// core/finders/spatialFinder.js
const logger = require('../../utils/logger');
const { getCanonicalPairKey } = require('../../utils/pairUtils');
const { getUniV3Price, getV2Price, getDodoPrice, BIGNUMBER_1E18 } = require('../../utils/priceUtils');

// --- Configuration ---
// Threshold for price difference AFTER accounting for fees
const MIN_NET_PRICE_DIFFERENCE_BIPS = 5n; // Example: Look for at least 0.05% net difference (Adjust!)
const MAX_REASONABLE_PRICE_DIFF_BIPS = 5000n; // 50% sanity check
const BASIS_POINTS_DENOMINATOR = 10000n;

class SpatialFinder {
    constructor(config) {
        this.config = config;
        this.pairRegistry = new Map();
        logger.info(`[SpatialFinder v1.25] Initialized (Calculates Prices, Fee-Adjusted Comparison).`);
    }

    updatePairRegistry(registry) {
        if (!registry || !(registry instanceof Map)) { logger.warn('[SpatialFinder] Invalid registry update.'); return; }
        this.pairRegistry = registry;
        logger.debug(`[SpatialFinder] Pair registry updated. Size: ${this.pairRegistry.size}`);
    }

    _calculatePrice(poolState) {
        // ... (Keep the _calculatePrice method from Response #30 - no changes needed) ...
        const { dexType, token0, token1 } = poolState;
        if (!token0 || !token1) { logger.warn(`[SF._CalcPrice] Missing token objects for ${poolState.address}`); return null; }
        try {
            switch (dexType) {
                case 'uniswapV3': if (poolState.sqrtPriceX96) { return getUniV3Price(poolState.sqrtPriceX96, token0, token1); } break;
                case 'sushiswap': if (poolState.reserve0 !== undefined && poolState.reserve1 !== undefined) { if (poolState.reserve0 === 0n || poolState.reserve1 === 0n) return null; return getV2Price(poolState.reserve0, poolState.reserve1, token0, token1); } break;
                case 'dodo': if (poolState.queryAmountOutWei !== undefined && poolState.queryBaseToken && poolState.queryQuoteToken) { const priceBaseInQuote = getDodoPrice(poolState.queryAmountOutWei, poolState.queryBaseToken, poolState.queryQuoteToken); if (priceBaseInQuote === null) return null; if (token0.address.toLowerCase() === poolState.queryBaseToken.address.toLowerCase()) { return priceBaseInQuote; } else { if (priceBaseInQuote === 0n) return null; return (BIGNUMBER_1E18 * BIGNUMBER_1E18) / priceBaseInQuote; } } break;
                default: logger.warn(`[SF._CalcPrice] Unknown dexType ${dexType}`);
            }
        } catch (error) { logger.error(`[SF._CalcPrice] Error for ${poolState.address}: ${error.message}`); }
        return null;
    }

