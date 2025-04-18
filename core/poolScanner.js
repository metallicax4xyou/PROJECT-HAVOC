// /workspaces/arbitrum-flash/core/poolScanner.js
const { ethers, FixedNumber } = require('ethers'); // Keep FixedNumber for formatting
const { Pool } = require('@uniswap/v3-sdk');
const { Token } = require('@uniswap/sdk-core');
const { ABIS } = require('../constants/abis');
const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler');
const { getPoolInfo } = require('./poolDataProvider');
const { TOKENS } = require('../constants/tokens');

const MAX_UINT128 = (1n << 128n) - 1n;
const Q96 = (1n << 96n);
const Q192 = Q96 * Q96; // Precompute Q192

// --- Configuration ---
const BIGNUM_SCALE_DECIMALS = 36; // Number of decimals for scaling
const BIGNUM_SCALE = 10n ** BigInt(BIGNUM_SCALE_DECIMALS);
// PROFIT_THRESHOLD = 1.0005 --> represented as BigInt scaled
const PROFIT_THRESHOLD_SCALED = (10005n * BIGNUM_SCALE) / 10000n;
const LOG_ALL_TRIANGLES = true; // Keep true for debugging

// Helper Function to get Tick Spacing from Fee Tier
function getTickSpacingFromFeeBps(feeBps) {
    const feeMap = { 100: 1, 500: 10, 3000: 60, 10000: 200 };
    const spacing = feeMap[feeBps];
    if (spacing === undefined) {
        logger.warn(`[PoolScanner] Unknown fee tier (${feeBps}bps), defaulting tickSpacing to 60.`);
        return 60;
    }
    return spacing;
}

// --- HELPER #4 (BigInt Price Ratio Calculation) ---
/**
 * Calculates the price ratio of token1/token0 using BigInt math, scaled.
 * Price(token1/token0) = (sqrtPriceX96 / 2^96)^2
 * Returns priceRatio * SCALE as a BigInt.
 * @param {bigint} sqrtPriceX96 The sqrtPriceX96 value from the pool.
 * @returns {bigint|null} The scaled price ratio, or null on error.
 */
function getScaledPriceRatio(sqrtPriceX96) {
    if (sqrtPriceX96 === 0n) return 0n;
    try {
        const sqrtP_squared = sqrtPriceX96 * sqrtPriceX96;
        const numerator = sqrtP_squared * BIGNUM_SCALE;
        if (Q192 === 0n) {
            logger.error("[getScaledPriceRatio] Q192 constant is zero!");
            return null;
        }
        const priceRatioScaled = numerator / Q192;
        return priceRatioScaled;
    } catch (error) {
        logger.error(`[getScaledPriceRatio] Error calculating scaled price ratio: ${error.message} for sqrtP=${sqrtPriceX96}`);
        return null;
    }
}

// --- Helper to format scaled BigInt for logging (Safer) ---
function formatScaledBigIntForLogging(scaledValue, scaleDecimals = BIGNUM_SCALE_DECIMALS) {
    if (typeof scaledValue !== 'bigint') return 'N/A';
    try {
        const scaleFactor = 10n ** BigInt(scaleDecimals);
        // Handle potential negative values if they ever occur (unlikely for rates)
        const isNegative = scaledValue < 0n;
        const absValue = isNegative ? -scaledValue : scaledValue;

        const integerPart = absValue / scaleFactor;
        const fractionalPart = absValue % scaleFactor;

        const fractionalString = fractionalPart.toString().padStart(scaleDecimals, '0');
        const displayDecimals = 8; // How many decimals to show in logs
        const displayFractional = fractionalString.slice(0, displayDecimals);

        return `${isNegative ? '-' : ''}${integerPart}.${displayFractional}`;
    } catch (e) {
        logger.error(`Error formatting BigInt ${scaledValue} for logging: ${e.message}`);
        return scaledValue.toString() + ` (Scale ${scaleDecimals})`; // Fallback
    }
}

