// /workspaces/arbitrum-flash/core/poolScanner.js
const { ethers } = require('ethers');
const { Pool } = require('@uniswap/v3-sdk');
const { Token } = require('@uniswap/sdk-core');
// Assuming ABIS are correctly defined and exported here
const { ABIS } = require('../constants/abis'); // Make sure this file exists and exports ABIS.UniswapV3Pool
const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler'); // Assuming this exports handleError
const { getPoolInfo } = require('./poolDataProvider'); // Assuming this exists and works
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
    // --- Constructor expects main config and provider ---
    constructor(config, provider) {
        logger.debug(`[Scanner Constructor] Initializing...`); // Added log
        if (!config || !provider) {
            // Use handleError for consistency if available, otherwise throw raw error
             const errMsg = 'PoolScanner requires config and provider.';
             if (handleError) handleError(new Error(errMsg), 'ScannerInit'); else console.error(errMsg);
             throw new ArbitrageError(errMsg, 'INITIALIZATION_ERROR');
        }
        this.config = config; // Store the main config
        this.provider = provider;
        this.poolContractCache = {};
        logger.debug(`[Scanner Constructor] Config object received keys: ${Object.keys(config || {}).join(', ')}`); // Added log
        logger.info(`[Scanner] Initialized.`); // Simplified log
    }

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

    // --- fetchPoolStates requires poolInfos array as argument ---
    async fetchPoolStates(poolInfos) {
         logger.debug(`[Scanner fetchPoolStates] Received ${poolInfos?.length ?? 0} poolInfos to fetch.`); // Added log
        if (!poolInfos || poolInfos.length === 0) {
            // This is the source of the warning seen previously
            logger.warn('[Scanner fetchPoolStates] No pool configurations provided (poolInfos array is empty). Cannot fetch states.');
            return {}; // Return empty object as per original logic
        }

        logger.info(`[Scanner] Fetching live states for ${poolInfos.length} configured pools...`);
        const statePromises = [];
        const validPoolConfigsForStateFetch = []; // Keep track of configs we attempt to fetch

        for (const poolInfo of poolInfos) {
            // Basic validation of the passed info
            if (!poolInfo || !poolInfo.address || !ethers.isAddress(poolInfo.address) || poolInfo.address === ethers.ZeroAddress || typeof poolInfo.fee !== 'number') {
                logger.warn(`[Scanner fetchPoolStates] Skipping invalid poolInfo received: ${JSON.stringify(poolInfo)}`);
                continue;
            }
            try {
                const poolContract = this._getPoolContract(poolInfo.address);
                // Fetch slot0 and liquidity using Promise.allSettled for resilience
                statePromises.push(
                    Promise.allSettled([
                        poolContract.slot0({ blockTag: 'latest' }),
                        poolContract.liquidity({ blockTag: 'latest' })
                    ]).then(results => ({
                        poolInfo: poolInfo, // Pass the original poolInfo through
                        slot0Result: results[0],
                        liquidityResult: results[1]
                    }))
                );
                validPoolConfigsForStateFetch.push(poolInfo); // Add to list of pools we're trying to fetch
            } catch (error) {
                // Error likely from _getPoolContract if ABI is missing
                logger.error(`[Scanner fetchPoolStates] Error preparing fetch for pool ${poolInfo.address}: ${error.message}`);
                // No need to call handleError here as it's called within _getPoolContract or below
            }
        }

        if (statePromises.length === 0) {
            logger.warn('[Scanner fetchPoolStates] No valid pools to fetch states for after filtering invalid info/contract errors.');
            return {};
        }

        logger.debug(`[Scanner fetchPoolStates] Attempting to fetch state for ${statePromises.length} pools.`);
        const livePoolStates = {}; // Use address as key
        try {
            const results = await Promise.all(statePromises);

            for (const stateResult of results) {
                 const { poolInfo, slot0Result, liquidityResult } = stateResult;
                 const address = poolInfo.address; // Address from the original info passed in

                if (slot0Result.status !== 'fulfilled' || liquidityResult.status !== 'fulfilled') {
                    const reason = slot0Result.reason?.message || liquidityResult.reason?.message || 'Unknown RPC/Contract Error';
                    logger.warn(`[Scanner] Pool ${address} (Fee: ${poolInfo.fee}bps) Fetch FAIL: ${reason}`);
                    continue; // Skip this pool if fetching failed
                }

                const slot0 = slot0Result.value;
                const liquidity = liquidityResult.value;

                // Validate the fetched data
                if (slot0 == null || typeof slot0.sqrtPriceX96 === 'undefined' || typeof slot0.tick === 'undefined' || liquidity == null) {
                    logger.warn(`[Scanner] Pool ${address} (Fee: ${poolInfo.fee}bps) Invalid State Data: SqrtPrice=${slot0?.sqrtPriceX96}, Tick=${slot0?.tick}, Liquidity=${liquidity}`);
                    continue; // Skip this pool if state data is invalid
                }
                 // Check for excessively large liquidity which might indicate an issue
                 if (liquidity > MAX_UINT128) {
                      logger.warn(`[Scanner] Pool ${address} (Fee: ${poolInfo.fee}bps) Liquidity value > MAX_UINT128 (${liquidity}). Skipping.`);
                      continue;
                 }


                // Resolve Token objects using the TOKENS constant map
                const token0 = TOKENS[poolInfo.token0Symbol];
                const token1 = TOKENS[poolInfo.token1Symbol];

                if (!(token0 instanceof Token) || !(token1 instanceof Token)) {
                    logger.error(`[Scanner] Internal Error: Could not resolve SDK Token instances for symbols ${poolInfo.token0Symbol}/${poolInfo.token1Symbol}. Check constants/tokens.js. Skipping pool ${address}`);
                    continue;
                }

                try {
                    const tickCurrent = Number(slot0.tick);
                    const sqrtPriceX96 = slot0.sqrtPriceX96;
                    const tickSpacing = getTickSpacingFromFeeBps(poolInfo.fee); // Use fee from poolInfo

                    // Create SDK Pool object - simplified constructor usage
                    // IMPORTANT: Ensure your @uniswap/v3-sdk version doesn't require tickDataProvider here
                    // If it does, you'll need to implement or mock one.
                    const sdkPool = new Pool(
                        token0.sortsBefore(token1) ? token0 : token1, // Ensure tokens are sorted for Pool constructor
                        token0.sortsBefore(token1) ? token1 : token0,
                        poolInfo.fee,
                        sqrtPriceX96.toString(),
                        liquidity.toString(),
                        tickCurrent
                        // tickSpacing argument might not be needed depending on SDK version
                        // tickSpacing // Add if required
                    );

                    // Store the fetched and processed state
                    livePoolStates[address] = {
                        address: address,
                        fee: poolInfo.fee, // Keep original fee
                        group: poolInfo.group, // Keep original group name
                        // Store live data
                        tick: tickCurrent,
                        liquidity: liquidity,
                        sqrtPriceX96: sqrtPriceX96,
                        tickSpacing: tickSpacing, // Store calculated tickSpacing
                        // Store resolved SDK Token instances
                        token0: token0,
                        token1: token1,
                        // Optional: store the SDK Pool instance if simulator doesn't create its own
                        // sdkPool: sdkPool,
                    };
                     logger.debug(`[Scanner fetchPoolStates] Successfully processed state for ${address}`);

                } catch (sdkError) {
                     logger.error(`[Scanner fetchPoolStates] Pool ${address} SDK Pool Creation Error: ${sdkError.message}`);
                     if (handleError) handleError(sdkError, `PoolScanner.CreateSDKPool (${address})`);
                     // Continue to next pool if SDK creation fails
                }
            } // End processing results loop

        } catch (error) {
            logger.error(`[Scanner fetchPoolStates] CRITICAL Error processing pool states: ${error.message}`);
            if (handleError) handleError(error, 'PoolScanner.fetchPoolStates');
             return {}; // Return empty object on critical error during processing
        }

        const finalCount = Object.keys(livePoolStates).length;
        logger.info(`[Scanner] Successfully fetched and processed states for ${finalCount} pools.`);
        if(finalCount === 0 && validPoolConfigsForStateFetch.length > 0){
            logger.warn(`[Scanner] Fetched 0 valid states despite attempting ${validPoolConfigsForStateFetch.length} pools. Check RPC errors or pool contract issues.`);
        }
        return livePoolStates; // Return object keyed by address
    }

     // --- findOpportunities needs to process the livePoolStates object returned by fetchPoolStates ---
     findOpportunities(livePoolStatesMap) { // Changed param name for clarity
         logger.debug(`[Scanner findOpportunities] Scanning ${Object.keys(livePoolStatesMap || {}).length} live pool states...`);
         const opportunities = [];
         if (!livePoolStatesMap || Object.keys(livePoolStatesMap).length < 2) {
              logger.info('[Scanner] Not enough live pool states to find opportunities.');
              return opportunities;
         }

         // --- Reconstruct pools grouped by their 'group' property ---
         const poolsByGroup = {};
         for (const address in livePoolStatesMap) {
             const poolData = livePoolStatesMap[address];
             const groupName = poolData.group; // Get group from the live state object
             if (!groupName) {
                 logger.warn(`[Scanner findOpportunities] Pool ${address} missing group name in live state. Skipping.`);
                 continue;
             }
             if (!poolsByGroup[groupName]) { poolsByGroup[groupName] = []; }
             poolsByGroup[groupName].push(poolData);
         }
         // --- ---

         logger.debug(`[Scanner] Scanning groups: ${Object.keys(poolsByGroup).join(', ')}`);

         for (const groupName in poolsByGroup) {
             const poolsInGroup = poolsByGroup[groupName];
             if (poolsInGroup.length < 2) { continue; } // Need >= 2 pools per group

             logger.debug(`[Scanner] Comparing ${poolsInGroup.length} pools in group ${groupName}...`);

             // --- Need Borrow Token definition - Get from main config ---
             // Assuming config structure holds this, adjust if needed
             const groupConfig = this.config.networks[process.env.NETWORK?.toLowerCase() || 'arbitrum']?.poolGroups?.[groupName];
             if (!groupConfig || !groupConfig.token0Symbol || !groupConfig.token1Symbol) {
                 logger.error(`[Scanner findOpportunities] Config Error: Could not find group config for ${groupName} in main config.`);
                 continue;
             }
             // Determine which token (token0 or token1 of the group) is the borrow token
             // This needs a clear definition in your config or logic based on convention (e.g., WETH in WETH_USDC)
             // For now, let's assume token0 of the group is the borrow token - THIS MIGHT BE WRONG!
             const borrowTokenSymbol = groupConfig.token0Symbol; // *** ASSUMPTION ***
             const sdkBorrowToken = TOKENS[borrowTokenSymbol];
             if (!sdkBorrowToken) {
                  logger.error(`[Scanner findOpportunities] Config Error: Borrow token symbol ${borrowTokenSymbol} for group ${groupName} not found in TOKENS constant.`);
                  continue;
             }
             // --- ---


             // Compare each pair of pools within the group
             for (let i = 0; i < poolsInGroup.length; i++) {
                 for (let j = i + 1; j < poolsInGroup.length; j++) {
                     const pool1 = poolsInGroup[i];
                     const pool2 = poolsInGroup[j];

                     // --- Actual Price Comparison Logic Needed Here ---
                     // Compare prices derived from pool1.sqrtPriceX96 and pool2.sqrtPriceX96
                     // This needs careful implementation considering token decimals and direction
                     // Placeholder: Compare ticks (simple, but often inaccurate for real arb)
                     const tick1 = pool1.tick;
                     const tick2 = pool2.tick;
                     const TICK_DIFF_THRESHOLD = 1; // Minimal difference to consider

                     let poolHop1 = null, poolHop2 = null; // Pool to borrow/first swap, pool for second swap

                     if (tick2 > tick1 + TICK_DIFF_THRESHOLD) { // Price in pool2 is higher (Sell high)
                         poolHop1 = pool1; // Borrow/Swap on lower price pool
                         poolHop2 = pool2; // Swap back on higher price pool
                     } else if (tick1 > tick2 + TICK_DIFF_THRESHOLD) { // Price in pool1 is higher
                         poolHop1 = pool2; // Borrow/Swap on lower price pool
                         poolHop2 = pool1; // Swap back on higher price pool
                     } else {
                         continue; // Ticks too close, no obvious opportunity
                     }
                     // --- End Placeholder Logic ---


                     // --- Determine Intermediate Token ---
                     // This assumes poolHop1 has token0 and token1 properties that are SDK Tokens
                     let sdkIntermediateToken;
                     if (!poolHop1.token0 || !poolHop1.token1){
                        logger.warn(`[Scanner] Pool ${poolHop1.address} missing token data in live state. Skipping opp check.`);
                        continue;
                     }
                     if (sdkBorrowToken.equals(poolHop1.token0)) {
                         sdkIntermediateToken = poolHop1.token1;
                     } else if (sdkBorrowToken.equals(poolHop1.token1)) {
                         sdkIntermediateToken = poolHop1.token0;
                     } else {
                         logger.error(`[Scanner] Logic Error: Borrow token ${sdkBorrowToken.symbol} doesn't match tokens ${poolHop1.token0.symbol}/${poolHop1.token1.symbol} in pool ${poolHop1.address}.`);
                         continue;
                     }
                     // --- ---

                     // --- Optional: Liquidity Check ---
                     // const minLiquidity = ... // Get threshold from config if needed
                     // if (poolHop1.liquidity < minLiquidity || poolHop2.liquidity < minLiquidity) continue;
                     // --- ---

                     logger.info(`[Scanner] Potential Opportunity Found: Group ${groupName}, Borrow ${sdkBorrowToken.symbol} from ${poolHop1.fee}bps -> Swap on ${poolHop2.fee}bps`);

                     // Construct opportunity object - Ensure simulator gets all needed data
                     const opportunity = {
                         group: groupName, // Pass group name
                         token0: sdkBorrowToken, // Token being borrowed (starting/ending token)
                         token1: sdkIntermediateToken, // Intermediate token
                         // Pass the full live state objects for both hops
                         poolHop1: poolHop1, // Includes address, fee, tick, liquidity, sqrtPriceX96, tickSpacing, token0, token1
                         poolHop2: poolHop2,
                         // Add borrow amount if needed by simulator, get from config
                         // borrowAmount: Config.flashSwap.borrowAmount // Example
                     };
                     opportunities.push(opportunity);
                 }
             }
         } // End group loop

        logger.info(`[Scanner] Found ${opportunities.length} potential opportunities.`);
        return opportunities;
     }
}

module.exports = { PoolScanner };
