// core/finders/spatialFinder.js
// --- VERSION 1.1: Enhanced debug logging ---

const logger = require('../../utils/logger'); // Adjust path if needed
const { handleError, ArbitrageError } = require('../../utils/errorHandler'); // Adjust path if needed, added ArbitrageError
// Assuming scannerUtils provides these helpers:
// getScaledPriceRatio: Calculates (sqrtPriceX96 / 2^96) * scale
// formatScaledBigIntForLogging: Formats a scaled bigint nicely for logging
const { getScaledPriceRatio, formatScaledBigIntForLogging } = require('../scannerUtils'); // Adjust path if needed

// Constants
const BIGNUM_SCALE_DECIMALS = 36; // Use a large number of decimals for precision
const BIGNUM_SCALE = 10n ** BigInt(BIGNUM_SCALE_DECIMALS);
// Example threshold: 0.05% profit -> 1.0005 multiplier
// Threshold slightly above 1 to account for fees already included in effective prices
const PROFIT_THRESHOLD_SCALED = (10001n * BIGNUM_SCALE) / 10000n; // Require > 0.01% profit *after* estimated fees
const TEN_THOUSAND = 10000n; // For basis points calculation

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
        const logPrefix = '[SpatialFinder]';
        logger.info(`${logPrefix} Starting spatial (UniV3 vs SushiSwap) opportunity scan...`);
        const opportunities = [];
        const checkedPairings = new Set();
        const poolsByPair = {};

        // 1. Group pools by pair and DEX type
        if (!livePoolStatesMap || Object.keys(livePoolStatesMap).length === 0) {
             logger.warn(`${logPrefix} No live pool states provided.`);
             return opportunities;
        }
        for (const address in livePoolStatesMap) {
            try {
                const poolState = livePoolStatesMap[address];
                // Basic validation of pool state structure needed for grouping
                if (!poolState || !poolState.token0Symbol || !poolState.token1Symbol || !poolState.dexType) {
                     logger.warn(`${logPrefix} Skipping invalid pool state for grouping: ${address}`);
                     continue;
                }
                const pairKey = [poolState.token0Symbol, poolState.token1Symbol].sort().join('/');
                if (!poolsByPair[pairKey]) { poolsByPair[pairKey] = { uniswapV3: [], sushiswap: [] }; }

                // Only add if pool seems valid for price calculation
                if (poolState.dexType === 'uniswapV3' && poolState.sqrtPriceX96 && poolState.sqrtPriceX96 > 0n && typeof poolState.fee === 'number') {
                     poolsByPair[pairKey].uniswapV3.push(poolState);
                } else if (poolState.dexType === 'sushiswap' && poolState.reserve0 && poolState.reserve1 && poolState.reserve0 > 0n && poolState.reserve1 > 0n && typeof poolState.fee === 'number') {
                     poolsByPair[pairKey].sushiswap.push(poolState);
                }
            } catch (groupingError) {
                 logger.error(`${logPrefix} Error grouping pool ${address}: ${groupingError.message}`);
            }
        }

        // 2. Iterate and compare pools within each pair
        logger.debug(`${logPrefix} Starting comparisons across ${Object.keys(poolsByPair).length} pairs.`);
        for (const pairKey in poolsByPair) {
            const pairPools = poolsByPair[pairKey];
            if (pairPools.uniswapV3.length === 0 || pairPools.sushiswap.length === 0) {
                // logger.debug(`${logPrefix} Skipping pair ${pairKey}: Missing pools on one DEX.`);
                continue;
            }
            logger.debug(`${logPrefix} --- Checking Pair: ${pairKey} ---`);

            for (const v3Pool of pairPools.uniswapV3) {
                for (const sushiPool of pairPools.sushiswap) {
                    // Avoid duplicate checks if multiple V3/Sushi pools exist for same pair
                    const pairingId = `${v3Pool.address}-${sushiPool.address}`;
                    if (checkedPairings.has(pairingId)) continue;
                    checkedPairings.add(pairingId);

                    const compareLogPrefix = `${logPrefix} Compare [${pairKey}] V3(${v3Pool.fee}bps) vs Sushi:`;

                    try {
                        // Calculate RAW scaled prices (token1 / token0)
                        const priceV3_scaled = this._calculateV3Price(v3Pool);
                        const priceSushi_scaled = this._calculateSushiPrice(sushiPool);

                        if (priceV3_scaled === null || priceSushi_scaled === null) {
                            logger.warn(`${compareLogPrefix} Skipping comparison due to null raw price calculation.`);
                            continue;
                        }

                        // Calculate EFFECTIVE prices including fees
                        const v3FeeBps = BigInt(v3Pool.fee);
                        const sushiFeeBps = BigInt(sushiPool.fee); // Should be 30 for standard Sushi

                        // Scenario 1: Buy on Sushi, Sell on V3 (Check if V3 price > Sushi price)
                        // We pay sushiFeeBps when buying, v3FeeBps when selling
                        const effectiveSushiBuyPrice_scaled = (priceSushi_scaled * TEN_THOUSAND * BIGNUM_SCALE) / ((TEN_THOUSAND - sushiFeeBps) * BIGNUM_SCALE); // Higher price due to fee
                        const effectiveV3SellPrice_scaled = (priceV3_scaled * (TEN_THOUSAND - v3FeeBps)) / TEN_THOUSAND; // Lower price due to fee

                        // Scenario 2: Buy on V3, Sell on Sushi (Check if Sushi price > V3 price)
                        // We pay v3FeeBps when buying, sushiFeeBps when selling
                        const effectiveV3BuyPrice_scaled = (priceV3_scaled * TEN_THOUSAND * BIGNUM_SCALE) / ((TEN_THOUSAND - v3FeeBps) * BIGNUM_SCALE); // Higher price due to fee
                        const effectiveSushiSellPrice_scaled = (priceSushi_scaled * (TEN_THOUSAND - sushiFeeBps)) / TEN_THOUSAND; // Lower price due to fee


                        // --- ENHANCED DEBUG LOG ---
                        logger.debug(`${compareLogPrefix}`);
                        logger.debug(`  Raw Prices   | V3: ${formatScaledBigIntForLogging(priceV3_scaled, BIGNUM_SCALE_DECIMALS)} | Sushi: ${formatScaledBigIntForLogging(priceSushi_scaled, BIGNUM_SCALE_DECIMALS)}`);
                        logger.debug(`  Sushi->V3 Eff| Buy Sushi: ${formatScaledBigIntForLogging(effectiveSushiBuyPrice_scaled, BIGNUM_SCALE_DECIMALS)} | Sell V3: ${formatScaledBigIntForLogging(effectiveV3SellPrice_scaled, BIGNUM_SCALE_DECIMALS)}`);
                        logger.debug(`  V3->Sushi Eff| Buy V3: ${formatScaledBigIntForLogging(effectiveV3BuyPrice_scaled, BIGNUM_SCALE_DECIMALS)} | Sell Sushi: ${formatScaledBigIntForLogging(effectiveSushiSellPrice_scaled, BIGNUM_SCALE_DECIMALS)}`);
                        // --- END ENHANCED DEBUG LOG ---


                        // Check Opportunities (Both Directions) using effective prices and threshold
                        let foundOpp = false;

                        // Scenario 1 Check: Sell V3 > (Buy Sushi * Threshold) ?
                        if (effectiveV3SellPrice_scaled * BIGNUM_SCALE > effectiveSushiBuyPrice_scaled * PROFIT_THRESHOLD_SCALED) {
                            foundOpp = true;
                            const estimatedRateNum = (effectiveV3SellPrice_scaled * BIGNUM_SCALE) / effectiveSushiBuyPrice_scaled; // Rate > 1.0 means profit
                            logger.info(`${logPrefix} >>> Opportunity [${pairKey}]: Buy on Sushi (${sushiPool.address}), Sell on V3 (${v3Pool.address}) | Est Rate: ${formatScaledBigIntForLogging(estimatedRateNum, BIGNUM_SCALE_DECIMALS)} <<<`);
                            opportunities.push({
                                 type: 'spatial',
                                 // Path depends on which token is base in price calc (token1/token0)
                                 // Assuming price is token1/token0, buying base on Sushi means sending token1, receiving token0
                                 // Selling base on V3 means sending token0, receiving token1. Path: T1 -> T0 (Sushi) -> T1 (V3) ? This needs review based on execution needs.
                                 // Let's simplify path for now, execution logic will need the pools.
                                 pathSymbols: [sushiPool.token1Symbol, sushiPool.token0Symbol, v3Pool.token1Symbol], // Example path Token1 -> Token0 -> Token1
                                 buyPool: sushiPool, // Pool to buy from (send token1, receive token0)
                                 sellPool: v3Pool, // Pool to sell to (send token0, receive token1)
                                 estimatedRate: formatScaledBigIntForLogging(estimatedRateNum, BIGNUM_SCALE_DECIMALS),
                                 groupName: `${pairKey}_Sushi_to_V3_${v3Pool.fee}`
                             });
                        }

                        // Scenario 2 Check: Sell Sushi > (Buy V3 * Threshold) ?
                        if (effectiveSushiSellPrice_scaled * BIGNUM_SCALE > effectiveV3BuyPrice_scaled * PROFIT_THRESHOLD_SCALED) {
                             foundOpp = true;
                             const estimatedRateNum = (effectiveSushiSellPrice_scaled * BIGNUM_SCALE) / effectiveV3BuyPrice_scaled; // Rate > 1.0 means profit
                             logger.info(`${logPrefix} >>> Opportunity [${pairKey}]: Buy on V3 (${v3Pool.address}), Sell on Sushi (${sushiPool.address}) | Est Rate: ${formatScaledBigIntForLogging(estimatedRateNum, BIGNUM_SCALE_DECIMALS)} <<<`);
                             opportunities.push({
                                 type: 'spatial',
                                 // Path: Token1 -> Token0 (V3) -> Token1 (Sushi)
                                 pathSymbols: [v3Pool.token1Symbol, v3Pool.token0Symbol, sushiPool.token1Symbol], // Example path Token1 -> Token0 -> Token1
                                 buyPool: v3Pool,   // Pool to buy from (send token1, receive token0)
                                 sellPool: sushiPool, // Pool to sell to (send token0, receive token1)
                                 estimatedRate: formatScaledBigIntForLogging(estimatedRateNum, BIGNUM_SCALE_DECIMALS),
                                 groupName: `${pairKey}_V3_${v3Pool.fee}_to_Sushi`
                             });
                         }

                         if (!foundOpp) {
                              logger.debug(`${compareLogPrefix} No profitable opportunity found meeting threshold.`);
                         }

                    } catch (priceError) {
                        logger.error(`${compareLogPrefix} Error calculating/comparing prices between ${v3Pool.address} and ${sushiPool.address}: ${priceError.message}`);
                         // Use imported handleError function
                        if (typeof handleError === 'function') handleError(priceError, `SpatialPriceCalc ${pairKey}`);
                        // Optionally wrap in ArbitrageError if needed downstream
                        // throw new ArbitrageError(`SpatialPriceCalc ${pairKey}`, priceError.message);
                    }
                } // End Sushi loop
            } // End V3 loop
        } // End pair loop
        logger.info(`${logPrefix} Scan finished. Found ${opportunities.length} potential spatial opportunities.`);
        return opportunities;
    }


    // --- Price Calculation Helpers (Assuming token1/token0 price) ---
    // Returns scaled price (token1/token0) * BIGNUM_SCALE or null
    _calculateV3Price(poolState) {
        // Add more validation at the start
         if (!poolState || !poolState.sqrtPriceX96 || poolState.sqrtPriceX96 <= 0n || !poolState.token0 || !poolState.token1 || !poolState.token0.decimals || !poolState.token1.decimals) {
            logger.warn(`[SpatialFinder _calculateV3Price] Invalid pool state or tokens for V3 price calc: ${poolState?.address}`);
            return null;
        }
         try {
             // price = (sqrtPriceX96 / 2^96)^2
             // We scale first to maintain precision
             const priceRatioX96_scaled = getScaledPriceRatio(poolState.sqrtPriceX96, BIGNUM_SCALE); // sqrtPrice * scale / 2^96
             if (priceRatioX96_scaled === null) return null; // Handle error from helper

             const price_scaled = (priceRatioX96_scaled * priceRatioX96_scaled) / BIGNUM_SCALE; // (priceRatio * scale)^2 / scale = price^2 * scale

             // Adjust for decimals: price * 10^(decimals1 - decimals0)
             const decimals0 = BigInt(poolState.token0.decimals);
             const decimals1 = BigInt(poolState.token1.decimals);
             const decimalDiff = decimals1 - decimals0;

             let adjustedPrice_scaled;
             if (decimalDiff >= 0n) {
                  const factor = 10n ** decimalDiff;
                  adjustedPrice_scaled = (price_scaled * factor); // Multiplication maintains scale
             } else { // decimalDiff is negative
                  const factor = 10n ** (-decimalDiff);
                  if (factor === 0n) { // Avoid division by zero if decimals differ hugely
                      logger.error(`[SpatialFinder _calculateV3Price] Decimal difference too large for pool ${poolState.address}, results in division by zero.`);
                      return null;
                  }
                  // Division requires careful handling of scale
                  // (price^2 * scale * 10^dec_diff) = (price^2 * scale) / (10 ^ -dec_diff)
                  adjustedPrice_scaled = price_scaled / factor;
             }
             return adjustedPrice_scaled; // This is scaled price of token0 in terms of token1
         } catch (e) {
             logger.error(`[SpatialFinder _calculateV3Price] Error during calculation for ${poolState.address}: ${e.message}`);
             return null;
         }
     }

    // Returns scaled price (token1/token0) * BIGNUM_SCALE or null
    _calculateSushiPrice(poolState) {
         // Add more validation at the start
         if (!poolState || !poolState.reserve0 || !poolState.reserve1 || poolState.reserve0 <= 0n || poolState.reserve1 <= 0n || !poolState.token0 || !poolState.token1 || !poolState.token0.decimals || !poolState.token1.decimals) {
            logger.warn(`[SpatialFinder _calculateSushiPrice] Invalid pool state or tokens for Sushi price calc: ${poolState?.address}`);
            return null;
        }
         try {
              // Price = reserve1 / reserve0 (adjusted for decimals)
              const reserve0 = poolState.reserve0;
              const reserve1 = poolState.reserve1;
              const decimals0 = BigInt(poolState.token0.decimals);
              const decimals1 = BigInt(poolState.token1.decimals);
              const scale = BIGNUM_SCALE;

              // Calculate price = (reserve1 / 10^dec1) / (reserve0 / 10^dec0)
              // price = (reserve1 * 10^dec0) / (reserve0 * 10^dec1)
              // price_scaled = price * scale = (reserve1 * 10^dec0 * scale) / (reserve0 * 10^dec1)

              let price_scaled;
              // To avoid large intermediate numbers, adjust difference first
              if (decimals1 >= decimals0) {
                   // Need to divide reserve0 by 10^(dec1-dec0) before dividing reserve1 by it
                   // price_scaled = (reserve1 * scale) / (reserve0 * 10^(dec1 - dec0))
                   const factor = 10n ** (decimals1 - decimals0);
                   const scaled_denominator = reserve0 * factor;
                   if (scaled_denominator === 0n) return null; // Avoid division by zero
                   price_scaled = (reserve1 * scale) / scaled_denominator;
              } else { // decimals0 > decimals1
                   // Need to multiply reserve1 by 10^(dec0-dec1) before dividing by reserve0
                   // price_scaled = (reserve1 * 10^(dec0 - dec1) * scale) / reserve0
                   const factor = 10n ** (decimals0 - decimals1);
                   price_scaled = (reserve1 * factor * scale) / reserve0;
              }

              return price_scaled; // This is scaled price of token0 in terms of token1
         } catch (e) {
             logger.error(`[SpatialFinder _calculateSushiPrice] Error during calculation for ${poolState.address}: ${e.message}`);
             return null;
         }
     }
}

module.exports = SpatialFinder;
