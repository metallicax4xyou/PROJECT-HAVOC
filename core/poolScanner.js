// /workspaces/arbitrum-flash/core/poolScanner.js
const { ethers, FixedNumber } = require('ethers'); // Keep FixedNumber for threshold constant formatting & final rate output string
const { Pool } = require('@uniswap/v3-sdk'); // Keep for context, not directly used in price calc
const { Token } = require('@uniswap/sdk-core');
const { ABIS } = require('../constants/abis');
const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler');
const { getPoolInfo } = require('./poolDataProvider'); // Kept for context
const { TOKENS } = require('../constants/tokens');

const MAX_UINT128 = (1n << 128n) - 1n;
const Q96 = (1n << 96n);
const Q192 = Q96 * Q96; // Precompute Q192

// --- Configuration ---
// Using BigInt representation for threshold comparison
const BIGNUM_SCALE_DECIMALS = 36; // Number of decimals for scaling
const BIGNUM_SCALE = 10n ** BigInt(BIGNUM_SCALE_DECIMALS);
// PROFIT_THRESHOLD = 1.0005 --> represented as BigInt scaled
const PROFIT_THRESHOLD_SCALED = (10005n * BIGNUM_SCALE) / 10000n;
const LOG_ALL_TRIANGLES = true; // Set to true for verbose debugging logs

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
    if (sqrtPriceX96 === 0n) return 0n; // Price is 0
    try {
        // Calculate numerator = sqrtPriceX96 * sqrtPriceX96 * SCALE
        // Use intermediate variable to potentially catch overflow earlier if sqrtPriceX96 is huge
        const sqrtP_squared = sqrtPriceX96 * sqrtPriceX96;
        const numerator = sqrtP_squared * BIGNUM_SCALE;

        // Ensure Q192 is not zero (should never happen)
        if (Q192 === 0n) {
            logger.error("[getScaledPriceRatio] Q192 constant is zero!");
            return null;
        }

        const priceRatioScaled = numerator / Q192;
        return priceRatioScaled;
    } catch (error) {
        // Catch potential BigInt calculation errors (e.g., overflow if intermediate numbers exceed BigInt limits, though unlikely here)
        logger.error(`[getScaledPriceRatio] Error calculating scaled price ratio: ${error.message} for sqrtP=${sqrtPriceX96}`);
        return null;
    }
}

