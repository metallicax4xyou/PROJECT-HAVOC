// core/finders/spatialFinder.js
// --- VERSION 1.3: Added detailed logging to grouping logic ---

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
        const poolsByPair = {}; // Reset for each cycle

        // --- Step 1: Group pools by pair and DEX type ---
        const poolAddresses = livePoolStatesMap ? Object.keys(livePoolStatesMap) : [];
        logger.debug(`${logPrefix} Grouping ${poolAddresses.length} fetched pool states...`);

        if (poolAddresses.length === 0) {
             logger.warn(`${logPrefix} No live pool states provided to group.`);
             return opportunities; // Return early if map is empty
        }

        for (const address of poolAddresses) { // Loop over fetched states using keys
            const poolState = livePoolStatesMap[address];
            const groupLogPrefix = `${logPrefix} Grouping pool ${address}:`;

            try {
                // --- Detailed Check 1: Basic Structure ---
                if (!poolState || !poolState.token0Symbol || !poolState.token1Symbol || !poolState.dexType) {
                     logger.warn(`${groupLogPrefix} Skipping - Invalid basic structure (missing symbols or dexType). State: ${JSON.stringify(poolState)}`);
                     continue;
                }
                logger.debug(`${groupLogPrefix} Basic structure OK (dexType: ${poolState.dexType}).`);

                // --- Detailed Check 2: Generate Pair Key ---
                const pairKey = [poolState.token0Symbol, poolState.token1Symbol].sort().join('/');
                logger.debug(`${groupLogPrefix} Generated pairKey: '${pairKey}'.`);
                if (!poolsByPair[pairKey]) {
                     logger.debug(`${groupLogPrefix} Initializing group for pairKey '${pairKey}'.`);
                     poolsByPair[pairKey] = { uniswapV3: [], sushiswap: [] };
                }

                // --- Detailed Check 3: Add to Group if Valid for Price Calc ---
                let addedToGroup = false;
                if (poolState.dexType === 'uniswapV3') {
                    const isValidV3 = !!poolState.sqrtPriceX96 && poolState.sqrtPriceX96 > 0n && typeof poolState.fee === 'number';
                    logger.debug(`${groupLogPrefix} Is valid V3 for price calc? ${isValidV3} (sqrtP=${!!poolState.sqrtPriceX96}, fee=${typeof poolState.fee === 'number'}).`);
                    if (isValidV3) {
                        poolsByPair[pairKey].uniswapV3.push(poolState);
                        addedToGroup = true;
                        logger.debug(`${groupLogPrefix} Added to uniswapV3 group for key '${pairKey}'.`);
                    }
                } else if (poolState.dexType === 'sushiswap') {
                    const isValidSushi = !!poolState.reserve0 && !!poolState.reserve1 && poolState.reserve0 > 0n && poolState.reserve1 > 0n && typeof poolState.fee === 'number';
                    logger.debug(`${groupLogPrefix} Is valid Sushi for price calc? ${isValidSushi} (r0=${!!poolState.reserve0 && poolState.reserve0 > 0n}, r1=${!!poolState.reserve1 && poolState.reserve1 > 0n}, fee=${typeof poolState.fee === 'number'}).`);
                    if (isValidSushi) {
                        poolsByPair[pairKey].sushiswap.push(poolState);
                        addedToGroup = true;
                        logger.debug(`${groupLogPrefix} Added to sushiswap group for key '${pairKey}'.`);
                    }
                }

                if (!addedToGroup) {
                    logger.debug(`${groupLogPrefix} Not added to any comparison group (invalid price/reserve data or fee).`);
                }

            } catch (groupingError) {
                 logger.error(`${groupLogPrefix} Unexpected error during grouping: ${groupingError.message}`, groupingError);
            }
        } // End grouping loop

        // --- Detailed Check 4: Log Final Grouping Structure ---
        logger.debug(`${logPrefix} --- Final Grouping Structure ---`);
        for (const key in poolsByPair) {
            logger.debug(`  PairKey: '${key}' | V3 Count: ${poolsByPair[key].uniswapV3.length} | Sushi Count: ${poolsByPair[key].sushiswap.length}`);
        }
        logger.debug(`${logPrefix} --- End Final Grouping Structure ---`);


        // --- Step 2: Iterate and compare pools within each pair ---
        const pairKeysToCompare = Object.keys(poolsByPair);
        logger.debug(`${logPrefix} Starting comparisons across ${pairKeysToCompare.length} unique pairs found in grouping.`);

        for (const pairKey of pairKeysToCompare) {
            const pairPools = poolsByPair[pairKey];
            logger.debug(`${logPrefix} Evaluating pair: ${pairKey} (V3: ${pairPools.uniswapV3.length}, Sushi: ${pairPools.sushiswap.length})`);

            if (pairPools.uniswapV3.length === 0 || pairPools.sushiswap.length === 0) {
                logger.debug(`${logPrefix} Skipping pair ${pairKey}: Missing pools on one DEX type.`);
                continue;
            }
            logger.debug(`${logPrefix} <<<>>> Proceeding with comparison for pair: ${pairKey} <<<>>>`); // Should see this for WBTC/WETH

            // --- Comparison logic remains the same ---
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

                        if (priceV3_scaled === null || priceSushi_scaled === null) { /* continue */ }

                        logger.debug(`${compareLogPrefix} Calculating effective prices...`);
                        // ... effective price calculations ...
                        logger.debug(`${compareLogPrefix} Effective price calculation done.`);

                        // ... enhanced debug log for prices ...
                         logger.debug(`${compareLogPrefix}`); // Separator
                         logger.debug(`  Raw Prices   | V3: ${formatScaledBigIntForLogging(priceV3_scaled, BIGNUM_SCALE_DECIMALS)} | Sushi: ${formatScaledBigIntForLogging(priceSushi_scaled, BIGNUM_SCALE_DECIMALS)}`);
                         // ... log effective prices ...

                        // ... check opportunities ...
                        let foundOpp = false;
                        if (/* Sushi->V3 condition */ false) { /* log and push opp */ }
                        if (/* V3->Sushi condition */ false) { /* log and push opp */ }
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
