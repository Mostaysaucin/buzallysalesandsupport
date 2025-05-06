require('dotenv').config();

// Note: This script assumes the latest pinecone package is installed.
// You may need to run: npm install @pinecone-database/pinecone

const { Pinecone } = require('@pinecone-database/pinecone');

async function listPineconeIndexes() {
  try {
    // Initialize the Pinecone client with your API key
    const pc = new Pinecone({
      apiKey: process.env.PINECONE_API_KEY,
    });

    // List all indexes
    const indexList = await pc.listIndexes();
    
    console.log('Available Pinecone Indexes:');
    if (indexList && indexList.length > 0) {
      indexList.forEach(index => {
        console.log(`- ${index.name}`);
      });
      console.log('\nTo use one of these indexes, update your .env file:');
      console.log('PINECONE_INDEX_NAME=your_chosen_index_name');
    } else {
      console.log('No indexes found. You may need to create an index in your Pinecone console first.');
      console.log('Visit: https://app.pinecone.io/');
    }
  } catch (error) {
    console.error('Error listing Pinecone indexes:', error.message);
  }
}

listPineconeIndexes(); 