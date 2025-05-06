import Redis from 'ioredis';
import fs from 'fs';

// Debug logging function
function debugLog(message) {
    const logMessage = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync('worker_debug.log', logMessage);
    console.log(logMessage.trim());
}

/**
 * Redis-based token bucket rate limiter
 * Implements a distributed rate limiting mechanism
 */
export class RateLimiter {
  constructor(options = {}) {
    this.redis = options.redis || new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD,
      tls: process.env.REDIS_TLS === 'true' ? {} : undefined
    });
    this.namespace = options.namespace || 'ratelimit';
    this.maxTokens = options.maxTokens || 100;
    this.refillRate = options.refillRate || 10; // tokens per second
    this.refillInterval = options.refillInterval || 1000; // ms
  }

  async consume(key, tokens = 1) {
    const bucketKey = `${this.namespace}:${key}`;
    const now = Date.now();
    
    const luaScript = `
      local bucket = redis.call('hmget', KEYS[1], 'tokens', 'lastRefill')
      local tokens = tonumber(bucket[1]) or tonumber(ARGV[1])
      local lastRefill = tonumber(bucket[2]) or tonumber(ARGV[3])
      local now = tonumber(ARGV[3])
      local refillRate = tonumber(ARGV[4])
      local interval = tonumber(ARGV[5])
      
      -- Calculate tokens to add based on time elapsed
      local timePassed = math.max(0, now - lastRefill)
      local intervalsElapsed = math.floor(timePassed / interval)
      local tokensToAdd = math.min(
        intervalsElapsed * refillRate,
        tonumber(ARGV[1]) - tokens
      )
      
      tokens = math.min(tokens + tokensToAdd, tonumber(ARGV[1]))
      
      -- Update last refill time if tokens were added
      if tokensToAdd > 0 then
        lastRefill = lastRefill + (intervalsElapsed * interval)
      end
      
      -- Attempt to consume tokens
      local allowed = 0
      if tokens >= tonumber(ARGV[2]) then
        tokens = tokens - tonumber(ARGV[2])
        allowed = 1
      end
      
      -- Update bucket
      redis.call('hmset', KEYS[1], 'tokens', tokens, 'lastRefill', lastRefill)
      
      return allowed
    `;
    
    try {
      const result = await this.redis.eval(
        luaScript,
        1,
        bucketKey,
        this.maxTokens,
        tokens,
        now,
        this.refillRate,
        this.refillInterval
      );
      
      return result === 1;
    } catch (error) {
      debugLog(`Rate limiter error: ${error.message}`);
      // In case of Redis failure, default to allowing the operation
      return true;
    }
  }
  
  /**
   * Check if operation would be rate limited without consuming a token
   */
  async would_limit(key, tokens = 1) {
    const bucketKey = `${this.namespace}:${key}`;
    
    try {
      const bucket = await this.redis.hmget(bucketKey, 'tokens', 'lastRefill');
      let currentTokens = parseInt(bucket[0]) || this.maxTokens;
      const lastRefill = parseInt(bucket[1]) || Date.now();
      
      // Calculate token refill based on time elapsed
      const now = Date.now();
      const timePassed = Math.max(0, now - lastRefill);
      const intervalsElapsed = Math.floor(timePassed / this.refillInterval);
      const tokensToAdd = Math.min(
        intervalsElapsed * this.refillRate,
        this.maxTokens - currentTokens
      );
      
      currentTokens = Math.min(currentTokens + tokensToAdd, this.maxTokens);
      
      return currentTokens < tokens;
    } catch (error) {
      debugLog(`Rate limiter check error: ${error.message}`);
      // In case of Redis failure, default to not limiting
      return false;
    }
  }
  
  /**
   * Get current token count for a key
   */
  async getTokens(key) {
    const bucketKey = `${this.namespace}:${key}`;
    
    try {
      const bucket = await this.redis.hmget(bucketKey, 'tokens', 'lastRefill');
      let currentTokens = parseInt(bucket[0]) || this.maxTokens;
      const lastRefill = parseInt(bucket[1]) || Date.now();
      
      // Calculate token refill based on time elapsed
      const now = Date.now();
      const timePassed = Math.max(0, now - lastRefill);
      const intervalsElapsed = Math.floor(timePassed / this.refillInterval);
      const tokensToAdd = Math.min(
        intervalsElapsed * this.refillRate,
        this.maxTokens - currentTokens
      );
      
      currentTokens = Math.min(currentTokens + tokensToAdd, this.maxTokens);
      
      return currentTokens;
    } catch (error) {
      debugLog(`Rate limiter get tokens error: ${error.message}`);
      return this.maxTokens;
    }
  }
}

