const axios = require('axios');
const WebSocket = require('ws');
const logger = require('./logger');
const EventEmitter = require('events');
const { sessionManager, publishRedisMessage } = require('./redisClient');

/**
 * Converts MP3 audio buffer to μ-law 8kHz format for Twilio compatibility
 * @param {Buffer} mp3Buffer - The MP3 audio buffer to convert
 * @returns {Promise<Buffer>} - The converted μ-law audio buffer
 */
async function convertMp3ToUlaw(mp3Buffer) {
  const ffmpeg = require('fluent-ffmpeg');
  const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
  const { promises: fs } = require('fs');
  const { v4: uuidv4 } = require('uuid');
  const path = require('path');
  const os = require('os');
  
  // Set ffmpeg path
  ffmpeg.setFfmpegPath(ffmpegPath);
  
  // Create temp files
  const tempDir = os.tmpdir();
  const tempId = uuidv4();
  const inputFile = path.join(tempDir, `input-${tempId}.mp3`);
  const outputFile = path.join(tempDir, `output-${tempId}.ulaw`);
  
  try {
    // Write MP3 buffer to temp file
    await fs.writeFile(inputFile, mp3Buffer);
    
    // Convert using ffmpeg
    return new Promise((resolve, reject) => {
      ffmpeg(inputFile)
        .outputOptions([
          '-f mulaw',    // μ-law format
          '-ar 8000',    // 8kHz sample rate
          '-ac 1'        // Mono (1 channel)
        ])
        .output(outputFile)
        .on('end', async () => {
          try {
            // Read the converted file
            const ulawBuffer = await fs.readFile(outputFile);
            
            // Clean up temp files
            await fs.unlink(inputFile).catch(() => {});
            await fs.unlink(outputFile).catch(() => {});
            
            resolve(ulawBuffer);
          } catch (err) {
            reject(err);
          }
        })
        .on('error', (err) => {
          reject(err);
        })
        .run();
    });
  } catch (err) {
    // Clean up temp files in case of error
    await fs.unlink(inputFile).catch(() => {});
    await fs.unlink(outputFile).catch(() => {});
    throw err;
  }
}

// Constants for reconnection and heartbeat
const RECONNECT_BASE_DELAY_MS = 1000; // 1 second
const RECONNECT_MAX_DELAY_MS = 30000; // 30 seconds
const RECONNECT_FACTOR = 2;
const RECONNECT_MAX_ATTEMPTS = 10; // Or null for infinite
const HEARTBEAT_INTERVAL_MS = 15000; // 15 seconds
const PONG_TIMEOUT_MS = 5000; // 5 seconds

// Store active WebSocket connections and associated data
// Map structure: sessionId -> { ws, agentId, status, callbacks, reconnectTimer, heartbeatTimer, pongTimeoutTimer, reconnectAttempts }
const activeSessions = new Map();

/**
 * ElevenLabs API client using WebSockets for Conversational AI.
 * Emits events: 'open', 'message', 'error', 'close', 'reconnecting', 'reconnected', 'permanently_closed'
 */
class ElevenLabsWebSocketClient extends EventEmitter {
  constructor() {
    super(); // Call EventEmitter constructor
    this.apiKey = process.env.ELEVENLABS_API_KEY;
    this.agentId = process.env.ELEVENLABS_AGENT_ID;
    // Note: Voice ID might be configured within the agent settings
    
    // Add default error handler to prevent process crashes on unhandled errors
    this.on('error', (sessionId, error) => {
      logger.error(`Default error handler: Unhandled error for session ${sessionId}:`, error);
      // This prevents Node.js from crashing due to unhandled 'error' events
    });
  }

  /**
   * Start a WebSocket conversation session. Returns sessionId immediately.
   * Listen for events ('open', 'message', 'error', 'close', etc.) on the client instance.
   * @param {string} [agentId] - Agent ID (defaults to environment variable)
   * @param {Function} onMessageCallback - Function to call when a message (transcript, agent response) is received
   * @param {Function} [onErrorCallback] - Optional: Function to call on non-fatal WebSocket error
   * @param {Function} [onCloseCallback] - Optional: Function to call when WebSocket closes definitively
   * @param {Function} [onReconnectingCallback] - Optional: Function to call when attempting to reconnect
   * @param {string} [customSessionId] - Optional: Use a specific session ID instead of generating one
   * @returns {string} - The unique session ID
   */
  async startConversation(
    agentId = this.agentId,
    onMessageCallback,
    onErrorCallback, // Keep callbacks for potential specific logging/handling
    onCloseCallback,
    onReconnectingCallback,
    customSessionId = null
  ) {
    const wsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${agentId}`;
    // Use provided customSessionId if available, otherwise generate one
    const sessionId = customSessionId || `session_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    logger.info(`[${sessionId}] Attempting to start WebSocket connection for agent ${agentId}`);
    logger.info(`[${sessionId}] Using WebSocket URL: ${wsUrl}`);
    logger.info(`[${sessionId}] Using API Key (masked): ${this.apiKey ? this.apiKey.substring(0, 5) + '...' + this.apiKey.substring(this.apiKey.length - 5) : 'undefined'}`);

    const sessionData = {
      ws: null,
      agentId: agentId,
      status: 'CONNECTING',
      callbacks: { // Store callbacks
        onMessage: onMessageCallback,
        onError: onErrorCallback,
        onClose: onCloseCallback,
        onReconnecting: onReconnectingCallback,
      },
      reconnectTimer: null,
      heartbeatTimer: null,
      pongTimeoutTimer: null,
      reconnectAttempts: 0,
      wsUrl: wsUrl, // Store URL for reconnections
      processId: process.pid, // Store the process ID that created this session
      connectionStartTime: Date.now() // Add timestamp for connection tracking
    };
    activeSessions.set(sessionId, sessionData);

    // Attempt to acquire session ownership in Redis
    try {
      const { sessionManager } = require('./redisClient');
      const acquired = await sessionManager.acquireSessionOwnership(sessionId, process.pid);
      if (!acquired) {
        logger.warn(`[${sessionId}] Failed to acquire session ownership in Redis, but continuing with connection attempt.`);
      } else {
        logger.debug(`[${sessionId}] Successfully acquired session ownership in Redis.`);
      }
    } catch (error) {
      logger.error(`[${sessionId}] Error acquiring session ownership:`, error);
      // Continue anyway, this is non-fatal
    }

    this._connect(sessionId); // Initiate the first connection attempt

    return sessionId; // Return session ID immediately
  }

