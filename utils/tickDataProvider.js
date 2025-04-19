// utils/tickDataProvider.js - Pool-Specific Instance Version
const { ethers } = require('ethers');
const logger = require('./logger');
const { tickToWord } = require('./tickUtils');
const tickLensAbi = require('../abis/TickLens.json');

class LensTickDataProvider {
    // Constructor now requires poolAddress
    constructor(tickLensAddress, provider, chainId, poolAddress) {
        const logPrefix = `[LensTickDataProvider Pool: ${poolAddress}]`; // Use poolAddress in initial logs

        if (!tickLensAddress || !ethers.isAddress(tickLensAddress)) { throw new Error(`[LensTickDataProvider] Invalid or missing TICKLENS_ADDRESS provided: ${tickLensAddress}`); }
        if (!provider) { throw new Error(`${logPrefix} Provider instance is required.`); }
        if (!ethers.isAddress(poolAddress)) { throw new Error(`${logPrefix} Invalid or missing poolAddress provided to constructor.`); } // Validate poolAddress
        // ChainId is optional but good practice
        if (!chainId) { logger.warn(`${logPrefix} Chain ID not provided during initialization.`); }

        this.tickLensAddress = tickLensAddress;
        this.provider = provider;
        this.poolAddress = poolAddress; // Store the pool address for this instance
        this.tickSpacing = null; // Will be set when fetching ticks if needed

        try {
            this.tickLensContract = new ethers.Contract(this.tickLensAddress, tickLensAbi, this.provider);
            logger.info(`${logPrefix} Initialized with TickLens contract at ${this.tickLensAddress}`);
        } catch (e) {
            logger.error(`${logPrefix} FAILED to initialize ethers.Contract for TickLens: ${e.message}`);
            throw e;
        }
        // Cache disabled
        logger.warn(`${logPrefix} Tick data cache is DISABLED for debugging.`);
    }

    // getPopulatedTicksInRange now uses this.poolAddress
    async getPopulatedTicksInRange(tickLower, tickUpper, tickSpacing) {
        const logPrefix = `[LensTickDataProvider Pool: ${this.poolAddress}]`; // Use instance's poolAddress

        // Store tickSpacing if we didn't have it
        if (this.tickSpacing === null && tickSpacing) this.tickSpacing = tickSpacing;

        if (tickLower == null || tickUpper == null || tickSpacing == null || tickLower >= tickUpper) {
             logger.warn(`${logPrefix} Invalid tick range/spacing ([${tickLower}, ${tickUpper}], ${tickSpacing}). Skipping fetch.`);
             return [];
        }

        logger.debug(`${logPrefix} Requesting ticks in range [${tickLower}, ${tickUpper}], Spacing: ${tickSpacing}`);
        const wordLower = tickToWord(tickLower, tickSpacing);
        const wordUpper = tickToWord(tickUpper, tickSpacing);
        logger.debug(`${logPrefix} Calculated word range: [${wordLower}, ${wordUpper}]`);

        if (wordLower === null || wordUpper === null || wordUpper < wordLower) {
             logger.error(`${logPrefix} Invalid word boundaries. Skipping fetch.`);
             return [];
        }
        // Simple sanity check for large ranges
        if (wordUpper - wordLower > 1000) { logger.warn(`${logPrefix} Calculated word range (${wordUpper - wordLower}) seems very large.`); }

        const allPopulatedTicks = [];
        for (let wordPos = wordLower; wordPos <= wordUpper; wordPos++) {
            const iterLogPrefix = `${logPrefix} WordPos: ${wordPos}`;
            try {
                // --- Direct TickLens Call (No Cache) ---
                if (!this.tickLensContract) { throw new Error(`${logPrefix} TickLens contract instance is not initialized.`); }
                logger.info(`${iterLogPrefix} Calling TickLens.getPopulatedTicksInWord... (Cache Disabled)`);
                // Use this.poolAddress here
                const ticksInWord = await this.tickLensContract.getPopulatedTicksInWord(this.poolAddress, wordPos);
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
                return []; // Return empty array on error for this range fetch
            }
        } // End for loop

        allPopulatedTicks.sort((a, b) => a.tick - b.tick); // Sort before returning
        logger.info(`${logPrefix} Successfully processed ${allPopulatedTicks.length} populated ticks in range [${tickLower}, ${tickUpper}]`);
        return allPopulatedTicks;
    }

    // --- SDK TickProvider Interface Methods ---
    // These no longer need poolAddress as input

