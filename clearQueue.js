// Script to clear BullMQ queue keys
require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const Redis = require('ioredis');
const logger = require('./utils/logger');

// Create a Redis client using the same configuration as the app
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
});

const QUEUE_NAME = 'outbound-calls';
const BULL_PREFIX = 'bull';

async function clearQueue() {
  try {
    logger.info('Connecting to Redis to clear BullMQ queue...');
    
    // Find all keys related to the queue
    const pattern = `${BULL_PREFIX}:${QUEUE_NAME}:*`;
    logger.info(`Searching for keys matching pattern: ${pattern}`);
    
    const keys = await redis.keys(pattern);
    
    if (keys.length === 0) {
      logger.info('No keys found for the queue. Queue may already be empty.');
    } else {
      logger.info(`Found ${keys.length} keys related to the queue:`);
      keys.forEach(key => logger.info(`  - ${key}`));
      
      // Delete all keys
      const result = await redis.del(...keys);
      logger.info(`Successfully deleted ${result} keys.`);
    }
    
    logger.info('Queue cleared successfully.');
  } catch (error) {
    logger.error('Error clearing queue:', error);
  } finally {
    // Close Redis connection
    await redis.quit();
    logger.info('Redis connection closed.');
  }
}

// Run the function
clearQueue(); 