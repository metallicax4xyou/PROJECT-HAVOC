// core/poolScanner.js
const logger = require('../utils/logger');
const { getProvider } = require('../utils/provider');
// *** CORRECTED PATH ***
const { getCanonicalPairKey } = require('../utils/pairUtils'); // Use '../' not '../../'
const { safeFetchWrapper } = require('../utils/networkUtils'); // Use '../'

class PoolScanner {
  constructor(config) {
    this.config = config;
    this.fetchers = {};
    this.pairRegistry = new Map();

    logger.info('[PoolScanner] Initializing PoolScanner fetchers...');

    // --- Fetcher Initialization ---
    if (config.UNISWAP_V3_ENABLED) {
      try {
        // *** CORRECTED PATH ***
        const UniswapV3Fetcher = require('./fetchers/uniswapV3Fetcher');
        const key = 'uniswapV3';
        this.fetchers[key] = new UniswapV3Fetcher(config);
        logger.debug(`[PoolScanner] Initialized fetcher: Key='${key}', Constructor=${this.fetchers[key]?.constructor?.name || 'Unknown'}`);
      } catch (e) { logger.error(`[PoolScanner] Failed to initialize UniswapV3Fetcher: ${e.message}`, e.stack); }
    } else { logger.info('[PoolScanner] Uniswap V3 fetcher disabled by config.'); }

    if (config.SUSHISWAP_ENABLED) {
      try {
         // *** CORRECTED PATH ***
        const SushiSwapFetcher = require('./fetchers/sushiSwapFetcher');
        const key = 'sushiswap';
        this.fetchers[key] = new SushiSwapFetcher(config);
        logger.debug(`[PoolScanner] Initialized fetcher: Key='${key}', Constructor=${this.fetchers[key]?.constructor?.name || 'Unknown'}`);
      } catch (e) { logger.error(`[PoolScanner] Failed to initialize SushiSwapFetcher: ${e.message}`, e.stack); }
    } else { logger.info('[PoolScanner] SushiSwap fetcher disabled by config.'); }

    if (config.DODO_ENABLED) {
      try {
         // *** CORRECTED PATH ***
        const DodoFetcher = require('./fetchers/dodoFetcher');
        const key = 'dodo';
        thisers[key] = new DodoFetcher(config);
        logger.debug(`[PoolScanner] Initialized fetcher: Key='${key}', Constructor=${this.fetchers[key]?.constructor?.name || 'Unknown'}`);
      } catch (e) { logger.error(`[PoolScanner] Failed to initialize DodoFetcher: ${e.message}`, e.stack); }
    } else { logger.info('[PoolScanner] DODO fetcher disabled by config.'); }

    // --- Final DEBUG Check ---
    const fetcherKeys = Object.keys(this.fetchers);
    logger.debug(`[PoolScanner] Available fetcher keys: [${fetcherKeys.map(k => `'${k}'`).join(', ')}]`);
    logger.debug(`[PoolScanner] Total fetchers initialized: ${fetcherKeys.length}`);
    if (fetcherKeys.length === 0) { logger.warn('[PoolScanner] WARNING: No fetchers were initialized!'); }

    logger.info('[PoolScanner] PoolScanner fetcher initialization complete.');
  }

