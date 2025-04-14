// core/poolScanner.js
const { ethers } = require('ethers');
const { Pool } = require('@uniswap/v3-sdk');
const { Token } = require('@uniswap/sdk-core'); // Needed if we construct SDK tokens here
const { ABIS } = require('../constants/abis');
const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler');

const MAX_UINT128 = (1n << 128n) - 1n; // Uniswap SDK liquidity validation requires BigInts

class PoolScanner {
    constructor(config, provider) {
        if (!config || !provider) {
            throw new ArbitrageError('PoolScanner requires config and provider.', 'INITIALIZATION_ERROR');
        }
        this.config = config;
        this.provider = provider;
        // Cache for pool contracts to avoid recreating them every cycle
        this.poolContractCache = {};
    }

    /**
     * Gets or creates an ethers.Contract instance for a given pool address.
     * @param {string} poolAddress The pool's address.
     * @returns {ethers.Contract} The contract instance.
     */
    _getPoolContract(poolAddress) {
        if (!this.poolContractCache[poolAddress]) {
            // logger.debug(`[Scanner] Creating contract instance for pool: ${poolAddress}`);
            this.poolContractCache[poolAddress] = new ethers.Contract(
                poolAddress,
                ABIS.UniswapV3Pool, // Use ABI from constants
                this.provider
            );
        }
        return this.poolContractCache[poolAddress];
    }

