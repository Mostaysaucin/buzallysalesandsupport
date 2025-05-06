import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import twilio from 'twilio';
import fs from 'fs';
import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { createQueues, createWorkers } from './utils/queueConfig.js';
import { twilioRateLimiter, elevenLabsRateLimiter, twilioCircuitBreaker, elevenLabsCircuitBreaker } from './utils/rateLimiter.js';

// Initialize dotenv
dotenv.config();

// Debug logging function to file
function debugLog(message) {
    const logMessage = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync('worker_debug.log', logMessage);
    console.log(logMessage.trim());
}

// Log all environment variables related to URLs and Twilio
debugLog("==== WORKER ENVIRONMENT DEBUG ====");
debugLog(`PUBLIC_URL: ${process.env.PUBLIC_URL}`);
debugLog(`TWILIO_ACCOUNT_SID: ${process.env.TWILIO_ACCOUNT_SID ? "Set (starts with " + process.env.TWILIO_ACCOUNT_SID.substring(0, 5) + "...)" : "NOT SET"}`);
debugLog(`TWILIO_AUTH_TOKEN: ${process.env.TWILIO_AUTH_TOKEN ? "Set (length: " + process.env.TWILIO_AUTH_TOKEN.length + ")" : "NOT SET"}`);
debugLog(`TWILIO_PHONE_NUMBER: ${process.env.TWILIO_PHONE_NUMBER}`);
debugLog(`TWILIO_VERIFIED_NUMBER: ${process.env.TWILIO_VERIFIED_NUMBER}`);
debugLog(`Current directory: ${process.cwd()}`);
debugLog(`REDIS_HOST: ${process.env.REDIS_HOST || 'localhost'}`);
debugLog(`REDIS_PORT: ${process.env.REDIS_PORT || '6379'}`);
debugLog(`Worker Debug Mode Enabled.`);

// Get your Account SID and Auth Token from environment variables
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;
const verifiedNumber = process.env.TWILIO_VERIFIED_NUMBER;

// Get the base URL for callbacks
const baseUrl = process.env.PUBLIC_URL;

// Check if the credentials are loaded
if (!accountSid || !authToken) {
    debugLog('Error: TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN not found in environment variables.');
    debugLog('Please ensure these are set in your .env file at the project root or in your environment.');
    process.exit(1);
}

// Create and initialize the Twilio client
const twilioClient = twilio(accountSid, authToken);

// Redis connection info
const redisConnectionOptions = {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD,
    // If Redis is using TLS
    tls: process.env.REDIS_TLS === 'true' ? {} : undefined
};

// Initialize Redis clients for session management
const redisClient = new Redis(redisConnectionOptions);
redisClient.on('connect', () => {
    debugLog('Redis client connected for session management');
});
redisClient.on('error', (err) => {
    debugLog(`Redis client error: ${err}`);
});

// Session management functions
const sessionManager = {
    // Save outbound call session to Redis
    saveOutboundSession: async (sessionId, data, ttl = 3600) => {
        try {
            const key = `outbound_session:${sessionId}`;
            await redisClient.set(key, JSON.stringify(data));
            await redisClient.expire(key, ttl);
            debugLog(`Session data saved to Redis: ${key}`);
            return true;
        } catch (error) {
            debugLog(`Error saving session to Redis: ${error.message}`);
            return false;
        }
    },
    
    // Get outbound call session from Redis
    getOutboundSession: async (sessionId) => {
        try {
            const key = `outbound_session:${sessionId}`;
            const data = await redisClient.get(key);
            return data ? JSON.parse(data) : null;
        } catch (error) {
            debugLog(`Error getting session from Redis: ${error.message}`);
            return null;
        }
    }
};

