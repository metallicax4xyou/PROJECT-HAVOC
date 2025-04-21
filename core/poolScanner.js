// /workspaces/arbitrum-flash/core/poolScanner.js
// --- REFACTORED VERSION 2.7 --- Added Logging INSIDE fetchPoolStates Loop ---

const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler');

// --- Import Fetchers ---
const UniswapV3Fetcher = require('./fetchers/uniswapV3Fetcher');
const SushiSwapFetcher = require('./fetchers/sushiSwapFetcher');
const CamelotFetcher = require('./fetchers/camelotFetcher');
const DodoFetcher = require('./fetchers/dodoFetcher');
// --- ---

class PoolScanner {
    constructor(config, provider) {
        const logPrefix = '[PoolScanner v2.7]'; // Updated version
        /* ... unchanged constructor ... */
         logger.info(`${logPrefix} Initialized with V3, Sushi, Camelot, and Dodo Fetchers.`);
    }

    // --- safeFetchWrapper with Retry Logic (Unchanged from v2.4) ---
    async safeFetchWrapper(fetcherPromise, poolInfo, maxRetries = 2, initialDelay = 500) { /* ... unchanged ... */ }
    // --- *** ---

    /**
     * Fetches live states for all configured pools and builds a pair registry.
     */
    async fetchPoolStates(poolInfos) {
        const logPrefix = "[PoolScanner v2.7 fetchPoolStates]"; // Updated version
        logger.debug(`${logPrefix} Received ${poolInfos?.length ?? 0} poolInfos to fetch.`);
        if (!poolInfos || poolInfos.length === 0) { return { livePoolStatesMap: {}, pairRegistry: {} }; }
        logger.info(`${logPrefix} Delegating state fetching for ${poolInfos.length} pools...`);

        const fetchPromises = [];
        let skippedCount = 0; // Count skipped pools

        // --- *** ADDED LOGGING INSIDE LOOP *** ---
        for (let i = 0; i < poolInfos.length; i++) { // Use index for logging
            const poolInfo = poolInfos[i];
            logger.debug(`${logPrefix} LOOP ${i + 1}/${poolInfos.length} - Processing poolInfo: ${JSON.stringify(poolInfo)}`);

            // Basic checks
            if (!poolInfo) { logger.warn(`${logPrefix} LOOP ${i + 1} - Skipping: poolInfo is null/undefined.`); skippedCount++; continue; }
            if (!poolInfo.address) { logger.warn(`${logPrefix} LOOP ${i + 1} - Skipping pool named '${poolInfo.name || 'N/A'}': Missing address.`); skippedCount++; continue; }
            if (!poolInfo.dexType) { logger.warn(`${logPrefix} LOOP ${i + 1} - Skipping pool ${poolInfo.address}: Missing dexType.`); skippedCount++; continue; }
            if (!poolInfo.token0Symbol || !poolInfo.token1Symbol) { logger.warn(`${logPrefix} LOOP ${i + 1} - Skipping pool ${poolInfo.address}: Missing token symbols.`); skippedCount++; continue; }
            logger.debug(`${logPrefix} LOOP ${i + 1} - Basic info valid for ${poolInfo.address}.`);

            let fetcherInstance;
            let fetcherMethod = 'fetchPoolState';

            // Delegate based on dexType
            logger.debug(`${logPrefix} LOOP ${i + 1} - Checking dexType: '${poolInfo.dexType}'`);
            switch (poolInfo.dexType) {
                case 'uniswapV3': fetcherInstance = this.v3Fetcher; break;
                case 'sushiswap': fetcherInstance = this.sushiFetcher; break;
                case 'camelot': fetcherInstance = this.camelotFetcher; break;
                case 'dodo': fetcherInstance = this.dodoFetcher; break;
                default:
                    logger.warn(`${logPrefix} LOOP ${i + 1} - Skipping pool ${poolInfo.address}: Unsupported dexType '${poolInfo.dexType}'`);
                    skippedCount++; continue;
            }
             logger.debug(`${logPrefix} LOOP ${i + 1} - Fetcher instance selected: ${fetcherInstance?.constructor?.name}`);


            // Check if fetcherInstance was assigned and has the method
            if (!fetcherInstance) {
                logger.error(`${logPrefix} LOOP ${i + 1} - Skipping: No fetcher instance assigned for dexType '${poolInfo.dexType}'.`);
                 skippedCount++; continue;
            }
             if (typeof fetcherInstance[fetcherMethod] !== 'function') {
                 logger.error(`${logPrefix} LOOP ${i + 1} - Skipping: Fetcher '${fetcherInstance.constructor.name}' missing method '${fetcherMethod}'.`);
                 skippedCount++; continue;
             }
             logger.debug(`${logPrefix} LOOP ${i + 1} - Fetcher instance and method valid.`);


            // Create the promise
            logger.debug(`${logPrefix} LOOP ${i + 1} - Calling fetcher method: ${fetcherInstance.constructor.name}.${fetcherMethod}(...)`);
            const fetchPromise = fetcherInstance[fetcherMethod](poolInfo);

            // Push to array
            fetchPromises.push(this.safeFetchWrapper(fetchPromise, poolInfo));
            logger.debug(`${logPrefix} LOOP ${i + 1} - Fetch promise added for ${poolInfo.address}. Current promise count: ${fetchPromises.length}`);

        } // End loop through poolInfos
        // --- *** ---

        logger.debug(`${logPrefix} Finished iterating poolInfos. Total Skipped: ${skippedCount}. Promises created: ${fetchPromises.length}`);

        if (fetchPromises.length === 0) {
             logger.warn(`${logPrefix} No valid fetch promises were created after filtering ${poolInfos?.length ?? 0} poolInfos.`);
             return { livePoolStatesMap: {}, pairRegistry: {} };
         }

        const livePoolStatesMap = {}; const pairRegistry = {};
        const attemptedCount = fetchPromises.length;
        console.log(`CONSOLE_LOG: [[PoolScanner v2.7 fetchPoolStates]] About to call Promise.all for ${attemptedCount} fetch promises...`); // Keep console log
        logger.info(`${logPrefix} Attempting to fetch states for ${attemptedCount} pools concurrently via Promise.all (with retries)...`);

        try {
            const results = await Promise.all(fetchPromises);
            console.log(`CONSOLE_LOG: [[PoolScanner v2.7 fetchPoolStates]] Promise.all resolved successfully with ${results.length} results.`); // Keep console log
            logger.info(`${logPrefix} Promise.all completed successfully.`);
            /* ... unchanged result processing ... */
        } catch (error) { /* ... unchanged critical error handling ... */ }

         /* ... unchanged logging and return ... */
          const finalPoolCount = Object.keys(livePoolStatesMap).length;
          const finalPairCount = Object.keys(pairRegistry).length;
          logger.info(`${logPrefix} Successfully gathered states for ${finalPoolCount} out of ${attemptedCount} attempted pools.`);
          logger.info(`${logPrefix} Built Pair Registry with ${finalPairCount} unique canonical pairs.`);
          if (finalPoolCount < attemptedCount) { logger.warn(`${logPrefix} ${attemptedCount - finalPoolCount} pools failed during fetch/processing (check retry logs).`); }
          console.log(`CONSOLE_LOG: [[PoolScanner v2.7 fetchPoolStates]] Finished processing results. Returning map and registry.`); // Keep console log
          logger.debug(`${logPrefix} Returning livePoolStates map and pairRegistry.`);
          return { livePoolStatesMap, pairRegistry };
    } // --- End fetchPoolStates ---
} // --- END PoolScanner Class ---

module.exports = { PoolScanner };
