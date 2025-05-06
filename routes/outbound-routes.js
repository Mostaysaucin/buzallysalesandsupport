const express = require('express');
const router = express.Router();
const twilio = require('twilio');
const logger = require('../utils/logger');
const elevenlabs = require('../utils/elevenlabsClient');
const knowledgeBase = require('../utils/knowledgeBase');
const VoiceResponse = twilio.twiml.VoiceResponse;
const { redisClient, subscriberClient, sessionManager, redisConnectionOptions } = require('../utils/redisClient');
const { dbService } = require('../utils/dbClient');
const { v4: uuidv4 } = require('uuid'); // For generating session IDs and job IDs

// Import handlers from the new elevenlabsHandlers module
const { 
  handleElevenLabsMessage,
  handleElevenLabsError, 
  handleElevenLabsClose,
  handleElevenLabsReconnecting,
  AUDIO_CHANNEL_PREFIX,
  TWILIO_AUDIO_CHANNEL_PREFIX,
  sequenceCounters,
  replayBufferedAudio
} = require('../utils/elevenlabsHandlers');

// Rate Limiting
const rateLimit = require('express-rate-limit');
// const RedisStore = require('rate-limit-redis'); // Standard require
// const { RedisStore } = require('rate-limit-redis'); // Destructured require
const rateLimitRedis = require('rate-limit-redis'); // Import the whole module
const RedisStore = rateLimitRedis.RedisStore; // Access the property

// Initialize Twilio client
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// --- BullMQ Setup ---
const { Queue } = require('bullmq');
const QUEUE_NAME = 'outbound-calls';
const outboundCallQueue = new Queue(QUEUE_NAME, {
    connection: redisConnectionOptions,
    defaultJobOptions: {
        attempts: 3, // Retry failed jobs 3 times
        backoff: { type: 'exponential', delay: 1000 } // Exponential backoff
    }
});
logger.info(`Queue '${QUEUE_NAME}' initialized.`);
// ---------------------

// --- Rate Limiter Placeholder --- 
// We will initialize this AFTER Redis connects
let startCallLimiter = (req, res, next) => {
    // Default to allow if not initialized (shouldn't happen in normal flow)
    logger.warn('Rate limiter accessed before initialization!');
    next(); 
};
// --------------------------------

// --- WebSocket Setup (for Twilio Stream) ---
// This needs to be integrated with the main Express app server instance
// We'll define the logic here, but the WebSocket server needs to be attached
// to the HTTP server created in server.js

const WebSocket = require('ws');

// Import the standardized Redis Pub/Sub channel prefix from elevenlabsHandlers
// This is a clearer name than the older version that was: 'twilio-audio:'
// const AUDIO_CHANNEL_PREFIX = 'twilio-audio:';

const serverAudioBuffers = new Map(); // sessionId -> array of payload strings
const MAX_SERVER_BUFFER_SIZE = 20; // limit buffered chunks per session
let wssInstance = null; // Store WebSocket server reference globally

