// /workspaces/arbitrum-flash/core/poolScanner.js
// --- REFACTORED VERSION 2.5 --- Added DODO Fetcher ---

const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler');

// --- Import Fetchers ---
const UniswapV3Fetcher = require('./fetchers/uniswapV3Fetcher');
const SushiSwapFetcher = require('./fetchers/sushiSwapFetcher');
const CamelotFetcher = require('./fetchers/camelotFetcher');
const DodoFetcher = require('./fetchers/dodoFetcher'); // <-- Import Dodo Fetcher
// --- Add imports for other fetchers (Balancer, etc.) here later ---

class PoolScanner {
    constructor(config, provider) {
        const logPrefix = '[PoolScanner v2.5]'; // Updated version
        logger.debug(`${logPrefix} Initializing...`);
        if (!config || !provider) { throw new ArbitrageError('PoolScanner requires config and provider.', 'INITIALIZATION_ERROR'); }
        this.config = config;
        this.provider = provider;

        // Instantiate Fetchers
        try {
            this.v3Fetcher = new UniswapV3Fetcher(provider);
            this.sushiFetcher = new SushiSwapFetcher(provider);
            this.camelotFetcher = new CamelotFetcher(provider);
            this.dodoFetcher = new DodoFetcher(provider); // <-- Instantiate Dodo Fetcher
        } catch (fetcherError) { logger.error(`${logPrefix} Failed to initialize fetchers: ${fetcherError.message}`); throw fetcherError; }
        logger.info(`${logPrefix} Initialized with V3, Sushi, Camelot, and Dodo Fetchers.`);
    }

