// utils/tickDataProvider.js
// --- VERSION UPDATED TO USE TickCache ---

const { ethers } = require('ethers'); // Ethers v6+
const logger = require('./logger');
const { tickToWord } = require('./tickUtils');
const tickLensAbi = require('../abis/TickLens.json');
const JSBI = require('jsbi');
const tickCache = require('./tickCache'); // Import the singleton cache instance

class LensTickDataProvider {
    constructor(tickLensAddress, provider, chainId, poolAddress) {
        // Ensure poolAddress is checksummed for consistent cache keys
        try {
            this.poolAddress = ethers.getAddress(poolAddress);
        } catch (e) {
             throw new Error(`[LensTickDataProvider] Invalid poolAddress provided: ${poolAddress}`);
        }

        const logPrefix = `[LensTickDataProvider Pool: ${this.poolAddress}]`;

        if (!tickLensAddress || !ethers.isAddress(tickLensAddress)) { throw new Error(`[LensTickDataProvider] Invalid TICKLENS_ADDRESS: ${tickLensAddress}`); }
        if (!provider) { throw new Error(`${logPrefix} Provider instance is required.`); }
        if (!chainId) { logger.warn(`${logPrefix} Chain ID not provided during initialization.`); }

        this.tickLensAddress = tickLensAddress;
        this.provider = provider;
        this.tickSpacing = null; // Will be set when needed

        try {
            this.tickLensContract = new ethers.Contract(this.tickLensAddress, tickLensAbi.abi || tickLensAbi, this.provider);
            logger.info(`${logPrefix} Initialized with TickLens contract at ${this.tickLensAddress}`);
        } catch (e) {
            logger.error(`${logPrefix} FAILED to initialize ethers.Contract for TickLens: ${e.message}`, e);
            throw e;
        }
        // No longer warn about cache disabled - it's now enabled by default
    }

    /**
     * Internal method to fetch and process ticks for a specific word position.
     * This method interacts with the cache.
     * @param {number} wordPos The word position to fetch.
     * @returns {Promise<Array<{tick: number, liquidityNet: bigint}> | null>} Processed ticks or null on error.
     */
    async _getTicksForWord(wordPos) {
        const logPrefix = `[LensTickDataProvider Pool: ${this.poolAddress}, Word: ${wordPos}]`;

        // Use the tickCache.getTicks method
        return tickCache.getTicks(this.poolAddress, wordPos, async () => {
            // This async function is the 'fetchFn' executed only on cache MISS
            logger.debug(`${logPrefix} Fetching from TickLens contract...`);
            try {
                if (!this.tickLensContract) { throw new Error(`TickLens contract instance is not initialized.`); }

                const rawTicksInWord = await this.tickLensContract.getPopulatedTicksInWord(this.poolAddress, wordPos);
                logger.debug(`${logPrefix} Received ${rawTicksInWord?.length ?? 0} raw ticks from TickLens.`);

                const processedTicks = [];
                 if (Array.isArray(rawTicksInWord)) {
                     rawTicksInWord.forEach(tickInfo => {
                         // Validate structure before accessing properties
                         if (tickInfo && typeof tickInfo.tick !== 'undefined' && typeof tickInfo.liquidityNet !== 'undefined') {
                             try {
                                 const tick = Number(tickInfo.tick); // Convert from BN/BigInt if needed
                                 const liquidityNet = ethers.toBigInt(tickInfo.liquidityNet); // Ensure BigInt
                                 if (!isNaN(tick)) {
                                     processedTicks.push({ tick: tick, liquidityNet: liquidityNet });
                                 } else { logger.warn(`${logPrefix} Parsed tick is NaN from tickInfo: ${JSON.stringify(tickInfo)}`); }
                             } catch (conversionError) {
                                  logger.warn(`${logPrefix} Error converting tick/liquidityNet: ${conversionError.message}`, tickInfo);
                             }
                         } else { logger.warn(`${logPrefix} Received invalid tickInfo structure: ${JSON.stringify(tickInfo)}`); }
                     });
                     // Sort ticks by tick index - important for SDK logic
                     processedTicks.sort((a, b) => a.tick - b.tick);
                     logger.debug(`${logPrefix} Successfully processed ${processedTicks.length} ticks.`);
                     return processedTicks; // Return the processed array for caching
                 } else {
                     logger.warn(`${logPrefix} TickLens call returned non-array data: ${JSON.stringify(rawTicksInWord)}`);
                     return []; // Return empty array if fetch failed or returned invalid data
                 }
            } catch (error) {
                logger.error(`${logPrefix} FAILED call to TickLens.getPopulatedTicksInWord: ${error.message}`, error);
                 if (error.code === 'CALL_EXCEPTION') { logger.error(`${logPrefix} CALL_EXCEPTION details: Reason=${error.reason}, Tx=${JSON.stringify(error.transaction)} Data=${error.data}`); }
                return null; // Indicate fetch error to the cache wrapper
            }
        });
    }


