require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const logger = require('./logger');

// Configuration
const PORT = process.env.PORT || 3000;
const BASE_URL = `http://localhost:${PORT}`;
const LOG_DIR = path.join(__dirname, '..', 'logs');
const STATS_FILE = path.join(LOG_DIR, 'system-stats.json');
const UPDATE_INTERVAL = 30000; // 30 seconds

// Ensure logs directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Initialize stats file if it doesn't exist
if (!fs.existsSync(STATS_FILE)) {
  const initialStats = {
    startTime: new Date().toISOString(),
    inboundCalls: {
      total: 0,
      active: 0,
      completed: 0,
      failed: 0
    },
    outboundCalls: {
      total: 0,
      active: 0,
      completed: 0,
      failed: 0
    },
    knowledgeBase: {
      totalEntries: 0,
      totalQueries: 0,
      averageQueryTime: 0
    },
    system: {
      uptime: 0,
      lastChecked: new Date().toISOString()
    }
  };
  fs.writeFileSync(STATS_FILE, JSON.stringify(initialStats, null, 2));
}

/**
 * Load current system stats
 * @returns {Object} Current stats
 */
function loadStats() {
  try {
    const data = fs.readFileSync(STATS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    logger.error('Error loading stats:', error);
    return null;
  }
}

/**
 * Save updated stats
 * @param {Object} stats - Stats to save
 */
function saveStats(stats) {
  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  } catch (error) {
    logger.error('Error saving stats:', error);
  }
}

/**
 * Check server health
 * @returns {Promise<boolean>} Server health status
 */
async function checkServerHealth() {
  try {
    const response = await axios.get(`${BASE_URL}/health`);
    return response.status === 200;
  } catch (error) {
    logger.error('Server health check failed:', error.message);
    return false;
  }
}

/**
 * Update system stats
 */
async function updateSystemStats() {
  const stats = loadStats();
  if (!stats) return;
  
  // Update uptime
  const startTime = new Date(stats.startTime);
  const uptime = (Date.now() - startTime.getTime()) / 1000; // in seconds
  stats.system.uptime = uptime;
  stats.system.lastChecked = new Date().toISOString();
  
  // Check server health
  const isHealthy = await checkServerHealth();
  stats.system.healthy = isHealthy;
  
  // Save updated stats
  saveStats(stats);
  
  // Log current status
  console.log('=== SYSTEM MONITOR UPDATE ===');
  console.log(`Timestamp: ${stats.system.lastChecked}`);
  console.log(`Server Status: ${isHealthy ? 'Healthy ✅' : 'Unhealthy ❌'}`);
  console.log(`Uptime: ${formatUptime(uptime)}`);
  console.log(`Inbound Calls: ${stats.inboundCalls.total} total (${stats.inboundCalls.active} active)`);
  console.log(`Outbound Calls: ${stats.outboundCalls.total} total (${stats.outboundCalls.active} active)`);
  console.log(`Knowledge Base Entries: ${stats.knowledgeBase.totalEntries}`);
  console.log('=============================');
}

/**
 * Format uptime in a human-readable format
 * @param {number} seconds - Uptime in seconds
 * @returns {string} Formatted uptime
 */
function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  return `${days}d ${hours}h ${minutes}m ${secs}s`;
}

/**
 * Register inbound call
 * @param {string} callId - Call ID
 * @param {string} status - Call status
 */
function registerInboundCall(callId, status) {
  const stats = loadStats();
  if (!stats) return;
  
  stats.inboundCalls.total++;
  if (status === 'active') {
    stats.inboundCalls.active++;
  } else if (status === 'completed') {
    stats.inboundCalls.completed++;
  } else if (status === 'failed') {
    stats.inboundCalls.failed++;
  }
  
  saveStats(stats);
  logger.info(`Registered inbound call ${callId} with status ${status}`);
}

/**
 * Register outbound call
 * @param {string} callId - Call ID
 * @param {string} status - Call status
 */
function registerOutboundCall(callId, status) {
  const stats = loadStats();
  if (!stats) return;
  
  stats.outboundCalls.total++;
  if (status === 'active') {
    stats.outboundCalls.active++;
  } else if (status === 'completed') {
    stats.outboundCalls.completed++;
  } else if (status === 'failed') {
    stats.outboundCalls.failed++;
  }
  
  saveStats(stats);
  logger.info(`Registered outbound call ${callId} with status ${status}`);
}

/**
 * Register knowledge base entry
 */
function registerKnowledgeEntry() {
  const stats = loadStats();
  if (!stats) return;
  
  stats.knowledgeBase.totalEntries++;
  saveStats(stats);
}

/**
 * Register knowledge base query
 * @param {number} queryTime - Query execution time in ms
 */
function registerKnowledgeQuery(queryTime) {
  const stats = loadStats();
  if (!stats) return;
  
  stats.knowledgeBase.totalQueries++;
  
  // Update average query time
  const currentAvg = stats.knowledgeBase.averageQueryTime;
  const newAvg = (currentAvg * (stats.knowledgeBase.totalQueries - 1) + queryTime) / stats.knowledgeBase.totalQueries;
  stats.knowledgeBase.averageQueryTime = newAvg;
  
  saveStats(stats);
}

/**
 * Start monitoring system
 */
function startMonitoring() {
  console.log('Starting system monitoring...');
  
  // Update stats immediately
  updateSystemStats();
  
  // Set up interval to update stats regularly
  setInterval(updateSystemStats, UPDATE_INTERVAL);
  
  console.log(`Monitoring active, stats will update every ${UPDATE_INTERVAL / 1000} seconds`);
  console.log(`Stats are being saved to: ${STATS_FILE}`);
}

// Export monitoring functions
module.exports = {
  startMonitoring,
  registerInboundCall,
  registerOutboundCall,
  registerKnowledgeEntry,
  registerKnowledgeQuery
};

// If this file is run directly, start monitoring
if (require.main === module) {
  startMonitoring();
} 