  _connect(sessionId) {
    const session = activeSessions.get(sessionId);
    if (!session || session.status === 'CLOSING' || session.status === 'CLOSED') {
      logger.warn(`[${sessionId}] Connection attempt aborted, session is closing or closed.`);
      return;
    }

    logger.info(`[${sessionId}] Connecting... (Attempt ${session.reconnectAttempts + 1})`);
    logger.info(`[${sessionId}] Connection elapsed time: ${Date.now() - session.connectionStartTime}ms`);
    session.status = 'CONNECTING';
    // Clear any previous timers just in case
    this._clearTimers(sessionId);

    try {
      const ws = new WebSocket(session.wsUrl, {
        headers: {
          'xi-api-key': this.apiKey,
        },
      });

      session.ws = ws; // Store the WebSocket instance

      ws.on('open', () => {
        logger.info(`[${sessionId}] WebSocket connection opened. Connection time: ${Date.now() - session.connectionStartTime}ms`);
        session.status = 'OPEN';
        session.reconnectAttempts = 0; // Reset attempts on successful connection
        this._clearReconnectTimer(sessionId); // Clear any pending reconnect timer

        // Send conversation_initiation with EXPLICIT audio format compatible with Twilio
        const initMessage = {
          type: 'conversation_initiation',
          conversation_initiation_event: {
            audio_format: "ulaw",    // Changed from "mulaw" to "ulaw" for consistency
            sample_rate_hz: 8000,     // Explicitly request 8kHz to match Twilio
            encoding: "audio/x-mulaw" // Use standard MIME type
          }
        };
        ws.send(JSON.stringify(initMessage));
        logger.info(`[${sessionId}] Sent conversation_initiation with explicit audio_format=ulaw, sample_rate_hz=8000, and encoding=audio/x-mulaw`);

        this._startHeartbeat(sessionId); // Start heartbeat mechanism

        // Update Redis ownership with new TTL
        this._refreshOwnership(sessionId);

        // Emit 'open' or 'reconnected' event
        const eventName = session.reconnectAttempts === 0 ? 'open' : 'reconnected';
        this.emit(eventName, sessionId);
      });

      ws.on('message', (data) => {
        // Any message indicates the connection is alive
        this._resetHeartbeatTimers(sessionId);

        try {
          const message = JSON.parse(data.toString());
          // logger.debug(`[${sessionId}] Received message:`, message);

          if (message.type === 'ping') {
            this.sendMessage(sessionId, {
              type: 'pong',
              event_id: message.ping_event.event_id,
            });
          } else if (message.type === 'pong') {
            // Pong received, clear the timeout timer
            this._clearPongTimeoutTimer(sessionId);
          } else if (session.callbacks.onMessage) {
            // Pass other messages to the provided callback
            session.callbacks.onMessage(sessionId, message);
            this.emit('message', sessionId, message); // Also emit generically
          }
        } catch (e) {
          logger.error(`[${sessionId}] Error parsing message:`, e);
          logger.error('[${sessionId}] Raw message data:', data.toString());
        }
      });

      ws.on('error', (error) => {
        logger.error(`[${sessionId}] WebSocket error:`, error.message);
        logger.error(`[${sessionId}] WebSocket error stack:`, error.stack);
        logger.error(`[${sessionId}] Agent ID: ${session.agentId}, API Key valid: ${Boolean(this.apiKey)}`);
        session.status = 'ERROR'; // Intermediate state before reconnecting/closed
        if (session.callbacks.onError) {
          session.callbacks.onError(sessionId, error);
        }
        this.emit('error', sessionId, error); // Emit error

        // Treat error as a trigger for reconnection
        this._handleDisconnect(sessionId, false); // false indicates not a clean close
      });

      ws.on('close', (code, reason) => {
        logger.info(`[${sessionId}] WebSocket connection closed. Code: ${code}, Reason: ${reason?.toString()}`);
        logger.info(`[${sessionId}] WebSocket connection duration: ${Date.now() - session.connectionStartTime}ms`);
        session.status = 'CLOSED_TEMP'; // Intermediate state

        // Determine if closure was expected/clean
        const isCleanClose = (code === 1000 || code === 1005); // 1000 = Normal, 1005 = No Status Received (often expected)

        this._handleDisconnect(sessionId, isCleanClose);
      });
    } catch (error) {
      logger.error(`[${sessionId}] Error creating WebSocket:`, error.message);
      logger.error(`[${sessionId}] Error stack:`, error.stack);
      session.status = 'ERROR';
      
      // Try reconnection
      this._handleDisconnect(sessionId, false);
    }
  }

