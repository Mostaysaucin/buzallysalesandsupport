require('dotenv').config();
const axios = require('axios');
const logger = require('./logger');

// Configuration
const PORT = process.env.PORT || 3000;
const BASE_URL = `http://localhost:${PORT}`;
const TEST_CALLER_NUMBER = "+12025550123"; // Example caller number
const TEST_RECEIVER_NUMBER = process.env.OPENPHONE_WEBHOOK_NUMBER || "+12025550198"; 
const TEST_CALL_SID = "test-call-" + Date.now();

/**
 * Simulate an inbound call webhook from OpenPhone
 */
async function simulateInboundCall() {
  try {
    console.log('=== TESTING INBOUND CALL FUNCTIONALITY ===');
    console.log(`Simulating inbound call to ${BASE_URL}/api/inbound/call`);

    // Create test webhook payload
    const webhookPayload = {
      event: "call.created",
      data: {
        id: TEST_CALL_SID,
        callerId: TEST_CALLER_NUMBER,
        calleeId: TEST_RECEIVER_NUMBER,
        direction: "inbound",
        state: "ringing",
        createdAt: new Date().toISOString(),
        answeredAt: null,
        endedAt: null
      }
    };
    
    console.log('Sending payload:', JSON.stringify(webhookPayload, null, 2));
    
    // Send request to the inbound call endpoint
    const response = await axios.post(`${BASE_URL}/api/inbound/call`, webhookPayload, {
      headers: {
        'Content-Type': 'application/json',
        'X-OpenPhone-Signature': process.env.OPENPHONE_WEBHOOK_SECRET
      }
    });
    
    console.log(`Response Status: ${response.status}`);
    console.log('Response Data:', JSON.stringify(response.data, null, 2));
    
    if (response.status === 200) {
      console.log('✅ Successfully simulated inbound call webhook!');
      
      // Now simulate a voice input from the caller
      await simulateVoiceInput();
    } else {
      console.error('❌ Inbound call simulation failed!');
    }
  } catch (error) {
    console.error('❌ Error simulating inbound call:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
      console.error('Response status:', error.response.status);
    }
  }
}

/**
 * Simulate voice input for the ongoing call
 */
async function simulateVoiceInput() {
  try {
    console.log('\n=== TESTING VOICE INPUT PROCESSING ===');
    console.log(`Simulating voice input to ${BASE_URL}/api/inbound/voice`);
    
    // Create test voice payload
    const voicePayload = {
      callId: TEST_CALL_SID,
      callerId: TEST_CALLER_NUMBER,
      calleeId: TEST_RECEIVER_NUMBER,
      text: "Hello, I'm calling about your business alliance services. Can you tell me more about your offerings?",
      confidence: 0.95
    };
    
    console.log('Sending payload:', JSON.stringify(voicePayload, null, 2));
    
    // Send request to the voice input endpoint
    const response = await axios.post(`${BASE_URL}/api/inbound/voice`, voicePayload, {
      headers: {
        'Content-Type': 'application/json',
      }
    });
    
    console.log(`Response Status: ${response.status}`);
    console.log('Response Data:', JSON.stringify(response.data, null, 2));
    
    if (response.status === 200) {
      console.log('✅ Successfully simulated voice input!');
      
      // Finally, simulate call hangup
      await simulateHangup();
    } else {
      console.error('❌ Voice input simulation failed!');
    }
  } catch (error) {
    console.error('❌ Error simulating voice input:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
      console.error('Response status:', error.response.status);
    }
  }
}

/**
 * Simulate call hangup
 */
async function simulateHangup() {
  try {
    console.log('\n=== TESTING CALL HANGUP ===');
    console.log(`Simulating call hangup to ${BASE_URL}/api/inbound/hangup`);
    
    // Create test hangup payload
    const hangupPayload = {
      event: "call.ended",
      data: {
        id: TEST_CALL_SID,
        callerId: TEST_CALLER_NUMBER,
        calleeId: TEST_RECEIVER_NUMBER,
        direction: "inbound",
        state: "completed",
        createdAt: new Date(Date.now() - 60000).toISOString(), // 1 minute ago
        answeredAt: new Date(Date.now() - 55000).toISOString(), // 55 seconds ago
        endedAt: new Date().toISOString()
      }
    };
    
    console.log('Sending payload:', JSON.stringify(hangupPayload, null, 2));
    
    // Send request to the hangup endpoint
    const response = await axios.post(`${BASE_URL}/api/inbound/hangup`, hangupPayload, {
      headers: {
        'Content-Type': 'application/json',
        'X-OpenPhone-Signature': process.env.OPENPHONE_WEBHOOK_SECRET
      }
    });
    
    console.log(`Response Status: ${response.status}`);
    console.log('Response Data:', JSON.stringify(response.data, null, 2));
    
    if (response.status === 200) {
      console.log('✅ Successfully simulated call hangup!');
      console.log('\n✅ All inbound call tests completed successfully!');
    } else {
      console.error('❌ Call hangup simulation failed!');
    }
  } catch (error) {
    console.error('❌ Error simulating call hangup:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
      console.error('Response status:', error.response.status);
    }
  }
}

/**
 * Main function to run all tests
 */
async function runTests() {
  console.log(`Testing inbound call functionality on ${BASE_URL}`);
  console.log('Make sure your server is running before proceeding!');
  
  try {
    // Check if server is running
    await axios.get(`${BASE_URL}/health`);
    console.log('✅ Server is running. Starting tests...\n');
    
    // Run inbound call test sequence
    await simulateInboundCall();
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      console.error(`❌ Could not connect to server at ${BASE_URL}`);
      console.error('Please start your server with: npm run dev');
    } else {
      console.error('❌ Error running tests:', error.message);
    }
  }
}

// Run the tests
runTests().catch(error => {
  console.error('Unhandled error during tests:', error);
}); 