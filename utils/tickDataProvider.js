// utils/tickDataProvider.js

const { ethers } = require('ethers');
// Removed TickListDataProvider, Tick as we implement the interface manually
const { Token } = require('@uniswap/sdk-core');
const { ABIS } = require('../constants/abis');
const logger = require('./logger');
const { tickToWord } = require('./tickUtils'); // Import tickToWord helper

const tickCache = new Map();
const CACHE_TTL_SECONDS = 30;
const POPULATED_TICK_TYPE = `tuple(int24 tick, int128 liquidityNet, uint128 liquidityGross)`;

/**
 * Implements the Uniswap V3 SDK TickDataProvider interface using the TickLens contract.
 */
class LensTickDataProvider {
    constructor(tickLensAddress, provider, chainId) {
        // ... (constructor remains the same) ...
        if (!tickLensAddress || !ethers.isAddress(tickLensAddress)) throw new Error('Invalid TickLens address.');
        if (!provider) throw new Error('Ethers provider required.');
        if (!chainId) throw new Error('Chain ID required.');
        this.chainId = chainId;
        this.provider = provider;
        try {
             if (!ABIS.TickLens) throw new Error("TickLens ABI not found.");
            this.tickLensContract = new ethers.Contract(tickLensAddress, ABIS.TickLens, provider);
            logger.info(`[LensTickDP] Initialized with TickLens at ${tickLensAddress}`);
        } catch (error) { logger.error(`[LensTickDP] Error initializing TickLens: ${error.message}`); throw error; }
    }

    async _getPopulatedTicks(poolAddress, wordPos) {
        const cacheKey = `${poolAddress.toLowerCase()}_${wordPos}`;
        const now = Date.now();
        const cached = tickCache.get(cacheKey);

        if (cached && (now - cached.timestamp < CACHE_TTL_SECONDS * 1000)) {
            return cached.ticks;
        }

        logger.debug(`[LensTickDP] Fetching ticks for pool ${poolAddress}, word ${wordPos}`);
        try {
            // Call TickLens contract - Added call options for safety
            const populatedTicksResult = await this.tickLensContract.getPopulatedTicksInWord(
                poolAddress,
                wordPos,
                { gasLimit: 500000 } // Add gas limit estimate for safety
            );

            const ticks = populatedTicksResult.map(tickData => ({
                tick: Number(tickData.tick),
                liquidityNet: BigInt(tickData.liquidityNet),
                liquidityGross: BigInt(tickData.liquidityGross)
            }));

            tickCache.set(cacheKey, { timestamp: now, ticks });
            logger.debug(`[LensTickDP] Fetched/cached ${ticks.length} ticks for ${cacheKey}`);
            return ticks;

        } catch (error) {
            logger.error(`[LensTickDP] Error fetching ticks for pool ${poolAddress}, word ${wordPos}: ${error.message}`);
            // Clear cache entry on error
            tickCache.delete(cacheKey);
            return []; // Return empty on error
        }
    }


    // getTick remains largely the same, might not be the primary issue
    async getTick(tick, tickSpacing, poolAddress) {
         const wordPos = tickToWord(tick, tickSpacing);
         if (wordPos === null) { logger.warn(`[LensTickDP] Invalid input in getTick.`); return { liquidityNet: 0n }; }
         try {
             const populatedTicks = await this._getPopulatedTicks(poolAddress, wordPos);
             const foundTick = populatedTicks.find(pt => pt.tick === tick);
             return foundTick ? { liquidityNet: foundTick.liquidityNet, liquidityGross: foundTick.liquidityGross } : { liquidityNet: 0n };
         } catch (error) { logger.error(`[LensTickDP] Error in getTick: ${error.message}`); return { liquidityNet: 0n }; }
    }


    // Refined nextInitializedTickWithinOneWord logic
    async nextInitializedTickWithinOneWord(tick, lte, tickSpacing, poolAddress) {
        const wordPos = tickToWord(tick, tickSpacing);
         if (wordPos === null) {
             logger.warn(`[LensTickDP] Invalid input in nextInit. tick=${tick}, spacing=${tickSpacing}`);
             return [tick, false];
         }

        // Define word boundaries more accurately
        // A word includes ticks from wordPos * 256 * tickSpacing up to (wordPos + 1) * 256 * tickSpacing - tickSpacing
        const wordStartTick = wordPos * 256 * tickSpacing;
        // const wordEndTick = wordStartTick + 255 * tickSpacing; // Inclusive end of the word range

        logger.debug(`[LensTickDP] nextInit: tick=${tick}, lte=${lte}, wordPos=${wordPos}, wordStart=${wordStartTick}`);

        try {
            const populatedTicks = await this._getPopulatedTicks(poolAddress, wordPos);
            if (!populatedTicks || populatedTicks.length === 0) {
                 logger.debug(`[LensTickDP] No populated ticks found for word ${wordPos}, pool ${poolAddress}.`);
                 // If no ticks in the word, return the appropriate boundary
                 // The SDK might expect the tick *just outside* the word in some cases? Let's try boundaries first.
                 return [lte ? wordStartTick : wordStartTick + tickSpacing, false]; // Return start or start+spacing
            }

            // Sort ticks numerically for easier searching
            populatedTicks.sort((a, b) => a.tick - b.tick);
            // logger.debug(`[LensTickDP] Populated ticks for word ${wordPos}: [${populatedTicks.map(t => t.tick).join(', ')}]`);

            if (lte) {
                // Find the highest tick index <= the current tick
                // Iterate downwards through the sorted list
                for (let i = populatedTicks.length - 1; i >= 0; i--) {
                    if (populatedTicks[i].tick <= tick) {
                        logger.debug(`[LensTickDP] nextInit (lte=true): Found ${populatedTicks[i].tick} for current ${tick}`);
                        return [populatedTicks[i].tick, true]; // Found initialized tick
                    }
                }
                // If no tick <= current tick is found in the populated list
                logger.debug(`[LensTickDP] nextInit (lte=true): No initialized tick <= ${tick}. Returning word boundary ${wordStartTick}.`);
                return [wordStartTick, false]; // Return word boundary, indicate not found within populated list relative to 'tick'

            } else {
                // Find the lowest tick index >= the current tick
                // Iterate upwards through the sorted list
                for (let i = 0; i < populatedTicks.length; i++) {
                    if (populatedTicks[i].tick >= tick) {
                        logger.debug(`[LensTickDP] nextInit (lte=false): Found ${populatedTicks[i].tick} for current ${tick}`);
                        return [populatedTicks[i].tick, true]; // Found initialized tick
                    }
                }
                // If no tick >= current tick is found in the populated list
                const nextWordStartTick = (wordPos + 1) * 256 * tickSpacing;
                logger.debug(`[LensTickDP] nextInit (lte=false): No initialized tick >= ${tick}. Returning next word boundary ${nextWordStartTick}.`);
                return [nextWordStartTick, false]; // Return next word boundary, indicate not found
            }
        } catch (error) {
            logger.error(`[LensTickDP] Error in nextInitializedTickWithinOneWord for tick ${tick}, pool ${poolAddress}: ${error.message}`);
            return [tick, false]; // Fallback on error
        }
    }
}

module.exports = { LensTickDataProvider };
