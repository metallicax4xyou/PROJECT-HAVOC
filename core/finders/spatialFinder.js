// core/finders/spatialFinder.js
// --- VERSION 1.4: Added CONSOLE.LOG to grouping loop for maximum visibility ---

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
        // Use console.log for this crucial step first
        console.log(`\n--- SPATIAL FINDER GROUPING (Cycle ${this.cycleCount || 'N/A'}) ---`); // Mark clearly
        console.log(`[SpatialFinder Console] Starting grouping for ${poolAddresses.length} addresses.`);

        if (poolAddresses.length === 0) {
             logger.warn(`${logPrefix} No live pool states provided to group.`);
             return opportunities;
        }

        for (const address of poolAddresses) {
            const poolState = livePoolStatesMap[address];
            // Use console.log for maximum visibility inside the loop
            console.log(`\n[SpatialFinder Console] Processing address: ${address}`);

            try {
                // Basic Structure Check
                if (!poolState || !poolState.token0Symbol || !poolState.token1Symbol || !poolState.dexType) {
                     console.log(`  [SpatialFinder Console] Skipping - Invalid basic structure.`);
                     continue;
                }
                console.log(`  [SpatialFinder Console] Basic structure OK (dexType: ${poolState.dexType}).`);

                // Generate Pair Key
                const pairKey = [poolState.token0Symbol, poolState.token1Symbol].sort().join('/');
                console.log(`  [SpatialFinder Console] Generated pairKey: '${pairKey}'.`);
                if (!poolsByPair[pairKey]) {
                     console.log(`  [SpatialFinder Console] Initializing group for pairKey '${pairKey}'.`);
                     poolsByPair[pairKey] = { uniswapV3: [], sushiswap: [] };
                }

                // Add to Group if Valid
                let addedToGroup = false;
                if (poolState.dexType === 'uniswapV3') {
                    const hasSqrtP = !!poolState.sqrtPriceX96 && poolState.sqrtPriceX96 > 0n;
                    const hasFee = typeof poolState.fee === 'number';
                    const isValidV3 = hasSqrtP && hasFee;
                    console.log(`  [SpatialFinder Console] Checking V3 validity: hasSqrtP=${hasSqrtP}, hasFee=${hasFee} -> isValidV3=${isValidV3}`);
                    if (isValidV3) {
                        poolsByPair[pairKey].uniswapV3.push(poolState);
                        addedToGroup = true;
                        console.log(`  [SpatialFinder Console] Added to uniswapV3 group for key '${pairKey}'.`);
                    }
                } else if (poolState.dexType === 'sushiswap') {
                    const hasR0 = !!poolState.reserve0 && poolState.reserve0 > 0n;
                    const hasR1 = !!poolState.reserve1 && poolState.reserve1 > 0n;
                    const hasFee = typeof poolState.fee === 'number'; // Fee is now added to sushi state
                    const isValidSushi = hasR0 && hasR1 && hasFee;
                     console.log(`  [SpatialFinder Console] Checking Sushi validity: hasR0=${hasR0}, hasR1=${hasR1}, hasFee=${hasFee} -> isValidSushi=${isValidSushi}`);
                    if (isValidSushi) {
                        poolsByPair[pairKey].sushiswap.push(poolState);
                        addedToGroup = true;
                        console.log(`  [SpatialFinder Console] Added to sushiswap group for key '${pairKey}'.`);
                    }
                }

                if (!addedToGroup) {
                    console.log(`  [SpatialFinder Console] Not added to any comparison group.`);
                }

            } catch (groupingError) {
                 console.error(`  [SpatialFinder Console] !!! UNEXPECTED ERROR during grouping for ${address}: ${groupingError.message}`, groupingError);
                 logger.error(`${logPrefix} Grouping pool ${address}: Unexpected error: ${groupingError.message}`); // Also log via logger
            }
        } // End grouping loop

        // --- Log Final Grouping Structure using console.log ---
        console.log(`\n[SpatialFinder Console] --- Final Grouping Structure ---`);
        for (const key in poolsByPair) {
            console.log(`  PairKey: '${key}' | V3 Count: ${poolsByPair[key].uniswapV3.length} | Sushi Count: ${poolsByPair[key].sushiswap.length}`);
        }
        console.log(`[SpatialFinder Console] --- End Final Grouping Structure ---`);
        console.log(`--- END SPATIAL FINDER GROUPING ---\n`); // Mark end clearly


        // --- Step 2: Iterate and compare pools (using logger again) ---
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

                        if (priceV3_scaled === null || priceSushi_scaled === null) { continue; }

                        logger.debug(`${compareLogPrefix} Calculating effective prices...`);
                        // ... effective price calculations ...
                        logger.debug(`${compareLogPrefix} Effective price calculation done.`);

                        // ... enhanced debug log for prices ...
                        logger.debug(`${compareLogPrefix}`);
                        // ... log prices ...

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