    findArbitrage(poolStates) {
        logger.info(`[SpatialFinder] Finding spatial arbitrage from ${poolStates.length} pool states...`);
        const opportunities = [];
        if (poolStates.length < 2 || this.pairRegistry.size === 0) return opportunities;

        const poolStateMap = new Map();
        poolStates.forEach(state => { if (state?.address) poolStateMap.set(state.address.toLowerCase(), state); });

        for (const [canonicalKey, poolAddressesSet] of this.pairRegistry.entries()) {
            if (poolAddressesSet.size < 2) continue;

            const relevantPoolStates = [];
            poolAddressesSet.forEach(addr => { const state = poolStateMap.get(addr.toLowerCase()); if (state) relevantPoolStates.push(state); });
            if (relevantPoolStates.length < 2) continue;

            const poolsWithPrices = relevantPoolStates.map(pool => ({
                 ...pool, price0_1_scaled: this._calculatePrice(pool)
            })).filter(p => p.price0_1_scaled !== null && p.price0_1_scaled > 0n);

            if (poolsWithPrices.length < 2) continue;

            for (let i = 0; i < poolsWithPrices.length; i++) {
                for (let j = i + 1; j < poolsWithPrices.length; j++) {
                    const poolA = poolsWithPrices[i];
                    const poolB = poolsWithPrices[j];
                    const rawPriceA = poolA.price0_1_scaled; // Price of token0 in token1 * 1e18
                    const rawPriceB = poolB.price0_1_scaled; // Price of token0 in token1 * 1e18

                    // --- Sanity Check on Raw Prices ---
                    const rawPriceDiff = rawPriceA > rawPriceB ? rawPriceA - rawPriceB : rawPriceB - rawPriceA;
                    const minRawPrice = rawPriceA < rawPriceB ? rawPriceA : rawPriceB;
                    if (minRawPrice === 0n) continue; // Should already be filtered, but double check
                    const rawDiffBips = (rawPriceDiff * BASIS_POINTS_DENOMINATOR) / minRawPrice;

                    if (rawDiffBips > MAX_REASONABLE_PRICE_DIFF_BIPS) {
                         logger.warn(`[SpatialFinder] Implausible RAW price diff (${rawDiffBips} bips) between ${poolA.dexType}/${poolA.address.substring(0,6)} and ${poolB.dexType}/${poolB.address.substring(0,6)}. Skipping.`);
                         continue;
                    }

                    // --- Fee Adjustment ---
                    // Fee is applied to the INPUT amount of a swap.
                    // Price = AmountOut / AmountIn
                    // Effective Sell Price (you receive less) = RawPrice * (1 - fee)
                    // Effective Buy Price (you pay more) = RawPrice / (1 - fee) --- conceptually, harder to calc directly
                    // Easier: Compare adjusted sell price on high pool vs raw buy price on low pool.

                    // Get fees in BIPS (ensure fee property exists and is numeric)
                    const feeA_bips = BigInt(poolA.fee ?? 30); // Default 0.3% if missing? Check fetchers/config. V3 fees are correct. Sushi needs fee set in config. DODO might need check.
                    const feeB_bips = BigInt(poolB.fee ?? 30);

                    // Calculate multipliers (e.g., 1 - 0.0030 = 0.9970 -> 9970)
                    const sellMultiplierA = BASIS_POINTS_DENOMINATOR - feeA_bips;
                    const sellMultiplierB = BASIS_POINTS_DENOMINATOR - feeB_bips;

                    // Effective price you get when SELLING token0 on each pool
                    const effectiveSellPriceA = (rawPriceA * sellMultiplierA) / BASIS_POINTS_DENOMINATOR;
                    const effectiveSellPriceB = (rawPriceB * sellMultiplierB) / BASIS_POINTS_DENOMINATOR;

                    // Opportunity: Sell high (effective sell price) > Buy low (raw price)
                    let poolBuy = null;
                    let poolSell = null;
                    let netDiffBips = 0n;

                    if (effectiveSellPriceB > rawPriceA) { // Can sell on B for more than it costs to buy on A
                        netDiffBips = ((effectiveSellPriceB - rawPriceA) * BASIS_POINTS_DENOMINATOR) / rawPriceA;
                        if (netDiffBips >= MIN_NET_PRICE_DIFFERENCE_BIPS) {
                             poolBuy = poolA; poolSell = poolB;
                        }
                    } else if (effectiveSellPriceA > rawPriceB) { // Can sell on A for more than it costs to buy on B
                        netDiffBips = ((effectiveSellPriceA - rawPriceB) * BASIS_POINTS_DENOMINATOR) / rawPriceB;
                         if (netDiffBips >= MIN_NET_PRICE_DIFFERENCE_BIPS) {
                             poolBuy = poolB; poolSell = poolA;
                         }
                    }

                    // If an opportunity exists after fee consideration
                    if (poolBuy && poolSell) {
                        const token0 = poolA.token0; const token1 = poolA.token1;
                        logger.info(`[SpatialFinder] NET Opportunity Found! Pair: ${token0.symbol}/${token1.symbol}`);
                        logger.info(`  Buy ${token0.symbol} on ${poolBuy.dexType} (${poolBuy.address.substring(0,6)}) @ Raw Price ~${ethers.formatUnits(poolBuy.price0_1_scaled, 18)} ${token1.symbol}`);
                        logger.info(`  Sell ${token0.symbol} on ${poolSell.dexType} (${poolSell.address.substring(0,6)}) @ Eff. Price ~${ethers.formatUnits(poolSell === poolA ? effectiveSellPriceA : effectiveSellPriceB, 18)} ${token1.symbol}`);
                        logger.info(`  Net Diff (Bips): ${netDiffBips.toString()} (Threshold: ${MIN_NET_PRICE_DIFFERENCE_BIPS.toString()})`);

                        const opportunity = this._createOpportunity(poolBuy, poolSell, canonicalKey);
                        opportunities.push(opportunity);
                    }
                }
            }
        }

        logger.info(`[SpatialFinder] Finished scan. Found ${opportunities.length} potential spatial opportunities (after fee adj).`);
        return opportunities;
    }

     // Updated to log paths correctly
     _createOpportunity(poolBuy, poolSell, canonicalKey) {
         const targetToken = poolBuy.token0;
         const quoteToken = poolBuy.token1;
         const amountIn = '1000000000000000000'; // Placeholder
         const amountOut = '1000100000000000000'; // Placeholder adjusted slightly

         // Helper to get pair symbols safely
         const getPairSymbols = (pool) => {
             const sym0 = pool.token0?.symbol || '?';
             const sym1 = pool.token1?.symbol || '?';
             return [sym0, sym1];
         }

         return {
             type: 'spatial',
             pairKey: canonicalKey,
             tokenIn: quoteToken.symbol,
             tokenIntermediate: targetToken.symbol,
             tokenOut: quoteToken.symbol,
             path: [
                 {
                     dex: poolBuy.dexType, address: poolBuy.address,
                     pair: getPairSymbols(poolBuy), // Use helper
                     action: 'buy', tokenIn: quoteToken.symbol, tokenOut: targetToken.symbol,
                     priceScaled: poolBuy.price0_1_scaled.toString()
                 },
                 {
                     dex: poolSell.dexType, address: poolSell.address,
                     pair: getPairSymbols(poolSell), // Use helper
                     action: 'sell', tokenIn: targetToken.symbol, tokenOut: quoteToken.symbol,
                     priceScaled: poolSell.price0_1_scaled.toString()
                 }
             ],
             amountIn: amountIn, amountOut: amountOut,
             timestamp: Date.now()
         };
     }
}

module.exports = SpatialFinder;