// Process outbound calls queue
async function processOutboundCall(to, from, sessionId) {
    try {
        // Use provided sessionId or generate a unique session ID
        sessionId = sessionId || `session_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        debugLog(`[${sessionId}] Processing outbound call from ${from} to ${to}`);
        
        // Check if Twilio circuit breaker is open
        const twilioCircuitOpen = await twilioCircuitBreaker.isOpen('make-call');
        if (twilioCircuitOpen) {
            debugLog(`[${sessionId}] Twilio circuit breaker is open. Delaying call.`);
            throw new Error('Twilio service currently unavailable, circuit breaker is open');
        }
        
        // Apply rate limiting for Twilio API
        const canMakeCall = await twilioRateLimiter.consume('make-call');
        if (!canMakeCall) {
            debugLog(`[${sessionId}] Rate limited for Twilio API. Will retry later.`);
            throw new Error('Rate limited for Twilio API calls');
        }
        
        // Create stream and callback URLs using the base URL
        const streamUrl = `wss://${baseUrl.replace('https://', '')}/api/outbound/stream/${sessionId}`;
        const statusCallbackUrl = `${baseUrl}/api/outbound/status/${sessionId}`;
        
        debugLog(`[${sessionId}] Using Stream URL: ${streamUrl}`);
        debugLog(`[${sessionId}] Using Status Callback URL: ${statusCallbackUrl}`);
        debugLog(`[${sessionId}] Base URL: ${baseUrl}`);
        
        let call;
        
        try {
            // For testing, if you're calling the verified number, use it directly
            if (to === verifiedNumber) {
                debugLog(`[${sessionId}] Making call to verified number: ${verifiedNumber}`);
                
                // Make the actual Twilio call but to the verified number
                call = await twilioClient.calls.create({
                    to: verifiedNumber, // Use the verified number instead
                    from: twilioPhoneNumber, // Use Twilio phone number instead of provided "from"
                    twiml: `<Response><Connect><Stream url="${streamUrl}" track="inbound_track" mediaFormat="audio/x-mulaw" /></Connect></Response>`,
                    statusCallback: statusCallbackUrl,
                    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
                    statusCallbackMethod: 'POST',
                });
            } else {
                debugLog(`[${sessionId}] Making call to: ${to}`);
                
                // Make normal Twilio call for non-test numbers
                call = await twilioClient.calls.create({
                    to: to,
                    from: twilioPhoneNumber, // Use Twilio phone number instead of provided "from"
                    twiml: `<Response><Connect><Stream url="${streamUrl}" track="inbound_track" mediaFormat="audio/x-mulaw" /></Connect></Response>`,
                    statusCallback: statusCallbackUrl,
                    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
                    statusCallbackMethod: 'POST',
                });
            }
            
            // Record success with circuit breaker
            await twilioCircuitBreaker.recordSuccess('make-call');
            
            debugLog(`[${sessionId}] Call initiated with SID: ${call.sid}`);
        } catch (error) {
            // Record failure with circuit breaker
            await twilioCircuitBreaker.recordFailure('make-call');
            debugLog(`[${sessionId}] Error making Twilio call: ${error.message}`);
            throw error;
        }
        
        // Save call information to Redis for the WebSocket server to find
        const callInfo = {
            sessionId,
            callSid: call.sid,
            to,
            from: twilioPhoneNumber,
            status: 'initiated',
            createdAt: new Date().toISOString(),
            createdBy: process.pid,
            streamUrl,
            statusCallbackUrl
        };
        
        // Store session in Redis with a TTL of 1 hour
        await sessionManager.saveOutboundSession(sessionId, callInfo);
        debugLog(`[${sessionId}] Call information saved to Redis`);
        
        // Check if ElevenLabs circuit breaker is open
        const elevenLabsCircuitOpen = await elevenLabsCircuitBreaker.isOpen('session-start');
        if (elevenLabsCircuitOpen) {
            debugLog(`[${sessionId}] ElevenLabs circuit breaker is open. Using fallback.`);
            // Handle fallback if needed - maybe use a different service or simplified TTS
        }
        
        // Apply rate limiting for ElevenLabs API
        const canUseElevenLabs = await elevenLabsRateLimiter.consume('session-start');
        if (!canUseElevenLabs) {
            debugLog(`[${sessionId}] Rate limited for ElevenLabs API. Using reduced quality TTS.`);
            // Optionally implement fallback to lower quality TTS or slower response
        }
        
        // Initialize ElevenLabs session
        debugLog(`[${sessionId}] Initializing ElevenLabs session`);
        try {
            await redisClient.publish('elevenlabs-session-start', JSON.stringify({
                sessionId: sessionId,
                callSid: call.sid,
                agentId: process.env.ELEVENLABS_AGENT_ID,
                voiceId: process.env.ELEVENLABS_VOICE_ID,
                useStreaming: true
            }));
            debugLog(`[${sessionId}] Published elevenlabs-session-start event to Redis`);
            
            // Record success with circuit breaker
            await elevenLabsCircuitBreaker.recordSuccess('session-start');
        } catch (error) {
            // Record failure with circuit breaker
            await elevenLabsCircuitBreaker.recordFailure('session-start');
            debugLog(`[${sessionId}] Error initializing ElevenLabs session: ${error.message}`);
            throw error;
        }
        
        return call.sid;
    } catch (error) {
        debugLog(`Error making outbound call: ${error.message}`);
        throw error;
    }
}

