const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const knowledgeBase = require('../utils/knowledgeBase');
const { v4: uuidv4 } = require('uuid');

// Add an item to the knowledge base
router.post('/', async (req, res) => {
  try {
    const { text, type, metadata } = req.body;
    
    if (!text) {
      return res.status(400).json({ error: 'Text content is required' });
    }
    
    const id = uuidv4();
    const result = await knowledgeBase.storeInKnowledgeBase(id, text, {
      type: type || 'general',
      createdAt: new Date().toISOString(),
      ...metadata
    });
    
    logger.info(`Added item ${id} to knowledge base`);
    
    res.status(201).json({
      id,
      text,
      type,
      metadata,
      message: 'Item added to knowledge base'
    });
  } catch (error) {
    logger.error('Error adding item to knowledge base:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Query the knowledge base
router.get('/query', async (req, res) => {
  try {
    const { query, limit, filter } = req.query;
    
    if (!query) {
      return res.status(400).json({ error: 'Query parameter is required' });
    }
    
    const filterObj = filter ? JSON.parse(filter) : {};
    const results = await knowledgeBase.queryKnowledgeBase(
      query,
      parseInt(limit, 10) || 5,
      filterObj
    );
    
    logger.info(`Query "${query}" returned ${results.length} results`);
    
    res.status(200).json({
      query,
      results
    });
  } catch (error) {
    logger.error('Error querying knowledge base:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Delete an item from the knowledge base
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    if (!id) {
      return res.status(400).json({ error: 'Item ID is required' });
    }
    
    await knowledgeBase.deleteFromKnowledgeBase(id);
    
    logger.info(`Deleted item ${id} from knowledge base`);
    
    res.status(200).json({
      id,
      message: 'Item deleted from knowledge base'
    });
  } catch (error) {
    logger.error('Error deleting item from knowledge base:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Batch import items to the knowledge base
router.post('/batch', async (req, res) => {
  try {
    const { items } = req.body;
    
    if (!items || !Array.isArray(items)) {
      return res.status(400).json({ error: 'Items array is required' });
    }
    
    const results = [];
    const errors = [];
    
    // Process items sequentially to avoid overloading the API
    for (const item of items) {
      try {
        if (!item.text) {
          errors.push({ item, error: 'Text content is required' });
          continue;
        }
        
        const id = item.id || uuidv4();
        await knowledgeBase.storeInKnowledgeBase(id, item.text, {
          type: item.type || 'general',
          createdAt: new Date().toISOString(),
          ...item.metadata
        });
        
        results.push({
          id,
          status: 'success'
        });
      } catch (error) {
        logger.error(`Error processing batch item: ${error.message}`);
        errors.push({
          item,
          error: error.message
        });
      }
    }
    
    logger.info(`Batch import: ${results.length} succeeded, ${errors.length} failed`);
    
    res.status(207).json({
      succeeded: results.length,
      failed: errors.length,
      results,
      errors
    });
  } catch (error) {
    logger.error('Error in batch import:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

module.exports = router; 