class PoolScanner {
    // --- Constructor ---
    constructor(config, provider) {
        logger.debug(`[Scanner Constructor] Initializing...`);
        if (!config || !provider) {
             const errMsg = 'PoolScanner requires config and provider.';
             if (handleError) handleError(new Error(errMsg), 'ScannerInit'); else console.error(errMsg);
             throw new ArbitrageError(errMsg, 'INITIALIZATION_ERROR');
        }
        this.config = config;
        this.provider = provider;
        this.poolContractCache = {};
        logger.debug(`[Scanner Constructor] Config object received keys: ${Object.keys(config || {}).join(', ')}`);
        logger.info(`[Scanner] Initialized.`);
    }

    // --- _getPoolContract ---
    _getPoolContract(poolAddress) {
        if (!this.poolContractCache[poolAddress]) {
            try {
                if (!ABIS || !ABIS.UniswapV3Pool) { throw new Error("UniswapV3Pool ABI not found in constants/abis."); }
                this.poolContractCache[poolAddress] = new ethers.Contract(
                    poolAddress, ABIS.UniswapV3Pool, this.provider
                );
            } catch (error) {
                 logger.error(`[Scanner _getPoolContract] Error creating contract instance for ${poolAddress}: ${error.message}`);
                 if (handleError) handleError(error, `PoolScanner._getPoolContract (${poolAddress})`);
                 throw error;
            }
        }
        return this.poolContractCache[poolAddress];
    }

    // --- fetchPoolStates ---
    async fetchPoolStates(poolInfos) {
         logger.debug(`[Scanner fetchPoolStates] Received ${poolInfos?.length ?? 0} poolInfos to fetch.`);
        if (!poolInfos || poolInfos.length === 0) {
            logger.warn('[Scanner fetchPoolStates] No pool configurations provided. Cannot fetch states.'); return {};
        }
        logger.info(`[Scanner] Fetching live states for ${poolInfos.length} configured pools...`);
        const statePromises = []; const validPoolConfigsForStateFetch = [];
        for (const poolInfo of poolInfos) {
            if (!poolInfo || !poolInfo.address || !ethers.isAddress(poolInfo.address) || poolInfo.address === ethers.ZeroAddress || typeof poolInfo.fee !== 'number') {
                logger.warn(`[Scanner fetchPoolStates] Skipping invalid poolInfo: ${JSON.stringify(poolInfo)}`); continue;
            }
            try {
                const poolContract = this._getPoolContract(poolInfo.address);
                statePromises.push(
                    Promise.allSettled([
                        poolContract.slot0({ blockTag: 'latest' }), poolContract.liquidity({ blockTag: 'latest' })
                    ]).then(results => ({ poolInfo, slot0Result: results[0], liquidityResult: results[1] }))
                );
                validPoolConfigsForStateFetch.push(poolInfo);
            } catch (error) { logger.error(`[Scanner fetchPoolStates] Error preparing fetch for pool ${poolInfo.address}: ${error.message}`); }
        }
        if (statePromises.length === 0) {
            logger.warn('[Scanner fetchPoolStates] No valid pools to fetch states for.'); return {};
        }
        const livePoolStates = {};
        try {
            const results = await Promise.all(statePromises);
            for (const stateResult of results) {
                 const { poolInfo, slot0Result, liquidityResult } = stateResult; const address = poolInfo.address;
                if (slot0Result.status !== 'fulfilled' || liquidityResult.status !== 'fulfilled') {
                    const reason = slot0Result.reason?.message || liquidityResult.reason?.message || 'Unknown RPC/Contract Error';
                    logger.warn(`[Scanner] Pool ${address} (Fee: ${poolInfo.fee}bps) Fetch FAIL: ${reason}`); continue;
                }
                const slot0 = slot0Result.value; const liquidity = liquidityResult.value;
                if (slot0 == null || typeof slot0.sqrtPriceX96 === 'undefined' || typeof slot0.tick === 'undefined' || liquidity == null) {
                    logger.warn(`[Scanner] Pool ${address} (Fee: ${poolInfo.fee}bps) Invalid State Data: SqrtPrice=${slot0?.sqrtPriceX96}, Tick=${slot0?.tick}, Liquidity=${liquidity}`); continue;
                }
                 const currentSqrtPriceX96 = BigInt(slot0.sqrtPriceX96);
                 const currentLiquidity = BigInt(liquidity);

                 if (currentLiquidity > MAX_UINT128) {
                      logger.warn(`[Scanner] Pool ${address} (Fee: ${poolInfo.fee}bps) Liquidity value > MAX_UINT128 (${currentLiquidity}). Skipping.`); continue;
                 }
                const token0 = TOKENS[poolInfo.token0Symbol]; const token1 = TOKENS[poolInfo.token1Symbol];
                if (!(token0 instanceof Token) || !(token1 instanceof Token)) {
                    logger.error(`[Scanner] Internal Error: Could not resolve SDK Token instances for ${poolInfo.token0Symbol}/${poolInfo.token1Symbol}. Check constants/tokens.js. Skipping pool ${address}`); continue;
                }
                try {
                    livePoolStates[address] = {
                        address, fee: poolInfo.fee, tick: Number(slot0.tick),
                        liquidity: currentLiquidity, sqrtPriceX96: currentSqrtPriceX96,
                        tickSpacing: getTickSpacingFromFeeBps(poolInfo.fee), token0, token1,
                        token0Symbol: poolInfo.token0Symbol, token1Symbol: poolInfo.token1Symbol,
                    };
                } catch (sdkError) {
                     logger.error(`[Scanner fetchPoolStates] Pool ${address} SDK Pool Creation Error: ${sdkError.message}`);
                     if (handleError) handleError(sdkError, `PoolScanner.CreateSDKPool (${address})`);
                }
            }
        } catch (error) {
            logger.error(`[Scanner fetchPoolStates] CRITICAL Error processing pool states: ${error.message}`);
            if (handleError) handleError(error, 'PoolScanner.fetchPoolStates'); return {};
        }
        const finalCount = Object.keys(livePoolStates).length;
        logger.info(`[Scanner] Successfully fetched and processed states for ${finalCount} pools.`);
        if(finalCount === 0 && validPoolConfigsForStateFetch.length > 0){
            logger.warn(`[Scanner] Fetched 0 valid states despite attempting ${validPoolConfigsForStateFetch.length} pools.`);
        }
        return livePoolStates;
    }

