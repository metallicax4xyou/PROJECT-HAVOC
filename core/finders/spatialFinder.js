// core/finders/spatialFinder.js
const logger = require('../../utils/logger'); // Adjust path if needed
const { getCanonicalPairKey } = require('../../utils/pairUtils'); // Adjust path if needed
// *** Import Price Utils ***
const { getUniV3Price, getV2Price, getDodoPrice, BIGNUMBER_1E18 } = require('../../utils/priceUtils'); // Adjust path if needed

// --- Configuration ---
// TODO: Move this to the main config object later
const MIN_PRICE_DIFFERENCE_PERCENT = 0.1; // Example: Look for at least 0.1% difference BEFORE fees/gas
const MIN_PRICE_DIFF_BIPS = BigInt(Math.round(MIN_PRICE_DIFFERENCE_PERCENT * 100)); // Basis points (0.1% = 10 bips)
const BASIS_POINTS_DENOMINATOR = 10000n;

class SpatialFinder {
    constructor(config) {
        this.config = config;
        this.pairRegistry = new Map();
        logger.info(`[SpatialFinder v1.23] Initialized (Calculates & Compares Prices).`);
    }

    /**
     * Updates the internal pair registry. Called by ArbitrageEngine.
     * @param {Map<string, Set<string>>} registry Map<canonicalPairKey, Set<poolAddress>>
     */
    updatePairRegistry(registry) {
        if (!registry || !(registry instanceof Map)) {
            logger.warn('[SpatialFinder] Received invalid registry in updatePairRegistry.');
            return;
        }
        this.pairRegistry = registry;
        logger.debug(`[SpatialFinder] Pair registry updated. Size: ${this.pairRegistry.size}`);
    }

    /**
     * Calculates the price for a given pool state.
     * Price is represented as the amount of token1 needed to buy 1 unit of token0, scaled by 1e18.
     * @param {object} poolState The pool state object from PoolScanner.
     * @returns {bigint|null} Scaled price (token0 in terms of token1 * 1e18) or null if calculation fails.
     */
    _calculatePrice(poolState) {
        const { dexType, token0, token1 } = poolState;
        if (!token0 || !token1) {
            logger.warn(`[SpatialFinder._calculatePrice] Missing token objects for pool ${poolState.address}`);
            return null;
        }

        try {
            switch (dexType) {
                case 'uniswapV3':
                    if (poolState.sqrtPriceX96) {
                        return getUniV3Price(poolState.sqrtPriceX96, token0, token1);
                    }
                    break;
                case 'sushiswap': // Assumes V2 logic
                    if (poolState.reserve0 !== undefined && poolState.reserve1 !== undefined) {
                         // Ensure reserves are non-zero for valid price calc
                         if (poolState.reserve0 === 0n || poolState.reserve1 === 0n) return null;
                         // V2 price needs token0 and token1 aligned with reserve0 and reserve1
                         // getV2Price expects reserve0, reserve1, token0, token1 matching the pool's order
                         return getV2Price(poolState.reserve0, poolState.reserve1, token0, token1);
                    }
                    break;
                case 'dodo':
                    // DODO fetcher provides price of base token in terms of quote token
                    // We need price of token0 in terms of token1 consistently
                    if (poolState.queryAmountOutWei !== undefined && poolState.queryBaseToken && poolState.queryQuoteToken) {
                        // Calculate price: amount of QUOTE per 1 unit of BASE, scaled by 1e18
                        const priceBaseInQuote = getDodoPrice(poolState.queryAmountOutWei, poolState.queryBaseToken, poolState.queryQuoteToken);
                        if (priceBaseInQuote === null) return null;

                        // Check if token0 is the base token
                        if (token0.address.toLowerCase() === poolState.queryBaseToken.address.toLowerCase()) {
                            // Price calculated is already Price0_1
                            return priceBaseInQuote;
                        } else {
                            // Price calculated is Price1_0. We need to invert it.
                            // P0/1 = 1 / P1/0
                            // P0/1_scaled = (1 * 10^18 * 10^18) / P1/0_scaled
                            if (priceBaseInQuote === 0n) return null; // Avoid division by zero
                            return (BIGNUMBER_1E18 * BIGNUMBER_1E18) / priceBaseInQuote;
                        }
                    }
                    break;
                // Add cases for other DEX types (Camelot, etc.) here
                default:
                    logger.warn(`[SpatialFinder._calculatePrice] Unknown dexType ${dexType} for pool ${poolState.address}`);
            }
        } catch (error) {
            logger.error(`[SpatialFinder._calculatePrice] Error calculating price for ${poolState.address} (${dexType}): ${error.message}`);
        }
        return null; // Return null if price couldn't be calculated
    }