// --- Helper to format scaled BigInt for logging (Safer) ---
function formatScaledBigIntForLogging(scaledValue, scaleDecimals = BIGNUM_SCALE_DECIMALS) {
    if (typeof scaledValue !== 'bigint') return 'N/A';
    try {
        // Basic string formatting for logging, might lose some precision visually
        const scaleFactor = 10n ** BigInt(scaleDecimals);
        const integerPart = scaledValue / scaleFactor;
        const fractionalPart = scaledValue % scaleFactor;

        // Pad fractional part and take leading digits for readability
        const fractionalString = fractionalPart.toString().padStart(scaleDecimals, '0');
        const displayDecimals = 8; // How many decimals to show in logs
        const displayFractional = fractionalString.slice(0, displayDecimals);

        return `${integerPart}.${displayFractional}`;
    } catch (e) {
        logger.error(`Error formatting BigInt ${scaledValue} for logging: ${e.message}`);
        // Fallback to raw string if formatting fails
        return scaledValue.toString() + ` (Scale ${scaleDecimals})`;
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
                 // logger.debug(`[Scanner _getPoolContract] Created contract instance for ${poolAddress}`); // Reduce noise
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
        // logger.debug(`[Scanner fetchPoolStates] Attempting to fetch state for ${statePromises.length} pools.`); // Reduce noise
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
                // Ensure sqrtPriceX96 is treated as BigInt
                if (slot0 == null || typeof slot0.sqrtPriceX96 === 'undefined' || typeof slot0.tick === 'undefined' || liquidity == null) {
                    logger.warn(`[Scanner] Pool ${address} (Fee: ${poolInfo.fee}bps) Invalid State Data: SqrtPrice=${slot0?.sqrtPriceX96}, Tick=${slot0?.tick}, Liquidity=${liquidity}`); continue;
                }
                 const currentSqrtPriceX96 = BigInt(slot0.sqrtPriceX96); // Explicitly cast to BigInt
                 const currentLiquidity = BigInt(liquidity); // Explicitly cast to BigInt

                 if (currentLiquidity > MAX_UINT128) {
                      logger.warn(`[Scanner] Pool ${address} (Fee: ${poolInfo.fee}bps) Liquidity value > MAX_UINT128 (${currentLiquidity}). Skipping.`); continue;
                 }
                const token0 = TOKENS[poolInfo.token0Symbol]; const token1 = TOKENS[poolInfo.token1Symbol];
                if (!(token0 instanceof Token) || !(token1 instanceof Token)) {
                    logger.error(`[Scanner] Internal Error: Could not resolve SDK Token instances for ${poolInfo.token0Symbol}/${poolInfo.token1Symbol}. Check constants/tokens.js. Skipping pool ${address}`); continue;
                }
                try {
                    livePoolStates[address] = {
                        address, fee: poolInfo.fee, tick: Number(slot0.tick), // tick is usually safe as Number
                        liquidity: currentLiquidity, // Store as BigInt
                        sqrtPriceX96: currentSqrtPriceX96, // Store as BigInt
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
             // Ensure poolState and tokens exist before accessing symbols
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
                 for (const poolAB of tokenGraph[tokenASymbol][tokenBSymbol]) { // Pool for A -> B
                     // Add checks for pool validity before accessing properties
                     if (!poolAB || !poolAB.token0 || !poolAB.token1 || !poolAB.sqrtPriceX96) {
                          logger.warn(`[Scanner] Invalid poolAB state encountered for ${tokenASymbol}->${tokenBSymbol}. Skipping.`);
                          continue;
                     }
                     if (!tokenGraph[tokenBSymbol]) continue; // Check intermediate token exists in graph

                     for (const tokenCSymbol in tokenGraph[tokenBSymbol]) {
                         if (tokenCSymbol === tokenASymbol) continue; // Skip A->B->A

                         for (const poolBC of tokenGraph[tokenBSymbol][tokenCSymbol]) { // Pool for B -> C
                              if (!poolBC || !poolBC.token0 || !poolBC.token1 || !poolBC.sqrtPriceX96) {
                                   logger.warn(`[Scanner] Invalid poolBC state encountered for ${tokenBSymbol}->${tokenCSymbol}. Skipping.`);
                                   continue;
                              }

                             if (tokenGraph[tokenCSymbol] && tokenGraph[tokenCSymbol][tokenASymbol]) {
                                 for (const poolCA of tokenGraph[tokenCSymbol][tokenASymbol]) { // Pool for C -> A
                                     if (!poolCA || !poolCA.token0 || !poolCA.token1 || !poolCA.sqrtPriceX96) {
                                          logger.warn(`[Scanner] Invalid poolCA state encountered for ${tokenCSymbol}->${tokenASymbol}. Skipping.`);
                                          continue;
                                     }

                                     const pools = [poolAB, poolBC, poolCA];
                                     const triangleId = pools.map(p => p.address).sort().join('-');
                                     if (checkedTriangles.has(triangleId)) { continue; }
                                     checkedTriangles.add(triangleId);

                                     const pathSymbols = [tokenASymbol, tokenBSymbol, tokenCSymbol, tokenASymbol];

                                     try {
                                         // --- Calculate SCALED prices using BigInt ---

                                         // 1. Get Price Ratios (Token1/Token0) * SCALE
                                         const priceRatioAB_scaled = getScaledPriceRatio(poolAB.sqrtPriceX96);
                                         const priceRatioBC_scaled = getScaledPriceRatio(poolBC.sqrtPriceX96);
                                         const priceRatioCA_scaled = getScaledPriceRatio(poolCA.sqrtPriceX96);

                                         if (priceRatioAB_scaled === null || priceRatioBC_scaled === null || priceRatioCA_scaled === null) {
                                             if (LOG_ALL_TRIANGLES) logger.debug(`[Scanner] Skipping triangle ${pathSymbols.join('->')} due to PriceRatio error.`);
                                             continue;
                                         }

                                         // 2. Adjust for direction and decimals (A -> B, B -> C, C -> A)
                                         let scaledPrice_AtoB, scaledPrice_BtoC, scaledPrice_CtoA;

                                         // Price A -> B (How many B for 1 A?) - Uses priceRatioAB (T1/T0)
                                         const decimals_T0_AB = BigInt(poolAB.token0.decimals);
                                         const decimals_T1_AB = BigInt(poolAB.token1.decimals);
                                         const decimalDiff_AB = decimals_T0_AB - decimals_T1_AB;
                                         const scaleDecimalFactor_AB = 10n ** BIGNUM_SCALE; // Use BIGNUM_SCALE directly

                                         if (poolAB.token0Symbol === tokenASymbol) { // A is Token0, B is Token1. Need Price(B/A) = Price(T1/T0)
                                             scaledPrice_AtoB = decimalDiff_AB > 0
                                                 ? (priceRatioAB_scaled * (10n ** decimalDiff_AB)) / scaleDecimalFactor_AB // Apply decimal adjust, keep scale
                                                 : (priceRatioAB_scaled * scaleDecimalFactor_AB) / (10n ** (-decimalDiff_AB)); // Apply decimal adjust, keep scale
                                         } else { // A is Token1, B is Token0. Need Price(B/A) = Price(T0/T1) = 1 / Price(T1/T0)
                                             const price_T1T0_adj_scaled = decimalDiff_AB > 0
                                                 ? (priceRatioAB_scaled * (10n ** decimalDiff_AB)) / scaleDecimalFactor_AB
                                                 : (priceRatioAB_scaled * scaleDecimalFactor_AB) / (10n ** (-decimalDiff_AB));

                                             if (price_T1T0_adj_scaled === 0n) { throw new Error('Zero price in inversion A->B'); }
                                             // Inverse (1*SCALE) / (Price*SCALE) = (1 / Price) * SCALE
                                             scaledPrice_AtoB = (BIGNUM_SCALE * BIGNUM_SCALE) / price_T1T0_adj_scaled;
                                         }

                                         // Price B -> C (How many C for 1 B?) - Uses priceRatioBC (T1/T0)
                                         const decimals_T0_BC = BigInt(poolBC.token0.decimals);
                                         const decimals_T1_BC = BigInt(poolBC.token1.decimals);
                                         const decimalDiff_BC = decimals_T0_BC - decimals_T1_BC;
                                         const scaleDecimalFactor_BC = 10n ** BIGNUM_SCALE;

                                         if (poolBC.token0Symbol === tokenBSymbol) { // B is T0, C is T1. Need Price(C/B) = Price(T1/T0)
                                              scaledPrice_BtoC = decimalDiff_BC > 0
                                                 ? (priceRatioBC_scaled * (10n ** decimalDiff_BC)) / scaleDecimalFactor_BC
                                                 : (priceRatioBC_scaled * scaleDecimalFactor_BC) / (10n ** (-decimalDiff_BC));
                                         } else { // B is T1, C is T0. Need Price(C/B) = Price(T0/T1) = 1 / Price(T1/T0)
                                             const price_T1T0_adj_scaled = decimalDiff_BC > 0
                                                 ? (priceRatioBC_scaled * (10n ** decimalDiff_BC)) / scaleDecimalFactor_BC
                                                 : (priceRatioBC_scaled * scaleDecimalFactor_BC) / (10n ** (-decimalDiff_BC));
                                             if (price_T1T0_adj_scaled === 0n) { throw new Error('Zero price in inversion B->C'); }
                                             scaledPrice_BtoC = (BIGNUM_SCALE * BIGNUM_SCALE) / price_T1T0_adj_scaled;
                                         }

                            
