// core/finders/spatialFinder.js
// --- VERSION 1.16: Refactored - Extracted _groupPoolsByPair ---

const logger = require('../../utils/logger');
const { handleError, ArbitrageError } = require('../../utils/errorHandler');
const { getScaledPriceRatio, formatScaledBigIntForLogging } = require('../scannerUtils');

// Constants (Keep these at the top)
const BIGNUM_SCALE_DECIMALS = 36;
const BIGNUM_SCALE = 10n ** BigInt(BIGNUM_SCALE_DECIMALS);
const PROFIT_THRESHOLD_SCALED = (10015n * BIGNUM_SCALE) / 10000n; // 1.0015 (0.15%)
const TEN_THOUSAND = 10000n;

class SpatialFinder {
    constructor() {
        logger.info('[SpatialFinder V1.16] Initialized.');
    }

    /**
     * Groups live pool states by token pair key and DEX type.
     * @param {Map<string, object>} livePoolStatesMap - Map of pool address to pool state object.
     * @returns {object} An object where keys are pairKeys and values contain arrays of uniswapV3 and sushiswap pools.
     * @private
     */
    _groupPoolsByPair(livePoolStatesMap) {
        const logPrefix = '[SpatialFinder V1.16 _groupPoolsByPair]';
        const poolsByPair = {};
        const poolAddresses = livePoolStatesMap ? Object.keys(livePoolStatesMap) : [];
        logger.debug(`${logPrefix} Grouping ${poolAddresses.length} fetched pool states...`);

        if (poolAddresses.length === 0) {
            logger.info(`${logPrefix} No live pool states provided.`);
            return poolsByPair; // Return empty object
        }

        for (const address of poolAddresses) {
            const poolState = livePoolStatesMap[address];
            if (!poolState || !poolState.pairKey) {
                logger.warn(`${logPrefix} Skipping pool ${address}: Missing state or pairKey.`);
                continue;
            }

            if (!poolsByPair[poolState.pairKey]) {
                poolsByPair[poolState.pairKey] = { uniswapV3: [], sushiswap: [] };
            }

            if (poolState.dex === 'UniswapV3') {
                poolsByPair[poolState.pairKey].uniswapV3.push(poolState);
            } else if (poolState.dex === 'SushiSwap') {
                poolsByPair[poolState.pairKey].sushiswap.push(poolState);
            }
        }

        // Log the grouping results clearly
        logger.debug(`${logPrefix} --- Final Grouping Structure ---`);
        for (const key in poolsByPair) {
            if (poolsByPair.hasOwnProperty(key)) {
                 logger.debug(`  PairKey: '${key}' | V3 Count: ${poolsByPair[key].uniswapV3.length} | Sushi Count: ${poolsByPair[key].sushiswap.length}`);
            }
        }
        logger.debug(`--- END GROUPING ---`);
        return poolsByPair;
    }

    // --- Price Calculation Helpers ---
    // (Keep _calculateV3Price and _calculateSushiPrice as they are for now)
    _calculateV3Price(poolState) { /* ... existing V3 price logic ... */ }
    _calculateSushiPrice(poolState) { /* ... existing Sushi price logic ... */ }


