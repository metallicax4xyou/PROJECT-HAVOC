// /workspaces/arbitrum-flash/core/poolScanner.js
const { ethers } = require('ethers');
const { Pool } = require('@uniswap/v3-sdk');
const { Token } = require('@uniswap/sdk-core');
// Assuming ABIS are correctly defined and exported here
const { ABIS } = require('../constants/abis'); // Make sure this file exists and exports ABIS.UniswapV3Pool
const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler'); // Assuming this exports handleError
const { getPoolInfo } = require('./poolDataProvider'); // Kept for context, though not used in findOpportunities
const { TOKENS } = require('../constants/tokens'); // Assuming this exists and works

const MAX_UINT128 = (1n << 128n) - 1n;

// Helper Function to get Tick Spacing from Fee Tier
function getTickSpacingFromFeeBps(feeBps) {
    // Using feeBps directly as number keys might be cleaner
    const feeMap = { 100: 1, 500: 10, 3000: 60, 10000: 200 };
    const spacing = feeMap[feeBps];
    if (spacing === undefined) {
        logger.warn(`[PoolScanner] Unknown fee tier (${feeBps}bps), defaulting tickSpacing to 60.`);
        return 60;
    }
    return spacing;
}

class PoolScanner {
    // --- Constructor remains the same ---
    constructor(config, provider) {
        logger.debug(`[Scanner Constructor] Initializing...`);
        if (!config || !provider) {
             const errMsg = 'PoolScanner requires config and provider.';
             if (handleError) handleError(new Error(errMsg), 'ScannerInit'); else console.error(errMsg);
             throw new ArbitrageError(errMsg, 'INITIALIZATION_ERROR');
        }
        this.config = config; // Store the main config
        this.provider = provider;
        this.poolContractCache = {};
        logger.debug(`[Scanner Constructor] Config object received keys: ${Object.keys(config || {}).join(', ')}`);
        logger.info(`[Scanner] Initialized.`);
    }

    // --- _getPoolContract remains the same ---
    _getPoolContract(poolAddress) {
        if (!this.poolContractCache[poolAddress]) {
            try {
                // Ensure ABIS.UniswapV3Pool is correctly loaded
                if (!ABIS || !ABIS.UniswapV3Pool) {
                    throw new Error("UniswapV3Pool ABI not found in constants/abis.");
                }
                this.poolContractCache[poolAddress] = new ethers.Contract(
                    poolAddress,
                    ABIS.UniswapV3Pool, // Use the ABI from constants
                    this.provider
                );
                 logger.debug(`[Scanner _getPoolContract] Created contract instance for ${poolAddress}`);
            } catch (error) {
                 logger.error(`[Scanner _getPoolContract] Error creating contract instance for ${poolAddress}: ${error.message}`);
                 if (handleError) handleError(error, `PoolScanner._getPoolContract (${poolAddress})`);
                 throw error; // Re-throw after logging
            }
        }
        return this.poolContractCache[poolAddress];
    }

