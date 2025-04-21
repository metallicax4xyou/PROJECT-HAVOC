// core/poolScanner.js
const logger = require('../utils/logger');
const { getProvider } = require('../utils/provider');
const { getCanonicalPairKey } = require('../utils/pairUtils');
const { safeFetchWrapper } = require('../utils/networkUtils'); // Assuming you created this

class PoolScanner {
  constructor(config) {
    this.config = config;
    this.provider = getProvider(config.NETWORK_RPC_URL); // Assuming getProvider handles caching/singleton
    this.fetchers = {};
    this.pairRegistry = new Map(); // Map<canonicalPairKey, Set<poolAddress>>

    logger.info('[PoolScanner] Initializing PoolScanner fetchers...');

    // --- Fetcher Initialization & DEBUG ---
    if (config.UNISWAP_V3_ENABLED) {
      try {
        // Use path confirmed by 'tree' command
        const UniswapV3Fetcher = require('./fetchers/uniswapV3Fetcher');
        const key = 'uniswapV3';
        this.fetchers[key] = new UniswapV3Fetcher(config);
        logger.debug(`[PoolScanner] Initialized fetcher: Key='${key}', Constructor=${this.fetchers[key]?.constructor?.name || 'Unknown'}`);
      } catch (e) {
        logger.error(`[PoolScanner] Failed to initialize UniswapV3Fetcher: ${e.message}`, e.stack);
      }
    } else {
        logger.info('[PoolScanner] Uniswap V3 fetcher disabled by config.');
    }

    if (config.SUSHISWAP_ENABLED) {
      try {
        // Use path confirmed by 'tree' command
        const SushiSwapFetcher = require('./fetchers/sushiSwapFetcher');
        const key = 'sushiswap';
        this.fetchers[key] = new SushiSwapFetcher(config);
        logger.debug(`[PoolScanner] Initialized fetcher: Key='${key}', Constructor=${this.fetchers[key]?.constructor?.name || 'Unknown'}`);
      } catch (e) {
        logger.error(`[PoolScanner] Failed to initialize SushiSwapFetcher: ${e.message}`, e.stack);
      }
    } else {
        logger.info('[PoolScanner] SushiSwap fetcher disabled by config.');
    }

    if (config.DODO_ENABLED) {
      try {
        // Use path confirmed by 'tree' command
        const DodoFetcher = require('./fetchers/dodoFetcher');
        const key = 'dodo';
        this.fetchers[key] = new DodoFetcher(config);
        logger.debug(`[PoolScanner] Initialized fetcher: Key='${key}', Constructor=${this.fetchers[key]?.constructor?.name || 'Unknown'}`);
      } catch (e) {
        logger.error(`[PoolScanner] Failed to initialize DodoFetcher: ${e.message}`, e.stack);
      }
    } else {
        logger.info('[PoolScanner] DODO fetcher disabled by config.');
    }

    // Add other DEXs here if needed, e.g., Camelot
    // if (config.CAMELOT_ENABLED) { ... }

    // --- Final DEBUG Check ---
    const fetcherKeys = Object.keys(this.fetchers);
    logger.debug(`[PoolScanner] Available fetcher keys after initialization attempt: [${fetcherKeys.map(k => `'${k}'`).join(', ')}]`);
    logger.debug(`[PoolScanner] Total fetchers successfully initialized: ${fetcherKeys.length}`);
    if (fetcherKeys.length === 0) {
        logger.warn('[PoolScanner] WARNING: No fetchers were successfully initialized! Check DEX enable flags (e.g., UNISWAP_V3_ENABLED=true in .env or config) and ensure fetcher files exist and have no syntax errors.');
    }
    // --- End DEBUG ---

    logger.info('[PoolScanner] PoolScanner fetcher initialization complete.');
  }

