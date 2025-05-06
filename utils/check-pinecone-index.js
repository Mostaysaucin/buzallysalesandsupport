require('dotenv').config();
const { Pinecone } = require('@pinecone-database/pinecone');

// Index name to check
const INDEX_NAME = 'voice-agents-kb';

async function checkPineconeIndex() {
  try {
    // Initialize the Pinecone client
    const pc = new Pinecone({
      apiKey: process.env.PINECONE_API_KEY,
    });

    console.log(`Checking status of Pinecone index: ${INDEX_NAME}...`);
    
    // Get the index description
    const description = await pc.describeIndex(INDEX_NAME);
    
    console.log('Index status:', description.status);
    console.log('Index details:', JSON.stringify(description, null, 2));
    
    if (description.status.ready) {
      console.log('\nIndex is ready! Update your .env file:');
      console.log(`PINECONE_INDEX_NAME=${INDEX_NAME}`);
    } else {
      console.log('\nIndex is not ready yet. Please check again in a few minutes.');
    }
    
  } catch (error) {
    console.error('Error checking Pinecone index:', error.message);
    if (error.message.includes('not found')) {
      console.log(`\nIndex '${INDEX_NAME}' not found. Create it first using utils/create-pinecone-index.js`);
    }
  }
}

checkPineconeIndex(); 