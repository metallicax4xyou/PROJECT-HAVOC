// core/finders/spatialFinder.js
// --- VERSION 1.2: Added logging inside pair comparison loop ---

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
        const logPrefix = '[SpatialFinder]';
        logger.info(`${logPrefix} Starting spatial (UniV3 vs SushiSwap) opportunity scan...`);
        const opportunities = [];
        const checkedPairings = new Set();
        const poolsByPair = {};

        // 1. Group pools by pair and DEX type
        if (!livePoolStatesMap || Object.keys(livePoolStatesMap).length === 0) { /* return */ }
        logger.debug(`${logPrefix} Grouping ${Object.keys(livePoolStatesMap).length} pools...`); // Log grouping start
        for (const address in livePoolStatesMap) {
            try {
                const poolState = livePoolStatesMap[address];
                if (!poolState || !poolState.token0Symbol || !poolState.token1Symbol || !poolState.dexType) { continue; }
                const pairKey = [poolState.token0Symbol, poolState.token1Symbol].sort().join('/');
                if (!poolsByPair[pairKey]) { poolsByPair[pairKey] = { uniswapV3: [], sushiswap: [] }; }

                // Add checks for required fields before adding
                if (poolState.dexType === 'uniswapV3' && poolState.sqrtPriceX96 && typeof poolState.fee === 'number') {
                     poolsByPair[pairKey].uniswapV3.push(poolState);
                } else if (poolState.dexType === 'sushiswap' && poolState.reserve0 && poolState.reserve1 && typeof poolState.fee === 'number') {
                     poolsByPair[pairKey].sushiswap.push(poolState);
                }
            } catch (groupingError) { /* handle */ }
        }
        logger.debug(`${logPrefix} Finished grouping. Pairs with pools: ${Object.keys(poolsByPair).join(', ')}`); // Log grouped pairs

        // 2. Iterate and compare pools within each pair
        const pairKeysToCompare = Object.keys(poolsByPair);
        logger.debug(`${logPrefix} Starting comparisons across ${pairKeysToCompare.length} unique pairs.`);

        for (const pairKey of pairKeysToCompare) { // Use explicit loop over keys
            const pairPools = poolsByPair[pairKey];

            // --- Log before the check ---
            logger.debug(`${logPrefix} Evaluating pair: ${pairKey} (V3: ${pairPools.uniswapV3.length}, Sushi: ${pairPools.sushiswap.length})`);

            if (pairPools.uniswapV3.length === 0 || pairPools.sushiswap.length === 0) {
                logger.debug(`${logPrefix} Skipping pair ${pairKey}: Missing pools on one DEX.`);
                continue; // Skip if pair doesn't exist on BOTH DEXs
            }

            // --- Log AFTER the check (means we should compare) ---
            logger.debug(`${logPrefix} <<<>>> Proceeding with comparison for pair: ${pairKey} <<<>>>`);

            for (const v3Pool of pairPools.uniswapV3) {
                for (const sushiPool of pairPools.sushiswap) {
                    const pairingId = `${v3Pool.address}-${sushiPool.address}`;
                    if (checkedPairings.has(pairingId)) continue;
                    checkedPairings.add(pairingId);

                    const compareLogPrefix = `${logPrefix} Compare [${pairKey}] V3(${v3Pool.fee}bps) vs Sushi:`;
                    logger.debug(`${compareLogPrefix} Comparing V3 Pool ${v3Pool.address} vs Sushi Pool ${sushiPool.address}`); // Log specific pools

                    try {
                        // --- Log BEFORE price calculation ---
                        logger.debug(`${compareLogPrefix} Calculating prices...`);

                        const priceV3_scaled = this._calculateV3Price(v3Pool);
                        const priceSushi_scaled = this._calculateSushiPrice(sushiPool);

                        // --- Log AFTER price calculation ---
                        logger.debug(`${compareLogPrefix} Price calculation done. V3: ${priceV3_scaled !== null}, Sushi: ${priceSushi_scaled !== null}`);


                        if (priceV3_scaled === null || priceSushi_scaled === null) {
                            logger.warn(`${compareLogPrefix} Skipping comparison due to null raw price calculation.`);
                            continue;
                        }

                        // --- Log EFFECTIVE price calculation ---
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
     _calculateV3Price(poolState) { /* ... */ }
     _calculateSushiPrice(poolState) { /* ... */ }
}

module.exports = SpatialFinder;
