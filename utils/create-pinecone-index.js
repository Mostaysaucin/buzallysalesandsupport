require('dotenv').config();
const { Pinecone } = require('@pinecone-database/pinecone');

// Index name to create
const INDEX_NAME = 'voice-agents-kb';
// Dimension of OpenAI embeddings (text-embedding-ada-002 is 1536)
const DIMENSION = 1536;

async function createPineconeIndex() {
  try {
    // Initialize the Pinecone client
    const pc = new Pinecone({
      apiKey: process.env.PINECONE_API_KEY,
    });

    console.log(`Creating new Pinecone index: ${INDEX_NAME}...`);
    
    // Create the index
    const createRequest = {
      name: INDEX_NAME,
      dimension: DIMENSION,
      metric: 'cosine',
      spec: {
        serverless: {
          cloud: 'gcp',
          region: 'gcp-starter'
        }
      }
    };
    
    console.log('Request:', JSON.stringify(createRequest, null, 2));
    
    await pc.createIndex(createRequest);

    console.log('Index creation initiated. It may take a few minutes to become ready.');
    console.log('\nAfter the index is ready, update your .env file:');
    console.log(`PINECONE_INDEX_NAME=${INDEX_NAME}`);
    
  } catch (error) {
    console.error('Error creating Pinecone index:', error);
    console.log('\nSince we encountered issues with the Pinecone API, please:');
    console.log('1. Visit https://app.pinecone.io/ and create an index manually');
    console.log('2. Set the dimension to 1536 (for OpenAI embeddings)');
    console.log('3. Once created, add the index name to your .env file:');
    console.log(`PINECONE_INDEX_NAME=your_index_name`);
  }
}

createPineconeIndex(); 