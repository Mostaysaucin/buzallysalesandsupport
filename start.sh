#!/bin/bash

# Determine script directory and project root
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
PROJECT_ROOT=$(cd -- "$SCRIPT_DIR/../.." &> /dev/null && pwd)

# Define log directory relative to project root
LOG_DIR="$PROJECT_ROOT/logs"
mkdir -p "$LOG_DIR"

# Get current timestamp for log files
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")

# Start server with proper environment and logging
echo "Starting server process..."
NODE_ENV=production node "$SCRIPT_DIR/server.js" > "$LOG_DIR/server_$TIMESTAMP.log" 2>&1 &
SERVER_PID=$!
echo "Server started with PID: $SERVER_PID"
# Storing PID file in the log directory relative to project root
echo $SERVER_PID > "$LOG_DIR/server.pid"

# Wait a moment to ensure server is initializing
sleep 3

# Start worker with proper environment and logging
echo "Starting worker process..."
NODE_ENV=production node "$PROJECT_ROOT/queueWorker.js" > "$LOG_DIR/worker_$TIMESTAMP.log" 2>&1 &
WORKER_PID=$!
echo "Worker started with PID: $WORKER_PID"
# Storing PID file in the log directory relative to project root
echo $WORKER_PID > "$LOG_DIR/worker.pid"

echo "Both processes started. Check logs at:"
echo "  - $LOG_DIR/server_$TIMESTAMP.log"
echo "  - $LOG_DIR/worker_$TIMESTAMP.log"
echo "To stop the processes, use: $SCRIPT_DIR/stop.sh (assuming stop.sh is in the same directory)" 