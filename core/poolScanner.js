// /workspaces/arbitrum-flash/core/poolScanner.js
// --- REFACTORED VERSION 2.3 --- Added Pair Registry Creation ---

const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler');

// --- Import Fetchers ---
const UniswapV3Fetcher = require('./fetchers/uniswapV3Fetcher');
const SushiSwapFetcher = require('./fetchers/sushiSwapFetcher');
const CamelotFetcher = require('./fetchers/camelotFetcher');
// --- Add imports for other fetchers (DODO, Balancer, etc.) here later ---

class PoolScanner {
    constructor(config, provider) {
        const logPrefix = '[PoolScanner v2.3]'; // Updated version
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
            this.camelotFetcher = new CamelotFetcher(provider);
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
        const poolDesc = `${poolInfo.dexType || 'Unknown DEX'} pool ${poolInfo.address || poolInfo.name || 'N/A'} (${poolInfo.token0Symbol || '?'}/${poolInfo.token1Symbol || '?'})`;
        try {
            const state = await fetcherPromise;
            if (state && state.address && state.pairKey) { // Also ensure pairKey exists for registry
                 logger.debug(`[PoolScanner SafeFetch] Successfully fetched ${poolDesc}`);
                 return state;
            } else if (state === null) {
                 logger.debug(`[PoolScanner SafeFetch] Fetcher for ${poolDesc} returned null.`);
                 return null;
            } else {
                 logger.warn(`[PoolScanner SafeFetch] Fetcher for ${poolDesc} resolved but returned invalid/incomplete state (Missing address or pairKey?). State: ${JSON.stringify(state)}`);
                 return null;
            }
        } catch (error) {
            logger.error(`[PoolScanner SafeFetch] Error fetching ${poolDesc}: ${error.message}`);
             if (typeof handleError === 'function') {
                handleError(error, `PoolScanner.Fetcher.${poolInfo.dexType || 'Unknown'}`);
            } else { console.error("Emergency Log: handleError function not found in PoolScanner.safeFetchWrapper"); }
            return null;
        }
    }

    /**
     * Fetches live states for all configured pools and builds a pair registry.
     * @param {Array<object>} poolInfos Array of pool configuration objects from config.
     * @returns {Promise<{livePoolStatesMap: object, pairRegistry: object}>} An object containing:
     *      - livePoolStatesMap: Map of poolAddress.toLowerCase() to its live state object.
     *      - pairRegistry: Map of canonicalPairKey to an array of live state objects for that pair.
     */
    async fetchPoolStates(poolInfos) {
        const logPrefix = "[PoolScanner v2.3 fetchPoolStates]"; // Updated version
        logger.debug(`${logPrefix} Received ${poolInfos?.length ?? 0} poolInfos to fetch.`);
        if (!poolInfos || poolInfos.length === 0) {
            logger.warn(`${logPrefix} No pool configurations provided.`);
            return { livePoolStatesMap: {}, pairRegistry: {} }; // Return empty objects
        }
        logger.info(`${logPrefix} Delegating state fetching for ${poolInfos.length} pools...`);

        const fetchPromises = [];
        for (const poolInfo of poolInfos) {
             // Basic check for address and dexType which are essential
            if (!poolInfo || !poolInfo.address || !poolInfo.dexType) {
                logger.warn(`${logPrefix} Skipping invalid poolInfo (missing address or dexType): ${JSON.stringify(poolInfo)}`);
                continue;
            }
            // Also need token symbols to resolve tokens and generate pairKey
             if (!poolInfo.token0Symbol || !poolInfo.token1Symbol) {
                  logger.warn(`${logPrefix} Skipping invalid poolInfo (missing token symbols): ${JSON.stringify(poolInfo)}`);
                  continue;
              }

            let fetcherPromise;
            // Delegate based on dexType
            switch (poolInfo.dexType) {
                case 'uniswapV3':
                    logger.debug(`${logPrefix} Creating V3 fetch promise for ${poolInfo.address}`);
                    fetcherPromise = this.v3Fetcher.fetchPoolState(poolInfo);
                    break;
                case 'sushiswap':
                    logger.debug(`${logPrefix} Creating Sushi fetch promise for ${poolInfo.address}`);
                    fetcherPromise = this.sushiFetcher.fetchPoolState(poolInfo);
                    break;
                case 'camelot':
                    logger.debug(`${logPrefix} Creating Camelot fetch promise for ${poolInfo.address}`);
                    fetcherPromise = this.camelotFetcher.fetchPoolState(poolInfo);
                    break;
                // --- Add cases for other dexTypes here later ---
                default:
                    logger.warn(`${logPrefix} Skipping pool ${poolInfo.address}: Unsupported dexType '${poolInfo.dexType}'`);
                    continue; // Skip loop iteration
            }
            fetchPromises.push(this.safeFetchWrapper(fetcherPromise, poolInfo));
        }

        if (fetchPromises.length === 0) {
            logger.warn(`${logPrefix} No valid pools found to fetch states for after filtering.`);
            return { livePoolStatesMap: {}, pairRegistry: {} }; // Return empty objects
        }

        const livePoolStatesMap = {};
        const pairRegistry = {}; // Initialize the pair registry
        const attemptedCount = fetchPromises.length;
        logger.info(`${logPrefix} Attempting to fetch states for ${attemptedCount} pools concurrently via Promise.all...`);

        try {
            const results = await Promise.all(fetchPromises);
            logger.info(`${logPrefix} Promise.all completed successfully.`);

            logger.debug(`${logPrefix} Processing ${results.length} results from Promise.all...`);
            for (const state of results) {
                // Check if fetch was successful AND state contains necessary info (address, pairKey)
                if (state && state.address && state.pairKey) {
                    const lowerCaseAddress = state.address.toLowerCase();
                    livePoolStatesMap[lowerCaseAddress] = state;

                    // --- Build Pair Registry ---
                    if (!pairRegistry[state.pairKey]) {
                        pairRegistry[state.pairKey] = []; // Initialize array for this pair key
                    }
                    pairRegistry[state.pairKey].push(state); // Add the pool state to the array
                    // --- ---
                }
                // Errors logged inside safeFetchWrapper
            }
        } catch (error) {
            logger.error(`${logPrefix} CRITICAL UNEXPECTED Error during Promise.all execution: ${error.message}`);
             if (typeof handleError === 'function') { handleError(error, 'PoolScanner.fetchPoolStates.PromiseAll'); }
             else { console.error("Emergency Log: handleError function not found..."); }
            // Return empty objects on critical failure
            return { livePoolStatesMap: {}, pairRegistry: {} };
        }

        const finalPoolCount = Object.keys(livePoolStatesMap).length;
        const finalPairCount = Object.keys(pairRegistry).length;

        logger.info(`${logPrefix} Successfully gathered states for ${finalPoolCount} out of ${attemptedCount} attempted pools.`);
        logger.info(`${logPrefix} Built Pair Registry with ${finalPairCount} unique canonical pairs.`); // Log registry size

        if (finalPoolCount < attemptedCount) {
             logger.warn(`${logPrefix} ${attemptedCount - finalPoolCount} pools failed during fetch/processing. Check preceding logs for errors.`);
        }
        logger.debug(`${logPrefix} Returning livePoolStates map and pairRegistry.`);
        // --- *** MODIFIED RETURN VALUE *** ---
        return { livePoolStatesMap, pairRegistry };
    } // --- End fetchPoolStates ---

} // --- END PoolScanner Class ---

module.exports = { PoolScanner };
