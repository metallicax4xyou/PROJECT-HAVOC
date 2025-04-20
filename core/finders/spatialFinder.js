// core/finders/spatialFinder.js
// --- VERSION 1.6: Added top-level console.log and input map logging ---

// --- Requires first ---
const logger = require('../../utils/logger'); // Use the logger consistently
const { handleError, ArbitrageError } = require('../../utils/errorHandler');
const { getScaledPriceRatio, formatScaledBigIntForLogging } = require('../scannerUtils');

// Constants
const BIGNUM_SCALE_DECIMALS = 36;
const BIGNUM_SCALE = 10n ** BigInt(BIGNUM_SCALE_DECIMALS);
const PROFIT_THRESHOLD_SCALED = (10001n * BIGNUM_SCALE) / 10000n; // Require > 0.01% profit *after* estimated fees
const TEN_THOUSAND = 10000n;

class SpatialFinder {
    constructor() {
        logger.info('[SpatialFinder] Initialized.');
    }

    findOpportunities(livePoolStatesMap) {
        // --- *** ADDED TOP-LEVEL CONSOLE LOG AND INPUT LOG *** ---
        console.log("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        console.log("!!! DEBUG: ENTERED SpatialFinder.findOpportunities V1.6 !!!");
        console.log("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        const receivedKeys = livePoolStatesMap ? Object.keys(livePoolStatesMap) : [];
        console.log(`[SpatialFinder Console] Received livePoolStatesMap with ${receivedKeys.length} keys:`, receivedKeys.join(', '));
        // --- *** END ADDED LOGS *** ---


        const logPrefix = '[SpatialFinder]';
        logger.info(`${logPrefix} Starting spatial (UniV3 vs SushiSwap) opportunity scan...`);
        const opportunities = [];
        const checkedPairings = new Set();
        const poolsByPair = {}; // Reset for each cycle

        // --- Step 1: Group pools by pair and DEX type ---
        const poolAddresses = receivedKeys; // Use keys derived above
        // Use logger.debug for subsequent steps
        logger.debug(`--- SPATIAL FINDER GROUPING (Cycle ${this.cycleCount || 'N/A'}) ---`);
        logger.debug(`[SpatialFinder Grouping] Starting grouping for ${poolAddresses.length} addresses.`);

        if (poolAddresses.length === 0) {
             logger.warn(`${logPrefix} No live pool states provided to group.`);
             return opportunities;
        }

        for (const address of poolAddresses) {
            const poolState = livePoolStatesMap[address];
            const groupLogPrefix = `${logPrefix} Grouping pool ${address}:`;

            try {
                // Basic Structure Check
                if (!poolState || !poolState.token0Symbol || !poolState.token1Symbol || !poolState.dexType) {
                     logger.debug(`${groupLogPrefix} Skipping - Invalid basic structure.`);
                     continue;
                }
                logger.debug(`${groupLogPrefix} Basic structure OK (dexType: ${poolState.dexType}).`);

                // Generate Pair Key
                const pairKey = [poolState.token0Symbol, poolState.token1Symbol].sort().join('/');
                logger.debug(`${groupLogPrefix} Generated pairKey: '${pairKey}'.`);
                if (!poolsByPair[pairKey]) {
                     logger.debug(`${groupLogPrefix} Initializing group for pairKey '${pairKey}'.`);
                     poolsByPair[pairKey] = { uniswapV3: [], sushiswap: [] };
                }

                // Add to Group if Valid
                let addedToGroup = false;
                if (poolState.dexType === 'uniswapV3') {
                    const hasSqrtP = !!poolState.sqrtPriceX96 && poolState.sqrtPriceX96 > 0n;
                    const hasFee = typeof poolState.fee === 'number';
                    const isValidV3 = hasSqrtP && hasFee;
                    logger.debug(`${groupLogPrefix} Checking V3 validity: hasSqrtP=${hasSqrtP}, hasFee=${hasFee} -> isValidV3=${isValidV3}`);
                    if (isValidV3) {
                        poolsByPair[pairKey].uniswapV3.push(poolState);
                        addedToGroup = true;
                        logger.debug(`${groupLogPrefix} Added to uniswapV3 group for key '${pairKey}'.`);
                    }
                } else if (poolState.dexType === 'sushiswap') {
                    const hasR0 = !!poolState.reserve0 && poolState.reserve0 > 0n;
                    const hasR1 = !!poolState.reserve1 && poolState.reserve1 > 0n;
                    const hasFee = typeof poolState.fee === 'number';
                    const isValidSushi = hasR0 && hasR1 && hasFee;
                    logger.debug(`${groupLogPrefix} Checking Sushi validity: hasR0=${hasR0}, hasR1=${hasR1}, hasFee=${hasFee} -> isValidSushi=${isValidSushi}`);
                    if (isValidSushi) {
                        poolsByPair[pairKey].sushiswap.push(poolState);
                        addedToGroup = true;
                        logger.debug(`${groupLogPrefix} Added to sushiswap group for key '${pairKey}'.`);
                    }
                }

                if (!addedToGroup) {
                    logger.debug(`${groupLogPrefix} Not added to any comparison group.`);
                }

            } catch (groupingError) {
                 logger.error(`${groupLogPrefix} !!! UNEXPECTED ERROR during grouping: ${groupingError.message}`, groupingError);
                 console.error(`  [SpatialFinder Console Backup] !!! UNEXPECTED ERROR during grouping for ${address}: ${groupingError.message}`, groupingError);
            }
        } // End grouping loop

        // --- Log Final Grouping Structure using logger.debug ---
        logger.debug(`${logPrefix} --- Final Grouping Structure ---`);
        for (const key in poolsByPair) {
            logger.debug(`  PairKey: '${key}' | V3 Count: ${poolsByPair[key].uniswapV3.length} | Sushi Count: ${poolsByPair[key].sushiswap.length}`);
        }
        logger.debug(`${logPrefix} --- End Final Grouping Structure ---`);
        logger.debug(`--- END SPATIAL FINDER GROUPING ---`);


        // --- Step 2: Iterate and compare pools (using logger) ---
        const pairKeysToCompare = Object.keys(poolsByPair);
        logger.debug(`${logPrefix} Starting comparisons across ${pairKeysToCompare.length} unique pairs found in grouping.`);
        if (pairKeysToCompare.length === 0) {
            logger.warn(`${logPrefix} No pairs found after grouping. Check grouping logic or pool data validity.`);
        }

        for (const pairKey of pairKeysToCompare) {
            // ... comparison logic using logger ...
            const pairPools = poolsByPair[pairKey];
            logger.debug(`${logPrefix} Evaluating pair: ${pairKey} (V3: ${pairPools.uniswapV3.length}, Sushi: ${pairPools.sushiswap.length})`);
            if (pairPools.uniswapV3.length === 0 || pairPools.sushiswap.length === 0) { continue; }
            logger.debug(`${logPrefix} <<<>>> Proceeding with comparison for pair: ${pairKey} <<<>>>`);
            for (const v3Pool of pairPools.uniswapV3) {
                for (const sushiPool of pairPools.sushiswap) {
                    // ... rest of comparison ...
                }
            }
        } // End pair loop

        logger.info(`${logPrefix} Scan finished. Found ${opportunities.length} potential spatial opportunities.`);
        return opportunities;
    }


    // --- Price Calculation Helpers (remain the same) ---
     _calculateV3Price(poolState) { /* ... */ }
     _calculateSushiPrice(poolState) { /* ... */ }
}

module.exports = SpatialFinder;
