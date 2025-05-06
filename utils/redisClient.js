const redis = require('redis');
const logger = require('./logger');

// Define connection options once
const redisConnectionOptions = {
    // Use standard Redis client options format
    // BullMQ can use these
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    // Add password, db, etc. if needed from process.env
};

// Existing client for general commands
const redisClient = redis.createClient(redisConnectionOptions);

// New client specifically for subscribing
const subscriberClient = redisClient.duplicate();

// Client for publishing
const publisherClient = redisClient.duplicate();

// Initialize all Redis clients on startup - moved to connectRedis function
async function connectRedis() {
    try {
        if (!redisClient.isOpen) {
            await redisClient.connect();
            logger.info('Redis client connected');
        }
        if (!subscriberClient.isOpen) {
            await subscriberClient.connect();
            logger.info('Redis subscriber client connected');
        }
        if (!publisherClient.isOpen) {
            await publisherClient.connect();
            logger.info('Redis publisher client connected');
        }
    } catch (err) {
        logger.error('Redis connection error:', err);
        throw err; // Rethrow for caller to handle
    }
}

// Function to publish messages to Redis channels
async function publishRedisMessage(channel, payload) {
    try {
        if (!publisherClient.isOpen) {
            await publisherClient.connect();
            logger.info('Redis publisher client connected on demand');
        }
        await publisherClient.publish(channel, payload);
        return true;
    } catch (err) {
        logger.error(`Error publishing to channel ${channel}:`, err);
        return false;
    }
}

redisClient.on('error', (err) => logger.error('Redis Client Error', err));
subscriberClient.on('error', (err) => logger.error('Redis Subscriber Error', err));
publisherClient.on('error', (err) => logger.error('Redis Publisher Error', err));

// Session Management Logic (Simplified Example - Adapt to your structure)
// Ensure this uses the 'redisClient' (general commands client)

class SessionManager {
    constructor(client, publisher) {
        this.client = client;
        this.publisher = publisher;
        this.outboundPrefix = 'outbound_session:';
        this.inboundPrefix = 'inbound_session:';
        this.mappingPrefix = 'session_to_call:';
        this.ownershipPrefix = 'session_owner:';
    }

    _getKey(sessionId) {
        return `${this.outboundPrefix}${sessionId}`;
    }

    _getInboundKey(callId) {
        return `${this.inboundPrefix}${callId}`;
    }

    _getMappingKey(sessionId) {
        return `${this.mappingPrefix}${sessionId}`;
    }

    _getOwnershipKey(sessionId) {
        return `${this.ownershipPrefix}${sessionId}`;
    }

    async saveOutboundSession(sessionId, data, ttlSeconds = 3600) { // ttl = 1 hour
    try {
            const key = this._getKey(sessionId);
            // Use SET with EX for atomic set + expiry
            await this.client.set(key, JSON.stringify(data), { EX: ttlSeconds });
            // logger.debug(`[${sessionId}] Session data saved/updated in Redis.`);
        } catch (err) {
            logger.error(`[${sessionId}] Error saving session to Redis:`, err);
        }
    }

    async getOutboundSession(sessionId) {
        try {
            const key = this._getKey(sessionId);
            const data = await this.client.get(key);
            return data ? JSON.parse(data) : null;
        } catch (err) {
            logger.error(`[${sessionId}] Error getting session from Redis:`, err);
            return null;
        }
    }

    async deleteOutboundSession(sessionId) {
         try {
            const key = this._getKey(sessionId);
            await this.client.del(key);
            logger.info(`[${sessionId}] Session deleted from Redis.`);
        } catch (err) {
            logger.error(`[${sessionId}] Error deleting session from Redis:`, err);
        }
    }
    
    async saveInboundSession(callId, data, ttlSeconds = 3600) {
        try {
            const key = this._getInboundKey(callId);
            await this.client.set(key, JSON.stringify(data), { EX: ttlSeconds });
            logger.debug(`[Inbound:${callId}] Session data saved to Redis.`);
        } catch (err) {
            logger.error(`[Inbound:${callId}] Error saving inbound session to Redis:`, err);
    }
    }

  async getInboundSession(callId) {
    try {
            const key = this._getInboundKey(callId);
            const data = await this.client.get(key);
            return data ? JSON.parse(data) : null;
        } catch (err) {
            logger.error(`[Inbound:${callId}] Error getting inbound session from Redis:`, err);
      return null;
    }
    }

