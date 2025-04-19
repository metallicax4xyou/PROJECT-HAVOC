// utils/tickDataProvider.js - Cache Disabled
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
        // Cache disabled
        // this.wordCache = new Map();
        // this.cacheTTL = 5000;
        logger.warn('[LensTickDataProvider] Tick data cache is DISABLED for debugging.');
    }

    // Removed getCachedPopulatedTicks helper - direct calls now

    // Removed cleanupCache helper

    // getPopulatedTicksInRange calls TickLens directly now
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
                // --- Direct TickLens Call (No Cache) ---
                if (!this.tickLensContract) { throw new Error("TickLens contract instance is not initialized."); }
                logger.info(`${iterLogPrefix} Calling TickLens.getPopulatedTicksInWord... (Cache Disabled)`);
                const ticksInWord = await this.tickLensContract.getPopulatedTicksInWord(poolAddress, wordPos);
                logger.debug(`${iterLogPrefix} Received ${ticksInWord?.length ?? 0} ticks from TickLens.`);

                const processedTicks = [];
                 if (Array.isArray(ticksInWord)) {
                     ticksInWord.forEach(tickInfo => {
                         if (tickInfo && tickInfo.tick !== undefined && tickInfo.liquidityNet !== undefined) {
                             const tick = Number(tickInfo.tick);
                             const liquidityNet = BigInt(tickInfo.liquidityNet);
                             if (!isNaN(tick)) {
                                 processedTicks.push({ tick: tick, liquidityNet: liquidityNet });
                             } else { logger.warn(`${iterLogPrefix} Parsed tick is NaN from tickInfo: ${JSON.stringify(tickInfo)}`); }
                         } else { logger.warn(`${iterLogPrefix} Received invalid tickInfo structure: ${JSON.stringify(tickInfo)}`); }
                     });
                 } else { logger.warn(`${iterLogPrefix} TickLens call returned non-array data: ${JSON.stringify(ticksInWord)}`); }
                 // --- End Direct TickLens Call ---

                 // Filter ticks from this word to be within the requested range
                 processedTicks.forEach(tickInfo => {
                     if (tickInfo.tick >= tickLower && tickInfo.tick <= tickUpper) {
                         allPopulatedTicks.push(tickInfo);
                     }
                 });

            } catch (error) {
                logger.error(`${iterLogPrefix} FAILED call to TickLens. Error: ${error.message}`);
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
    // These now call getPopulatedTicksInRange directly for the required word

    async getTick(tick, tickSpacing, poolAddress) {
        const wordPos = tickToWord(tick, tickSpacing);
        if (wordPos === null) { logger.error(`[LensTickDataProvider Pool: ${poolAddress}] Could not calculate wordPos for getTick(${tick})`); return null; }

        // Calculate the range for the single word needed
        const tickLower = wordPos * tickSpacing * 256;
        const tickUpper = tickLower + tickSpacing * 256 - 1;

        logger.debug(`[LensTickDataProvider Pool: ${poolAddress}] getTick(${tick}) - Fetching word range [${tickLower}, ${tickUpper}] (WordPos: ${wordPos})`);
        let ticksInWord;
        try {
             // Directly fetch the required word
             ticksInWord = await this.getPopulatedTicksInRange(poolAddress, tickLower, tickUpper, tickSpacing);
        } catch (error) {
             logger.error(`[LensTickDataProvider Pool: ${poolAddress}] Error calling getPopulatedTicksInRange for getTick(${tick}): ${error.message}`);
             throw new Error(`Failed to fetch tick data for getTick: ${error.message}`);
        }
        const foundTick = ticksInWord.find(t => t.tick === tick);
        if (foundTick) {
             logger.debug(`[LensTickDataProvider Pool: ${poolAddress}] getTick(${tick}) - Found in fetched word ${wordPos}, liquidityNet=${foundTick.liquidityNet}`);
            return { liquidityNet: foundTick.liquidityNet };
        } else {
             logger.debug(`[LensTickDataProvider Pool: ${poolAddress}] getTick(${tick}) - Tick not found in fetched word ${wordPos}.`);
             return null; // Return null if tick is not initialized/found
        }
    }

    async nextInitializedTickWithinOneWord(tick, lte, tickSpacing, poolAddress) {
        const wordPos = tickToWord(tick, tickSpacing);
        if (wordPos === null) { logger.error(`[LensTickDataProvider Pool: ${poolAddress}] Could not calculate wordPos for nextInitializedTickWithinOneWord(${tick})`); return null; }

         // Calculate the range for the single word needed
         const tickLower = wordPos * tickSpacing * 256;
         const tickUpper = tickLower + tickSpacing * 256 - 1;

        logger.debug(`[LensTickDataProvider Pool: ${poolAddress}] nextInitializedTickWithinOneWord(${tick}, lte=${lte}) - Fetching word range [${tickLower}, ${tickUpper}] (WordPos: ${wordPos})`);
        let ticksInWord;
        try {
             // Directly fetch the required word
             ticksInWord = await this.getPopulatedTicksInRange(poolAddress, tickLower, tickUpper, tickSpacing);
        } catch(error){
            logger.error(`[LensTickDataProvider Pool: ${poolAddress}] Error calling getPopulatedTicksInRange for nextInitializedTickWithinOneWord(${tick}): ${error.message}`);
            throw new Error(`Failed to fetch tick data for nextInitializedTickWithinOneWord: ${error.message}`);
        }
        if (!ticksInWord || ticksInWord.length === 0) {
            logger.debug(`[LensTickDataProvider Pool: ${poolAddress}] No initialized ticks found in fetched word ${wordPos} for nextInitializedTickWithinOneWord(${tick}).`);
            return null;
        }

        ticksInWord.sort((a, b) => a.tick - b.tick); // Ensure sorted
        let resultTick = null;
        if (lte) {
            for (let i = ticksInWord.length - 1; i >= 0; i--) {
                if (ticksInWord[i].tick <= tick) { resultTick = ticksInWord[i].tick; break; }
            }
        } else {
            for (let i = 0; i < ticksInWord.length; i++) {
                if (ticksInWord[i].tick > tick) { resultTick = ticksInWord[i].tick; break; }
            }
        }
        logger.debug(`[LensTickDataProvider Pool: ${poolAddress}] nextInitializedTickWithinOneWord(${tick}, lte=${lte}) result: ${resultTick}`);
        return resultTick;
    }
}

module.exports = { LensTickDataProvider };
