/**
 * ElevenLabs Handlers Module
 * 
 * This module provides handler functions for processing ElevenLabs messages
 * and managing audio data between ElevenLabs and Twilio.
 */

const logger = require('./logger');
const { publishRedisMessage, getRedisClient } = require('./redisClient');
// Standardize on a clearer prefix name that indicates this is for ElevenLabs audio going to Twilio
const AUDIO_CHANNEL_PREFIX = 'elevenlabs-to-twilio:';

// Add a prefix for Twilio audio going to ElevenLabs
const TWILIO_AUDIO_CHANNEL_PREFIX = 'twilio-to-elevenlabs:';

// Track sequence numbers for ordered audio delivery
const sequenceCounters = new Map(); // sessionId -> current sequence number

// Add a debug utility function to dump the first part of base64 content as hex
function dumpAudioHex(base64Data, maxBytes = 32) {
  try {
    // Decode a small part of the base64 data for inspection
    const buffer = Buffer.from(base64Data, 'base64');
    const sampleSize = Math.min(buffer.length, maxBytes);
    const sample = buffer.slice(0, sampleSize);
    const hex = sample.toString('hex').match(/.{1,2}/g).join(' ');
    return `First ${sampleSize} bytes (hex): ${hex}`;
  } catch (error) {
    return `Error creating hex dump: ${error.message}`;
  }
}

/**
 * Handle messages from ElevenLabs WebSocket
 * @param {string} sessionId - The session ID
 * @param {object} message - The message received from ElevenLabs
 */
async function handleElevenLabsMessage(sessionId, message) {
  const logPrefix = `[${sessionId}]`;
  
  try {
    // Determine message type
    if (typeof message === 'string') {
      try {
        message = JSON.parse(message);
      } catch (error) {
        logger.error(`${logPrefix} Error parsing message as JSON:`, error);
        return;
      }
    }

    // Save message to debug logs for troubleshooting
    const messageType = message.type || 'unknown';
    logger.info(`${logPrefix} Received ElevenLabs message type: ${messageType}`);
    
    if (messageType === 'audio') {
      // Handle audio data from ElevenLabs
      await handleAudioMessage(sessionId, message);
    } else if (messageType === 'agent_response') {
      // Handle text responses from the agent
      await handleAgentResponse(sessionId, message);
    } else if (messageType === 'conversation_initiation_metadata') {
      // Handle metadata about the conversation
      logger.info(`${logPrefix} Received conversation metadata: ${JSON.stringify(message)}`);
    } else if (messageType === 'user_transcript') {
      // Handle user transcript - useful for debugging but no audio processing needed
      const transcript = message.user_transcript_event?.text || message.transcript || '';
      logger.info(`${logPrefix} User transcript: "${transcript}"`);
    } else {
      logger.info(`${logPrefix} Received message of type ${messageType} (not processed)`);
    }

  } catch (error) {
    logger.error(`${logPrefix} Error handling ElevenLabs message:`, error);
  }
}

/**
 * Handle audio data from ElevenLabs
 * @param {string} sessionId - The session ID
 * @param {object} message - The audio message
 */
