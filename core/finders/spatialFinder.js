// core/finders/spatialFinder.js
const logger = require('../../utils/logger');
const { getCanonicalPairKey } = require('../../utils/pairUtils');
const { getUniV3Price, getV2Price, getDodoPrice, BIGNUMBER_1E18 } = require('../../utils/priceUtils');

// --- Configuration ---
const MAX_REASONABLE_PRICE_DIFF_BIPS = 5000n; // 50% diff - still huge, but filters infinities (Adjust later)
const MIN_PRICE_DIFF_BIPS = 10n; // 0.1% diff (Example - adjust based on fees/gas)
const BASIS_POINTS_DENOMINATOR = 10000n;

class SpatialFinder {
    constructor(config) {
        this.config = config;
        this.pairRegistry = new Map();
        logger.info(`[SpatialFinder v1.24] Initialized (Calculates Prices, Sanity Check Added).`);
    }

    updatePairRegistry(registry) {
        if (!registry || !(registry instanceof Map)) { logger.warn('[SpatialFinder] Invalid registry update.'); return; }
        this.pairRegistry = registry;
        logger.debug(`[SpatialFinder] Pair registry updated. Size: ${this.pairRegistry.size}`);
    }

    _calculatePrice(poolState) {
        // ... (Keep the _calculatePrice method from Response #28 - no changes needed here) ...
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
                case 'sushiswap':
                    if (poolState.reserve0 !== undefined && poolState.reserve1 !== undefined) {
                         if (poolState.reserve0 === 0n || poolState.reserve1 === 0n) return null;
                         return getV2Price(poolState.reserve0, poolState.reserve1, token0, token1);
                    }
                    break;
                case 'dodo':
                    if (poolState.queryAmountOutWei !== undefined && poolState.queryBaseToken && poolState.queryQuoteToken) {
                        const priceBaseInQuote = getDodoPrice(poolState.queryAmountOutWei, poolState.queryBaseToken, poolState.queryQuoteToken);
                        if (priceBaseInQuote === null) return null;
                        if (token0.address.toLowerCase() === poolState.queryBaseToken.address.toLowerCase()) {
                            return priceBaseInQuote;
                        } else {
                            if (priceBaseInQuote === 0n) return null;
                            return (BIGNUMBER_1E18 * BIGNUMBER_1E18) / priceBaseInQuote;
                        }
                    }
                    break;
                default:
                    logger.warn(`[SpatialFinder._calculatePrice] Unknown dexType ${dexType}`);
            }
        } catch (error) {
            logger.error(`[SpatialFinder._calculatePrice] Error for ${poolState.address}: ${error.message}`);
        }
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
                    const priceA = poolA.price0_1_scaled;
                    const priceB = poolB.price0_1_scaled;

                    const priceDiff = priceA > priceB ? priceA - priceB : priceB - priceA;
                    const minPrice = priceA < priceB ? priceA : priceB;
                    if (minPrice === 0n) continue; // Avoid division by zero

                    const diffBips = (priceDiff * BASIS_POINTS_DENOMINATOR) / minPrice;

                    // *** ADD SANITY CHECK ***
                    if (diffBips > MAX_REASONABLE_PRICE_DIFF_BIPS) {
                         logger.warn(`[SpatialFinder] Implausible price diff (${diffBips} bips) between ${poolA.dexType}/${poolA.address.substring(0,6)} and ${poolB.dexType}/${poolB.address.substring(0,6)} for ${canonicalKey}. Skipping.`);
                         continue; // Skip this pair comparison
                    }
                    // *** END SANITY CHECK ***

                    // Compare against minimum threshold (ignoring fees for now)
                    if (diffBips >= MIN_PRICE_DIFF_BIPS) {
                        let poolBuy, poolSell;
                        if (priceA < priceB) { poolBuy = poolA; poolSell = poolB; }
                        else { poolBuy = poolB; poolSell = poolA; }

                        const token0 = poolA.token0; const token1 = poolA.token1;
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

     _createOpportunity(poolBuy, poolSell, canonicalKey) {
        // ... (keep the _createOpportunity method from Response #28 - no changes needed here) ...
        const targetToken = poolBuy.token0;
        const quoteToken = poolBuy.token1;
         const amountIn = '1000000000000000000';
         const amountOut = '1001000000000000000';

         return {
             type: 'spatial',
             pairKey: canonicalKey,
             tokenIn: quoteToken.symbol,
             tokenIntermediate: targetToken.symbol,
             tokenOut: quoteToken.symbol,
             path: [
                 {
                     dex: poolBuy.dexType, address: poolBuy.address,
                     pair: [poolBuy.token0.symbol, poolBuy.token1.symbol],
                     action: 'buy', tokenIn: quoteToken.symbol, tokenOut: targetToken.symbol,
                     priceScaled: poolBuy.price0_1_scaled.toString()
                 },
                 {
                     dex: poolSell.dexType, address: poolSell.address,
                     pair: [poolSell.token0.symbol, poolSell.token1.symbol],
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
