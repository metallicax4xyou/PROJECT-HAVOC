// core/finders/spatialFinder.js
// --- VERSION 1.5: Using logger.debug for detailed grouping logs ---

const logger = require('../../utils/logger'); // Use the logger consistently
const { handleError, ArbitrageError } = require('../../utils/errorHandler');
const { getScaledPriceRatio, formatScaledBigIntForLogging } = require('../scannerUtils');

// Constants
const BIGNUM_SCALE_DECIMALS = 36;
const BIGNUM_SCALE = 10n ** BigInt(BIGNUM_SCALE_DECIMALS);
const PROFIT_THRESHOLD_SCALED = (10001n * BIGNUM_SCALE) / 10000n; // Require > 0.01% profit *after* estimated fees
const TEN_THOUSAND = 10000n;

class SpatialFinder {
    constructor() {
        logger.info('[SpatialFinder] Initialized.');
    }

    findOpportunities(livePoolStatesMap) {
        const logPrefix = '[SpatialFinder]';
        logger.info(`${logPrefix} Starting spatial (UniV3 vs SushiSwap) opportunity scan...`);
        const opportunities = [];
        const checkedPairings = new Set();
        const poolsByPair = {}; // Reset for each cycle

        // --- Step 1: Group pools by pair and DEX type ---
        const poolAddresses = livePoolStatesMap ? Object.keys(livePoolStatesMap) : [];
        // Use logger.debug for this crucial step
        logger.debug(`--- SPATIAL FINDER GROUPING (Cycle ${this.cycleCount || 'N/A'}) ---`); // Mark clearly in logs
        logger.debug(`[SpatialFinder Grouping] Starting grouping for ${poolAddresses.length} addresses.`);

        if (poolAddresses.length === 0) {
             logger.warn(`${logPrefix} No live pool states provided to group.`);
             return opportunities;
        }

        for (const address of poolAddresses) {
            const poolState = livePoolStatesMap[address];
            const groupLogPrefix = `${logPrefix} Grouping pool ${address}:`; // Use logger prefix

            try {
                // Basic Structure Check
                if (!poolState || !poolState.token0Symbol || !poolState.token1Symbol || !poolState.dexType) {
                     logger.debug(`${groupLogPrefix} Skipping - Invalid basic structure.`); // Use logger
                     continue;
                }
                logger.debug(`${groupLogPrefix} Basic structure OK (dexType: ${poolState.dexType}).`);

                // Generate Pair Key
                const pairKey = [poolState.token0Symbol, poolState.token1Symbol].sort().join('/');
                logger.debug(`${groupLogPrefix} Generated pairKey: '${pairKey}'.`);
                if (!poolsByPair[pairKey]) {
                     logger.debug(`${groupLogPrefix} Initializing group for pairKey '${pairKey}'.`);
                     poolsByPair[pairKey] = { uniswapV3: [], sushiswap: [] };
                }

                // Add to Group if Valid
                let addedToGroup = false;
                if (poolState.dexType === 'uniswapV3') {
                    const hasSqrtP = !!poolState.sqrtPriceX96 && poolState.sqrtPriceX96 > 0n;
                    const hasFee = typeof poolState.fee === 'number';
                    const isValidV3 = hasSqrtP && hasFee;
                    logger.debug(`${groupLogPrefix} Checking V3 validity: hasSqrtP=${hasSqrtP}, hasFee=${hasFee} -> isValidV3=${isValidV3}`);
                    if (isValidV3) {
                        poolsByPair[pairKey].uniswapV3.push(poolState);
                        addedToGroup = true;
                        logger.debug(`${groupLogPrefix} Added to uniswapV3 group for key '${pairKey}'.`);
                    }
                } else if (poolState.dexType === 'sushiswap') {
                    const hasR0 = !!poolState.reserve0 && poolState.reserve0 > 0n;
                    const hasR1 = !!poolState.reserve1 && poolState.reserve1 > 0n;
                    const hasFee = typeof poolState.fee === 'number'; // Fee is now added to sushi state
                    const isValidSushi = hasR0 && hasR1 && hasFee;
                    logger.debug(`${groupLogPrefix} Checking Sushi validity: hasR0=${hasR0}, hasR1=${hasR1}, hasFee=${hasFee} -> isValidSushi=${isValidSushi}`);
                    if (isValidSushi) {
                        poolsByPair[pairKey].sushiswap.push(poolState);
                        addedToGroup = true;
                        logger.debug(`${groupLogPrefix} Added to sushiswap group for key '${pairKey}'.`);
                    }
                }

                if (!addedToGroup) {
                    logger.debug(`${groupLogPrefix} Not added to any comparison group.`); // Use logger
                }

            } catch (groupingError) {
                 // Log via logger primarily, console as backup if logger fails
                 logger.error(`${groupLogPrefix} !!! UNEXPECTED ERROR during grouping: ${groupingError.message}`, groupingError);
                 console.error(`  [SpatialFinder Console Backup] !!! UNEXPECTED ERROR during grouping for ${address}: ${groupingError.message}`, groupingError);
            }
        } // End grouping loop

        // --- Log Final Grouping Structure using logger.debug ---
        logger.debug(`${logPrefix} --- Final Grouping Structure ---`);
        for (const key in poolsByPair) {
            logger.debug(`  PairKey: '${key}' | V3 Count: ${poolsByPair[key].uniswapV3.length} | Sushi Count: ${poolsByPair[key].sushiswap.length}`);
        }
        logger.debug(`${logPrefix} --- End Final Grouping Structure ---`);
        logger.debug(`--- END SPATIAL FINDER GROUPING ---`); // Mark end clearly


        // --- Step 2: Iterate and compare pools (using logger) ---
        const pairKeysToCompare = Object.keys(poolsByPair);
        logger.debug(`${logPrefix} Starting comparisons across ${pairKeysToCompare.length} unique pairs found in grouping.`);
        if (pairKeysToCompare.length === 0) {
            logger.warn(`${logPrefix} No pairs found after grouping. Check grouping logic or pool data validity.`);
        }

        for (const pairKey of pairKeysToCompare) {
            const pairPools = poolsByPair[pairKey];
            logger.debug(`${logPrefix} Evaluating pair: ${pairKey} (V3: ${pairPools.uniswapV3.length}, Sushi: ${pairPools.sushiswap.length})`);

            if (pairPools.uniswapV3.length === 0 || pairPools.sushiswap.length === 0) {
                logger.debug(`${logPrefix} Skipping pair ${pairKey}: Missing pools on one DEX type.`);
                continue;
            }
            logger.debug(`${logPrefix} <<<>>> Proceeding with comparison for pair: ${pairKey} <<<>>>`);

            // Comparison logic using logger...
            for (const v3Pool of pairPools.uniswapV3) {
                for (const sushiPool of pairPools.sushiswap) {
                    const pairingId = `${v3Pool.address}-${sushiPool.address}`;
                    if (checkedPairings.has(pairingId)) continue;
                    checkedPairings.add(pairingId);

                    const compareLogPrefix = `${logPrefix} Compare [${pairKey}] V3(${v3Pool.fee}bps) vs Sushi:`;
                    logger.debug(`${compareLogPrefix} Comparing V3 Pool ${v3Pool.address} vs Sushi Pool ${sushiPool.address}`);
                    try {
                        logger.debug(`${compareLogPrefix} Calculating prices...`);
                        const priceV3_scaled = this._calculateV3Price(v3Pool);
                        const priceSushi_scaled = this._calculateSushiPrice(sushiPool);
                        logger.debug(`${compareLogPrefix} Price calculation done. V3: ${priceV3_scaled !== null}, Sushi: ${priceSushi_scaled !== null}`);

                        if (priceV3_scaled === null || priceSushi_scaled === null) {
                             logger.warn(`${compareLogPrefix} Skipping comparison due to null raw price calculation.`);
                             continue; // Continue to next pool pairing
                         }

                        logger.debug(`${compareLogPrefix} Calculating effective prices...`);
                        const v3FeeBps = BigInt(v3Pool.fee);
                        const sushiFeeBps = BigInt(sushiPool.fee);
                        const effectiveSushiBuyPrice_scaled = (priceSushi_scaled * TEN_THOUSAND * BIGNUM_SCALE) / ((TEN_THOUSAND - sushiFeeBps) * BIGNUM_SCALE);
                        const effectiveV3SellPrice_scaled = (priceV3_scaled * (TEN_THOUSAND - v3FeeBps)) / TEN_THOUSAND;
                        const effectiveV3BuyPrice_scaled = (priceV3_scaled * TEN_THOUSAND * BIGNUM_SCALE) / ((TEN_THOUSAND - v3FeeBps) * BIGNUM_SCALE);
                        const effectiveSushiSellPrice_scaled = (priceSushi_scaled * (TEN_THOUSAND - sushiFeeBps)) / TEN_THOUSAND;
                        logger.debug(`${compareLogPrefix} Effective price calculation done.`);

                        // --- Enhanced Debug Log ---
                        logger.debug(`${compareLogPrefix}`); // Separator
                        logger.debug(`  Raw Prices   | V3: ${formatScaledBigIntForLogging(priceV3_scaled, BIGNUM_SCALE_DECIMALS)} | Sushi: ${formatScaledBigIntForLogging(priceSushi_scaled, BIGNUM_SCALE_DECIMALS)}`);
                        logger.debug(`  Sushi->V3 Eff| Buy Sushi: ${formatScaledBigIntForLogging(effectiveSushiBuyPrice_scaled, BIGNUM_SCALE_DECIMALS)} | Sell V3: ${formatScaledBigIntForLogging(effectiveV3SellPrice_scaled, BIGNUM_SCALE_DECIMALS)}`);
                        logger.debug(`  V3->Sushi Eff| Buy V3: ${formatScaledBigIntForLogging(effectiveV3BuyPrice_scaled, BIGNUM_SCALE_DECIMALS)} | Sell Sushi: ${formatScaledBigIntForLogging(effectiveSushiSellPrice_scaled, BIGNUM_SCALE_DECIMALS)}`);
                        // --- End Enhanced Debug Log ---

                        // Check Opportunities (Both Directions)
                        let foundOpp = false;
                        // Scenario 1: Sell V3 > (Buy Sushi * Threshold) ?
                        if (effectiveV3SellPrice_scaled * BIGNUM_SCALE > effectiveSushiBuyPrice_scaled * PROFIT_THRESHOLD_SCALED) {
                             foundOpp = true;
                             const estimatedRateNum = (effectiveV3SellPrice_scaled * BIGNUM_SCALE) / effectiveSushiBuyPrice_scaled;
                             logger.info(`${logPrefix} >>> Opportunity [${pairKey}]: Buy on Sushi (${sushiPool.address}), Sell on V3 (${v3Pool.address}) | Est Rate: ${formatScaledBigIntForLogging(estimatedRateNum, BIGNUM_SCALE_DECIMALS)} <<<`);
                             opportunities.push({
                                 type: 'spatial',
                                 pathSymbols: [sushiPool.token1Symbol, sushiPool.token0Symbol, v3Pool.token1Symbol], // Example path Token1 -> Token0 -> Token1
                                 buyPool: sushiPool, // Pool to buy from (send token1, receive token0)
                                 sellPool: v3Pool, // Pool to sell to (send token0, receive token1)
                                 estimatedRate: formatScaledBigIntForLogging(estimatedRateNum, BIGNUM_SCALE_DECIMALS),
                                 groupName: `${pairKey}_Sushi_to_V3_${v3Pool.fee}`
                             });
                         }
                         // Scenario 2: Sell Sushi > (Buy V3 * Threshold) ?
                         if (effectiveSushiSellPrice_scaled * BIGNUM_SCALE > effectiveV3BuyPrice_scaled * PROFIT_THRESHOLD_SCALED) {
                             foundOpp = true;
                             const estimatedRateNum = (effectiveSushiSellPrice_scaled * BIGNUM_SCALE) / effectiveV3BuyPrice_scaled;
                             logger.info(`${logPrefix} >>> Opportunity [${pairKey}]: Buy on V3 (${v3Pool.address}), Sell on Sushi (${sushiPool.address}) | Est Rate: ${formatScaledBigIntForLogging(estimatedRateNum, BIGNUM_SCALE_DECIMALS)} <<<`);
                             opportunities.push({
                                 type: 'spatial',
                                 pathSymbols: [v3Pool.token1Symbol, v3Pool.token0Symbol, sushiPool.token1Symbol], // Example path Token1 -> Token0 -> Token1
                                 buyPool: v3Pool,   // Pool to buy from (send token1, receive token0)
                                 sellPool: sushiPool, // Pool to sell to (send token0, receive token1)
                                 estimatedRate: formatScaledBigIntForLogging(estimatedRateNum, BIGNUM_SCALE_DECIMALS),
                                 groupName: `${pairKey}_V3_${v3Pool.fee}_to_Sushi`
                             });
                         }
                        if (!foundOpp) { logger.debug(`${compareLogPrefix} No profitable opportunity found meeting threshold.`); }

                    } catch (priceError) {
                        logger.error(`${compareLogPrefix} Error calculating/comparing prices between ${v3Pool.address} and ${sushiPool.address}: ${priceError.message}`);
                         if (typeof handleError === 'function') handleError(priceError, `SpatialPriceCalc ${pairKey}`);
                    }
                } // End Sushi loop
            } // End V3 loop
        } // End pair loop

        logger.info(`${logPrefix} Scan finished. Found ${opportunities.length} potential spatial opportunities.`);
        return opportunities;
    }


