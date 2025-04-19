// /workspaces/arbitrum-flash/core/poolScanner.js
// --- REFACTORED VERSION 2.0 ---
// ONLY fetches states, delegates finding opportunities to separate finder classes.

const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler');

// --- Import Fetchers ---
const UniswapV3Fetcher = require('./fetchers/uniswapV3Fetcher');
const SushiSwapFetcher = require('./fetchers/sushiSwapFetcher');
// --- ---

class PoolScanner {
    constructor(config, provider) {
        logger.debug(`[PoolScanner v2.0] Initializing...`);
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
            logger.error(`[PoolScanner v2.0] Failed to initialize fetchers: ${fetcherError.message}`);
            throw fetcherError;
        }
        logger.info(`[PoolScanner v2.0] Initialized with V3 and Sushi Fetchers.`);
    }

    /**
     * Fetches live states for all configured pools using dedicated fetchers.
     * @param {Array<object>} poolInfos Array of pool configuration objects from config.
     * @returns {Promise<object>} A map of poolAddress.toLowerCase() to its live state object, or an empty object if fetch fails.
     */
    async fetchPoolStates(poolInfos) {
        logger.debug(`[PoolScanner v2.0] Received ${poolInfos?.length ?? 0} poolInfos to fetch.`);
        if (!poolInfos || poolInfos.length === 0) {
            logger.warn('[PoolScanner v2.0] No pool configurations provided.');
            return {};
        }
        logger.info(`[PoolScanner v2.0] Delegating state fetching for ${poolInfos.length} pools...`);

        const fetchPromises = [];

        for (const poolInfo of poolInfos) {
            if (!poolInfo || !poolInfo.address || !poolInfo.dexType) {
                logger.warn(`[PoolScanner v2.0] Skipping invalid poolInfo (missing address or dexType): ${JSON.stringify(poolInfo)}`);
                continue;
            }

            // Delegate to the appropriate fetcher
            if (poolInfo.dexType === 'uniswapV3') {
                fetchPromises.push(this.v3Fetcher.fetchPoolState(poolInfo));
            } else if (poolInfo.dexType === 'sushiswap') {
                fetchPromises.push(this.sushiFetcher.fetchPoolState(poolInfo));
            } else {
                logger.warn(`[PoolScanner v2.0] Skipping pool ${poolInfo.address}: Unsupported dexType '${poolInfo.dexType}'`);
            }
        }

        if (fetchPromises.length === 0) {
            logger.warn('[PoolScanner v2.0] No valid pools to fetch states for.');
            return {};
        }

        const livePoolStates = {};
        try {
            // Execute all fetch requests concurrently
            const results = await Promise.all(fetchPromises);

            // Process results (fetchers return state object or null)
            for (const state of results) {
                if (state && state.address) { // Check if fetch was successful
                    livePoolStates[state.address.toLowerCase()] = state;
                }
                // Errors are logged within the fetcher methods
            }
        } catch (error) { // Catch errors from Promise.all itself (should be rare)
            logger.error(`[PoolScanner v2.0] CRITICAL Error during Promise.all execution: ${error.message}`);
            if (typeof handleError === 'function') handleError(error, 'PoolScanner.fetchPoolStates.PromiseAll');
            return {}; // Return empty on critical error
        }

        const finalCount = Object.keys(livePoolStates).length;
        const attemptedCount = fetchPromises.length;
        logger.info(`[PoolScanner v2.0] Successfully processed states for ${finalCount} out of ${attemptedCount} attempted pools.`);
        if (finalCount < attemptedCount) {
             logger.warn(`[PoolScanner v2.0] ${attemptedCount - finalCount} pools failed to fetch/process. Check fetcher logs.`);
        }
        return livePoolStates;
    } // --- End fetchPoolStates ---

    // --- Opportunity Finding Logic REMOVED ---
    // --- Price Calculation Helpers REMOVED ---

} // --- END PoolScanner Class ---

module.exports = { PoolScanner }; // Keep exporting the main class