  async fetchPoolStates() {
    const configuredPools = this.config.POOL_CONFIGS || [];
    logger.info(`[PoolScanner] Starting fetchPoolStates for ${configuredPools.length} configured pools.`);
    const fetchPromises = [];
    this.pairRegistry.clear(); // Clear registry for this cycle

    const poolProcessingStartTime = Date.now();

    // Pre-check if any fetchers are available
    if (Object.keys(this.fetchers).length === 0) {
        logger.error("[PoolScanner] No fetchers are available. Cannot fetch pool states. Check initialization logs.");
        return { poolStates: [], pairRegistry: this.pairRegistry };
    }

    let poolsToFetchCount = 0;
    for (const poolInfo of configuredPools) {

      // Basic validation of poolInfo object
      if (!poolInfo || !poolInfo.address || !poolInfo.pair || !Array.isArray(poolInfo.pair) || poolInfo.pair.length !== 2 || !poolInfo.dexType) {
          logger.warn(`[PoolScanner] Skipping malformed pool configuration: ${JSON.stringify(poolInfo)}`);
          continue;
      }

      const { address, pair, dexType } = poolInfo;
      const fetcherInstance = this.fetchers[dexType]; // Lookup fetcher using dexType string

      // Build Pair Registry regardless of whether fetcher exists (SpatialFinder needs all configured pools)
      try {
        const canonicalKey = getCanonicalPairKey(pair[0], pair[1]);
        if (!this.pairRegistry.has(canonicalKey)) {
          this.pairRegistry.set(canonicalKey, new Set());
        }
        this.pairRegistry.get(canonicalKey).add(address); // Store pool address
      } catch (error) {
          logger.error(`[PoolScanner] Error building pair registry for ${pair.join('/')} (${address}): ${error.message}`);
          // Continue processing other pools
      }


      if (fetcherInstance) {
        // Ensure fetcher has the required method
        if (typeof fetcherInstance.fetchPoolData !== 'function') {
             logger.error(`[PoolScanner] Fetcher for dexType '${dexType}' (${fetcherInstance.constructor.name}) is missing the 'fetchPoolData' method. Skipping pool ${pair.join('/')} (${address}).`);
             continue; // Skip this pool
        }

        logger.debug(`[PoolScanner] Queueing fetch for ${pair.join('/')} on ${dexType} (${address}). Fetcher: ${fetcherInstance.constructor.name}`);
        poolsToFetchCount++;
        // Wrap the fetch call with retry logic using safeFetchWrapper
        fetchPromises.push(
          safeFetchWrapper(
            () => fetcherInstance.fetchPoolData(address, pair), // Pass necessary args
            `Pool ${pair.join('/')} (${dexType}, ${address})`, // Unique identifier for logging
            this.config.RPC_RETRIES,
            this.config.RPC_RETRY_DELAY_MS
          ).catch(err => {
             // Catch errors from safeFetchWrapper itself (e.g., max retries exceeded)
             // Return a structured error object so Promise.allSettled can handle it
             logger.error(`[PoolScanner] safeFetchWrapper failed for ${pair.join('/')} (${dexType}) after retries: ${err.message}`);
             return { status: 'rejected', reason: err }; // Mimic Promise.allSettled structure
          })
        );
      } else {
        // This is the core problem we are debugging - log detailed info
        logger.warn(`[PoolScanner] No fetcher instance found for dexType '${dexType}' defined in pool config for ${pair.join('/')} (${address}). Skipping fetch for this pool.`);
        // Log available fetcher keys again for context at the point of failure
        const availableKeys = Object.keys(this.fetchers);
        logger.debug(`[PoolScanner] Available fetcher keys at time of lookup: [${availableKeys.map(k => `'${k}'`).join(', ')}]`);
        if (availableKeys.length === 0) {
             logger.warn(`[PoolScanner] Reminder: No fetchers were initialized at all.`);
        }
      }
    } // End of loop through pool configs

    const poolProcessingEndTime = Date.now();
    logger.debug(`[PoolScanner] Pool config processing and promise creation took ${poolProcessingEndTime - poolProcessingStartTime}ms.`);


    if (fetchPromises.length === 0) {
        if (configuredPools.length > 0) {
             logger.warn("[PoolScanner] No fetch promises were created, likely due to dexType mismatches or missing fetcher implementations for all configured pools. Check previous logs.");
        } else {
             logger.warn("[PoolScanner] No pools configured in POOL_CONFIGS. Nothing to fetch.");
        }
        // Return empty states but the potentially populated registry
        return { poolStates: [], pairRegistry: this.pairRegistry };
    }

    logger.info(`[PoolScanner] Attempting to fetch data for ${fetchPromises.length} pools (out of ${configuredPools.length} configured) concurrently...`);
    const fetchStartTime = Date.now();

    // Using Promise.allSettled to handle both successful and failed fetches
    const results = await Promise.allSettled(fetchPromises);

    const fetchEndTime = Date.now();
    logger.info(`[PoolScanner] Raw pool data fetching finished in ${fetchEndTime - fetchStartTime}ms.`);

    const poolStates = [];
    let successfulFetches = 0;
    let failedFetches = 0;
    let poolsSkippedByFetcher = 0; // Count pools where fetch succeeded but returned no data

    // Process results more carefully
    results.forEach((result, index) => {
        // Find corresponding poolInfo. Need a reliable way if filtering occurred.
        // Assuming the order of fetchPromises matches the order of pools *that had a fetcher*.
        // Let's rebuild the list of pools actually attempted
        const attemptedPools = configuredPools.filter(p => this.fetchers[p.dexType] && typeof this.fetchers[p.dexType].fetchPoolData === 'function');
        const poolInfo = attemptedPools[index]; // Get the pool info for the corresponding promise

         if (!poolInfo) {
            logger.error(`[PoolScanner] CRITICAL: Mismatch between promise results and pool info at index ${index}. Cannot process result: ${JSON.stringify(result)}`);
            failedFetches++; // Count this as a failure
            return; // Skip this result
         }

        const poolDesc = `${poolInfo.pair.join('/')} on ${poolInfo.dexType} (${poolInfo.address})`;

        if (result.status === 'fulfilled') {
            const fetcherResult = result.value;
            // Check the structure returned by fetchPoolData (assuming { success: boolean, poolData: object|null, error: string|null })
            if (fetcherResult && fetcherResult.success && fetcherResult.poolData) {
                poolStates.push(fetcherResult.poolData);
                successfulFetches++;
                logger.debug(`[PoolScanner] Successfully processed fetched state for ${poolDesc}`);
            } else if (fetcherResult && !fetcherResult.success) {
                // Fetch technically succeeded but fetcher reported failure (e.g., pool not found, RPC error handled internally)
                poolsSkippedByFetcher++;
                const reason = fetcherResult.error || 'Fetcher reported failure without specific error';
                logger.warn(`[PoolScanner] Fetcher reported failure for ${poolDesc}. Reason: ${reason}`);
            } else {
                // Fetch succeeded but returned unexpected value (null, undefined, missing fields)
                poolsSkippedByFetcher++;
                logger.warn(`[PoolScanner] Fetch for ${poolDesc} succeeded but returned invalid data or indicated no pool data. Result: ${JSON.stringify(fetcherResult)}`);
            }
        } else { // status === 'rejected'
            failedFetches++;
            // Extract reason, which might be an Error object or the structured error from safeFetchWrapper's catch block
            const reason = result.reason instanceof Error ? result.reason.message : JSON.stringify(result.reason);
            logger.error(`[PoolScanner] Failed to fetch state for ${poolDesc} after retries. Reason: ${reason}`);
            // Log stack trace if available
            if (result.reason instanceof Error && result.reason.stack) {
                logger.debug(`[PoolScanner] Stack trace for ${poolDesc} failure: ${result.reason.stack}`);
            }
        }
    });

    logger.info(`[PoolScanner] Pool state fetching complete. Total Configured: ${configuredPools.length}, Fetch Attempts: ${fetchPromises.length}, Success: ${successfulFetches}, Failed (after retries): ${failedFetches}, Skipped/No Data by Fetcher: ${poolsSkippedByFetcher}`);
    logger.debug(`[PoolScanner] Final Pair Registry Size: ${this.pairRegistry.size}`);

    return { poolStates, pairRegistry: this.pairRegistry };
  }
}

module.exports = PoolScanner;
