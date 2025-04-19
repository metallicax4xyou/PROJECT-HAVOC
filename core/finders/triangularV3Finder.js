// core/finders/triangularV3Finder.js
const { Token } = require('@uniswap/sdk-core');
const logger = require('../../utils/logger'); // Adjust path if needed
const { handleError } = require('../../utils/errorHandler'); // Adjust path if needed
const { getScaledPriceRatio, formatScaledBigIntForLogging } = require('../scannerUtils'); // Adjust path if needed

// Constants can be defined here or imported from a central constants file if preferred
const BIGNUM_SCALE_DECIMALS = 36;
const BIGNUM_SCALE = 10n ** BigInt(BIGNUM_SCALE_DECIMALS);
const PROFIT_THRESHOLD_SCALED = (10005n * BIGNUM_SCALE) / 10000n; // 1.0005x scaled profit threshold
const LOG_ALL_TRIANGLES = true; // Keep true for debugging V3 triangular paths

class TriangularV3Finder {
    constructor() {
        logger.info('[TriangularV3Finder] Initialized.');
        // No config needed directly for this finder logic itself
    }

    /**
     * Finds potential V3 triangular arbitrage opportunities from a map of live pool states.
     * @param {object} livePoolStatesMap Map of poolAddress.toLowerCase() -> poolState object.
     * @returns {Array<object>} An array of potential triangularV3 opportunity objects.
     */
    findOpportunities(livePoolStatesMap) {
        // Filter for V3 pools only
        const v3PoolStates = {};
        for (const addr in livePoolStatesMap) {
            if (livePoolStatesMap[addr].dexType === 'uniswapV3' && livePoolStatesMap[addr].sqrtPriceX96 !== null) {
                v3PoolStates[addr] = livePoolStatesMap[addr];
            }
        }
        logger.info(`[TriangularV3Finder] Starting V3 triangular scan with ${Object.keys(v3PoolStates).length} live V3 pool states.`);
        const opportunities = [];
        if (!v3PoolStates || Object.keys(v3PoolStates).length < 3) {
             logger.info('[TriangularV3Finder] Not enough live V3 pool states (< 3).');
             return opportunities;
        }
        const tokenGraph = {};
        if (LOG_ALL_TRIANGLES) logger.debug('[TriangularV3Finder] Building token graph...');
        for (const poolAddress in v3PoolStates) {
             const poolState = v3PoolStates[poolAddress];
             if (!poolState || !poolState.token0Symbol || !poolState.token1Symbol || typeof poolState.sqrtPriceX96 === 'undefined') continue;
             const sym0 = poolState.token0Symbol; const sym1 = poolState.token1Symbol;
             if (!tokenGraph[sym0]) tokenGraph[sym0] = {}; if (!tokenGraph[sym0][sym1]) tokenGraph[sym0][sym1] = []; tokenGraph[sym0][sym1].push(poolState);
             if (!tokenGraph[sym1]) tokenGraph[sym1] = {}; if (!tokenGraph[sym1][sym0]) tokenGraph[sym1][sym0] = []; tokenGraph[sym1][sym0].push(poolState);
        }
        if (LOG_ALL_TRIANGLES) logger.debug(`[TriangularV3Finder] Token graph built. Tokens: ${Object.keys(tokenGraph).join(', ')}`);
        logger.debug(`[TriangularV3Finder] Starting triangle detection...`);
        const checkedTriangles = new Set();
        for (const tokenASymbol in tokenGraph) {
            for (const tokenBSymbol in tokenGraph[tokenASymbol]) {
                for (const poolAB of tokenGraph[tokenASymbol][tokenBSymbol]) {
                     if (typeof poolAB?.sqrtPriceX96 === 'undefined' || !tokenGraph[tokenBSymbol]) continue;
                     for (const tokenCSymbol in tokenGraph[tokenBSymbol]) {
                         if (tokenCSymbol === tokenASymbol) continue;
                         for (const poolBC of tokenGraph[tokenBSymbol][tokenCSymbol]) {
                              if (typeof poolBC?.sqrtPriceX96 === 'undefined' || !tokenGraph[tokenCSymbol]?.[tokenASymbol]) continue;
                              for (const poolCA of tokenGraph[tokenCSymbol][tokenASymbol]) {
                                     if (typeof poolCA?.sqrtPriceX96 === 'undefined') continue;
                                     const pools = [poolAB, poolBC, poolCA];
                                     if (!pools.every(p => p && p.address && typeof p.fee === 'number' && p.token0 instanceof Token && p.token1 instanceof Token)) { continue; }
                                     const triangleId = pools.map(p => p.address).sort().join('-');
                                     if (checkedTriangles.has(triangleId)) continue; checkedTriangles.add(triangleId);
                                     const pathSymbols = [tokenASymbol, tokenBSymbol, tokenCSymbol, tokenASymbol];
                                     const pathPools = pools.map(p=>p.address); const pathFees = pools.map(p=>p.fee);
                                     if (LOG_ALL_TRIANGLES) logger.debug(`--- Checking V3 Triangle: ${pathSymbols.join('->')} Fees: ${pathFees.join(',')} ---`);
                                     try {
                                         const priceRatioAB_scaled = getScaledPriceRatio(poolAB.sqrtPriceX96, BIGNUM_SCALE);
                                         const priceRatioBC_scaled = getScaledPriceRatio(poolBC.sqrtPriceX96, BIGNUM_SCALE);
                                         const priceRatioCA_scaled = getScaledPriceRatio(poolCA.sqrtPriceX96, BIGNUM_SCALE);
                                         if (priceRatioAB_scaled === null || priceRatioBC_scaled === null || priceRatioCA_scaled === null) { continue; }
                                         let scaledPrice_AtoB, scaledPrice_BtoC, scaledPrice_CtoA;
                                         // Price A -> B
                                         const decimals_T0_AB = BigInt(poolAB.token0.decimals); const decimals_T1_AB = BigInt(poolAB.token1.decimals); const decimalDiff_AB = decimals_T1_AB - decimals_T0_AB;
                                         const price_T1T0_adj_scaled_AB = decimalDiff_AB >= 0n ? priceRatioAB_scaled * (10n ** decimalDiff_AB) : priceRatioAB_scaled / (10n ** (-decimalDiff_AB));
                                         if (poolAB.token0Symbol === tokenASymbol) { scaledPrice_AtoB = price_T1T0_adj_scaled_AB; }
                                         else { if (price_T1T0_adj_scaled_AB === 0n) throw new Error(`Zero price A->B`); scaledPrice_AtoB = (BIGNUM_SCALE * BIGNUM_SCALE) / price_T1T0_adj_scaled_AB; }
                                         // Price B -> C
                                         const decimals_T0_BC = BigInt(poolBC.token0.decimals); const decimals_T1_BC = BigInt(poolBC.token1.decimals); const decimalDiff_BC = decimals_T1_BC - decimals_T0_BC;
                                         const price_T1T0_adj_scaled_BC = decimalDiff_BC >= 0n ? priceRatioBC_scaled * (10n ** decimalDiff_BC) : priceRatioBC_scaled / (10n ** (-decimalDiff_BC));
                                         if (poolBC.token0Symbol === tokenBSymbol) { scaledPrice_BtoC = price_T1T0_adj_scaled_BC; }
                                         else { if (price_T1T0_adj_scaled_BC === 0n) throw new Error(`Zero price B->C`); scaledPrice_BtoC = (BIGNUM_SCALE * BIGNUM_SCALE) / price_T1T0_adj_scaled_BC; }
                                         // Price C -> A
                                         const decimals_T0_CA = BigInt(poolCA.token0.decimals); const decimals_T1_CA = BigInt(poolCA.token1.decimals); const decimalDiff_CA = decimals_T1_CA - decimals_T0_CA;
                                         const price_T1T0_adj_scaled_CA = decimalDiff_CA >= 0n ? priceRatioCA_scaled * (10n ** decimalDiff_CA) : priceRatioCA_scaled / (10n ** (-decimalDiff_CA));
                                         if (poolCA.token0Symbol === tokenCSymbol) { scaledPrice_CtoA = price_T1T0_adj_scaled_CA; }
                                         else { if (price_T1T0_adj_scaled_CA === 0n) throw new Error(`Zero price C->A`); scaledPrice_CtoA = (BIGNUM_SCALE * BIGNUM_SCALE) / price_T1T0_adj_scaled_CA; }

                                         const rawRate_scaled = (scaledPrice_AtoB * scaledPrice_BtoC * scaledPrice_CtoA) / (BIGNUM_SCALE * BIGNUM_SCALE);
                                         const feeAB_bps = BigInt(poolAB.fee); const feeBC_bps = BigInt(poolBC.fee); const feeCA_bps = BigInt(poolCA.fee); const TEN_THOUSAND = 10000n;
                                         const feeNum_scaled = (TEN_THOUSAND - feeAB_bps) * (TEN_THOUSAND - feeBC_bps) * (TEN_THOUSAND - feeCA_bps) * BIGNUM_SCALE;
                                         const feeDenom = TEN_THOUSAND * TEN_THOUSAND * TEN_THOUSAND;
                                         const feeMultiplier_scaled = feeDenom > 0n ? feeNum_scaled / feeDenom : 0n;
                                         const rateWithFees_scaled = (rawRate_scaled * feeMultiplier_scaled) / BIGNUM_SCALE;

                                         if (LOG_ALL_TRIANGLES) {
                                             logger.debug(`  V3 Tri Raw Rate: ${formatScaledBigIntForLogging(rawRate_scaled, BIGNUM_SCALE_DECIMALS)} | Fee Mult: ${formatScaledBigIntForLogging(feeMultiplier_scaled, BIGNUM_SCALE_DECIMALS)} | Est Rate: ${formatScaledBigIntForLogging(rateWithFees_scaled, BIGNUM_SCALE_DECIMALS)}`);
                                         }
                                         if (rateWithFees_scaled > PROFIT_THRESHOLD_SCALED) {
                                             logger.info(`[TriangularV3Finder] >>> POTENTIAL TRIANGULAR OPPORTUNITY FOUND <<<`);
                                             logger.info(`  Path: ${pathSymbols.join(' -> ')} Pools: ${pathPools.join(' -> ')} Fees: ${pathFees.join(' -> ')}`);
                                             logger.info(`  Est Rate: ${formatScaledBigIntForLogging(rateWithFees_scaled, BIGNUM_SCALE_DECIMALS)} > Threshold: ${formatScaledBigIntForLogging(PROFIT_THRESHOLD_SCALED, BIGNUM_SCALE_DECIMALS)}`);
                                             const opportunity = {
                                                 type: 'triangularV3',
                                                 pathSymbols: pathSymbols,
                                                 pools: [poolAB, poolBC, poolCA],
                                                 estimatedRate: rateWithFees_scaled.toString(),
                                                 rawRate: rawRate_scaled.toString(),
                                                 groupName: poolAB.groupName || 'N/A'
                                             };
                                             opportunities.push(opportunity);
                                         }
                                     } catch (error) {
                                         logger.error(`[TriangularV3Finder] Error calc rates for ${triangleId}: ${error.message}`);
                                         if (typeof handleError === 'function') handleError(error, `Triangle Calc ${triangleId}`);
                                     }
                                 } // end poolCA loop
                             } // end poolBC loop
                         } // end tokenCSymbol loop
                     } // end poolAB loop
                 } // end tokenBSymbol loop
             } // end tokenASymbol loop
        logger.info(`[TriangularV3Finder] Scan finished. Found ${opportunities.length} potential V3 triangular opportunities.`);
        return opportunities;
    }
}

module.exports = TriangularV3Finder;
