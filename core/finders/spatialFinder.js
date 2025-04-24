// core/finders/spatialFinder.js
// --- VERSION v1.32 ---
// TEMPORARILY Restricting to UniV3 <-> UniV3 paths for estimateGas testing

const { ethers } = require('ethers');
const logger = require('../../utils/logger');
const { getCanonicalPairKey } = require('../../utils/pairUtils');
const { getUniV3Price, getV2Price, getDodoPrice, BIGNUMBER_1E18 } = require('../../utils/priceUtils');
const { TOKENS } = require('../../constants/tokens');

// --- Configuration ---
// *** KEEPING THRESHOLD AT 0 FOR THIS TEST ***
const MIN_NET_PRICE_DIFFERENCE_BIPS = 0n; // Allow any V3<->V3 difference through
const MAX_REASONABLE_PRICE_DIFF_BIPS = 5000n;
const BASIS_POINTS_DENOMINATOR = 10000n;

const SIMULATION_INPUT_AMOUNTS = { /* ... */ };

class SpatialFinder {
    constructor(config) { this.config = config; this.pairRegistry = new Map(); logger.info(`[SpatialFinder v1.32] Initialized (V3 ONLY TEST MODE).`); }
    updatePairRegistry(registry) { if (!registry || !(registry instanceof Map)) { return; } this.pairRegistry = registry; logger.debug(`[SF] Pair registry updated. Size: ${this.pairRegistry.size}`); }
    _calculatePrice(poolState) { /* ... unchanged ... */ }

    findArbitrage(poolStates) {
        logger.info(`[SpatialFinder] Finding spatial arbitrage (V3 ONLY TEST) from ${poolStates.length} pool states...`);
        const opportunities = [];
        if (poolStates.length < 2 || this.pairRegistry.size === 0) return opportunities;
        const poolStateMap = new Map(); poolStates.forEach(state => { if (state?.address) poolStateMap.set(state.address.toLowerCase(), state); });

        for (const [canonicalKey, poolAddressesSet] of this.pairRegistry.entries()) {
            if (poolAddressesSet.size < 2) continue;
            const relevantPoolStates = []; poolAddressesSet.forEach(addr => { const state = poolStateMap.get(addr.toLowerCase()); if (state) relevantPoolStates.push(state); }); if (relevantPoolStates.length < 2) continue;
            const poolsWithPrices = relevantPoolStates.map(pool => ({ ...pool, price0_1_scaled: this._calculatePrice(pool) })).filter(p => p.price0_1_scaled !== null && p.price0_1_scaled > 0n); if (poolsWithPrices.length < 2) continue;

            // logger.debug(`[SpatialFinder] Comparing ${poolsWithPrices.length} pools for pair ${canonicalKey}...`);

            for (let i = 0; i < poolsWithPrices.length; i++) {
                for (let j = i + 1; j < poolsWithPrices.length; j++) {
                    const poolA = poolsWithPrices[i]; const poolB = poolsWithPrices[j];

                    // *** TEMPORARY FILTER: ONLY COMPARE UniV3 <-> UniV3 ***
                    if (poolA.dexType !== 'uniswapV3' || poolB.dexType !== 'uniswapV3') {
                        continue; // Skip if either pool is not UniV3
                    }
                    // *** END TEMPORARY FILTER ***

                    const rawPriceA = poolA.price0_1_scaled; const rawPriceB = poolB.price0_1_scaled;
                    // Sanity Check
                    const rawPriceDiff = rawPriceA > rawPriceB ? rawPriceA - rawPriceB : rawPriceB - rawPriceA; const minRawPrice = rawPriceA < rawPriceB ? rawPriceA : rawPriceB; if (minRawPrice === 0n) continue; const rawDiffBips = (rawPriceDiff * BASIS_POINTS_DENOMINATOR) / minRawPrice; if (rawDiffBips > MAX_REASONABLE_PRICE_DIFF_BIPS) { /* logger.warn(...) */ continue; }
                    // Fee Adjustment
                    const feeA_bips = BigInt(poolA.fee ?? 30); const feeB_bips = BigInt(poolB.fee ?? 30); const sellMultiplierA = BASIS_POINTS_DENOMINATOR - feeA_bips; const sellMultiplierB = BASIS_POINTS_DENOMINATOR - feeB_bips; const effectiveSellPriceA = (rawPriceA * sellMultiplierA) / BASIS_POINTS_DENOMINATOR; const effectiveSellPriceB = (rawPriceB * sellMultiplierB) / BASIS_POINTS_DENOMINATOR;
                    const comparisonBvsA = effectiveSellPriceB > rawPriceA; const comparisonAvsB = effectiveSellPriceA > rawPriceB;

                    let poolBuy = null, poolSell = null, netDiffBips = 0n;
                    if (comparisonBvsA) { netDiffBips = ((effectiveSellPriceB - rawPriceA) * BASIS_POINTS_DENOMINATOR) / rawPriceA; if (netDiffBips >= MIN_NET_PRICE_DIFFERENCE_BIPS) { poolBuy = poolA; poolSell = poolB; } }
                    else if (comparisonAvsB) { netDiffBips = ((effectiveSellPriceA - rawPriceB) * BASIS_POINTS_DENOMINATOR) / rawPriceB; if (netDiffBips >= MIN_NET_PRICE_DIFFERENCE_BIPS) { poolBuy = poolB; poolSell = poolA; } }

                    if (poolBuy && poolSell) {
                        const t0Sym = poolA.token0.symbol; const t1Sym = poolA.token1.symbol;
                        logger.info(`[SpatialFinder] NET V3 Opportunity Found! Pair: ${t0Sym}/${t1Sym}`); // Log specific type
                        // ... (rest of logging) ...
                        const opportunity = this._createOpportunity(poolBuy, poolSell, canonicalKey); opportunities.push(opportunity);
                    }
                }
            }
        }
        logger.info(`[SpatialFinder] Finished scan. Found ${opportunities.length} V3 spatial opportunities (using NET threshold: ${MIN_NET_PRICE_DIFFERENCE_BIPS}).`);
        return opportunities;
    }

     _createOpportunity(poolBuy, poolSell, canonicalKey) { /* ... unchanged ... */ }
}

module.exports = SpatialFinder;
