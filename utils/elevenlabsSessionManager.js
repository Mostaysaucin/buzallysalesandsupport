/**
 * ElevenLabs Session Manager
 * 
 * Manages ElevenLabs sessions in Redis to ensure proper tracking
 * and initialization of audio sessions.
 */

const logger = require('./logger');
const { redisClient } = require('./redisClient');

// Session key prefix in Redis
const SESSION_KEY_PREFIX = 'elevenlabs_session:';

class ElevenLabsSessionManager {
    constructor() {
        this.sessionTimeoutMs = 3600 * 1000; // 1 hour default timeout
    }

    /**
     * Creates or updates a session in Redis
     * @param {string} sessionId - The session ID
     * @param {object} sessionData - Session data to store
     * @param {number} ttlSeconds - Time to live in seconds (default: 1 hour)
     */
    async saveSession(sessionId, sessionData, ttlSeconds = 3600) {
        const key = this._getSessionKey(sessionId);
        try {
            // Add timestamp for tracking
            const dataWithTimestamp = {
                ...sessionData,
                updatedAt: new Date().toISOString(),
                createdAt: sessionData.createdAt || new Date().toISOString()
            };
            
            await redisClient.set(key, JSON.stringify(dataWithTimestamp), { EX: ttlSeconds });
            logger.debug(`[${sessionId}] ElevenLabs session saved to Redis`);
            return true;
        } catch (error) {
            logger.error(`[${sessionId}] Error saving ElevenLabs session to Redis: ${error.message}`);
            return false;
        }
    }

    /**
     * Get session data from Redis
     * @param {string} sessionId - The session ID
     * @returns {object|null} Session data or null if not found
     */
    async getSession(sessionId) {
        const key = this._getSessionKey(sessionId);
        try {
            const data = await redisClient.get(key);
            return data ? JSON.parse(data) : null;
        } catch (error) {
            logger.error(`[${sessionId}] Error getting ElevenLabs session from Redis: ${error.message}`);
            return null;
        }
    }

    /**
     * Update session status in Redis
     * @param {string} sessionId - The session ID
     * @param {string} status - New status value
     * @returns {boolean} Success indicator
     */
    async updateSessionStatus(sessionId, status) {
        try {
            const session = await this.getSession(sessionId);
            if (!session) {
                logger.warn(`[${sessionId}] Cannot update status: session not found`);
                return false;
            }
            
            session.status = status;
            session.updatedAt = new Date().toISOString();
            
            return await this.saveSession(sessionId, session);
        } catch (error) {
            logger.error(`[${sessionId}] Error updating session status: ${error.message}`);
            return false;
        }
    }

    /**
     * Activates an ElevenLabs session in Redis
     * @param {string} sessionId - The session ID to activate
     * @param {object} options - Activation options
     * @returns {boolean} Success indicator
     */
    async activateSession(sessionId, options = {}) {
        const {
            callSid,
            agentId = process.env.ELEVENLABS_AGENT_ID,
            voiceId = process.env.ELEVENLABS_VOICE_ID,
            streamingEnabled = true
        } = options;
        
        try {
            // Check if session exists
            const existingSession = await this.getSession(sessionId);
            const sessionData = {
                ...(existingSession || {}),
                status: 'ACTIVE',
                callSid: callSid || (existingSession?.callSid || null),
                agentId,
                voiceId,
                streamingEnabled,
                activatedAt: new Date().toISOString()
            };
            
            return await this.saveSession(sessionId, sessionData);
        } catch (error) {
            logger.error(`[${sessionId}] Error activating ElevenLabs session: ${error.message}`);
            return false;
        }
    }

    /**
     * Deactivates an ElevenLabs session in Redis
     * @param {string} sessionId - The session ID to deactivate
     * @param {string} reason - Reason for deactivation
     * @returns {boolean} Success indicator
     */
    async deactivateSession(sessionId, reason = 'user_request') {
        try {
            const session = await this.getSession(sessionId);
            if (!session) {
                logger.warn(`[${sessionId}] Cannot deactivate: session not found`);
                return false;
            }
            
            session.status = 'INACTIVE';
            session.deactivatedAt = new Date().toISOString();
            session.deactivationReason = reason;
            
            return await this.saveSession(sessionId, session);
        } catch (error) {
            logger.error(`[${sessionId}] Error deactivating session: ${error.message}`);
            return false;
        }
    }

    /**
     * Check if a session is active
     * @param {string} sessionId - The session ID to check
     * @returns {boolean} True if active, false otherwise
     */
    async isSessionActive(sessionId) {
        try {
            const session = await this.getSession(sessionId);
            return session && session.status === 'ACTIVE';
        } catch (error) {
            logger.error(`[${sessionId}] Error checking session status: ${error.message}`);
            return false;
        }
    }

    /**
     * Delete a session from Redis
     * @param {string} sessionId - The session ID to delete
     * @returns {boolean} Success indicator
     */
    async deleteSession(sessionId) {
        const key = this._getSessionKey(sessionId);
        try {
            await redisClient.del(key);
            logger.debug(`[${sessionId}] ElevenLabs session deleted from Redis`);
            return true;
        } catch (error) {
            logger.error(`[${sessionId}] Error deleting ElevenLabs session: ${error.message}`);
            return false;
        }
    }

    /**
     * Get Redis key for a session
     * @private
     * @param {string} sessionId - The session ID
     * @returns {string} Redis key
     */
    _getSessionKey(sessionId) {
        return `${SESSION_KEY_PREFIX}${sessionId}`;
    }
}

// Export a singleton instance
const elevenlabsSessionManager = new ElevenLabsSessionManager();
module.exports = elevenlabsSessionManager; 