// /workspaces/arbitrum-flash/core/poolScanner.js
const { ethers, FixedNumber } = require('ethers');
const { Pool } = require('@uniswap/v3-sdk');
const { Token } = require('@uniswap/sdk-core');
const { ABIS } = require('../constants/abis');
const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler');
const { getPoolInfo } = require('./poolDataProvider'); // Kept for context
const { TOKENS } = require('../constants/tokens');

const MAX_UINT128 = (1n << 128n) - 1n;
const Q96 = (1n << 96n);

// --- Configuration for Profitability ---
const PROFIT_THRESHOLD = FixedNumber.fromString("1.0005"); // 0.05% profit threshold
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


// --- REVISED HELPER FUNCTION #3 for Price Calculation (Direct FixedNumber) ---
/**
 * Calculates the price of one token in terms of another using sqrtPriceX96.
 * Returns a FixedNumber for precision.
 * Uses FixedNumber math inspired by common Q-format handling.
 * @param {object} poolState - The live state object for the pool.
 * @param {string} baseTokenSymbol - The symbol of the token we want the price denominated in.
 * @returns {FixedNumber|null} The price of the other token in terms of the baseToken, or null if invalid.
 */
function getFixedPriceQuote(poolState, baseTokenSymbol) {
    try {
        const { sqrtPriceX96, token0, token1, token0Symbol, token1Symbol } = poolState;

        if (!token0 || !token1 || typeof token0.decimals !== 'number' || typeof token1.decimals !== 'number') {
            logger.warn(`[getFixedPriceQuote] Invalid token data in poolState for ${poolState.address}`); return null;
        }
        if (sqrtPriceX96 === 0n) {
             logger.warn(`[getFixedPriceQuote] sqrtPriceX96 is zero for pool ${poolState.address}.`); return null;
        }

        // --- FixedNumber Calculation (Attempt 3) ---
        // Represent sqrtPriceX96 as a FixedNumber (interpreting it as a value, no implied decimals yet)
        const sqrtP_FN = FixedNumber.fromValue(sqrtPriceX96, 0);

        // Represent 2^192 as a FixedNumber (Q96 * Q96)
        // Note: FixedNumber might struggle with powers this large directly. Let's compute Q192 as BigInt first.
        const Q192_BigInt = Q96 * Q96; // 1n << 192n
        const Q192_FN = FixedNumber.fromValue(Q192_BigInt, 0);

        // Calculate price^2 = (sqrtPriceX96 * sqrtPriceX96) / (2^192) using FixedNumber math
        // This calculates the raw price ratio of Token1/Token0
        if (Q192_FN.isZero()) { // Should not happen, but safety check
             logger.error("[getFixedPriceQuote] Calculated Q192_FN is zero. Cannot divide.");
             return null;
        }
        const priceRatioSquared_FN = sqrtP_FN.mulUnsafe(sqrtP_FN).divUnsafe(Q192_FN);

        // Decimal adjustment factor: 10^(decimals0 - decimals1)
        const decimalDiff = token0.decimals - token1.decimals;
        const decimalFactor = FixedNumber.fromString("10").powUnsafe(FixedNumber.fromString(decimalDiff.toString()));

        // Price of Token1 in terms of Token0, adjusted for decimals
        const priceToken1InToken0 = priceRatioSquared_FN.mulUnsafe(decimalFactor);
        // --- End FixedNumber Calculation ---


        // --- Return based on baseTokenSymbol ---
        if (baseTokenSymbol === token0Symbol) {
            // We want the price of Token1 in terms of Token0
            return priceToken1InToken0;
        } else if (baseTokenSymbol === token1Symbol) {
            // We want the price of Token0 in terms of Token1 (inverse)
            if (priceToken1InToken0.isZero()) {
                logger.warn(`[getFixedPriceQuote] Calculated price of ${token1Symbol}/${token0Symbol} is zero for pool ${poolState.address}. Cannot invert.`);
                return null;
            }
            return FixedNumber.fromString("1.0").divUnsafe(priceToken1InToken0);
        } else {
            logger.warn(`[getFixedPriceQuote] baseTokenSymbol ${baseTokenSymbol} not found in pool ${poolState.address} (${token0Symbol}/${token1Symbol})`);
            return null;
        }
    } catch (error) {
        // Catch potential errors during FixedNumber/BigInt operations
        logger.error(`[getFixedPriceQuote] Error calculating price for pool ${poolState?.address}: ${error.message} (sqrtPriceX96: ${poolState?.sqrtPriceX96})`);
        // Log specific numeric faults if they occur
        if (error.code === 'NUMERIC_FAULT') {
             logger.error(`[getFixedPriceQuote] Numeric fault detail: ${error.fault} on value ${error.value}`);
        }
        return null;
    }
}
// --- END HELPER FUNCTION ---


