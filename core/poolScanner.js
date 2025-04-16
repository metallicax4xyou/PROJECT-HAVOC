// core/poolScanner.js
const { ethers } = require('ethers');
const { Pool } = require('@uniswap/v3-sdk');
const { Token } = require('@uniswap/sdk-core');
const { ABIS } = require('../constants/abis');
const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler');

const MAX_UINT128 = (1n << 128n) - 1n;

// --- Helper Function to get Tick Spacing from Fee Tier ---
function getTickSpacingFromFeeBps(feeBps) {
    switch (feeBps) {
        case 100: return 1;   // 0.01%
        case 500: return 10;  // 0.05%
        case 3000: return 60; // 0.30%
        case 10000: return 200; // 1.00%
        default:
            logger.warn(`[PoolScanner] Unknown fee tier (${feeBps}bps), defaulting tickSpacing to 60.`);
            return 60; // Default to standard 0.3% spacing if unknown
    }
}
// --- ---

class PoolScanner {
    constructor(config, provider) {
        if (!config || !provider) {
            throw new ArbitrageError('PoolScanner requires config and provider.', 'INITIALIZATION_ERROR');
        }
        this.config = config;
        this.provider = provider;
        this.poolContractCache = {};
    }

    _getPoolContract(poolAddress) {
        if (!this.poolContractCache[poolAddress]) {
            this.poolContractCache[poolAddress] = new ethers.Contract(
                poolAddress,
                ABIS.UniswapV3Pool,
                this.provider
            );
        }
        return this.poolContractCache[poolAddress];
    }

    async fetchPoolStates(poolInfos) {
        if (!poolInfos || poolInfos.length === 0) {
            logger.warn('[Scanner] No pool configurations provided to fetch states for.');
            return {};
        }

        logger.info(`[Scanner] Fetching live states for ${poolInfos.length} configured pools...`);
        const statePromises = [];
        const validPoolConfigs = [];

        for (const poolInfo of poolInfos) {
            if (!poolInfo || !poolInfo.address || poolInfo.address === ethers.ZeroAddress) {
                logger.warn(`[Scanner] Skipping invalid pool config:`, poolInfo);
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
                validPoolConfigs.push(poolInfo);
            } catch (error) {
                handleError(error, `PoolScanner._getPoolContract (${poolInfo.address})`);
                 logger.warn(`[Scanner] Error preparing fetch for pool ${poolInfo.address}. Skipping.`);
            }
        }

        if (statePromises.length === 0) {
            logger.warn('[Scanner] No valid pools to fetch states for after initial validation.');
            return {};
        }

        const livePoolStates = {};
        try {
            const results = await Promise.all(statePromises);

            for (const stateResult of results) {
                 const { poolInfo, slot0Result, liquidityResult } = stateResult;
                 const address = poolInfo.address;

                if (slot0Result.status !== 'fulfilled' || liquidityResult.status !== 'fulfilled') {
                    const reason = slot0Result.reason?.message || liquidityResult.reason?.message || 'Unknown RPC/Contract Error';
                    logger.warn(`[Scanner] Pool ${address} (Group: ${poolInfo.groupName}, Fee: ${poolInfo.feeBps}bps) Fetch FAIL: ${reason}`);
                    continue;
                }

                const slot0 = slot0Result.value;
                const liquidity = liquidityResult.value;

                if (slot0 == null || typeof slot0.sqrtPriceX96 === 'undefined' || typeof slot0.tick === 'undefined' || liquidity == null || liquidity > MAX_UINT128) {
                    logger.warn(`[Scanner] Pool ${address} (Group: ${poolInfo.groupName}, Fee: ${poolInfo.feeBps}bps) Invalid State Data: SqrtPrice=${slot0?.sqrtPriceX96}, Tick=${slot0?.tick}, Liquidity=${liquidity}`);
                    continue;
                }

                const groupConfig = this.config.POOL_GROUPS.find(g => g.name === poolInfo.groupName);
                if (!groupConfig || !groupConfig.sdkToken0 || !groupConfig.sdkToken1) {
                    logger.error(`[Scanner] Internal Error: Could not find group config or SDK tokens for group ${poolInfo.groupName}. Skipping pool ${address}`);
                    continue;
                }

                try {
                    const tickCurrent = Number(slot0.tick);
                    const sqrtPriceX96 = slot0.sqrtPriceX96;
                    // --- *** CALCULATE AND ADD TICK SPACING *** ---
                    const tickSpacing = getTickSpacingFromFeeBps(poolInfo.feeBps);
                    // --- *** ---

                    // Create SDK Pool object - Pass tickSpacing to constructor
                    const sdkPool = new Pool(
                        groupConfig.sdkToken0,
                        groupConfig.sdkToken1,
                        poolInfo.feeBps,
                        sqrtPriceX96.toString(),
                        liquidity.toString(),
                        tickCurrent,
                        // Note: TickListDataProvider is not needed for basic Pool object creation,
                        // it's used later for simulation if necessary
                        undefined, // placeholder for tickDataProvider if constructor requires it (older SDK?)
                        tickSpacing // Pass tickSpacing if required by constructor
                    );

                    livePoolStates[address] = {
                        ...poolInfo, // address, feeBps, groupName
                        sdkPool: sdkPool, // Store the created SDK Pool object (might not be needed if re-created in simulator)
                        tick: tickCurrent,
                        liquidity: liquidity,
                        sqrtPriceX96: sqrtPriceX96,
                        tickSpacing: tickSpacing, // <<<--- ADDED tickSpacing
                        sdkToken0: groupConfig.sdkToken0,
                        sdkToken1: groupConfig.sdkToken1,
                    };

                } catch (sdkError) {
                     handleError(sdkError, `PoolScanner.CreateSDKPool (${address})`);
                     logger.warn(`[Scanner] Pool ${address} SDK Pool Creation Error: ${sdkError.message}`);
                }
            } // End processing results

        } catch (error) {
            handleError(error, 'PoolScanner.fetchPoolStates');
             logger.error(`[Scanner] CRITICAL Error fetching pool states: ${error.message}`);
             return {};
        }

        logger.log(`[Scanner] Successfully fetched and processed states for ${Object.keys(livePoolStates).length} pools.`);
        return livePoolStates;
    }

