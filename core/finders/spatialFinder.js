// core/finders/spatialFinder.js
// --- VERSION 1.20: Uses external pairRegistry, removed internal grouping ---

const logger = require('../../utils/logger');
const { handleError, ArbitrageError } = require('../../utils/errorHandler');
const { getScaledPriceRatio, formatScaledBigIntForLogging } = require('../scannerUtils');
const { calculateV3Price, calculateSushiPrice, calculateEffectivePrices } = require('../calculation/priceCalculation');

// Constants specific to this finder
const BIGNUM_SCALE_DECIMALS = 36;
const BIGNUM_SCALE = 10n ** BigInt(BIGNUM_SCALE_DECIMALS);
const PROFIT_THRESHOLD_SCALED = (10015n * BIGNUM_SCALE) / 10000n; // 1.0015 (0.15%) threshold

class SpatialFinder {
    constructor() {
        // Updated version number
        logger.info('[SpatialFinder V1.20] Initialized (Uses external Pair Registry).');
    }

    // --- *** REMOVED _groupPoolsByPair method *** ---

    /**
     * Checks for a profitable spatial arbitrage opportunity between two pools based on effective prices.
     * @private
     * @returns {object|null} An opportunity object if found, otherwise null.
     */
    _checkSpatialOpportunity(effectivePrices, poolA, poolB, priceA_scaled, priceB_scaled, compareLogPrefix) {
        // Determine which pool is V3 and which is Sushi/Camelot (or generalize)
        let v3Pool = null;
        let otherPool = null; // Could be Sushi, Camelot, etc.

        if (poolA.dexType === 'uniswapV3') {
            v3Pool = poolA;
            otherPool = poolB;
        } else if (poolB.dexType === 'uniswapV3') {
            v3Pool = poolB;
            otherPool = poolA;
        } else {
            // This function currently assumes one pool is V3 and the other is V2-style
            // If comparing V2 vs V2, need different logic or dedicated function
             logger.warn(`${compareLogPrefix} Skipping comparison: Requires one V3 and one V2-style pool. Found ${poolA.dexType} vs ${poolB.dexType}.`);
             return null;
        }
        // Ensure we handle the case where both are somehow V3 (shouldn't happen with current logic)
        if (!otherPool || otherPool.dexType === 'uniswapV3') {
             logger.warn(`${compareLogPrefix} Skipping comparison: Logic error, both pools seem to be V3?`);
             return null;
        }

        // Effective prices are calculated based on V3 vs Other DEX perspective
        // Need to make sure the priceCalculation utility returns consistent keys
        // Assuming: sushiBuy/v3Sell compares OtherDEX->V3, v3Buy/sushiSell compares V3->OtherDEX
        const { buyOther, sellV3, buyV3, sellOther } = effectivePrices; // Use generic names from calculation output

        let opportunity = null;
        let foundOpp = false;

        // Log effective prices before checking threshold
        logger.debug(`${compareLogPrefix}`);
        logger.debug(`  Raw Prices   | V3: ${formatScaledBigIntForLogging(priceA_scaled)} | ${otherPool.dexType}: ${formatScaledBigIntForLogging(priceB_scaled)}`);
        logger.debug(`  Other->V3 Eff| Buy Other Cost: ${formatScaledBigIntForLogging(buyOther)} | Sell V3 Receive: ${formatScaledBigIntForLogging(sellV3)}`);
        logger.debug(`  V3->Other Eff| Buy V3 Cost:    ${formatScaledBigIntForLogging(buyV3)} | Sell Other Receive: ${formatScaledBigIntForLogging(sellOther)}`);

        // Check Opportunity: Buy Other DEX -> Sell V3
        // (Receive more from selling on V3 than it cost to buy on Other DEX)
        if (sellV3 * BIGNUM_SCALE > buyOther * PROFIT_THRESHOLD_SCALED) {
            const profitRatio = getScaledPriceRatio(sellV3, buyOther, BIGNUM_SCALE_DECIMALS);
            logger.info(`${compareLogPrefix} Opportunity Found: Buy ${otherPool.dexType} -> Sell V3. Ratio: ${profitRatio.toFixed(6)} > Threshold`);
            opportunity = {
                type: 'spatial',
                path: [otherPool.address, v3Pool.address], // Path: Buy here, Sell there
                pools: [otherPool, v3Pool], // Order matches path
                direction: `${otherPool.dexType}ToV3`,
                pairKey: v3Pool.pairKey, // Use pairKey from either pool (should be same)
                priceV3Raw: priceA_scaled, priceOtherRaw: priceB_scaled, // Keep raw prices
                effectiveBuyPrice: buyOther, effectiveSellPrice: sellV3,
                profitRatio: profitRatio, profitThreshold: PROFIT_THRESHOLD_SCALED
            };
            foundOpp = true;
        }

        // Check Opportunity: Buy V3 -> Sell Other DEX
        // (Receive more from selling on Other DEX than it cost to buy on V3)
        if (sellOther * BIGNUM_SCALE > buyV3 * PROFIT_THRESHOLD_SCALED) {
            const profitRatio = getScaledPriceRatio(sellOther, buyV3, BIGNUM_SCALE_DECIMALS);
            logger.info(`${compareLogPrefix} Opportunity Found: Buy V3 -> Sell ${otherPool.dexType}. Ratio: ${profitRatio.toFixed(6)} > Threshold`);
            // Overwrite previous opportunity if this one is also found (or choose best, or return array)
            opportunity = {
                type: 'spatial',
                path: [v3Pool.address, otherPool.address], // Path: Buy here, Sell there
                pools: [v3Pool, otherPool], // Order matches path
                direction: `V3To${otherPool.dexType}`,
                pairKey: v3Pool.pairKey,
                priceV3Raw: priceA_scaled, priceOtherRaw: priceB_scaled,
                effectiveBuyPrice: buyV3, effectiveSellPrice: sellOther,
                profitRatio: profitRatio, profitThreshold: PROFIT_THRESHOLD_SCALED
            };
            foundOpp = true;
        }

        if (!foundOpp) {
             logger.debug(`${compareLogPrefix} No profitable opportunity found meeting threshold (${formatScaledBigIntForLogging(PROFIT_THRESHOLD_SCALED)}).`);
        }

        return opportunity;
    }


