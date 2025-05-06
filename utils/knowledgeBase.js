const { Pinecone } = require('@pinecone-database/pinecone');
const { OpenAI } = require('openai');
const logger = require('./logger');

// Initialize OpenAI client for embeddings
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Initialize Pinecone client with newer SDK
const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY,
});

// Get reference to the index
const index = pinecone.index(process.env.PINECONE_INDEX_NAME);

/**
 * Generate embeddings for text using OpenAI
 * @param {string} text - Text to generate embeddings for
 * @returns {Promise<Array<number>>} - Vector embedding
 */
async function generateEmbedding(text) {
  try {
    const response = await openai.embeddings.create({
      model: 'text-embedding-ada-002',
      input: text,
    });
    return response.data[0].embedding;
  } catch (error) {
    logger.error('Error generating embedding:', error);
    throw error;
  }
}

/**
 * Store information in the knowledge base
 * @param {string} id - Unique identifier for the record
 * @param {string} text - Text content to store
 * @param {Object} metadata - Additional metadata for context
 * @returns {Promise<Object>} - Result of the upsert operation
 */
async function storeInKnowledgeBase(id, text, metadata) {
  try {
    const embedding = await generateEmbedding(text);
    const result = await index.upsert({
      vectors: [
        {
          id,
          values: embedding,
          metadata: {
            text,
            ...metadata,
          },
        },
      ],
    });
    logger.info(`Stored item ${id} in knowledge base`);
    return result;
  } catch (error) {
    logger.error('Error storing in knowledge base:', error);
    throw error;
  }
}

/**
 * Query the knowledge base for relevant information
 * @param {string} query - Text query to find relevant information
 * @param {number} topK - Number of results to return
 * @param {Object} filter - Optional metadata filter
 * @returns {Promise<Array<Object>>} - Matched records with scores
 */
async function queryKnowledgeBase(query, topK = 5, filter = {}) {
  try {
    const queryEmbedding = await generateEmbedding(query);
    const results = await index.query({
      vector: queryEmbedding,
      topK,
      includeMetadata: true,
      filter,
    });
    
    logger.info(`Found ${results.matches.length} matches for query`);
    return results.matches.map(match => ({
      id: match.id,
      score: match.score,
      text: match.metadata.text,
      metadata: match.metadata,
    }));
  } catch (error) {
    logger.error('Error querying knowledge base:', error);
    throw error;
  }
}

/**
 * Delete an item from the knowledge base
 * @param {string} id - ID of the item to delete
 * @returns {Promise<Object>} - Result of the delete operation
 */
async function deleteFromKnowledgeBase(id) {
  try {
    const result = await index.delete({
      ids: [id],
    });
    logger.info(`Deleted item ${id} from knowledge base`);
    return result;
  } catch (error) {
    logger.error('Error deleting from knowledge base:', error);
    throw error;
  }
}

module.exports = {
  storeInKnowledgeBase,
  queryKnowledgeBase,
  deleteFromKnowledgeBase,
  generateEmbedding,
}; 