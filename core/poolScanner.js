// /workspaces/arbitrum-flash/core/poolScanner.js
// --- REFACTORED VERSION 2.4 --- Added RPC Retry Logic ---

const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler');

// --- Import Fetchers ---
const UniswapV3Fetcher = require('./fetchers/uniswapV3Fetcher');
const SushiSwapFetcher = require('./fetchers/sushiSwapFetcher');
const CamelotFetcher = require('./fetchers/camelotFetcher');
// --- ---

class PoolScanner {
    constructor(config, provider) {
        const logPrefix = '[PoolScanner v2.4]'; // Updated version
        logger.debug(`${logPrefix} Initializing...`);
        if (!config || !provider) { throw new ArbitrageError('PoolScanner requires config and provider.', 'INITIALIZATION_ERROR'); }
        this.config = config;
        this.provider = provider;

        // Instantiate Fetchers
        try {
            this.v3Fetcher = new UniswapV3Fetcher(provider);
            this.sushiFetcher = new SushiSwapFetcher(provider);
            this.camelotFetcher = new CamelotFetcher(provider);
        } catch (fetcherError) { /* ... */ } // Existing handling
        logger.info(`${logPrefix} Initialized with V3, Sushi, and Camelot Fetchers.`);
    }

    // --- *** UPDATED safeFetchWrapper with Retry Logic *** ---
    /**
     * Wraps an individual fetcher promise with retries to ensure it resolves,
     * logging any errors internally. Resolves null if all retries fail.
     * @param {Promise} fetcherPromise The promise returned by the fetcher.
     * @param {object} poolInfo The configuration info for the pool being fetched.
     * @param {number} [maxRetries=2] Maximum number of retry attempts (total attempts = maxRetries + 1).
     * @param {number} [initialDelay=500] Initial delay in ms before first retry.
     * @returns {Promise<object|null>} Resolves with the pool state or null if all retries fail.
     */
    async safeFetchWrapper(fetcherPromise, poolInfo, maxRetries = 2, initialDelay = 500) {
        const poolDesc = `${poolInfo.dexType || 'Unknown DEX'} pool ${poolInfo.address || poolInfo.name || 'N/A'} (${poolInfo.token0Symbol || '?'}/${poolInfo.token1Symbol || '?'})`;
        let attempt = 0;

        while (attempt <= maxRetries) {
            try {
                const state = await fetcherPromise; // Await the actual fetcher call
                // Validate the returned state
                if (state && state.address && state.pairKey) {
                    // Log success only on the first attempt for brevity
                    if (attempt === 0) {
                        logger.debug(`[PoolScanner SafeFetch] Successfully fetched ${poolDesc}`);
                    } else {
                        logger.info(`[PoolScanner SafeFetch] Successfully fetched ${poolDesc} on attempt ${attempt + 1}`);
                    }
                    return state; // Success! Return the state.
                } else if (state === null && attempt === 0) {
                    // Fetcher explicitly returned null on first try (likely logged its own warning)
                    logger.debug(`[PoolScanner SafeFetch] Fetcher for ${poolDesc} returned null.`);
                    return null; // Don't retry if fetcher intentionally returned null
                } else if (attempt === 0) {
                    // Fetcher resolved but returned invalid state on first try
                     logger.warn(`[PoolScanner SafeFetch] Fetcher for ${poolDesc} returned invalid/incomplete state (Attempt 1). Retrying...`);
                     // Fall through to retry logic
                 } else {
                      // Invalid state on a retry attempt
                      logger.warn(`[PoolScanner SafeFetch] Fetcher for ${poolDesc} returned invalid state on attempt ${attempt + 1}.`);
                      // Decide if invalid state on retry should stop retries or continue. Let's stop.
                      return null;
                  }

            } catch (error) {
                logger.warn(`[PoolScanner SafeFetch] Error fetching ${poolDesc} (Attempt ${attempt + 1}/${maxRetries + 1}): ${error.message}`);
                if (attempt >= maxRetries) {
                    logger.error(`[PoolScanner SafeFetch] All ${maxRetries + 1} fetch attempts failed for ${poolDesc}. Last error: ${error.message}`);
                    // Use global handler for the final, persistent error
                    if (typeof handleError === 'function') {
                        handleError(error, `PoolScanner.Fetcher.FinalFail.${poolInfo.dexType || 'Unknown'}`);
                    } else { console.error("Emergency Log: handleError function not found..."); }
                    return null; // Return null after all retries fail
                }
                // Calculate delay with exponential backoff (e.g., 500ms, 1000ms, 2000ms)
                const delay = initialDelay * Math.pow(2, attempt);
                logger.warn(`[PoolScanner SafeFetch] Retrying fetch for ${poolDesc} in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
            attempt++; // Increment attempt counter *after* potential delay
        }
        // Should technically not be reached if logic is correct, but as a safeguard
        logger.error(`[PoolScanner SafeFetch] Exited retry loop unexpectedly for ${poolDesc}.`);
        return null;
    }
    // --- *** END UPDATED safeFetchWrapper *** ---

    /**
     * Fetches live states for all configured pools and builds a pair registry.
     * @param {Array<object>} poolInfos Array of pool configuration objects from config.
     * @returns {Promise<{livePoolStatesMap: object, pairRegistry: object}>} Result object.
     */
    async fetchPoolStates(poolInfos) {
        const logPrefix = "[PoolScanner v2.4 fetchPoolStates]"; // Updated version
        logger.debug(`${logPrefix} Received ${poolInfos?.length ?? 0} poolInfos to fetch.`);
        if (!poolInfos || poolInfos.length === 0) { return { livePoolStatesMap: {}, pairRegistry: {} }; }
        logger.info(`${logPrefix} Delegating state fetching for ${poolInfos.length} pools...`);

        const fetchPromises = [];
        for (const poolInfo of poolInfos) {
            if (!poolInfo || !poolInfo.address || !poolInfo.dexType || !poolInfo.token0Symbol || !poolInfo.token1Symbol) {
                logger.warn(`${logPrefix} Skipping invalid poolInfo (missing address, dexType, or token symbols): ${JSON.stringify(poolInfo)}`);
                continue;
            }

            let fetcherInstance;
            switch (poolInfo.dexType) {
                case 'uniswapV3': fetcherInstance = this.v3Fetcher; break;
                case 'sushiswap': fetcherInstance = this.sushiFetcher; break;
                case 'camelot': fetcherInstance = this.camelotFetcher; break;
                // Add other cases here
                default:
                    logger.warn(`${logPrefix} Skipping pool ${poolInfo.address}: Unsupported dexType '${poolInfo.dexType}'`);
                    continue;
            }

            if (!fetcherInstance) { // Should not happen with default case, but safeguard
                 logger.error(`${logPrefix} Internal Error: No fetcher instance found for dexType '${poolInfo.dexType}'.`);
                 continue;
            }

            // --- *** Pass the fetcher *function call* to the wrapper *** ---
            // safeFetchWrapper now handles awaiting the promise internally with retries
            fetchPromises.push(this.safeFetchWrapper(
                fetcherInstance.fetchPoolState(poolInfo), // Pass the promise directly
                poolInfo
            ));
            // --- *** ---

        } // End loop through poolInfos

        if (fetchPromises.length === 0) { /* ... */ return { livePoolStatesMap: {}, pairRegistry: {} }; }

        const livePoolStatesMap = {};
        const pairRegistry = {};
        const attemptedCount = fetchPromises.length;
        logger.info(`${logPrefix} Attempting to fetch states for ${attemptedCount} pools concurrently via Promise.all (with retries)...`);

        try {
            // Promise.all now receives promises from safeFetchWrapper, which handle retries internally
            const results = await Promise.all(fetchPromises);
            logger.info(`${logPrefix} Promise.all completed successfully.`);

            logger.debug(`${logPrefix} Processing ${results.length} results from Promise.all...`);
            for (const state of results) {
                if (state && state.address && state.pairKey) {
                    const lowerCaseAddress = state.address.toLowerCase();
                    livePoolStatesMap[lowerCaseAddress] = state;
                    if (!pairRegistry[state.pairKey]) { pairRegistry[state.pairKey] = []; }
                    pairRegistry[state.pairKey].push(state);
                }
            }
        } catch (error) { /* ... existing critical error handling ... */ return { livePoolStatesMap: {}, pairRegistry: {} }; }

        const finalPoolCount = Object.keys(livePoolStatesMap).length;
        const finalPairCount = Object.keys(pairRegistry).length;

        logger.info(`${logPrefix} Successfully gathered states for ${finalPoolCount} out of ${attemptedCount} attempted pools.`);
        logger.info(`${logPrefix} Built Pair Registry with ${finalPairCount} unique canonical pairs.`);

        if (finalPoolCount < attemptedCount) { logger.warn(`${logPrefix} ${attemptedCount - finalPoolCount} pools failed during fetch/processing (check retry logs).`); }
        logger.debug(`${logPrefix} Returning livePoolStates map and pairRegistry.`);
        return { livePoolStatesMap, pairRegistry };
    } // --- End fetchPoolStates ---

} // --- END PoolScanner Class ---

module.exports = { PoolScanner };