function setupWebSocketServer(httpServer) {
  // Match any path starting with /api/outbound/stream/
  // Ensure this path doesn't conflict with other WebSocket paths
  const wss = new WebSocket.Server({
       noServer: true, // We'll handle upgrade manually for path matching
       clientTracking: true // Keep track of clients for broadcasting/targeting if needed (though Pub/Sub is better)
  });
  
  // Store wss reference globally
  wssInstance = wss;

  // Handle HTTP upgrade requests to filter for our specific path
  httpServer.on('upgrade', (request, socket, head) => {
    const pathname = require('url').parse(request.url).pathname;
    if (pathname.startsWith('/api/outbound/stream/')) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request); 
      });
    } else {
      // Close connections trying to connect to other paths on this endpoint
      // Or pass to another WebSocket server if you have multiple
      logger.warn(`WebSocket connection attempt rejected for path: ${pathname}`);
      socket.destroy();
    }
  });


  // Store active subscriptions for cleanup: Map<sessionId, Function>
  const activeSubscriptions = new Map();

  wss.on('connection', async (ws, req) => { // Make handler async
    logger.info(`>>> WebSocket connection event fired. Original URL: ${req.url}`);
    // Extract session ID from the PATH
    let sessionId; // This sessionId corresponds to the ElevenLabs session
    try {
      const url = require('url');
      const parsedPath = url.parse(req.url).pathname;
      const pathParts = parsedPath.split('/');
      // Expecting /api/outbound/stream/SESSION_ID
      if (pathParts.length === 5 && pathParts[1] === 'api' && pathParts[2] === 'outbound' && pathParts[3] === 'stream') {
           sessionId = pathParts[4];
      }
    } catch (err) {
      logger.error('Error parsing WebSocket request URL path:', err);
    }

    if (!sessionId) {
      logger.error('Session ID not found in WebSocket connection URL. Closing.');
      ws.close(1008, 'Session ID missing');
      return;
    }
    
    // Prefix log messages in this handler with the session ID
    const logPrefix = `[${sessionId}]`; 
    logger.info(`${logPrefix} Twilio stream attempting connection.`);
    
    // --- PHASE 3: Get Call Info ONLY from Redis --- 
    let callInfo = await sessionManager.getOutboundSession(sessionId);
    // --- Remove global fallback --- 

    if (!callInfo) { // Check Redis result directly
        logger.error(`${logPrefix} No active call found in Redis for this session ID. Closing Twilio connection.`);
        ws.close(1011, 'Session not found in Redis');
        return;
    }

    // *** Enhanced session detection and acquisition logic ***
    const elevenLabsStatus = elevenlabs.getSessionStatus(sessionId);
    
    // If the session is not active in this process, try to check and acquire it
    if (!elevenlabs.isSessionActiveOrOpening(sessionId)) {
        logger.info(`${logPrefix} ElevenLabs session not active in server process. Checking if it exists elsewhere...`);
        
        // Check if the session exists in any process via Redis
        const sessionInfo = await elevenlabs.sessionExistsAnywhere(sessionId);
        
        if (!sessionInfo.exists) {
            logger.error(`${logPrefix} ElevenLabs session (${sessionId}) is inactive and not found in Redis. Cannot connect Twilio stream. Closing.`);
            // Clean up Redis state if call shouldn't be active
       await sessionManager.deleteOutboundSession(sessionId);
       ws.close(1011, 'ElevenLabs session inactive or closed');
       return;
        } 
        
        // Try to acquire ownership of the session if it exists elsewhere
        if (sessionInfo.owner && sessionInfo.owner !== process.pid) {
            logger.info(`${logPrefix} ElevenLabs session owned by process ${sessionInfo.owner}. Attempting to coordinate...`);
            
            // Update Redis to indicate the server is handling this WebSocket
            await sessionManager.saveOutboundSession(sessionId, {
                ...callInfo,
                serverHandling: process.pid,
                serverHandlingTime: Date.now(),
                previousServerPid: callInfo.serverHandling || null,
                workerOwner: sessionInfo.owner
            });
            
            // Notify the user of the coordination attempt
            logger.info(`${logPrefix} Updated Redis to indicate server process ${process.pid} is handling WebSocket for session owned by worker ${sessionInfo.owner}`);
            
            // Wait a moment for the other process to respond if necessary
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // Re-fetch call info after coordination
            callInfo = await sessionManager.getOutboundSession(sessionId);
            if (!callInfo) {
                logger.error(`${logPrefix} Session data lost during coordination. Closing connection.`);
                ws.close(1011, 'Session data lost during coordination');
                return;
            }
        }
    } else if (elevenLabsStatus !== 'OPEN') {
        logger.warn(`${logPrefix} ElevenLabs session (${sessionId}) is not OPEN (Status: ${elevenLabsStatus}). Twilio stream connecting, but issues might occur.`);
    } else {
        logger.info(`${logPrefix} ElevenLabs session (${sessionId}) is OPEN in this process. Direct routing will be used.`);
    }

    logger.info(`${logPrefix} Twilio stream connected. Attaching handlers. Call SID: ${callInfo.callSid}`);

    // Attach session info directly to the WebSocket object for this connection's scope
    ws.sessionId = sessionId;
    ws.callInfo = callInfo; // Initial call info

    // --- Subscribe to Redis Pub/Sub channel for this session ---
    const audioChannel = `${AUDIO_CHANNEL_PREFIX}${sessionId}`;
    logger.info(`${logPrefix} [DEBUG] Using Redis channel for ElevenLabs->Twilio audio: ${audioChannel}`);
    const messageHandler = (message, channel) => {
        if (channel === audioChannel) {
            // Received audio from ElevenLabs via Redis Pub/Sub
            try {
                 const data = JSON.parse(message);
                 logger.info(`${logPrefix} [DEBUG] Received audio from Redis channel ${channel}, data keys: ${Object.keys(data).join(', ')}`);
                 
                 if (data.audioBase64) {
                     logger.info(`${logPrefix} [DEBUG] Audio base64 data length: ${data.audioBase64.length}, format: ${data.format || 'unknown'}, sampleRate: ${data.sampleRate || 'unknown'}`);
                 } else {
                     logger.warn(`${logPrefix} [DEBUG] Received message without audioBase64 data!`);
                 }
                 
                 // Check WebSocket state
                 logger.info(`${logPrefix} [DEBUG] WebSocket readyState: ${ws.readyState} (${ws.readyState === WebSocket.OPEN ? 'OPEN' : 'NOT OPEN'})`);
                 logger.info(`${logPrefix} [DEBUG] StreamSid set? ${ws.callInfo?.streamSid ? 'YES: ' + ws.callInfo.streamSid : 'NO'}`);
                 
                 if (data.audioBase64 && ws.readyState === WebSocket.OPEN && ws.callInfo?.streamSid) {
                      // Format audio payload for Twilio Media API
                      // According to Twilio's bidirectional Media Streams spec the
                      // `media` object must ONLY contain a base64 `payload`. Including
                      // additional unknown keys (e.g. `track`, `contentType`) can cause
                      // Twilio to silently ignore the chunk.  We therefore strip every
                      // field except the required `payload`.
                      const twilioMediaMessage = {
                          event: 'media',
                          streamSid: ws.callInfo.streamSid, // Use potentially updated streamSid
                          media: {
                              payload: data.audioBase64
                          },
                      };
                      
                      // Log detailed info about the audio being sent
                      logger.info(`${logPrefix} [DEBUG] Sending ElevenLabs audio to Twilio, source: ${data.source || 'unknown'}, ` +
                                  `length: ${data.audioBase64.length}, format: ${data.format || 'unknown'}, ` +
                                  `sampleRate: ${data.sampleRate || 'unknown'}, sequence: ${data.sequenceNumber || 'unknown'}`);
                      
                      try {
                          ws.send(JSON.stringify(twilioMediaMessage));
                          logger.info(`${logPrefix} [DEBUG] Successfully sent audio to Twilio WebSocket`);
                      } catch (wsError) {
                          logger.error(`${logPrefix} [DEBUG] Error sending audio to Twilio WebSocket: ${wsError.message}`);
                          logger.error(`${logPrefix} [DEBUG] WebSocket error stack: ${wsError.stack}`);
                      }
                 } else if (!ws.callInfo?.streamSid) {
                     // Buffer audio until streamSid is available
                     if (!serverAudioBuffers.has(sessionId)) {
                         serverAudioBuffers.set(sessionId, []);
                     }
                     const buf = serverAudioBuffers.get(sessionId);
                     
                     // Store the complete data object to preserve metadata
                     buf.push(data);
                     
                     // Limit buffer size to avoid memory bloat
                     if (buf.length > MAX_SERVER_BUFFER_SIZE) {
                         buf.shift();
                     }
                     logger.info(`${logPrefix} [DEBUG] Buffered audio chunk (${data.source || 'unknown'}) because streamSid not yet set. Buffer length: ${buf.length}`);
                 } else if (ws.readyState !== WebSocket.OPEN) {
                      logger.warn(`${logPrefix} [DEBUG] Received audio via Pub/Sub, but WebSocket is not open (state: ${ws.readyState}). Discarding.`);
                      // Add more detail about WebSocket state
                      switch (ws.readyState) {
                          case WebSocket.CONNECTING:
                              logger.warn(`${logPrefix} [DEBUG] WebSocket is still connecting (state: CONNECTING)`);
                              break;
                          case WebSocket.CLOSING:
                              logger.warn(`${logPrefix} [DEBUG] WebSocket is closing (state: CLOSING)`);
                              break;
                          case WebSocket.CLOSED:
                              logger.warn(`${logPrefix} [DEBUG] WebSocket is closed (state: CLOSED)`);
                              break;
                      }
                 } else {
                      logger.warn(`${logPrefix} [DEBUG] Received message from Redis but audioBase64 missing. Message keys: ${Object.keys(data).join(', ')}`);
                 }
            } catch (err) {
                 logger.error(`${logPrefix} [DEBUG] Error processing message from Redis Pub/Sub channel ${channel}:`, err);
                 logger.error(`${logPrefix} [DEBUG] Error stack: ${err.stack}`);
                 logger.error(`${logPrefix} [DEBUG] Raw message: ${message.substring(0, 200)}...`);
            }
        }
    };

    // Subscribe using the dedicated subscriber client
    await subscriberClient.subscribe(audioChannel, messageHandler);
    activeSubscriptions.set(sessionId, messageHandler); // Store handler reference for unsubscribe
    logger.info(`${logPrefix} [DEBUG] Subscribed to Redis channel: ${audioChannel}`);
    // -----------------------------------------------------------

    // Add handler for Twilio WebSocket messages to debug incoming events
    ws.on('message', function(message) {
        try {
            const data = JSON.parse(message);
            logger.info(`${logPrefix} [DEBUG] Received message from Twilio, event: ${data.event || 'unknown'}`);
            
            // If we receive a successful start event, make sure to check for buffered audio
            if (data.event === 'start' && data.start && data.start.streamSid) {
                const streamSid = data.start.streamSid;
                logger.info(`${logPrefix} [DEBUG] Received Twilio start event with streamSid: ${streamSid}`);
                
                // Update streamSid in call info
                if (ws.callInfo) {
                    ws.callInfo.streamSid = streamSid;
                    logger.info(`${logPrefix} [DEBUG] Updated streamSid in call info`);
                    
                    // Run audio diagnostic test
                    logger.info(`${logPrefix} [DEBUG] Running audio diagnostic test`);
                    testAudioPlayback(sessionId, streamSid).catch(error => {
                        logger.error(`${logPrefix} [DEBUG] Error running audio test: ${error.message}`);
                    });
                    
                    // Check if we have buffered audio to send
                    if (serverAudioBuffers.has(sessionId)) {
                        const bufferedChunks = serverAudioBuffers.get(sessionId);
                        logger.info(`${logPrefix} [DEBUG] Found ${bufferedChunks.length} buffered audio chunks to send`);
                        
                        // Send buffered chunks in sequence
                        for (const chunk of bufferedChunks) {
                            // Create proper Twilio media message
                            // Only include payload, omit unsupported keys
                            const twilioMediaMessage = {
                                event: 'media',
                                streamSid: streamSid,
                                media: {
                                    payload: chunk.audioBase64
                                }
                            };
                            
                            try {
                                ws.send(JSON.stringify(twilioMediaMessage));
                                logger.info(`${logPrefix} [DEBUG] Sent buffered audio chunk to Twilio, sequence: ${chunk.sequenceNumber || 'unknown'}`);
                            } catch (wsError) {
                                logger.error(`${logPrefix} [DEBUG] Error sending buffered audio: ${wsError.message}`);
                                break; // Stop on first error
                            }
                        }
                        
                        // Clear buffer after sending
                        serverAudioBuffers.delete(sessionId);
                    } else {
                        logger.info(`${logPrefix} [DEBUG] No buffered audio to send after receiving streamSid`);
                    }
                }
            } else if (data.event === 'media' && data.media) {
                // Handle incoming audio from Twilio (user's voice)
                logger.info(`${logPrefix} [DEBUG] Received audio from Twilio (user's voice), payload length: ${data.media.payload?.length || 0}`);
                
                // Log track information
                if (data.media.track) {
                    logger.info(`${logPrefix} [DEBUG] Audio track: ${data.media.track}`);
                }
                
                // Verify we're receiving audio content
                if (data.media.payload) {
                    // Log first few bytes of the audio data
                    try {
                        const buffer = Buffer.from(data.media.payload, 'base64');
                        const sampleSize = Math.min(buffer.length, 32);
                        const sample = buffer.slice(0, sampleSize);
                        const hex = sample.toString('hex').match(/.{1,2}/g).join(' ');
                        logger.info(`${logPrefix} [DEBUG] Inbound audio sample (first ${sampleSize} bytes): ${hex}`);
                        logger.info(`${logPrefix} [DEBUG] Total audio payload size: ${buffer.length} bytes`);
                    } catch (error) {
                        logger.error(`${logPrefix} [DEBUG] Error examining inbound audio: ${error.message}`);
                    }
                    
                    // Forward audio to ElevenLabs if we have a valid session
                    if (elevenlabs.isSessionActiveOrOpening(sessionId)) {
                        logger.info(`${logPrefix} [DEBUG] Forwarding user audio to ElevenLabs`);
                        
                        // Get detailed session status
                        const sessionStatus = elevenlabs.getSessionStatus(sessionId);
                        logger.info(`${logPrefix} [DEBUG] ElevenLabs session status: ${sessionStatus}`);
                        
                        // Get connection details from active session if available
                        try {
                            const activeSessionInfo = elevenlabs.getSessionDetails(sessionId);
                            if (activeSessionInfo) {
                                logger.info(`${logPrefix} [DEBUG] Session details - Reconnect attempts: ${activeSessionInfo.reconnectAttempts}, Connection time: ${Date.now() - activeSessionInfo.connectionStartTime}ms`);
                            }
                        } catch (error) {
                            logger.error(`${logPrefix} [DEBUG] Error getting session details: ${error.message}`);
                        }
                        
                        try {
                            elevenlabs.sendAudioChunk(sessionId, data.media.payload);
                            logger.info(`${logPrefix} [DEBUG] Successfully forwarded audio chunk to ElevenLabs`);
                        } catch (error) {
                            logger.error(`${logPrefix} [DEBUG] Error forwarding audio chunk to ElevenLabs: ${error.message}`);
                            logger.error(`${logPrefix} [DEBUG] Error stack: ${error.stack}`);
                        }
                    } else {
                        logger.warn(`${logPrefix} [DEBUG] ElevenLabs session not active, cannot forward user audio`);
                        
                        // Try to get session status for more info
                        try {
                            const sessionStatus = elevenlabs.getSessionStatus(sessionId);
                            logger.warn(`${logPrefix} [DEBUG] Current session status: ${sessionStatus}`);
                            
                            // Check if session exists in Redis
                            // Use .then() instead of await since this is not an async function
                            elevenlabs.sessionExistsAnywhere(sessionId)
                                .then(sessionExists => {
                                    if (sessionExists.exists) {
                                        logger.warn(`${logPrefix} [DEBUG] Session exists in Redis, owned by process: ${sessionExists.owner}`);
                                    } else {
                                        logger.warn(`${logPrefix} [DEBUG] Session does not exist in Redis`);
                                    }
                                })
                                .catch(error => {
                                    logger.error(`${logPrefix} [DEBUG] Error checking if session exists in Redis: ${error.message}`);
                                });
                        } catch (error) {
                            logger.error(`${logPrefix} [DEBUG] Error getting session status: ${error.message}`);
                        }
                    }
                } else {
                    logger.warn(`${logPrefix} [DEBUG] Received media message without payload`);
                }
            }
        } catch (error) {
            logger.error(`${logPrefix} [DEBUG] Error processing Twilio WebSocket message:`, error);
        }
    });
    
    // Add error and close handlers for better debugging
    ws.on('error', function(error) {
        logger.error(`${logPrefix} [DEBUG] Twilio WebSocket error:`, error);
    });
    
    ws.on('close', function(code, reason) {
        logger.info(`${logPrefix} [DEBUG] Twilio WebSocket closed. Code: ${code}, Reason: ${reason || 'No reason provided'}`);
        // Clean up subscriptions
        if (activeSubscriptions.has(sessionId)) {
            logger.info(`${logPrefix} [DEBUG] Cleaning up Redis subscription for closed WebSocket`);
            const handler = activeSubscriptions.get(sessionId);
            subscriberClient.unsubscribe(audioChannel, handler);
            activeSubscriptions.delete(sessionId);
        }
    });
  });

  return wss;
}

