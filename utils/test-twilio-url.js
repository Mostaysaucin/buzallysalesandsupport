require('dotenv').config();
const twilio = require('twilio');
const logger = require('./logger'); // Use existing logger for consistency

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;
const publicUrl = process.env.PUBLIC_URL; // Get the base ngrok URL

// Use a dummy session ID for testing
const testSessionId = 'test_session_12345';
const testToNumber = '+12025550199'; // Use a valid test number if needed, but the URL error happens first

if (!accountSid || !authToken || !twilioPhoneNumber || !publicUrl) {
  logger.error('Missing Twilio credentials or PUBLIC_URL in .env file. Exiting.');
  process.exit(1);
}

const twilioClient = twilio(accountSid, authToken);

// Construct the exact URL that causes the error
const problematicTwimlUrl = `${publicUrl}/api/outbound/twiml/${testSessionId}`.trim();
logger.info(`Testing Twilio client with URL: ${problematicTwimlUrl}`);

async function testCallCreate() {
  try {
    logger.info(`Attempting twilioClient.calls.create...`);
    const call = await twilioClient.calls.create({
      to: testToNumber,
      from: twilioPhoneNumber,
      url: problematicTwimlUrl, // Use the potentially problematic URL
      // statusCallback: problematicStatusUrl, // Can omit status callback for this specific test
      // statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed', 'failed'],
      // statusCallbackMethod: 'POST'
    });
    logger.info(`SUCCESS: twilioClient.calls.create initiated call SID: ${call.sid}`);
    logger.info('This suggests the URL is valid in this isolated context.');

  } catch (error) {
    logger.error('FAILED: twilioClient.calls.create threw an error:');
    if (error.message.includes('Url is not a valid URL')) {
        logger.error(`CONFIRMED: The error is specifically 'Url is not a valid URL'.`);
        logger.error('This indicates the twilio-node library is rejecting this URL format directly.');
    } else {
        logger.error(`Error message: ${error.message}`);
        logger.error('Stack:', error.stack);
        logger.error('This might be an authentication issue or other problem, not the URL itself.');
    }
  }
}

testCallCreate(); 