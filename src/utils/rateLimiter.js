const logger = require('./logger');

/**
 * Token bucket rate limiter for Instagram API calls.
 * Ensures we stay under 200 requests/hour (configured to 180 with buffer).
 */
class RateLimiter {
  constructor(opts = {}) {
    this.maxTokens = opts.maxTokens || 180;
    this.refillRate = opts.refillRate || 180;                // tokens per interval
    this.refillInterval = opts.refillInterval || 3600_000;   // 1 hour in ms
    this.tokens = this.maxTokens;
    this.lastRefill = Date.now();
    this._waitQueue = [];
  }

  _refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const tokensToAdd = Math.floor((elapsed / this.refillInterval) * this.refillRate);
    if (tokensToAdd > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
      this.lastRefill = now;
    }
  }

  /**
   * Waits until a token is available, then consumes one.
   */
  async acquire() {
    this._refill();

    if (this.tokens > 0) {
      this.tokens--;
      return;
    }

    // Calculate wait time until next token
    const waitMs = Math.ceil(this.refillInterval / this.refillRate);
    logger.warn(`Rate limiter: no tokens available, waiting ${waitMs}ms`);

    await new Promise(resolve => setTimeout(resolve, waitMs));
    this._refill();

    if (this.tokens > 0) {
      this.tokens--;
      return;
    }

    // Recursive wait if still no tokens (shouldn't happen often)
    return this.acquire();
  }

  get available() {
    this._refill();
    return this.tokens;
  }
}

module.exports = { RateLimiter };
