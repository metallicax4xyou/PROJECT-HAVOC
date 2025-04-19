// utils/tickDataProvider.js

const { ethers } = require('ethers');
const { TickListDataProvider, Tick } = require('@uniswap/v3-sdk');
const { Token } = require('@uniswap/sdk-core');
const { ABIS } = require('../constants/abis'); // Use centralized ABIs
const logger = require('./logger');
const { tickToWord } = require('./tickUtils'); // Import tickToWord helper

// Cache for populated ticks fetched from TickLens (Simple Map Cache)
// Key: poolAddress_wordPos, Value: { timestamp: number, ticks: PopulatedTick[] }
const tickCache = new Map();
const CACHE_TTL_SECONDS = 30; // Cache ticks for 30 seconds

// Structure returned by TickLens getPopulatedTicksInWord
// struct PopulatedTick { int24 tick; int128 liquidityNet; uint128 liquidityGross; }
const POPULATED_TICK_TYPE = `tuple(int24 tick, int128 liquidityNet, uint128 liquidityGross)`;

/**
 * Implements the Uniswap V3 SDK TickDataProvider interface using the TickLens contract.
 * Provides initialized tick data needed for accurate swap simulations.
 */
class LensTickDataProvider {
    /**
     * @param {string} tickLensAddress The address of the deployed TickLens contract.
     * @param {ethers.Provider} provider Ethers provider instance.
     * @param {number} chainId The chain ID for token context.
     */
    constructor(tickLensAddress, provider, chainId) {
        if (!tickLensAddress || !ethers.isAddress(tickLensAddress)) {
            throw new Error('Invalid TickLens address provided.');
        }
        if (!provider) {
            throw new Error('Ethers provider is required.');
        }
        if (!chainId) {
             throw new Error('Chain ID is required.');
        }
        this.chainId = chainId;
        this.provider = provider;
        try {
             // Ensure TickLens ABI is loaded
             if (!ABIS.TickLens) {
                 throw new Error("TickLens ABI not found or failed to load. Check constants/abis.js.");
             }
            this.tickLensContract = new ethers.Contract(tickLensAddress, ABIS.TickLens, provider);
            logger.info(`[LensTickDP] Initialized with TickLens at ${tickLensAddress}`);
        } catch (error) {
             logger.error(`[LensTickDP] Error initializing TickLens contract: ${error.message}`);
             throw error; // Re-throw critical initialization error
        }
    }

    /**
     * Fetches populated ticks within a word from TickLens, using a cache.
     * @param {string} poolAddress Address of the Uniswap V3 pool.
     * @param {number} wordPos The tick bitmap index.
     * @returns {Promise<Array<{ tick: number; liquidityNet: bigint; liquidityGross: bigint }>>} Array of populated tick data.
     */
    async _getPopulatedTicks(poolAddress, wordPos) {
        const cacheKey = `${poolAddress.toLowerCase()}_${wordPos}`;
        const now = Date.now();
        const cached = tickCache.get(cacheKey);

        if (cached && (now - cached.timestamp < CACHE_TTL_SECONDS * 1000)) {
            // logger.debug(`[LensTickDP] Cache hit for ticks: ${cacheKey}`);
            return cached.ticks;
        }

        logger.debug(`[LensTickDP] Fetching populated ticks for pool ${poolAddress}, word ${wordPos}`);
        try {
            // Call TickLens contract
            const populatedTicksResult = await this.tickLensContract.getPopulatedTicksInWord(poolAddress, wordPos);

            // Process result: Convert from struct array to desired format with BigInts
            const ticks = populatedTicksResult.map(tickData => ({
                tick: Number(tickData.tick), // Convert int24 to number
                liquidityNet: BigInt(tickData.liquidityNet), // Convert int128 to bigint
                liquidityGross: BigInt(tickData.liquidityGross) // Convert uint128 to bigint
            }));

            // Update cache
            tickCache.set(cacheKey, { timestamp: now, ticks });
            logger.debug(`[LensTickDP] Fetched and cached ${ticks.length} ticks for ${cacheKey}`);
            return ticks;

        } catch (error) {
            logger.error(`[LensTickDP] Error fetching ticks for pool ${poolAddress}, word ${wordPos}: ${error.message}`);
            // Don't cache errors, return empty array to allow simulation to proceed potentially
            // Handle specific errors (e.g., contract revert) if needed
            return [];
        }
    }