// --- MODIFIED /start route --- 
// Use the startCallLimiter variable which will be updated later
router.post('/start', (req, res, next) => startCallLimiter(req, res, next), async (req, res) => {
    const { to, from, n8nWorkflowUrl } = req.body;

  if (!to || !from) {
        logger.warn('Missing required parameters for /start endpoint.');
    return res.status(400).json({ error: 'Missing required parameters: to, from' });
  }

    try {
        const jobId = uuidv4(); // Generate a unique ID for the job
        const jobData = { 
            to,
            from,
            n8nWorkflowUrl: n8nWorkflowUrl || null,
            jobId // Pass jobId to worker for logging/tracking
         };

        // Add job to the queue
        await outboundCallQueue.add('initiate-call', jobData, {
            jobId: jobId // Use custom jobId for potential tracking
    });

        logger.info(`[API][Job ${jobId}] Added call initiation job to queue for ${to} from ${from}`);

        // Respond immediately to the client
        res.status(202).json({ 
            message: 'Call initiation request accepted and queued.', 
            jobId: jobId // Return jobId so client can potentially track status
    });

  } catch (error) {
        logger.error(`[API] Error adding call initiation job to queue for ${to}:`, error);
        res.status(500).json({ error: 'Failed to queue call initiation request.', details: error.message });
  }
});
// --- End of MODIFIED /start route ---