// Pre-configured rate limiters for different services
export const twilioRateLimiter = new RateLimiter({
  namespace: 'twilio',
  maxTokens: 100,  // Maximum of 100 concurrent requests
  refillRate: 5     // Add 5 tokens per second (adjust based on Twilio limits)
});

export const elevenLabsRateLimiter = new RateLimiter({
  namespace: 'elevenlabs',
  maxTokens: 50,    // Maximum of 50 concurrent requests
  refillRate: 3     // Add 3 tokens per second (adjust based on ElevenLabs limits)
});

// Circuit breaker implementation to prevent cascading failures
export class CircuitBreaker {
  constructor(options = {}) {
    this.redis = options.redis || new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD,
      tls: process.env.REDIS_TLS === 'true' ? {} : undefined
    });
    this.namespace = options.namespace || 'circuit';
    this.failureThreshold = options.failureThreshold || 5;
    this.resetTimeout = options.resetTimeout || 30000; // 30 seconds
  }
  
  // Check if circuit is open (failures exceeded threshold)
  async isOpen(key) {
    const circuitKey = `${this.namespace}:${key}`;
    
    try {
      const data = await this.redis.hgetall(circuitKey);
      
      if (!data.status) {
        return false;
      }
      
      if (data.status === 'open') {
        // Check if reset timeout has passed
        const openTime = parseInt(data.openTime || 0);
        const now = Date.now();
        
        if (now - openTime > this.resetTimeout) {
          // Reset to half-open state
          await this.redis.hset(circuitKey, 'status', 'half-open');
          return false;
        }
        
        return true;
      }
      
      return false;
    } catch (error) {
      debugLog(`Circuit breaker error: ${error.message}`);
      return false;
    }
  }
  
  // Record a failure
  async recordFailure(key) {
    const circuitKey = `${this.namespace}:${key}`;
    
    try {
      // Get current circuit state
      const data = await this.redis.hgetall(circuitKey);
      const failures = parseInt(data.failures || 0) + 1;
      
      // Update failure count
      await this.redis.hset(circuitKey, 'failures', failures);
      
      // If failures exceed threshold, open the circuit
      if (failures >= this.failureThreshold) {
        await this.redis.hmset(circuitKey, {
          status: 'open',
          openTime: Date.now()
        });
        
        debugLog(`Circuit breaker opened for ${key} after ${failures} failures`);
      }
    } catch (error) {
      debugLog(`Circuit breaker failure recording error: ${error.message}`);
    }
  }
  
  // Record a success
  async recordSuccess(key) {
    const circuitKey = `${this.namespace}:${key}`;
    
    try {
      const data = await this.redis.hgetall(circuitKey);
      
      // If in half-open state, reset to closed
      if (data.status === 'half-open') {
        await this.redis.hmset(circuitKey, {
          status: 'closed',
          failures: 0
        });
        
        debugLog(`Circuit breaker closed for ${key} after successful operation`);
      } else if (data.status === 'closed') {
        // Reset failure count
        await this.redis.hset(circuitKey, 'failures', 0);
      }
    } catch (error) {
      debugLog(`Circuit breaker success recording error: ${error.message}`);
    }
  }
  
  // Reset circuit to closed state
  async reset(key) {
    const circuitKey = `${this.namespace}:${key}`;
    
    try {
      await this.redis.hmset(circuitKey, {
        status: 'closed',
        failures: 0
      });
      
      debugLog(`Circuit breaker manually reset for ${key}`);
    } catch (error) {
      debugLog(`Circuit breaker reset error: ${error.message}`);
    }
  }
}

// Pre-configured circuit breakers for different services
export const twilioCircuitBreaker = new CircuitBreaker({
  namespace: 'twilio-circuit',
  failureThreshold: 5,
  resetTimeout: 60000 // 1 minute
});

export const elevenLabsCircuitBreaker = new CircuitBreaker({
  namespace: 'elevenlabs-circuit',
  failureThreshold: 3,
  resetTimeout: 45000 // 45 seconds
}); 