    /**
     * Fetches the current on-chain state (slot0, liquidity) for a list of pool configurations.
     * @param {Array<object>} poolInfos Array of pool config objects [{ address, feeBps, groupName, ... }] from the main config.
     * @returns {Promise<object>} A map where keys are pool addresses and values are objects containing the live state
     *                            (e.g., { sdkPool, tick, liquidity, address, feeBps, groupName }). Returns empty object on error.
     */
    async fetchPoolStates(poolInfos) {
        if (!poolInfos || poolInfos.length === 0) {
            logger.warn('[Scanner] No pool configurations provided to fetch states for.');
            return {};
        }

        logger.log(`[Scanner] Fetching live states for ${poolInfos.length} configured pools...`);
        const statePromises = [];
        const validPoolConfigs = []; // Keep track of configs we attempt to fetch

        // Create promises for fetching slot0 and liquidity concurrently
        for (const poolInfo of poolInfos) {
            if (!poolInfo || !poolInfo.address || poolInfo.address === ethers.ZeroAddress) {
                logger.warn(`[Scanner] Skipping invalid pool config:`, poolInfo);
                continue;
            }
            try {
                const poolContract = this._getPoolContract(poolInfo.address);
                statePromises.push(
                    Promise.allSettled([
                        poolContract.slot0({ blockTag: 'latest' }), // Fetch from latest block
                        poolContract.liquidity({ blockTag: 'latest' })
                    ]).then(results => ({ // Include original info in the result
                        poolInfo: poolInfo,
                        slot0Result: results[0],
                        liquidityResult: results[1]
                    }))
                );
                validPoolConfigs.push(poolInfo); // Track that we initiated a fetch for this
            } catch (error) {
                handleError(error, `PoolScanner._getPoolContract (${poolInfo.address})`);
                 logger.warn(`[Scanner] Error preparing fetch for pool ${poolInfo.address}. Skipping.`);
            }
        }

        if (statePromises.length === 0) {
            logger.warn('[Scanner] No valid pools to fetch states for after initial validation.');
            return {};
        }

        const livePoolStates = {}; // { poolAddress: { sdkPool, tick, liquidity, ...poolInfo } }
        try {
            // Execute all fetches concurrently
            const results = await Promise.all(statePromises);

            // Process results
            for (const stateResult of results) {
                 // stateResult structure: { poolInfo, slot0Result, liquidityResult }
                 const { poolInfo, slot0Result, liquidityResult } = stateResult;
                 const address = poolInfo.address; // Get address from original info

                if (slot0Result.status !== 'fulfilled' || liquidityResult.status !== 'fulfilled') {
                    const reason = slot0Result.reason?.message || liquidityResult.reason?.message || 'Unknown RPC/Contract Error';
                    logger.warn(`[Scanner] Pool ${address} (Group: ${poolInfo.groupName}, Fee: ${poolInfo.feeBps}bps) Fetch FAIL: ${reason}`);
                    continue; // Skip this pool if fetching failed
                }

                const slot0 = slot0Result.value;
                const liquidity = liquidityResult.value;

                // Validate fetched data
                if (slot0 == null || typeof slot0.sqrtPriceX96 === 'undefined' || typeof slot0.tick === 'undefined' || liquidity == null || liquidity > MAX_UINT128) {
                    logger.warn(`[Scanner] Pool ${address} (Group: ${poolInfo.groupName}, Fee: ${poolInfo.feeBps}bps) Invalid State Data: SqrtPrice=${slot0?.sqrtPriceX96}, Tick=${slot0?.tick}, Liquidity=${liquidity}`);
                    continue; // Skip if data looks corrupt
                }
                 if (liquidity === 0n) {
                     logger.debug(`[Scanner] Pool ${address} (Group: ${poolInfo.groupName}, Fee: ${poolInfo.feeBps}bps) has zero liquidity.`);
                     // Potentially skip zero liquidity pools, depending on strategy
                     // continue;
                 }


                // Find the corresponding group config to get Token objects
                // This assumes groupName was passed in poolInfo
                const groupConfig = this.config.POOL_GROUPS.find(g => g.name === poolInfo.groupName);
                if (!groupConfig || !groupConfig.sdkToken0 || !groupConfig.sdkToken1) {
                    logger.error(`[Scanner] Internal Error: Could not find group config or SDK tokens for group ${poolInfo.groupName}. Skipping pool ${address}`);
                    continue;
                }

                try {
                    const tickCurrent = Number(slot0.tick);
                    const sqrtPriceX96 = slot0.sqrtPriceX96;

                    // Create Uniswap SDK Pool object using SDK tokens from config
                    const sdkPool = new Pool(
                        groupConfig.sdkToken0, // Use pre-created SDK Token object
                        groupConfig.sdkToken1, // Use pre-created SDK Token object
                        poolInfo.feeBps,
                        sqrtPriceX96.toString(), // Must be string
                        liquidity.toString(),    // Must be string
                        tickCurrent
                    );

                    livePoolStates[address] = {
                        ...poolInfo, // Keep original config info (address, feeBps, groupName)
                        sdkPool: sdkPool,
                        tick: tickCurrent,
                        liquidity: liquidity, // Store as BigInt
                        sqrtPriceX96: sqrtPriceX96 // Store for potential use
                    };
                    // logger.debug(`[Scanner] Pool ${address} (Group: ${poolInfo.groupName}, Fee: ${poolInfo.feeBps}bps) State OK: Tick=${tickCurrent}, Liq=${liquidity.toString()}`);

                } catch (sdkError) {
                     handleError(sdkError, `PoolScanner.CreateSDKPool (${address})`);
                     logger.warn(`[Scanner] Pool ${address} (Group: ${poolInfo.groupName}, Fee: ${poolInfo.feeBps}bps) SDK Pool Creation Error: ${sdkError.message}`);
                }
            } // End processing results

        } catch (error) {
            // Catch errors from Promise.all itself (e.g., network issues during fetch)
            handleError(error, 'PoolScanner.fetchPoolStates');
             logger.error(`[Scanner] CRITICAL Error fetching pool states: ${error.message}`);
             return {}; // Return empty on critical fetch error
        }

        logger.log(`[Scanner] Successfully fetched and processed states for ${Object.keys(livePoolStates).length} pools.`);
        return livePoolStates;
    }

