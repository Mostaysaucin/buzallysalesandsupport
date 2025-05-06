require('dotenv').config({ path: require('path').resolve(__dirname, '.env') }); // Ensure path is specified HERE TOO
const { Worker } = require('bullmq');
const logger = require('./utils/logger');
const { redisConnectionOptions, sessionManager, connectRedis, redisClient } = require('./utils/redisClient');
const { dbService } = require('./utils/dbClient');
const elevenlabs = require('./utils/elevenlabsClient');
const twilio = require('twilio');
const { v4: uuidv4 } = require('uuid');

// Initialize Twilio client (needed for making the call)
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Import the ElevenLabs message handlers
const { 
    handleElevenLabsMessage, 
    handleElevenLabsError, 
    handleElevenLabsClose,
    handleElevenLabsReconnecting
} = require('./utils/elevenlabsHandlers'); // Use the new handler module

const QUEUE_NAME = 'outbound-calls';

logger.info(`Worker connecting to Redis at: ${redisConnectionOptions.url || '(default)'}`);

// --- Function to connect dependencies ---
// We call this before starting the worker
async function initializeWorkerDependencies() {
    try {
        await connectRedis(); // Connect the redis clients needed by sessionManager etc.
        logger.info('Worker Redis clients connected.');
        // Initialize other async dependencies if needed (like DB?)
        // await dbService.init(); // If your DB needs an async init
    } catch (err) {
        logger.error('Worker failed to initialize dependencies:', err);
        process.exit(1); // Exit if essential connections fail
    }
}
// ------------------------------------

// Function to send welcome message
async function sendWelcomeMessage(sessionId) {
    const logPrefix = `[${sessionId}]`;
    // Simple text-to-speech welcome message
    const welcomeText = "Hello! I'm your voice assistant. How can I help you today?";
    
    try {
        await redisClient.publish('elevenlabs-tts-request', JSON.stringify({
            sessionId,
            text: welcomeText,
            voiceId: process.env.ELEVENLABS_VOICE_ID,
            modelId: 'eleven_monolingual_v1'
        }));
        
        logger.info(`${logPrefix} Sent welcome message request`);
        return true;
    } catch (error) {
        logger.error(`${logPrefix} Error sending welcome message: ${error.message}`);
        return false;
    }
}

