#!/bin/bash

echo "Checking PostgreSQL status..."
if pg_isready; then
    echo "PostgreSQL is running"
    
    # Check if user already exists
    USER_EXISTS=$(psql -t -c "SELECT 1 FROM pg_roles WHERE rolname='voice_user';" postgres 2>/dev/null)
    
    if [ -z "$USER_EXISTS" ]; then
        echo "Creating voice_user role..."
        psql -c "CREATE ROLE voice_user WITH LOGIN PASSWORD 'I;C66^0;hTs|';" postgres
    else
        echo "User voice_user already exists"
    fi
    
    # Check if database already exists
    DB_EXISTS=$(psql -t -c "SELECT 1 FROM pg_database WHERE datname='voice_agents';" postgres 2>/dev/null)
    
    if [ -z "$DB_EXISTS" ]; then
        echo "Creating voice_agents database..."
        psql -c "CREATE DATABASE voice_agents OWNER voice_user;" postgres
    else
        echo "Database voice_agents already exists"
    fi
    
    echo "Database setup completed!"
else
    echo "PostgreSQL is not running."
    echo "If you're using Docker, try the following commands:"
    echo "docker exec -it <postgres_container_name> psql -U postgres -c \"CREATE ROLE voice_user WITH LOGIN PASSWORD 'I;C66^0;hTs|';\""
    echo "docker exec -it <postgres_container_name> psql -U postgres -c \"CREATE DATABASE voice_agents OWNER voice_user;\""
fi 