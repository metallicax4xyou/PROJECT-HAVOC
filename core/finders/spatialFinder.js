// core/finders/spatialFinder.js
// --- VERSION 1.5: Using logger.debug for detailed grouping logs ---

const logger = require('../../utils/logger'); // Use the logger consistently
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
        // Use logger.debug for this crucial step
        logger.debug(`\n--- SPATIAL FINDER GROUPING (Cycle ${this.cycleCount || 'N/A'}) ---`); // Mark clearly
        logger.debug(`[SpatialFinder Grouping] Starting grouping for ${poolAddresses.length} addresses.`);

        if (poolAddresses.length === 0) {
             logger.warn(`${logPrefix} No live pool states provided to group.`);
             return opportunities;
        }

        for (const address of poolAddresses) {
            const poolState = livePoolStatesMap[address];
            const groupLogPrefix = `${logPrefix} Grouping pool ${address}:`; // Use logger prefix

            try {
                // Basic Structure Check
                if (!poolState || !poolState.token0Symbol || !poolState.token1Symbol || !poolState.dexType) {
                     logger.debug(`${groupLogPrefix} Skipping - Invalid basic structure.`); // Use logger
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
                    const hasFee = typeof poolState.fee === 'number'; // Fee is now added to sushi state
                    const isValidSushi = hasR0 && hasR1 && hasFee;
                    logger.debug(`${groupLogPrefix} Checking Sushi validity: hasR0=${hasR0}, hasR1=${hasR1}, hasFee=${hasFee} -> isValidSushi=${isValidSushi}`);
                    if (isValidSushi) {
                        poolsByPair[pairKey].sushiswap.push(poolState);
                        addedToGroup = true;
                        logger.debug(`${groupLogPrefix} Added to sushiswap group for key '${pairKey}'.`);
                    }
                }

                if (!addedToGroup) {
                    logger.debug(`${groupLogPrefix} Not added to any comparison group.`); // Use logger
                }

            } catch (groupingError) {
                 // Log via logger primarily, console as backup if logger fails
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
        logger.debug(`--- END SPATIAL FINDER GROUPING ---`); // Mark end clearly


        // --- Step 2: Iterate and compare pools (using logger) ---
        const pairKeysToCompare = Object.keys(poolsByPair);
        logger.debug(`${logPrefix} Starting comparisons across ${pairKeysToCompare.length} unique pairs found in grouping.`);
        if (pairKeysToCompare.length === 0) {
            logger.warn(`${logPrefix} No pairs found after grouping. Check grouping logic or pool data validity.`);
        }

        for (const pairKey of pairKeysToCompare) {
            const pairPools = poolsByPair[pairKey];
            logger.debug(`${logPrefix} Evaluating pair: ${pairKey} (V3: ${pairPools.uniswapV3.length}, Sushi: ${pairPools.sushiswap.length})`);

            if (pairPools.uniswapV3.length === 0 || pairPools.sushiswap.length === 0) {
                logger.debug(`${logPrefix} Skipping pair ${pairKey}: Missing pools on one
