// core/finders/spatialFinder.js
// --- VERSION 1.19: Refactored - Uses external priceCalculation utilities ---

const logger = require('../../utils/logger');
const { handleError, ArbitrageError } = require('../../utils/errorHandler');
const { getScaledPriceRatio, formatScaledBigIntForLogging } = require('../scannerUtils'); // Assuming path is correct

// Import calculation functions from the new utility file
const {
    calculateV3Price,
    calculateSushiPrice,
    calculateEffectivePrices
} = require('../calculation/priceCalculation'); // Adjust path if needed

// Constants specific to this finder
const BIGNUM_SCALE_DECIMALS = 36; // Should match the scale used in priceCalculation.js
const BIGNUM_SCALE = 10n ** BigInt(BIGNUM_SCALE_DECIMALS);
const PROFIT_THRESHOLD_SCALED = (10015n * BIGNUM_SCALE) / 10000n; // 1.0015 (0.15%) threshold for post-fee profit

class SpatialFinder {
    constructor() {
        logger.info('[SpatialFinder V1.19] Initialized.');
    }

    /**
     * Groups live pool states by token pair key and DEX type.
     * @private
     */
    _groupPoolsByPair(livePoolStatesMap) {
        const logPrefix = '[SpatialFinder V1.19 _groupPoolsByPair]';
        const poolsByPair = {};
        const poolAddresses = livePoolStatesMap ? Object.keys(livePoolStatesMap) : [];
        logger.debug(`${logPrefix} Grouping ${poolAddresses.length} states...`);

        if (poolAddresses.length === 0) { return poolsByPair; }

        for (const address of poolAddresses) {
            const poolState = livePoolStatesMap[address];
            if (!poolState || !poolState.pairKey) { continue; } // Skip invalid states
            if (!poolsByPair[poolState.pairKey]) {
                poolsByPair[poolState.pairKey] = { uniswapV3: [], sushiswap: [] };
            }
            if (poolState.dex === 'UniswapV3') {
                poolsByPair[poolState.pairKey].uniswapV3.push(poolState);
            } else if (poolState.dex === 'SushiSwap') {
                poolsByPair[poolState.pairKey].sushiswap.push(poolState);
            }
        }

        logger.debug(`${logPrefix} Grouping complete. ${Object.keys(poolsByPair).length} pairs found.`);
        return poolsByPair;
    }

    /**
     * Checks for a profitable spatial arbitrage opportunity between two pools based on effective prices.
     * @private
     * @returns {object|null} An opportunity object if found, otherwise null.
     */
    _checkSpatialOpportunity(effectivePrices, v3Pool, sushiPool, priceV3_scaled, priceSushi_scaled, compareLogPrefix) {
        const { sushiBuy, v3Sell, v3Buy, sushiSell } = effectivePrices;
        let opportunity = null;
        let foundOpp = false; // Flag to check if any direction is profitable

        // Log effective prices before checking threshold
        logger.debug(`${compareLogPrefix}`);
        logger.debug(`  Raw Prices   | V3: ${formatScaledBigIntForLogging(priceV3_scaled)} | Sushi: ${formatScaledBigIntForLogging(priceSushi_scaled)}`);
        logger.debug(`  Sushi->V3 Eff| Buy Sushi Cost: ${formatScaledBigIntForLogging(sushiBuy)} | Sell V3 Receive: ${formatScaledBigIntForLogging(v3Sell)}`);
        logger.debug(`  V3->Sushi Eff| Buy V3 Cost:    ${formatScaledBigIntForLogging(v3Buy)} | Sell Sushi Receive: ${formatScaledBigIntForLogging(sushiSell)}`);


        // Check Opportunity: Buy Sushi -> Sell V3
        if (v3Sell * BIGNUM_SCALE > sushiBuy * PROFIT_THRESHOLD_SCALED) {
            const profitRatio = getScaledPriceRatio(v3Sell, sushiBuy, BIGNUM_SCALE_DECIMALS);
            logger.info(`${compareLogPrefix} Opportunity Found: Buy Sushi -> Sell V3. Ratio: ${profitRatio.toFixed(6)} > Threshold`);
            opportunity = {
                type: 'spatial',
                path: [sushiPool.address, v3Pool.address],
                pools: [sushiPool, v3Pool],
                direction: 'SushiToV3',
                pairKey: v3Pool.pairKey,
                priceV3Raw: priceV3_scaled, priceSushiRaw: priceSushi_scaled, // Keep raw prices for reference
                effectiveBuyPrice: sushiBuy, effectiveSellPrice: v3Sell,
                profitRatio: profitRatio, profitThreshold: PROFIT_THRESHOLD_SCALED
            };
            foundOpp = true;
        }

        // Check Opportunity: Buy V3 -> Sell Sushi
        // Allow checking the second direction even if the first was found
        if (sushiSell * BIGNUM_SCALE > v3Buy * PROFIT_THRESHOLD_SCALED) {
            const profitRatio = getScaledPriceRatio(sushiSell, v3Buy, BIGNUM_SCALE_DECIMALS);
            logger.info(`${compareLogPrefix} Opportunity Found: Buy V3 -> Sell Sushi. Ratio: ${profitRatio.toFixed(6)} > Threshold`);
            // If an opportunity was already found, decide: overwrite, return both, or ignore?
            // Current: Overwrite with V3->Sushi if it's also profitable. Consider returning an array if both needed.
            opportunity = {
                type: 'spatial',
                path: [v3Pool.address, sushiPool.address],
                pools: [v3Pool, sushiPool],
                direction: 'V3ToSushi',
                pairKey: v3Pool.pairKey,
                priceV3Raw: priceV3_scaled, priceSushiRaw: priceSushi_scaled,
                effectiveBuyPrice: v3Buy, effectiveSellPrice: sushiSell,
                profitRatio: profitRatio, profitThreshold: PROFIT_THRESHOLD_SCALED
            };
            foundOpp = true;
        }

        if (!foundOpp) {
             logger.debug(`${compareLogPrefix} No profitable opportunity found meeting threshold (${formatScaledBigIntForLogging(PROFIT_THRESHOLD_SCALED)}).`);
        }

        return opportunity; // Return the latest found opportunity object or null
    }


