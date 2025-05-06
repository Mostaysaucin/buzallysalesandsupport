const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Create logs directory if it doesn't exist
const logDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// Create debug logs directory if it doesn't exist
const debugLogDir = path.join(__dirname, '..', 'debug_logs');
if (!fs.existsSync(debugLogDir)) {
  fs.mkdirSync(debugLogDir, { recursive: true });
}

// Format that captures detailed information including timestamp and any debug flags in messages
const detailedFormat = winston.format.combine(
  winston.format.timestamp({
    format: 'YYYY-MM-DD HH:mm:ss.SSS'
  }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

// Custom format for console output
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({
    format: 'YYYY-MM-DD HH:mm:ss.SSS'
  }),
  winston.format.printf(
    info => `${info.timestamp} ${info.level}: ${info.message}${info.stack ? '\n' + info.stack : ''}`
  )
);

// Create the logger with appropriate transports
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  format: detailedFormat,
  defaultMeta: { service: 'voice-agents-service', pid: process.pid },
  transports: [
    new winston.transports.Console({
      format: consoleFormat
    }),
    // Always log to a debug file regardless of environment
    new winston.transports.File({ 
      filename: path.join(debugLogDir, `debug-${process.pid}.log`), 
      level: 'debug',
      maxsize: 10485760, // 10MB
      maxFiles: 5,
      format: detailedFormat
    })
  ]
});

// Add standard log files in production
if (process.env.NODE_ENV === 'production') {
  logger.add(
    new winston.transports.File({ 
      filename: path.join(logDir, 'error.log'), 
      level: 'error',
      maxsize: 10485760, // 10MB
      maxFiles: 5
    })
  );
  logger.add(
    new winston.transports.File({ 
      filename: path.join(logDir, 'combined.log'),
      maxsize: 10485760, // 10MB
      maxFiles: 5
    })
  );
}

// Log startup information
logger.info(`Logger initialized with level: ${logger.level}, environment: ${process.env.NODE_ENV || 'development'}, PID: ${process.pid}`);
logger.info(`Debug logs will be written to: ${path.join(debugLogDir, `debug-${process.pid}.log`)}`);

module.exports = logger; 