    // --- safeFetchWrapper with Retry Logic (Unchanged from v2.4) ---
    async safeFetchWrapper(fetcherPromise, poolInfo, maxRetries = 2, initialDelay = 500) {
        const poolDesc = `${poolInfo.dexType || 'Unknown DEX'} pool ${poolInfo.address || poolInfo.name || 'N/A'} (${poolInfo.token0Symbol || '?'}/${poolInfo.token1Symbol || '?'})`;
        let attempt = 0;
        while (attempt <= maxRetries) {
            try {
                // *** We await the promise HERE inside the wrapper ***
                const state = await fetcherPromise;
                if (state && state.address && state.pairKey) {
                    if (attempt === 0) { logger.debug(`[PoolScanner SafeFetch] Successfully fetched ${poolDesc}`); }
                    else { logger.info(`[PoolScanner SafeFetch] Successfully fetched ${poolDesc} on attempt ${attempt + 1}`); }
                    return state;
                } else if (state === null && attempt === 0) { logger.debug(`[PoolScanner SafeFetch] Fetcher for ${poolDesc} returned null.`); return null; }
                else if (attempt === 0) { logger.warn(`[PoolScanner SafeFetch] Fetcher for ${poolDesc} returned invalid/incomplete state (Attempt 1). Retrying...`); }
                else { logger.warn(`[PoolScanner SafeFetch] Fetcher for ${poolDesc} returned invalid state on attempt ${attempt + 1}.`); return null; }
            } catch (error) {
                logger.warn(`[PoolScanner SafeFetch] Error fetching ${poolDesc} (Attempt ${attempt + 1}/${maxRetries + 1}): ${error.message}`);
                if (attempt >= maxRetries) {
                     logger.error(`[PoolScanner SafeFetch] All ${maxRetries + 1} fetch attempts failed for ${poolDesc}. Last error: ${error.message}`);
                     if (typeof handleError === 'function') { handleError(error, `PoolScanner.Fetcher.FinalFail.${poolInfo.dexType || 'Unknown'}`); }
                     else { console.error("Emergency Log: handleError function not found..."); }
                     return null;
                }
                const delay = initialDelay * Math.pow(2, attempt);
                logger.warn(`[PoolScanner SafeFetch] Retrying fetch for ${poolDesc} in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
            attempt++;
        }
        logger.error(`[PoolScanner SafeFetch] Exited retry loop unexpectedly for ${poolDesc}.`);
        return null;
    }
    // --- *** ---

    /**
     * Fetches live states for all configured pools and builds a pair registry.
     */
    async fetchPoolStates(poolInfos) {
        const logPrefix = "[PoolScanner v2.5 fetchPoolStates]"; // Updated version
        logger.debug(`${logPrefix} Received ${poolInfos?.length ?? 0} poolInfos to fetch.`);
        if (!poolInfos || poolInfos.length === 0) { return { livePoolStatesMap: {}, pairRegistry: {} }; }
        logger.info(`${logPrefix} Delegating state fetching for ${poolInfos.length} pools...`);

        const fetchPromises = [];
        for (const poolInfo of poolInfos) {
            if (!poolInfo || !poolInfo.address || !poolInfo.dexType || !poolInfo.token0Symbol || !poolInfo.token1Symbol) { logger.warn(`${logPrefix} Skipping invalid poolInfo: ${JSON.stringify(poolInfo)}`); continue; }

            let fetcherInstance;
            let fetcherMethod = 'fetchPoolState'; // Default method name

            // --- *** ADDED DODO CASE & Fetcher Delegation Logic *** ---
            switch (poolInfo.dexType) {
                case 'uniswapV3':
                    fetcherInstance = this.v3Fetcher;
                    logger.debug(`${logPrefix} Creating V3 fetch promise for ${poolInfo.address}`);
                    break;
                case 'sushiswap':
                    fetcherInstance = this.sushiFetcher;
                    logger.debug(`${logPrefix} Creating Sushi fetch promise for ${poolInfo.address}`);
                    break;
                case 'camelot':
                    fetcherInstance = this.camelotFetcher;
                    logger.debug(`${logPrefix} Creating Camelot fetch promise for ${poolInfo.address}`);
                    break;
                case 'dodo': // Added DODO
                    fetcherInstance = this.dodoFetcher;
                    logger.debug(`${logPrefix} Creating DODO fetch promise for ${poolInfo.address}`);
                    break;
                // --- Add other cases here later ---
                default:
                    logger.warn(`${logPrefix} Skipping pool ${poolInfo.address}: Unsupported dexType '${poolInfo.dexType}'`);
                    continue; // Skip this poolInfo
            }
            // --- *** ---

            if (!fetcherInstance || typeof fetcherInstance[fetcherMethod] !== 'function') {
                 logger.error(`${logPrefix} Internal Error: No fetcher instance or method found for dexType '${poolInfo.dexType}'.`);
                 continue;
            }

            // Create the promise by calling the fetcher method
            const fetchPromise = fetcherInstance[fetcherMethod](poolInfo);

            // Pass the promise to safeFetchWrapper for retry handling
            fetchPromises.push(this.safeFetchWrapper(
                fetchPromise,
                poolInfo
            ));
        } // End loop

        if (fetchPromises.length === 0) { logger.warn(`${logPrefix} No valid pools to fetch.`); return { livePoolStatesMap: {}, pairRegistry: {} }; }

        const livePoolStatesMap = {}; const pairRegistry = {};
        const attemptedCount = fetchPromises.length;
        logger.info(`${logPrefix} Attempting to fetch states for ${attemptedCount} pools concurrently via Promise.all (with retries)...`);

        try {
            const results = await Promise.all(fetchPromises); // results contains state objects or null
            logger.info(`${logPrefix} Promise.all completed successfully.`);
            logger.debug(`${logPrefix} Processing ${results.length} results from Promise.all...`);
            for (const state of results) {
                if (state && state.address && state.pairKey) { // Ensure state is valid
                    const lowerCaseAddress = state.address.toLowerCase();
                    livePoolStatesMap[lowerCaseAddress] = state;
                    if (!pairRegistry[state.pairKey]) { pairRegistry[state.pairKey] = []; }
                    pairRegistry[state.pairKey].push(state);
                }
            }
        } catch (error) { /* ... unchanged critical error handling ... */ }

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