    async saveSessionToCallIdMapping(sessionId, callId, ttlSeconds = 3600) {
    try {
            const key = this._getMappingKey(sessionId);
            await this.client.set(key, callId, { EX: ttlSeconds });
            logger.debug(`[${sessionId}] Session to callId mapping saved to Redis.`);
        } catch (err) {
            logger.error(`[${sessionId}] Error saving mapping to Redis:`, err);
      }
    }

    async getCallIdForSession(sessionId) {
        try {
            const key = this._getMappingKey(sessionId);
            return await this.client.get(key);
        } catch (err) {
            logger.error(`[${sessionId}] Error getting callId mapping from Redis:`, err);
            return null;
    }
    }

    async deleteSessionToCallIdMapping(sessionId) {
    try {
            const key = this._getMappingKey(sessionId);
            await this.client.del(key);
            logger.debug(`[${sessionId}] Session to callId mapping deleted from Redis.`);
        } catch (err) {
            logger.error(`[${sessionId}] Error deleting mapping from Redis:`, err);
        }
    }

    // New methods for session ownership management
    async acquireSessionOwnership(sessionId, processId, ttlSeconds = 30) {
        const key = this._getOwnershipKey(sessionId);
        const logPrefix = `[${sessionId}]`;
        
        try {
            // Use Redis NX option for atomic "set if not exists"
            const result = await this.client.set(key, String(processId), {
                EX: ttlSeconds,
                NX: true // Only set if key doesn't exist
            });
            
            if (result === 'OK') {
                logger.debug(`${logPrefix} Process ${processId} acquired ownership for ${ttlSeconds}s`);
      return true;
            } else {
                // Key already exists, ownership is with another process
                const currentOwner = await this.client.get(key);
                logger.debug(`${logPrefix} Cannot acquire ownership, already owned by process ${currentOwner}`);
                return false;
            }
        } catch (err) {
            logger.error(`${logPrefix} Error acquiring session ownership in Redis:`, err);
      return false;
    }
    }

    async updateSessionOwnership(sessionId, processId, ttlSeconds = 30) {
        const key = this._getOwnershipKey(sessionId);
        const logPrefix = `[${sessionId}]`;
        
        try {
            // Check if we own the session first
            const currentOwner = await this.client.get(key);
            
            if (!currentOwner) {
                // Session not owned, try to acquire
                return await this.acquireSessionOwnership(sessionId, processId, ttlSeconds);
            } else if (currentOwner === String(processId)) {
                // We already own it, just refresh TTL
                await this.client.expire(key, ttlSeconds);
      return true;
            } else {
                // Owned by another process
                logger.warn(`${logPrefix} Cannot update ownership TTL, owned by another process ${currentOwner}`);
      return false;
    }
        } catch (err) {
            logger.error(`${logPrefix} Error updating session ownership in Redis:`, err);
            return false;
        }
    }

    async releaseSessionOwnership(sessionId, processId) {
        const key = this._getOwnershipKey(sessionId);
        const logPrefix = `[${sessionId}]`;
        
        try {
            // Check if we own the session
            const currentOwner = await this.client.get(key);
            
            if (!currentOwner) {
                logger.debug(`${logPrefix} No ownership to release, key not found`);
                return true;
            } else if (currentOwner === String(processId)) {
                // We own it, release it
                await this.client.del(key);
                logger.debug(`${logPrefix} Process ${processId} released ownership`);
                return true;
            } else {
                // Owned by another process
                logger.warn(`${logPrefix} Cannot release ownership, owned by another process ${currentOwner}`);
                return false;
            }
        } catch (err) {
            logger.error(`${logPrefix} Error releasing session ownership in Redis:`, err);
      return false;
    }
    }

    async getSessionOwner(sessionId) {
        const key = this._getOwnershipKey(sessionId);
        
        try {
            const owner = await this.client.get(key);
            return owner ? parseInt(owner, 10) : null;
        } catch (err) {
            logger.error(`[${sessionId}] Error getting session owner from Redis:`, err);
            return null;
    }
    }

    // Method to publish audio to Redis Pub/Sub
    async publishAudio(channel, payload) {
        try {
            await this.publisher.publish(channel, payload);
      return true;
        } catch (err) {
            logger.error(`Error publishing to channel ${channel}:`, err);
      return false;
    }
  }
}

const sessionManager = new SessionManager(redisClient, publisherClient);

module.exports = {
    redisClient,
    subscriberClient,
    publisherClient,
    connectRedis,
    sessionManager,
    redisConnectionOptions,
    publishRedisMessage
}; 