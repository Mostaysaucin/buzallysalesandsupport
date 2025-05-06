require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const { v4: uuidv4 } = require('uuid');
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

const index = pinecone.index(process.env.PINECONE_INDEX_NAME);
const baseUrl = 'https://www.businessesalliance.com';
const visitedUrls = new Set();
const maxPages = 50; // Limit to prevent infinite crawling
let pageCount = 0;

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
 * Store content in Pinecone
 * @param {string} url - Source URL
 * @param {string} title - Page title
 * @param {string} content - Page content
 */
async function storeInPinecone(url, title, content) {
  try {
    if (!content.trim()) {
      console.log(`Skipping empty content from ${url}`);
      return;
    }
    
    // Chunk content if it's too long (OpenAI has token limits)
    const chunks = chunkText(content, 1000);
    console.log(`Storing ${chunks.length} chunks from: ${url}`);
    
    const vectorsToUpsert = [];
    
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = await generateEmbedding(chunk);
      const id = uuidv4();
      
      vectorsToUpsert.push({
        id,
        values: embedding,
        metadata: {
          url,
          title,
          text: chunk,
          chunk: i + 1,
          totalChunks: chunks.length,
          source: 'businessesalliance.com',
          createdAt: new Date().toISOString(),
        },
      });
    }
    
    if (vectorsToUpsert.length > 0) {
        // Upsert expects an array of vectors
        await index.upsert(vectorsToUpsert);
        console.log(`✅ Stored ${vectorsToUpsert.length} chunks from ${url}`);
    } else {
        console.log(`No valid chunks found for ${url}`);
    }

  } catch (error) {
    console.error(`Error storing content from ${url}:`, error);
  }
}

/**
 * Split text into smaller chunks
 * @param {string} text - Text to split
 * @param {number} maxChars - Maximum characters per chunk
 * @returns {Array<string>} - Array of text chunks
 */
function chunkText(text, maxChars) {
  const chunks = [];
  const words = text.split(' ');
  let currentChunk = '';
  
  for (const word of words) {
    if ((currentChunk + ' ' + word).length <= maxChars) {
      currentChunk += (currentChunk ? ' ' : '') + word;
    } else {
      chunks.push(currentChunk);
      currentChunk = word;
    }
  }
  
  if (currentChunk) {
    chunks.push(currentChunk);
  }
  
  return chunks;
}

/**
 * Extract clean text content from HTML
 * @param {CheerioStatic} $ - Loaded Cheerio object
 * @returns {string} - Cleaned text
 */
function extractContent($) {
  // Remove elements that typically don't contain useful text
  $('script, style, nav, footer, header, aside, [role=banner], [role=navigation], .menu, .footer, .header, .navigation, .sidebar, .ad, .advertisement').remove();
  
  // Get the main content
  let content = '';
  
  // Try to find main content containers
  const mainContent = $('main, [role=main], article, .content, .main, .article, .post');
  
  if (mainContent.length) {
    content = mainContent.text();
  } else {
    // Fallback to body content
    content = $('body').text();
  }
  
  // Clean up the text
  return content
    .replace(/\\s+/g, ' ') // Replace multiple whitespace with single space
    .replace(/\\n+/g, ' ') // Replace newlines with space
    .trim();
}

/**
 * Extract all links from a page
 * @param {string} url - URL to scrape
 * @param {CheerioStatic} $ - Loaded Cheerio object
 * @returns {Array<string>} - Array of URLs
 */
function extractLinks($, baseUrl) {
  const links = new Set();
  
  $('a').each((_, element) => {
    const href = $(element).attr('href');
    if (href) {
      // Convert relative URLs to absolute
      let absoluteUrl;
      try {
        absoluteUrl = new URL(href, baseUrl).href;
      } catch (e) {
        return; // Invalid URL
      }
      
      // Only include links from the same domain
      if (absoluteUrl.startsWith(baseUrl)) {
        // Remove hash and query params
        const cleanUrl = absoluteUrl.split('#')[0].split('?')[0];
        if (cleanUrl !== baseUrl + '/') {
          links.add(cleanUrl);
        }
      }
    }
  });
  
  return Array.from(links);
}

/**
 * Scrape a single page
 * @param {string} url - URL to scrape
 */
async function scrapePage(url) {
  if (visitedUrls.has(url) || pageCount >= maxPages) {
    return;
  }
  
  visitedUrls.add(url);
  pageCount++;
  
  try {
    console.log(`Scraping page ${pageCount}/${maxPages}: ${url}`);
    
    const response = await axios.get(url);
    const $ = cheerio.load(response.data);
    
    // Get page title and content
    const title = $('title').text().trim();
    const content = extractContent($);
    
    // Store in Pinecone
    await storeInPinecone(url, title, content);
    
    // Find and follow links
    const links = extractLinks($, baseUrl);
    
    // Process each link (with delay to avoid rate limiting)
    for (const link of links) {
      if (!visitedUrls.has(link) && pageCount < maxPages) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second delay
        await scrapePage(link);
      }
    }
  } catch (error) {
    console.error(`Error scraping ${url}:`, error.message);
  }
}

/**
 * Main function to start scraping
 */
async function scrapeWebsite() {
  try {
    console.log(`Starting to scrape ${baseUrl}`);
    console.log(`Will store data in Pinecone index: ${process.env.PINECONE_INDEX_NAME}`);
    
    // First check if Pinecone is accessible
    const indexesList = await pinecone.listIndexes();
    const indexExists = indexesList && indexesList.indexes && indexesList.indexes.some(idx => idx.name === process.env.PINECONE_INDEX_NAME);
    
    if (!indexExists) {
      console.error(`Index '${process.env.PINECONE_INDEX_NAME}' does not exist! Please create it first.`);
      return;
    }
    
    console.log('Pinecone index is accessible. Starting the scraping process...');
    
    // Install required packages if not already installed
    try {
      require('cheerio');
      require('uuid');
    } catch (e) {
      console.log('Installing required packages...');
      const { execSync } = require('child_process');
      execSync('npm install --save cheerio uuid', { stdio: 'inherit' });
      console.log('Packages installed successfully.');
    }
    
    // Start scraping from the homepage
    await scrapePage(baseUrl);
    
    console.log(`Scraping completed! Processed ${pageCount} pages.`);
    console.log(`Content stored in Pinecone index: ${process.env.PINECONE_INDEX_NAME}`);
  } catch (error) {
    console.error('Error during website scraping:', error);
  }
}

// Run the scraper
scrapeWebsite().catch(error => {
  console.error('Unhandled error during scraping:', error);
}); 