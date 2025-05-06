/**
 * Test script for PostgreSQL database connection
 * 
 * This script tests the connection to PostgreSQL using the credentials from the .env file.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const { Pool } = require('pg');
const logger = console;

// Create connection pool using environment variables
const pool = new Pool({
    user: process.env.DB_USERNAME,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

async function testConnection() {
    logger.log('Testing PostgreSQL connection...');
    
    try {
        // Get a client from the pool
        const client = await pool.connect();
        
        try {
            // Test the connection with a simple query
            const result = await client.query('SELECT NOW() as now');
            logger.log('✅ Connection successful! Server time:', result.rows[0].now);
            
            // Test schema
            logger.log('Testing if tables exist...');
            const tableResult = await client.query(`
                SELECT table_name
                FROM information_schema.tables
                WHERE table_schema='public'
                ORDER BY table_name;
            `);
            
            if (tableResult.rows.length === 0) {
                logger.log('⚠️ No tables found in the database. You may need to create the schema.');
            } else {
                logger.log('Tables found:');
                tableResult.rows.forEach(row => {
                    logger.log(`- ${row.table_name}`);
                });
            }
            
            // Create a test table if needed
            if (!tableResult.rows.some(row => row.table_name === 'connection_tests')) {
                logger.log('Creating a test table...');
                await client.query(`
                    CREATE TABLE connection_tests (
                        id SERIAL PRIMARY KEY,
                        test_time TIMESTAMP DEFAULT NOW(),
                        test_message TEXT
                    );
                `);
                logger.log('✅ Test table created successfully.');
                
                // Insert a test row
                await client.query(`
                    INSERT INTO connection_tests (test_message) 
                    VALUES ('Connection test successful');
                `);
                logger.log('✅ Test data inserted successfully.');
            }
            
        } finally {
            // Release the client back to the pool
            client.release();
        }
    } catch (error) {
        logger.error('❌ Database connection error:', error.message);
        
        if (error.message.includes('role') || error.message.includes('authentication')) {
            logger.error('Authentication failed. Make sure you:');
            logger.error('1. Created the "voice_user" role in PostgreSQL');
            logger.error('2. Created the "voice_agents" database');
            logger.error('3. Set the correct password in the .env file');
            logger.error('\nRun the create_db.sh script to set up the database user and database.');
        }
        
        if (error.message.includes('database') && error.message.includes('does not exist')) {
            logger.error('Database does not exist. Make sure you:');
            logger.error('1. Created the "voice_agents" database');
            logger.error('\nRun the create_db.sh script to set up the database.');
        }
        
        if (error.message.includes('connect ECONNREFUSED')) {
            logger.error('Could not connect to PostgreSQL server. Make sure:');
            logger.error('1. PostgreSQL is running at ' + process.env.DB_HOST + ':' + process.env.DB_PORT);
            logger.error('2. Firewall rules allow the connection');
        }
    } finally {
        // End the pool
        await pool.end();
    }
}

// Run the test function
testConnection().catch(err => {
    logger.error('Unhandled error:', err);
    process.exit(1);
}); 