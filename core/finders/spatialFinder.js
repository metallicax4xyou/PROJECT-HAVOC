// core/finders/spatialFinder.js
// --- VERSION 1.13: Isolate failing effective price calculation ---

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
        const logPrefix = '[SpatialFinder V1.13]'; // Updated prefix
        logger.info(`${logPrefix} Starting spatial (UniV3 vs SushiSwap) opportunity scan...`);
        const opportunities = [];
        const checkedPairings = new Set();
        const poolsByPair = {};

        // Step 1: Group pools (same as 1.12)
        // ... grouping logic ...
        const poolAddresses = livePoolStatesMap ? Object.keys(livePoolStatesMap) : [];
        logger.debug(`${logPrefix} Grouping ${poolAddresses.length} fetched pool states...`);
        if (poolAddresses.length === 0) { return opportunities; }
        for (const address of poolAddresses) { /* ... grouping logic ... */ }
        logger.debug(`${logPrefix} --- Final Grouping Structure ---`);
        for (const key in poolsByPair) { logger.debug(`  PairKey: '${key}' | V3 Count: ${poolsByPair[key].uniswapV3.length} | Sushi Count: ${poolsByPair[key].sushiswap.length}`); }
        logger.debug(`--- END SPATIAL FINDER GROUPING ---`);


        // Step 2: Iterate and compare pools
        const pairKeysToCompare = Object.keys(poolsByPair);
        logger.debug(`${logPrefix} Starting comparisons across ${pairKeysToCompare.length} unique pairs found in grouping.`);
        if (pairKeysToCompare.length === 0) { /* ... */ }

        for (const pairKey of pairKeysToCompare) {
            const pairPools = poolsByPair[pairKey];
            if (pairPools.uniswapV3.length === 0 || pairPools.sushiswap.length === 0) { continue; }
            logger.debug(`${logPrefix} <<<>>> Proceeding with comparison for pair: ${pairKey} <<<>>>`);

            for (const v3Pool of pairPools.uniswapV3) {
                for (const sushiPool of pairPools.sushiswap) {
                    const pairingId = `${v3Pool.address}-${sushiPool.address}`;
                    if (checkedPairings.has(pairingId)) continue;
                    checkedPairings.add(pairingId);
                    const compareLogPrefix = `${logPrefix} Compare [${pairKey}] V3(${v3Pool.fee}bps) vs Sushi:`;
                    // logger.debug(`${compareLogPrefix} Comparing V3 Pool ${v3Pool.address} vs Sushi Pool ${sushiPool.address}`);

                    try {
                        // logger.debug(`${compareLogPrefix} Calculating prices...`);
                        const priceV3_scaled = this._calculateV3Price(v3Pool);
                        const priceSushi_scaled = this._calculateSushiPrice(sushiPool);
                        // logger.debug(`${compareLogPrefix} Price calculation done. V3: ${priceV3_scaled !== null}, Sushi: ${priceSushi_scaled !== null}`);
                        if (priceV3_scaled === null || priceSushi_scaled === null) { continue; }

                        // Log raw prices BEFORE trying effective price calcs
                        logger.debug(`${compareLogPrefix} Raw Prices | V3_scaled: ${priceV3_scaled?.toString()}, Sushi_scaled: ${priceSushi_scaled?.toString()}`);

                        logger.debug(`${compareLogPrefix} Preparing values for effective price calc...`);
                        let v3FeeBps, sushiFeeBps, divisorSushi, divisorV3;
                        try {
                             v3FeeBps = BigInt(v3Pool.fee); sushiFeeBps = BigInt(sushiPool.fee);
                             divisorSushi = (TEN_THOUSAND - sushiFeeBps); divisorV3 = (TEN_THOUSAND - v3FeeBps);
                             if (divisorSushi <= 0n || divisorV3 <= 0n || BIGNUM_SCALE <= 0n) { throw new Error(`Invalid divisor or scale`); }
                             logger.debug(`${compareLogPrefix} Fees and Divisors OK.`);
                        } catch (feeError) { logger.error(`${compareLogPrefix} Error preparing fee values: ${feeError.message}`); continue; }

                        // --- *** Calculate Effective Prices Individually *** ---
                        let effectiveSushiBuyPrice_scaled, effectiveV3SellPrice_scaled, effectiveV3BuyPrice_scaled, effectiveSushiSellPrice_scaled;
                        let calcError = null;

                        try {
                             logger.debug(`${compareLogPrefix} Calculating effectiveSushiBuyPrice_scaled...`);
                             const num = priceSushi_scaled * TEN_THOUSAND * BIGNUM_SCALE;
                             const den = divisorSushi * BIGNUM_SCALE;
                             if (den === 0n) throw new Error("Denominator zero for effectiveSushiBuyPrice_scaled");
                             effectiveSushiBuyPrice_scaled = num / den;
                             logger.debug(`${compareLogPrefix}   -> OK: ${effectiveSushiBuyPrice_scaled}`);
                        } catch (e) { calcError = e; logger.error(`${compareLogPrefix} ERROR calculating effectiveSushiBuyPrice_scaled: ${e.message}`); }

                        if (!calcError) try {
                             logger.debug(`${compareLogPrefix} Calculating effectiveV3SellPrice_scaled...`);
                             const num = priceV3_scaled * divisorV3;
                             const den = TEN_THOUSAND; // Safe
                             effectiveV3SellPrice_scaled = num / den;
                             logger.debug(`${compareLogPrefix}   -> OK: ${effectiveV3SellPrice_scaled}`);
                        } catch (e) { calcError = e; logger.error(`${compareLogPrefix} ERROR calculating effectiveV3SellPrice_scaled: ${e.message}`); }

                        if (!calcError) try {
                             logger.debug(`${compareLogPrefix} Calculating effectiveV3BuyPrice_scaled...`);
                             const num = priceV3_scaled * TEN_THOUSAND * BIGNUM_SCALE;
                             const den = divisorV3 * BIGNUM_SCALE;
                             if (den === 0n) throw new Error("Denominator zero for effectiveV3BuyPrice_scaled");
                             effectiveV3BuyPrice_scaled = num / den;
                             logger.debug(`${compareLogPrefix}   -> OK: ${effectiveV3BuyPrice_scaled}`);
                        } catch (e) { calcError = e; logger.error(`${compareLogPrefix} ERROR calculating effectiveV3BuyPrice_scaled: ${e.message}`); }

                        if (!calcError) try {
                             logger.debug(`${compareLogPrefix} Calculating effectiveSushiSellPrice_scaled...`);
                             const num = priceSushi_scaled * divisorSushi;
                             const den = TEN_THOUSAND; // Safe
                             effectiveSushiSellPrice_scaled = num / den;
                             logger.debug(`${compareLogPrefix}   -> OK: ${effectiveSushiSellPrice_scaled}`);
                        } catch (e) { calcError = e; logger.error(`${compareLogPrefix} ERROR calculating effectiveSushiSellPrice_scaled: ${e.message}`); }

                        // If any calculation failed, skip the rest for this pair
                        if (calcError) {
                             logger.warn(`${compareLogPrefix} Skipping profitability check due to calculation error.`);
                             continue;
                        }
                        // --- *** End Individual Calculation *** ---

                        logger.debug(`${compareLogPrefix} Effective price calculation completed.`); // Should reach here now

                        // Log prices and check for opportunities...
                        logger.debug(`${compareLogPrefix}`);
                        logger.debug(`  Raw Prices   | V3: ${formatScaledBigIntForLogging(priceV3_scaled, BIGNUM_SCALE_DECIMALS)} | Sushi: ${formatScaledBigIntForLogging(priceSushi_scaled, BIGNUM_SCALE_DECIMALS)}`);
                        logger.debug(`  Sushi->V3 Eff| Buy Sushi: ${formatScaledBigIntForLogging(effectiveSushiBuyPrice_scaled, BIGNUM_SCALE_DECIMALS)} | Sell V3: ${formatScaledBigIntForLogging(effectiveV3SellPrice_scaled, BIGNUM_SCALE_DECIMALS)}`);
                        logger.debug(`  V3->Sushi Eff| Buy V3: ${formatScaledBigIntForLogging(effectiveV3BuyPrice_scaled, BIGNUM_SCALE_DECIMALS)} | Sell Sushi: ${formatScaledBigIntForLogging(effectiveSushiSellPrice_scaled, BIGNUM_SCALE_DECIMALS)}`);

                        // Check opportunities...
                        let foundOpp = false;
                         if (effectiveV3SellPrice_scaled * BIGNUM_SCALE > effectiveSushiBuyPrice_scaled * PROFIT_THRESHOLD_SCALED) { /* ... */ }
                         if (effectiveSushiSellPrice_scaled * BIGNUM_SCALE > effectiveV3BuyPrice_scaled * PROFIT_THRESHOLD_SCALED) { /* ... */ }
                        if (!foundOpp) { logger.debug(`${compareLogPrefix} No profitable opportunity found meeting threshold.`); }

                    } catch (priceError) {
                         logger.error(`${compareLogPrefix} Outer error calculating/comparing prices: ${priceError.message}`);
                         handleError(priceError, `SpatialPriceCalc ${pairKey}`);
                     }
                } // End Sushi loop
            } // End V3 loop
        } // End pair loop

        logger.info(`${logPrefix} Scan finished. Found ${opportunities.length} potential spatial opportunities.`);
        return opportunities;
    }


    // --- Price Calculation Helpers ---
     _calculateV3Price(poolState) { /* ... */ }
     _calculateSushiPrice(poolState) { /* ... */ }
}

module.exports = SpatialFinder;
