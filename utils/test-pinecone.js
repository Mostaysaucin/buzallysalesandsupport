require('dotenv').config();
const { Pinecone } = require('@pinecone-database/pinecone');
const { OpenAI } = require('openai');
const logger = require('./logger');

// Initialize OpenAI client for embeddings
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Initialize Pinecone client
const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY,
});

const indexName = process.env.PINECONE_INDEX_NAME;

async function testPineconeConnection() {
  try {
    console.log(`Testing connection to Pinecone index: ${indexName}`);
    
    // Check if index exists
    const indexesList = await pinecone.listIndexes();
    
    // Check if the desired index name is in the list
    // The listIndexes method returns an object like { indexes: [...] }
    const indexExists = indexesList && indexesList.indexes && indexesList.indexes.some(index => index.name === indexName);
    
    if (!indexExists) {
      console.error(`Index '${indexName}' does not exist! Please create it first.`);
      return false;
    }
    
    console.log(`✅ Successfully connected to index: ${indexName}`);
    return true;
  } catch (error) {
    console.error('❌ Error connecting to Pinecone:', error);
    return false;
  }
}

async function testVectorOperations() {
  try {
    const index = pinecone.index(indexName);
    
    // Generate test embedding
    const testText = "This is a test embedding for voice agents system";
    console.log(`Generating embedding for text: "${testText}"`);
    
    const response = await openai.embeddings.create({
      model: 'text-embedding-ada-002',
      input: testText,
    });
    const embedding = response.data[0].embedding;
    
    // Create a test vector - note the structure change for upsert
    const testId = `test-${Date.now()}`;
    const testVector = {
      id: testId,
      values: embedding,
      metadata: {
        text: testText,
        source: 'test',
      },
    };
    
    console.log(`Upserting test vector with ID: ${testId}`);
    
    // Upsert expects an array of vectors
    await index.upsert([testVector]);
    
    // Add a longer delay to allow for indexing
    console.log('Waiting for index to update...');
    await new Promise(resolve => setTimeout(resolve, 10000)); // 10-second delay
    
    // Query the vector
    console.log('Querying the vector...');
    const queryResponse = await index.query({
      vector: embedding,
      topK: 1,
      includeMetadata: true,
    });
    
    if (queryResponse.matches && queryResponse.matches.length > 0 && queryResponse.matches[0].id === testId) {
      console.log('✅ Successfully queried the vector!');
      console.log('Query results:', JSON.stringify(queryResponse.matches[0], null, 2));
      
      // Delete the test vector
      console.log(`Deleting test vector with ID: ${testId}`);
      await index.deleteOne(testId);
      console.log('Waiting for delete to propagate...');
      await new Promise(resolve => setTimeout(resolve, 5000)); // 5-second delay after delete
      
      // Verify deletion
      const deleteCheckResponse = await index.fetch([testId]);
      // Check if the vectors object exists and is empty
      if (!deleteCheckResponse || !deleteCheckResponse.vectors || Object.keys(deleteCheckResponse.vectors).length === 0) {
          console.log('✅ Successfully verified deletion of the test vector!');
          return true;
      } else {
          console.error('❌ Failed to verify deletion of the test vector!');
          console.error('Fetch response after delete:', deleteCheckResponse);
          return false;
      }
      
    } else {
      console.error('❌ Query did not return the expected vector!');
      console.error('Query response:', queryResponse);
      return false;
    }
  } catch (error) {
    console.error('❌ Error performing vector operations:', error);
    return false;
  }
}

async function runTests() {
  console.log('=== PINECONE INTEGRATION TESTS ===');
  
  // Test connection
  const connectionSuccess = await testPineconeConnection();
  if (!connectionSuccess) {
    console.error('Connection test failed! Please check your Pinecone configuration.');
    return;
  }
  
  // Test vector operations
  const operationsSuccess = await testVectorOperations();
  if (!operationsSuccess) {
    console.error('Vector operations test failed! Please check your Pinecone and OpenAI configurations.');
    return;
  }
  
  console.log('✅ All tests passed! Your Pinecone integration is working correctly.');
}

runTests().catch(error => {
  console.error('Unhandled error during tests:', error);
}); 