    /**
     * Get data for a specific tick. Required by TickDataProvider interface.
     * NOTE: The V3 SDK's trade simulation primarily relies on `nextInitializedTickWithinOneWord`.
     * This implementation can often return default data unless specific tick liquidity is crucial.
     * We fetch the word containing the tick to see if it *is* populated.
     *
     * @param {number} tick The tick index.
     * @param {number} tickSpacing The tick spacing of the pool.
     * @param {string} poolAddress Address of the pool.
     * @returns {Promise<{ liquidityNet: bigint, liquidityGross?: bigint }>} Tick data.
     */
    async getTick(tick, tickSpacing, poolAddress) {
        // logger.debug(`[LensTickDP] getTick called for tick: ${tick}, pool: ${poolAddress}`);
        const wordPos = tickToWord(tick, tickSpacing);
        if (wordPos === null) {
            logger.warn(`[LensTickDP] Invalid input to tickToWord in getTick. tick=${tick}, spacing=${tickSpacing}`);
            return { liquidityNet: 0n }; // Return default on error
        }

        try {
            const populatedTicks = await this._getPopulatedTicks(poolAddress, wordPos);
            const foundTick = populatedTicks.find(pt => pt.tick === tick);

            if (foundTick) {
                // logger.debug(`[LensTickDP] getTick: Found populated tick ${tick} data.`);
                return {
                    liquidityNet: foundTick.liquidityNet,
                    liquidityGross: foundTick.liquidityGross // Include gross if available
                };
            } else {
                 // logger.debug(`[LensTickDP] getTick: Tick ${tick} not found in populated list for word ${wordPos}. Returning default.`);
                 // Return default if the specific tick isn't initialized in the fetched word
                 return { liquidityNet: 0n };
            }
        } catch (error) {
             logger.error(`[LensTickDP] Error in getTick for tick ${tick}, pool ${poolAddress}: ${error.message}`);
             return { liquidityNet: 0n }; // Return default on error
        }
    }


    /**
     * Finds the next initialized tick within the same word as the given tick.
     * Crucial for accurate V3 swap simulation.
     *
     * @param {number} tick The starting tick index.
     * @param {boolean} lte Find tick less than or equal to the starting tick.
     * @param {number} tickSpacing The tick spacing of the pool.
     * @param {string} poolAddress Address of the pool.
     * @returns {Promise<[number, boolean]>} [next tick index, found an initialized tick]
     */
    async nextInitializedTickWithinOneWord(tick, lte, tickSpacing, poolAddress) {
        // logger.debug(`[LensTickDP] nextInitializedTickWithinOneWord: tick=${tick}, lte=${lte}, spacing=${tickSpacing}, pool=${poolAddress}`);
        const wordPos = tickToWord(tick, tickSpacing);
         if (wordPos === null) {
             logger.warn(`[LensTickDP] Invalid input to tickToWord in nextInit. tick=${tick}, spacing=${tickSpacing}`);
             return [tick, false]; // Return input tick, not found
         }

        try {
            const populatedTicks = await this._getPopulatedTicks(poolAddress, wordPos);

            if (lte) {
                // Find the largest initialized tick <= the given tick
                let nextTick = -Infinity; // Start with smallest possible value
                let found = false;
                 // Sort descending to find largest easily
                 populatedTicks.sort((a, b) => b.tick - a.tick);
                 for (const pt of populatedTicks) {
                     if (pt.tick <= tick) {
                         nextTick = pt.tick;
                         found = true;
                         break; // Found the largest tick <= target
                     }
                 }
                 if (found) {
                    // logger.debug(`[LensTickDP] nextInitializedTickWithinOneWord (lte=true): Found ${nextTick} for current ${tick}`);
                    return [nextTick, true];
                 } else {
                     // logger.debug(`[LensTickDP] nextInitializedTickWithinOneWord (lte=true): No initialized tick <= ${tick} found in word ${wordPos}.`);
                     // Find the theoretical minimum tick in the word
                     const minTickInWord = wordPos * 256 * tickSpacing;
                     return [minTickInWord, false]; // Return boundary, not found
                 }

            } else {
                // Find the smallest initialized tick >= the given tick
                 let nextTick = Infinity; // Start with largest possible value
                 let found = false;
                  // Sort ascending to find smallest easily
                  populatedTicks.sort((a, b) => a.tick - b.tick);
                  for (const pt of populatedTicks) {
                      if (pt.tick >= tick) {
                          nextTick = pt.tick;
                          found = true;
                          break; // Found the smallest tick >= target
                      }
                  }
                  if (found) {
                     // logger.debug(`[LensTickDP] nextInitializedTickWithinOneWord (lte=false): Found ${nextTick} for current ${tick}`);
                     return [nextTick, true];
                  } else {
                      // logger.debug(`[LensTickDP] nextInitializedTickWithinOneWord (lte=false): No initialized tick >= ${tick} found in word ${wordPos}.`);
                      // Find the theoretical maximum tick in the word
                      const maxTickInWord = (wordPos + 1) * 256 * tickSpacing - tickSpacing;
                      return [maxTickInWord, false]; // Return boundary, not found
                  }
            }
        } catch (error) {
            logger.error(`[LensTickDP] Error in nextInitializedTickWithinOneWord for tick ${tick}, pool ${poolAddress}: ${error.message}`);
            return [tick, false]; // Return input tick, indicate failure
        }
    }
}

module.exports = { LensTickDataProvider };
