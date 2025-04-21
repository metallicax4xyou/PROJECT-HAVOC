// /workspaces/arbitrum-flash/core/poolScanner.js
// --- REFACTORED VERSION 2.8 --- Corrected Fetcher Instantiation ---

const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler');

// --- Import Fetcher CLASSES ---
const UniswapV3Fetcher = require('./fetchers/uniswapV3Fetcher');
const SushiSwapFetcher = require('./fetchers/sushiSwapFetcher');
const CamelotFetcher = require('./fetchers/camelotFetcher');
const DodoFetcher = require('./fetchers/dodoFetcher');
// --- ---

class PoolScanner {
    /**
     * @param {object} config The main configuration object.
     * @param {ethers.Provider} provider Ethers provider instance.
     */
    constructor(config, provider) {
        const logPrefix = '[PoolScanner v2.8]'; // Updated version
        logger.debug(`${logPrefix} Initializing...`);
        if (!config || !provider) { throw new ArbitrageError('PoolScanner requires config and provider.', 'INITIALIZATION_ERROR'); }
        this.config = config;
        this.provider = provider;

        // --- *** Correctly Instantiate Fetchers HERE *** ---
        this.fetchers = {}; // Use an object map for fetchers
        try {
            // Instantiate each fetcher and store it in the map
            this.fetchers['uniswapV3'] = new UniswapV3Fetcher(provider);
            this.fetchers['sushiswap'] = new SushiSwapFetcher(provider);
            this.fetchers['camelot'] = new CamelotFetcher(provider);
            this.fetchers['dodo'] = new DodoFetcher(provider);
            // Add other fetchers here later:
            // this.fetchers['balancer'] = new BalancerFetcher(provider);

            // Log successful initialization
            logger.info(`${logPrefix} Initialized with fetchers for: ${Object.keys(this.fetchers).join(', ')}`);

        } catch (fetcherError) {
            logger.error(`${logPrefix} Failed to initialize one or more fetchers: ${fetcherError.message}`);
            // Decide if partial initialization is okay or if we should throw
            // For now, log the error but continue - some DEXs might still work
             handleError(fetcherError, 'PoolScanner.FetcherInit');
             // Or: throw fetcherError; // Make it fatal if all fetchers are required
        }
        // --- *** ---
    }

    // --- safeFetchWrapper (Unchanged from v2.6) ---
    async safeFetchWrapper(fetcherPromise, poolInfo, maxRetries = 2, initialDelay = 500) { /* ... unchanged ... */ }
    // --- *** ---

    /**
     * Fetches live states for all configured pools and builds a pair registry.
     */
    async fetchPoolStates(poolInfos) {
        const logPrefix = "[PoolScanner v2.8 fetchPoolStates]"; // Updated version
        logger.debug(`${logPrefix} Received ${poolInfos?.length ?? 0} poolInfos to fetch.`);
        if (!poolInfos || poolInfos.length === 0) { return { livePoolStatesMap: {}, pairRegistry: {} }; }

        // --- *** Added Check for Initialized Fetchers *** ---
        if (!this.fetchers || Object.keys(this.fetchers).length === 0) {
             logger.error(`${logPrefix} No fetchers were initialized successfully in the constructor! Cannot fetch pool states.`);
             return { livePoolStatesMap: {}, pairRegistry: {} }; // Cannot proceed
        }
        // --- *** ---

        logger.info(`${logPrefix} Delegating state fetching for ${poolInfos.length} pools...`);

        const fetchPromises = [];
        let skippedCount = 0;

        for (let i = 0; i < poolInfos.length; i++) {
            const poolInfo = poolInfos[i];
            // logger.debug(`${logPrefix} LOOP ${i + 1}/${poolInfos.length} - Processing poolInfo: ${JSON.stringify(poolInfo)}`); // Keep disabled unless needed

            // Basic checks
            if (!poolInfo || !poolInfo.address || !poolInfo.dexType || !poolInfo.token0Symbol || !poolInfo.token1Symbol) { logger.warn(`${logPrefix} Skipping invalid poolInfo ${i + 1}`); skippedCount++; continue; }

            // --- *** Get Fetcher Instance from Map *** ---
            const fetcherInstance = this.fetchers[poolInfo.dexType];
            // --- *** ---

            let fetcherMethod = 'fetchPoolState';

            // Check if fetcherInstance exists for the dexType AND has the required method
            if (!fetcherInstance) {
                 logger.warn(`${logPrefix} LOOP ${i + 1} - Skipping pool ${poolInfo.address}: No registered fetcher for dexType '${poolInfo.dexType}'.`);
                 skippedCount++; continue;
            }
            if (typeof fetcherInstance[fetcherMethod] !== 'function') {
                 logger.error(`${logPrefix} LOOP ${i + 1} - Skipping pool ${poolInfo.address}: Fetcher '${fetcherInstance.constructor.name}' missing method '${fetcherMethod}'.`);
                 skippedCount++; continue;
             }

            // Create the promise
            const fetchPromise = fetcherInstance[fetcherMethod](poolInfo);

            // Push to array
            fetchPromises.push(this.safeFetchWrapper(fetchPromise, poolInfo));
            // logger.debug(`${logPrefix} LOOP ${i + 1} - Fetch promise added for ${poolInfo.address}. Current promise count: ${fetchPromises.length}`); // Disable verbose log

        } // End loop

        logger.debug(`${logPrefix} Finished iterating poolInfos. Total Skipped: ${skippedCount}. Promises created: ${fetchPromises.length}`);

        if (fetchPromises.length === 0) { /* ... */ return { livePoolStatesMap: {}, pairRegistry: {} }; }

        /* ... unchanged Promise.all logic and return ... */
         const livePoolStatesMap = {}; const pairRegistry = {};
         const attemptedCount = fetchPromises.length;
         logger.info(`${logPrefix} Attempting to fetch states for ${attemptedCount} pools concurrently via Promise.all (with retries)...`);
         try {
             const results = await Promise.all(fetchPromises);
             logger.info(`${logPrefix} Promise.all completed successfully.`);
             // logger.debug(`${logPrefix} Processing ${results.length} results...`); // Verbose
             for (const state of results) { if (state && state.address && state.pairKey) { /* ... populate maps ... */ } }
         } catch (error) { /* ... critical error handling ... */ }
         const finalPoolCount = Object.keys(livePoolStatesMap).length;
         const finalPairCount = Object.keys(pairRegistry).length;
         logger.info(`${logPrefix} Successfully gathered states for ${finalPoolCount} out of ${attemptedCount} attempted pools.`);
         logger.info(`${logPrefix} Built Pair Registry with ${finalPairCount} unique canonical pairs.`);
         if (finalPoolCount < attemptedCount) { logger.warn(`${logPrefix} ${attemptedCount - finalPoolCount} pools failed fetch/processing.`); }
         logger.debug(`${logPrefix} Returning results.`);
         return { livePoolStatesMap, pairRegistry };

    } // --- End fetchPoolStates ---
} // --- END PoolScanner Class ---

module.exports = { PoolScanner };
