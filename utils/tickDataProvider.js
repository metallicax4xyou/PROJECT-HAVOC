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
        this.tickLensContract = new ethers.Contract(this.tickLensAddress, tickLensAbi, provider);
        logger.info(`[LensTickDataProvider] Initialized with TickLens contract at ${this.tickLensAddress}`);
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
        if (!ethers.isAddress(poolAddress)) {
            logger.error(`[LensTickDataProvider] Invalid pool address: ${poolAddress}`);
            return [];
        }
        if (tickLower >= tickUpper) {
             logger.warn(`[LensTickDataProvider] tickLower (${tickLower}) must be less than tickUpper (${tickUpper}). Skipping fetch for pool ${poolAddress}.`);
             return [];
        }

        const wordLower = tickToWord(tickLower, tickSpacing);
        const wordUpper = tickToWord(tickUpper, tickSpacing);

        if (wordLower === null || wordUpper === null) {
            logger.error(`[LensTickDataProvider] Could not calculate word boundaries for ticks ${tickLower}, ${tickUpper} and spacing ${tickSpacing}. Skipping fetch for pool ${poolAddress}.`);
            return [];
        }

        const populatedTicks = [];
        // Iterate through all the words that fall within the tick range.
        // TickLens fetches ticks for a whole word at a time.
        for (let wordPos = wordLower; wordPos <= wordUpper; wordPos++) {
            logger.debug(`[LensTickDataProvider] Preparing to call TickLens.getPopulatedTicksInWord for pool ${poolAddress}, wordPos ${wordPos}`); // <-- ADDED LOGGING HERE

            try {
                // *** Log parameters just before the call ***
                logger.info(`[LensTickDataProvider] Calling TickLens.getPopulatedTicksInWord with params: pool='${poolAddress}', tickBitmapIndex=${wordPos} (type: ${typeof wordPos})`);

                const ticksInWord = await this.tickLensContract.getPopulatedTicksInWord(
                    poolAddress,
                    wordPos // Ensure this is passed as a number
                );

                logger.debug(`[LensTickDataProvider] Received ${ticksInWord.length} ticks from word ${wordPos} for pool ${poolAddress}`);

                ticksInWord.forEach(tickInfo => {
                    const tick = Number(tickInfo.tick); // Convert from BigInt/ethers internal type if necessary
                    // Filter ticks to be strictly within the requested [tickLower, tickUpper] range,
                    // as getPopulatedTicksInWord returns ticks for the whole word.
                    if (tick >= tickLower && tick <= tickUpper) {
                        populatedTicks.push({
                            tick: tick,
                            liquidityNet: BigInt(tickInfo.liquidityNet) // Ensure it's BigInt
                        });
                    }
                });
            } catch (error) {
                // *** Log the specific error for this wordPos ***
                logger.error(`[LensTickDataProvider] Error fetching ticks for word ${wordPos}, pool ${poolAddress}. Error: ${error.message}`);
                // Check for specific error types
                if (error.code === 'CALL_EXCEPTION') {
                     logger.error(`[LensTickDataProvider] CALL_EXCEPTION details: ${JSON.stringify(error)}`);
                }
                // Decide if we should continue to the next word or abort
                // For now, let's log and continue, but collect potentially incomplete data
                 // Consider throwing or returning partial data indicator if needed
            }
        }

        // Sort ticks by tick index
        populatedTicks.sort((a, b) => a.tick - b.tick);

        logger.info(`[LensTickDataProvider] Successfully fetched ${populatedTicks.length} populated ticks in range [${tickLower}, ${tickUpper}] for pool ${poolAddress}`);
        return populatedTicks;
    }
}

module.exports = { LensTickDataProvider };