    // --- Price Calculation Helpers (remain the same) ---
    _calculateV3Price(poolState) {
         if (!poolState || !poolState.sqrtPriceX96 || poolState.sqrtPriceX96 <= 0n || !poolState.token0 || !poolState.token1 || !poolState.token0.decimals || !poolState.token1.decimals) {
            logger.warn(`[SpatialFinder _calculateV3Price] Invalid pool state or tokens for V3 price calc: ${poolState?.address}`); return null;
         }
         try {
             const priceRatioX96_scaled = getScaledPriceRatio(poolState.sqrtPriceX96, BIGNUM_SCALE);
             if (priceRatioX96_scaled === null) return null;
             const price_scaled = (priceRatioX96_scaled * priceRatioX96_scaled) / BIGNUM_SCALE;
             const decimals0 = BigInt(poolState.token0.decimals); const decimals1 = BigInt(poolState.token1.decimals);
             const decimalDiff = decimals1 - decimals0;
             let adjustedPrice_scaled;
             if (decimalDiff >= 0n) { adjustedPrice_scaled = (price_scaled * (10n ** decimalDiff)); }
             else { const factor = 10n ** (-decimalDiff); if (factor === 0n) { logger.error(`[SpatialFinder _calculateV3Price] Decimal difference too large for pool ${poolState.address}, results in division by zero.`); return null; } adjustedPrice_scaled = price_scaled / factor; }
             return adjustedPrice_scaled;
         } catch (e) { logger.error(`[SpatialFinder _calculateV3Price] Error during calculation for ${poolState.address}: ${e.message}`); return null; }
     }