  _handleDisconnect(sessionId, isCleanClose) {
      const session = activeSessions.get(sessionId);
      if (!session || session.status === 'CLOSING' || session.status === 'CLOSED') {
          logger.debug(`[${sessionId}] Disconnect handling skipped, session already closing/closed.`);
          return;
      }

      this._stopHeartbeat(sessionId); // Stop heartbeats

      if (isCleanClose || session.status === 'CLOSING') {
          logger.info(`[${sessionId}] Clean close or explicit termination. Not reconnecting.`);
          session.status = 'CLOSED';
          this.emit('close', sessionId, 1000, "Clean closure"); // Emit standard close
          if (session.callbacks.onClose) {
              session.callbacks.onClose(sessionId, 1000, "Clean closure");
          }
          this._cleanupSession(sessionId);
      } else {
          // Unexpected close or error, attempt reconnection
          this._scheduleReconnect(sessionId);
      }
  }


  _scheduleReconnect(sessionId) {
    const session = activeSessions.get(sessionId);
    if (!session || session.status === 'CLOSING' || session.status === 'CLOSED') {
      logger.warn(`[${sessionId}] Reconnect scheduling aborted, session is closing or closed.`);
      return;
    }

    if (RECONNECT_MAX_ATTEMPTS !== null && session.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      logger.error(`[${sessionId}] Max reconnection attempts (${RECONNECT_MAX_ATTEMPTS}) reached. Connection permanently closed.`);
      session.status = 'CLOSED';
      this.emit('permanently_closed', sessionId, 'Max reconnection attempts reached');
       if (session.callbacks.onClose) { // Notify via close callback as well
            session.callbacks.onClose(sessionId, 1011, 'Max reconnection attempts reached'); // 1011 = Internal Error
       }
      this._cleanupSession(sessionId);
      return;
    }

    session.reconnectAttempts++;
    session.status = 'RECONNECTING';

    // Calculate delay with exponential backoff and jitter
    const baseDelay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * Math.pow(RECONNECT_FACTOR, session.reconnectAttempts - 1));
    const jitter = baseDelay * 0.2 * Math.random(); // Add +/- 10% jitter
    const delay = Math.round(baseDelay + jitter);

    logger.info(`[${sessionId}] Scheduling reconnection attempt ${session.reconnectAttempts} in ${delay}ms...`);

    this.emit('reconnecting', sessionId, session.reconnectAttempts, delay);
    if (session.callbacks.onReconnecting) {
        session.callbacks.onReconnecting(sessionId, session.reconnectAttempts, delay);
    }