class PoolScanner {
    // --- Constructor remains the same ---
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

    // --- _getPoolContract remains the same ---
    _getPoolContract(poolAddress) {
        if (!this.poolContractCache[poolAddress]) {
            try {
                if (!ABIS || !ABIS.UniswapV3Pool) { throw new Error("UniswapV3Pool ABI not found in constants/abis."); }
                this.poolContractCache[poolAddress] = new ethers.Contract(
                    poolAddress, ABIS.UniswapV3Pool, this.provider
                );
                 logger.debug(`[Scanner _getPoolContract] Created contract instance for ${poolAddress}`);
            } catch (error) {
                 logger.error(`[Scanner _getPoolContract] Error creating contract instance for ${poolAddress}: ${error.message}`);
                 if (handleError) handleError(error, `PoolScanner._getPoolContract (${poolAddress})`);
                 throw error;
            }
        }
        return this.poolContractCache[poolAddress];
    }

    // --- fetchPoolStates remains the same ---
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
        logger.debug(`[Scanner fetchPoolStates] Attempting to fetch state for ${statePromises.length} pools.`);
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
                 if (liquidity > MAX_UINT128) {
                      logger.warn(`[Scanner] Pool ${address} (Fee: ${poolInfo.fee}bps) Liquidity value > MAX_UINT128 (${liquidity}). Skipping.`); continue;
                 }
                const token0 = TOKENS[poolInfo.token0Symbol]; const token1 = TOKENS[poolInfo.token1Symbol];
                if (!(token0 instanceof Token) || !(token1 instanceof Token)) {
                    logger.error(`[Scanner] Internal Error: Could not resolve SDK Token instances for ${poolInfo.token0Symbol}/${poolInfo.token1Symbol}. Check constants/tokens.js. Skipping pool ${address}`); continue;
                }
                try {
                    livePoolStates[address] = {
                        address, fee: poolInfo.fee, tick: Number(slot0.tick), liquidity, sqrtPriceX96: slot0.sqrtPriceX96,
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

     // --- REFACTORED findOpportunities (Using Revised Price Calc #3) ---
     findOpportunities(livePoolStatesMap) {
         logger.info(`[Scanner] Starting opportunity scan with ${Object.keys(livePoolStatesMap || {}).length} live pool states.`);
         const opportunities = [];
         if (!livePoolStatesMap || Object.keys(livePoolStatesMap).length < 3) {
              logger.info('[Scanner] Not enough live pool states (< 3) to form a triangular arbitrage path.');
              return opportunities;
         }

         // --- Step 1: Build Token Graph ---
         const tokenGraph = {};
         if (LOG_ALL_TRIANGLES) logger.debug('[Scanner] Building token graph...');
         for (const poolAddress in livePoolStatesMap) {
             const poolState = livePoolStatesMap[poolAddress];
             if (!poolState.token0Symbol || !poolState.token1Symbol) { logger.warn(`[Scanner] Pool ${poolAddress} missing token symbols. Skipping.`); continue; }
             const sym0 = poolState.token0Symbol; const sym1 = poolState.token1Symbol;
             if (!tokenGraph[sym0]) tokenGraph[sym0] = {}; if (!tokenGraph[sym0][sym1]) tokenGraph[sym0][sym1] = []; tokenGraph[sym0][sym1].push(poolState);
             if (!tokenGraph[sym1]) tokenGraph[sym1] = {}; if (!tokenGraph[sym1][sym0]) tokenGraph[sym1][sym0] = []; tokenGraph[sym1][sym0].push(poolState);
         }
         if (LOG_ALL_TRIANGLES) logger.debug(`[Scanner] Token graph built. Edges: ${Object.keys(tokenGraph).join(', ')}`);
         // --- End Step 1 ---

         // --- Step 2 & 3: Triangle Detection, Price Calculation & Fee-Adjusted Profit Check ---
         logger.debug(`[Scanner] Starting triangle detection and profitability analysis (Threshold: ${PROFIT_THRESHOLD.toString()})...`);
         const checkedTriangles = new Set();
         const ONE = FixedNumber.fromString("1.0");

         for (const tokenASymbol in tokenGraph) {
             for (const tokenBSymbol in tokenGraph[tokenASymbol]) {
                 for (const poolAB of tokenGraph[tokenASymbol][tokenBSymbol]) {
                     if (!tokenGraph[tokenBSymbol]) continue;
                     for (const tokenCSymbol in tokenGraph[tokenBSymbol]) {
                         if (tokenCSymbol === tokenASymbol) continue; // Skip A->B->A
                         for (const poolBC of tokenGraph[tokenBSymbol][tokenCSymbol]) {
                             if (tokenGraph[tokenCSymbol] && tokenGraph[tokenCSymbol][tokenASymbol]) {
                                 for (const poolCA of tokenGraph[tokenCSymbol][tokenASymbol]) {

                                     const pools = [poolAB, poolBC, poolCA];
                                     const triangleId = pools.map(p => p.address).sort().join('-');
                                     if (checkedTriangles.has(triangleId)) { continue; }
                                     checkedTriangles.add(triangleId);

                                     const pathSymbols = [tokenASymbol, tokenBSymbol, tokenCSymbol, tokenASymbol];

                                     // --- Calculate Theoretical Rate ---
                                     const priceB_in_A = getFixedPriceQuote(poolAB, tokenASymbol);
                                     const priceC_in_B = getFixedPriceQuote(poolBC, tokenBSymbol);
                                     const priceA_in_C = getFixedPriceQuote(poolCA, tokenCSymbol);

                                     // Check if price calculation failed for any leg
                                     if (!priceB_in_A || !priceC_in_B || !priceA_in_C) {
                                         if (LOG_ALL_TRIANGLES) logger.debug(`[Scanner] Skipping triangle ${pathSymbols.join('->')} due to price calculation error.`);
                                         continue; // Skip this triangle
                                     }

                                     try {
                                         // Calculate Raw Rate
                                         const rawRate = priceB_in_A.mulUnsafe(priceC_in_B).mulUnsafe(priceA_in_C);

                                         // Calculate Fee Multiplier
                                         const feeAB = FixedNumber.fromString(poolAB.fee.toString()).divUnsafe(FixedNumber.fromString("10000"));
                                         const feeBC = FixedNumber.fromString(poolBC.fee.toString()).divUnsafe(FixedNumber.fromString("10000"));
                                         const feeCA = FixedNumber.fromString(poolCA.fee.toString()).divUnsafe(FixedNumber.fromString("10000"));
                                         const feeMultiplier = ONE.subUnsafe(feeAB).mulUnsafe(ONE.subUnsafe(feeBC)).mulUnsafe(ONE.subUnsafe(feeCA));

                                         // Calculate Rate Adjusted for Fees
                                         const rateWithFees = rawRate.mulUnsafe(feeMultiplier);

                                         // Log details if enabled
                                         if (LOG_ALL_TRIANGLES) {
                                             // Use toFixed for better readability of small differences
                                             logger.debug(`[Scanner] Triangle ${pathSymbols.join('->')} | Pools [${pools.map(p => `${p.address.slice(0, 6)}..(${p.fee})`).join(', ')}] | Raw Rate: ${rawRate.toUnsafeFloat().toFixed(8)} | Fee Adj Rate: ${rateWithFees.toUnsafeFloat().toFixed(8)}`);
                                         }

                                         // Final Profitability Check
                                         if (rateWithFees.gt(PROFIT_THRESHOLD)) {
                                             logger.info(`✅ [Scanner] PROFITABLE OPPORTUNITY FOUND: ${pathSymbols.join('->')} | Pools: [${pools.map(p => `${p.address.slice(0, 6)}..(${p.fee})`).join(', ')}] | Fee Adj Rate: ${rateWithFees.toString()} > ${PROFIT_THRESHOLD.toString()}`);
                                             const opportunity = {
                                                 type: 'triangular', pathSymbols,
                                                 pathTokens: [TOKENS[tokenASymbol], TOKENS[tokenBSymbol], TOKENS[tokenCSymbol], TOKENS[tokenASymbol]],
                                                 pools, estimatedRate: rateWithFees.toString(), rawRate: rawRate.toString()
                                             };
                                             opportunities.push(opportunity);
                                         }
                                     } catch (calcError) {
                                        logger.warn(`[Scanner] Error during rate/fee calculation for triangle ${pathSymbols.join('->')}: ${calcError.message}`);
                                     }
                                 } // End loop P_CA
                             } // End check C -> A
                         } // End loop P_BC
                     } // End loop Token C
                 } // End loop P_AB
             } // End loop Token B
         } // End loop Token A
         logger.debug(`[Scanner] Finished triangle detection and profitability analysis.`);
         // --- End Step 2 & 3 ---

         logger.info(`[Scanner] Opportunity scan complete. Found ${opportunities.length} profitable opportunities (Fee Adjusted Rate > ${PROFIT_THRESHOLD.toString()}). Checked ${checkedTriangles.size} unique triangles.`);
         return opportunities;
     }
}

module.exports = { PoolScanner };
