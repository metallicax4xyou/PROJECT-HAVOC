// core/finders/spatialFinder.js
const logger = require('../../utils/logger');
const { getCanonicalPairKey } = require('../../utils/pairUtils');

class SpatialFinder {
    constructor(config) {
        // Store config if needed for later logic, e.g., filtering based on DEX types
        this.config = config;
        this.pairRegistry = new Map(); // Initialize internal registry
        logger.info(`[SpatialFinder V1.21] Initialized (Requires external Pair Registry update via updatePairRegistry method).`);
    }

    /**
     * Updates the internal pair registry used for finding spatial opportunities.
     * Called by the ArbitrageEngine after each pool state fetch cycle.
     * @param {Map<string, Set<string>>} registry - The registry map (canonicalPairKey -> Set<poolAddress>) built by PoolScanner.
     */
    updatePairRegistry(registry) {
        if (!registry || !(registry instanceof Map)) {
            logger.warn('[SpatialFinder] Received invalid registry in updatePairRegistry. Expected a Map.');
            return;
        }
        this.pairRegistry = registry; // Replace internal registry with the new one
        logger.debug(`[SpatialFinder] Pair registry updated. Size: ${this.pairRegistry.size}`);
    }

    /**
     * Finds spatial arbitrage opportunities across different DEXs for the same token pair.
     * @param {Array<object>} poolStates - Array of fetched pool state objects from PoolScanner.
     * @returns {Array<object>} - Array of potential spatial arbitrage opportunity objects.
     */
    findArbitrage(poolStates) {
        logger.info(`[SpatialFinder] Finding spatial arbitrage opportunities from ${poolStates.length} pool states...`);
        const opportunities = [];

        if (poolStates.length < 2) {
            logger.info('[SpatialFinder] Not enough pool states (< 2) to find spatial opportunities.');
            return opportunities;
        }
         if (this.pairRegistry.size === 0) {
             logger.warn('[SpatialFinder] Pair registry is empty. Cannot efficiently find spatial opportunities. Ensure PoolScanner ran and updatePairRegistry was called.');
             // Could potentially fallback to iterating all poolStates, but less efficient
             return opportunities;
         }


        // Iterate through the pair registry to find pairs present on multiple pools/DEXs
        for (const [canonicalKey, poolAddressesSet] of this.pairRegistry.entries()) {
            if (poolAddressesSet.size < 2) {
                continue; // Skip pairs that only exist on one pool
            }

            // Filter the poolStates to get only the states for the current canonical pair
            const relevantPoolStates = poolStates.filter(state =>
                poolAddressesSet.has(state.address) && state.pairKey === canonicalKey // Ensure address and key match
            );

            if (relevantPoolStates.length < 2) {
                // This might happen if a pool in the registry failed to fetch its state
                logger.debug(`[SpatialFinder] Skipping pair ${canonicalKey}: Found only ${relevantPoolStates.length} valid states out of ${poolAddressesSet.size} registered pools.`);
                continue;
            }

            // Now compare prices within this relevant set
            // logger.debug(`[SpatialFinder] Comparing ${relevantPoolStates.length} pools for pair ${canonicalKey}...`);
            for (let i = 0; i < relevantPoolStates.length; i++) {
                for (let j = i + 1; j < relevantPoolStates.length; j++) {
                    const poolA = relevantPoolStates[i];
                    const poolB = relevantPoolStates[j];

                    // Ensure we have necessary data (e.g., price/reserves) - Adapt based on fetcher output
                    if (!this._hasComparablePrice(poolA) || !this._hasComparablePrice(poolB)) {
                        logger.warn(`[SpatialFinder] Skipping comparison between ${poolA.address} and ${poolB.address} due to missing price data.`);
                        continue;
                    }

                    // --- Price Comparison Logic ---
                    // This needs refinement based on how price is represented (sqrtPrice, reserves, effectivePrice)
                    // For now, just logging the potential comparison pair
                    // logger.debug(`[SpatialFinder] Comparing ${poolA.dexType} (${poolA.address}) vs ${poolB.dexType} (${poolB.address}) for pair ${canonicalKey}`);

                    // Example: Compare effective prices if available (like from DODO)
                     if (poolA.effectivePrice !== undefined && poolB.effectivePrice !== undefined) {
                         if (poolA.effectivePrice > poolB.effectivePrice * 1.001) { // Sell on A, Buy on B (with tiny threshold)
                             opportunities.push(this._createOpportunity(poolA, poolB, canonicalKey));
                             logger.info(`[SpatialFinder] Potential Opportunity (DODO): Sell ${poolA.queryBaseToken?.symbol} on ${poolA.address}, Buy on ${poolB.address}`);
                         } else if (poolB.effectivePrice > poolA.effectivePrice * 1.001) { // Sell on B, Buy on A
                             opportunities.push(this._createOpportunity(poolB, poolA, canonicalKey));
                              logger.info(`[SpatialFinder] Potential Opportunity (DODO): Sell ${poolB.queryBaseToken?.symbol} on ${poolB.address}, Buy on ${poolA.address}`);
                         }
                     }
                     // TODO: Add comparison logic for UniswapV3 (sqrtPriceX96) and SushiSwap (reserves)
                     // This will involve calculating price from reserves/sqrtPrice and considering fees.
                     // Example (Conceptual for V2):
                     // priceA = poolA.reserve1 / poolA.reserve0;
                     // priceB = poolB.reserve1 / poolB.reserve0;
                     // if (priceA > priceB * (1 + feeFactor)) { opportunities.push(...) }
                     // Example (Conceptual for V3):
                     // priceA = sqrtPriceToPrice(poolA.sqrtPriceX96, poolA.token0, poolA.token1);
                     // priceB = sqrtPriceToPrice(poolB.sqrtPriceX96, poolB.token0, poolB.token1);
                     // if (priceA > priceB * (1 + feeFactor)) { opportunities.push(...) }

                    // Placeholder: Assume basic comparison indicates opportunity
                    // Remove this placeholder once real comparison logic is added
                    // if (i !== j) { // Basic check to ensure different pools
                    //     opportunities.push(this._createOpportunity(poolA, poolB, canonicalKey));
                    // }

                }
            }
        }


        logger.info(`[SpatialFinder] Found ${opportunities.length} potential spatial opportunities.`);
        return opportunities;
    }