async function handleAudioMessage(sessionId, message) {
  const logPrefix = `[${sessionId}]`;
  try {
    // Get the base64 audio data
    const audioBase64 = message.audio_event?.data || message.audio_data;
    
    if (!audioBase64) {
      logger.warn(`${logPrefix} Received audio message without data`);
      return;
    }
    
    // Enhanced audio logging - include format and detailed size info
    logger.info(`${logPrefix} [DEBUG] Received audio message with base64 data of length: ${audioBase64.length} bytes`);
    
    // Add a small hex dump of the first few bytes to help debug format issues
    const hexDump = dumpAudioHex(audioBase64);
    logger.info(`${logPrefix} [DEBUG] Audio content sample: ${hexDump}`);
    
    // Get session information from Redis
    const redisClient = getRedisClient();
    const sessionRedisKey = `session:${sessionId}`;
    const sessionJson = await redisClient.get(sessionRedisKey);
    logger.info(`${logPrefix} [DEBUG] Redis session lookup (key=${sessionRedisKey}): ${sessionJson ? 'FOUND' : 'NOT FOUND'}`);
    
    // Track sequence numbers for ordered delivery
    if (!sequenceCounters.has(sessionId)) {
      sequenceCounters.set(sessionId, 0);
    }
    const sequenceNumber = sequenceCounters.get(sessionId);
    sequenceCounters.set(sessionId, sequenceNumber + 1);
    
    // Source of audio - either ElevenLabs directly or our speech synthesis
    const source = 'direct-audio';
    
    // Format data as JSON for the server process to send to Twilio
    const payload = JSON.stringify({ 
      audioBase64,
      source,
      timestamp: Date.now(),
      processId: process.pid,
      format: 'ulaw', // Use ulaw format string for Twilio compatibility
      sampleRate: 8000, // explicitly mark sample rate
      sequenceNumber, // Add sequence number for proper ordering
      track: 'outbound', // Explicitly mark as outbound audio (from us to caller)
      contentType: 'audio/x-mulaw', // Use standard MIME type
    });
    
    logger.info(`${logPrefix} [DEBUG] Prepared audio payload with metadata: format=ulaw, sampleRate=8000, processId=${process.pid}, sequenceNumber=${sequenceNumber}`);
    
    if (sessionJson) {
      const sessionData = JSON.parse(sessionJson);
      
      // Log detailed session data to help with debugging
      logger.info(`${logPrefix} [DEBUG] Session data from Redis: ${JSON.stringify(sessionData)}`);
      
      if (sessionData.ownerProcess && sessionData.ownerProcess !== process.pid) {
        // Owned by another process - publish to Redis for that process
        logger.info(`${logPrefix} Server process ${sessionData.ownerProcess} is handling WebSocket. Publishing audio from ${source}.`);
        
        // Publish to Redis channel for the server process to pick up
        const channel = `${AUDIO_CHANNEL_PREFIX}${sessionId}`;
        logger.info(`${logPrefix} [DEBUG] Publishing audio to Redis channel: ${channel}`);
        
        try {
          await publishRedisMessage(channel, payload);
          logger.info(`${logPrefix} [DEBUG] Successfully published audio chunk to Redis channel ${channel} (length=${payload.length})`);
        } catch (redisError) {
          logger.error(`${logPrefix} [DEBUG] Failed to publish audio to Redis: ${redisError.message}`);
        }
        
      } else if (sessionData.serverHandling && sessionData.serverHandling !== process.pid) {
        // The session might be owned by this process but WebSocket is handled by another
        logger.info(`${logPrefix} [DEBUG] WebSocket handled by server process ${sessionData.serverHandling}. Publishing audio.`);
        
        const channel = `${AUDIO_CHANNEL_PREFIX}${sessionId}`;
        try {
          await publishRedisMessage(channel, payload);
          logger.info(`${logPrefix} [DEBUG] Successfully published audio chunk to Redis channel ${channel} for server ${sessionData.serverHandling}`);
        } catch (redisError) {
          logger.error(`${logPrefix} [DEBUG] Failed to publish audio to Redis: ${redisError.message}`);
        }
      } else {
        // We own this session, but no specific WebSocket handler found
        logger.warn(`${logPrefix} [DEBUG] Published audio (${source}) - no WebSocket handler explicitly found in Redis data. Session may be misconfigured.`);
        
        // Try publishing to Redis anyway, in case another process is listening
        const channel = `${AUDIO_CHANNEL_PREFIX}${sessionId}`;
        try {
          await publishRedisMessage(channel, payload);
          logger.info(`${logPrefix} [DEBUG] Defensively published audio to Redis channel ${channel}`);
        } catch (redisError) {
          logger.error(`${logPrefix} [DEBUG] Failed to publish defensive audio to Redis: ${redisError.message}`);
        }
      }
    } else {
      logger.warn(`${logPrefix} [DEBUG] Published audio (${source}) - no session data found in Redis. This likely indicates a configuration issue.`);
      
      // Try publishing to Redis anyway as a fallback
      const channel = `${AUDIO_CHANNEL_PREFIX}${sessionId}`;
      try {
        await publishRedisMessage(channel, payload);
        logger.info(`${logPrefix} [DEBUG] Fallback published audio to Redis channel ${channel} despite missing session data`);
      } catch (redisError) {
        logger.error(`${logPrefix} [DEBUG] Failed to publish fallback audio to Redis: ${redisError.message}`);
      }
    }
  } catch (error) {
    logger.error(`${logPrefix} Error handling audio message:`, error);
    // Add a detailed stack trace for debugging
    logger.error(`${logPrefix} [DEBUG] Stack trace: ${error.stack}`);
  }
}

/**
 * Handle agent response messages (text)
 * @param {string} sessionId - The session ID
 * @param {object} message - The agent response message
 */
