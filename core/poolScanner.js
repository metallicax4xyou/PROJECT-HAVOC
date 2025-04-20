// /workspaces/arbitrum-flash/core/poolScanner.js
// --- REFACTORED VERSION 2.1 ---
// Added robust error handling for individual fetcher calls within Promise.all

const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler'); // Correct import assuming handleError is exported

// --- Import Fetchers ---
const UniswapV3Fetcher = require('./fetchers/uniswapV3Fetcher');
const SushiSwapFetcher = require('./fetchers/sushiSwapFetcher');
// --- ---

class PoolScanner {
    constructor(config, provider) {
        logger.debug(`[PoolScanner v2.1] Initializing...`); // Updated version
        if (!config || !provider) {
            throw new ArbitrageError('PoolScanner requires config and provider.', 'INITIALIZATION_ERROR');
        }
        this.config = config;
        this.provider = provider;

        // Instantiate Fetchers
        try {
            this.v3Fetcher = new UniswapV3Fetcher(provider);
            this.sushiFetcher = new SushiSwapFetcher(provider);
        } catch (fetcherError) {
            logger.error(`[PoolScanner v2.1] Failed to initialize fetchers: ${fetcherError.message}`);
            throw fetcherError;
        }
        logger.info(`[PoolScanner v2.1] Initialized with V3 and Sushi Fetchers.`);
    }

    /**
     * Wraps an individual fetcher promise to ensure it always resolves,
     * logging any errors internally.
     * @param {Promise} fetcherPromise The promise returned by the fetcher.
     * @param {object} poolInfo The configuration info for the pool being fetched.
     * @returns {Promise<object|null>} Resolves with the pool state or null if an error occurred.
     */
    async safeFetchWrapper(fetcherPromise, poolInfo) {
        const poolDesc = `${poolInfo.dexType} pool ${poolInfo.address} (${poolInfo.token0Symbol}/${poolInfo.token1Symbol})`;
        try {
            const state = await fetcherPromise;
            // Optional: Add basic validation on the returned state if needed
            if (state && state.address) {
                 logger.debug(`[PoolScanner SafeFetch] Successfully fetched ${poolDesc}`);
                 return state;
            } else {
                 // This case might indicate the fetcher resolved successfully but returned invalid data
                 logger.warn(`[PoolScanner SafeFetch] Fetcher for ${poolDesc} returned null or invalid state.`);
                 return null;
            }
        } catch (error) {
            logger.error(`[PoolScanner SafeFetch] Error fetching ${poolDesc}: ${error.message}`);
            // Use global handler for unexpected fetcher errors
             if (typeof handleError === 'function') handleError(error, `PoolScanner.Fetcher.${poolInfo.dexType}`);
            return null; // Resolve with null on error to prevent Promise.all rejection
        }
    }

    /**
     * Fetches live states for all configured pools using dedicated fetchers.
     * @param {Array<object>} poolInfos Array of pool configuration objects from config.
     * @returns {Promise<object>} A map of poolAddress.toLowerCase() to its live state object, or an empty object if fetch fails critically.
     */
    async fetchPoolStates(poolInfos) {
        const logPrefix = "[PoolScanner v2.1 fetchPoolStates]"; // Consistent prefix
        logger.debug(`${logPrefix} Received ${poolInfos?.length ?? 0} poolInfos to fetch.`);
        if (!poolInfos || poolInfos.length === 0) {
            logger.warn(`${logPrefix} No pool configurations provided.`);
            return {};
        }
        logger.info(`${logPrefix} Delegating state fetching for ${poolInfos.length} pools...`);

        const fetchPromises = [];

        for (const poolInfo of poolInfos) {
            if (!poolInfo || !poolInfo.address || !poolInfo.dexType) {
                logger.warn(`${logPrefix} Skipping invalid poolInfo (missing address or dexType): ${JSON.stringify(poolInfo)}`);
                continue;
            }

            let fetcherPromise;
            // Delegate to the appropriate fetcher
            if (poolInfo.dexType === 'uniswapV3') {
                logger.debug(`${logPrefix} Creating V3 fetch promise for ${poolInfo.address}`);
                fetcherPromise = this.v3Fetcher.fetchPoolState(poolInfo);
            } else if (poolInfo.dexType === 'sushiswap') {
                logger.debug(`${logPrefix} Creating Sushi fetch promise for ${poolInfo.address}`);
                fetcherPromise = this.sushiFetcher.fetchPoolState(poolInfo);
            } else {
                logger.warn(`${logPrefix} Skipping pool ${poolInfo.address}: Unsupported dexType '${poolInfo.dexType}'`);
                continue; // Skip if dexType is unknown
            }

            // Wrap the fetcher promise to handle errors gracefully
            fetchPromises.push(this.safeFetchWrapper(fetcherPromise, poolInfo));
        }

        if (fetchPromises.length === 0) {
            logger.warn(`${logPrefix} No valid pools found to fetch states for after filtering.`);
            return {};
        }

        const livePoolStates = {};
        const attemptedCount = fetchPromises.length;
        logger.info(`${logPrefix} Attempting to fetch states for ${attemptedCount} pools concurrently via Promise.all...`);

        try {
            // Execute all wrapped fetch requests concurrently
            // Promise.all will now only reject if safeFetchWrapper itself has a critical bug (unlikely)
            const results = await Promise.all(fetchPromises);
            logger.info(`${logPrefix} Promise.all completed successfully.`);

            // Process results (results array contains state objects or null)
             logger.debug(`${logPrefix} Processing ${results.length} results from Promise.all...`);
            for (const state of results) {
                if (state && state.address) { // Check if fetch was successful (not null)
                    livePoolStates[state.address.toLowerCase()] = state;
                }
                // Individual errors were logged inside safeFetchWrapper
            }
        } catch (error) { // Catch errors from Promise.all itself (should be very rare now)
            logger.error(`${logPrefix} CRITICAL UNEXPECTED Error during Promise.all execution: ${error.message}`);
             if (typeof handleError === 'function') handleError(error, 'PoolScanner.fetchPoolStates.PromiseAll');
            // Optionally clear results if Promise.all fails catastrophically
            // return {};
            // Or try to proceed with any results gathered before the error (if possible, depends on error)
        }

        const finalCount = Object.keys(livePoolStates).length;

        logger.info(`${logPrefix} Successfully gathered states for ${finalCount} out of ${attemptedCount} attempted pools.`);
        if (finalCount < attemptedCount) {
             logger.warn(`${logPrefix} ${attemptedCount - finalCount} pools failed during fetch/processing. Check preceding logs for errors.`);
        }
        logger.debug(`${logPrefix} Returning livePoolStates map.`);
        return livePoolStates;
    } // --- End fetchPoolStates ---

} // --- END PoolScanner Class ---

module.exports = { PoolScanner };
