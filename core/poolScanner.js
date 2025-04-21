// core/poolScanner.js
const logger = require('../utils/logger');
const { getProvider } = require('../utils/provider');
const { getCanonicalPairKey } = require('../../utils/pairUtils'); // Adjust path if needed
const { safeFetchWrapper } = require('../../utils/networkUtils'); // Adjust path if needed

class PoolScanner {
  constructor(config) {
    this.config = config;
    // PoolScanner often doesn't need its own provider if fetchers handle it
    // this.provider = getProvider(config.PRIMARY_RPC_URL);
    this.fetchers = {};
    this.pairRegistry = new Map(); // Map<canonicalPairKey, Set<poolAddress>>

    logger.info('[PoolScanner] Initializing PoolScanner fetchers...');

    // --- Fetcher Initialization & DEBUG ---
    if (config.UNISWAP_V3_ENABLED) {
      try {
        const UniswapV3Fetcher = require('./fetchers/uniswapV3Fetcher'); // Adjust path if needed
        const key = 'uniswapV3';
        this.fetchers[key] = new UniswapV3Fetcher(config); // Pass full config
        logger.debug(`[PoolScanner] Initialized fetcher: Key='${key}', Constructor=${this.fetchers[key]?.constructor?.name || 'Unknown'}`);
      } catch (e) { logger.error(`[PoolScanner] Failed to initialize UniswapV3Fetcher: ${e.message}`, e.stack); }
    } else { logger.info('[PoolScanner] Uniswap V3 fetcher disabled by config.'); }

    if (config.SUSHISWAP_ENABLED) {
      try {
        const SushiSwapFetcher = require('./fetchers/sushiSwapFetcher'); // Adjust path if needed
        const key = 'sushiswap';
        this.fetchers[key] = new SushiSwapFetcher(config); // Pass full config
        logger.debug(`[PoolScanner] Initialized fetcher: Key='${key}', Constructor=${this.fetchers[key]?.constructor?.name || 'Unknown'}`);
      } catch (e) { logger.error(`[PoolScanner] Failed to initialize SushiSwapFetcher: ${e.message}`, e.stack); }
    } else { logger.info('[PoolScanner] SushiSwap fetcher disabled by config.'); }

    if (config.DODO_ENABLED) {
      try {
        const DodoFetcher = require('./fetchers/dodoFetcher'); // Adjust path if needed
        const key = 'dodo';
        this.fetchers[key] = new DodoFetcher(config); // Pass full config
        logger.debug(`[PoolScanner] Initialized fetcher: Key='${key}', Constructor=${this.fetchers[key]?.constructor?.name || 'Unknown'}`);
      } catch (e) { logger.error(`[PoolScanner] Failed to initialize DodoFetcher: ${e.message}`, e.stack); }
    } else { logger.info('[PoolScanner] DODO fetcher disabled by config.'); }

    // --- Final DEBUG Check ---
    const fetcherKeys = Object.keys(this.fetchers);
    logger.debug(`[PoolScanner] Available fetcher keys: [${fetcherKeys.map(k => `'${k}'`).join(', ')}]`);
    logger.debug(`[PoolScanner] Total fetchers initialized: ${fetcherKeys.length}`);
    if (fetcherKeys.length === 0) { logger.warn('[PoolScanner] WARNING: No fetchers were initialized!'); }
    // --- End DEBUG ---

    logger.info('[PoolScanner] PoolScanner fetcher initialization complete.');
  }

