import { Queue, Worker, QueueScheduler } from 'bullmq';
import Redis from 'ioredis';
import fs from 'fs';
import dotenv from 'dotenv';

// Initialize dotenv
dotenv.config();

// Debug logging function to file
function debugLog(message) {
    const logMessage = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync('worker_debug.log', logMessage);
    console.log(logMessage.trim());
}

// Create Redis connection with retry strategy
export const createRedisConnection = () => {
  return new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD,
    tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
    maxRetriesPerRequest: null,
    retryStrategy: (times) => {
      return Math.min(Math.exp(times), 20000);
    }
  });
};

// Create separate queues for different processing stages
export const createQueues = () => {
  const connection = createRedisConnection();
  
  // Queues for different stages
  const inboundCallQueue = new Queue('inbound-calls', { connection });
  const outboundCallQueue = new Queue('outbound-calls', { connection });
  const audioProcessingQueue = new Queue('audio-processing', { connection });
  
  // Add error handlers
  [inboundCallQueue, outboundCallQueue, audioProcessingQueue].forEach(queue => {
    queue.on('error', (error) => {
      debugLog(`Queue error: ${error.message}`);
    });
  });
  
  // Add queue schedulers for delayed jobs
  const schedulers = [
    new QueueScheduler('inbound-calls', { connection }),
    new QueueScheduler('outbound-calls', { connection }),
    new QueueScheduler('audio-processing', { connection })
  ];
  
  // Set global concurrency limit for outbound calls
  outboundCallQueue.setGlobalConcurrency(10);
  
  return {
    inboundCallQueue,
    outboundCallQueue,
    audioProcessingQueue,
    connection,
    schedulers
  };
};

// Create workers with proper concurrency and error handling
export const createWorkers = (queueNames = ['outbound-calls'], options = {}) => {
  const connection = createRedisConnection();
  const workers = [];
  
  queueNames.forEach(queueName => {
    const worker = new Worker(
      queueName,
      async (job) => {
        // This will be replaced by the actual job processor
        throw new Error('Job processor not implemented');
      },
      {
        connection,
        concurrency: options.concurrency || 5,
        limiter: {
          max: options.maxJobsPerSecond || 5,
          duration: 1000
        },
        backoff: {
          type: 'exponential',
          delay: 1000
        },
        attempts: options.attempts || 5,
        ...options
      }
    );
    
    // Add event handlers
    worker.on('completed', (job) => {
      debugLog(`[${job.id}] Job completed successfully`);
    });
    
    worker.on('failed', (job, error) => {
      debugLog(`[${job.id}] Job failed: ${error.message}`);
    });
    
    worker.on('error', (error) => {
      debugLog(`Worker error: ${error.message}`);
    });
    
    workers.push(worker);
  });
  
  // Setup graceful shutdown
  const gracefulShutdown = async (signal) => {
    debugLog(`Received ${signal}, closing workers...`);
    
    await Promise.all(workers.map(worker => worker.close()));
    debugLog('All workers closed gracefully');
    
    process.exit(0);
  };
  
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  
  return workers;
};

// Function to add job with prioritization
export const addJob = async (queue, jobName, data, options = {}) => {
  try {
    const job = await queue.add(jobName, data, {
      priority: options.priority || 0,  // Lower number = higher priority
      attempts: options.attempts || 5,
      backoff: options.backoff || {
        type: 'exponential',
        delay: 1000
      },
      removeOnComplete: options.removeOnComplete || {
        age: 3600,  // 1 hour
        count: 1000
      },
      removeOnFail: options.removeOnFail || {
        age: 24 * 3600  // 24 hours
      },
      ...options
    });
    
    debugLog(`Added job ${job.id} to queue ${queue.name}`);
    return job;
  } catch (error) {
    debugLog(`Error adding job to queue ${queue.name}: ${error.message}`);
    throw error;
  }
}; 