module.exports = {
  apps: [
    {
      name: 'api-server',
      script: './queueWorker.js',
      instances: 1, // Use one instance for queue setup
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      }
    },
    {
      name: 'outbound-worker',
      script: './outboundCallWorker.js',
      instances: 4, // Run 4 worker instances
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        QUEUE_TYPE: 'outbound-calls'
      }
    },
    {
      name: 'audio-worker',
      script: './audioWorker.js',
      instances: 2,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        QUEUE_TYPE: 'audio-processing'
      }
    },
    {
      name: 'ws-cleanup',
      script: './wsCleanupWorker.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production'
      },
      cron_restart: '0 */4 * * *' // Restart every 4 hours
    }
  ]
}; 