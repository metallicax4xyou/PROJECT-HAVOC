// core/finders/triangularV3Finder.js
// --- VERSION 1.1: Added detailed logging ---

const { Token } = require('@uniswap/sdk-core');
const logger = require('../../utils/logger'); // Adjust path if needed
const { handleError, ArbitrageError } = require('../../utils/errorHandler'); // Adjust path if needed
const { getScaledPriceRatio, formatScaledBigIntForLogging } = require('../scannerUtils'); // Adjust path if needed

// Constants
const BIGNUM_SCALE_DECIMALS = 36;
const BIGNUM_SCALE = 10n ** BigInt(BIGNUM_SCALE_DECIMALS);
const PROFIT_THRESHOLD_SCALED = (10001n * BIGNUM_SCALE) / 10000n; // Use 1.0001 (0.01%) threshold as fees included later
const LOG_ALL_TRIANGLES = true; // Keep true for debugging

class TriangularV3Finder {
    constructor() {
        logger.info('[TriangularV3Finder] Initialized.');
    }

    findOpportunities(livePoolStatesMap) {
        // --- *** ADDED ENTRY LOG *** ---
        const logPrefix = '[TriangularV3Finder]';
        logger.debug(`${logPrefix} >>> Entered findOpportunities V1.1 <<<`);

        // --- Filter for V3 pools only ---
        const v3PoolStates = {};
        if (!livePoolStatesMap) {
             logger.warn(`${logPrefix} Received null or undefined livePoolStatesMap.`);
             return [];
        }
        logger.debug(`${logPrefix} Filtering for V3 pools from ${Object.keys(livePoolStatesMap).length} total states...`);
        for (const addr in livePoolStatesMap) {
            const poolState = livePoolStatesMap[addr];
            // Add more checks for required V3 data
            if (poolState && poolState.dexType === 'uniswapV3' && poolState.sqrtPriceX96 && poolState.sqrtPriceX96 > 0n && typeof poolState.fee === 'number' && poolState.token0 instanceof Token && poolState.token1 instanceof Token) {
                v3PoolStates[addr] = poolState;
            }
        }
        const v3PoolCount = Object.keys(v3PoolStates).length;
        logger.info(`${logPrefix} Starting V3 triangular scan with ${v3PoolCount} valid live V3 pool states.`);
        const opportunities = [];
        if (v3PoolCount < 3) {
             logger.info(`${logPrefix} Not enough valid V3 pool states (< 3) for triangles. Exiting.`);
             return opportunities;
        }

        // --- Build Token Graph ---
        const tokenGraph = {};
        logger.debug(`${logPrefix} Building token graph...`);
        for (const poolAddress in v3PoolStates) {
             const poolState = v3PoolStates[poolAddress];
             // Basic check should be sufficient here as filtered above
             if (!poolState || !poolState.token0Symbol || !poolState.token1Symbol) continue;
             const sym0 = poolState.token0Symbol; const sym1 = poolState.token1Symbol;
             if (!tokenGraph[sym0]) tokenGraph[sym0] = {}; if (!tokenGraph[sym0][sym1]) tokenGraph[sym0][sym1] = []; tokenGraph[sym0][sym1].push(poolState);
             if (!tokenGraph[sym1]) tokenGraph[sym1] = {}; if (!tokenGraph[sym1][sym0]) tokenGraph[sym1][sym0] = []; tokenGraph[sym1][sym0].push(poolState);
        }
        logger.debug(`${logPrefix} Token graph built. Tokens: ${Object.keys(tokenGraph).join(', ')}`);

        // --- Triangle Detection Loops ---
        logger.debug(`${logPrefix} Starting triangle detection loops...`);
        const checkedTriangles = new Set();
        let loopACount = 0, loopBCount = 0, loopCCount = 0, innerTryCount = 0;

        for (const tokenASymbol in tokenGraph) { // Loop A
            loopACount++;
            logger.debug(`${logPrefix} Loop A (${loopACount}): TokenA = ${tokenASymbol}`);
            if (!tokenGraph[tokenASymbol]) continue; // Should not happen based on loop logic

            for (const tokenBSymbol in tokenGraph[tokenASymbol]) { // Loop B
                 loopBCount++;
                 logger.debug(`${logPrefix} Loop B (${loopBCount}): TokenB = ${tokenBSymbol}`);
                 if (!tokenGraph[tokenBSymbol]) continue; // Check if Token B exists as a key

                 for (const poolAB of tokenGraph[tokenASymbol][tokenBSymbol]) {
                     // Check poolAB validity early
                     if (!poolAB || typeof poolAB.sqrtPriceX96 === 'undefined' || typeof poolAB.fee !== 'number' || !(poolAB.token0 instanceof Token) || !(poolAB.token1 instanceof Token)) continue;

                     for (const tokenCSymbol in tokenGraph[tokenBSymbol]) { // Loop C
                         loopCCount++;
                         if (tokenCSymbol === tokenASymbol) continue; // Skip A->B->A
                         logger.debug(`${logPrefix} Loop C (${loopCCount}): TokenC = ${tokenCSymbol}`);
                         if (!tokenGraph[tokenCSymbol] || !tokenGraph[tokenCSymbol][tokenASymbol]) continue; // Check if C and C->A path exist

                         for (const poolBC of tokenGraph[tokenBSymbol][tokenCSymbol]) {
                             // Check poolBC validity
                              if (!poolBC || typeof poolBC.sqrtPriceX96 === 'undefined' || typeof poolBC.fee !== 'number' || !(poolBC.token0 instanceof Token) || !(poolBC.token1 instanceof Token)) continue;

                             for (const poolCA of tokenGraph[tokenCSymbol][tokenASymbol]) {
                                 // Check poolCA validity
                                 if (!poolCA || typeof poolCA.sqrtPriceX96 === 'undefined' || typeof poolCA.fee !== 'number' || !(poolCA.token0 instanceof Token) || !(poolCA.token1 instanceof Token)) continue;

                                 const pools = [poolAB, poolBC, poolCA];
                                 const triangleId = pools.map(p => p.address).sort().join('-');
                                 if (checkedTriangles.has(triangleId)) continue;
                                 checkedTriangles.add(triangleId);

                                 const pathSymbols = [tokenASymbol, tokenBSymbol, tokenCSymbol, tokenASymbol];
                                 const pathPools = pools.map(p=>p.address);
                                 const pathFees = pools.map(p=>p.fee);

                                 // --- Log Entry to Innermost Calculation Block ---
                                 logger.debug(`${logPrefix} --- Checking Triangle: ${pathSymbols.join('->')} Fees: ${pathFees.join(',')} ID: ${triangleId} ---`);
                                 innerTryCount++; // Count how many triangles we actually try to calculate

                                 try {
                                     // --- Price Ratio Calculation ---
                                     logger.debug(`${logPrefix} Calculating price ratios...`);
                                     const priceRatioAB_scaled = getScaledPriceRatio(poolAB.sqrtPriceX96, BIGNUM_SCALE);
                                     const priceRatioBC_scaled = getScaledPriceRatio(poolBC.sqrtPriceX96, BIGNUM_SCALE);
                                     const priceRatioCA_scaled = getScaledPriceRatio(poolCA.sqrtPriceX96, BIGNUM_SCALE);
                                     logger.debug(`${logPrefix} Price ratios calculated (AB:${priceRatioAB_scaled !== null}, BC:${priceRatioBC_scaled !== null}, CA:${priceRatioCA_scaled !== null})`);
                                     if (priceRatioAB_scaled === null || priceRatioBC_scaled === null || priceRatioCA_scaled === null) {
                                         logger.debug(`${logPrefix} Skipping triangle due to null price ratio.`);
                                         continue; // Skip this triangle if any ratio failed
                                     }

                                     // --- Rate Calculation (A->B->C->A) ---
                                      logger.debug(`${logPrefix} Calculating directional prices and rates...`);
                                     let scaledPrice_AtoB, scaledPrice_BtoC, scaledPrice_CtoA;
                                     // Price A -> B
                                     const decimals_T0_AB = BigInt(poolAB.token0.decimals); const decimals_T1_AB = BigInt(poolAB.token1.decimals); const decimalDiff_AB = decimals_T1_AB - decimals_T0_AB;
                                     const price_T1T0_adj_scaled_AB = decimalDiff_AB >= 0n ? priceRatioAB_scaled * (10n ** decimalDiff_AB) : priceRatioAB_scaled / (10n ** (-decimalDiff_AB));
                                     if (poolAB.token0Symbol === tokenASymbol) { scaledPrice_AtoB = price_T1T0_adj_scaled_AB; }
                                     else { if (price_T1T0_adj_scaled_AB === 0n) throw new Error(`Zero adjusted price AB`); scaledPrice_AtoB = (BIGNUM_SCALE * BIGNUM_SCALE) / price_T1T0_adj_scaled_AB; }
                                     // Price B -> C
                                     const decimals_T0_BC = BigInt(poolBC.token0.decimals); const decimals_T1_BC = BigInt(poolBC.token1.decimals); const decimalDiff_BC = decimals_T1_BC - decimals_T0_BC;
                                     const price_T1T0_adj_scaled_BC = decimalDiff_BC >= 0n ? priceRatioBC_scaled * (10n ** decimalDiff_BC) : priceRatioBC_scaled / (10n ** (-decimalDiff_BC));
                                     if (poolBC.token0Symbol === tokenBSymbol) { scaledPrice_BtoC = price_T1T0_adj_scaled_BC; }
                                     else { if (price_T1T0_adj_scaled_BC === 0n) throw new Error(`Zero adjusted price BC`); scaledPrice_BtoC = (BIGNUM_SCALE * BIGNUM_SCALE) / price_T1T0_adj_scaled_BC; }
                                     // Price C -> A
                                     const decimals_T0_CA = BigInt(poolCA.token0.decimals); const decimals_T1_CA = BigInt(poolCA.token1.decimals); const decimalDiff_CA = decimals_T1_CA - decimals_T0_CA;
                                     const price_T1T0_adj_scaled_CA = decimalDiff_CA >= 0n ? priceRatioCA_scaled * (10n ** decimalDiff_CA) : priceRatioCA_scaled / (10n ** (-decimalDiff_CA));
                                     if (poolCA.token0Symbol === tokenCSymbol) { scaledPrice_CtoA = price_T1T0_adj_scaled_CA; }
                                     else { if (price_T1T0_adj_scaled_CA === 0n) throw new Error(`Zero adjusted price CA`); scaledPrice_CtoA = (BIGNUM_SCALE * BIGNUM_SCALE) / price_T1T0_adj_scaled_CA; }

                                     // --- Calculate Raw Rate and Fee Multiplier ---
                                     logger.debug(`${logPrefix} Calculating raw rate and fee multiplier...`);
                                     const rawRate_scaled = (scaledPrice_AtoB * scaledPrice_BtoC * scaledPrice_CtoA) / (BIGNUM_SCALE * BIGNUM_SCALE);
                                     const feeAB_bps = BigInt(poolAB.fee); const feeBC_bps = BigInt(poolBC.fee); const feeCA_bps = BigInt(poolCA.fee); const TEN_THOUSAND = 10000n;
                                     const feeNum_scaled = (TEN_THOUSAND - feeAB_bps) * (TEN_THOUSAND - feeBC_bps) * (TEN_THOUSAND - feeCA_bps) * BIGNUM_SCALE;
                                     const feeDenom = TEN_THOUSAND * TEN_THOUSAND * TEN_THOUSAND;
                                     const feeMultiplier_scaled = feeDenom > 0n ? feeNum_scaled / feeDenom : 0n;
                                     const rateWithFees_scaled = (rawRate_scaled * feeMultiplier_scaled) / BIGNUM_SCALE;
                                     logger.debug(`${logPrefix} Calculations complete for triangle.`);

                                     // --- Log Rates and Check Profitability ---
                                     logger.debug(`  V3 Tri Raw Rate: ${formatScaledBigIntForLogging(rawRate_scaled, BIGNUM_SCALE_DECIMALS)} | Fee Mult: ${formatScaledBigIntForLogging(feeMultiplier_scaled, BIGNUM_SCALE_DECIMALS)} | Est Rate: ${formatScaledBigIntForLogging(rateWithFees_scaled, BIGNUM_SCALE_DECIMALS)}`);

                                     if (rateWithFees_scaled > PROFIT_THRESHOLD_SCALED) {
                                         logger.info(`${logPrefix} >>> POTENTIAL TRIANGULAR OPPORTUNITY FOUND <<<`);
                                         logger.info(`  Path: ${pathSymbols.join(' -> ')} Pools: ${pathPools.join(' -> ')} Fees: ${pathFees.join(' -> ')}`);
                                         logger.info(`  Est Rate: ${formatScaledBigIntForLogging(rateWithFees_scaled, BIGNUM_SCALE_DECIMALS)} > Threshold: ${formatScaledBigIntForLogging(PROFIT_THRESHOLD_SCALED, BIGNUM_SCALE_DECIMALS)}`);
                                         const opportunity = {
                                             type: 'triangularV3',
                                             pathSymbols: pathSymbols,
                                             pools: [poolAB, poolBC, poolCA], // Pass full state objects
                                             estimatedRate: rateWithFees_scaled.toString(), // Pass as string
                                             rawRate: rawRate_scaled.toString(), // Pass as string
                                             groupName: `TriV3_${pathSymbols.slice(0,3).join('_')}` // Auto group name
                                         };
                                         opportunities.push(opportunity);
                                     }
                                 } catch (error) {
                                     logger.error(`${logPrefix} Error calc rates for ${triangleId}: ${error.message}`, error.stack); // Log stack on error
                                     if (typeof handleError === 'function') handleError(error, `Triangle Calc ${triangleId}`);
                                 }
                             } // end poolCA loop
                         } // end poolBC loop
                     } // end tokenCSymbol loop
                 } // end poolAB loop
             } // end tokenBSymbol loop
        } // end tokenASymbol loop

        logger.debug(`${logPrefix} Finished loops. Checked ${innerTryCount} unique triangles.`);
        logger.info(`${logPrefix} Scan finished. Found ${opportunities.length} potential V3 triangular opportunities.`);
        return opportunities;
    } // End findOpportunities
} // End Class

module.exports = TriangularV3Finder;
