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
const LOG_ALL_TRIANGLES = true; // *** CHANGED TO TRUE FOR DETAILED LOGGING ***

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

// --- HELPER FUNCTION for Price Calculation (Remains the Same) ---
function getFixedPriceQuote(poolState, baseTokenSymbol) {
    try {
        const { sqrtPriceX96, token0, token1, token0Symbol, token1Symbol } = poolState;
        if (!token0 || !token1 || typeof token0.decimals !== 'number' || typeof token1.decimals !== 'number') {
            logger.warn(`[getFixedPriceQuote] Invalid token data in poolState for ${poolState.address}`); return null;
        }
        if (sqrtPriceX96 === 0n) {
             logger.warn(`[getFixedPriceQuote] sqrtPriceX96 is zero for pool ${poolState.address}.`); return null;
        }
        const sqrtPriceX96Fixed = FixedNumber.fromValue(sqrtPriceX96, 0, "fixed128x96");
        const Q96Fixed = FixedNumber.fromValue(Q96, 0, "fixed128x96");
        const priceRatioFixed = sqrtPriceX96Fixed.divUnsafe(Q96Fixed).mulUnsafe(sqrtPriceX96Fixed.divUnsafe(Q96Fixed));
        const decimalDiff = token0.decimals - token1.decimals;
        const decimalFactor = FixedNumber.fromString("10").powUnsafe(FixedNumber.fromString(decimalDiff.toString()));
        const priceToken1InToken0 = priceRatioFixed.mulUnsafe(decimalFactor);
        if (baseTokenSymbol === token0Symbol) {
            return priceToken1InToken0;
        } else if (baseTokenSymbol === token1Symbol) {
            if (priceToken1InToken0.isZero()) {
                logger.warn(`[getFixedPriceQuote] Calculated price of ${token1Symbol}/${token0Symbol} is zero for pool ${poolState.address}. Cannot invert.`); return null;
            }
            return FixedNumber.fromString("1.0").divUnsafe(priceToken1InToken0);
        } else {
            logger.warn(`[getFixedPriceQuote] baseTokenSymbol ${baseTokenSymbol} not found in pool ${poolState.address} (${token0Symbol}/${token1Symbol})`); return null;
        }
    } catch (error) {
        logger.error(`[getFixedPriceQuote] Error calculating price for pool ${poolState?.address}: ${error.message}`);
        if (error instanceof Error && error.message.includes('overflow')) {
             logger.error(`[getFixedPriceQuote] Possible overflow during FixedNumber calculation. Pool: ${poolState?.address}, sqrtPrice: ${poolState?.sqrtPriceX96}`);
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
                     // Removed the per-pool success log from fetch to reduce noise when LOG_ALL_TRIANGLES is on
                     // logger.debug(`[Scanner fetchPoolStates] Successfully processed state for ${address}`);
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

     // --- REFACTORED findOpportunities (Logging Enabled) ---
     findOpportunities(livePoolStatesMap) {
         logger.info(`[Scanner] Starting opportunity scan with ${Object.keys(livePoolStatesMap || {}).length} live pool states.`);
         const opportunities = [];
         if (!livePoolStatesMap || Object.keys(livePoolStatesMap).length < 3) {
              logger.info('[Scanner] Not enough live pool states (< 3) to form a triangular arbitrage path.');
              return opportunities;
         }

         // --- Step 1: Build Token Graph ---
         const tokenGraph = {};
         if (LOG_ALL_TRIANGLES) logger.debug('[Scanner] Building token graph...'); // Less verbose graph build log
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

                                     const priceB_in_A = getFixedPriceQuote(poolAB, tokenASymbol);
                                     const priceC_in_B = getFixedPriceQuote(poolBC, tokenBSymbol);
                                     const priceA_in_C = getFixedPriceQuote(poolCA, tokenCSymbol);

                                     if (!priceB_in_A || !priceC_in_B || !priceA_in_C) {
                                         if (LOG_ALL_TRIANGLES) logger.debug(`[Scanner] Skipping triangle ${pathSymbols.join('->')} due to price calculation error.`);
                                         continue;
                                     }

                                     try {
                                         const rawRate = priceB_in_A.mulUnsafe(priceC_in_B).mulUnsafe(priceA_in_C);
                                         const feeAB = FixedNumber.fromString(poolAB.fee.toString()).divUnsafe(FixedNumber.fromString("10000"));
                                         const feeBC = FixedNumber.fromString(poolBC.fee.toString()).divUnsafe(FixedNumber.fromString("10000"));
                                         const feeCA = FixedNumber.fromString(poolCA.fee.toString()).divUnsafe(FixedNumber.fromString("10000"));
                                         const feeMultiplier = ONE.subUnsafe(feeAB).mulUnsafe(ONE.subUnsafe(feeBC)).mulUnsafe(ONE.subUnsafe(feeCA));
                                         const rateWithFees = rawRate.mulUnsafe(feeMultiplier);

                                         // *** DETAILED LOGGING ENABLED ***
                                         if (LOG_ALL_TRIANGLES) {
                                             // Log with slightly more precision using toFixed
                                             logger.debug(`[Scanner] Triangle ${pathSymbols.join('->')} | Pools [${pools.map(p => `${p.address.slice(0, 6)}..(${p.fee})`).join(', ')}] | Raw Rate: ${rawRate.toUnsafeFloat().toFixed(8)} | Fee Adj Rate: ${rateWithFees.toUnsafeFloat().toFixed(8)}`);
                                         }

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

         logger.info(`[Scanner] Opportunity scan complete. Found ${opportunities.length} profitable opportunities (Fee Adjusted Rate > ${PROFIT_THRESHOLD.toString()}). Checked ${checkedTriangles.size} unique triangles.`); // Added triangle count
         return opportunities;
     }
}

module.exports = { PoolScanner };