    /**
     * Finds spatial arbitrage opportunities by comparing prices across different DEXs.
     * @param {Array<object>} poolStates - Array of fetched pool state objects from PoolScanner.
     * @returns {Array<object>} - Array of potential spatial arbitrage opportunity objects.
     */
    findArbitrage(poolStates) {
        logger.info(`[SpatialFinder] Finding spatial arbitrage from ${poolStates.length} pool states...`);
        const opportunities = [];

        if (poolStates.length < 2 || this.pairRegistry.size === 0) {
            logger.info('[SpatialFinder] Not enough pool states or empty registry.');
            return opportunities;
        }

        // Map states for lookup
        const poolStateMap = new Map();
        poolStates.forEach(state => { if (state?.address) poolStateMap.set(state.address.toLowerCase(), state); });

        // Iterate through pairs present on multiple pools
        for (const [canonicalKey, poolAddressesSet] of this.pairRegistry.entries()) {
            if (poolAddressesSet.size < 2) continue;

            // Get states for the current pair
            const relevantPoolStates = [];
            poolAddressesSet.forEach(addr => {
                 const state = poolStateMap.get(addr.toLowerCase());
                 if (state) relevantPoolStates.push(state);
            });

            if (relevantPoolStates.length < 2) continue;

            // Calculate prices for all relevant pools
            const poolsWithPrices = relevantPoolStates.map(pool => ({
                 ...pool,
                 // Calculate price of token0 in terms of token1, scaled by 1e18
                 price0_1_scaled: this._calculatePrice(pool)
            })).filter(p => p.price0_1_scaled !== null && p.price0_1_scaled > 0n); // Filter out invalid/zero prices

            if (poolsWithPrices.length < 2) continue; // Need at least two valid prices to compare

            // Compare all valid pairs within this canonical key set
            for (let i = 0; i < poolsWithPrices.length; i++) {
                for (let j = i + 1; j < poolsWithPrices.length; j++) {
                    const poolA = poolsWithPrices[i];
                    const poolB = poolsWithPrices[j];

                    // Price A = Price of token0 on pool A (in terms of token1) * 1e18
                    // Price B = Price of token0 on pool B (in terms of token1) * 1e18
                    const priceA = poolA.price0_1_scaled;
                    const priceB = poolB.price0_1_scaled;

                    // --- Compare Prices ---
                    // Find the difference percentage using BigInt math
                    const priceDiff = priceA > priceB ? priceA - priceB : priceB - priceA;
                    const minPrice = priceA < priceB ? priceA : priceB;

                    // diff_percent = (diff / minPrice)
                    // diff_bips = (diff * 10000) / minPrice
                    const diffBips = (priceDiff * BASIS_POINTS_DENOMINATOR) / minPrice;

                    // TODO: Incorporate fee adjustments more accurately before comparison.
                    // Example: adjPriceA = priceA * (10000 - feeA_bips) / 10000; etc.
                    // For now, just compare raw prices against a threshold

                    if (diffBips >= MIN_PRICE_DIFF_BIPS) {
                        // Opportunity found! Determine buy/sell pools
                        let poolBuy, poolSell;
                        if (priceA < priceB) { // Price of token0 is lower on A, higher on B
                            poolBuy = poolA;  // Buy token0 on A
                            poolSell = poolB; // Sell token0 on B
                        } else {
                            poolBuy = poolB;  // Buy token0 on B
                            poolSell = poolA; // Sell token0 on A
                        }

                        const token0 = poolA.token0; // token0 is consistent for this pair
                        const token1 = poolA.token1; // token1 is consistent for this pair

                        logger.info(`[SpatialFinder] Potential Opportunity Found! Pair: ${token0.symbol}/${token1.symbol}`);
                        logger.info(`  Buy ${token0.symbol} on ${poolBuy.dexType} (${poolBuy.address.substring(0,6)})`);
                        logger.info(`  Sell ${token0.symbol} on ${poolSell.dexType} (${poolSell.address.substring(0,6)})`);
                        logger.info(`  Price Diff (Bips): ${diffBips.toString()} (Threshold: ${MIN_PRICE_DIFF_BIPS.toString()})`);

                        const opportunity = this._createOpportunity(poolBuy, poolSell, canonicalKey);
                        opportunities.push(opportunity);
                    }
                }
            }
        }

        logger.info(`[SpatialFinder] Finished scan. Found ${opportunities.length} potential spatial opportunities.`);
        return opportunities;
    }


     /**
      * Creates a structured opportunity object.
      * Assumes we are buying token0 on poolBuy and selling token0 on poolSell.
      */
     _createOpportunity(poolBuy, poolSell, canonicalKey) {
        // Token being arbitraged (buy low, sell high)
        const targetToken = poolBuy.token0; // Assuming price comparison was for token0
        const quoteToken = poolBuy.token1;

         // Placeholder amounts - ProfitCalculator will determine optimal size and actual profit
         const amountIn = '1000000000000000000'; // Example: 1 unit of quote token? Or target token? Needs clarity for ProfitCalc.
         const amountOut = '1001000000000000000'; // Example output

         return {
             type: 'spatial',
             pairKey: canonicalKey,
             // --- Define the token flow ---
             // Start with quote token, buy target token, sell target token for quote token
             tokenIn: quoteToken.symbol,      // Initial token (e.g., USDC to start)
             tokenIntermediate: targetToken.symbol, // Token being arbitraged (e.g., WETH)
             tokenOut: quoteToken.symbol,     // Final token (back to USDC)
             // --- Define the path ---
             path: [
                 {
                     dex: poolBuy.dexType,
                     address: poolBuy.address,
                     pair: [poolBuy.token0.symbol, poolBuy.token1.symbol], // Use symbols for readability
                     action: 'buy', // Buy targetToken (token0)
                     tokenIn: quoteToken.symbol,
                     tokenOut: targetToken.symbol,
                     // Include calculated price for reference (buy low)
                     priceScaled: poolBuy.price0_1_scaled.toString() // Price of token0 in token1 * 1e18
                 },
                 {
                     dex: poolSell.dexType,
                     address: poolSell.address,
                     pair: [poolSell.token0.symbol, poolSell.token1.symbol],
                     action: 'sell', // Sell targetToken (token0)
                     tokenIn: targetToken.symbol,
                     tokenOut: quoteToken.symbol,
                      // Include calculated price for reference (sell high)
                     priceScaled: poolSell.price0_1_scaled.toString() // Price of token0 in token1 * 1e18
                 }
             ],
              // --- Simplified Amount placeholders ---
             amountIn: amountIn,   // Placeholder amount of tokenIn to start
             amountOut: amountOut, // Placeholder amount of tokenOut expected
             // --- Additional Info ---
             timestamp: Date.now()
         };
     }
}

module.exports = SpatialFinder;
