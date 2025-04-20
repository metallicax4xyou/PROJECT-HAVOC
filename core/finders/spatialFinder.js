// core/finders/spatialFinder.js
// --- VERSION 1.14: Log raw scaled prices before effective calc ---

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
        const logPrefix = '[SpatialFinder V1.14]'; // Updated prefix
        logger.info(`${logPrefix} Starting spatial (UniV3 vs SushiSwap) opportunity scan...`);
        const opportunities = [];
        const checkedPairings = new Set();
        const poolsByPair = {};

        // Step 1: Group pools
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

                    try {
                        // Calculate Raw Prices
                        const priceV3_scaled = this._calculateV3Price(v3Pool);
                        const priceSushi_scaled = this._calculateSushiPrice(sushiPool);

                        // --- *** Explicit Check and Log BEFORE Effective Calc *** ---
                        logger.debug(`${compareLogPrefix} Raw Price Check | V3_scaled: ${priceV3_scaled?.toString() ?? 'NULL'}, Sushi_scaled: ${priceSushi_scaled?.toString() ?? 'NULL'}`);
                        if (priceV3_scaled === null || priceSushi_scaled === null || priceV3_scaled <= 0n || priceSushi_scaled <= 0n) {
                             logger.warn(`${compareLogPrefix} Skipping comparison due to null or non-positive raw price.`);
                             continue; // Skip if prices are invalid/null/zero
                         }
                        // --- *** END Explicit Check *** ---


                        logger.debug(`${compareLogPrefix} Preparing values for effective price calc...`);
                        let v3FeeBps, sushiFeeBps, divisorSushi, divisorV3;
                        try {
                             v3FeeBps = BigInt(v3Pool.fee); sushiFeeBps = BigInt(sushiPool.fee);
                             divisorSushi = (TEN_THOUSAND - sushiFeeBps); divisorV3 = (TEN_THOUSAND - v3FeeBps);
                             if (divisorSushi <= 0n || divisorV3 <= 0n || BIGNUM_SCALE <= 0n) { throw new Error(`Invalid divisor or scale`); }
                             logger.debug(`${compareLogPrefix} Fees and Divisors OK | V3 Fee: ${v3FeeBps}, Sushi Fee: ${sushiFeeBps}, DivV3: ${divisorV3}, DivSushi: ${divisorSushi}`);
                        } catch (feeError) { logger.error(`${compareLogPrefix} Error preparing fee values: ${feeError.message}`); continue; }

                        // Calculate Effective Prices Individually with try/catch
                        let effectiveSushiBuyPrice_scaled, effectiveV3SellPrice_scaled, effectiveV3BuyPrice_scaled, effectiveSushiSellPrice_scaled;
                        let calcError = null;

                        try {
                             logger.debug(`${compareLogPrefix} Calculating effectiveSushiBuyPrice_scaled...`);
                             effectiveSushiBuyPrice_scaled = (priceSushi_scaled * TEN_THOUSAND * BIGNUM_SCALE) / (divisorSushi * BIGNUM_SCALE);
                        } catch (e) { calcError = e; logger.error(`${compareLogPrefix} ERROR calculating effectiveSushiBuyPrice_scaled: ${e.message}`); }

                        if (!calcError) try {
                             logger.debug(`${compareLogPrefix} Calculating effectiveV3SellPrice_scaled...`);
                             effectiveV3SellPrice_scaled = (priceV3_scaled * divisorV3) / TEN_THOUSAND;
                        } catch (e) { calcError = e; logger.error(`${compareLogPrefix} ERROR calculating effectiveV3SellPrice_scaled: ${e.message}`); }

                        if (!calcError) try {
                             logger.debug(`${compareLogPrefix} Calculating effectiveV3BuyPrice_scaled...`);
                             effectiveV3BuyPrice_scaled = (priceV3_scaled * TEN_THOUSAND * BIGNUM_SCALE) / (divisorV3 * BIGNUM_SCALE);
                        } catch (e) { calcError = e; logger.error(`${compareLogPrefix} ERROR calculating effectiveV3BuyPrice_scaled: ${e.message}`); }

                        if (!calcError) try {
                             logger.debug(`${compareLogPrefix} Calculating effectiveSushiSellPrice_scaled...`);
                             effectiveSushiSellPrice_scaled = (priceSushi_scaled * divisorSushi) / TEN_THOUSAND;
                        } catch (e) { calcError = e; logger.error(`${compareLogPrefix} ERROR calculating effectiveSushiSellPrice_scaled: ${e.message}`); }

                        if (calcError) {
                             logger.warn(`${compareLogPrefix} Skipping profitability check due to calculation error.`);
                             continue;
                        }

                        logger.debug(`${compareLogPrefix} Effective price calculation completed.`);

                        // Log prices and check for opportunities...
                        logger.debug(`${compareLogPrefix}`);
                        logger.debug(`  Raw Prices   | V3: ${formatScaledBigIntForLogging(priceV3_scaled, BIGNUM_SCALE_DECIMALS)} | Sushi: ${formatScaledBigIntForLogging(priceSushi_scaled, BIGNUM_SCALE_DECIMALS)}`);
                        logger.debug(`  Sushi->V3 Eff| Buy Sushi: ${formatScaledBigIntForLogging(effectiveSushiBuyPrice_scaled, BIGNUM_SCALE_DECIMALS)} | Sell V3: ${formatScaledBigIntForLogging(effectiveV3SellPrice_scaled, BIGNUM_SCALE_DECIMALS)}`);
                        logger.debug(`  V3->Sushi Eff| Buy V3: ${formatScaledBigIntForLogging(effectiveV3BuyPrice_scaled, BIGNUM_SCALE_DECIMALS)} | Sell Sushi: ${formatScaledBigIntForLogging(effectiveSushiSellPrice_scaled, BIGNUM_SCALE_DECIMALS)}`);

                        // Check opportunities...
                        let foundOpp = false;
                        // ... check logic ...
                        if (!foundOpp) { logger.debug(`${compareLogPrefix} No profitable opportunity found meeting threshold.`); }

                    } catch (outerError) {
                         logger.error(`${compareLogPrefix} Outer error calculating/comparing prices: ${outerError.message}`);
                         handleError(outerError, `SpatialPriceCalc ${pairKey}`);
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
