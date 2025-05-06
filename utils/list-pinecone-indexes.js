require('dotenv').config();
const axios = require('axios');

async function listPineconeIndexes() {
  try {
    const response = await axios.get('https://api.pinecone.io/indexes', {
      headers: {
        'Api-Key': process.env.PINECONE_API_KEY
      }
    });

    console.log('Available Pinecone Indexes:');
    if (response.data && response.data.indexes) {
      response.data.indexes.forEach(index => {
        console.log(`- ${index.name}`);
      });
    } else {
      console.log('No indexes found');
    }
  } catch (error) {
    console.error('Error fetching Pinecone indexes:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
    }
  }
}

listPineconeIndexes(); 