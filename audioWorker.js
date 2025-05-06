import dotenv from 'dotenv';
import fs from 'fs';
import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { createQueues, createWorkers } from './utils/queueConfig.js';
import { twilioRateLimiter, elevenLabsRateLimiter } from './utils/rateLimiter.js';
import { publishRedisMessage } from './utils/websocketManager.js';
import path from 'path';
import { fileURLToPath } from 'url';

// Initialize dotenv
dotenv.config();

// Debug logging function
function debugLog(message) {
    const logMessage = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync('audio_worker.log', logMessage);
    console.log(logMessage.trim());
}

debugLog("==== AUDIO WORKER ENVIRONMENT DEBUG ====");
debugLog(`Current directory: ${process.cwd()}`);
debugLog(`REDIS_HOST: ${process.env.REDIS_HOST || 'localhost'}`);
debugLog(`REDIS_PORT: ${process.env.REDIS_PORT || '6379'}`);
debugLog(`Audio Worker Debug Mode Enabled.`);

// Redis connection
const redisClient = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD,
    tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
    maxRetriesPerRequest: null
});

// Handle Redis errors
redisClient.on('error', (err) => {
    debugLog(`Redis client error: ${err.message}`);
});

redisClient.on('connect', () => {
    debugLog('Redis client connected for audio processing operations');
});

// Initialize queue system
const { audioProcessingQueue, connection, schedulers } = createQueues();

// Process audio conversion task
async function processAudioConversion(job) {
    const { sessionId, audioData, format, sampleRate } = job.data;
    debugLog(`[${sessionId}] Processing audio conversion to ${format} at ${sampleRate}Hz`);
    
    try {
        // Check rate limits
        const canProcess = await elevenLabsRateLimiter.consume('audio-processing');
        if (!canProcess) {
            debugLog(`[${sessionId}] Rate limited for audio processing. Will retry later.`);
            throw new Error('Rate limited for audio processing');
        }
        
        // In a real implementation, you would use a library like fluent-ffmpeg
        // to convert audio between formats. For this example, we'll simulate success.
        
        // Simulate audio conversion processing time
        await new Promise(resolve => setTimeout(resolve, 50));
        
        debugLog(`[${sessionId}] Audio conversion completed successfully`);
        
        // Publish the converted audio to Redis for distribution
        await publishRedisMessage('elevenlabs-audio', {
            sessionId,
            audioChunk: audioData, // This would be the converted audio data in a real implementation
            isLast: job.data.isLast || false,
            chunkId: job.data.chunkId || null,
            timestamp: Date.now()
        });
        
        return { success: true };
    } catch (error) {
        debugLog(`[${sessionId}] Error processing audio conversion: ${error.message}`);
        throw error;
    }
}

// Process audio streaming task
async function processAudioStreaming(job) {
    const { sessionId, audioData, isLast } = job.data;
    debugLog(`[${sessionId}] Processing audio streaming task${isLast ? ' (final chunk)' : ''}`);
    
    try {
        // Check rate limits
        const canProcess = await elevenLabsRateLimiter.consume('audio-streaming');
        if (!canProcess) {
            debugLog(`[${sessionId}] Rate limited for audio streaming. Will retry later.`);
            throw new Error('Rate limited for audio streaming');
        }
        
        // In a real implementation, there might be buffering or other processing
        // before streaming. Here we'll simulate that with a small delay.
        await new Promise(resolve => setTimeout(resolve, 20));
        
        // Publish the audio chunk to Redis for distribution
        await publishRedisMessage('elevenlabs-audio', {
            sessionId,
            audioChunk: audioData,
            isLast: isLast || false,
            chunkId: job.data.chunkId || null,
            timestamp: Date.now()
        });
        
        debugLog(`[${sessionId}] Audio streaming task completed successfully`);
        
        return { success: true };
    } catch (error) {
        debugLog(`[${sessionId}] Error processing audio streaming: ${error.message}`);
        throw error;
    }
}

// Create audio worker processor
const createAudioProcessor = () => async (job) => {
    debugLog(`Processing job ${job.id} of type ${job.name}`);
    
    switch (job.name) {
        case 'audio-conversion':
            return await processAudioConversion(job);
        
        case 'audio-streaming':
            return await processAudioStreaming(job);
            
        default:
            debugLog(`Unknown job type: ${job.name}`);
            throw new Error(`Unknown job type: ${job.name}`);
    }
};

// Create worker with enhanced options
const workers = createWorkers(['audio-processing'], {
    concurrency: 20, // Higher concurrency for audio processing
    maxJobsPerSecond: 50, // Audio chunks can come in rapidly
    attempts: 3,
    processor: createAudioProcessor()
});

debugLog("Audio Worker started and listening for jobs on queue: audio-processing");

// Listen for Redis events for audio related tasks
const pubSubClient = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD,
    tls: process.env.REDIS_TLS === 'true' ? {} : undefined
});

// Subscribe to elevenlabs-audio-processing channel
pubSubClient.subscribe('elevenlabs-audio-processing');

pubSubClient.on('message', async (channel, message) => {
    if (channel === 'elevenlabs-audio-processing') {
        try {
            const data = JSON.parse(message);
            debugLog(`Received audio processing request for session ${data.sessionId}`);
            
            // Add job to the queue
            await audioProcessingQueue.add('audio-streaming', data, {
                priority: 1, // High priority for real-time audio
                attempts: 2,
                backoff: {
                    type: 'exponential',
                    delay: 100 // Start with very short delay for audio
                }
            });
        } catch (error) {
            debugLog(`Error handling Redis message: ${error.message}`);
        }
    }
});

// Graceful shutdown
process.on('SIGINT', async () => {
    debugLog('Received SIGINT, shutting down audio worker...');
    
    try {
        await pubSubClient.unsubscribe();
        await pubSubClient.quit();
        await redisClient.quit();
        
        debugLog('Closed Redis connections');
    } catch (error) {
        debugLog(`Error during shutdown: ${error.message}`);
    }
    
    process.exit(0);
});

process.on('SIGTERM', async () => {
    debugLog('Received SIGTERM, shutting down audio worker...');
    
    try {
        await pubSubClient.unsubscribe();
        await pubSubClient.quit();
        await redisClient.quit();
        
        debugLog('Closed Redis connections');
    } catch (error) {
        debugLog(`Error during shutdown: ${error.message}`);
    }
    
    process.exit(0);
}); 