  async fetchPoolStates() {
    const configuredPools = this.config.POOL_CONFIGS || [];
    // CHANGED from logger.info to logger.debug
    logger.debug(`[PoolScanner] Starting fetchPoolStates for ${configuredPools.length} configured pools.`);
    const fetchPromises = [];
    this.pairRegistry.clear();

    const poolProcessingStartTime = Date.now();

    if (Object.keys(this.fetchers).length === 0) {
        logger.error("[PoolScanner] No fetchers available.");
        return { poolStates: [], pairRegistry: this.pairRegistry };
    }

    let poolsToFetchCount = 0;
    for (const poolInfo of configuredPools) {
        const tokenASymbol = poolInfo.pair?.[0]?.symbol || 'TokenA?';
        const tokenBSymbol = poolInfo.pair?.[1]?.symbol || 'TokenB?';
        const pairStr = `${tokenASymbol}/${tokenBSymbol}`;

      if (!poolInfo?.address || !poolInfo.pair || !Array.isArray(poolInfo.pair) || poolInfo.pair.length !== 2 || !poolInfo.dexType) {
          logger.warn(`[PoolScanner] Skipping malformed pool config: ${JSON.stringify(poolInfo)}`);
          continue;
      }

      const { address, pair, dexType } = poolInfo;
      const fetcherInstance = this.fetchers[dexType];

      try {
        // Pass actual token objects from poolInfo.pair
        const canonicalKey = getCanonicalPairKey(pair[0], pair[1]);
        if (!canonicalKey) {
            logger.warn(`[PoolScanner] Failed to get canonical key for ${pairStr} (${address}), skipping registry add.`);
            continue;
        }
        if (!this.pairRegistry.has(canonicalKey)) {
          this.pairRegistry.set(canonicalKey, new Set());
        }
        this.pairRegistry.get(canonicalKey).add(address);
      } catch (error) {
          logger.error(`[PoolScanner] Error building pair registry for ${pairStr} (${address}): ${error.message}`);
          continue;
      }

      if (fetcherInstance) {
        if (typeof fetcherInstance.fetchPoolData !== 'function') {
             logger.error(`[PoolScanner] Fetcher '${dexType}' missing 'fetchPoolData'. Skipping pool ${pairStr} (${address}).`);
             continue;
        }

        logger.debug(`[PoolScanner] Queueing fetch for ${pairStr} on ${dexType} (${address}). Fetcher: ${fetcherInstance.constructor.name}`);
        poolsToFetchCount++;

        const fetchIdentifier = `Pool ${pairStr} (${dexType}, ${address})`;
        fetchPromises.push(
          safeFetchWrapper(
            () => fetcherInstance.fetchPoolData(address, pair), // Pass address and token objects
            fetchIdentifier,
            this.config.RPC_RETRIES || 3,
            this.config.RPC_RETRY_DELAY_MS || 1000
          ).catch(err => {
             logger.error(`[PoolScanner] safeFetchWrapper failed for ${fetchIdentifier} after retries: ${err.message}`);
             return { status: 'rejected', reason: err };
          })
        );
      } else {
        logger.warn(`[PoolScanner] No fetcher instance for dexType '${dexType}' for pool ${pairStr} (${address}). Skipping fetch.`);
      }
    } // End loop

    const poolProcessingEndTime = Date.now();
    logger.debug(`[PoolScanner] Pool config processing took ${poolProcessingEndTime - poolProcessingStartTime}ms.`);

    if (fetchPromises.length === 0) {
        if (configuredPools.length > 0) { logger.warn("[PoolScanner] No fetch promises created."); }
        else { logger.warn("[PoolScanner] No pools configured."); }
        return { poolStates: [], pairRegistry: this.pairRegistry };
    }

    // CHANGED from logger.info to logger.debug
    logger.debug(`[PoolScanner] Attempting to fetch data for ${fetchPromises.length} pools concurrently...`);
    const fetchStartTime = Date.now();
    const results = await Promise.allSettled(fetchPromises);
    const fetchEndTime = Date.now();
    // CHANGED from logger.info to logger.debug
    logger.debug(`[PoolScanner] Raw pool data fetching finished in ${fetchEndTime - fetchStartTime}ms.`);

    const poolStates = [];
    let successfulFetches = 0;
    let failedFetches = 0;
    let poolsSkippedByFetcher = 0;

    // Filter attempted pools based on whether a fetcher existed for their dexType
    const attemptedPools = configuredPools.filter(p => this.fetchers[p.dexType] && typeof this.fetchers[p.dexType].fetchPoolData === 'function');

    results.forEach((result, index) => {
        // Get the corresponding poolInfo based on the index from the *attempted* pools array
        const poolInfo = attemptedPools[index];
        if (!poolInfo) {
            // This is a critical error, indicates a logic bug in how results are mapped back
            logger.error(`[PoolScanner] CRITICAL: Mismatch between promise results and pool info at index ${index}.`);
            failedFetches++; // Count as a failure related to processing
            return; // Skip processing this result further
        }
        const pairStr = `${poolInfo.pair?.[0]?.symbol || '?'}/${poolInfo.pair?.[1]?.symbol || '?'}`;
        const poolDesc = `${pairStr} on ${poolInfo.dexType} (${poolInfo.address})`;

        if (result.status === 'fulfilled') {
            const fetcherResult = result.value;
            if (fetcherResult && fetcherResult.success && fetcherResult.poolData) {
                poolStates.push(fetcherResult.poolData); successfulFetches++;
                logger.debug(`[PoolScanner] Successfully processed fetched state for ${poolDesc}`);
            } else if (fetcherResult && !fetcherResult.success) {
                poolsSkippedByFetcher++; logger.warn(`[PoolScanner] Fetcher reported failure for ${poolDesc}. Reason: ${fetcherResult.error || 'Unknown'}`);
            } else {
                // Fetcher returned something, but not in the expected success/poolData format
                poolsSkippedByFetcher++; logger.warn(`[PoolScanner] Fetch for ${poolDesc} succeeded but returned invalid data format.`);
            }
        } else { // status === 'rejected'
            failedFetches++; const reason = result.reason instanceof Error ? result.reason.message : JSON.stringify(result.reason);
            logger.error(`[PoolScanner] Failed to fetch state for ${poolDesc} after retries. Reason: ${reason}`);
            if (result.reason instanceof Error && result.reason.stack) { logger.debug(`[PoolScanner] Stack trace for ${poolDesc} failure: ${result.reason.stack}`); }
        }
    });

    // CHANGED from logger.info to logger.debug
    logger.debug(`[PoolScanner] Pool state fetching complete. Total Configured: ${configuredPools.length}, Attempts: ${fetchPromises.length}, Success: ${successfulFetches}, Failed: ${failedFetches}, Skipped: ${poolsSkippedByFetcher}`);
    logger.debug(`[PoolScanner] Final Pair Registry Size: ${this.pairRegistry.size}`);

    return { poolStates, pairRegistry: this.pairRegistry };
  }
}

module.exports = PoolScanner;
