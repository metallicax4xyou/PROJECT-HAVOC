// utils/tickCache.js
const NodeCache = require('node-cache');
const logger = require('./logger'); // Assuming logger is available globally

// --- Configuration ---
// Consider moving TTL to the main config file later
const CACHE_TTL_SECONDS = process.env.TICK_CACHE_TTL_SECONDS ? parseInt(process.env.TICK_CACHE_TTL_SECONDS, 10) : 15; // Default 15 seconds TTL
const LOG_STATS_INTERVAL = 60000; // Log cache stats every 60 seconds (adjust as needed)

class TickCache {
  constructor() {
    if (isNaN(CACHE_TTL_SECONDS) || CACHE_TTL_SECONDS <= 0) {
        logger.warn(`[TickCache] Invalid CACHE_TTL_SECONDS (${process.env.TICK_CACHE_TTL_SECONDS}). Defaulting to 15.`);
        this.ttl = 15;
    } else {
        this.ttl = CACHE_TTL_SECONDS;
    }

    this.cache = new NodeCache({
      stdTTL: this.ttl,
      checkperiod: Math.max(1, Math.floor(this.ttl * 0.2)), // Check roughly every 20% of TTL
      useClones: false, // Important for performance, avoids deep cloning objects
      deleteOnExpire: true
    });

    this.stats = { hits: 0, misses: 0, sets: 0, errors: 0 };
    this.logInterval = null;

    logger.info(`[TickCache] Initialized with TTL: ${this.ttl}s`);
    this._startLogging();
  }

  _getTickKey(poolAddress, wordPos) {
    // Consistent key structure
    return `${poolAddress}:${wordPos}`;
  }

  /**
   * Gets ticks for a specific pool and word position, using cache if available.
   * If ticks are not cached, it calls the provided async fetch function.
   * @param {string} poolAddress The checksummed pool address.
   * @param {number} wordPos The word position integer.
   * @param {Function} fetchFn An async function responsible for fetching and *processing* the ticks if not cached.
   *                           It should return `Array<{tick: number, liquidityNet: bigint}>` on success, or `null` on failure.
   * @returns {Promise<Array<{tick: number, liquidityNet: bigint}> | null>} The cached or fetched tick data, or null if fetch failed.
   */
  async getTicks(poolAddress, wordPos, fetchFn) {
    const key = this._getTickKey(poolAddress, wordPos);
    const cachedTicks = this.cache.get(key);

    if (cachedTicks !== undefined) {
      this.stats.hits++;
      logger.debug(`[TickCache] HIT for key: ${key} (Retrieved ${cachedTicks?.length ?? 0} items)`);
      return cachedTicks; // Return the exact cached array (could be empty array)
    } else {
      this.stats.misses++;
      logger.debug(`[TickCache] MISS for key: ${key}. Fetching...`);
      try {
        const fetchedTicks = await fetchFn(); // Expect fetchFn to return processed array or null

        // Only cache if fetchFn returned a valid array (even an empty one is valid)
        if (fetchedTicks !== null && Array.isArray(fetchedTicks)) {
             this.cache.set(key, fetchedTicks);
             this.stats.sets++;
             logger.debug(`[TickCache] SET cache for key: ${key} with ${fetchedTicks.length} items.`);
             return fetchedTicks;
        } else {
             logger.warn(`[TickCache] Fetch function for key ${key} returned null or non-array. Not caching.`);
             return fetchedTicks; // Return null or whatever fetchFn gave
        }
      } catch (error) {
        this.stats.errors++;
        logger.error(`[TickCache] Error executing fetchFn for key ${key}: ${error.message}`, error);
        return null; // Indicate fetch error
      }
    }
  }

  logStats() {
      const total = this.stats.hits + this.stats.misses;
      if (total > 0) {
          const hitRate = ((this.stats.hits / total) * 100).toFixed(1);
          logger.info(`[TickCache Stats] Hits: ${this.stats.hits}, Misses: ${this.stats.misses}, Sets: ${this.stats.sets}, Errors: ${this.stats.errors}, Hit Rate: ${hitRate}%`);
      } else {
          logger.info(`[TickCache Stats] No cache activity recorded yet.`);
      }
      // Optional: Log detailed cache stats from node-cache itself
      // logger.debug('[TickCache Detailed Stats]', this.cache.getStats());
  }

  _startLogging() {
      if (this.logInterval) clearInterval(this.logInterval);
      this.logInterval = setInterval(() => this.logStats(), LOG_STATS_INTERVAL);
      logger.info(`[TickCache] Periodic stats logging enabled (Interval: ${LOG_STATS_INTERVAL / 1000}s).`);
  }

  stopLogging() {
       if (this.logInterval) {
            clearInterval(this.logInterval);
            this.logInterval = null;
            logger.info('[TickCache] Periodic stats logging stopped.');
       }
  }

  // Optional: Method to clear cache if needed for testing or state reset
  flush() {
      this.cache.flushAll();
      this.stats = { hits: 0, misses: 0, sets: 0, errors: 0 }; // Reset stats too
      logger.info('[TickCache] Cache flushed.');
  }
}

// Export a singleton instance so all DataProviders use the same cache
module.exports = new TickCache();
