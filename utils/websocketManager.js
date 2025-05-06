import WebSocket from 'ws';
import http from 'http';
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

/**
 * WebSocket Manager for handling audio streaming connections
 * Optimized for high concurrency with Redis pub/sub for distributing audio
 */
export class WebSocketManager {
  constructor(server) {
    this.wss = new WebSocket.Server({ server });
    this.sessions = new Map();
    this.redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD,
      tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
      maxRetriesPerRequest: null
    });
    
    this.pubSub = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD,
      tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
      maxRetriesPerRequest: null
    });
    
    // Subscribe to Redis channels for audio streaming
    this.pubSub.subscribe('elevenlabs-audio');
    this.pubSub.on('message', this.handleRedisMessage.bind(this));
    
    // Set up WebSocket server
    this.wss.on('connection', this.handleConnection.bind(this));
    
    // Start heartbeat to detect dead connections
    this.startHeartbeat();
    
    debugLog('WebSocket Manager initialized');
    
    // Handle Redis errors
    this.redis.on('error', (err) => {
      debugLog(`Redis client error: ${err.message}`);
    });
    
    this.pubSub.on('error', (err) => {
      debugLog(`Redis pubsub error: ${err.message}`);
    });
  }
  
  /**
   * Handle new WebSocket connections
   */
  handleConnection(ws, req) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const sessionId = url.pathname.split('/').pop();
    
    if (!sessionId) {
      ws.close(1008, 'Missing session ID');
      debugLog('Rejected WebSocket connection: Missing session ID');
      return;
    }
    
    // Store the connection with session ID
    ws.sessionId = sessionId;
    ws.isAlive = true;
    ws.lastActivity = Date.now();
    
    // Store connection in Map with metadata
    this.sessions.set(sessionId, {
      ws,
      stats: {
        connectedAt: Date.now(),
        messagesSent: 0,
        messagesReceived: 0,
        bytesReceived: 0,
        bytesSent: 0
      }
    });
    
    debugLog(`WebSocket connection established for session ${sessionId}`);
    
    // Handle WebSocket events
    ws.on('pong', () => {
      ws.isAlive = true;
      ws.lastActivity = Date.now();
    });
    
    ws.on('close', () => {
      this.sessions.delete(sessionId);
      debugLog(`WebSocket connection closed for session ${sessionId}`);
      
      // Notify other systems that connection is closed
      this.redis.publish('websocket-disconnected', JSON.stringify({
        sessionId,
        timestamp: Date.now()
      }));
    });
    
    ws.on('error', (error) => {
      debugLog(`WebSocket error for session ${sessionId}: ${error.message}`);
    });
    
    // Handle incoming messages from client
    ws.on('message', (message) => {
      const session = this.sessions.get(sessionId);
      if (session) {
        session.stats.messagesReceived++;
        session.stats.bytesReceived += message.length;
      }
      
      try {
        const data = JSON.parse(message);
        debugLog(`Received WebSocket message from ${sessionId}: ${JSON.stringify(data)}`);
        
        // Publish message to Redis for processing by relevant services
        this.redis.publish('websocket-message', JSON.stringify({
          sessionId,
          data,
          timestamp: Date.now()
        }));
      } catch (error) {
        debugLog(`Error parsing WebSocket message from ${sessionId}: ${error.message}`);
      }
    });
    
    // Notify other systems that a new connection has been established
    this.redis.publish('websocket-connected', JSON.stringify({
      sessionId,
      timestamp: Date.now(),
      url: req.url,
      headers: req.headers
    }));
  }
  
  /**
   * Handle messages from Redis pubsub
   */
  handleRedisMessage(channel, message) {
    if (channel === 'elevenlabs-audio') {
      try {
        const data = JSON.parse(message);
        const { sessionId, audioChunk, isLast = false, chunkId, timestamp } = data;
        
        // Find the session
        const session = this.sessions.get(sessionId);
        if (!session || !session.ws || session.ws.readyState !== WebSocket.OPEN) {
          return;
        }
        
        // Send audio chunk to client
        this.sendToClient(session, {
          type: 'audio',
          data: audioChunk,
          isLast,
          chunkId,
          timestamp: timestamp || Date.now()
        });
      } catch (error) {
        debugLog(`Error handling Redis elevenlabs-audio message: ${error.message}`);
      }
    }
  }
  
  /**
   * Send data to a client safely
   */
  sendToClient(session, data) {
    try {
      if (session.ws && session.ws.readyState === WebSocket.OPEN) {
        const message = JSON.stringify(data);
        session.ws.send(message);
        
        // Update stats
        session.stats.messagesSent++;
        session.stats.bytesSent += message.length;
        
        return true;
      }
    } catch (error) {
      debugLog(`Error sending to client: ${error.message}`);
    }
    
    return false;
  }
  
  /**
   * Send audio to a specific session
   */
  sendAudio(sessionId, audioChunk, isLast = false, chunkId = null) {
    const session = this.sessions.get(sessionId);
    
    if (session) {
      return this.sendToClient(session, {
        type: 'audio',
        data: audioChunk,
        isLast,
        chunkId,
        timestamp: Date.now()
      });
    }
    
    return false;
  }
  
  /**
   * Publish audio to Redis for distribution to all workers
   */
  publishAudio(sessionId, audioChunk, isLast = false, chunkId = null) {
    try {
      this.redis.publish('elevenlabs-audio', JSON.stringify({
        sessionId,
        audioChunk,
        isLast,
        chunkId,
        timestamp: Date.now()
      }));
      
      return true;
    } catch (error) {
      debugLog(`Error publishing audio to Redis: ${error.message}`);
      return false;
    }
  }
  
  /**
   * Send a control message to a session
   */
  sendControl(sessionId, action, data = {}) {
    const session = this.sessions.get(sessionId);
    
    if (session) {
      return this.sendToClient(session, {
        type: 'control',
        action,
        data,
        timestamp: Date.now()
      });
    }
    
    return false;
  }
  
  /**
   * Heartbeat to detect and close dead connections
   */
  startHeartbeat() {
    setInterval(() => {
      const now = Date.now();
      
      this.sessions.forEach((session, sessionId) => {
        const { ws } = session;
        
        if (ws.isAlive === false) {
          debugLog(`Terminating inactive WebSocket for session ${sessionId}`);
          ws.terminate();
          this.sessions.delete(sessionId);
          return;
        }
        
        // Check for inactive connections (no activity for 2 minutes)
        if (now - ws.lastActivity > 120000) {
          debugLog(`Terminating long inactive WebSocket for session ${sessionId}`);
          ws.terminate();
          this.sessions.delete(sessionId);
          return;
        }
        
        ws.isAlive = false;
        ws.ping(() => {});
      });
    }, 30000); // 30 seconds
  }
  
  /**
   * Get stats about active connections
   */
  getStats() {
    return {
      activeConnections: this.sessions.size,
      connections: Array.from(this.sessions.entries()).map(([sessionId, session]) => ({
        sessionId,
        connectedAt: session.stats.connectedAt,
        messagesSent: session.stats.messagesSent,
        messagesReceived: session.stats.messagesReceived,
        bytesReceived: session.stats.bytesReceived,
        bytesSent: session.stats.bytesSent,
        lastActivity: session.ws.lastActivity
      }))
    };
  }
  
  /**
   * Broadcast a message to all connected clients
   */
  broadcast(message) {
    let successCount = 0;
    
    this.sessions.forEach((session) => {
      if (this.sendToClient(session, message)) {
        successCount++;
      }
    });
    
    return successCount;
  }
  
  /**
   * Close all connections and cleanup
   */
  async close() {
    // Stop heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    // Close all connections
    this.sessions.forEach((session, sessionId) => {
      try {
        session.ws.close(1000, 'Server shutting down');
      } catch (error) {
        // Ignore errors during shutdown
      }
    });
    
    // Unsubscribe from Redis channels
    await this.pubSub.unsubscribe();
    
    // Close Redis connections
    await this.redis.quit();
    await this.pubSub.quit();
    
    debugLog('WebSocket Manager closed');
  }
}

/**
 * Create a WebSocket manager instance for the given server
 */
export const createWebSocketManager = (server) => {
  return new WebSocketManager(server);
};

// Helper function to publish Redis messages (for backward compatibility)
export const publishRedisMessage = async (channel, message) => {
  const redis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD,
    tls: process.env.REDIS_TLS === 'true' ? {} : undefined
  });
  
  try {
    await redis.publish(channel, typeof message === 'string' ? message : JSON.stringify(message));
    await redis.quit();
    return true;
  } catch (error) {
    debugLog(`Error publishing Redis message: ${error.message}`);
    await redis.quit();
    return false;
  }
};

// Helper function to get a Redis client
export const getRedisClient = () => {
  return new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD,
    tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
    maxRetriesPerRequest: null
  });
}; 