    /**
     * Main method to find spatial arbitrage opportunities using a pre-built pair registry.
     * @param {object} pairRegistry - Map of canonicalPairKey to array of pool state objects.
     * @returns {Array<object>} A list of potential arbitrage opportunities.
     */
    findOpportunities(pairRegistry) {
        const logPrefix = '[SpatialFinder V1.20]'; // Updated version
        logger.info(`${logPrefix} Starting spatial scan using Pair Registry...`);
        const opportunities = [];
        const checkedPairings = new Set(); // Avoid duplicate checks if multiple V3/Other pools exist for same pair

        if (!pairRegistry || typeof pairRegistry !== 'object') {
            logger.warn(`${logPrefix} Invalid or empty pairRegistry received.`);
            return opportunities;
        }

        const pairKeysToCompare = Object.keys(pairRegistry);
        const numPairs = pairKeysToCompare.length;
        logger.debug(`${logPrefix} Received registry with ${numPairs} unique canonical pairs.`);

        if (numPairs === 0) {
            logger.info(`${logPrefix} Pair registry is empty. No comparisons possible.`);
            return opportunities; // Early exit
        }

        for (const pairKey of pairKeysToCompare) {
            const poolsInPair = pairRegistry[pairKey];

            // Need at least one V3 and one non-V3 pool to compare spatially with current logic
            const v3Pools = poolsInPair.filter(p => p.dexType === 'uniswapV3');
            const otherPools = poolsInPair.filter(p => p.dexType !== 'uniswapV3'); // Sushi, Camelot, etc.

            if (v3Pools.length === 0 || otherPools.length === 0) {
                // logger.debug(`${logPrefix} Skipping pair ${pairKey}: Does not have both V3 and Other DEX pools.`);
                continue; // Skip pairs that don't span V3 and another DEX type
            }

            logger.debug(`${logPrefix} <<< Comparing Pair: ${pairKey} (${v3Pools.length} V3, ${otherPools.length} Other) >>>`);

            // Iterate through all combinations of V3 vs Other pools for this pair
            for (const v3Pool of v3Pools) {
                for (const otherPool of otherPools) {
                    // Create unique ID for this specific V3-Other pairing to avoid redundant checks
                    // Order doesn't matter here as we check both directions in _checkSpatialOpportunity
                    const pairingId = [v3Pool.address.toLowerCase(), otherPool.address.toLowerCase()].sort().join('-');
                    if (checkedPairings.has(pairingId)) { continue; } // Skip if already checked
                    checkedPairings.add(pairingId);

                    const compareLogPrefix = `${logPrefix} Cmp [${pairKey}] V3(${v3Pool.fee}bps @ ${v3Pool.address.substring(0,6)}) vs ${otherPool.dexType}(@ ${otherPool.address.substring(0,6)}):`;

                    try {
                        // 1. Calculate Raw Prices (using external utility)
                        // Ensure price calculation handles different dexTypes correctly
                        const priceV3_scaled = calculateV3Price(v3Pool); // Assuming V3 always uses this
                         let priceOther_scaled = null;
                         // Use the correct price function based on the other pool's dexType
                         if(otherPool.dexType === 'sushiswap' || otherPool.dexType === 'camelot') { // Add other V2 types here
                            priceOther_scaled = calculateSushiPrice(otherPool); // Assuming V2 types use similar logic
                         } else {
                              logger.warn(`${compareLogPrefix} Skipping: Unsupported dexType '${otherPool.dexType}' for raw price calculation.`);
                              continue;
                          }


                        if (priceV3_scaled === null || priceOther_scaled === null) {
                             logger.warn(`${compareLogPrefix} Skipping: Could not calculate valid raw prices.`);
                             continue;
                         }
                         if (priceV3_scaled <= 0n || priceOther_scaled <= 0n) {
                            logger.warn(`${compareLogPrefix} Skipping: Non-positive raw price detected.`);
                            continue;
                         }

                        // 2. Calculate Effective Prices (using external utility)
                        // Ensure this utility handles V3 vs the specific otherPool.dexType
                        const effectivePrices = calculateEffectivePrices(v3Pool, otherPool, priceV3_scaled, priceOther_scaled);

                        if (!effectivePrices) {
                            logger.warn(`${compareLogPrefix} Skipping: Could not calculate effective prices.`);
                            continue;
                        }

                        // 3. Check for Opportunity (using internal helper)
                        // Pass pools in a consistent order if helper expects it, or handle internally
                        const opportunity = this._checkSpatialOpportunity(
                            effectivePrices,
                            v3Pool, // Pass V3 pool as first arg maybe?
                            otherPool, // Pass other pool as second arg maybe?
                            priceV3_scaled,
                            priceOther_scaled,
                            compareLogPrefix
                        );

                        if (opportunity) {
                            opportunities.push(opportunity);
                        }

                    } catch (outerError) {
                         logger.error(`${compareLogPrefix} Outer error during comparison: ${outerError.message} ${outerError.stack}`);
                         handleError(outerError, `SpatialComparisonLoop ${pairKey} ${pairingId}`);
                    }
                } // End Other DEX loop
            } // End V3 loop
        } // End pair loop

        logger.info(`${logPrefix} Scan finished. Found ${opportunities.length} potential opportunities passing initial filter.`);
        return opportunities;
    } // End findOpportunities

} // End Class

module.exports = SpatialFinder;