    // --- Main findOpportunities Method (Modified) ---
    findOpportunities(livePoolStatesMap) {
        const logPrefix = '[SpatialFinder V1.16]';
        logger.info(`${logPrefix} Starting spatial (UniV3 vs SushiSwap) opportunity scan...`);
        const opportunities = [];
        const checkedPairings = new Set(); // Keep track of checked V3-Sushi pairs

        // Step 1: Group pools using the new helper method
        const poolsByPair = this._groupPoolsByPair(livePoolStatesMap);

        // Step 2: Iterate through pairs and compare
        const pairKeysToCompare = Object.keys(poolsByPair);
        logger.debug(`${logPrefix} Starting comparisons across ${pairKeysToCompare.length} unique pairs found in grouping.`);

        if (pairKeysToCompare.length === 0) {
            logger.info(`${logPrefix} No pairs found with pools on both Uniswap V3 and SushiSwap.`);
            // Fall through to return empty opportunities array
        }

        for (const pairKey of pairKeysToCompare) {
            const pairPools = poolsByPair[pairKey];

            // Skip if the pair doesn't exist on both DEXs
            if (pairPools.uniswapV3.length === 0 || pairPools.sushiswap.length === 0) {
                logger.debug(`${logPrefix} Skipping pair ${pairKey}: Not present on both DEXs.`);
                continue;
            }
            logger.debug(`${logPrefix} <<<>>> Proceeding with comparison for pair: ${pairKey} <<<>>>`);

            // Compare every V3 pool with every SushiSwap pool for the same pair
            for (const v3Pool of pairPools.uniswapV3) {
                for (const sushiPool of pairPools.sushiswap) {
                    // Generate a unique ID for this specific V3-Sushi pairing
                    const pairingId = `${v3Pool.address}-${sushiPool.address}`;
                    if (checkedPairings.has(pairingId)) {
                        logger.trace(`${logPrefix} Skipping already checked pairing: ${pairingId}`);
                        continue;
                    }
                    checkedPairings.add(pairingId);

                    const compareLogPrefix = `${logPrefix} Compare [${pairKey}] V3(${v3Pool.fee}bps @ ${v3Pool.address.substring(0,6)}) vs Sushi(@ ${sushiPool.address.substring(0,6)}):`;

                    try {
                        // --- Calculate Raw Prices ---
                        const priceV3_scaled = this._calculateV3Price(v3Pool);
                        const priceSushi_scaled = this._calculateSushiPrice(sushiPool);

                        // Validate raw prices before proceeding
                        logger.debug(`${compareLogPrefix} Raw Price Check | V3_scaled: ${formatScaledBigIntForLogging(priceV3_scaled, BIGNUM_SCALE_DECIMALS)}, Sushi_scaled: ${formatScaledBigIntForLogging(priceSushi_scaled, BIGNUM_SCALE_DECIMALS)}`);
                        if (priceV3_scaled === null || priceSushi_scaled === null || priceV3_scaled <= 0n || priceSushi_scaled <= 0n) {
                             logger.warn(`${compareLogPrefix} Skipping comparison due to null or non-positive raw price.`);
                             continue;
                         }

                        // --- Effective Price Calculation (Still inline - will refactor next) ---
                        // ... (existing effective price calculation logic) ...
                        logger.debug(`${compareLogPrefix} Preparing values for effective price calc...`);
                        let v3FeeBps, sushiFeeBps, divisorSushi, divisorV3;
                        try {
                             v3FeeBps = BigInt(v3Pool.fee); sushiFeeBps = BigInt(sushiPool.fee);
                             divisorSushi = (TEN_THOUSAND - sushiFeeBps); divisorV3 = (TEN_THOUSAND - v3FeeBps);
                             if (divisorSushi <= 0n || divisorV3 <= 0n || TEN_THOUSAND <= 0n || BIGNUM_SCALE <= 0n) { throw new ArbitrageError(`Invalid fee divisor detected`); }
                             logger.debug(`${compareLogPrefix} Fees and Divisors OK | V3 Fee: ${v3FeeBps}, Sushi Fee: ${sushiFeeBps}, DivV3: ${divisorV3}, DivSushi: ${divisorSushi}`);
                        } catch (feeError) { logger.error(`${compareLogPrefix} Error preparing fee values: ${feeError.message}`); handleError(feeError, `SpatialFeePrep ${pairKey}`); continue; }

                        let effectiveSushiBuyPrice_scaled, effectiveV3SellPrice_scaled, effectiveV3BuyPrice_scaled, effectiveSushiSellPrice_scaled;
                        let calcError = null;
                        // (Existing try/catch blocks for each effective price calculation)
                        try { /* effectiveSushiBuyPrice_scaled calc */ } catch (e) { calcError = e; /* log */ }
                        if (!calcError) try { /* effectiveV3SellPrice_scaled calc */ } catch (e) { calcError = e; /* log */ }
                        if (!calcError) try { /* effectiveV3BuyPrice_scaled calc */ } catch (e) { calcError = e; /* log */ }
                        if (!calcError) try { /* effectiveSushiSellPrice_scaled calc */ } catch (e) { calcError = e; /* log */ }
                        if (calcError) { logger.warn(`${compareLogPrefix} Skipping profitability check due to effective price calculation error.`); handleError(calcError, `SpatialEffectivePriceCalc ${pairKey}`); continue; }
                        logger.debug(`${compareLogPrefix} Effective price calculation completed.`);
                         // --- END Effective Price Calculation (Inline Block) ---


                        // --- Log Calculated Prices ---
                        logger.debug(`${compareLogPrefix}`);
                        logger.debug(`  Raw Prices   | V3: ${formatScaledBigIntForLogging(priceV3_scaled, BIGNUM_SCALE_DECIMALS)} | Sushi: ${formatScaledBigIntForLogging(priceSushi_scaled, BIGNUM_SCALE_DECIMALS)}`);
                        logger.debug(`  Sushi->V3 Eff| Buy Sushi Cost: ${formatScaledBigIntForLogging(effectiveSushiBuyPrice_scaled, BIGNUM_SCALE_DECIMALS)} | Sell V3 Receive: ${formatScaledBigIntForLogging(effectiveV3SellPrice_scaled, BIGNUM_SCALE_DECIMALS)}`);
                        logger.debug(`  V3->Sushi Eff| Buy V3 Cost:    ${formatScaledBigIntForLogging(effectiveV3BuyPrice_scaled, BIGNUM_SCALE_DECIMALS)} | Sell Sushi Receive: ${formatScaledBigIntForLogging(effectiveSushiSellPrice_scaled, BIGNUM_SCALE_DECIMALS)}`);


                        // --- Profitability Check (Still inline - will refactor next) ---
                        // ... (existing profitability check logic using PROFIT_THRESHOLD_SCALED) ...
                        let foundOpp = false;
                        if (effectiveV3SellPrice_scaled * BIGNUM_SCALE > effectiveSushiBuyPrice_scaled * PROFIT_THRESHOLD_SCALED) { /* push opp */ foundOpp = true; }
                        if (effectiveSushiSellPrice_scaled * BIGNUM_SCALE > effectiveV3BuyPrice_scaled * PROFIT_THRESHOLD_SCALED) { /* push opp */ foundOpp = true; }
                        if (!foundOpp) { logger.debug(`${compareLogPrefix} No profitable opportunity found meeting threshold.`); }
                        // --- END Profitability Check (Inline Block) ---

                    } catch (outerError) {
                         logger.error(`${compareLogPrefix} Outer error during comparison: ${outerError.message}`);
                         handleError(outerError, `SpatialComparison ${pairKey} ${pairingId}`);
                    }
                } // End Sushi loop
            } // End V3 loop
        } // End pair loop

        logger.info(`${logPrefix} Scan finished. Found ${opportunities.length} potential spatial opportunities passing initial filter.`);
        return opportunities;
    }

} // End Class

module.exports = SpatialFinder;
