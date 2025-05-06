require('dotenv').config();
const axios = require('axios');
const logger = require('./logger');

// Configuration
const PORT = process.env.PORT || 3000;
const BASE_URL = `http://localhost:${PORT}`;
const TEST_PHONE_NUMBER = "+12025550123"; // Replace with a real test number if needed

/**
 * Test initiating an outbound call
 */
async function testOutboundCall() {
  try {
    console.log('=== TESTING OUTBOUND CALL FUNCTIONALITY ===');
    console.log(`Initiating outbound call to ${TEST_PHONE_NUMBER}`);
    
    // Create outbound call payload
    const callPayload = {
      to: TEST_PHONE_NUMBER,
      context: "sales_follow_up",
      data: {
        customer_name: "John Doe",
        company: "ACME Inc.",
        product_interest: "Business Alliance Professional Services",
        last_contact: "2 weeks ago"
      }
    };
    
    console.log('Sending payload:', JSON.stringify(callPayload, null, 2));
    
    // Send request to initiate outbound call
    const response = await axios.post(`${BASE_URL}/api/outbound/call`, callPayload, {
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    console.log(`Response Status: ${response.status}`);
    console.log('Response Data:', JSON.stringify(response.data, null, 2));
    
    if (response.status === 200 && response.data.callSid) {
      console.log(`✅ Successfully initiated outbound call! Call SID: ${response.data.callSid}`);
      
      // Test call status endpoint
      await testCallStatus(response.data.callSid);
    } else {
      console.error('❌ Outbound call initiation failed!');
    }
  } catch (error) {
    console.error('❌ Error initiating outbound call:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
      console.error('Response status:', error.response.status);
    }
  }
}

/**
 * Test call status endpoint
 * @param {string} callSid - The SID of the initiated call
 */
async function testCallStatus(callSid) {
  try {
    console.log('\n=== TESTING CALL STATUS ENDPOINT ===');
    console.log(`Getting status for call: ${callSid}`);
    
    // Create status update payload
    const statusPayload = {
      CallSid: callSid,
      CallStatus: "in-progress",
      CallDuration: "5",
      Timestamp: new Date().toISOString()
    };
    
    console.log('Sending payload:', JSON.stringify(statusPayload, null, 2));
    
    // Send status update
    const response = await axios.post(`${BASE_URL}/api/outbound/status/${callSid}`, statusPayload, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    
    console.log(`Response Status: ${response.status}`);
    
    if (response.status === 200) {
      console.log('✅ Successfully updated call status!');
      
      // Test speech processing endpoint
      // await testSpeechProcessing(callSid); // REMOVED: Deprecated due to WebSocket streaming
      console.log('\n✅ Core outbound call tests completed successfully (initiation and status)!');
      
    } else {
      console.error('❌ Call status update failed!');
    }
  } catch (error) {
    console.error('❌ Error updating call status:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
      console.error('Response status:', error.response.status);
    }
  }
}

/**
 * Test TwiML generation endpoint
 * @param {string} callSid - The SID of the initiated call
 */
async function testTwiML(callSid) {
  try {
    console.log('\n=== TESTING TWIML GENERATION ENDPOINT ===');
    console.log(`Getting TwiML for call: ${callSid}`);
    
    // Get TwiML for the call
    const response = await axios.get(`${BASE_URL}/api/outbound/twiml/${callSid}`);
    
    console.log(`Response Status: ${response.status}`);
    console.log('Response Data (TwiML):', response.data);
    
    if (response.status === 200 && response.data.includes('<Response>')) {
      console.log('✅ Successfully generated TwiML!');
    } else {
      console.error('❌ TwiML generation failed!');
    }
  } catch (error) {
    console.error('❌ Error generating TwiML:', error.message);
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
  console.log(`Testing outbound call functionality on ${BASE_URL}`);
  console.log('Make sure your server is running before proceeding!');
  
  try {
    // Check if server is running
    await axios.get(`${BASE_URL}/health`);
    console.log('✅ Server is running. Starting tests...\n');
    
    // Run outbound call test sequence
    await testOutboundCall();
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