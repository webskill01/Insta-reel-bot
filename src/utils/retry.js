const logger = require('./logger');

/**
 * Retries an async function with exponential backoff.
 * @param {Function} fn - async function to retry
 * @param {Object} opts
 * @param {number} opts.maxRetries - default 3
 * @param {number} opts.baseDelay - initial delay in ms, default 2000
 * @param {number} opts.maxDelay - cap on delay in ms, default 30000
 * @param {number} opts.factor - multiplier, default 2
 * @param {string} opts.label - for logging
 * @returns {Promise<any>}
 */
async function withRetry(fn, opts = {}) {
  const {
    maxRetries = 3,
    baseDelay = 2000,
    maxDelay = 30000,
    factor = 2,
    label = 'operation',
  } = opts;

  let lastError;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;

      if (attempt > maxRetries) {
        logger.error(`${label}: all ${maxRetries} retries exhausted`, {
          error: err.message,
        });
        throw err;
      }

      const delay = Math.min(baseDelay * Math.pow(factor, attempt - 1), maxDelay);
      logger.warn(`${label}: attempt ${attempt} failed, retrying in ${delay}ms`, {
        error: err.message,
      });

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

module.exports = { withRetry };