// Status Callback Endpoint (Receives updates from Twilio about the call)
// Consider adding rate limiting here too if needed
router.post('/status/:sessionId', async (req, res) => {
  const sessionId = req.params.sessionId;
    const { CallSid, CallStatus, CallDuration, ErrorCode, ErrorMessage } = req.body;
    const logPrefix = `[${sessionId}/${CallSid}]`;

    logger.info(`${logPrefix} Received Twilio Status Callback: ${CallStatus}`);

    try {
        // --- PHASE 3: Update Redis ONLY ---
  let callInfo = await sessionManager.getOutboundSession(sessionId);

  if (!callInfo) {
            logger.error(`${logPrefix} Cannot find session data in Redis for status update. Ignoring.`);
            // Respond 200 to Twilio anyway to acknowledge receipt
            return res.sendStatus(200);
        }

        // Update status and potentially other fields
        callInfo.status = CallStatus;
        callInfo.duration = CallDuration;
        if (ErrorCode) callInfo.errorCode = ErrorCode;
        if (ErrorMessage) callInfo.errorMessage = ErrorMessage;

        // Decide on TTL based on status - maybe keep completed/failed calls longer?
        let ttl = 3600; // Default 1 hour
        if (['completed', 'failed', 'canceled', 'busy', 'no-answer'].includes(CallStatus)) {
            ttl = 24 * 3600; // Keep final states for 24 hours in Redis
            // End ElevenLabs session if the call ends definitively
             logger.info(`${logPrefix} Call ended (${CallStatus}). Ensuring ElevenLabs session is terminated.`);
             await elevenlabs.endConversation(sessionId);
        }

        await sessionManager.saveOutboundSession(sessionId, callInfo, ttl);
   // --- Remove global update ---

        // --- Phase 3: Update DB using callSid (No change needed here) ---
  const callRecord = await dbService.getCallByExternalId(CallSid);
  if (callRecord) {
      const updateData = { 
          status: CallStatus, 
                duration: CallDuration ? parseInt(CallDuration, 10) : null,
            };
            // Set end time only for final states
            if (['completed', 'failed', 'canceled', 'busy', 'no-answer'].includes(CallStatus)) {
                updateData.end_time = new Date();
                if (ErrorCode) updateData.failure_reason = `Twilio Error ${ErrorCode}: ${ErrorMessage || 'Unknown'}`;
      }
      await dbService.updateCall(callRecord.id, updateData);
             logger.info(`${logPrefix} Updated DB record status to ${CallStatus}.`);
  } else {
            logger.warn(`${logPrefix} Could not find DB record for CallSid ${CallSid} during status update.`);
            // Consider creating a record here if it should always exist
  }
        // --- End Phase 3 ---

        res.sendStatus(200); // Acknowledge receipt to Twilio
    
      } catch (error) {
         logger.error(`${logPrefix} Error processing Twilio status callback:`, error);
         res.status(500).send('Error processing status update');
     }
});

