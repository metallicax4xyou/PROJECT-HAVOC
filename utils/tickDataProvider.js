// utils/tickDataProvider.js
const { ethers } = require('ethers');
// Removed direct imports for provider and config
const logger = require('./logger');
const { tickToWord } = require('./tickUtils');
const tickLensAbi = require('../abis/TickLens.json');

class LensTickDataProvider {
    // Constructor now accepts dependencies
    constructor(tickLensAddress, provider, chainId) {
        if (!tickLensAddress || !ethers.isAddress(tickLensAddress)) {
            throw new Error(`[LensTickDataProvider] Invalid or missing TICKLENS_ADDRESS provided: ${tickLensAddress}`);
        }
        if (!provider) {
            throw new Error(`[LensTickDataProvider] Provider instance is required.`);
        }
        // chainId might not be strictly needed by the provider itself, but good practice to have if available
        if (!chainId) {
            logger.warn(`[LensTickDataProvider] Chain ID not provided during initialization.`);
        }

        this.tickLensAddress = tickLensAddress;
        this.provider = provider; // Store the provider instance
        // this.chainId = chainId; // Store if needed later

        try {
            this.tickLensContract = new ethers.Contract(this.tickLensAddress, tickLensAbi, this.provider);
            logger.info(`[LensTickDataProvider] Initialized with TickLens contract at ${this.tickLensAddress}`);
        } catch (e) {
            logger.error(`[LensTickDataProvider] FAILED to initialize ethers.Contract for TickLens: ${e.message}`);
            throw e; // Re-throw critical error
        }
    }

    /**
     * Fetches populated ticks within a given tick range for a specific pool using TickLens.
     * (Implementation remains the same as the last version you ran)
     * @param {string} poolAddress The address of the Uniswap V3 pool.
     * @param {number} tickLower The lower bound of the tick range.
     * @param {number} tickUpper The upper bound of the tick range.
     * @param {number} tickSpacing The tick spacing of the pool.
     * @returns {Promise<Array<{tick: number, liquidityNet: bigint}>>} A promise resolving to an array of populated ticks.
     */
    async getPopulatedTicksInRange(poolAddress, tickLower, tickUpper, tickSpacing) {
        const logPrefix = `[LensTickDataProvider Pool: ${poolAddress}]`;

        if (!ethers.isAddress(poolAddress)) {
            logger.error(`${logPrefix} Invalid pool address provided.`);
            return [];
        }
        if (tickLower == null || tickUpper == null || tickSpacing == null || tickLower >= tickUpper) {
             logger.warn(`${logPrefix} Invalid tick range/spacing: Lower=${tickLower}, Upper=${tickUpper}, Spacing=${tickSpacing}. Skipping fetch.`);
             return [];
        }

        logger.debug(`${logPrefix} Requesting ticks in range [${tickLower}, ${tickUpper}], Spacing: ${tickSpacing}`);
        const wordLower = tickToWord(tickLower, tickSpacing);
        const wordUpper = tickToWord(tickUpper, tickSpacing);
        logger.debug(`${logPrefix} Calculated word range: [${wordLower}, ${wordUpper}]`);

        if (wordLower === null || wordUpper === null) {
            logger.error(`${logPrefix} Could not calculate word boundaries. Skipping fetch.`);
            return [];
        }
        if (wordUpper < wordLower) {
             logger.error(`${logPrefix} Calculated wordUpper (${wordUpper}) < wordLower (${wordLower}). This should not happen. Skipping fetch.`);
             return [];
        }
        if (wordUpper - wordLower > 1000) {
             logger.warn(`${logPrefix} Calculated word range (${wordUpper - wordLower}) seems very large. Check inputs/logic.`);
        }

        const populatedTicks = [];
        for (let wordPos = wordLower; wordPos <= wordUpper; wordPos++) {
            const iterLogPrefix = `${logPrefix} WordPos: ${wordPos}`;
            try {
                logger.info(`${iterLogPrefix} Calling TickLens.getPopulatedTicksInWord...`);
                if (!this.tickLensContract) {
                     throw new Error("TickLens contract instance is not initialized.");
                }
                const ticksInWord = await this.tickLensContract.getPopulatedTicksInWord(
                    poolAddress,
                    wordPos
                );
                logger.debug(`${iterLogPrefix} Received ${ticksInWord?.length ?? 0} ticks from TickLens.`);

                if (Array.isArray(ticksInWord)) {
                    ticksInWord.forEach(tickInfo => {
                        if (tickInfo && tickInfo.tick !== undefined && tickInfo.liquidityNet !== undefined) {
                            const tick = Number(tickInfo.tick);
                            const liquidityNet = BigInt(tickInfo.liquidityNet);
                            if (!isNaN(tick) && tick >= tickLower && tick <= tickUpper) {
                                populatedTicks.push({ tick: tick, liquidityNet: liquidityNet });
                            } else if (isNaN(tick)) {
                                logger.warn(`${iterLogPrefix} Parsed tick is NaN from tickInfo: ${JSON.stringify(tickInfo)}`);
                            }
                        } else {
                             logger.warn(`${iterLogPrefix} Received invalid tickInfo structure: ${JSON.stringify(tickInfo)}`);
                        }
                    });
                } else {
                    logger.warn(`${iterLogPrefix} TickLens call returned non-array data: ${JSON.stringify(ticksInWord)}`);
                }
            } catch (error) {
                logger.error(`${iterLogPrefix} FAILED call to TickLens.getPopulatedTicksInWord. Error: ${error.message}`);
                if (error.code === 'CALL_EXCEPTION') {
                     logger.error(`${iterLogPrefix} CALL_EXCEPTION details: Action=${error.action}, Code=${error.code}, Reason=${error.reason}, Tx=${JSON.stringify(error.transaction)} Data=${error.data}`);
                } else {
                     logger.error(`${iterLogPrefix} Non-CALL_EXCEPTION details: Code=${error.code}, ${JSON.stringify(error)}`);
                }
                logger.error(`${logPrefix} Aborting tick fetch for this range due to error.`);
                return []; // Return empty array on error
            }
        } // End for loop

        populatedTicks.sort((a, b) => a.tick - b.tick);
        logger.info(`${logPrefix} Successfully fetched ${populatedTicks.length} populated ticks in range [${tickLower}, ${tickUpper}]`);
        return populatedTicks;
    }

