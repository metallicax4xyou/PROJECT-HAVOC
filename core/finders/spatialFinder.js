// core/finders/spatialFinder.js
// --- VERSION 1.12: CONSOLE.LOG fee type/value before BigInt conversion ---

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
        const logPrefix = '[SpatialFinder V1.12]'; // Updated prefix
        logger.info(`${logPrefix} Starting spatial (UniV3 vs SushiSwap) opportunity scan...`);
        const opportunities = [];
        const checkedPairings = new Set();
        const poolsByPair = {};

        // Step 1: Group pools (Using logger.debug)
        // ... (grouping logic remains the same as v1.9 / 1.11) ...
        const poolAddresses = livePoolStatesMap ? Object.keys(livePoolStatesMap) : [];
        logger.debug(`${logPrefix} Grouping ${poolAddresses.length} fetched pool states...`);
        if (poolAddresses.length === 0) { return opportunities; }
        for (const address of poolAddresses) {
             try {
                 const poolState = livePoolStatesMap[address];
                 let token0Sym, token1Sym, dexTypeStr, pairKey;
                 try { if (!poolState) throw new Error("poolState is null/undefined"); token0Sym = poolState.token0Symbol; token1Sym = poolState.token1Symbol; dexTypeStr = poolState.dexType; if (!token0Sym || !token1Sym || !dexTypeStr) { throw new Error(`Missing basic props`); } } catch (propError) { continue; }
                 try { pairKey = [token0Sym, token1Sym].sort().join('/'); } catch (keyError) { continue; }
                 if (!poolsByPair[pairKey]) { poolsByPair[pairKey] = { uniswapV3: [], sushiswap: [] }; }
                 let addedToGroup = false;
                 if (dexTypeStr === 'uniswapV3') { const isValidV3 = !!poolState.sqrtPriceX96 && poolState.sqrtPriceX96 > 0n && typeof poolState.fee === 'number' && !!poolState.token0 && !!poolState.token1 && typeof poolState.token0.decimals === 'number' && typeof poolState.token1.decimals === 'number'; if (isValidV3) { poolsByPair[pairKey].uniswapV3.push(poolState); addedToGroup = true; } }
                 else if (dexTypeStr === 'sushiswap') { const isValidSushi = !!poolState.reserve0 && poolState.reserve0 > 0n && !!poolState.reserve1 && poolState.reserve1 > 0n && typeof poolState.fee === 'number' && !!poolState.token0 && !!poolState.token1 && typeof poolState.token0.decimals === 'number' && typeof poolState.token1.decimals === 'number'; if (isValidSushi) { poolsByPair[pairKey].sushiswap.push(poolState); addedToGroup = true; } }
             } catch (groupingError) { logger.error(`${logPrefix} Grouping pool ${address}: Unexpected error: ${groupingError.message}`); }
        }
        logger.debug(`${logPrefix} --- Final Grouping Structure ---`);
        for (const key in poolsByPair) { logger.debug(`  PairKey: '${key}' | V3 Count: ${poolsByPair[key].uniswapV3.length} | Sushi Count: ${poolsByPair[key].sushiswap.length}`); }
        logger.debug(`--- END SPATIAL FINDER GROUPING ---`);


        // Step 2: Iterate and compare pools
        const pairKeysToCompare = Object.keys(poolsByPair);
        logger.debug(`${logPrefix} Starting comparisons across ${pairKeysToCompare.length} unique pairs found in grouping.`);
        if (pairKeysToCompare.length === 0) { /* ... */ }

        for (const pairKey of pairKeysToCompare) {
            const pairPools = poolsByPair[pairKey];
            // logger.debug(`${logPrefix} Evaluating pair: ${pairKey} ...`);
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

                        logger.debug(`${compareLogPrefix} Calculating effective prices...`); // Last seen log

                        // --- *** CONSOLE.LOG Fee Values BEFORE BigInt Conversion *** ---
                        console.log(`      [Spatial Console] Checking V3 fee. Type: ${typeof v3Pool.fee}, Value: ${v3Pool.fee}`);
                        console.log(`      [Spatial Console] Checking Sushi fee. Type: ${typeof sushiPool.fee}, Value: ${sushiPool.fee}`);
                        // --- *** END CONSOLE.LOG *** ---

                        let v3FeeBps, sushiFeeBps, divisorSushi, divisorV3;
                        try {
                             // Attempt conversion
                             v3FeeBps = BigInt(v3Pool.fee);
                             sushiFeeBps = BigInt(sushiPool.fee);
                             logger.debug(`${compareLogPrefix} Fees | v3FeeBps: ${v3FeeBps}, sushiFeeBps: ${sushiFeeBps}`); // Should appear if BigInt works

                             divisorSushi = (TEN_THOUSAND - sushiFeeBps);
                             divisorV3 = (TEN_THOUSAND - v3FeeBps);
                             logger.debug(`${compareLogPrefix} Divisors | (10k - sushiFee): ${divisorSushi}, (10k - v3Fee): ${divisorV3}`);

                             if (divisorSushi === 0n || divisorV3 === 0n) { throw new Error(`Calculated zero divisor!`); }
                             if (BIGNUM_SCALE === 0n) throw new Error(`BIGNUM_SCALE is zero!`);

                        } catch (feeError) {
                             logger.error(`${compareLogPrefix} Error preparing/converting fee values: ${feeError.message}`);
                             console.error(`      [Spatial Console] ERROR CONVERTING FEES: ${feeError.message}`); // Also log error to console
                             continue; // Skip this pairing if fees are bad
                        }

                        // --- Perform calculations ---
                        const effectiveSushiBuyPrice_scaled = (priceSushi_scaled * TEN_THOUSAND * BIGNUM_SCALE) / (divisorSushi * BIGNUM_SCALE);
                        const effectiveV3SellPrice_scaled = (priceV3_scaled * divisorV3) / TEN_THOUSAND;
                        const effectiveV3BuyPrice_scaled = (priceV3_scaled * TEN_THOUSAND * BIGNUM_SCALE) / (divisorV3 * BIGNUM_SCALE);
                        const effectiveSushiSellPrice_scaled = (priceSushi_scaled * divisorSushi) / TEN_THOUSAND;
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

                    } catch (priceError) { /* handle */ }
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