router.post('/start-call', rateLimit({ windowMs: 60000, max: 10 }), async (req, res) => {
    try {
        // ... existing code ...
        
        // Log the call attempt
        logger.info(`[${sessionId}] Initiating outbound call to ${phoneNumber}`);
        
        // Add audio diagnostic test when call is first answered
        logger.info(`[${sessionId}] [DEBUG] Will run audio diagnostic test when call is answered`);
        
        // ... rest of function ...
    } catch (error) {
        // ... existing error handling ...
    }
});

// Add a diagnostic test for audio playback
// This function creates a test tone and sends it to Twilio when a call is first connected
async function testAudioPlayback(sessionId, streamSid) {
    const logPrefix = `[${sessionId}]`;
    logger.info(`${logPrefix} [DEBUG] Running audio diagnostic test with test tone`);
    
    try {
        // Generate a simple test tone (mu-law encoded)
        // This is a 1kHz sine wave encoded as mu-law
        const testToneLength = 1600; // 200ms of audio at 8kHz
        const buffer = Buffer.alloc(testToneLength);
        
        // Fill buffer with a pattern that's recognizable 
        // (alternating values that will produce a distinct sound)
        for (let i = 0; i < testToneLength; i++) {
            // Simple pattern that will create an audible tone when played
            buffer[i] = i % 2 === 0 ? 0x55 : 0xAA;
        }
        
        // Convert to base64
        const audioBase64 = buffer.toString('base64');
        
        // Send test tone directly to Twilio
        const twilioMediaMessage = {
            event: 'media',
            streamSid: streamSid,
            media: {
                payload: audioBase64
            }
        };
        
        // Find the WebSocket connection
        let wsFound = false;
        if (wssInstance && wssInstance.clients) {
            // Explicitly convert clients Set to Array for iteration
            const clientsArray = Array.from(wssInstance.clients);
            logger.info(`${logPrefix} [DEBUG] Checking ${clientsArray.length} active WebSocket connections for session ${sessionId}`);
            
            for (const ws of clientsArray) {
                if (ws.sessionId === sessionId && ws.readyState === WebSocket.OPEN) {
                    logger.info(`${logPrefix} [DEBUG] Found active WebSocket for session, sending test tone`);
                    ws.send(JSON.stringify(twilioMediaMessage));
                    wsFound = true;
                    
                    // Also log in the message handler that audio is being sent
                    logger.info(`${logPrefix} [DEBUG] TEST TONE SENT: If you don't hear a brief tone, there may be an audio playback issue`);
                    break;
                }
            }
        } else {
            logger.warn(`${logPrefix} [DEBUG] WebSocket server not accessible (wssInstance: ${Boolean(wssInstance)}, clients: ${Boolean(wssInstance?.clients)})`);
        }
        
        if (!wsFound) {
            logger.warn(`${logPrefix} [DEBUG] No active WebSocket found for session, cannot send test tone`);
            
            // Try to publish test tone to Redis as fallback
            const { publishRedisMessage } = require('../utils/redisClient');
            // Using AUDIO_CHANNEL_PREFIX ('elevenlabs-to-twilio:') for consistent channel naming
            const channel = `${AUDIO_CHANNEL_PREFIX}${sessionId}`;
            logger.info(`${logPrefix} [DEBUG] Using Redis channel for test tone: ${channel}`);
            
            const payload = JSON.stringify({
                audioBase64,
                source: 'test-tone',
                timestamp: Date.now(),
                processId: process.pid,
                // Remove track and contentType which don't get used by Twilio
                format: 'ulaw',
                sampleRate: 8000,
                sequenceNumber: 0
            });
            
            try {
                await publishRedisMessage(channel, payload);
                logger.info(`${logPrefix} [DEBUG] Published test tone to Redis channel ${channel}`);
            } catch (error) {
                logger.error(`${logPrefix} [DEBUG] Failed to publish test tone to Redis: ${error.message}`);
            }
        }
    } catch (error) {
        logger.error(`${logPrefix} [DEBUG] Error in audio diagnostic test: ${error.message}`);
        logger.error(`${logPrefix} [DEBUG] Error stack: ${error.stack}`);
    }
}

module.exports = { router, setupWebSocketServer, initializeRateLimiters() { return (req, res, next) => next(); } };
