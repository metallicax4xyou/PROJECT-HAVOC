// utils/tickDataProvider.js
const { ethers } = require('ethers');
const logger = require('./logger');
const { tickToWord } = require('./tickUtils');
const tickLensAbi = require('../abis/TickLens.json');

class LensTickDataProvider {
    constructor(tickLensAddress, provider, chainId) {
        if (!tickLensAddress || !ethers.isAddress(tickLensAddress)) { throw new Error(`[LensTickDataProvider] Invalid or missing TICKLENS_ADDRESS provided: ${tickLensAddress}`); }
        if (!provider) { throw new Error(`[LensTickDataProvider] Provider instance is required.`); }
        if (!chainId) { logger.warn(`[LensTickDataProvider] Chain ID not provided during initialization.`); }
        this.tickLensAddress = tickLensAddress;
        this.provider = provider;
        try {
            this.tickLensContract = new ethers.Contract(this.tickLensAddress, tickLensAbi, this.provider);
            logger.info(`[LensTickDataProvider] Initialized with TickLens contract at ${this.tickLensAddress}`);
        } catch (e) {
            logger.error(`[LensTickDataProvider] FAILED to initialize ethers.Contract for TickLens: ${e.message}`);
            throw e;
        }
        // Add a cache for getPopulatedTicksInRange results to avoid redundant calls within the same simulation hop
        this.wordCache = new Map();
        this.cacheTTL = 5000; // Cache entries for 5 seconds
    }

    // Helper to manage the cache
    async getCachedPopulatedTicks(poolAddress, wordPos) {
        const cacheKey = `${poolAddress}-${wordPos}`;
        const cachedEntry = this.wordCache.get(cacheKey);

        if (cachedEntry && (Date.now() - cachedEntry.timestamp < this.cacheTTL)) {
            logger.debug(`[LensTickDataProvider Pool: ${poolAddress} WordPos: ${wordPos}] Cache HIT`);
            return cachedEntry.data;
        }

        logger.debug(`[LensTickDataProvider Pool: ${poolAddress} WordPos: ${wordPos}] Cache MISS or expired`);
        if (!this.tickLensContract) { throw new Error("TickLens contract instance is not initialized."); }

        logger.info(`[LensTickDataProvider Pool: ${poolAddress} WordPos: ${wordPos}] Calling TickLens.getPopulatedTicksInWord...`);
        const ticksInWord = await this.tickLensContract.getPopulatedTicksInWord(poolAddress, wordPos);
        logger.debug(`[LensTickDataProvider Pool: ${poolAddress} WordPos: ${wordPos}] Received ${ticksInWord?.length ?? 0} ticks from TickLens.`);

        const processedTicks = [];
        if (Array.isArray(ticksInWord)) {
            ticksInWord.forEach(tickInfo => {
                if (tickInfo && tickInfo.tick !== undefined && tickInfo.liquidityNet !== undefined) {
                    const tick = Number(tickInfo.tick);
                    const liquidityNet = BigInt(tickInfo.liquidityNet);
                    if (!isNaN(tick)) {
                        processedTicks.push({ tick: tick, liquidityNet: liquidityNet });
                    } else { logger.warn(`[LensTickDataProvider Pool: ${poolAddress} WordPos: ${wordPos}] Parsed tick is NaN from tickInfo: ${JSON.stringify(tickInfo)}`); }
                } else { logger.warn(`[LensTickDataProvider Pool: ${poolAddress} WordPos: ${wordPos}] Received invalid tickInfo structure: ${JSON.stringify(tickInfo)}`); }
            });
        } else { logger.warn(`[LensTickDataProvider Pool: ${poolAddress} WordPos: ${wordPos}] TickLens call returned non-array data: ${JSON.stringify(ticksInWord)}`); }

        // Store in cache before returning
        this.wordCache.set(cacheKey, { data: processedTicks, timestamp: Date.now() });
        // Clean up old cache entries periodically (optional, could do this elsewhere or less frequently)
        this.cleanupCache();

        return processedTicks;
    }

     // Simple cache cleanup
     cleanupCache() {
         const now = Date.now();
         for (const [key, entry] of this.wordCache.entries()) {
             if (now - entry.timestamp >= this.cacheTTL) {
                 this.wordCache.delete(key);
             }
         }
     }


