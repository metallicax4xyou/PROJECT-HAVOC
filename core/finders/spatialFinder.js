// core/finders/spatialFinder.js
// --- VERSION 1.11: Logging intermediate values in effective price calc ---

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
        const logPrefix = '[SpatialFinder V1.11]'; // Updated prefix
        logger.info(`${logPrefix} Starting spatial (UniV3 vs SushiSwap) opportunity scan...`);
        const opportunities = [];
        const checkedPairings = new Set();
        const poolsByPair = {};

        // Step 1: Group pools (Using logger.debug from v1.9)
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
            logger.debug(`${logPrefix} Evaluating pair: ${pairKey} (V3: ${pairPools.uniswapV3.length}, Sushi: ${pairPools.sushiswap.length})`);
            if (pairPools.uniswapV3.length === 0 || pairPools.sushiswap.length === 0) { continue; }
            logger.debug(`${logPrefix} <<<>>> Proceeding with comparison for pair: ${pairKey} <<<>>>`);

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
                        // --- *** Log intermediate values *** ---
                        let v3FeeBps, sushiFeeBps, divisorSushi, divisorV3;
                        try {
                             v3FeeBps = BigInt(v3Pool.fee);
                             sushiFeeBps = BigInt(sushiPool.fee);
                             logger.debug(`${compareLogPrefix} Fees | v3FeeBps: ${v3FeeBps}, sushiFeeBps: ${sushiFeeBps}`);

                             divisorSushi = (TEN_THOUSAND - sushiFeeBps);
                             divisorV3 = (TEN_THOUSAND - v3FeeBps);
                             logger.debug(`${compareLogPrefix} Divisors | (10k - sushiFee): ${divisorSushi}, (10k - v3Fee): ${divisorV3}`);

                             // Check for zero divisors explicitly (shouldn't happen with valid fees)
                             if (divisorSushi === 0n || divisorV3 === 0n) {
                                 throw new Error(`Calculated zero divisor! Sushi Div: ${divisorSushi}, V3 Div: ${divisorV3}`);
                             }
                             // Also check BIGNUM_SCALE just in case
                             if (BIGNUM_SCALE === 0n) throw new Error(`BIGNUM_SCALE is zero!`);


                        } catch (feeError) {
                             logger.error(`${compareLogPrefix} Error preparing fee values: ${feeError.message}`);
                             continue; // Skip this pairing if fees are bad
                        }
                        // --- *** End intermediate logging *** ---

                        // --- Perform calculations (now safer) ---
                        const effectiveSushiBuyPrice_scaled = (priceSushi_scaled * TEN_THOUSAND * BIGNUM_SCALE) / (divisorSushi * BIGNUM_SCALE);
                        const effectiveV3SellPrice_scaled = (priceV3_scaled * divisorV3) / TEN_THOUSAND;
                        const effectiveV3BuyPrice_scaled = (priceV3_scaled * TEN_THOUSAND * BIGNUM_SCALE) / (divisorV3 * BIGNUM_SCALE);
                        const effectiveSushiSellPrice_scaled = (priceSushi_scaled * divisorSushi) / TEN_THOUSAND;
                        // --- *** Log completion *** ---
                        logger.debug(`${compareLogPrefix} Effective price calculation done.`);


                        // Log prices and check for opportunities...
                        logger.debug(`${compareLogPrefix}`);
                        logger.debug(`  Raw Prices   | V3: ${formatScaledBigIntForLogging(priceV3_scaled, BIGNUM_SCALE_DECIMALS)} | Sushi: ${formatScaledBigIntForLogging(priceSushi_scaled, BIGNUM_SCALE_DECIMALS)}`);
                        logger.debug(`  Sushi->V3 Eff| Buy Sushi: ${formatScaledBigIntForLogging(effectiveSushiBuyPrice_scaled, BIGNUM_SCALE_DECIMALS)} | Sell V3: ${formatScaledBigIntForLogging(effectiveV3SellPrice_scaled, BIGNUM_SCALE_DECIMALS)}`);
                        logger.debug(`  V3->Sushi Eff| Buy V3: ${formatScaledBigIntForLogging(effectiveV3BuyPrice_scaled, BIGNUM_SCALE_DECIMALS)} | Sell Sushi: ${formatScaledBigIntForLogging(effectiveSushiSellPrice_scaled, BIGNUM_SCALE_DECIMALS)}`);

                        let foundOpp = false;
                        if (effectiveV3SellPrice_scaled * BIGNUM_SCALE > effectiveSushiBuyPrice_scaled * PROFIT_THRESHOLD_SCALED) { /* ... */ }
                        if (effectiveSushiSellPrice_scaled * BIGNUM_SCALE > effectiveV3BuyPrice_scaled * PROFIT_THRESHOLD_SCALED) { /* ... */ }
                        if (!foundOpp) { logger.debug(`${compareLogPrefix} No profitable opportunity found meeting threshold.`); }

                    } catch (priceError) {
                        logger.error(`${compareLogPrefix} Error calculating/comparing prices between ${v3Pool.address} and ${sushiPool.address}: ${priceError.message}`);
                        handleError(priceError, `SpatialPriceCalc ${pairKey}`); // Use imported directly
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
