import dotenv from 'dotenv';
import fs from 'fs';
import Redis from 'ioredis';

// Initialize dotenv
dotenv.config();

// Debug logging function
function debugLog(message) {
    const logMessage = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync('cleanup_worker.log', logMessage);
    console.log(logMessage.trim());
}

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
    debugLog('Redis client connected for cleanup operations');
});

// Cleanup old sessions
async function cleanupOldSessions() {
    try {
        debugLog('Starting session cleanup process...');
        
        // Get all session keys
        const sessionKeys = await redisClient.keys('outbound_session:*');
        debugLog(`Found ${sessionKeys.length} session keys to check`);
        
        let expiredCount = 0;
        let activeCount = 0;
        
        // Check each session for expiration criteria
        for (const key of sessionKeys) {
            try {
                // Get session data
                const sessionDataStr = await redisClient.get(key);
                
                if (!sessionDataStr) {
                    // If no data found, it's already expired or was removed
                    continue;
                }
                
                const sessionData = JSON.parse(sessionDataStr);
                const createdAt = new Date(sessionData.createdAt);
                const now = new Date();
                const sessionAge = now - createdAt; // Age in milliseconds
                
                // Sessions older than 24 hours should be cleaned up
                if (sessionAge > 24 * 60 * 60 * 1000) {
                    await redisClient.del(key);
                    expiredCount++;
                    debugLog(`Cleaned up expired session: ${key}`);
                } else {
                    activeCount++;
                }
            } catch (error) {
                debugLog(`Error processing session key ${key}: ${error.message}`);
            }
        }
        
        debugLog(`Cleanup complete. Removed ${expiredCount} expired sessions. ${activeCount} active sessions remain.`);
    } catch (error) {
        debugLog(`Error cleaning up sessions: ${error.message}`);
    }
}

// Cleanup circuit breaker states
async function cleanupCircuitBreakerStates() {
    try {
        debugLog('Starting circuit breaker state cleanup...');
        
        // Get all circuit breaker keys
        const circuitKeys = await redisClient.keys('*circuit:*');
        debugLog(`Found ${circuitKeys.length} circuit breaker states to check`);
        
        let resetCount = 0;
        
        // Check each circuit
        for (const key of circuitKeys) {
            try {
                const data = await redisClient.hgetall(key);
                
                // If circuit is open but the openTime is very old (more than 1 hour), force a reset
                if (data.status === 'open') {
                    const openTime = parseInt(data.openTime || 0);
                    const now = Date.now();
                    
                    if (now - openTime > 3600000) { // 1 hour
                        await redisClient.hmset(key, {
                            status: 'half-open',
                            failures: 0
                        });
                        resetCount++;
                        debugLog(`Reset stale circuit breaker state for: ${key}`);
                    }
                }
            } catch (error) {
                debugLog(`Error processing circuit key ${key}: ${error.message}`);
            }
        }
        
        debugLog(`Circuit breaker cleanup complete. Reset ${resetCount} stale circuits.`);
    } catch (error) {
        debugLog(`Error cleaning up circuit breaker states: ${error.message}`);
    }
}

// Cleanup rate limiter buckets
async function cleanupRateLimiterBuckets() {
    try {
        debugLog('Starting rate limiter bucket cleanup...');
        
        // Get all rate limiter keys
        const rateLimitKeys = await redisClient.keys('ratelimit:*');
        debugLog(`Found ${rateLimitKeys.length} rate limiter buckets to check`);
        
        let resetCount = 0;
        
        // Reset any buckets that have been inactive for more than 12 hours
        for (const key of rateLimitKeys) {
            try {
                const data = await redisClient.hmget(key, 'lastRefill');
                const lastRefill = parseInt(data[0] || 0);
                const now = Date.now();
                
                if (lastRefill && now - lastRefill > 12 * 3600000) { // 12 hours
                    // Delete the bucket, it will be recreated with default values when needed
                    await redisClient.del(key);
                    resetCount++;
                    debugLog(`Removed stale rate limit bucket: ${key}`);
                }
            } catch (error) {
                debugLog(`Error processing rate limit key ${key}: ${error.message}`);
            }
        }
        
        debugLog(`Rate limiter cleanup complete. Removed ${resetCount} stale buckets.`);
    } catch (error) {
        debugLog(`Error cleaning up rate limiter buckets: ${error.message}`);
    }
}

// Run all cleanup tasks
async function runCleanupTasks() {
    debugLog('Starting cleanup tasks...');
    
    try {
        await cleanupOldSessions();
        await cleanupCircuitBreakerStates();
        await cleanupRateLimiterBuckets();
        
        debugLog('All cleanup tasks completed successfully');
    } catch (error) {
        debugLog(`Error during cleanup tasks: ${error.message}`);
    }
}

// Run cleanup immediately on startup
runCleanupTasks()
    .then(() => {
        debugLog('Initial cleanup completed');
    })
    .catch(error => {
        debugLog(`Error during initial cleanup: ${error.message}`);
    });

// Set up periodic cleanup every hour
const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour
const cleanupInterval = setInterval(runCleanupTasks, CLEANUP_INTERVAL);

debugLog(`WebSocket Cleanup Worker started with ${CLEANUP_INTERVAL}ms interval`);

// Graceful shutdown
process.on('SIGINT', async () => {
    debugLog('Received SIGINT, shutting down cleanup worker...');
    clearInterval(cleanupInterval);
    await redisClient.quit();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    debugLog('Received SIGTERM, shutting down cleanup worker...');
    clearInterval(cleanupInterval);
    await redisClient.quit();
    process.exit(0);
}); 