  async fetchPoolStates() {
    const configuredPools = this.config.POOL_CONFIGS || [];
    logger.info(`[PoolScanner] Starting fetchPoolStates for ${configuredPools.length} configured pools.`);
    const fetchPromises = [];
    this.pairRegistry.clear();

    const poolProcessingStartTime = Date.now();

    if (Object.keys(this.fetchers).length === 0) {
        logger.error("[PoolScanner] No fetchers available. Cannot fetch pool states.");
        return { poolStates: [], pairRegistry: this.pairRegistry };
    }

    let poolsToFetchCount = 0;
    for (const poolInfo of configuredPools) {
        // Use optional chaining for safer access to symbols
        const tokenASymbol = poolInfo.pair?.[0]?.symbol || 'TokenA?';
        const tokenBSymbol = poolInfo.pair?.[1]?.symbol || 'TokenB?';
        const pairStr = `${tokenASymbol}/${tokenBSymbol}`; // Use symbols for logging

      if (!poolInfo?.address || !poolInfo.pair || !Array.isArray(poolInfo.pair) || poolInfo.pair.length !== 2 || !poolInfo.dexType || !tokenASymbol || !tokenBSymbol) {
          logger.warn(`[PoolScanner] Skipping malformed pool config: ${JSON.stringify(poolInfo)}`);
          continue;
      }

      const { address, pair, dexType } = poolInfo;
      const fetcherInstance = this.fetchers[dexType];

      // Build Pair Registry
      try {
        // Pass actual token objects from poolInfo.pair to getCanonicalPairKey
        const canonicalKey = getCanonicalPairKey(pair[0], pair[1]);
        if (!canonicalKey) {
            logger.warn(`[PoolScanner] Failed to get canonical key for ${pairStr} (${address}), skipping registry add.`);
            // Decide if you should still attempt fetch - maybe not if key fails?
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
             logger.error(`[PoolScanner] Fetcher for dexType '${dexType}' (${fetcherInstance.constructor.name}) missing 'fetchPoolData'. Skipping pool ${pairStr} (${address}).`);
             continue;
        }

        logger.debug(`[PoolScanner] Queueing fetch for ${pairStr} on ${dexType} (${address}). Fetcher: ${fetcherInstance.constructor.name}`);
        poolsToFetchCount++;

        // Use pairStr for logging identifier in safeFetchWrapper
        const fetchIdentifier = `Pool ${pairStr} (${dexType}, ${address})`;
        fetchPromises.push(
          safeFetchWrapper(
            () => fetcherInstance.fetchPoolData(address, pair), // Pass address and TOKEN OBJECTS
            fetchIdentifier,
            this.config.RPC_RETRIES || 3, // Use config or default
            this.config.RPC_RETRY_DELAY_MS || 1000 // Use config or default
          ).catch(err => {
             logger.error(`[PoolScanner] safeFetchWrapper failed for ${fetchIdentifier} after retries: ${err.message}`);
             return { status: 'rejected', reason: err };
          })
        );
      } else {
        logger.warn(`[PoolScanner] No fetcher instance for dexType '${dexType}' for pool ${pairStr} (${address}). Skipping fetch.`);
        const availableKeys = Object.keys(this.fetchers);
        logger.debug(`[PoolScanner] Available fetcher keys: [${availableKeys.map(k => `'${k}'`).join(', ')}]`);
      }
    } // End loop

    const poolProcessingEndTime = Date.now();
    logger.debug(`[PoolScanner] Pool config processing took ${poolProcessingEndTime - poolProcessingStartTime}ms.`);

    if (fetchPromises.length === 0) {
        if (configuredPools.length > 0) { logger.warn("[PoolScanner] No fetch promises created."); }
        else { logger.warn("[PoolScanner] No pools configured."); }
        return { poolStates: [], pairRegistry: this.pairRegistry };
    }

    logger.info(`[PoolScanner] Attempting to fetch data for ${fetchPromises.length} pools (out of ${configuredPools.length} configured) concurrently...`);
    const fetchStartTime = Date.now();
    const results = await Promise.allSettled(fetchPromises);
    const fetchEndTime = Date.now();
    logger.info(`[PoolScanner] Raw pool data fetching finished in ${fetchEndTime - fetchStartTime}ms.`);

    const poolStates = [];
    let successfulFetches = 0;
    let failedFetches = 0;
    let poolsSkippedByFetcher = 0;

    const attemptedPools = configuredPools.filter(p => this.fetchers[p.dexType] && typeof this.fetchers[p.dexType].fetchPoolData === 'function');

    results.forEach((result, index) => {
        const poolInfo = attemptedPools[index];
        if (!poolInfo) {
            logger.error(`[PoolScanner] CRITICAL: Mismatch between promise results and pool info at index ${index}.`);
            failedFetches++;
            return;
        }
        // Use symbols for logging
        const pairStr = `${poolInfo.pair?.[0]?.symbol || '?'}/${poolInfo.pair?.[1]?.symbol || '?'}`;
        const poolDesc = `${pairStr} on ${poolInfo.dexType} (${poolInfo.address})`;

        if (result.status === 'fulfilled') {
            const fetcherResult = result.value;
            if (fetcherResult && fetcherResult.success && fetcherResult.poolData) {
                poolStates.push(fetcherResult.poolData);
                successfulFetches++;
                logger.debug(`[PoolScanner] Successfully processed fetched state for ${poolDesc}`);
            } else if (fetcherResult && !fetcherResult.success) {
                poolsSkippedByFetcher++;
                const reason = fetcherResult.error || 'Fetcher reported failure';
                logger.warn(`[PoolScanner] Fetcher reported failure for ${poolDesc}. Reason: ${reason}`);
            } else {
                poolsSkippedByFetcher++;
                logger.warn(`[PoolScanner] Fetch for ${poolDesc} succeeded but returned invalid data. Result: ${JSON.stringify(fetcherResult)}`);
            }
        } else { // status === 'rejected'
            failedFetches++;
            const reason = result.reason instanceof Error ? result.reason.message : JSON.stringify(result.reason);
            logger.error(`[PoolScanner] Failed to fetch state for ${poolDesc} after retries. Reason: ${reason}`);
            if (result.reason instanceof Error && result.reason.stack) {
                logger.debug(`[PoolScanner] Stack trace for ${poolDesc} failure: ${result.reason.stack}`);
            }
        }
    });

    logger.info(`[PoolScanner] Pool state fetching complete. Total Configured: ${configuredPools.length}, Fetch Attempts: ${fetchPromises.length}, Success: ${successfulFetches}, Failed: ${failedFetches}, Skipped/No Data: ${poolsSkippedByFetcher}`);
    logger.debug(`[PoolScanner] Final Pair Registry Size: ${this.pairRegistry.size}`);

    return { poolStates, pairRegistry: this.pairRegistry };
  }
}

module.exports = PoolScanner;
