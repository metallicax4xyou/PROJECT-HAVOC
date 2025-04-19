// core/finders/spatialFinder.js
const logger = require('../../utils/logger'); // Adjust path if needed
const { handleError } = require('../../utils/errorHandler'); // Adjust path if needed
const { getScaledPriceRatio, formatScaledBigIntForLogging } = require('../scannerUtils'); // Adjust path if needed

// Constants can be defined here or imported from a central constants file if preferred
const BIGNUM_SCALE_DECIMALS = 36;
const BIGNUM_SCALE = 10n ** BigInt(BIGNUM_SCALE_DECIMALS);
const PROFIT_THRESHOLD_SCALED = (10005n * BIGNUM_SCALE) / 10000n; // 1.0005x scaled profit threshold

class SpatialFinder {
    constructor() {
        logger.info('[SpatialFinder] Initialized.');
        // No config needed directly for this finder logic itself
    }

    /**
     * Finds potential spatial arbitrage opportunities (V3 vs Sushi) from a map of live pool states.
     * @param {object} livePoolStatesMap Map of poolAddress.toLowerCase() -> poolState object.
     * @returns {Array<object>} An array of potential spatial opportunity objects.
     */
    findOpportunities(livePoolStatesMap) {
        logger.info(`[SpatialFinder] Starting spatial (UniV3 vs SushiSwap) opportunity scan...`);
        const opportunities = [];
        const checkedPairings = new Set();
        const poolsByPair = {};

        // 1. Group pools by pair and DEX type
        for (const address in livePoolStatesMap) {
            const poolState = livePoolStatesMap[address];
            const pairKey = [poolState.token0Symbol, poolState.token1Symbol].sort().join('/');
            if (!poolsByPair[pairKey]) { poolsByPair[pairKey] = { uniswapV3: [], sushiswap: [] }; }
            if (poolState.dexType === 'uniswapV3' && poolState.sqrtPriceX96 !== null && poolState.liquidity > 0n) { poolsByPair[pairKey].uniswapV3.push(poolState); }
            else if (poolState.dexType === 'sushiswap' && poolState.reserve0 > 0n && poolState.reserve1 > 0n) { poolsByPair[pairKey].sushiswap.push(poolState); }
        }

        // 2. Iterate and compare pools within each pair
        for (const pairKey in poolsByPair) {
            const pairPools = poolsByPair[pairKey];
            if (pairPools.uniswapV3.length === 0 || pairPools.sushiswap.length === 0) continue;
            logger.debug(`[SpatialFinder] Checking pair: ${pairKey}`);
            for (const v3Pool of pairPools.uniswapV3) {
                for (const sushiPool of pairPools.sushiswap) {
                    const pairingId = `${v3Pool.address}-${sushiPool.address}`;
                    if (checkedPairings.has(pairingId)) continue; checkedPairings.add(pairingId);
                    try {
                        const priceV3 = this._calculateV3Price(v3Pool);
                        const priceSushi = this._calculateSushiPrice(sushiPool);
                        if (priceV3 === null || priceSushi === null) continue;
                        logger.debug(`  Pairing: ${v3Pool.groupName}(${v3Pool.fee}) vs ${sushiPool.groupName} | V3 Price: ${formatScaledBigIntForLogging(priceV3, BIGNUM_SCALE_DECIMALS)} | Sushi Price: ${formatScaledBigIntForLogging(priceSushi, BIGNUM_SCALE_DECIMALS)}`);

                        // Check Opportunities (Both Directions)
                        const TEN_THOUSAND = 10000n;
                        const v3FeeBps = BigInt(v3Pool.fee);
                        const sushiFeeBps = BigInt(sushiPool.fee);

                        // Scenario 1: Buy on Sushi, Sell on V3
                        const effectiveSushiBuyPrice = (priceSushi * TEN_THOUSAND * BIGNUM_SCALE) / ((TEN_THOUSAND - sushiFeeBps) * BIGNUM_SCALE);
                        const effectiveV3SellPrice = (priceV3 * (TEN_THOUSAND - v3FeeBps)) / TEN_THOUSAND;
                        if (effectiveV3SellPrice > (effectiveSushiBuyPrice * PROFIT_THRESHOLD_SCALED) / BIGNUM_SCALE) {
                            logger.info(`[SpatialFinder] >>> Opportunity [${pairKey}]: Buy on Sushi (${sushiPool.address}), Sell on V3 (${v3Pool.address}) <<<`);
                            logger.info(`    V3 Sell Price (est): ${formatScaledBigIntForLogging(effectiveV3SellPrice, BIGNUM_SCALE_DECIMALS)} > Sushi Buy Price (est): ${formatScaledBigIntForLogging(effectiveSushiBuyPrice, BIGNUM_SCALE_DECIMALS)}`);
                            const opportunity = {
                                 type: 'spatial',
                                 pathSymbols: [sushiPool.token0Symbol, sushiPool.token1Symbol, sushiPool.token0Symbol],
                                 buyPool: sushiPool,
                                 sellPool: v3Pool,
                                 estimatedRate: formatScaledBigIntForLogging((effectiveV3SellPrice * BIGNUM_SCALE * BIGNUM_SCALE) / effectiveSushiBuyPrice, BIGNUM_SCALE_DECIMALS),
                                 groupName: `${pairKey}_Sushi_to_V3_${v3Pool.fee}`
                             };
                            opportunities.push(opportunity);
                        }

                        // Scenario 2: Buy on V3, Sell on Sushi
                        const effectiveV3BuyPrice = (priceV3 * TEN_THOUSAND * BIGNUM_SCALE) / ((TEN_THOUSAND - v3FeeBps) * BIGNUM_SCALE);
                        const effectiveSushiSellPrice = (priceSushi * (TEN_THOUSAND - sushiFeeBps)) / TEN_THOUSAND;
                        if (effectiveSushiSellPrice > (effectiveV3BuyPrice * PROFIT_THRESHOLD_SCALED) / BIGNUM_SCALE) {
                             logger.info(`[SpatialFinder] >>> Opportunity [${pairKey}]: Buy on V3 (${v3Pool.address}), Sell on Sushi (${sushiPool.address}) <<<`);
                             logger.info(`    Sushi Sell Price (est): ${formatScaledBigIntForLogging(effectiveSushiSellPrice, BIGNUM_SCALE_DECIMALS)} > V3 Buy Price (est): ${formatScaledBigIntForLogging(effectiveV3BuyPrice, BIGNUM_SCALE_DECIMALS)}`);
                             const opportunity = {
                                 type: 'spatial',
                                 pathSymbols: [v3Pool.token0Symbol, v3Pool.token1Symbol, v3Pool.token0Symbol],
                                 buyPool: v3Pool,
                                 sellPool: sushiPool,
                                 estimatedRate: formatScaledBigIntForLogging((effectiveSushiSellPrice * BIGNUM_SCALE * BIGNUM_SCALE) / effectiveV3BuyPrice, BIGNUM_SCALE_DECIMALS),
                                 groupName: `${pairKey}_V3_${v3Pool.fee}_to_Sushi`
                             };
                             opportunities.push(opportunity);
                         }
                    } catch (priceError) {
                        logger.error(`[SpatialFinder] Error calculating/comparing prices for ${pairKey} between ${v3Pool.address} and ${sushiPool.address}: ${priceError.message}`);
                        if (typeof handleError === 'function') handleError(priceError, `SpatialPriceCalc ${pairKey}`);
                    }
                } // End Sushi loop
            } // End V3 loop
        } // End pair loop
        logger.info(`[SpatialFinder] Scan finished. Found ${opportunities.length} potential spatial opportunities.`);
        return opportunities;
    }


