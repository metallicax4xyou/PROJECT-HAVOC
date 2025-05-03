// core/poolScanner.js
// Scans configured pools and fetches their latest state.
// --- VERSION v1.3 --- Temporarily commented out DODO fetcher initialization for debugging.

const logger = require('../utils/logger');
const { getProvider } = require('../utils/provider');
const { getCanonicalPairKey } = require('../utils/pairUtils'); // Use '../' not '../../'
const { safeFetchWrapper } = require('../utils/networkUtils'); // Use '../'

class PoolScanner {
  constructor(config) {
    this.config = config;
    this.fetchers = {};
    this.pairRegistry = new Map();

    logger.info('[PoolScanner v1.3] Initializing PoolScanner fetchers...');

    // --- Fetcher Initialization ---
    if (config.UNISWAP_V3_ENABLED) {
      try {
        const UniswapV3Fetcher = require('./fetchers/uniswapV3Fetcher');
        const key = 'uniswapV3';
        this.fetchers[key] = new UniswapV3Fetcher(config);
        logger.debug(`[PoolScanner v1.3] Initialized fetcher: Key='${key}', Constructor=${this.fetchers[key]?.constructor?.name || 'Unknown'}`);
      } catch (e) {
          logger.error(`[PoolScanner v1.3] Failed to initialize UniswapV3Fetcher: ${e.message}`, e.stack);
          this.config.UNISWAP_V3_ENABLED = false; // Disable if init fails
          logger.warn(`[PoolScanner v1.3] Uniswap V3 fetching disabled due to initialization failure.`);
      }
    } else { logger.info('[PoolScanner v1.3] Uniswap V3 fetcher disabled by config.'); }

    if (config.SUSHISWAP_ENABLED) {
      try {
        const SushiSwapFetcher = require('./fetchers/sushiSwapFetcher');
        const key = 'sushiswap';
        this.fetchers[key] = new SushiSwapFetcher(config);
        logger.debug(`[PoolScanner v1.3] Initialized fetcher: Key='${key}', Constructor=${this.fetchers[key]?.constructor?.name || 'Unknown'}`);
      } catch (e) {
         logger.error(`[PoolScanner v1.3] Failed to initialize SushiSwapFetcher: ${e.message}`, e.stack);
         this.config.SUSHISWAP_ENABLED = false; // Disable if init fails
         logger.warn(`[PoolScanner v1.3] SushiSwap fetching disabled due to initialization failure.`);
      }
    } else { logger.info('[PoolScanner v1.3] SushiSwap fetcher disabled by config.'); }

    // --- DODO Fetcher Initialization (TEMPORARILY COMMENTED OUT) ---
    // To work on DODO, you'll need to uncomment this and find the correct ABI
    // that exposes the PMM state variables (_I_, _K_, etc.) and fee getters.
    /*
    if (config.DODO_ENABLED) {
      try {
        const DodoFetcher = require('./fetchers/dodoFetcher');
        const key = 'dodo';
        this.fetchers[key] = new DodoFetcher(config);
        logger.debug(`[PoolScanner v1.3] Initialized fetcher: Key='${key}', Constructor=${this.fetchers[key]?.constructor?.name || 'Unknown'}. DODO ABI status:`, config.ABIS?.DODOV1V2Pool ? 'Loaded' : 'Missing');
      } catch (e) {
         logger.error(`[PoolScanner v1.3] Failed to initialize DodoFetcher: ${e.message}`, e.stack);
         this.config.DODO_ENABLED = false; // Disable if init fails
         logger.warn(`[PoolScanner v1.3] DODO fetching disabled due to initialization failure.`);
      }
    } else { logger.info('[PoolScanner v1.3] DODO fetcher disabled by config.'); }
    */
     // Log a reminder if DODO is enabled in config but the fetcher init is commented out
     if (config.DODO_ENABLED && !this.fetchers.dodo) {
          logger.warn("[PoolScanner v1.3] DODO is enabled in config, but its fetcher initialization block is commented out or failed.");
     }


    // --- Final DEBUG Check ---
    const fetcherKeys = Object.keys(this.fetchers);
    logger.debug(`[PoolScanner v1.3] Available fetcher keys: [${fetcherKeys.map(k => `'${k}'`).join(', ')}]`);
    logger.debug(`[PoolScanner v1.3] Total fetchers initialized: ${fetcherKeys.length}`);
    if (fetcherKeys.length === 0) { logger.error('[PoolScanner v1.3] CRITICAL: No fetchers were initialized!'); }

    logger.info('[PoolScanner v1.3] PoolScanner fetcher initialization complete.');
  }