    this._clearReconnectTimer(sessionId); // Clear previous timer if any
    session.reconnectTimer = setTimeout(() => {
      if (session.status === 'RECONNECTING') { // Ensure status hasn't changed
          this._connect(sessionId);
      } else {
           logger.warn(`[${sessionId}] Reconnect timer fired, but status is now ${session.status}. Aborting reconnect.`);
      }
    }, delay);
  }

  _startHeartbeat(sessionId) {
    const session = activeSessions.get(sessionId);
    if (!session || session.status !== 'OPEN') return;

    logger.debug(`[${sessionId}] Starting heartbeat mechanism.`);
    this._clearTimers(sessionId); // Clear previous timers

    session.heartbeatTimer = setInterval(() => {
      if (session.ws && session.ws.readyState === WebSocket.OPEN) {
        logger.debug(`[${sessionId}] Sending ping.`);
        session.ws.ping(() => {}); // Send WebSocket standard ping

        // Refresh session ownership in Redis at each heartbeat
        this._refreshOwnership(sessionId);
        
        // Check for termination requests from other processes
        this._checkForTerminationRequests(sessionId);
        
        // Check for audio from server process
        this._checkForTwilioAudio(sessionId);

        // Set a timeout waiting for the pong (or any message)
        this._clearPongTimeoutTimer(sessionId); // Clear previous pong timeout
        session.pongTimeoutTimer = setTimeout(() => {
          logger.warn(`[${sessionId}] Pong timeout! Connection assumed dead. Terminating.`);
          if (session.ws) {
            session.ws.terminate(); // Force close the connection
          }
          // The 'close' event handler will trigger reconnection logic
        }, PONG_TIMEOUT_MS);
      } else {
        logger.warn(`[${sessionId}] Heartbeat interval: WebSocket not open. Skipping ping.`);
         // If WS is not open during a heartbeat interval, something is wrong. Trigger reconnect.
         // This handles cases where the state somehow didn't update correctly.
         this._handleDisconnect(sessionId, false);
      }
    }, HEARTBEAT_INTERVAL_MS);
    
    // Set up Redis subscription for audio from server process
    this._setupTwilioAudioSubscription(sessionId);
  }

  _stopHeartbeat(sessionId) {
    logger.debug(`[${sessionId}] Stopping heartbeat mechanism.`);
    this._clearTimers(sessionId);
  }

  _resetHeartbeatTimers(sessionId) {
    const session = activeSessions.get(sessionId);
    if (session && session.status === 'OPEN') {
        // logger.debug(`[${sessionId}] Resetting heartbeat timers due to received message.`);
        this._clearPongTimeoutTimer(sessionId); // Clear pong timeout as connection is alive
        // We could also clear and restart the main heartbeat interval timer here,
        // effectively making it an inactivity timer. For now, keep the fixed interval ping.
        // clearInterval(session.heartbeatTimer);
        // this._startHeartbeat(sessionId); // If restarting the interval
    }
  }

  _clearPongTimeoutTimer(sessionId) {
    const session = activeSessions.get(sessionId);
    if (session && session.pongTimeoutTimer) {
      clearTimeout(session.pongTimeoutTimer);
      session.pongTimeoutTimer = null;
    }
  }

  _clearReconnectTimer(sessionId) {
      const session = activeSessions.get(sessionId);
      if (session && session.reconnectTimer) {
          clearTimeout(session.reconnectTimer);
          session.reconnectTimer = null;
      }
  }

  _clearHeartbeatIntervalTimer(sessionId) {
       const session = activeSessions.get(sessionId);
       if (session && session.heartbeatTimer) {
           clearInterval(session.heartbeatTimer);
           session.heartbeatTimer = null;
       }
  }

  _clearTimers(sessionId) {
       this._clearHeartbeatIntervalTimer(sessionId);
       this._clearPongTimeoutTimer(sessionId);
       // Keep reconnect timer separate as it controls the reconnect loop itself
  }

  // New method to refresh Redis session ownership
  async _refreshOwnership(sessionId) {
    try {
      const { sessionManager } = require('./redisClient');
      const session = activeSessions.get(sessionId);
      
      if (session) {
        // Try to update ownership TTL in Redis
        await sessionManager.updateSessionOwnership(sessionId, process.pid);
      }
    } catch (error) {
      logger.error(`[${sessionId}] Error refreshing session ownership in Redis:`, error);
      // Continue anyway, this is non-fatal for the websocket
    }
  }

  /**
   * Send a message through the WebSocket connection
   * @param {string} sessionId - The session ID
   * @param {object} message - The message to send
   * @returns {boolean} - Whether the message was sent successfully
   */
  sendMessage(sessionId, message) {
    const session = activeSessions.get(sessionId);
    if (!session || session.status !== 'OPEN' || !session.ws || session.ws.readyState !== WebSocket.OPEN) {
      logger.warn(`[${sessionId}] [DEBUG] Cannot send message - session not open. Status: ${session?.status || 'NOT_FOUND'}, WebSocket state: ${session?.ws?.readyState || 'NO_WEBSOCKET'}`);
      return false;
    }

    try {
      const messageData = typeof message === 'string' ? message : JSON.stringify(message);
      // Log message type and details for debugging
      const messageType = message.type || (typeof message === 'object' ? 'unknown_type' : 'string_message');
      logger.info(`[${sessionId}] [DEBUG] Sending message to ElevenLabs WebSocket. Type: ${messageType}, keys: ${typeof message === 'object' ? Object.keys(message).join(', ') : 'N/A'}`);
      
      // For audio messages, log size information
      if (messageType === 'audio' && message.audio_event?.data) {
        logger.info(`[${sessionId}] [DEBUG] Sending audio data of length: ${message.audio_event.data.length} bytes`);
      } else if (messageType === 'user_speech') {
        logger.info(`[${sessionId}] [DEBUG] Sending user speech event, audio length: ${message.user_speech_event?.data?.length || 'no data'} bytes`);
      }
      
      session.ws.send(messageData);
      
      // Confirm message was sent
      logger.debug(`[${sessionId}] Message sent to ElevenLabs successfully`);
      return true;
    } catch (error) {
      logger.error(`[${sessionId}] [DEBUG] Error sending message to ElevenLabs:`, error);
      logger.error(`[${sessionId}] [DEBUG] Error stack: ${error.stack}`);
      return false;
    }
  }
  
  /**
   * Send user audio chunk over WebSocket
   * @param {string} sessionId - The ID of the session
   * @param {string} audioBase64 - Base64 encoded audio chunk
   */
  sendAudioChunk(sessionId, audioBase64) {
      this.sendMessage(sessionId, {
          user_audio_chunk: audioBase64
      });
  }
  
  /**
   * Send user text input over WebSocket (if needed/supported)
   * Note: Primary input is usually audio chunks
   * @param {string} sessionId - The ID of the session
   * @param {string} text - Text input
   */
  sendTextInput(sessionId, text) {
      this.sendMessage(sessionId, {
          type: 'user_text_input', // Type might vary based on API spec
          text: text
      });
  }

  /**
   * End a specific conversation session
   * @param {string} sessionId - The ID of the session to end
   */
  async endConversation(sessionId) {
    const session = activeSessions.get(sessionId);
    
    // First check if this session exists in Redis but is owned by another process
    if (!session) {
      try {
        const sessionInfo = await this.sessionExistsAnywhere(sessionId);
        
        if (sessionInfo.exists) {
          logger.info(`[${sessionId}] Session doesn't exist locally but exists in Redis. Attempting to signal termination.`);
          
          // Get the current Redis data
          const { sessionManager } = require('./redisClient');
          const sessionData = await sessionManager.getOutboundSession(sessionId);
          
          if (sessionData) {
            // Update Redis with termination flag that other process can detect
            await sessionManager.saveOutboundSession(sessionId, {
              ...sessionData,
              status: 'terminating',
              terminateRequested: true,
              terminateRequestedBy: process.pid,
              terminateRequestTime: Date.now()
            });
            
            logger.info(`[${sessionId}] Signaled termination request through Redis for process ${sessionInfo.owner || 'unknown'}`);
            return;
          }
        } else {
          logger.warn(`Attempted to end non-existent session: ${sessionId}`);
          return;
        }
      } catch (error) {
        logger.error(`[${sessionId}] Error checking session existence for termination:`, error);
      }
    }
    
    if (session) {
       logger.info(`[${sessionId}] Explicitly closing conversation.`);
       session.status = 'CLOSING'; // Mark as intentionally closing
       this._stopHeartbeat(sessionId);
       this._clearReconnectTimer(sessionId); // Prevent reconnection attempts

       // Release Redis ownership
       try {
         const { sessionManager } = require('./redisClient');
         await sessionManager.releaseSessionOwnership(sessionId, process.pid);
         logger.debug(`[${sessionId}] Released ownership in Redis.`);
       } catch (error) {
         logger.error(`[${sessionId}] Error releasing ownership in Redis:`, error);
       }

       if (session.ws) {
           if (session.ws.readyState === WebSocket.OPEN || session.ws.readyState === WebSocket.CONNECTING) {
               // Send a specific close message if the API requires one? Check API docs.
               // this.sendMessage(sessionId, { type: 'terminate_session' });
               session.ws.close(1000, 'Conversation ended by client');
           } else {
               logger.warn(`[${sessionId}] WebSocket already closing or closed when endConversation called.`);
               // Ensure cleanup still happens if WS is in a weird state
                this._handleDisconnect(sessionId, true); // Treat as clean close for cleanup
           }
       } else {
            logger.warn(`[${sessionId}] No WebSocket instance found during endConversation. Cleaning up.`);
            // Ensure cleanup if WS never connected or was already gone
            this._handleDisconnect(sessionId, true); // Treat as clean close for cleanup
       }
    } else {
        logger.warn(`Attempted to end non-existent session: ${sessionId}`);
    }
    // Note: _handleDisconnect (called by 'close' event or directly above) now handles _cleanupSession
  }

  /**
   * Clean up session data from the map
   * @param {string} sessionId - The ID of the session to clean up
   */
  _cleanupSession(sessionId) {
    const session = activeSessions.get(sessionId);
    if (session) {
      this._clearTimers(sessionId);
      this._clearReconnectTimer(sessionId);
      // Ensure WS listeners are removed if WS object exists (prevent memory leaks)
      if(session.ws) {
          session.ws.removeAllListeners();
      }
      activeSessions.delete(sessionId);
      logger.info(`[${sessionId}] Cleaned up session data.`);
    }
  }
  
  /**
   * Check if a session is active
   * @param {string} sessionId - The session ID to check
   * @returns {boolean} - True if session exists and status is OPEN
   */
  isSessionActive(sessionId) {
    const session = activeSessions.get(sessionId);
    return session && session.status === 'OPEN';
  }

  /**
   * Check if a session is active, connecting, or reconnecting
   * @param {string} sessionId - The session ID to check
   * @returns {boolean} - True if session exists and status is OPEN, CONNECTING, or RECONNECTING
   */
  isSessionActiveOrOpening(sessionId) {
    const session = activeSessions.get(sessionId);
    return session && ['OPEN', 'CONNECTING', 'RECONNECTING'].includes(session.status);
  }

  /**
   * Check if a session is active or reconnecting (but not initial connecting)
   * @param {string} sessionId - The session ID to check
   * @returns {boolean} - True if session exists and status is OPEN or RECONNECTING
   */
  isSessionActiveOrReconnecting(sessionId) {
    const session = activeSessions.get(sessionId);
    return session && ['OPEN', 'RECONNECTING'].includes(session.status);
  }

  /**
  * Get the current status of a session
   * @param {string} sessionId - The session ID
   * @returns {string|null} - The session status or null if not found
  */
  getSessionStatus(sessionId) {
    const session = activeSessions.get(sessionId);
    if (!session) {
      return 'NOT_FOUND';
    }
    return session.status;
  }

  /**
   * Get detailed information about a session
   * @param {string} sessionId - The session ID 
   * @returns {object|null} - Session details or null if session not found
   */
  getSessionDetails(sessionId) {
    const session = activeSessions.get(sessionId);
    if (!session) {
      return null;
    }
    
    // Return a safe copy with only the fields we want to expose
    return {
      status: session.status,
      agentId: session.agentId,
      reconnectAttempts: session.reconnectAttempts || 0,
      connectionStartTime: session.connectionStartTime || Date.now(),
      processId: session.processId
    };
  }
  
  /**
   * Check if a session exists in any process via Redis
   * @param {string} sessionId - The session ID 
   * @returns {Promise<object>} - Object with exists and owner properties
   */
  async sessionExistsAnywhere(sessionId) {
    // Check local memory first
    const inMemory = activeSessions.has(sessionId);
    let owner = null;
    let status = null;
    
    if (inMemory) {
      const session = activeSessions.get(sessionId);
      status = session.status;
      owner = session.processId || process.pid;
      
      return { exists: true, owner, status, inMemory };
    }
    
    // Session not in memory, check Redis
    try {
      const { sessionManager } = require('./redisClient');
      
      // Check for session data
      const redisData = await sessionManager.getOutboundSession(sessionId);
      
      // Check for session ownership
      owner = await sessionManager.getSessionOwner(sessionId);
      
      if (redisData) {
        status = redisData.status || 'unknown';
        return { exists: true, owner, status, inMemory: false };
      }
      
      // Neither in memory nor in Redis
      return { exists: false, owner: null, status: null, inMemory: false };
    } catch (error) {
      logger.error(`[${sessionId}] Error checking session existence in Redis:`, error);
      // Default to reporting only what we know for sure - it's in memory or not
      return { exists: inMemory, owner, status, inMemory };
    }
  }

  /**
   * Attempt to take ownership of a session that might be in another process
   * @param {string} sessionId - The session ID to take ownership of
   * @returns {Promise<boolean>} - True if ownership was acquired or already held
   */
  async acquireSessionIfExists(sessionId) {
    try {
      // Check if the session exists anywhere
      const sessionInfo = await this.sessionExistsAnywhere(sessionId);
      
      if (!sessionInfo.exists) {
        logger.warn(`[${sessionId}] Cannot acquire non-existent session`);
        return false;
      }
      
      // If it's in our memory, we already have it
      if (sessionInfo.inMemory) {
        logger.debug(`[${sessionId}] Session already in local memory, no need to acquire`);
        return true;
      }
      
      // Attempt to acquire ownership in Redis
      const { sessionManager } = require('./redisClient');
      const acquired = await sessionManager.acquireSessionOwnership(sessionId, process.pid);
      
      if (acquired) {
        logger.info(`[${sessionId}] Successfully acquired ownership of remote session`);
        // Note: we don't have the actual WebSocket connection, just the metadata
        // The actual connection exists in another process
        return true;
      } else {
        logger.warn(`[${sessionId}] Failed to acquire ownership of remote session (owner: ${sessionInfo.owner})`);
        return false;
      }
    } catch (error) {
      logger.error(`[${sessionId}] Error acquiring session ownership:`, error);
      return false;
    }
  }

  constructor_http() { // Keep original constructor logic for HTTP methods if needed
    this.apiKey = process.env.ELEVENLABS_API_KEY;
    this.baseUrl = 'https://api.elevenlabs.io/v1';
    this.voiceId = process.env.ELEVENLABS_VOICE_ID;
    // Agent ID is used for WebSocket connection now
    
    this.axiosInstance = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'xi-api-key': this.apiKey
      }
    });
  }

  /**
   * Generate speech from text (HTTP method)
   */
  async textToSpeech(text, voiceId = this.voiceId, options = {}) {
     // Need to instantiate axios if not done in constructor
     if (!this.axiosInstance) { this.constructor_http(); }
    try {
      const response = await this.axiosInstance.post(
        `/text-to-speech/${voiceId}`,
        {
          text,
          model_id: options.modelId || 'eleven_monolingual_v1',
          voice_settings: {
            stability: options.stability || 0.5,
            similarity_boost: options.similarityBoost || 0.75,
          }
        },
        {
          responseType: 'arraybuffer'
        }
      );
      logger.info(`Generated speech for text (${text.length} chars)`);
      return response.data;
    } catch (error) {
      logger.error('Error in text-to-speech:', error.response?.status, error.response?.data);
      throw error;
    }
  }

  /**
   * Get available voices (HTTP method)
   */
  async getVoices() {
     // Need to instantiate axios if not done in constructor
     if (!this.axiosInstance) { this.constructor_http(); }
    try {
      const response = await this.axiosInstance.get('/voices');
      logger.info(`Retrieved ${response.data.voices.length} voices`);
      return response.data.voices;
    } catch (error) {
      logger.error('Error getting voices:', error.response?.status, error.response?.data);
      throw error;
    }
  }

  // New method to check for termination requests from other processes
  async _checkForTerminationRequests(sessionId) {
    try {
      const { sessionManager } = require('./redisClient');
      const sessionData = await sessionManager.getOutboundSession(sessionId);
      
      if (sessionData && sessionData.terminateRequested) {
        logger.info(`[${sessionId}] Detected termination request from process ${sessionData.terminateRequestedBy || 'unknown'}`);
        
        // Close the session as requested by another process
        this._stopHeartbeat(sessionId);
        
        const session = activeSessions.get(sessionId);
        if (session && session.ws) {
          session.status = 'CLOSING';
          session.ws.close(1000, `Termination requested by process ${sessionData.terminateRequestedBy}`);
        }
        
        // Update Redis to acknowledge termination request
        await sessionManager.saveOutboundSession(sessionId, {
          ...sessionData,
          status: 'closing',
          terminationAcknowledged: true,
          terminationAcknowledgedBy: process.pid,
          terminationAcknowledgedTime: Date.now()
        });
      }
    } catch (error) {
      logger.error(`[${sessionId}] Error checking for termination requests:`, error);
    }
  }

  // New method to set up a Redis subscription for Twilio audio
  async _setupTwilioAudioSubscription(sessionId) {
    try {
      const { subscriberClient } = require('./redisClient');
      const { TWILIO_AUDIO_CHANNEL_PREFIX } = require('./elevenlabsHandlers');
      const audioChannel = `${TWILIO_AUDIO_CHANNEL_PREFIX}${sessionId}`;  // Use the dedicated Twilio-to-ElevenLabs prefix
      
      // Subscribe to the audio channel
      await subscriberClient.subscribe(audioChannel, (message) => {
        try {
          const data = JSON.parse(message);
          
          if (data.audioBase64) {
            logger.info(`[${sessionId}] Received Twilio audio from process ${data.sourceProcess || 'unknown'} via Redis`);
            
            // Forward the audio to ElevenLabs
            this.sendAudioChunk(sessionId, data.audioBase64);
          }
        } catch (error) {
          logger.error(`[${sessionId}] Error processing Twilio audio from Redis:`, error);
        }
      });
      
      logger.info(`[${sessionId}] Set up subscription for Twilio audio from server process`);
    } catch (error) {
      logger.error(`[${sessionId}] Error setting up Twilio audio subscription:`, error);
    }
  }
  
  // Method to periodically check for Twilio audio messages in Redis
  async _checkForTwilioAudio(sessionId) {
    // This is now handled by the subscription, but we could add additional checks here if needed
  }

  /**
   * Synthesize speech for a response and send to Twilio
   * 
   * This handles text-to-speech conversion if ElevenLabs' agent response 
   * does not include audio.
   * 
   * @param {string} sessionId - The session ID 
   * @param {string} text - The text to convert to speech
   * @returns {Promise<boolean>} - Whether the synthesis was successful
   */
  async synthesizeResponseSpeech(sessionId, text, retryCount = 0) {
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 1000;
    const logPrefix = `[${sessionId}]`;
    
    logger.info(`${logPrefix} [DEBUG] Synthesizing speech for text: "${text.substring(0, 100)}${text.length > 100 ? '...' : ''}"${retryCount > 0 ? ` (retry ${retryCount}/${MAX_RETRIES})` : ''}`);
    
    if (!text || typeof text !== 'string') {
      logger.error(`${logPrefix} [DEBUG] Invalid text for speech synthesis: ${typeof text}`);
      return false;
    }
    
    try {
      // Check if session exists in Redis using the session manager
      const sessionData = await sessionManager.getOutboundSession(sessionId);
      
      if (!sessionData) {
        if (retryCount < MAX_RETRIES) {
          // Session not found but we have retries left
          logger.warn(`${logPrefix} [DEBUG] Session not found in Redis. Will retry in ${RETRY_DELAY_MS}ms (${retryCount+1}/${MAX_RETRIES})`);
          
          // Wait before retrying
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
          
          // Recursively try again with incremented retry count
          return this.synthesizeResponseSpeech(sessionId, text, retryCount + 1);
        } else {
          // We've exhausted our retries
          logger.error(`${logPrefix} [DEBUG] Cannot synthesize speech - session not found in Redis after ${MAX_RETRIES} retries`);
          return false;
        }
      }
      
      // Session data found - log and proceed
      logger.info(`${logPrefix} [DEBUG] Session data found in Redis after ${retryCount} retries: ${JSON.stringify(sessionData)}`);
      
      // Check if voice ID is configured
      const voiceId = this.voiceId || process.env.ELEVENLABS_VOICE_ID;
      if (!voiceId) {
        logger.error(`${logPrefix} [DEBUG] No voice ID configured for speech synthesis`);
        return false;
      }
      
      logger.info(`${logPrefix} [DEBUG] Using voice ID: ${voiceId} for speech synthesis`);
      
      // Prepare TTS API request
      const apiUrl = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
      const headers = {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': this.apiKey
      };
      
      // Request parameters optimized for Twilio voice
      const requestData = {
        text: text,
        model_id: "eleven_monolingual_v1",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true
        },
        output_format: "ulaw_8000" // Explicit µ-law 8kHz format for Twilio compatibility
      };
      
      logger.info(`${logPrefix} [DEBUG] Making TTS API request to ElevenLabs`);
      
      // Make the API request
      const response = await axios({
        method: 'post',
        url: apiUrl,
        headers: headers,
        data: requestData,
        responseType: 'arraybuffer'
      });
      
      logger.info(`${logPrefix} [DEBUG] TTS API response received, status: ${response.status}, content-type: ${response.headers['content-type']}, data length: ${response.data.byteLength} bytes`);
      
      // Check content type header to detect format
      const contentType = response.headers['content-type'];
      logger.info(`${logPrefix} [DEBUG] TTS API response content-type: ${contentType}`);

      // Analyze the first few bytes to determine actual format
      const buffer = Buffer.from(response.data);
      const sampleSize = Math.min(buffer.length, 16);
      const sample = buffer.slice(0, sampleSize);
      const hex = sample.toString('hex').match(/.{1,2}/g).join(' ');
      logger.info(`${logPrefix} [DEBUG] Audio content sample (first ${sampleSize} bytes): ${hex}`);

      // Convert the audio to μ-law format if it's not already
      let audioBuffer;
      if (hex.startsWith('49 44 33')) { // MP3 format
        logger.info(`${logPrefix} [DEBUG] Detected MP3 format, converting to μ-law...`);
        try {
          audioBuffer = await convertMp3ToUlaw(response.data);
          logger.info(`${logPrefix} [DEBUG] Successfully converted MP3 to μ-law format (${audioBuffer.length} bytes)`);
        } catch (conversionError) {
          logger.error(`${logPrefix} [DEBUG] Error converting audio format:`, conversionError);
          audioBuffer = response.data; // Fall back to original format if conversion fails
        }
      } else {
        audioBuffer = response.data; // Use as-is
      }

      // Convert the audio buffer to base64
      const audioBase64 = Buffer.from(audioBuffer).toString('base64');
      
      // Track sequence number for this audio
      const { sequenceCounters } = require('./elevenlabsHandlers');
      if (!sequenceCounters.has(sessionId)) {
        sequenceCounters.set(sessionId, 0);
      }
      const sequenceNumber = sequenceCounters.get(sessionId);
      sequenceCounters.set(sessionId, sequenceNumber + 1);
      
      // Format data for Twilio - remove fields that Twilio doesn't need
      const payload = JSON.stringify({
        audioBase64,
        source: 'tts-synthesis',
        timestamp: Date.now(),
        processId: process.pid,
        format: 'ulaw', // Use ulaw format string for Twilio compatibility
        sampleRate: 8000, // explicitly mark sample rate
        sequenceNumber
        // Removed track and contentType fields which can cause Twilio to silently ignore the chunk
      });
      
      // Get the AUDIO_CHANNEL_PREFIX from the handlers module to ensure consistency
      const { AUDIO_CHANNEL_PREFIX } = require('./elevenlabsHandlers');
      
      // Determine where to send the audio (Twilio WebSocket handling process)
      if (sessionData.ownerProcess && sessionData.ownerProcess !== process.pid) {
        // Owned by another process - publish to Redis
        logger.info(`${logPrefix} [DEBUG] Publishing synthesized speech to Redis for process ${sessionData.ownerProcess}`);
        
        const channel = `${AUDIO_CHANNEL_PREFIX}${sessionId}`;
        logger.info(`${logPrefix} [DEBUG] Using Redis channel for audio: ${channel}`);
        try {
          await publishRedisMessage(channel, payload);
          logger.info(`${logPrefix} [DEBUG] Successfully published synthesized speech to Redis channel ${channel}`);
          return true;
        } catch (redisError) {
          logger.error(`${logPrefix} [DEBUG] Failed to publish synthesized speech to Redis: ${redisError.message}`);
          return false;
        }
      } else if (sessionData.serverHandling && sessionData.serverHandling !== process.pid) {
        // WebSocket handled by another process
        logger.info(`${logPrefix} [DEBUG] Publishing synthesized speech to Redis for server process ${sessionData.serverHandling}`);
        
        const channel = `${AUDIO_CHANNEL_PREFIX}${sessionId}`;
        logger.info(`${logPrefix} [DEBUG] Using Redis channel for audio: ${channel}`);
        try {
          await publishRedisMessage(channel, payload);
          logger.info(`${logPrefix} [DEBUG] Successfully published synthesized speech to Redis for server ${sessionData.serverHandling}`);
          return true;
        } catch (redisError) {
          logger.error(`${logPrefix} [DEBUG] Failed to publish synthesized speech to Redis: ${redisError.message}`);
          return false;
        }
      } else {
        // We own this session, but we might not be handling the WebSocket directly
        // Publish to Redis anyway as a fallback
        logger.warn(`${logPrefix} [DEBUG] No specific process handling WebSocket found. Publishing to Redis as fallback.`);
        
        const channel = `${AUDIO_CHANNEL_PREFIX}${sessionId}`;
        logger.info(`${logPrefix} [DEBUG] Using Redis channel for audio: ${channel}`);
        try {
          await publishRedisMessage(channel, payload);
          logger.info(`${logPrefix} [DEBUG] Fallback published synthesized speech to Redis channel ${channel}`);
          return true;
        } catch (redisError) {
          logger.error(`${logPrefix} [DEBUG] Failed to publish fallback synthesized speech: ${redisError.message}`);
          return false;
        }
      }
    } catch (error) {
      logger.error(`${logPrefix} [DEBUG] Error synthesizing speech:`, error);
      logger.error(`${logPrefix} [DEBUG] Error stack: ${error.stack}`);
      return false;
    }
  }

  /**
   * Utility function to convert a readable stream to an ArrayBuffer
   * This follows the pattern used in the ElevenLabs Twilio documentation
   * @param {ReadableStream} readableStream - The stream to convert
   * @returns {Promise<ArrayBuffer>} - The stream data as ArrayBuffer
   */
  streamToArrayBuffer(readableStream) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      
      readableStream.on('data', (chunk) => {
        chunks.push(chunk);
      });
      
      readableStream.on('end', () => {
        resolve(Buffer.concat(chunks).buffer);
      });
      
      readableStream.on('error', reject);
    });
  }
}

module.exports = new ElevenLabsWebSocketClient();
// Also export the conversion function for potential use in other modules
module.exports.convertMp3ToUlaw = convertMp3ToUlaw; 