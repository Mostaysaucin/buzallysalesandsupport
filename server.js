require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const express = require('express');
const http = require('http'); // Import http module
const cors = require('cors');
const logger = require('./utils/logger');
const inboundRoutes = require('./routes/inbound-routes');
const { 
    router: outboundRouter, 
    setupWebSocketServer: setupOutboundWebSocketServer, 
    initializeRateLimiters 
} = require('./routes/outbound-routes');
const knowledgeRoutes = require('./routes/knowledge-routes');
const { redisClient, connectRedis, subscriberClient } = require('./utils/redisClient'); // Import redisClient
const { dbService } = require('./utils/dbClient');     // Import DB service
const {
    handleElevenLabsSessionStart,
    handleElevenLabsTtsRequest,
    handleElevenLabsSessionEnd
} = require('./utils/redisMessageHandlers');

// --- Optional: Integrate Worker (Commented out - run separately) ---
// require('./queueWorker.js'); 
// ------------------------------------

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  // Exclude WebSocket upgrade requests from HTTP logging if desired
  if (req.headers.upgrade !== 'websocket') {
     logger.info(`${req.method} ${req.url}`);
  }
  next();
});

// Routes
app.use('/api/inbound', inboundRoutes);
app.use('/api/outbound', outboundRouter);
app.use('/api/knowledge', knowledgeRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Setup WebSocket server for outbound calls
// Note: setup function itself doesn't need Redis connection usually
// setupOutboundWebSocketServer(server);

// Setup Redis subscribers for ElevenLabs message types
async function setupRedisSubscribers() {
    try {
        await subscriberClient.subscribe('elevenlabs-session-start', handleElevenLabsSessionStart);
        await subscriberClient.subscribe('elevenlabs-tts-request', handleElevenLabsTtsRequest);
        await subscriberClient.subscribe('elevenlabs-session-end', handleElevenLabsSessionEnd);
        
        logger.info('Redis subscribers configured for ElevenLabs message types');
    } catch (error) {
        logger.error('Error setting up Redis subscribers:', error);
    }
}

// Error handler
app.use((err, req, res, next) => {
  logger.error(err.stack);
  res.status(500).json({ error: 'Internal Server Error', message: err.message });
});

// Start function
async function startServer() {
  try {
    // Connect to Redis (ensure clients are connected before use)
    await connectRedis();
    logger.info('Redis connected successfully.');

    // Set up Redis subscribers
    await setupRedisSubscribers();
    logger.info('Redis subscribers set up successfully.');

    // Initialize Rate Limiters now that Redis client is connected
    // Pass the connected client instance
    initializeRateLimiters(redisClient);

    // Setup WebSocket servers by passing the HTTP server instance
    // setupOutboundWebSocketServer needs to be called AFTER rate limiters
    // if WS setup depends on anything initialized after Redis connect.
    // In our case, it uses sessionManager which uses redisClient, so order is ok.
    setupOutboundWebSocketServer(server); // Setup for outbound calls
    logger.info('Outbound WebSocket server attached to HTTP server.');

    // Start listening
      server.listen(PORT, () => {
        logger.info(`Server (HTTP & WebSocket) running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
      logger.info(`Outbound WebSocket stream path: /api/outbound/stream/:sessionId`);
    });

  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

// Handle graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => { // Close the HTTP server
      logger.info('HTTP server closed.');
      // Add WebSocket server closing logic if needed
      process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  server.close(() => { // Close the HTTP server
      logger.info('HTTP server closed.');
       // Add WebSocket server closing logic if needed
      process.exit(0);
  });
});

module.exports = app; // Export app for testing, but server instance is what runs 