    // Helper to check if a pool state has enough info for price comparison
    _hasComparablePrice(poolState) {
        // Needs refinement based on DEX types
        if (!poolState) return false;
        return (
            poolState.effectivePrice !== undefined || // DODO
            (poolState.reserve0 !== undefined && poolState.reserve1 !== undefined && poolState.reserve0 > 0n && poolState.reserve1 > 0n) || // V2 Style
            (poolState.sqrtPriceX96 !== undefined && poolState.liquidity !== undefined) // V3 Style (Liquidity > 0 check might be needed)
        );
    }

     // Helper to format an opportunity object
     // TODO: Refine this structure based on ProfitCalculator needs
     _createOpportunity(poolSell, poolBuy, canonicalKey) {
         // Determine tokenIn/tokenOut based on which pool has better price
         // This is simplified - real arb involves buying token A on poolBuy and selling on poolSell
         // Let's assume we spot that price of token0 (relative to token1) is higher on poolSell than poolBuy
         // Opportunity: Buy token0 on poolBuy, Sell token0 on poolSell
         const tokenToBuy = poolSell.token0; // Buy token0 cheaply on poolBuy
         const tokenToSell = poolSell.token1; // Sell token1 expensively on poolSell (or vice versa) - NEEDS CLARITY

         // Placeholder amounts - ProfitCalculator should determine optimal amount
         const amountIn = '1000000000000000000'; // Example: 1 unit of a token (e.g., 1 ETH)
         const amountOut = '1001000000000000000'; // Example: Slightly more back

         return {
             type: 'spatial',
             pairKey: canonicalKey,
             tokenIn: tokenToBuy?.symbol || 'UNKNOWN', // Symbol of token being bought on cheaper DEX
             tokenOut: tokenToBuy?.symbol || 'UNKNOWN', // Symbol of token being received on expensive DEX (should be same token)
             amountIn: amountIn, // Placeholder amount to start trade with
             amountOut: amountOut, // Placeholder amount received after trade
             path: [ // Define the two pools involved
                 { dex: poolBuy.dexType, address: poolBuy.address, pair: [poolBuy.token0Symbol, poolBuy.token1Symbol], action: 'buy' }, // Buy on cheaper DEX
                 { dex: poolSell.dexType, address: poolSell.address, pair: [poolSell.token0Symbol, poolSell.token1Symbol], action: 'sell' } // Sell on expensive DEX
             ],
             // Add prices for logging/debugging if available
             priceBuy: poolBuy.effectivePrice ?? 'N/A',
             priceSell: poolSell.effectivePrice ?? 'N/A',
             timestamp: Date.now()
         };
     }
}

module.exports = SpatialFinder;