    // getPopulatedTicksInRange now uses the caching helper
    async getPopulatedTicksInRange(poolAddress, tickLower, tickUpper, tickSpacing) {
        const logPrefix = `[LensTickDataProvider Pool: ${poolAddress}]`;
        if (!ethers.isAddress(poolAddress)) { logger.error(`${logPrefix} Invalid pool address provided.`); return []; }
        if (tickLower == null || tickUpper == null || tickSpacing == null || tickLower >= tickUpper) { logger.warn(`${logPrefix} Invalid tick range/spacing. Skipping fetch.`); return []; }

        logger.debug(`${logPrefix} Requesting ticks in range [${tickLower}, ${tickUpper}], Spacing: ${tickSpacing}`);
        const wordLower = tickToWord(tickLower, tickSpacing);
        const wordUpper = tickToWord(tickUpper, tickSpacing);
        logger.debug(`${logPrefix} Calculated word range: [${wordLower}, ${wordUpper}]`);

        if (wordLower === null || wordUpper === null || wordUpper < wordLower) { logger.error(`${logPrefix} Invalid word boundaries. Skipping fetch.`); return []; }
        if (wordUpper - wordLower > 1000) { logger.warn(`${logPrefix} Calculated word range (${wordUpper - wordLower}) seems very large.`); }

        const allPopulatedTicks = [];
        for (let wordPos = wordLower; wordPos <= wordUpper; wordPos++) {
            const iterLogPrefix = `${logPrefix} WordPos: ${wordPos}`;
            try {
                 // Use the caching helper
                 const ticksFromCacheOrFetch = await this.getCachedPopulatedTicks(poolAddress, wordPos);

                 // Filter ticks from this word to be within the requested range
                 ticksFromCacheOrFetch.forEach(tickInfo => {
                     if (tickInfo.tick >= tickLower && tickInfo.tick <= tickUpper) {
                         allPopulatedTicks.push(tickInfo);
                     }
                 });

            } catch (error) {
                logger.error(`${iterLogPrefix} FAILED call via getCachedPopulatedTicks. Error: ${error.message}`);
                if (error.code === 'CALL_EXCEPTION') { logger.error(`${iterLogPrefix} CALL_EXCEPTION details: Action=${error.action}, Code=${error.code}, Reason=${error.reason}, Tx=${JSON.stringify(error.transaction)} Data=${error.data}`); }
                else { logger.error(`${iterLogPrefix} Non-CALL_EXCEPTION details: Code=${error.code}, ${JSON.stringify(error)}`); }
                logger.error(`${logPrefix} Aborting tick fetch for this range due to error.`);
                return []; // Return empty array on error
            }
        } // End for loop

        allPopulatedTicks.sort((a, b) => a.tick - b.tick);
        logger.info(`${logPrefix} Successfully processed ${allPopulatedTicks.length} populated ticks in range [${tickLower}, ${tickUpper}]`);
        return allPopulatedTicks;
    }


    // --- SDK TickProvider Interface Methods ---

    // *** MODIFIED getTick ***
    async getTick(tick, tickSpacing, poolAddress) {
        const wordPos = tickToWord(tick, tickSpacing);
        if (wordPos === null) {
             logger.error(`[LensTickDataProvider Pool: ${poolAddress}] Could not calculate wordPos for getTick(${tick})`);
             return null; // Indicate failure to get tick data
        }

        logger.debug(`[LensTickDataProvider Pool: ${poolAddress}] getTick(${tick}) - Fetching/getting word ${wordPos} from cache`);
        let ticksInWord;
        try {
             ticksInWord = await this.getCachedPopulatedTicks(poolAddress, wordPos);
        } catch (error) {
             logger.error(`[LensTickDataProvider Pool: ${poolAddress}] Error calling getCachedPopulatedTicks for getTick(${tick}): ${error.message}`);
             // Propagate the error or return null? Returning null might hide issues. Let's rethrow.
             throw new Error(`Failed to fetch tick data for getTick: ${error.message}`);
        }

        const foundTick = ticksInWord.find(t => t.tick === tick);

        if (foundTick) {
             logger.trace(`[LensTickDataProvider Pool: ${poolAddress}] getTick(${tick}) - Found in word ${wordPos}, liquidityNet=${foundTick.liquidityNet}`);
            return { liquidityNet: foundTick.liquidityNet }; // Return structure expected by SDK for initialized tick
        } else {
             logger.trace(`[LensTickDataProvider Pool: ${poolAddress}] getTick(${tick}) - Tick not found in fetched word ${wordPos}.`);
             // *** Return null if tick is not initialized/found ***
             return null;
        }
    }

    // *** nextInitializedTickWithinOneWord - Logic mostly same, uses cache ***
    async nextInitializedTickWithinOneWord(tick, lte, tickSpacing, poolAddress) {
        const wordPos = tickToWord(tick, tickSpacing);
         if (wordPos === null) {
             logger.error(`[LensTickDataProvider Pool: ${poolAddress}] Could not calculate wordPos for nextInitializedTickWithinOneWord(${tick})`);
             return null;
         }

        logger.debug(`[LensTickDataProvider Pool: ${poolAddress}] nextInitializedTickWithinOneWord(${tick}, lte=${lte}) - Fetching/getting word ${wordPos} from cache`);
        let ticksInWord;
        try {
            ticksInWord = await this.getCachedPopulatedTicks(poolAddress, wordPos);
        } catch(error){
            logger.error(`[LensTickDataProvider Pool: ${poolAddress}] Error calling getCachedPopulatedTicks for nextInitializedTickWithinOneWord(${tick}): ${error.message}`);
            throw new Error(`Failed to fetch tick data for nextInitializedTickWithinOneWord: ${error.message}`);
        }


        if (!ticksInWord || ticksInWord.length === 0) {
            logger.trace(`[LensTickDataProvider Pool: ${poolAddress}] No initialized ticks found in word ${wordPos} for nextInitializedTickWithinOneWord(${tick}).`);
            return null;
        }

        // Sort ticks just in case they aren't (cache should preserve order, but safety)
        ticksInWord.sort((a, b) => a.tick - b.tick);

        let resultTick = null;
        if (lte) {
            // Find the tick <= current tick
            for (let i = ticksInWord.length - 1; i >= 0; i--) {
                if (ticksInWord[i].tick <= tick) {
                    resultTick = ticksInWord[i].tick;
                    break;
                }
            }
        } else {
            // Find the tick > current tick
            for (let i = 0; i < ticksInWord.length; i++) {
                if (ticksInWord[i].tick > tick) {
                    resultTick = ticksInWord[i].tick;
                    break;
                }
            }
        }
        logger.trace(`[LensTickDataProvider Pool: ${poolAddress}] nextInitializedTickWithinOneWord(${tick}, lte=${lte}) result: ${resultTick}`);
        return resultTick;
    }
}

module.exports = { LensTickDataProvider };