    // --- fetchPoolStates (with minor modification to add symbols) ---
    async fetchPoolStates(poolInfos) {
         logger.debug(`[Scanner fetchPoolStates] Received ${poolInfos?.length ?? 0} poolInfos to fetch.`);
        if (!poolInfos || poolInfos.length === 0) {
            logger.warn('[Scanner fetchPoolStates] No pool configurations provided (poolInfos array is empty). Cannot fetch states.');
            return {};
        }

        logger.info(`[Scanner] Fetching live states for ${poolInfos.length} configured pools...`);
        const statePromises = [];
        const validPoolConfigsForStateFetch = [];

        for (const poolInfo of poolInfos) {
            if (!poolInfo || !poolInfo.address || !ethers.isAddress(poolInfo.address) || poolInfo.address === ethers.ZeroAddress || typeof poolInfo.fee !== 'number') {
                logger.warn(`[Scanner fetchPoolStates] Skipping invalid poolInfo received: ${JSON.stringify(poolInfo)}`);
                continue;
            }
            try {
                const poolContract = this._getPoolContract(poolInfo.address);
                statePromises.push(
                    Promise.allSettled([
                        poolContract.slot0({ blockTag: 'latest' }),
                        poolContract.liquidity({ blockTag: 'latest' })
                    ]).then(results => ({
                        poolInfo: poolInfo,
                        slot0Result: results[0],
                        liquidityResult: results[1]
                    }))
                );
                validPoolConfigsForStateFetch.push(poolInfo);
            } catch (error) {
                logger.error(`[Scanner fetchPoolStates] Error preparing fetch for pool ${poolInfo.address}: ${error.message}`);
            }
        }

        if (statePromises.length === 0) {
            logger.warn('[Scanner fetchPoolStates] No valid pools to fetch states for after filtering invalid info/contract errors.');
            return {};
        }

        logger.debug(`[Scanner fetchPoolStates] Attempting to fetch state for ${statePromises.length} pools.`);
        const livePoolStates = {};
        try {
            const results = await Promise.all(statePromises);

            for (const stateResult of results) {
                 const { poolInfo, slot0Result, liquidityResult } = stateResult;
                 const address = poolInfo.address;

                if (slot0Result.status !== 'fulfilled' || liquidityResult.status !== 'fulfilled') {
                    const reason = slot0Result.reason?.message || liquidityResult.reason?.message || 'Unknown RPC/Contract Error';
                    logger.warn(`[Scanner] Pool ${address} (Fee: ${poolInfo.fee}bps) Fetch FAIL: ${reason}`);
                    continue;
                }

                const slot0 = slot0Result.value;
                const liquidity = liquidityResult.value;

                if (slot0 == null || typeof slot0.sqrtPriceX96 === 'undefined' || typeof slot0.tick === 'undefined' || liquidity == null) {
                    logger.warn(`[Scanner] Pool ${address} (Fee: ${poolInfo.fee}bps) Invalid State Data: SqrtPrice=${slot0?.sqrtPriceX96}, Tick=${slot0?.tick}, Liquidity=${liquidity}`);
                    continue;
                }
                 if (liquidity > MAX_UINT128) {
                      logger.warn(`[Scanner] Pool ${address} (Fee: ${poolInfo.fee}bps) Liquidity value > MAX_UINT128 (${liquidity}). Skipping.`);
                      continue;
                 }

                const token0 = TOKENS[poolInfo.token0Symbol];
                const token1 = TOKENS[poolInfo.token1Symbol];

                if (!(token0 instanceof Token) || !(token1 instanceof Token)) {
                    logger.error(`[Scanner] Internal Error: Could not resolve SDK Token instances for symbols ${poolInfo.token0Symbol}/${poolInfo.token1Symbol}. Check constants/tokens.js. Skipping pool ${address}`);
                    continue;
                }

                try {
                    const tickCurrent = Number(slot0.tick);
                    const sqrtPriceX96 = slot0.sqrtPriceX96;
                    const tickSpacing = getTickSpacingFromFeeBps(poolInfo.fee);

                    // Store the fetched and processed state
                    livePoolStates[address] = {
                        address: address,
                        fee: poolInfo.fee, // Keep original fee
                        tick: tickCurrent,
                        liquidity: liquidity,
                        sqrtPriceX96: sqrtPriceX96,
                        tickSpacing: tickSpacing, // Store calculated tickSpacing
                        // Store resolved SDK Token instances
                        token0: token0,
                        token1: token1,
                        // Added symbols for easier graph building
                        token0Symbol: poolInfo.token0Symbol,
                        token1Symbol: poolInfo.token1Symbol,
                    };
                     logger.debug(`[Scanner fetchPoolStates] Successfully processed state for ${address}`);

                } catch (sdkError) {
                     logger.error(`[Scanner fetchPoolStates] Pool ${address} SDK Pool Creation Error: ${sdkError.message}`);
                     if (handleError) handleError(sdkError, `PoolScanner.CreateSDKPool (${address})`);
                }
            } // End processing results loop

        } catch (error) {
            logger.error(`[Scanner fetchPoolStates] CRITICAL Error processing pool states: ${error.message}`);
            if (handleError) handleError(error, 'PoolScanner.fetchPoolStates');
             return {};
        }

        const finalCount = Object.keys(livePoolStates).length;
        logger.info(`[Scanner] Successfully fetched and processed states for ${finalCount} pools.`);
        if(finalCount === 0 && validPoolConfigsForStateFetch.length > 0){
            logger.warn(`[Scanner] Fetched 0 valid states despite attempting ${validPoolConfigsForStateFetch.length} pools. Check RPC errors or pool contract issues.`);
        }
        return livePoolStates; // Return object keyed by address
    }

