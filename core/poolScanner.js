// /workspaces/arbitrum-flash/core/poolScanner.js
// --- REFACTORED VERSION 2.2 --- Added Camelot Fetcher ---

const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler');

// --- Import Fetchers ---
const UniswapV3Fetcher = require('./fetchers/uniswapV3Fetcher');
const SushiSwapFetcher = require('./fetchers/sushiSwapFetcher');
const CamelotFetcher = require('./fetchers/camelotFetcher'); // <-- Import Camelot Fetcher
// --- Add imports for other fetchers (DODO, Balancer, etc.) here later ---

class PoolScanner {
    constructor(config, provider) {
        const logPrefix = '[PoolScanner v2.2]'; // Updated version
        logger.debug(`${logPrefix} Initializing...`);
        if (!config || !provider) {
            throw new ArbitrageError('PoolScanner requires config and provider.', 'INITIALIZATION_ERROR');
        }
        this.config = config;
        this.provider = provider;

        // Instantiate Fetchers
        try {
            this.v3Fetcher = new UniswapV3Fetcher(provider);
            this.sushiFetcher = new SushiSwapFetcher(provider);
            this.camelotFetcher = new CamelotFetcher(provider); // <-- Instantiate Camelot Fetcher
            // --- Instantiate other fetchers here later ---
        } catch (fetcherError) {
            logger.error(`${logPrefix} Failed to initialize fetchers: ${fetcherError.message}`);
            throw fetcherError;
        }
        logger.info(`${logPrefix} Initialized with V3, Sushi, and Camelot Fetchers.`);
    }

    /**
     * Wraps an individual fetcher promise to ensure it always resolves,
     * logging any errors internally.
     * @param {Promise} fetcherPromise The promise returned by the fetcher.
     * @param {object} poolInfo The configuration info for the pool being fetched.
     * @returns {Promise<object|null>} Resolves with the pool state or null if an error occurred.
     */
    async safeFetchWrapper(fetcherPromise, poolInfo) {
        // Use dexType and address/name for description
        const poolDesc = `${poolInfo.dexType || 'Unknown DEX'} pool ${poolInfo.address || poolInfo.name || 'N/A'} (${poolInfo.token0Symbol || '?'}/${poolInfo.token1Symbol || '?'})`;
        try {
            const state = await fetcherPromise;
            if (state && state.address) {
                 logger.debug(`[PoolScanner SafeFetch] Successfully fetched ${poolDesc}`);
                 return state;
            } else if (state === null) {
                 // Fetcher explicitly returned null (likely logged its own warning)
                 logger.debug(`[PoolScanner SafeFetch] Fetcher for ${poolDesc} returned null.`);
                 return null;
            }
             else {
                 // This case might indicate the fetcher resolved successfully but returned invalid data
                 logger.warn(`[PoolScanner SafeFetch] Fetcher for ${poolDesc} resolved but returned invalid/incomplete state.`);
                 return null;
            }
        } catch (error) {
            logger.error(`[PoolScanner SafeFetch] Error fetching ${poolDesc}: ${error.message}`);
             // Use global handler for unexpected fetcher errors - check if handleError exists
             if (typeof handleError === 'function') {
                handleError(error, `PoolScanner.Fetcher.${poolInfo.dexType || 'Unknown'}`);
            } else {
                console.error("Emergency Log: handleError function not found in PoolScanner.safeFetchWrapper");
            }
            return null; // Resolve with null on error to prevent Promise.all rejection
        }
    }

    /**
     * Fetches live states for all configured pools using dedicated fetchers.
     * @param {Array<object>} poolInfos Array of pool configuration objects from config.
     * @returns {Promise<object>} A map of poolAddress.toLowerCase() to its live state object, or an empty object if fetch fails critically.
     */
    async fetchPoolStates(poolInfos) {
        const logPrefix = "[PoolScanner v2.2 fetchPoolStates]"; // Updated version
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
            // Delegate to the appropriate fetcher based on dexType
            if (poolInfo.dexType === 'uniswapV3') {
                logger.debug(`${logPrefix} Creating V3 fetch promise for ${poolInfo.address}`);
                fetcherPromise = this.v3Fetcher.fetchPoolState(poolInfo);
            } else if (poolInfo.dexType === 'sushiswap') {
                logger.debug(`${logPrefix} Creating Sushi fetch promise for ${poolInfo.address}`);
                fetcherPromise = this.sushiFetcher.fetchPoolState(poolInfo);
            } else if (poolInfo.dexType === 'camelot') { // <-- Add delegation for Camelot
                logger.debug(`${logPrefix} Creating Camelot fetch promise for ${poolInfo.address}`);
                fetcherPromise = this.camelotFetcher.fetchPoolState(poolInfo);
            // --- Add 'else if' blocks for other dexTypes here later ---
            // else if (poolInfo.dexType === 'dodo') { ... }
            // else if (poolInfo.dexType === 'balancer') { ... }
            }
             else {
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
            const results = await Promise.all(fetchPromises);
            logger.info(`${logPrefix} Promise.all completed successfully.`);

            // Process results (results array contains state objects or null)
             logger.debug(`${logPrefix} Processing ${results.length} results from Promise.all...`);
            let successCount = 0;
            for (const state of results) {
                if (state && state.address) { // Check if fetch was successful and returned valid state
                    // Use lowercase address as key for consistency
                    livePoolStates[state.address.toLowerCase()] = state;
                    successCount++;
                }
                // Individual errors were logged inside safeFetchWrapper
            }
        } catch (error) { // Catch errors from Promise.all itself (should be very rare now)
            logger.error(`${logPrefix} CRITICAL UNEXPECTED Error during Promise.all execution: ${error.message}`);
             if (typeof handleError === 'function') {
                 handleError(error, 'PoolScanner.fetchPoolStates.PromiseAll');
            } else {
                 console.error("Emergency Log: handleError function not found in PoolScanner.fetchPoolStates catch block");
            }
            // Depending on severity, maybe return partial results or empty object
            // return livePoolStates; // Return whatever was collected
            return {}; // Return empty on critical failure
        }

        const finalCount = Object.keys(livePoolStates).length; // Count successful fetches

        logger.info(`${logPrefix} Successfully gathered states for ${finalCount} out of ${attemptedCount} attempted pools.`);
        if (finalCount < attemptedCount) {
             logger.warn(`${logPrefix} ${attemptedCount - finalCount} pools failed during fetch/processing. Check preceding logs for errors.`);
        }
        logger.debug(`${logPrefix} Returning livePoolStates map with ${finalCount} entries.`);
        return livePoolStates;
    } // --- End fetchPoolStates ---

} // --- END PoolScanner Class ---

// Ensure PoolScanner is exported correctly if used elsewhere directly
// If only used by ArbitrageEngine, internal export might be fine.
// Common pattern:
module.exports = { PoolScanner };
// Or just: module.exports = PoolScanner; depending on usage.
