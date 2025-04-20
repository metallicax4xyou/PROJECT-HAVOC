// core/finders/spatialFinder.js
// --- VERSION 1.9: Restored logic + extra try/catch in grouping ---

const logger = require('../../utils/logger');
const { handleError, ArbitrageError } = require('../../utils/errorHandler');
const { getScaledPriceRatio, formatScaledBigIntForLogging } = require('../scannerUtils');

// Constants
const BIGNUM_SCALE_DECIMALS = 36;
const BIGNUM_SCALE = 10n ** BigInt(BIGNUM_SCALE_DECIMALS);
const PROFIT_THRESHOLD_SCALED = (10001n * BIGNUM_SCALE) / 10000n;
const TEN_THOUSAND = 10000n;

class SpatialFinder {
    constructor() {
        logger.info('[SpatialFinder] Initialized.');
    }

    findOpportunities(livePoolStatesMap) {
        const logPrefix = '[SpatialFinder V1.9]'; // Updated prefix
        logger.info(`${logPrefix} Starting spatial (UniV3 vs SushiSwap) opportunity scan...`);
        const opportunities = [];
        const checkedPairings = new Set();
        const poolsByPair = {};

        // --- Step 1: Group pools by pair and DEX type ---
        const poolAddresses = livePoolStatesMap ? Object.keys(livePoolStatesMap) : [];
        logger.debug(`${logPrefix} Grouping ${poolAddresses.length} fetched pool states...`);

        if (poolAddresses.length === 0) {
             logger.warn(`${logPrefix} No live pool states provided to group.`);
             return opportunities;
        }

        for (const address of poolAddresses) {
            const poolState = livePoolStatesMap[address];
            const groupLogPrefix = `${logPrefix} Grouping pool ${address}:`;

            // --- ADDED Outer Try/Catch for Safety ---
            try {
                // Basic Structure Check (with internal try/catch for property access)
                let token0Sym, token1Sym, dexTypeStr, pairKey;
                try {
                    if (!poolState) throw new Error("poolState is null/undefined");
                    token0Sym = poolState.token0Symbol;
                    token1Sym = poolState.token1Symbol;
                    dexTypeStr = poolState.dexType;
                    if (!token0Sym || !token1Sym || !dexTypeStr) {
                        throw new Error(`Missing basic properties (t0=${!!token0Sym}, t1=${!!token1Sym}, dex=${!!dexTypeStr})`);
                    }
                } catch (propError) {
                    logger.warn(`${groupLogPrefix} Skipping - Error accessing basic properties: ${propError.message}`);
                    continue; // Skip this pool if basic props are missing
                }
                logger.debug(`${groupLogPrefix} Basic structure OK (dexType: ${dexTypeStr}).`);

                // Generate Pair Key
                try {
                     pairKey = [token0Sym, token1Sym].sort().join('/');
                } catch (keyError) {
                      logger.warn(`${groupLogPrefix} Skipping - Error generating pairKey: ${keyError.message}`);
                      continue;
                }
                logger.debug(`${groupLogPrefix} Generated pairKey: '${pairKey}'.`);

                if (!poolsByPair[pairKey]) {
                     logger.debug(`${groupLogPrefix} Initializing group for pairKey '${pairKey}'.`);
                     poolsByPair[pairKey] = { uniswapV3: [], sushiswap: [] };
                }

                // Add to Group if Valid (with internal checks for properties needed later)
                let addedToGroup = false;
                if (dexTypeStr === 'uniswapV3') {
                    const hasSqrtP = !!poolState.sqrtPriceX96 && poolState.sqrtPriceX96 > 0n;
                    const hasFee = typeof poolState.fee === 'number';
                    // Also check for tokens needed in price calc helper
                    const hasTokens = !!poolState.token0 && !!poolState.token1 && typeof poolState.token0.decimals === 'number' && typeof poolState.token1.decimals === 'number';
                    const isValidV3 = hasSqrtP && hasFee && hasTokens;
                    logger.debug(`${groupLogPrefix} Checking V3 validity: hasSqrtP=${hasSqrtP}, hasFee=${hasFee}, hasTokens=${hasTokens} -> isValidV3=${isValidV3}`);
                    if (isValidV3) {
                        poolsByPair[pairKey].uniswapV3.push(poolState);
                        addedToGroup = true;
                        logger.debug(`${groupLogPrefix} Added to uniswapV3 group for key '${pairKey}'.`);
                    }
                } else if (dexTypeStr === 'sushiswap') {
                    const hasR0 = !!poolState.reserve0 && poolState.reserve0 > 0n;
                    const hasR1 = !!poolState.reserve1 && poolState.reserve1 > 0n;
                    const hasFee = typeof poolState.fee === 'number';
                    // Also check for tokens needed in price calc helper
                    const hasTokens = !!poolState.token0 && !!poolState.token1 && typeof poolState.token0.decimals === 'number' && typeof poolState.token1.decimals === 'number';
                    const isValidSushi = hasR0 && hasR1 && hasFee && hasTokens;
                    logger.debug(`${groupLogPrefix} Checking Sushi validity: hasR0=${hasR0}, hasR1=${hasR1}, hasFee=${hasFee}, hasTokens=${hasTokens} -> isValidSushi=${isValidSushi}`);
                    if (isValidSushi) {
                        poolsByPair[pairKey].sushiswap.push(poolState);
                        addedToGroup = true;
                        logger.debug(`${groupLogPrefix} Added to sushiswap group for key '${pairKey}'.`);
                    }
                }

                if (!addedToGroup) {
                    logger.debug(`${groupLogPrefix} Not added to any comparison group (failed validity check).`);
                }

            // --- End Outer Try/Catch ---
            } catch (groupingError) {
                 logger.error(`${groupLogPrefix} !!! UNEXPECTED OUTER ERROR during grouping: ${groupingError.message}`, groupingError);
                 // Continue to next pool if one fails unexpectedly
            }
        } // End grouping loop

        // Log Final Grouping Structure
        logger.debug(`${logPrefix} --- Final Grouping Structure ---`);
        for (const key in poolsByPair) {
            logger.debug(`  PairKey: '${key}' | V3 Count: ${poolsByPair[key].uniswapV3.length} | Sushi Count: ${poolsByPair[key].sushiswap.length}`);
        }
        logger.debug(`${logPrefix} --- End Final Grouping Structure ---`);


        // --- Step 2: Iterate and compare pools ---
        const pairKeysToCompare = Object.keys(poolsByPair);
        logger.debug(`${logPrefix} Starting comparisons across ${pairKeysToCompare.length} unique pairs found in grouping.`);
        if (pairKeysToCompare.length === 0) {
            logger.warn(`${logPrefix} No pairs with pools on both DEX types found after grouping.`);
        }

        for (const pairKey of pairKeysToCompare) {
            const pairPools = poolsByPair[pairKey];
            logger.debug(`${logPrefix} Evaluating pair: ${pairKey} (V3: ${pairPools.uniswapV3.length}, Sushi: ${pairPools.sushiswap.length})`);

            if (pairPools.uniswapV3.length === 0 || pairPools.sushiswap.length === 0) {
                logger.debug(`${logPrefix} Skipping pair ${pairKey}: Missing pools on one DEX type.`);
                continue;
            }
            logger.debug(`${logPrefix} <<<>>> Proceeding with comparison for pair: ${pairKey} <<<>>>`);

            // --- Comparison logic (same as v1.5) ---
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
                        if (priceV3_scaled === null || priceSushi_scaled === null) { continue; }

                        logger.debug(`${compareLogPrefix} Calculating effective prices...`);
                        const v3FeeBps = BigInt(v3Pool.fee); const sushiFeeBps = BigInt(sushiPool.fee);
                        const effectiveSushiBuyPrice_scaled = (priceSushi_scaled * TEN_THOUSAND * BIGNUM_SCALE) / ((TEN_THOUSAND - sushiFeeBps) * BIGNUM_SCALE);
                        const effectiveV3SellPrice_scaled = (priceV3_scaled * (TEN_THOUSAND - v3FeeBps)) / TEN_THOUSAND;
                        const effectiveV3BuyPrice_scaled = (priceV3_scaled * TEN_THOUSAND * BIGNUM_SCALE) / ((TEN_THOUSAND - v3FeeBps) * BIGNUM_SCALE);
                        const effectiveSushiSellPrice_scaled = (priceSushi_scaled * (TEN_THOUSAND - sushiFeeBps)) / TEN_THOUSAND;
                        logger.debug(`${compareLogPrefix} Effective price calculation done.`);

                        logger.debug(`${compareLogPrefix}`);
                        logger.debug(`  Raw Prices   | V3: ${formatScaledBigIntForLogging(priceV3_scaled, BIGNUM_SCALE_DECIMALS)} | Sushi: ${formatScaledBigIntForLogging(priceSushi_scaled, BIGNUM_SCALE_DECIMALS)}`);
                        logger.debug(`  Sushi->V3 Eff| Buy Sushi: ${formatScaledBigIntForLogging(effectiveSushiBuyPrice_scaled, BIGNUM_SCALE_DECIMALS)} | Sell V3: ${formatScaledBigIntForLogging(effectiveV3SellPrice_scaled, BIGNUM_SCALE_DECIMALS)}`);
                        logger.debug(`  V3->Sushi Eff| Buy V3: ${formatScaledBigIntForLogging(effectiveV3BuyPrice_scaled, BIGNUM_SCALE_DECIMALS)} | Sell Sushi: ${formatScaledBigIntForLogging(effectiveSushiSellPrice_scaled, BIGNUM_SCALE_DECIMALS)}`);

                        let foundOpp = false;
                         if (effectiveV3SellPrice_scaled * BIGNUM_SCALE > effectiveSushiBuyPrice_scaled * PROFIT_THRESHOLD_SCALED) {
                             foundOpp = true; /* log and push opp */
                             const estimatedRateNum = (effectiveV3SellPrice_scaled * BIGNUM_SCALE) / effectiveSushiBuyPrice_scaled;
                             logger.info(`${logPrefix} >>> Opportunity [${pairKey}]: Buy on Sushi (${sushiPool.address}), Sell on V3 (${v3Pool.address}) | Est Rate: ${formatScaledBigIntForLogging(estimatedRateNum, BIGNUM_SCALE_DECIMALS)} <<<`);
                             opportunities.push({ /* ... opp details ... */ });
                         }
                         if (effectiveSushiSellPrice_scaled * BIGNUM_SCALE > effectiveV3BuyPrice_scaled * PROFIT_THRESHOLD_SCALED) {
                             foundOpp = true; /* log and push opp */
                             const estimatedRateNum = (effectiveSushiSellPrice_scaled * BIGNUM_SCALE) / effectiveV3BuyPrice_scaled;
                             logger.info(`${logPrefix} >>> Opportunity [${pairKey}]: Buy on V3 (${v3Pool.address}), Sell on Sushi (${sushiPool.address}) | Est Rate: ${formatScaledBigIntForLogging(estimatedRateNum, BIGNUM_SCALE_DECIMALS)} <<<`);
                             opportunities.push({ /* ... opp details ... */ });
                         }
                        if (!foundOpp) { logger.debug(`${compareLogPrefix} No profitable opportunity found meeting threshold.`); }

                    } catch (priceError) { /* handle price error */ }
                } // End Sushi loop
            } // End V3 loop
        } // End pair loop

        logger.info(`${logPrefix} Scan finished. Found ${opportunities.length} potential spatial opportunities.`);
        return opportunities;
    }


    // --- Price Calculation Helpers (remain the same) ---
     _calculateV3Price(poolState) { /* ... */ }
     _calculateSushiPrice(poolState) { /* ... */ }
}

module.exports = SpatialFinder;