    // --- SDK TickProvider Interface Methods ---
    // These methods adapt getPopulatedTicksInRange for the SDK's Pool constructor

    /**
     * Provides the tick data needed by the Uniswap SDK Pool constructor.
     * This typically involves fetching ticks around the current pool tick.
     * @param {number} tick The current tick of the pool.
     * @param {number} tickSpacing The pool's tick spacing.
     * @param {string} poolAddress The pool's address.
     * @returns {Promise<object>} An object containing tick data or throwing if fetch fails.
     */
    async getTick(tick, tickSpacing, poolAddress) {
        // For simulation, we usually need ticks around the current tick.
        // Determine a reasonable range to fetch. Fetching a single word might be enough.
        const wordPos = tickToWord(tick, tickSpacing);
        const tickLower = wordPos * tickSpacing * 256; // Approximate start of the word
        const tickUpper = tickLower + tickSpacing * 256 - 1; // Approximate end of the word

        logger.debug(`[LensTickDataProvider Pool: ${poolAddress}] getTick called for tick ${tick}. Fetching word range [${tickLower}, ${tickUpper}] (WordPos: ${wordPos})`);

        const ticks = await this.getPopulatedTicksInRange(poolAddress, tickLower, tickUpper, tickSpacing);

        // Find the specific tick requested, or the closest one if needed by SDK logic (check SDK needs)
        // The SDK might just need the liquidityNet at this specific tick if it exists.
        const foundTick = ticks.find(t => t.tick === tick);

        if (foundTick) {
            return { liquidityNet: foundTick.liquidityNet }; // Return structure expected by SDK
        } else {
            // If the exact tick isn't populated, the SDK expects null or similar
            // Let's return an object indicating it's not initialized
             // logger.trace(`[LensTickDataProvider Pool: ${poolAddress}] Tick ${tick} not found in fetched range.`);
             return { liquidityNet: 0n }; // Or potentially null / throw? SDK testing needed. Let's assume 0 for now.
        }
    }

    /**
     * Provides the next initialized tick within the same word needed by the SDK Pool constructor.
     * @param {number} tick Current tick.
     * @param {boolean} lte Find tick less than or equal to the current tick.
     * @param {number} tickSpacing Pool's tick spacing.
     * @param {string} poolAddress The pool's address.
     * @returns {Promise<number | null>} The next initialized tick index or null.
     */
    async nextInitializedTickWithinOneWord(tick, lte, tickSpacing, poolAddress) {
        const wordPos = tickToWord(tick, tickSpacing);
        // Define the boundaries of the word this tick falls into
        const wordStartTick = wordPos * tickSpacing * 256; // tickToWord gives word index, word has 256 ticks (compressed)
        const wordEndTick = wordStartTick + tickSpacing * 256 - 1;

        logger.debug(`[LensTickDataProvider Pool: ${poolAddress}] nextInitializedTickWithinOneWord called for tick ${tick}, lte=${lte}. Fetching word range [${wordStartTick}, ${wordEndTick}] (WordPos: ${wordPos})`);

        const ticksInWord = await this.getPopulatedTicksInRange(poolAddress, wordStartTick, wordEndTick, tickSpacing);

        if (!ticksInWord || ticksInWord.length === 0) {
            // logger.trace(`[LensTickDataProvider Pool: ${poolAddress}] No ticks found in word ${wordPos}.`);
            return null; // No initialized ticks in this word
        }

        if (lte) {
            // Find the closest initialized tick <= current tick
            let closestTick = null;
            for (let i = ticksInWord.length - 1; i >= 0; i--) {
                if (ticksInWord[i].tick <= tick) {
                    closestTick = ticksInWord[i].tick;
                    break;
                }
            }
             // logger.trace(`[LensTickDataProvider Pool: ${poolAddress}] Next initialized tick (<= ${tick}): ${closestTick}`);
             return closestTick;
        } else {
            // Find the closest initialized tick > current tick
            let closestTick = null;
            for (let i = 0; i < ticksInWord.length; i++) {
                if (ticksInWord[i].tick > tick) {
                    closestTick = ticksInWord[i].tick;
                    break;
                }
            }
            // logger.trace(`[LensTickDataProvider Pool: ${poolAddress}] Next initialized tick (> ${tick}): ${closestTick}`);
            return closestTick;
        }
    }
}

module.exports = { LensTickDataProvider };
