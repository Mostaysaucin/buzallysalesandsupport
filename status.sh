#!/bin/bash

# Define log directory
LOG_DIR="logs"

# Function to check process status
check_process() {
  local pid_file="$1"
  local process_name="$2"
  
  if [ -f "$pid_file" ]; then
    PID=$(cat "$pid_file")
    
    if ps -p $PID > /dev/null; then
      echo "$process_name is running (PID: $PID)"
      return 0
    else
      echo "$process_name is not running, but PID file exists (stale PID: $PID)"
      return 1
    fi
  else
    echo "$process_name is not running (no PID file)"
    return 1
  fi
}

# Check server and worker status
SERVER_RUNNING=0
WORKER_RUNNING=0

check_process "$LOG_DIR/server.pid" "Server"
SERVER_RUNNING=$?

check_process "$LOG_DIR/worker.pid" "Worker"
WORKER_RUNNING=$?

# Show the recent logs
echo ""
echo "Recent log entries for server:"
if [ -f "$LOG_DIR/server.pid" ]; then
  SERVER_PID=$(cat "$LOG_DIR/server.pid")
  LATEST_SERVER_LOG=$(ls -t $LOG_DIR/server_*.log 2>/dev/null | head -n 1)
  if [ -n "$LATEST_SERVER_LOG" ]; then
    tail -n 10 "$LATEST_SERVER_LOG"
  else
    echo "No server logs found."
  fi
fi

echo ""
echo "Recent log entries for worker:"
if [ -f "$LOG_DIR/worker.pid" ]; then
  WORKER_PID=$(cat "$LOG_DIR/worker.pid")
  LATEST_WORKER_LOG=$(ls -t $LOG_DIR/worker_*.log 2>/dev/null | head -n 1)
  if [ -n "$LATEST_WORKER_LOG" ]; then
    tail -n 10 "$LATEST_WORKER_LOG"
  else
    echo "No worker logs found."
  fi
fi

echo ""
if [ $SERVER_RUNNING -eq 0 ] && [ $WORKER_RUNNING -eq 0 ]; then
  echo "All systems operational."
else
  echo "One or more systems are not running. Use ./start.sh to restart them."
fi 