debugLog("Setting up enhanced BullMQ worker connection to Redis...");

// Initialize queue system
const { outboundCallQueue, connection, schedulers } = createQueues();

// Create outbound call worker with proper processor function
const createOutboundCallProcessor = () => async (job) => {
    debugLog(`Processing job ${job.id} of type ${job.name}`);
    
    if (job.name === 'initiate-call') {
        const { to, from, jobId, n8nWorkflowUrl } = job.data;
        debugLog(`[Job ${jobId}] Received call initiation request: to=${to}, from=${from}`);
        
        try {
            // Use jobId as the session ID to ensure consistency
            const callSid = await processOutboundCall(to, from, jobId);
            debugLog(`[Job ${jobId}] Call initiated successfully with SID: ${callSid}`);
            return { success: true, callSid };
        } catch (error) {
            debugLog(`[Job ${jobId}] Failed to initiate call: ${error.message}`);
            throw new Error(`Failed to initiate call: ${error.message}`);
        }
    } else {
        debugLog(`Unknown job type: ${job.name}`);
        throw new Error(`Unknown job type: ${job.name}`);
    }
};

// Create worker with enhanced options
const workers = createWorkers(['outbound-calls'], {
    concurrency: 10,
    maxJobsPerSecond: 5,
    attempts: 5,
    processor: createOutboundCallProcessor()
});

debugLog("Enhanced BullMQ Worker started and listening for jobs on queue: outbound-calls");

// Listen for messages from the process (for backward compatibility)
process.on('message', async (message) => {
    debugLog(`Received IPC message: ${JSON.stringify(message)}`);
    if (message.type === 'call' && message.data) {
        try {
            const callSid = await processOutboundCall(message.data.to, message.data.from);
            process.send({ type: 'callResponse', success: true, callSid });
        } catch (error) {
            process.send({ type: 'callResponse', success: false, error: error.message });
        }
    }
});

// Example: For testing purposes, if run directly
if (process.argv[2] === '--test') {
    const testTo = process.argv[3] || verifiedNumber;
    const testFrom = process.argv[4] || twilioPhoneNumber;
    debugLog(`Running test call from ${testFrom} to ${testTo}`);
    processOutboundCall(testTo, testFrom)
        .then(sid => debugLog(`Test call SID: ${sid}`))
        .catch(error => debugLog(`Test call error: ${error.message}`))
        .finally(() => {
            // Allow time for logs to be written before exit
            setTimeout(() => process.exit(0), 5000);
        });
}

// Export the processOutboundCall function so it can be imported by other modules
export { processOutboundCall }; 