     // --- REFACTORED findOpportunities ---
     findOpportunities(livePoolStatesMap) {
         logger.info(`[Scanner] Starting opportunity scan with ${Object.keys(livePoolStatesMap || {}).length} live pool states.`);
         const opportunities = [];
         if (!livePoolStatesMap || Object.keys(livePoolStatesMap).length < 3) { // Need at least 3 pools for a potential triangle
              logger.info('[Scanner] Not enough live pool states (< 3) to form a triangular arbitrage path.');
              return opportunities;
         }

         // --- Step 1: Build Token Graph ---
         const tokenGraph = {}; // Structure: { TokenA_Symbol: { TokenB_Symbol: [poolState1, poolState2, ...] } }

         logger.debug('[Scanner] Building token graph from live pool states...');
         for (const poolAddress in livePoolStatesMap) {
             const poolState = livePoolStatesMap[poolAddress];

             if (!poolState.token0Symbol || !poolState.token1Symbol) {
                 logger.warn(`[Scanner] Pool ${poolAddress} missing token symbols in live state. Skipping during graph build.`);
                 continue;
             }
             const sym0 = poolState.token0Symbol;
             const sym1 = poolState.token1Symbol;

             if (!tokenGraph[sym0]) tokenGraph[sym0] = {};
             if (!tokenGraph[sym0][sym1]) tokenGraph[sym0][sym1] = [];
             tokenGraph[sym0][sym1].push(poolState);

             if (!tokenGraph[sym1]) tokenGraph[sym1] = {};
             if (!tokenGraph[sym1][sym0]) tokenGraph[sym1][sym0] = [];
             tokenGraph[sym1][sym0].push(poolState);
         }
         logger.debug(`[Scanner] Token graph built. Tokens with edges: ${Object.keys(tokenGraph).join(', ')}`);
         // --- End Step 1 ---


         // --- Step 2: Triangle Detection Loop ---
         logger.debug('[Scanner] Starting triangle detection loops...');
         const checkedTriangles = new Set(); // To avoid duplicates like A->B->C and A->C->B if pricing isn't checked yet

         // Iterate through all possible starting tokens (Token A)
         for (const tokenASymbol in tokenGraph) {
             // Iterate through all possible intermediate tokens (Token B) connected to Token A
             for (const tokenBSymbol in tokenGraph[tokenASymbol]) {
                 // Iterate through all pools connecting Token A and Token B (P_AB)
                 for (const poolAB of tokenGraph[tokenASymbol][tokenBSymbol]) {

                     // Iterate through all possible final tokens (Token C) connected to Token B
                     // Ensure Token C is not the same as Token A (to avoid A->B->A)
                     if (!tokenGraph[tokenBSymbol]) continue; // Should not happen if graph built correctly, but safe check
                     for (const tokenCSymbol in tokenGraph[tokenBSymbol]) {
                         if (tokenCSymbol === tokenASymbol) continue; // Skip A->B->A

                         // Iterate through all pools connecting Token B and Token C (P_BC)
                         for (const poolBC of tokenGraph[tokenBSymbol][tokenCSymbol]) {

                             // Check if Token C is connected back to Token A
                             if (tokenGraph[tokenCSymbol] && tokenGraph[tokenCSymbol][tokenASymbol]) {
                                 // Iterate through all pools connecting Token C and Token A (P_CA)
                                 for (const poolCA of tokenGraph[tokenCSymbol][tokenASymbol]) {

                                     // Now we have a potential triangle: A -> B -> C -> A
                                     // Using pools: poolAB, poolBC, poolCA
                                     const path = [tokenASymbol, tokenBSymbol, tokenCSymbol, tokenASymbol];
                                     const pools = [poolAB, poolBC, poolCA];

                                     // Optional: Prevent checking the same triangle path multiple times
                                     // E.g. WETH->USDC->ARB->WETH via specific pools
                                     const triangleId = pools.map(p => p.address).sort().join('-');
                                     if (checkedTriangles.has(triangleId)) {
                                         continue;
                                     }
                                     checkedTriangles.add(triangleId);

                                     logger.debug(`[Scanner] Found potential triangle: ${path.join(' -> ')} using pools [${pools.map(p => `${p.address}(${p.fee})`).join(', ')}]`);


                                     // --- Step 3: Profitability Check & Opportunity Creation (Placeholder) ---
                                     // TODO: Calculate theoretical price rate (ignoring fees/slippage first)
                                     // TODO: If rate > 1, then calculate rate with fees
                                     // TODO: If rateWithFees > PROFIT_THRESHOLD, create opportunity object
                                     // Example structure:
                                     // const opportunity = {
                                     //     type: 'triangular',
                                     //     pathSymbols: path, // [A_Symbol, B_Symbol, C_Symbol, A_Symbol]
                                     //     pathTokens: [TOKENS[tokenASymbol], TOKENS[tokenBSymbol], TOKENS[tokenCSymbol], TOKENS[tokenASymbol]], // SDK Token objects
                                     //     pools: pools, // [poolAB_State, poolBC_State, poolCA_State]
                                     //     // estimatedRate: calculatedRate // Add this later
                                     // };
                                     // opportunities.push(opportunity);
                                     // --- End Step 3 Placeholder ---

                                 } // End loop P_CA
                             } // End check C -> A
                         } // End loop P_BC
                     } // End loop Token C
                 } // End loop P_AB
             } // End loop Token B
         } // End loop Token A
         logger.debug(`[Scanner] Finished triangle detection loops.`);
         // --- End Step 2 ---


         logger.info(`[Scanner] Opportunity scan complete. Found ${opportunities.length} potential opportunities (Profit Check Pending).`);
         return opportunities;
     }
}

module.exports = { PoolScanner };