    // --- Price Calculation Helpers ---
    _calculateV3Price(poolState) {
         if (!poolState || !poolState.sqrtPriceX96 || poolState.sqrtPriceX96 <= 0n || !poolState.token0 || !poolState.token1) return null;
         try {
             const priceRatioX96_scaled = getScaledPriceRatio(poolState.sqrtPriceX96, BIGNUM_SCALE);
             const price_scaled = (priceRatioX96_scaled * priceRatioX96_scaled) / BIGNUM_SCALE;
             const decimals0 = BigInt(poolState.token0.decimals); const decimals1 = BigInt(poolState.token1.decimals);
             const decimalDiff = decimals1 - decimals0;
             let adjustedPrice_scaled;
             if (decimalDiff >= 0n) { adjustedPrice_scaled = price_scaled * (10n ** decimalDiff); }
             else { const divisor = 10n ** (-decimalDiff); if (divisor === 0n) return null; adjustedPrice_scaled = price_scaled / divisor; }
             return adjustedPrice_scaled;
         } catch (e) { logger.error(`Error in _calculateV3Price for ${poolState.address}: ${e.message}`); return null; }
     }

    _calculateSushiPrice(poolState) {
         if (!poolState || !poolState.reserve0 || !poolState.reserve1 || poolState.reserve0 <= 0n || poolState.reserve1 <= 0n || !poolState.token0 || !poolState.token1) return null;
         try {
              const reserve0 = poolState.reserve0; const reserve1 = poolState.reserve1;
              const decimals0 = BigInt(poolState.token0.decimals); const decimals1 = BigInt(poolState.token1.decimals);
              const scale = BIGNUM_SCALE; let price_scaled;
              if (decimals1 >= decimals0) { const factor = 10n ** (decimals1 - decimals0); if (reserve0 * factor === 0n) return null; price_scaled = (reserve1 * scale) / (reserve0 * factor); }
              else { const factor = 10n ** (decimals0 - decimals1); price_scaled = (reserve1 * factor * scale) / reserve0; }
              return price_scaled;
         } catch (e) { logger.error(`Error in _calculateSushiPrice for ${poolState.address}: ${e.message}`); return null; }
     }
}

module.exports = SpatialFinder;
