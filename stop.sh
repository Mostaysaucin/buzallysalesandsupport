#!/bin/bash

# Define log directory
LOG_DIR="logs"

# Function to stop a process
stop_process() {
  local pid_file="$1"
  local process_name="$2"
  
  if [ -f "$pid_file" ]; then
    PID=$(cat "$pid_file")
    echo "Stopping $process_name (PID: $PID)..."
    
    if ps -p $PID > /dev/null; then
      kill $PID
      sleep 2
      
      # Check if it's still running and force kill if needed
      if ps -p $PID > /dev/null; then
        echo "$process_name did not stop gracefully, forcing termination..."
        kill -9 $PID
      fi
      
      echo "$process_name stopped successfully."
    else
      echo "$process_name is not running."
    fi
    
    rm "$pid_file"
  else
    echo "No PID file found for $process_name."
  fi
}

# Stop server and worker
stop_process "$LOG_DIR/server.pid" "Server"
stop_process "$LOG_DIR/worker.pid" "Worker"

echo "All processes stopped." 