async function handleAgentResponse(sessionId, message) {
  const logPrefix = `[${sessionId}]`;
  try {
    // Log receiving the agent response
    const keys = Object.keys(message).join(', ');
    logger.info(`${logPrefix} Received agent_response with keys: ${keys}`);
    
    // Add more detailed logging of the message content
    logger.info(`${logPrefix} [DEBUG] Full agent_response message content: ${JSON.stringify(message)}`);
    if (message.agent_response_event) {
      logger.info(`${logPrefix} [DEBUG] agent_response_event content: ${JSON.stringify(message.agent_response_event)}`);
    }
    
    // Extract the text from the response - using the correct field name
    // The field could be agent_response, text, or nested in agent_response_event
    const text = message.agent_response_event?.agent_response || 
                message.agent_response_event?.text || 
                message.text || 
                message.agent_response;
    
    if (text) {
      logger.info(`${logPrefix} Agent text response: "${text}"`);
    } else {
      logger.warn(`${logPrefix} [DEBUG] No text found in agent_response message - this could indicate a configuration issue`);
      logger.warn(`${logPrefix} [DEBUG] Message keys: ${keys}`);
    }
    
    // Check for audio data in the agent_response
    const hasAudioEvent = !!message.audio_event;
    const hasAudioData = !!message.audio_data;
    const hasAudioInAgentResponseEvent = !!message.agent_response_event?.audio_base64;
    
    logger.info(`${logPrefix} [DEBUG] Audio data check: hasAudioEvent=${hasAudioEvent}, hasAudioData=${hasAudioData}, hasAudioInAgentResponseEvent=${hasAudioInAgentResponseEvent}`);
    
    // Handle direct audio in agent_response_event if available
    if (message.agent_response_event?.audio_base64) {
      logger.info(`${logPrefix} [DEBUG] Found audio_base64 in agent_response_event, length: ${message.agent_response_event.audio_base64.length} bytes`);
      
      // Create an audio message to handle
      const audioMessage = {
        type: 'audio',
        audio_event: {
          data: message.agent_response_event.audio_base64
        }
      };
      
      // Process through our audio handler
      await handleAudioMessage(sessionId, audioMessage);
      return;
    }
    
    // Handle direct audio if available or synthesize speech if only text is provided
    if (!message.audio_event && !message.audio_data && text) {
      logger.info(`${logPrefix} [DEBUG] No direct audio found in agent_response, but text is present. Synthesizing speech...`);
      
      // Import elevenlabsClient here to avoid circular dependencies
      const elevenlabs = require('./elevenlabsClient');
      
      // Call the synthesizeResponseSpeech method to convert text to audio
      try {
        logger.info(`${logPrefix} [DEBUG] Calling synthesizeResponseSpeech with text: "${text}"`);
        const success = await elevenlabs.synthesizeResponseSpeech(sessionId, text);
        if (success) {
          logger.info(`${logPrefix} [DEBUG] Successfully synthesized speech for text: "${text}"`);
        } else {
          logger.error(`${logPrefix} [DEBUG] Failed to synthesize speech for text: "${text}". This is likely why you don't hear responses.`);
        }
      } catch (synthError) {
        logger.error(`${logPrefix} [DEBUG] Error synthesizing speech:`, synthError);
        logger.error(`${logPrefix} [DEBUG] Error stack: ${synthError.stack}`);
      }
    } else if (hasAudioEvent || hasAudioData) {
      logger.info(`${logPrefix} [DEBUG] Direct audio found in message - expecting it to be processed separately`);
    } else {
      logger.warn(`${logPrefix} [DEBUG] No audio or text found in agent_response - nothing to play to caller!`);
    }
  } catch (error) {
    logger.error(`${logPrefix} Error handling agent response:`, error);
    logger.error(`${logPrefix} [DEBUG] Error stack: ${error.stack}`);
  }
}

/**
 * Handle errors from ElevenLabs
 * @param {string} sessionId - The session ID 
 * @param {Error} error - The error object
 */
function handleElevenLabsError(sessionId, error) {
  const logPrefix = `[${sessionId}]`;
  logger.error(`${logPrefix} ElevenLabs WebSocket error:`, error);
}

/**
 * Handle WebSocket close events from ElevenLabs
 * @param {string} sessionId - The session ID
 * @param {number} code - The close code
 * @param {string} reason - The close reason
 */
function handleElevenLabsClose(sessionId, code, reason) {
  const logPrefix = `[${sessionId}]`;
  logger.info(`${logPrefix} ElevenLabs WebSocket closed. Code: ${code}, Reason: ${reason}`);
}

/**
 * Handle ElevenLabs reconnection events
 * @param {string} sessionId - The session ID
 */
function handleElevenLabsReconnecting(sessionId) {
  const logPrefix = `[${sessionId}]`;
  logger.warn(`${logPrefix} ElevenLabs WebSocket reconnecting...`);
}

/**
 * Replay any buffered audio chunks for a session
 * @param {string} sessionId - The session ID
 * @param {object} callInfo - Call information containing streamSid
 */
async function replayBufferedAudio(sessionId, callInfo) {
  const logPrefix = `[${sessionId}]`;
  logger.info(`${logPrefix} Checking for buffered audio to replay`);
  // Implement buffering logic if needed
  // This is a placeholder for audio buffering/replay functionality
}

// Export the functions for use in other modules
module.exports = {
  handleElevenLabsMessage,
  handleElevenLabsError,
  handleElevenLabsClose,
  handleElevenLabsReconnecting,
  AUDIO_CHANNEL_PREFIX,
  TWILIO_AUDIO_CHANNEL_PREFIX,
  sequenceCounters,
  replayBufferedAudio
};
