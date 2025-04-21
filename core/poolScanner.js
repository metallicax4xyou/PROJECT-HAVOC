// /workspaces/arbitrum-flash/core/poolScanner.js
// --- REFACTORED VERSION 2.6 --- Added More Logging for fetchPoolStates Hang ---

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
        const logPrefix = '[PoolScanner v2.6]'; // Updated version
        /* ... unchanged constructor ... */
    }

    // --- safeFetchWrapper with Retry Logic (Add final error log) ---
    async safeFetchWrapper(fetcherPromise, poolInfo, maxRetries = 2, initialDelay = 500) {
        const poolDesc = `${poolInfo.dexType || 'Unknown DEX'} pool ${poolInfo.address || poolInfo.name || 'N/A'} (${poolInfo.token0Symbol || '?'}/${poolInfo.token1Symbol || '?'})`;
        let attempt = 0;
        while (attempt <= maxRetries) {
            try {
                const state = await fetcherPromise;
                if (state && state.address && state.pairKey) { /* ... success logging ... */ return state; }
                else if (state === null && attempt === 0) { /* ... null return ... */ return null; }
                else if (attempt === 0) { /* ... invalid state, retry ... */ }
                else { /* ... invalid state on retry ... */ return null; }
            } catch (error) {
                logger.warn(`[PoolScanner SafeFetch] Error fetching ${poolDesc} (Attempt ${attempt + 1}/${maxRetries + 1}): ${error.message}`);
                if (attempt >= maxRetries) {
                     logger.error(`[PoolScanner SafeFetch] All ${maxRetries + 1} fetch attempts FAILED for ${poolDesc}. Last error: ${error.message}`); // Log final failure clearly
                     // *** Log the stack trace too for the final error ***
                     console.error(`CONSOLE_LOG: Final fetch error for ${poolDesc}`, error);
                     // *** --- ***
                     if (typeof handleError === 'function') { handleError(error, `PoolScanner.Fetcher.FinalFail.${poolInfo.dexType || 'Unknown'}`); }
                     else { console.error("Emergency Log: handleError function not found..."); }
                     return null; // Return null after all retries fail
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
        const logPrefix = "[PoolScanner v2.6 fetchPoolStates]"; // Updated version
        /* ... unchanged start ... */
        logger.info(`${logPrefix} Delegating state fetching for ${poolInfos.length} pools...`);

        const fetchPromises = [];
        for (const poolInfo of poolInfos) { /* ... unchanged loop to build fetchPromises ... */ }

        if (fetchPromises.length === 0) { /* ... */ }

        const livePoolStatesMap = {}; const pairRegistry = {};
        const attemptedCount = fetchPromises.length;
        // --- *** ADDED LOG BEFORE PROMISE.ALL *** ---
        console.log(`CONSOLE_LOG: [${logPrefix}] About to call Promise.all for ${attemptedCount} fetch promises...`);
        logger.info(`${logPrefix} Attempting to fetch states for ${attemptedCount} pools concurrently via Promise.all (with retries)...`);
        // --- *** ---

        try {
            const results = await Promise.all(fetchPromises);
            // --- *** ADDED LOG AFTER PROMISE.ALL *** ---
            console.log(`CONSOLE_LOG: [${logPrefix}] Promise.all resolved successfully with ${results.length} results.`);
            logger.info(`${logPrefix} Promise.all completed successfully.`);
            // --- *** ---

            logger.debug(`${logPrefix} Processing ${results.length} results from Promise.all...`);
            for (const state of results) { /* ... unchanged result processing ... */ }

        } catch (error) {
             // --- *** ADDED LOG IN PROMISE.ALL CATCH *** ---
             console.error(`CONSOLE_LOG: [${logPrefix}] CRITICAL ERROR caught directly from Promise.all execution!`);
             console.error(error);
             // --- *** ---
             logger.error(`${logPrefix} CRITICAL UNEXPECTED Error during Promise.all execution: ${error.message}`);
             if (typeof handleError === 'function') { handleError(error, 'PoolScanner.fetchPoolStates.PromiseAll'); }
             else { console.error("Emergency Log: handleError function not found..."); }
             return { livePoolStatesMap: {}, pairRegistry: {} };
        }

        /* ... unchanged logging and return ... */
         const finalPoolCount = Object.keys(livePoolStatesMap).length;
         const finalPairCount = Object.keys(pairRegistry).length;
         logger.info(`${logPrefix} Successfully gathered states for ${finalPoolCount} out of ${attemptedCount} attempted pools.`);
         logger.info(`${logPrefix} Built Pair Registry with ${finalPairCount} unique canonical pairs.`);
         if (finalPoolCount < attemptedCount) { logger.warn(`${logPrefix} ${attemptedCount - finalPoolCount} pools failed during fetch/processing (check retry logs).`); }
         console.log(`CONSOLE_LOG: [${logPrefix}] Finished processing results. Returning map and registry.`); // Log end
         logger.debug(`${logPrefix} Returning livePoolStates map and pairRegistry.`);
         return { livePoolStatesMap, pairRegistry };
    } // --- End fetchPoolStates ---
} // --- END PoolScanner Class ---

module.exports = { PoolScanner };
