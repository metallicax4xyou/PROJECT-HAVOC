// utils/networkUtils.js
const logger = require('./logger');

/**
 * Utility function to introduce a delay.
 * @param {number} ms - Milliseconds to wait.
 * @returns {Promise<void>}
 */
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Wraps an async function call with retry logic and exponential backoff.
 * @param {Function} fetchFn - The async function to call (should not take arguments directly, use closure if needed).
 * @param {string} identifier - A string identifying the operation for logging purposes (e.g., "Pool WETH/USDC (Uniswap)").
 * @param {number} maxRetries - Maximum number of retry attempts.
 * @param {number} initialDelayMs - Initial delay in milliseconds before the first retry.
 * @returns {Promise<any>} - Resolves with the result of fetchFn or rejects if all retries fail.
 */
async function safeFetchWrapper(fetchFn, identifier, maxRetries = 3, initialDelayMs = 1000) {
  let currentDelay = initialDelayMs;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      logger.debug(`[safeFetchWrapper] Attempt ${attempt}/${maxRetries + 1} for ${identifier}`);
      const result = await fetchFn();
      // If fetchFn completes successfully, return its result
      logger.debug(`[safeFetchWrapper] Success on attempt ${attempt} for ${identifier}`);
      return result;
    } catch (error) {
      logger.warn(`[safeFetchWrapper] Attempt ${attempt} failed for ${identifier}. Error: ${error.message}`);
      if (attempt > maxRetries) {
        // If this was the last attempt, throw the error
        logger.error(`[safeFetchWrapper] Max retries (${maxRetries}) reached for ${identifier}. Operation failed.`);
        // Re-throw the last error to be caught by the caller or Promise.allSettled
        throw new Error(`Operation '${identifier}' failed after ${maxRetries} retries: ${error.message}`);
      }

      // Calculate delay with exponential backoff (e.g., 1s, 2s, 4s, ...)
      // Add some jitter (randomness) to prevent thundering herd issues
      const jitter = Math.random() * currentDelay * 0.2; // +/- 10% jitter
      const waitTime = currentDelay + (Math.random() < 0.5 ? -jitter : jitter);

      logger.info(`[safeFetchWrapper] Retrying ${identifier} in ${(waitTime / 1000).toFixed(2)}s... (Attempt ${attempt + 1})`);
      await delay(waitTime);

      // Increase delay for the next potential retry
      currentDelay *= 2;
    }
  }
  // This part should theoretically not be reached due to the throw in the loop,
  // but included for completeness.
  throw new Error(`Operation '${identifier}' failed unexpectedly after all retries.`);
}

module.exports = {
  safeFetchWrapper,
  delay // Export delay if needed elsewhere, otherwise it can be kept private
};