  async fetchPoolStates() {
    const configuredPools = this.config.POOL_CONFIGS || [];
    logger.debug(`[PoolScanner v1.3] Starting fetchPoolStates for ${configuredPools.length} configured pools.`);
    const startTime = process.hrtime.bigint();

    const fetchPromises = [];
    this.pairRegistry.clear(); // Clear registry at the start of each scan cycle

    const poolConfigProcessingStartTime = Date.now(); // Use consistent naming
    let poolsToAttemptFetch = 0; // Counter for pools we will actually try to fetch

    for (const poolInfo of configuredPools) {
        const tokenASymbol = poolInfo.pair?.[0]?.symbol || 'TokenA?';
        const tokenBSymbol = poolInfo.pair?.[1]?.symbol || 'TokenB?';
        const pairStr = `${tokenASymbol}/${tokenBSymbol}`;

      if (!poolInfo?.address || !poolInfo.pair || !Array.isArray(poolInfo.pair) || poolInfo.pair.length !== 2 || !poolInfo.dexType) {
          logger.warn(`[PoolScanner v1.3] Skipping malformed pool config: ${JSON.stringify(poolInfo)}`);
          continue;
      }

      const { address, pair, dexType } = poolInfo;
      const fetcherInstance = this.fetchers[dexType]; // Get the fetcher instance

      // Always attempt to build pair registry entry for configured pools, even if fetcher is missing/disabled
      // This ensures the finder knows the pool exists, even if its state isn't fetched
      try {
        const canonicalKey = getCanonicalPairKey(pair[0], pair[1]);
        if (!canonicalKey) {
            logger.warn(`[PoolScanner v1.3] Failed to get canonical key for ${pairStr} (${address}), skipping pair registry add.`);
            // Decide if we should skip the entire pool if canonical key fails - probably yes.
            continue;
        }
        if (!this.pairRegistry.has(canonicalKey)) {
          this.pairRegistry.set(canonicalKey, new Set());
        }
        this.pairRegistry.get(canonicalKey).add(address);
      } catch (error) {
          logger.error(`[PoolScanner v1.3] Error building pair registry entry for ${pairStr} (${address}): ${error.message}`, error);
          // Decide if we should skip the entire pool if pair registry fails - probably yes.
          continue;
      }


      if (fetcherInstance && typeof fetcherInstance.fetchPoolData === 'function') {
        logger.debug(`[PoolScanner v1.3] Queueing fetch for ${pairStr} on ${dexType} (${address}). Fetcher: ${fetcherInstance.constructor.name}`);
        poolsToAttemptFetch++; // Increment counter only if we attempt to fetch

        // Use safeFetchWrapper for robustness against temporary RPC issues
        const fetchIdentifier = `Pool ${pairStr} (${dexType}, ${address})`;
        fetchPromises.push(
          safeFetchWrapper(
            () => fetcherInstance.fetchPoolData(address, pair), // Pass address and token objects
            fetchIdentifier,
            this.config.RPC_RETRIES || 3,
            this.config.RPC_RETRY_DELAY_MS || 1000
          ).catch(err => {
             logger.error(`[PoolScanner v1.3] safeFetchWrapper failed for ${fetchIdentifier} after retries: ${err.message}`);
             // Return a structured failure object so Promise.allSettled doesn't lose track
             // Include the address and dexType from poolInfo so we can identify the failed pool later
             return { status: 'rejected', reason: err, poolInfo: poolInfo };
          })
        );
      } else {
        logger.debug(`[PoolScanner v1.3] No active fetcher instance for dexType '${dexType}' or fetchPoolData missing for pool ${pairStr} (${address}). Skipping fetch.`);
        // Do NOT increment poolsToAttemptFetch here, as we didn't queue a fetch
        // Do NOT add to processedPoolStates - it wasn't fetched
      }
    } // End loop over configuredPools

    const poolConfigProcessingEndTime = Date.now();
    logger.debug(`[PoolScanner v1.3] Pool config processing took ${poolConfigProcessingEndTime - poolConfigProcessingStartTime}ms. ${poolsToAttemptFetch} pools queued for fetch.`);


    if (fetchPromises.length === 0) {
        if (configuredPools.length > 0) { logger.warn("[PoolScanner v1.3] No fetch promises created for configured pools."); }
        else { logger.warn("[PoolScanner v1.3] No pools configured."); }
        // Return empty array and the potentially populated pairRegistry
        return { poolStates: [], pairRegistry: this.pairRegistry };
    }

    logger.debug(`[PoolScanner v1.3] Attempting to fetch data for ${fetchPromises.length} pools concurrently...`);
    const fetchStartTime = Date.now();
    const results = await Promise.allSettled(fetchPromises); // Use Promise.allSettled to process all promises
    const fetchEndTime = Date.now();
    logger.debug(`[PoolScanner v1.3] Raw pool data fetching finished in ${fetchEndTime - fetchStartTime}ms.`);


    const poolStates = []; // Array to hold successfully fetched and processed pool state data
    let successfulFetches = 0;
    let failedFetches = 0;
    let skippedByFetcher = 0; // Fetches that returned { success: false }


    results.forEach(result => {
        if (result.status === 'fulfilled') {
            const fetcherResult = result.value;
            if (fetcherResult && fetcherResult.success && fetcherResult.poolData) {
                // Success path: add the processed poolData
                poolStates.push(fetcherResult.poolData);
                successfulFetches++;
                // The poolData is already added to pairRegistry during the initial loop pass
                 // logger.debug(`[PoolScanner v1.3] Successfully processed fetched state for ${fetcherResult.poolData?.groupName || fetcherResult.poolData?.address}`); // Refined logging
            } else if (fetcherResult && !fetcherResult.success) {
                // Fetcher returned success: false (e.g., zero reserves, specific fetcher error)
                skippedByFetcher++; // Count as skipped by fetcher logic
                 // We can log a warning here, but the fetcher already logged it inside safeFetchWrapper
            } else {
                // Fetcher returned something unexpected that wasn't a success/fail object
                failedFetches++;
                logger.error(`[PoolScanner v1.3] Fetcher returned invalid data format for pool: ${fetcherResult?.address || 'Unknown'}. Result: ${JSON.stringify(fetcherResult)}`);
            }
        } else { // status === 'rejected' (Error from safeFetchWrapper after retries, or unexpected promise error)
            failedFetches++;
            // The error reason is already logged by safeFetchWrapper's catch handler
            // Log the pool info for context if available
            const poolInfo = result.reason?.poolInfo; // Check if poolInfo was attached in the catch
            const poolDesc = poolInfo ? `${poolInfo.pair?.[0]?.symbol}/${poolInfo.pair?.[1]?.symbol} on ${poolInfo.dexType} (${poolInfo.address})` : 'Unknown Pool';
            logger.error(`[PoolScanner v1.3] Fetch promise rejected for ${poolDesc}. Reason already logged.`);
        }
    });

    logger.debug(`[PoolScanner v1.3] Pool state fetching cycle complete. Configured: ${configuredPools.length}, Attempted Fetches: ${poolsToAttemptFetch}, Successful: ${successfulFetches}, Failed Promises: ${failedFetches}, Skipped by Fetcher: ${skippedByFetcher}`);
    logger.debug(`[PoolScanner v1.3] Final Pair Registry Size: ${this.pairRegistry.size}`);

    // Return the array of successfully fetched pool states and the complete pair registry
    return { poolStates, pairRegistry: this.pairRegistry };
  }
}

module.exports = PoolScanner;