// Define the worker
const processJob = async (job) => {
    const { to, from, n8nWorkflowUrl, jobId } = job.data;
    const workerLogPrefix = `[Worker][Job ${jobId}]`;
    logger.info(`${workerLogPrefix} Processing job for call to ${to} from ${from}`);

    let elevenLabsSessionId = null;

    try {
        // Generate ElevenLabs session ID using UUID 
        elevenLabsSessionId = `session_${Date.now()}_${uuidv4().substring(0, 6)}`;
        const logPrefix = `[${elevenLabsSessionId}]`;

        // 1. Pre-create session data in Redis BEFORE connecting to ElevenLabs
        // This ensures the session data is available immediately when ElevenLabs responds
        logger.info(`${workerLogPrefix} -> ${logPrefix} Pre-creating session data in Redis before ElevenLabs connection`);
        const startTime = new Date();
        const initialRedisData = {
            // Use a placeholder for callSid since we don't have it yet
            callSid: null,
            streamSid: null,
            to: to,
            from: from,
            status: 'initializing',
            startTime: startTime.toISOString(),
            n8nWorkflowUrl: n8nWorkflowUrl || null,
            jobId: jobId,
            ownerProcess: process.pid,
            // Add flag to indicate this is a pre-creation record
            preCreated: true
        };
        await sessionManager.saveOutboundSession(elevenLabsSessionId, initialRedisData);
        logger.info(`${workerLogPrefix} -> ${logPrefix} Initial session pre-created in Redis.`);

        // 2. Start ElevenLabs Conversation - with retry logic
        const maxRetries = 3;
        let retryCount = 0;
        let connectionSuccess = false;

        while (retryCount < maxRetries && !connectionSuccess) {
            try {
                // Attempt to start the conversation with our pre-generated session ID
                await elevenlabs.startConversation(
                    process.env.ELEVENLABS_AGENT_ID, // Use default agent ID
                    handleElevenLabsMessage, // Now using the imported handlers from elevenlabsHandlers.js
                    handleElevenLabsError,
                    handleElevenLabsClose,
                    handleElevenLabsReconnecting,
                    elevenLabsSessionId // Pass our pre-generated session ID
                );
                logger.info(`${workerLogPrefix} -> ${logPrefix} ElevenLabs session initiated. Connection pending.`);

                // Add a delay to allow the ElevenLabs WebSocket connection to fully establish
                // Increased from 300ms to 2000ms to give more time for connection establishment
                await new Promise(resolve => setTimeout(resolve, 2000));
                logger.info(`${workerLogPrefix} -> ${logPrefix} Added 2000ms delay to reduce race condition.`);

                // Check if the WebSocket connection is actually open
                const isConnected = elevenlabs.isSessionActive(elevenLabsSessionId);
                if (!isConnected) {
                    // Wait a bit longer and retry - add an additional 3 seconds
                    logger.warn(`${workerLogPrefix} -> ${logPrefix} WebSocket connection not active after initial delay. Waiting additional 3 seconds...`);
                    await new Promise(resolve => setTimeout(resolve, 3000));
                    
                    // Check again
                    const isConnectedRetry = elevenlabs.isSessionActive(elevenLabsSessionId);
                    if (!isConnectedRetry) {
                        logger.warn(`${workerLogPrefix} -> ${logPrefix} WebSocket connection still not active after additional delay. Retry attempt ${retryCount + 1} of ${maxRetries}.`);
                        retryCount++;
                        
                        // If we've reached max retries, log an error but continue
                        if (retryCount >= maxRetries) {
                            logger.error(`${workerLogPrefix} -> ${logPrefix} Failed to establish WebSocket connection after ${maxRetries} attempts. Proceeding anyway, but audio may not work properly.`);
                            break;
                        }
                        
                        // End the current session before retrying
                        try {
                            await elevenlabs.endConversation(elevenLabsSessionId);
                        } catch (endError) {
                            logger.error(`${workerLogPrefix} -> ${logPrefix} Error ending failed session: ${endError.message}`);
                        }
                        
                        // Wait before retrying
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        continue; // Try again
                    } else {
                        logger.info(`${workerLogPrefix} -> ${logPrefix} WebSocket connection successfully established after additional delay.`);
                        connectionSuccess = true;
                    }
                } else {
                    logger.info(`${workerLogPrefix} -> ${logPrefix} WebSocket connection successfully established.`);
                    connectionSuccess = true;
                }
                
                break; // Exit the retry loop if we get here
            } catch (connError) {
                logger.error(`${workerLogPrefix} Connection attempt ${retryCount + 1} failed: ${connError.message}`);
                retryCount++;
                
                if (retryCount >= maxRetries) {
                    throw new Error(`Failed to establish ElevenLabs connection after ${maxRetries} attempts: ${connError.message}`);
                }
                
                // Wait before retrying
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        
        // 3. Prepare TwiML URL and Status Callback URL
        const publicBaseUrl = process.env.PUBLIC_URL;
        if (!publicBaseUrl) {
            throw new Error('PUBLIC_URL environment variable is not set.');
        }
        const wsBase = publicBaseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
        const streamUrl = `wss://${wsBase}/api/outbound/stream/${elevenLabsSessionId}`;
        const httpBase = publicBaseUrl.replace(/\/$/, '');
        const statusCallbackUrl = `${httpBase}/api/outbound/status/${elevenLabsSessionId}`;

        logger.info(`${workerLogPrefix} -> ${logPrefix} Using Stream URL: ${streamUrl}`);
        logger.info(`${workerLogPrefix} -> ${logPrefix} Using Status Callback URL: ${statusCallbackUrl}`);

        // 3. Check if this is a test phone number - use verified number or test mode
        const isTestNumber = to === '+12345678900' || to === 'test'; // Special handling for test numbers

        // Use the Twilio phone number from environment variables instead of the provided "from" number
        const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;
        
        if (!twilioPhoneNumber) {
            throw new Error('TWILIO_PHONE_NUMBER environment variable is not set');
        }
        
        // Log that we're using the Twilio phone number instead of the provided "from" number
        if (from !== twilioPhoneNumber) {
            logger.info(`${workerLogPrefix} -> ${logPrefix} Using Twilio phone number ${twilioPhoneNumber} instead of provided number ${from}`);
        }
        
        let call;
        if (isTestNumber) {
            // Use a verified phone number from environment or simulate a call for testing
            const verifiedNumber = process.env.TWILIO_VERIFIED_NUMBER;
            
            if (verifiedNumber) {
                logger.info(`${workerLogPrefix} -> ${logPrefix} Using verified number ${verifiedNumber} instead of test number ${to}`);
                
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
                // Simulate a call for testing (no actual Twilio API call)
                logger.info(`${workerLogPrefix} -> ${logPrefix} Test mode: Simulating Twilio call for test number ${to}`);
                
                // Generate a fake call SID
                const fakeCallSid = `TEST${Date.now()}`;
                
                // Create a fake call object
                call = {
                    sid: fakeCallSid,
                    status: 'initiated',
                    from: twilioPhoneNumber, // Use Twilio phone number
                    to: to
                };
                
                // Simulate a status callback after a delay
                setTimeout(async () => {
                    try {
                        // Make an HTTP POST request to the status callback URL to simulate Twilio
                        const axios = require('axios');
                        
                        // Simulate call queued
                        await axios.post(statusCallbackUrl, {
                            CallSid: fakeCallSid,
                            CallStatus: 'queued'
                        });
                        
                        // Simulate call ringing after 1 second
                        setTimeout(async () => {
                            await axios.post(statusCallbackUrl, {
                                CallSid: fakeCallSid,
                                CallStatus: 'ringing'
                            });
                            
                            // Simulate call answered after 2 more seconds
                            setTimeout(async () => {
                                await axios.post(statusCallbackUrl, {
                                    CallSid: fakeCallSid,
                                    CallStatus: 'in-progress'
                                });
                                
                                // Complete call after 30 seconds
                                setTimeout(async () => {
                                    await axios.post(statusCallbackUrl, {
                                        CallSid: fakeCallSid,
                                        CallStatus: 'completed',
                                        CallDuration: '30'
                                    });
                                }, 30000);
                            }, 2000);
                        }, 1000);
                    } catch (error) {
                        logger.error(`${workerLogPrefix} -> ${logPrefix} Error in simulated call status updates:`, error);
                    }
                }, 100);
            }
        } else {
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

        logger.info(`${workerLogPrefix} -> ${logPrefix} Twilio call initiated. Call SID: ${call.sid}`);

        // 4. Save Initial State to Redis with process ownership information
        const redisData = {
            callSid: call.sid,
            streamSid: null,
            to: to,
            from: from,
            status: 'initiated',
            startTime: startTime.toISOString(),
            n8nWorkflowUrl: n8nWorkflowUrl || null,
            jobId: jobId, // Store the BullMQ job ID for reference
            ownerProcess: process.pid // Track which process owns this session
        };
        await sessionManager.saveOutboundSession(elevenLabsSessionId, redisData);
        logger.info(`${workerLogPrefix} -> ${logPrefix} Initial session data saved to Redis.`);

        // Initialize ElevenLabs session
        logger.info(`[${elevenLabsSessionId}] Initializing ElevenLabs session`);
        try {
            await redisClient.publish('elevenlabs-session-start', JSON.stringify({
                sessionId: elevenLabsSessionId,
                callSid: call.sid,
                agentId: process.env.ELEVENLABS_AGENT_ID,
                voiceId: process.env.ELEVENLABS_VOICE_ID,
                useStreaming: true
            }));
            logger.info(`[${elevenLabsSessionId}] Published elevenlabs-session-start event to Redis`);
            
            // Send welcome message
            await sendWelcomeMessage(elevenLabsSessionId);
            logger.info(`[${elevenLabsSessionId}] Sent welcome message request`);
            
            // Schedule a test tone after 3 seconds
            setTimeout(async () => {
                try {
                    logger.info(`[${elevenLabsSessionId}] Generating test tone`);
                    // Generate simple test tone (mu-law encoded)
                    const testToneLength = 1600; // 200ms at 8kHz
                    const buffer = Buffer.alloc(testToneLength);
                    for (let i = 0; i < testToneLength; i++) {
                        buffer[i] = i % 2 === 0 ? 0x55 : 0xAA; // Simple pattern for audible tone
                    }
                    
                    // Publish test tone to Redis
                    await redisClient.publish(`elevenlabs-to-twilio:${elevenLabsSessionId}`, JSON.stringify({
                        audioBase64: buffer.toString('base64'),
                        source: 'test-tone',
                        timestamp: Date.now(),
                        format: 'ulaw',
                        sampleRate: 8000
                    }));
                    
                    logger.info(`[${elevenLabsSessionId}] Published test tone to Redis`);
                } catch (error) {
                    logger.error(`[${elevenLabsSessionId}] Error sending test tone: ${error.message}`);
                }
            }, 3000);
            
            // Monitor ElevenLabs session status
            const sessionStatusInterval = setInterval(async () => {
                try {
                    const data = await redisClient.get(`elevenlabs_session:${elevenLabsSessionId}`);
                    logger.info(`[${elevenLabsSessionId}] ElevenLabs session status: ${data ? JSON.parse(data).status : 'NOT_FOUND'}`);
                } catch (error) {
                    logger.error(`[${elevenLabsSessionId}] Error checking ElevenLabs session: ${error.message}`);
                }
            }, 2000);
            
            // Clear interval after 30 seconds to avoid memory leaks
            setTimeout(() => {
                clearInterval(sessionStatusInterval);
                logger.info(`[${elevenLabsSessionId}] Stopped monitoring ElevenLabs session status`);
            }, 30000);
            
        } catch (error) {
            logger.error(`[${elevenLabsSessionId}] Error initializing ElevenLabs session: ${error.message}`);
        }

        // 5. Save Initial State to Database
        await dbService.upsertCallByExternalId(call.sid, {
            call_id: call.sid,
            session_id: elevenLabsSessionId,
            direction: 'outbound',
            from_number: from,
            to_number: to,
            start_time: startTime,
            status: 'initiated',
            call_data: { provider: 'twilio', n8nWorkflowUrl: n8nWorkflowUrl || null, bullmqJobId: jobId }
        });
        logger.info(`${workerLogPrefix} -> ${logPrefix} Initial call record saved to DB.`);

        logger.info(`${workerLogPrefix} -> ${logPrefix} Job completed successfully.`);
        return { callSid: call.sid, sessionId: elevenLabsSessionId }; // Optional: return result

    } catch (error) {
        logger.error(`${workerLogPrefix} Error processing job:`, error);
        // Attempt cleanup if session ID was generated before the error
        if (elevenLabsSessionId) {
            const logPrefix = `[${elevenLabsSessionId}]`;
            logger.error(`${workerLogPrefix} -> ${logPrefix} Cleaning up ElevenLabs session due to processing error.`);
            await elevenlabs.endConversation(elevenLabsSessionId);
            
            // Also remove potentially partial Redis entry and release ownership
            await sessionManager.deleteOutboundSession(elevenLabsSessionId);
            await sessionManager.releaseSessionOwnership(elevenLabsSessionId, process.pid);
            
            logger.error(`${workerLogPrefix} -> ${logPrefix} Removed Redis session entry and released ownership.`);
            
            // Optionally update DB status to failed if record was created
            /* <<< COMMENT OUT START
             try {
                const callRecord = await dbService.getCallBySessionId(elevenLabsSessionId); // Need this method in dbService
                if (callRecord) {
                    await dbService.updateCall(callRecord.id, {
                        status: 'failed',
                        end_time: new Date(),
                        failure_reason: `Worker job failed: ${error.message}`
                    });
                     logger.error(`${workerLogPrefix} -> ${logPrefix} Updated DB record to failed.`);
                }
             } catch (dbError) {
                  logger.error(`${workerLogPrefix} -> ${logPrefix} Failed to update DB status after worker error:`, dbError);
             }
             <<< COMMENT OUT END */
        }
        // Let BullMQ know the job failed, it will be retried based on queue settings
        throw error; // Re-throw the error to mark the job as failed
    }
};

// --- Initialize Worker AFTER dependencies are ready ---
async function startWorker() {
    await initializeWorkerDependencies();

    const worker = new Worker(QUEUE_NAME, processJob, {
        connection: redisConnectionOptions,
        // concurrency: 5, 
        // limiter: { ... }
    });

    // --- Worker Event Listeners ---
    worker.on('completed', (job, result) => {
      logger.info(`[Worker][Job ${job.id}] Completed call to ${job.data.to}. Result: ${JSON.stringify(result)}`);
    });

    worker.on('failed', (job, err) => {
      logger.error(`[Worker][Job ${job.id}] Failed call to ${job.data.to}. Error: ${err.message}`);
      // You might want more sophisticated error handling/reporting here
    });

    worker.on('error', err => {
      // Local worker errors (e.g., connection issues)
      logger.error('[Worker] Error:', err);
    });

    logger.info('Worker started and listening for jobs on queue: ', QUEUE_NAME);

    // Graceful shutdown
    process.on('SIGTERM', async () => {
      logger.info('SIGTERM signal received. Closing worker...');
      await worker.close();
      logger.info('Worker closed.');
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      logger.info('SIGINT signal received. Closing worker...');
      await worker.close();
      logger.info('Worker closed.');
      process.exit(0);
    });
}

startWorker(); // Start the initialization and worker setup 