    async getTick(tick, tickSpacing) { // removed poolAddress parameter
        const logPrefix = `[LensTickDataProvider Pool: ${this.poolAddress}]`; // Use instance's poolAddress
        const wordPos = tickToWord(tick, tickSpacing);
        if (wordPos === null) { logger.error(`${logPrefix} Could not calculate wordPos for getTick(${tick})`); return null; }

        const tickLower = wordPos * tickSpacing * 256;
        const tickUpper = tickLower + tickSpacing * 256 - 1;

        logger.debug(`${logPrefix} getTick(${tick}) - Fetching word range [${tickLower}, ${tickUpper}] (WordPos: ${wordPos})`);
        let ticksInWord;
        try {
             // Call internal method which now uses this.poolAddress
             ticksInWord = await this.getPopulatedTicksInRange(tickLower, tickUpper, tickSpacing);
        } catch (error) {
             logger.error(`${logPrefix} Error calling getPopulatedTicksInRange for getTick(${tick}): ${error.message}`);
             // Rethrow or handle as appropriate for the SDK interface contract
             throw new Error(`Failed to fetch tick data for getTick: ${error.message}`);
        }
        const foundTick = ticksInWord.find(t => t.tick === tick);
        if (foundTick) {
             logger.debug(`${logPrefix} getTick(${tick}) - Found in fetched word ${wordPos}, liquidityNet=${foundTick.liquidityNet}`);
            // The SDK expects an object with liquidityNet, or specific error/null handling
            return { liquidityNet: foundTick.liquidityNet };
        } else {
             logger.debug(`${logPrefix} getTick(${tick}) - Tick not found in fetched word ${wordPos}.`);
             // The SDK might expect null or a specific format if the tick is uninitialized
             return null; // Return null as per ITickDataProvider if not initialized
        }
    }

    async nextInitializedTickWithinOneWord(tick, lte, tickSpacing) { // removed poolAddress parameter
        const logPrefix = `[LensTickDataProvider Pool: ${this.poolAddress}]`; // Use instance's poolAddress
        const wordPos = tickToWord(tick, tickSpacing);
        if (wordPos === null) { logger.error(`${logPrefix} Could not calculate wordPos for nextInitializedTickWithinOneWord(${tick})`); return null; }

         const tickLower = wordPos * tickSpacing * 256;
         const tickUpper = tickLower + tickSpacing * 256 - 1;

        logger.debug(`${logPrefix} nextInitializedTickWithinOneWord(${tick}, lte=${lte}) - Fetching word range [${tickLower}, ${tickUpper}] (WordPos: ${wordPos})`);
        let ticksInWord;
        try {
             // Call internal method which now uses this.poolAddress
             ticksInWord = await this.getPopulatedTicksInRange(tickLower, tickUpper, tickSpacing);
        } catch(error){
            logger.error(`${logPrefix} Error calling getPopulatedTicksInRange for nextInitializedTickWithinOneWord(${tick}): ${error.message}`);
            throw new Error(`Failed to fetch tick data for nextInitializedTickWithinOneWord: ${error.message}`);
        }
        if (!ticksInWord || ticksInWord.length === 0) {
            logger.debug(`${logPrefix} No initialized ticks found in fetched word ${wordPos} for nextInitializedTickWithinOneWord(${tick}).`);
            // SDK interface expects [number | null, boolean]
            return [null, false]; // No tick found, boolean indicates if search exhausted word (true if no ticks, false shouldn't happen here)
        }

        // Already sorted by getPopulatedTicksInRange
        let resultTick = null;
        let found = false;

        if (lte) {
            // Find the closest tick <= the input tick
            for (let i = ticksInWord.length - 1; i >= 0; i--) {
                if (ticksInWord[i].tick <= tick) {
                    resultTick = ticksInWord[i].tick;
                    found = true;
                    break;
                }
            }
        } else {
            // Find the closest tick > the input tick
            for (let i = 0; i < ticksInWord.length; i++) {
                if (ticksInWord[i].tick > tick) {
                    resultTick = ticksInWord[i].tick;
                    found = true;
                    break;
                }
            }
        }
        logger.debug(`${logPrefix} nextInitializedTickWithinOneWord(${tick}, lte=${lte}) result: ${resultTick}, Found: ${found}`);
        // SDK expects [tick number | null, boolean indicating if the word boundary was reached without finding a tick]
        // Since we fetch the whole word, we always find a tick if one exists in the desired direction within the word.
        // If no tick is found (resultTick is null), it means no suitable tick exists in this word.
        return [resultTick, resultTick === null]; // Return tick (or null) and boolean indicating if a valid tick was found in the search direction
    }
}

module.exports = { LensTickDataProvider };