    _calculateSushiPrice(poolState) {
         if (!poolState || !poolState.reserve0 || !poolState.reserve1 || poolState.reserve0 <= 0n || poolState.reserve1 <= 0n || !poolState.token0 || !poolState.token1 || !poolState.token0.decimals || !poolState.token1.decimals) {
             logger.warn(`[SpatialFinder _calculateSushiPrice] Invalid pool state or tokens for Sushi price calc: ${poolState?.address}`); return null;
         }
         try {
              const reserve0 = poolState.reserve0; const reserve1 = poolState.reserve1;
              const decimals0 = BigInt(poolState.token0.decimals); const decimals1 = BigInt(poolState.token1.decimals);
              const scale = BIGNUM_SCALE; let price_scaled;
              if (decimals1 >= decimals0) { const factor = 10n ** (decimals1 - decimals0); const scaled_denominator = reserve0 * factor; if (scaled_denominator === 0n) return null; price_scaled = (reserve1 * scale) / scaled_denominator; }
              else { const factor = 10n ** (decimals0 - decimals1); price_scaled = (reserve1 * factor * scale) / reserve0; }
              return price_scaled;
         } catch (e) { logger.error(`[SpatialFinder _calculateSushiPrice] Error during calculation for ${poolState.address}: ${e.message}`); return null; }
     }
} // Make sure this closing brace exists

module.exports = SpatialFinder;