     // --- REFACTORED findOpportunities (Pure BigInt Pipeline) ---
     findOpportunities(livePoolStatesMap) {
         logger.info(`[Scanner] Starting opportunity scan with ${Object.keys(livePoolStatesMap || {}).length} live pool states.`);
         const opportunities = [];
         if (!livePoolStatesMap || Object.keys(livePoolStatesMap).length < 3) {
              logger.info('[Scanner] Not enough live pool states (< 3) to form triangular path.');
              return opportunities;
         }

         // --- Step 1: Build Token Graph ---
         const tokenGraph = {};
         if (LOG_ALL_TRIANGLES) logger.debug('[Scanner] Building token graph...');
         for (const poolAddress in livePoolStatesMap) {
             const poolState = livePoolStatesMap[poolAddress];
             if (!poolState || !poolState.token0Symbol || !poolState.token1Symbol) {
                 logger.warn(`[Scanner] Pool ${poolAddress} missing token symbols or state. Skipping graph build.`);
                 continue;
             }
             const sym0 = poolState.token0Symbol; const sym1 = poolState.token1Symbol;
             if (!tokenGraph[sym0]) tokenGraph[sym0] = {}; if (!tokenGraph[sym0][sym1]) tokenGraph[sym0][sym1] = []; tokenGraph[sym0][sym1].push(poolState);
             if (!tokenGraph[sym1]) tokenGraph[sym1] = {}; if (!tokenGraph[sym1][sym0]) tokenGraph[sym1][sym0] = []; tokenGraph[sym1][sym0].push(poolState);
         }
         if (LOG_ALL_TRIANGLES) logger.debug(`[Scanner] Token graph built. Edges: ${Object.keys(tokenGraph).join(', ')}`);
         // --- End Step 1 ---

         // --- Step 2 & 3: Triangle Detection, BigInt Price Calculation & Profit Check ---
         logger.debug(`[Scanner] Starting triangle detection (BigInt) (Threshold: ~${formatScaledBigIntForLogging(PROFIT_THRESHOLD_SCALED)})...`);
         const checkedTriangles = new Set();

         for (const tokenASymbol in tokenGraph) {
             for (const tokenBSymbol in tokenGraph[tokenASymbol]) {
                 for (const poolAB of tokenGraph[tokenASymbol][tokenBSymbol]) {
                     if (!poolAB || !poolAB.token0 || !poolAB.token1 || !poolAB.sqrtPriceX96) { continue; }
                     if (!tokenGraph[tokenBSymbol]) continue;

                     for (const tokenCSymbol in tokenGraph[tokenBSymbol]) {
                         if (tokenCSymbol === tokenASymbol) continue;

                         for (const poolBC of tokenGraph[tokenBSymbol][tokenCSymbol]) {
                              if (!poolBC || !poolBC.token0 || !poolBC.token1 || !poolBC.sqrtPriceX96) { continue; }

                             if (tokenGraph[tokenCSymbol] && tokenGraph[tokenCSymbol][tokenASymbol]) {
                                 for (const poolCA of tokenGraph[tokenCSymbol][tokenASymbol]) {
                                     if (!poolCA || !poolCA.token0 || !poolCA.token1 || !poolCA.sqrtPriceX96) { continue; }

                                     const pools = [poolAB, poolBC, poolCA];
                                     const triangleId = pools.map(p => p.address).sort().join('-');
                                     if (checkedTriangles.has(triangleId)) { continue; }
                                     checkedTriangles.add(triangleId);

                                     const pathSymbols = [tokenASymbol, tokenBSymbol, tokenCSymbol, tokenASymbol];

                                     try {
                                         // 1. Get Price Ratios (Token1/Token0) * SCALE
                                         const priceRatioAB_scaled = getScaledPriceRatio(poolAB.sqrtPriceX96);
                                         const priceRatioBC_scaled = getScaledPriceRatio(poolBC.sqrtPriceX96);
                                         const priceRatioCA_scaled = getScaledPriceRatio(poolCA.sqrtPriceX96);

                                         if (priceRatioAB_scaled === null || priceRatioBC_scaled === null || priceRatioCA_scaled === null) {
                                             if (LOG_ALL_TRIANGLES) logger.debug(`[Scanner] Skipping triangle ${pathSymbols.join('->')} due to PriceRatio error.`);
                                             continue;
                                         }

                                         // 2. Adjust for direction and decimals
                                         let scaledPrice_AtoB, scaledPrice_BtoC, scaledPrice_CtoA;

                                         // Price A -> B
                                         const decimals_T0_AB = BigInt(poolAB.token0.decimals);
                                         const decimals_T1_AB = BigInt(poolAB.token1.decimals);
                                         const decimalDiff_AB = decimals_T0_AB - decimals_T1_AB;
                                         if (poolAB.token0Symbol === tokenASymbol) { // A=T0, B=T1. Price(B/A) = P(T1/T0)
                                              scaledPrice_AtoB = decimalDiff_AB > 0
                                                   ? (priceRatioAB_scaled * (10n ** decimalDiff_AB))
                                                   : (priceRatioAB_scaled / (10n ** (-decimalDiff_AB)));
                                         } else { // A=T1, B=T0. Price(B/A) = P(T0/T1) = 1 / P(T1/T0)
                                              const price_T1T0_adj_scaled = decimalDiff_AB > 0
                                                   ? (priceRatioAB_scaled * (10n ** decimalDiff_AB))
                                                   : (priceRatioAB_scaled / (10n ** (-decimalDiff_AB)));
                                              if (price_T1T0_adj_scaled === 0n) { throw new Error('Zero price in inversion A->B'); }
                                              scaledPrice_AtoB = (BIGNUM_SCALE * BIGNUM_SCALE) / price_T1T0_adj_scaled;
                                         }

                                         // Price B -> C
                                         const decimals_T0_BC = BigInt(poolBC.token0.decimals);
                                         const decimals_T1_BC = BigInt(poolBC.token1.decimals);
                                         const decimalDiff_BC = decimals_T0_BC - decimals_T1_BC;
                                         if (poolBC.token0Symbol === tokenBSymbol) { // B=T0, C=T1. Price(C/B) = P(T1/T0)
                                              scaledPrice_BtoC = decimalDiff_BC > 0
                                                 ? (priceRatioBC_scaled * (10n ** decimalDiff_BC))
                                                 : (priceRatioBC_scaled / (10n ** (-decimalDiff_BC)));
                                         } else { // B=T1, C=T0. Price(C/B) = P(T0/T1) = 1 / P(T1/T0)
                                             const price_T1T0_adj_scaled = decimalDiff_BC > 0
                                                 ? (priceRatioBC_scaled * (10n ** decimalDiff_BC))
                                                 : (priceRatioBC_scaled / (10n ** (-decimalDiff_BC)));
                                             if (price_T1T0_adj_scaled === 0n) { throw new Error('Zero price in inversion B->C'); }
                                             scaledPrice_BtoC = (BIGNUM_SCALE * BIGNUM_SCALE) / price_T1T0_adj_scaled;
                                         }

                                         // Price C -> A
                                         const decimals_T0_CA = BigInt(poolCA.token0.decimals);
                                         const decimals_T1_CA = BigInt(poolCA.token1.decimals);
                                         const decimalDiff_CA = decimals_T0_CA - decimals_T1_CA;
                                         if (poolCA.token0Symbol === tokenCSymbol) { // C=T0, A=T1. Price(A/C) = P(T1/T0)
                                              scaledPrice_CtoA = decimalDiff_CA > 0
                                                 ? (priceRatioCA_scaled * (10n ** decimalDiff_CA))
                                                 : (priceRatioCA_scaled / (10n ** (-decimalDiff_CA)));
                                         } else { // C=T1, A=T0. Price(A/C) = P(T0/T1) = 1 / P(T1/T0)
                                             const price_T1T0_adj_scaled = decimalDiff_CA > 0
                                                 ? (priceRatioCA_scaled * (10n ** decimalDiff_CA))
                                                 : (priceRatioCA_scaled / (10n ** (-decimalDiff_CA)));
                                             if (price_T1T0_adj_scaled === 0n) { throw new Error('Zero price in inversion C->A'); }
                                             scaledPrice_CtoA = (BIGNUM_SCALE * BIGNUM_SCALE) / price_T1T0_adj_scaled;
                                         }

                                         // 3. Calculate Raw Rate (scaled)
                                         const rawRate_scaled = (scaledPrice_AtoB * scaledPrice_BtoC * scaledPrice_CtoA) / (BIGNUM_SCALE * BIGNUM_SCALE);

                                         // 4. Calculate Fee Multiplier (scaled)
                                         const feeAB_bps = BigInt(poolAB.fee);
                                         const feeBC_bps = BigInt(poolBC.fee);
                                         const feeCA_bps = BigInt(poolCA.fee);
                                         const feeNum_scaled = (10000n - feeAB_bps) * (10000n - feeBC_bps) * (10000n - feeCA_bps) * BIGNUM_SCALE;
                                         const feeDenom = 10000n * 10000n * 10000n;
                                         const feeMultiplier_scaled = feeNum_scaled / feeDenom;

                                         // 5. Calculate Final Rate (scaled)
                                         const rateWithFees_scaled = (rawRate_scaled * feeMultiplier_scaled) / BIGNUM_SCALE;

                                         // Log details if enabled
                                         if (LOG_ALL_TRIANGLES) {
                                             logger.debug(`[Scanner] Triangle ${pathSymbols.join('->')} | Pools [${pools.map(p => `${p.address.slice(
