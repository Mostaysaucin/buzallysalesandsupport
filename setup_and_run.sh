#!/bin/bash

echo "=== Voice Agent Call System Setup and Run ==="

# Make scripts executable
chmod +x create_db.sh
chmod +x start.sh
chmod +x stop.sh

# Step 1: Setup database
echo "Step 1: Setting up PostgreSQL database..."
./create_db.sh

# Step 2: Test database connection
echo "Step 2: Testing database connection..."
node test_db_connection.js

if [ $? -ne 0 ]; then
    echo "Database connection test failed. Please fix the database issues before continuing."
    echo "You may need to install the pg package: npm install pg"
    echo "Do you want to continue anyway? (y/n)"
    read continue_answer
    if [ "$continue_answer" != "y" ]; then
        echo "Setup aborted. Fix the database issues and try again."
        exit 1
    fi
fi

# Step 3: Stop any running instances
echo "Step 3: Stopping any running instances..."
./stop.sh

# Step 4: Start the services
echo "Step 4: Starting services..."
./start.sh

# Step 5: Wait a moment for services to initialize
echo "Waiting for services to initialize..."
sleep 5

# Step 6: Tail logs in split view
echo "Step 5: Showing logs (CTRL+C to exit)..."
tail -f logs/worker_*.log logs/server_*.log

# Instructions for testing
echo ""
echo "To make a test call, open a new terminal and run:"
echo "curl -X POST -H \"Content-Type: application/json\" -d '{ \"to\": \"+18504919713\", \"from\": \"+14077537142\" }' http://localhost:3000/api/outbound/start" 