     findOpportunities(livePoolStates) {
         const opportunities = [];
         if (!livePoolStates || Object.keys(livePoolStates).length < 2) {
              logger.debug('[Scanner] Not enough live pool states to find opportunities.');
              return opportunities;
         }
         logger.log('[Scanner] Scanning for price discrepancies and checking liquidity...');
         const poolsByGroup = {};
         for (const poolAddress in livePoolStates) {
             const poolData = livePoolStates[poolAddress];
             if (!poolsByGroup[poolData.groupName]) { poolsByGroup[poolData.groupName] = []; }
             poolsByGroup[poolData.groupName].push(poolData);
         }

         for (const groupName in poolsByGroup) {
             const poolsInGroup = poolsByGroup[groupName];
             if (poolsInGroup.length < 2) { continue; }

             logger.debug(`[Scanner] Comparing ${poolsInGroup.length} pools in group ${groupName}...`);
             const groupConfig = this.config.POOL_GROUPS.find(g => g.name === groupName);
             if (!groupConfig || !groupConfig.sdkBorrowToken) { logger.error(`[Scanner] Internal Error: Missing group config or borrow token for ${groupName}.`); continue; }
             const groupLiqThresholds = this.config.MIN_LIQUIDITY_REQUIREMENTS?.[groupName];
             const minRawLiquidity = groupLiqThresholds?.MIN_RAW_LIQUIDITY || 0n;

             for (let i = 0; i < poolsInGroup.length; i++) {
                 for (let j = i + 1; j < poolsInGroup.length; j++) {
                     const livePool1 = poolsInGroup[i];
                     const livePool2 = poolsInGroup[j];
                     const tick1 = livePool1.tick;
                     const tick2 = livePool2.tick;
                     const TICK_DIFF_THRESHOLD = 1;
                     let startPoolLive = null, swapPoolLive = null;
                     if (tick2 > tick1 + TICK_DIFF_THRESHOLD) { startPoolLive = livePool1; swapPoolLive = livePool2; }
                     else if (tick1 > tick2 + TICK_DIFF_THRESHOLD) { startPoolLive = livePool2; swapPoolLive = livePool1; }
                     else { continue; }

                     if (minRawLiquidity > 0n && swapPoolLive.liquidity < minRawLiquidity) {
                         logger.debug(`[Scanner] Skipping ${startPoolLive.feeBps}bps -> ${swapPoolLive.feeBps}bps: Swap pool liquidity (${swapPoolLive.liquidity}) below threshold.`);
                         continue;
                     }

                     let sdkIntermediateToken;
                     if (groupConfig.sdkBorrowToken.equals(livePool1.sdkToken0)) { sdkIntermediateToken = livePool1.sdkToken1; }
                     else if (groupConfig.sdkBorrowToken.equals(livePool1.sdkToken1)) { sdkIntermediateToken = livePool1.sdkToken0; }
                     else { logger.error(`[Scanner] Config Error: Borrow token mismatch in group ${groupName}.`); continue; }

                     logger.log(`[Scanner] Potential Opportunity Found (Passed Liq Check): Group ${groupName}, Borrow ${groupConfig.sdkBorrowToken.symbol} from ${startPoolLive.feeBps}bps -> Swap on ${swapPoolLive.feeBps}bps`);
                     // Pass the full live state objects which now include tickSpacing
                     const opportunity = {
                         groupName: groupName,
                         startPoolInfo: startPoolLive, // Includes tick, liquidity, sqrtPriceX96, feeBps, tickSpacing, sdkTokens
                         swapPoolInfo: swapPoolLive,   // Includes tick, liquidity, sqrtPriceX96, feeBps, tickSpacing, sdkTokens
                         sdkTokenBorrowed: groupConfig.sdkBorrowToken,
                         sdkTokenIntermediate: sdkIntermediateToken,
                         borrowAmount: groupConfig.borrowAmount,
                     };
                     opportunities.push(opportunity);
                 }
             }
         }
        logger.log(`[Scanner] Found ${opportunities.length} potential opportunities (after liquidity checks).`);
        return opportunities;
     }
}

// Export the class directly if bot.js uses { PoolScanner } = require(...)
// Or export as property if bot.js uses const PoolScanner = require(...).PoolScanner
module.exports = { PoolScanner }; // Matching export from earlier analysis