    /**
     * Main method to find spatial arbitrage opportunities.
     * @param {Map<string, object>} livePoolStatesMap - Map of pool address to pool state object.
     * @returns {Array<object>} A list of potential arbitrage opportunities.
     */
    findOpportunities(livePoolStatesMap) {
        const logPrefix = '[SpatialFinder V1.19]';
        logger.info(`${logPrefix} Starting spatial scan...`);
        const opportunities = [];
        const checkedPairings = new Set(); // Avoid duplicate V3-Sushi checks

        const poolsByPair = this._groupPoolsByPair(livePoolStatesMap);
        const pairKeysToCompare = Object.keys(poolsByPair);
        logger.debug(`${logPrefix} Comparing across ${pairKeysToCompare.length} unique pairs.`);

        if (pairKeysToCompare.length === 0) {
            logger.info(`${logPrefix} No pairs found on both DEXs.`);
            return opportunities; // Early exit
        }

        for (const pairKey of pairKeysToCompare) {
            const pairPools = poolsByPair[pairKey];
            if (pairPools.uniswapV3.length === 0 || pairPools.sushiswap.length === 0) { continue; } // Skip incomplete pairs
            logger.debug(`${logPrefix} <<< Comparing Pair: ${pairKey} >>>`);

            for (const v3Pool of pairPools.uniswapV3) {
                for (const sushiPool of pairPools.sushiswap) {
                    const pairingId = `${v3Pool.address}-${sushiPool.address}`;
                    if (checkedPairings.has(pairingId)) { continue; }
                    checkedPairings.add(pairingId);
                    const compareLogPrefix = `${logPrefix} Cmp [${pairKey}] V3(${v3Pool.fee}bps @ ${v3Pool.address.substring(0,6)}) vs Sushi(@ ${sushiPool.address.substring(0,6)}):`;

                    try {
                        // 1. Calculate Raw Prices (using external utility)
                        const priceV3_scaled = calculateV3Price(v3Pool);
                        const priceSushi_scaled = calculateSushiPrice(sushiPool);

                        if (priceV3_scaled === null || priceSushi_scaled === null) {
                             logger.warn(`${compareLogPrefix} Skipping: Could not calculate valid raw prices.`);
                             continue; // Cannot proceed without raw prices
                         }
                         // Non-positive checks (optional here if handled in calc functions)
                         if (priceV3_scaled <= 0n || priceSushi_scaled <= 0n) {
                            logger.warn(`${compareLogPrefix} Skipping: Non-positive raw price detected.`);
                            continue;
                         }


                        // 2. Calculate Effective Prices (using external utility)
                        const effectivePrices = calculateEffectivePrices(v3Pool, sushiPool, priceV3_scaled, priceSushi_scaled);

                        if (!effectivePrices) {
                            logger.warn(`${compareLogPrefix} Skipping: Could not calculate effective prices.`);
                            continue; // Error logged in utility function
                        }


                        // 3. Check for Opportunity (using internal helper)
                        const opportunity = this._checkSpatialOpportunity(
                            effectivePrices,
                            v3Pool,
                            sushiPool,
                            priceV3_scaled,
                            priceSushi_scaled,
                            compareLogPrefix
                        );

                        if (opportunity) {
                            opportunities.push(opportunity);
                        }

                    } catch (outerError) {
                         // Catch unexpected errors during the comparison loop for this pair
                         logger.error(`${compareLogPrefix} Outer error during comparison: ${outerError.message} ${outerError.stack}`);
                         handleError(outerError, `SpatialComparisonLoop ${pairKey} ${pairingId}`);
                         // Continue to next pair, don't crash the whole finder
                    }
                } // End Sushi loop
            } // End V3 loop
        } // End pair loop

        logger.info(`${logPrefix} Scan finished. Found ${opportunities.length} potential opportunities passing initial filter.`);
        return opportunities;
    } // End findOpportunities

} // End Class

module.exports = SpatialFinder;