    // getPopulatedTicksInRange now uses the internal _getTicksForWord method
    async getPopulatedTicksInRange(tickLower, tickUpper, tickSpacing) {
        const logPrefix = `[LensTickDataProvider Pool: ${this.poolAddress}]`;

        if (this.tickSpacing === null && tickSpacing) this.tickSpacing = tickSpacing;

        if (tickLower == null || tickUpper == null || tickSpacing == null || tickLower >= tickUpper) {
             logger.warn(`${logPrefix} Invalid tick range/spacing ([${tickLower}, ${tickUpper}], ${tickSpacing}).`);
             return [];
        }

        logger.debug(`${logPrefix} Getting populated ticks in range [${tickLower}, ${tickUpper}] using cache...`);
        const wordLower = tickToWord(tickLower, tickSpacing);
        const wordUpper = tickToWord(tickUpper, tickSpacing);
        if (wordLower === null || wordUpper === null || wordUpper < wordLower) {
             logger.error(`${logPrefix} Invalid word boundaries derived from ticks. Lower: ${tickLower}, Upper: ${tickUpper}, Spacing: ${tickSpacing}`);
             return [];
        }
        logger.debug(`${logPrefix} Calculated word range: [${wordLower}, ${wordUpper}]`);

        const allPopulatedTicks = [];
        let fetchErrorOccurred = false;

        for (let wordPos = wordLower; wordPos <= wordUpper; wordPos++) {
            const ticksFromWord = await this._getTicksForWord(wordPos); // Uses cache

            if (ticksFromWord === null) {
                 logger.error(`${logPrefix} Failed to get ticks for word ${wordPos} (fetch error). Aborting range fetch.`);
                 fetchErrorOccurred = true;
                 break; // Stop processing this range if one word fails
            }

            // Add all ticks from the word, we filter later
            allPopulatedTicks.push(...ticksFromWord);
        }

        if (fetchErrorOccurred) {
             return []; // Return empty if any word fetch failed
        }

        // Filter the combined list AFTER fetching all relevant words
        const filteredTicks = allPopulatedTicks.filter(tickInfo => tickInfo.tick >= tickLower && tickInfo.tick <= tickUpper);

        // Sort the final filtered list (might be redundant if individual words are sorted, but safe)
        filteredTicks.sort((a, b) => a.tick - b.tick);

        logger.info(`${logPrefix} Successfully retrieved/processed ${filteredTicks.length} populated ticks in range [${tickLower}, ${tickUpper}] (using cache).`);
        return filteredTicks;
    }

    // --- SDK TickProvider Interface Methods ---

    // getTick now uses the internal _getTicksForWord method
    async getTick(tick, tickSpacing) {
        const logPrefix = `[LensTickDataProvider Pool: ${this.poolAddress}]`;
        const wordPos = tickToWord(tick, tickSpacing);
        if (wordPos === null) { logger.error(`${logPrefix} Could not calculate wordPos for getTick(${tick})`); return null; }

        logger.debug(`${logPrefix} getTick(${tick}) - Getting data for WordPos: ${wordPos}`);
        const ticksInWord = await this._getTicksForWord(wordPos); // Uses cache

        if (ticksInWord === null) { // Check if fetch failed
            logger.error(`${logPrefix} Error fetching data for word ${wordPos} required by getTick(${tick}).`);
            // Depending on SDK tolerance, might need to throw here
            return null;
        }

        const foundTick = ticksInWord.find(t => t.tick === tick);
        if (foundTick) {
             // Convert native bigint to JSBI for the SDK
             const liquidityNetJSBI = JSBI.BigInt(foundTick.liquidityNet.toString());
             logger.debug(`${logPrefix} getTick(${tick}) - Found in word ${wordPos}, liquidityNet=${foundTick.liquidityNet} (Returning JSBI)`);
             return { liquidityNet: liquidityNetJSBI }; // Return JSBI as expected by SDK
        } else {
             logger.debug(`${logPrefix} getTick(${tick}) - Tick not found in word ${wordPos}. Returning null.`);
             return null; // Return null if tick is not initialized/found
        }
    }

    // nextInitializedTickWithinOneWord now uses the internal _getTicksForWord method
    async nextInitializedTickWithinOneWord(tick, lte, tickSpacing) {
        const logPrefix = `[LensTickDataProvider Pool: ${this.poolAddress}]`;
        const wordPos = tickToWord(tick, tickSpacing);
        if (wordPos === null) { logger.error(`${logPrefix} Could not calculate wordPos for nextInitializedTickWithinOneWord(${tick})`); return [null, false]; }

        logger.debug(`${logPrefix} nextInitializedTickWithinOneWord(${tick}, lte=${lte}) - Getting data for WordPos: ${wordPos}`);
        const ticksInWord = await this._getTicksForWord(wordPos); // Uses cache

         if (ticksInWord === null) { // Check if fetch failed
             logger.error(`${logPrefix} Error fetching data for word ${wordPos} required by nextInitializedTickWithinOneWord(${tick}).`);
             // SDK expects [number | null, boolean] - return indicating failure
             return [null, false];
         }
        if (ticksInWord.length === 0) {
            logger.debug(`${logPrefix} No initialized ticks found in word ${wordPos} for nextInitializedTickWithinOneWord(${tick}).`);
            return [null, false];
        }

        // Ticks in ticksInWord are already sorted by the processing step in _getTicksForWord
        let resultTick = null;
        let found = false;

        if (lte) {
            // Search backwards from the end of the sorted list
            for (let i = ticksInWord.length - 1; i >= 0; i--) {
                if (ticksInWord[i].tick <= tick) {
                    resultTick = ticksInWord[i].tick;
                    found = true;
                    break;
                }
            }
        } else {
            // Search forwards from the start of the sorted list
            for (let i = 0; i < ticksInWord.length; i++) {
                // Find the first tick *strictly greater* than the input tick
                if (ticksInWord[i].tick > tick) {
                    resultTick = ticksInWord[i].tick;
                    found = true;
                    break;
                }
            }
        }
        logger.debug(`${logPrefix} nextInitializedTickWithinOneWord(${tick}, lte=${lte}) result: ${resultTick}, Found: ${found}`);
        // The second element of the tuple indicates if the search *crossed* a word boundary,
        // which is always false here as we only searched within the single word fetched.
        return [resultTick, false];
    }
}

module.exports = { LensTickDataProvider };
