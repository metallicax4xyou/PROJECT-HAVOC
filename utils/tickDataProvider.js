// utils/tickDataProvider.js
const { ethers } = require('ethers');
const { provider } = require('./provider');
const logger = require('./logger');
const config = require('../config'); // Use consolidated config
const { tickToWord } = require('./tickUtils');

// ABI for the TickLens contract
const tickLensAbi = require('../abis/TickLens.json'); // Assuming ABI is stored here

class LensTickDataProvider {
    constructor() {
        this.tickLensAddress = config.TICKLENS_ADDRESS;
        if (!this.tickLensAddress || !ethers.isAddress(this.tickLensAddress)) {
            throw new Error(`[LensTickDataProvider] Invalid or missing TICKLENS_ADDRESS in config: ${this.tickLensAddress}`);
        }
        try {
            this.tickLensContract = new ethers.Contract(this.tickLensAddress, tickLensAbi, provider);
            logger.info(`[LensTickDataProvider] Initialized with TickLens contract at ${this.tickLensAddress}`);
        } catch (e) {
             logger.error(`[LensTickDataProvider] FAILED to initialize ethers.Contract for TickLens: ${e.message}`);
             throw e; // Re-throw critical error
        }
    }

    /**
     * Fetches populated ticks within a given tick range for a specific pool using TickLens.
     * @param {string} poolAddress The address of the Uniswap V3 pool.
     * @param {number} tickLower The lower bound of the tick range.
     * @param {number} tickUpper The upper bound of the tick range.
     * @param {number} tickSpacing The tick spacing of the pool.
     * @returns {Promise<Array<{tick: number, liquidityNet: bigint}>>} A promise resolving to an array of populated ticks.
     */
    async getPopulatedTicksInRange(poolAddress, tickLower, tickUpper, tickSpacing) {
        const logPrefix = `[LensTickDataProvider Pool: ${poolAddress}]`; // Add pool address to prefix

        if (!ethers.isAddress(poolAddress)) {
            logger.error(`${logPrefix} Invalid pool address provided.`);
            return [];
        }
        if (tickLower == null || tickUpper == null || tickSpacing == null || tickLower >= tickUpper) {
             logger.warn(`${logPrefix} Invalid tick range/spacing: Lower=${tickLower}, Upper=${tickUpper}, Spacing=${tickSpacing}. Skipping fetch.`);
             return [];
        }

        // --- Added Logging for Inputs ---
        logger.debug(`${logPrefix} Requesting ticks in range [${tickLower}, ${tickUpper}], Spacing: ${tickSpacing}`);

        const wordLower = tickToWord(tickLower, tickSpacing);
        const wordUpper = tickToWord(tickUpper, tickSpacing);

        // --- Added Logging for Calculated Words ---
        logger.debug(`${logPrefix} Calculated word range: [${wordLower}, ${wordUpper}]`);

        if (wordLower === null || wordUpper === null) {
            logger.error(`${logPrefix} Could not calculate word boundaries. Skipping fetch.`);
            return [];
        }
        // --- Add check if word range is reasonable ---
        if (wordUpper < wordLower) {
             logger.error(`${logPrefix} Calculated wordUpper (${wordUpper}) < wordLower (${wordLower}). This should not happen. Skipping fetch.`);
             return [];
        }
        if (wordUpper - wordLower > 1000) { // Sanity check: avoid huge loops if calculation is wrong
             logger.warn(`${logPrefix} Calculated word range (${wordUpper - wordLower}) seems very large. Check inputs/logic.`);
             // Maybe return [] or throw error here? For now, just log.
        }


        const populatedTicks = [];
        // Iterate through all the words that fall within the tick range.
        for (let wordPos = wordLower; wordPos <= wordUpper; wordPos++) {
            // Use a specific log prefix for this iteration
            const iterLogPrefix = `${logPrefix} WordPos: ${wordPos}`;

            try {
                // *** Log parameters just before the call ***
                logger.info(`${iterLogPrefix} Calling TickLens.getPopulatedTicksInWord...`); // Simplified log

                // Ensure contract instance is valid before calling
                if (!this.tickLensContract) {
                     throw new Error("TickLens contract instance is not initialized.");
                }

                const ticksInWord = await this.tickLensContract.getPopulatedTicksInWord(
                    poolAddress,
                    wordPos // Pass JS number directly
                );

                // Log success only if call didn't throw
                logger.debug(`${iterLogPrefix} Received ${ticksInWord?.length ?? 0} ticks from TickLens.`);

                // Process ticks if the call was successful and returned data
                if (Array.isArray(ticksInWord)) {
                    ticksInWord.forEach(tickInfo => {
                        // Add extra validation for tickInfo structure
                        if (tickInfo && tickInfo.tick !== undefined && tickInfo.liquidityNet !== undefined) {
                            const tick = Number(tickInfo.tick); // Convert from BigInt/ethers internal type if necessary
                            const liquidityNet = BigInt(tickInfo.liquidityNet); // Ensure it's BigInt

                            // Filter ticks strictly within the requested [tickLower, tickUpper] range
                            if (!isNaN(tick) && tick >= tickLower && tick <= tickUpper) {
                                populatedTicks.push({
                                    tick: tick,
                                    liquidityNet: liquidityNet
                                });
                            } else if (isNaN(tick)) {
                                logger.warn(`${iterLogPrefix} Parsed tick is NaN from tickInfo: ${JSON.stringify(tickInfo)}`);
                            }
                            // else { logger.trace(`${iterLogPrefix} Tick ${tick} outside requested range [${tickLower}, ${tickUpper}]`); } // Optional trace log
                        } else {
                             logger.warn(`${iterLogPrefix} Received invalid tickInfo structure: ${JSON.stringify(tickInfo)}`);
                        }
                    });
                } else {
                    logger.warn(`${iterLogPrefix} TickLens call returned non-array data: ${JSON.stringify(ticksInWord)}`);
                }

            } catch (error) {
                // *** Log the specific error for this wordPos ***
                logger.error(`${iterLogPrefix} FAILED call to TickLens.getPopulatedTicksInWord. Error: ${error.message}`);
                // Check for specific error types and log details
                if (error.code === 'CALL_EXCEPTION') {
                     logger.error(`${iterLogPrefix} CALL_EXCEPTION details: Action=${error.action}, Code=${error.code}, Reason=${error.reason}, Tx=${JSON.stringify(error.transaction)} Data=${error.data}`);
                     // Also log the full error object if helpful
                     // logger.error(`${iterLogPrefix} Full CALL_EXCEPTION object: ${JSON.stringify(error)}`);
                } else {
                     // Log other types of errors
                     logger.error(`${iterLogPrefix} Non-CALL_EXCEPTION details: Code=${error.code}, ${JSON.stringify(error)}`);
                }

                // Decide how to proceed. For now, let's break the loop on the first error
                // because continuing often hides the root cause.
                // Alternative: continue; // To try and get partial data
                logger.error(`${logPrefix} Aborting tick fetch for this range due to error.`);
                // We could return the partially collected ticks or throw the error
                // Returning partial data might lead to incorrect simulations. Let's return empty for safety.
                return []; // Return empty array on error
                // break; // Or break if we want to return partial data collected so far
            }
        } // End for loop

        // Sort ticks by tick index if successful
        populatedTicks.sort((a, b) => a.tick - b.tick);

        logger.info(`${logPrefix} Successfully fetched ${populatedTicks.length} populated ticks in range [${tickLower}, ${tickUpper}]`);
        return populatedTicks;
    }
}

module.exports = { LensTickDataProvider };
