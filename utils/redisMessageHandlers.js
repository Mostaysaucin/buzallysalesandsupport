/**
 * Redis Message Handlers
 * 
 * Handles various message types published to Redis channels.
 */

const logger = require('./logger');
const elevenlabsSessionManager = require('./elevenlabsSessionManager');
const elevenlabs = require('./elevenlabsClient');
const { 
    handleElevenLabsMessage, 
    handleElevenLabsError, 
    handleElevenLabsClose,
    handleElevenLabsReconnecting
} = require('./elevenlabsHandlers');

/**
 * Handle elevenlabs-session-start message
 * 
 * @param {string} messageData - The JSON string message data
 */
async function handleElevenLabsSessionStart(messageData) {
    try {
        const data = JSON.parse(messageData);
        const { sessionId, callSid, agentId, voiceId, useStreaming } = data;
        
        if (!sessionId) {
            logger.error('Invalid elevenlabs-session-start message: missing sessionId');
            return;
        }
        
        logger.info(`[${sessionId}] Processing elevenlabs-session-start event`);
        
        // Save the session in Redis using our dedicated session manager
        await elevenlabsSessionManager.activateSession(sessionId, {
            callSid,
            agentId: agentId || process.env.ELEVENLABS_AGENT_ID,
            voiceId: voiceId || process.env.ELEVENLABS_VOICE_ID,
            streamingEnabled: useStreaming !== false
        });
        
        logger.info(`[${sessionId}] ElevenLabs session activated in Redis`);
        
        // Check if we already have an active WebSocket connection
        const isActive = elevenlabs.isSessionActive(sessionId);
        
        if (isActive) {
            logger.info(`[${sessionId}] ElevenLabs WebSocket already active, skipping connection`);
            
            // Even if active, let's send a welcome text to start audio immediately
            try {
                await elevenlabs.sendTextInput(sessionId, "Hello, I'm your voice assistant. How can I help you today?");
                logger.info(`[${sessionId}] Sent welcome message to already active session`);
            } catch (textError) {
                logger.error(`[${sessionId}] Error sending welcome text to active session: ${textError.message}`);
            }
            
            return;
        }
        
        // Attempt to start the conversation with the provided session ID
        logger.info(`[${sessionId}] Starting ElevenLabs conversation with agent ${agentId || process.env.ELEVENLABS_AGENT_ID}`);
        
        // Start conversation WebSocket with retry logic
        const MAX_RETRIES = 3;
        let retryCount = 0;
        let connectionSuccess = false;
        
        while (retryCount < MAX_RETRIES && !connectionSuccess) {
            try {
                await elevenlabs.startConversation(
                    agentId || process.env.ELEVENLABS_AGENT_ID,
                    handleElevenLabsMessage,
                    handleElevenLabsError,
                    handleElevenLabsClose,
                    handleElevenLabsReconnecting,
                    sessionId
                );
                
                logger.info(`[${sessionId}] ElevenLabs conversation initiated`);
                
                // Wait for connection to establish
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                // Check if connection is active
                connectionSuccess = elevenlabs.isSessionActive(sessionId);
                if (connectionSuccess) {
                    logger.info(`[${sessionId}] ElevenLabs WebSocket connection established successfully`);
                    
                    // Send a welcome message
                    try {
                        await elevenlabs.sendTextInput(sessionId, "Hello, I'm your voice assistant. How can I help you today?");
                        logger.info(`[${sessionId}] Sent welcome message`);
                    } catch (textError) {
                        logger.error(`[${sessionId}] Error sending welcome text: ${textError.message}`);
                    }
                    
                    break;
                } else {
                    logger.warn(`[${sessionId}] ElevenLabs connection attempt ${retryCount + 1} failed - socket not active after delay`);
                    retryCount++;
                    
                    // Try to end any partially established connection
                    try {
                        await elevenlabs.endConversation(sessionId);
                    } catch (endError) {
                        logger.error(`[${sessionId}] Error ending failed session: ${endError.message}`);
                    }
                    
                    // Wait before retrying
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            } catch (connectionError) {
                logger.error(`[${sessionId}] Connection attempt ${retryCount + 1} failed: ${connectionError.message}`);
                retryCount++;
                
                if (retryCount >= MAX_RETRIES) {
                    logger.error(`[${sessionId}] Failed to establish ElevenLabs connection after ${MAX_RETRIES} attempts`);
                    await elevenlabsSessionManager.updateSessionStatus(sessionId, 'CONNECTION_FAILED');
                } else {
                    // Wait before retrying
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
        }
        
        if (!connectionSuccess) {
            logger.error(`[${sessionId}] Could not establish ElevenLabs WebSocket connection after ${MAX_RETRIES} attempts`);
            await elevenlabsSessionManager.updateSessionStatus(sessionId, 'CONNECTION_FAILED');
        }
        
    } catch (error) {
        logger.error(`Error handling elevenlabs-session-start: ${error.message}`);
        logger.error(error.stack);
    }
}

/**
 * Handle elevenlabs-tts-request message
 * 
 * @param {string} messageData - The JSON string message data
 */
async function handleElevenLabsTtsRequest(messageData) {
    try {
        const data = JSON.parse(messageData);
        const { sessionId, text, voiceId, modelId } = data;
        
        if (!sessionId || !text) {
            logger.error('Invalid elevenlabs-tts-request message: missing required fields');
            return;
        }
        
        logger.info(`[${sessionId}] Processing elevenlabs-tts-request: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
        
        // Send the text as a message to ElevenLabs
        await elevenlabs.sendTextInput(sessionId, text);
        
        logger.info(`[${sessionId}] Text sent to ElevenLabs for synthesis`);
    } catch (error) {
        logger.error(`Error handling elevenlabs-tts-request: ${error.message}`);
        logger.error(error.stack);
    }
}

/**
 * Handle elevenlabs-session-end message
 * 
 * @param {string} messageData - The JSON string message data
 */
async function handleElevenLabsSessionEnd(messageData) {
    try {
        const data = JSON.parse(messageData);
        const { sessionId, reason } = data;
        
        if (!sessionId) {
            logger.error('Invalid elevenlabs-session-end message: missing sessionId');
            return;
        }
        
        logger.info(`[${sessionId}] Processing elevenlabs-session-end event`);
        
        // Update session status in Redis
        await elevenlabsSessionManager.deactivateSession(sessionId, reason);
        
        // End the conversation
        await elevenlabs.endConversation(sessionId);
        
        logger.info(`[${sessionId}] ElevenLabs session ended`);
    } catch (error) {
        logger.error(`Error handling elevenlabs-session-end: ${error.message}`);
        logger.error(error.stack);
    }
}

module.exports = {
    handleElevenLabsSessionStart,
    handleElevenLabsTtsRequest,
    handleElevenLabsSessionEnd
}; 