     /**
      * Finds potential arbitrage opportunities by comparing ticks within groups.
      * This is the logic previously in monitor.js (detection part).
      * @param {object} livePoolStates Map of poolAddress -> { sdkPool, tick, liquidity, ...poolInfo }
      * @returns {Array<object>} List of potential opportunity objects, ready for simulation.
      */
     findOpportunities(livePoolStates) {
         const opportunities = [];
         if (!livePoolStates || Object.keys(livePoolStates).length < 2) {
              logger.debug('[Scanner] Not enough live pool states to find opportunities.');
              return opportunities; // Need at least two pools overall to compare
         }

         logger.log('[Scanner] Scanning for price discrepancies...');

         // Group pools by their groupName
         const poolsByGroup = {};
         for (const poolAddress in livePoolStates) {
             const poolData = livePoolStates[poolAddress];
             if (!poolsByGroup[poolData.groupName]) {
                 poolsByGroup[poolData.groupName] = [];
             }
             poolsByGroup[poolData.groupName].push(poolData);
         }

         // Compare pairs within each group
         for (const groupName in poolsByGroup) {
             const poolsInGroup = poolsByGroup[groupName];

             if (poolsInGroup.length < 2) {
                 logger.debug(`[Scanner] Skipping group ${groupName} - only ${poolsInGroup.length} valid pool(s) found this cycle.`);
                 continue;
             }

             logger.debug(`[Scanner] Comparing ${poolsInGroup.length} pools in group ${groupName}...`);
             const groupConfig = this.config.POOL_GROUPS.find(g => g.name === groupName); // Find original group config

             if (!groupConfig || !groupConfig.sdkBorrowToken) {
                  logger.error(`[Scanner] Internal Error: Could not find group config or borrow token for group ${groupName}. Cannot identify opportunities.`);
                  continue;
             }

             for (let i = 0; i < poolsInGroup.length; i++) {
                 for (let j = i + 1; j < poolsInGroup.length; j++) {
                     const livePool1 = poolsInGroup[i];
                     const livePool2 = poolsInGroup[j];

                     const tick1 = livePool1.tick;
                     const tick2 = livePool2.tick;
                     const tickDelta = Math.abs(tick1 - tick2);
                     // TODO: Make TICK_DIFF_THRESHOLD configurable?
                     const TICK_DIFF_THRESHOLD = 1; // Minimum tick difference to consider

                     // logger.debug(`  - Compare ${livePool1.feeBps}bps(${tick1}) vs ${livePool2.feeBps}bps(${tick2}) | Delta: ${tickDelta}`);

                     let startPoolLive = null; // Pool to borrow from (lower price)
                     let swapPoolLive = null;  // Pool to swap on (higher price)

                     // Determine direction based on price (tick)
                     if (tick2 > tick1 + TICK_DIFF_THRESHOLD) { startPoolLive = livePool1; swapPoolLive = livePool2; }
                     else if (tick1 > tick2 + TICK_DIFF_THRESHOLD) { startPoolLive = livePool2; swapPoolLive = livePool1; }
                     else { continue; } // Ticks too close

                     // Determine the intermediate token (the one NOT being borrowed)
                     let sdkIntermediateToken;
                     if (groupConfig.sdkBorrowToken.equals(groupConfig.sdkToken0)) { sdkIntermediateToken = groupConfig.sdkToken1; }
                     else if (groupConfig.sdkBorrowToken.equals(groupConfig.sdkToken1)) { sdkIntermediateToken = groupConfig.sdkToken0; }
                     else { logger.error(`[Scanner] Config Error: Borrow token ${groupConfig.sdkBorrowToken.symbol} mismatch in group ${groupName}.`); continue; }

                     logger.log(`[Scanner] Potential Opportunity Found: Group ${groupName}, Borrow ${groupConfig.sdkBorrowToken.symbol} from ${startPoolLive.feeBps}bps -> Swap on ${swapPoolLive.feeBps}bps`);

                     // Construct opportunity object for the simulator
                     const opportunity = {
                         groupName: groupName,
                         startPoolInfo: startPoolLive, // Contains address, feeBps, sdkPool, tick, liquidity
                         swapPoolInfo: swapPoolLive,   // Contains address, feeBps, sdkPool, tick, liquidity
                         sdkTokenBorrowed: groupConfig.sdkBorrowToken,
                         sdkTokenIntermediate: sdkIntermediateToken,
                         borrowAmount: groupConfig.borrowAmount, // Borrow amount from config
                         // Include any other relevant info needed by simulator/executor
                     };
                     opportunities.push(opportunity);

                 } // End inner loop (j)
             } // End outer loop (i)
         } // End group loop

        logger.log(`[Scanner] Found ${opportunities.length} potential opportunities.`);
        return opportunities;
     }

}

module.exports = { PoolScanner };
