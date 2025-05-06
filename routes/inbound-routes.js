const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const elevenlabs = require('../utils/elevenlabsClient');
const knowledgeBase = require('../utils/knowledgeBase');
const crypto = require('crypto');
const { sessionManager } = require('../utils/redisClient');
const { dbService } = require('../utils/dbClient');

// Secret for internal n8n communication
const N8N_INTERNAL_SECRET = process.env.N8N_INTERNAL_SECRET;

// Verify OpenPhone webhook signature OR internal N8N secret
const verifyWebhookSignature = (req, res, next) => {
  try {
    // Check for internal N8N secret first
    const n8nSecretHeader = req.headers['x-n8n-auth'];
    if (n8nSecretHeader && N8N_INTERNAL_SECRET && n8nSecretHeader === N8N_INTERNAL_SECRET) {
      logger.debug('Request authenticated via internal N8N secret.');
      return next(); // Bypass OpenPhone signature check
    }

    // If no N8N secret, proceed with OpenPhone signature check
    const signature = req.headers['x-openphone-signature'];
    const webhookSecret = process.env.OPENPHONE_WEBHOOK_SECRET;
    
    if (!signature || !webhookSecret) {
      logger.warn('Missing OpenPhone signature or webhook secret, and no valid N8N secret provided.'); // Changed to warn
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // Use rawBody if available (requires body-parser raw type)
    // If not, stringify might mangle the body needed for signature verification.
    // For now, assuming JSON parsing is okay, but this might need adjustment.
    let payload;
    if (req.rawBody) {
      payload = req.rawBody;
      logger.debug('Using rawBody for signature verification.');
    } else {
      payload = JSON.stringify(req.body);
      logger.warn('Using JSON.stringify(req.body) for signature verification. This might be unreliable. Consider using a raw body parser.');
    }
    
    const hmac = crypto.createHmac('sha256', webhookSecret);
    const digest = 'sha256=' + hmac.update(payload).digest('hex'); // Add sha256= prefix if OpenPhone requires it
    
    // Note: OpenPhone signature format might be 't=timestamp,v1=signature'
    // This verification logic assumes a simple hex digest. Adjust if needed based on actual OpenPhone header format.
    // Example parsing for 't=...,v1=...' format:
    // const elements = signature.split(',');
    // const signatureHash = elements.find(el => el.startsWith('v1=')).split('=')[1];
    // if (signatureHash !== digest) { ... }
    
    if (signature !== digest) { // Compare digests
      logger.error('Invalid OpenPhone webhook signature. Received: ', signature, ' Expected: ', digest);
      return res.status(401).json({ error: 'Invalid Signature' }); // More specific error
    }
    
    logger.debug('OpenPhone webhook signature verified successfully.');
    next();
  } catch (error) {
    logger.error('Error validating webhook signature:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// --- Placeholder Callbacks for Inbound ElevenLabs Sessions ---
// TODO: Implement detailed logic for handling messages, errors, etc. for inbound calls
async function handleElevenLabsMessageInbound(sessionId, message) {
    logger.debug(`[${sessionId}] Inbound ElevenLabs Message: ${message.type}`);
    const callId = await sessionManager.getCallIdForSession(sessionId); // Need reverse lookup
    if (!callId) {
        logger.error(`[${sessionId}] Cannot find callId for inbound message.`);
        return;
    }
    // Example: Store message
    // await sessionManager.addInboundMessage(callId, { role: '...', text: '...', timestamp: new Date().toISOString() });
    // Example: Trigger actions based on agent response or user transcript
}

async function handleElevenLabsErrorInbound(sessionId, error) {
    logger.error(`[${sessionId}] Inbound ElevenLabs Error:`, error.message);
    const callId = await sessionManager.getCallIdForSession(sessionId);
    if (callId) {
        // Update call status? Log error against call?
        // await sessionManager.updateInboundCallStatus(callId, 'error');
    }
}

async function handleElevenLabsCloseInbound(sessionId, code, reason) {
    logger.warn(`[${sessionId}] Inbound ElevenLabs Connection Closed: ${code} ${reason}`);
    const callId = await sessionManager.getCallIdForSession(sessionId);
    if (callId) {
        // Finalize call state?
        // await sessionManager.updateInboundCallStatus(callId, 'closed');
    }
}

async function handleElevenLabsReconnectingInbound(sessionId, attempt, delay) {
    logger.warn(`[${sessionId}] Inbound ElevenLabs Reconnecting (Attempt ${attempt}, Delay ${delay}ms)`);
    const callId = await sessionManager.getCallIdForSession(sessionId);
    if (callId) {
        // Update call status?
        // await sessionManager.updateInboundCallStatus(callId, 'reconnecting');
    }
}

// Handle incoming calls from OpenPhone
router.post('/call', verifyWebhookSignature, async (req, res) => {
  try {
    const { callId, from, to, state } = req.body; // callId from OpenPhone
    const logPrefix = `[${callId}]`;

    logger.info(`${logPrefix} Incoming call event: ${state} from ${from} to ${to}`);

    // Only process calls in 'ringing' state (received from OpenPhone webhook)
    if (state !== 'ringing') { 
      logger.info(`${logPrefix} Ignoring call event with state: ${state}`);
      return res.status(200).json({ message: 'Webhook received, state ignored' });
    }
    
    // Start an ElevenLabs conversation session
    // Removed await, pass callbacks, get sessionId immediately
    const elevenLabsSessionId = elevenlabs.startConversation(
        process.env.ELEVENLABS_AGENT_ID, // Default agent
        handleElevenLabsMessageInbound,
        handleElevenLabsErrorInbound,
        handleElevenLabsCloseInbound,
        handleElevenLabsReconnectingInbound
    );
    logger.info(`${logPrefix} Initiated ElevenLabs session: ${elevenLabsSessionId}. Connection pending.`);

    // Session data
    const startTime = new Date();
    const sessionData = {
      sessionId: elevenLabsSessionId, // Use the actual session ID from ElevenLabs
      from,
      to,
      startTime: startTime.toISOString(),
      status: 'active' // Initial status for the *call* session
    };
    
    // Store in Redis, mapping OpenPhone callId to ElevenLabs sessionId
    await sessionManager.saveInboundSession(callId, sessionData);
    // TODO: Ensure sessionManager supports saving/retrieving this mapping correctly
    // You might also need a reverse mapping: elevenLabsSessionId -> callId for callbacks
    await sessionManager.saveSessionToCallIdMapping(elevenLabsSessionId, callId); 
    
    // Create record in database for permanent storage
    // Use upsert to handle potential duplicate webhook calls
    await dbService.upsertCallByExternalId(callId, {
      call_id: callId, // OpenPhone Call ID
      session_id: elevenLabsSessionId, // ElevenLabs Session ID
      direction: 'inbound',
      from_number: from,
      to_number: to,
      start_time: startTime,
      status: 'active',
      call_data: { provider: 'openphone' }
    });
    
    logger.info(`${logPrefix} Associated with ElevenLabs session ${elevenLabsSessionId}`);
    
    // Return success to acknowledge the webhook, include the actual session ID
    res.status(200).json({ 
      sessionId: elevenLabsSessionId,
      message: 'Conversation started'
    });
  } catch (error) {
    // Note: elevenLabsSessionId might be null if startConversation itself threw an error
    const sessionForLog = error.elevenLabsSessionId || 'unknown_session'; 
    logger.error(`[${req.body?.callId || 'unknown_call'}] Error handling incoming call:`, error);
    // Attempt cleanup if session was initiated before error
    if (error.elevenLabsSessionId) {
        logger.warn(`[${error.elevenLabsSessionId}] Attempting cleanup of ElevenLabs session due to error during inbound call initiation.`);
        elevenlabs.endConversation(error.elevenLabsSessionId);
    }
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Receive voice input from the call (This seems more like text input from OpenPhone?)
// If using actual voice streaming, this endpoint would change significantly.
router.post('/voice', verifyWebhookSignature, async (req, res) => {
  try {
    const { callId, text } = req.body; // Assuming text input for now
    const logPrefix = `[${callId}]`;
    
    if (!callId || !text) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    // Get the call session info (which includes the elevenLabsSessionId)
    let callSession = await sessionManager.getInboundSession(callId);
    
    if (!callSession || !callSession.sessionId) {
      logger.error(`${logPrefix} Active session or ElevenLabs Session ID not found in Redis.`);
      return res.status(404).json({ error: 'Active session not found' });
    }

    const elevenLabsSessionId = callSession.sessionId;
    const elevenLabsStatus = elevenlabs.getSessionStatus(elevenLabsSessionId);

    logger.info(`${logPrefix} Received voice input for ElevenLabs session ${elevenLabsSessionId} (Status: ${elevenLabsStatus}): ${text}`);
    
    // User message object
    const userMessageTimestamp = new Date();
    const userMessage = {
      role: 'user',
      text,
      timestamp: userMessageTimestamp.toISOString()
    };
    
    // Store in Redis mapped to OpenPhone callId
    await sessionManager.addInboundMessage(callId, userMessage);
    
    // Query the knowledge base
    // const knowledgeResults = await knowledgeBase.queryKnowledgeBase(text);

    // Send message to ElevenLabs conversational AI, check if active
    if (elevenlabs.isSessionActive(elevenLabsSessionId)) {
        // If the ElevenLabs API supports sending text input via WebSocket:
        // elevenlabs.sendTextInput(elevenLabsSessionId, text);
        // logger.info(`${logPrefix} Sent text input to ElevenLabs session ${elevenLabsSessionId}`);
        
        // OR if you need to use the HTTP endpoint for sending messages:
        logger.warn(`${logPrefix} Sending text via HTTP (sendMessage) - Check if WS input is supported/preferred.`);
        // const response = await elevenlabs.sendMessage(elevenLabsSessionId, text); // Original HTTP?
        // This part needs clarification based on how OpenPhone input maps to ElevenLabs interaction
        // For now, let's assume we don't send text this way, but wait for WS responses.
        
        // Placeholder: If expecting audio back, this response needs structuring
        res.status(200).json({
          text: "Processing input...", // Placeholder response
          audioBase64: null
        });

    } else {
        logger.error(`${logPrefix} Cannot send input to ElevenLabs session ${elevenLabsSessionId}, status is ${elevenLabsStatus}.`);
         res.status(503).json({ error: 'Agent session not active. Please try again later.' });
         return;
    }
    
    // --- Agent response handling (moved to handleElevenLabsMessageInbound callback) ---
    // const agentMessageTimestamp = new Date();
    // const agentMessage = { ... };
    // await sessionManager.addInboundMessage(callId, agentMessage);
    // ... DB saving ...
    // const audioBuffer = await elevenlabs.textToSpeech(response.text); // TTS likely triggered by agent response in callback
    // res.status(200).json({ text: response.text, audioBase64: audioBuffer.toString('base64') });

  } catch (error) {
    logger.error(`[${req.body?.callId || 'unknown_call'}] Error processing voice input:`, error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// End the conversation when call ends
router.post('/hangup', verifyWebhookSignature, async (req, res) => {
  try {
    const { callId, state } = req.body;
    const logPrefix = `[${callId}]`;

    if (state !== 'ended') {
      logger.debug(`${logPrefix} Ignoring hangup webhook with state ${state}`);
      return res.status(200).json({ message: 'Webhook received, state ignored' });
    }
    
    // Get the call session info to find the ElevenLabs session ID
    let callSession = await sessionManager.getInboundSession(callId);
    
    if (!callSession) {
      // Session might already be cleaned up, or never existed. Log and return OK.
      logger.warn(`${logPrefix} Call session not found in Redis during hangup (might be already processed or failed).`);
      return res.status(200).json({ message: 'Session not found, hangup acknowledged' });
    }
    
    const elevenLabsSessionId = callSession.sessionId;
    logger.info(`${logPrefix} Call ended. Attempting to close ElevenLabs session ${elevenLabsSessionId}`);
    
    // End the ElevenLabs conversation session if the ID exists
    if (elevenLabsSessionId) {
        try {
            // Check status before ending? Optional.
            // const status = elevenlabs.getSessionStatus(elevenLabsSessionId);
            // logger.info(`${logPrefix} Ending ElevenLabs session ${elevenLabsSessionId} (Current Status: ${status})`);
            elevenlabs.endConversation(elevenLabsSessionId);
        } catch (elevenError) {
            // Log error but continue cleanup
            logger.error(`${logPrefix} Error explicitly ending ElevenLabs session ${elevenLabsSessionId}:`, elevenError);
        }
        // Clean up reverse mapping
        await sessionManager.deleteSessionToCallIdMapping(elevenLabsSessionId);
    } else {
        logger.warn(`${logPrefix} No ElevenLabs session ID found associated with call during hangup.`);
    }

    // Update call record in database
    const call = await dbService.getCallByExternalId(callId);
    const endTime = new Date();
    let duration = null;

    if (call) {
      if (call.start_time) {
          duration = Math.floor((endTime - new Date(call.start_time)) / 1000);
      }
      
      await dbService.updateCall(call.id, {
        end_time: endTime,
        duration: duration,
        status: 'completed' // Assuming 'ended' means completed successfully
      });
      logger.info(`${logPrefix} Updated call record ${call.id} in DB to completed.`);
    } else {
         logger.warn(`${logPrefix} DB record not found for call during hangup processing.`);
    }

    // Remove session from Redis
    await sessionManager.deleteInboundSession(callId);
    logger.info(`${logPrefix} Removed inbound session data from Redis.`);

    res.status(200).json({ message: 'Hangup processed successfully' });

  } catch (error) {
    logger.error(`[${req.body?.callId || 'unknown_call'}] Error processing hangup:`, error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

module.exports = router; 