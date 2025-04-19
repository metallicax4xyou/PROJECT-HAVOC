// /workspaces/arbitrum-flash/core/poolScanner.js
const { ethers } = require('ethers');
const { Token } = require('@uniswap/sdk-core');
const { ABIS } = require('../constants/abis');
const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler');
const { TOKENS } = require('../constants/tokens');
// --- Import Helpers ---
const {
    getTickSpacingFromFeeBps,
    getScaledPriceRatio,
    formatScaledBigIntForLogging
} = require('./scannerUtils'); // Import from the new utility file

const MAX_UINT128 = (1n << 128n) - 1n;

// --- Configuration ---
const BIGNUM_SCALE_DECIMALS = 36; // Keep scale defined here for calculations
const BIGNUM_SCALE = 10n ** BigInt(BIGNUM_SCALE_DECIMALS);
const PROFIT_THRESHOLD_SCALED = (10005n * BIGNUM_SCALE) / 10000n; // 1.0005 scaled
const LOG_ALL_TRIANGLES = true; // Keep true for debugging


class PoolScanner {
    // --- Constructor ---
    constructor(config, provider) {
        logger.debug(`[Scanner Constructor] Initializing...`);
        if (!config || !provider) {
            const errMsg = 'PoolScanner requires config and provider.';
            if (typeof handleError === 'function') handleError(new Error(errMsg), 'ScannerInit'); else console.error(errMsg);
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
        const lowerCaseAddress = poolAddress.toLowerCase();
        if (!this.poolContractCache[lowerCaseAddress]) {
            try {
                if (!ABIS || !ABIS.UniswapV3Pool) { throw new Error("UniswapV3Pool ABI not found in constants/abis."); }
                this.poolContractCache[lowerCaseAddress] = new ethers.Contract(
                    poolAddress, ABIS.UniswapV3Pool, this.provider
                );
            } catch (error) {
                 logger.error(`[Scanner _getPoolContract] Error creating contract instance for ${poolAddress}: ${error.message}`);
                 if (typeof handleError === 'function') handleError(error, `PoolScanner._getPoolContract (${poolAddress})`);
                 throw error;
            }
        }
        return this.poolContractCache[lowerCaseAddress];
    }

    // --- fetchPoolStates ---
    async fetchPoolStates(poolInfos) {
        logger.debug(`[Scanner fetchPoolStates] Received ${poolInfos?.length ?? 0} poolInfos to fetch.`);
        if (!poolInfos || poolInfos.length === 0) {
            logger.warn('[Scanner fetchPoolStates] No pool configurations provided.'); return {};
        }
        logger.info(`[Scanner] Fetching live states for ${poolInfos.length} configured pools...`);

        const statePromises = [];
        const validPoolConfigsForStateFetch = [];

        for (const poolInfo of poolInfos) {
            if (!poolInfo || !poolInfo.address || !ethers.isAddress(poolInfo.address) || poolInfo.address === ethers.ZeroAddress || typeof poolInfo.fee !== 'number') {
                logger.warn(`[Scanner fetchPoolStates] Skipping invalid poolInfo: ${JSON.stringify(poolInfo)}`); continue;
            }
            try {
                const poolContract = this._getPoolContract(poolInfo.address);
                statePromises.push(
                    Promise.allSettled([
                        poolContract.slot0({ blockTag: 'latest' }),
                        poolContract.liquidity({ blockTag: 'latest' })
                    ]).then(results => ({ poolInfo, slot0Result: results[0], liquidityResult: results[1] }))
                );
                validPoolConfigsForStateFetch.push(poolInfo);
            } catch (error) {
                logger.error(`[Scanner fetchPoolStates] Error preparing fetch for pool ${poolInfo.address}: ${error.message}`);
            }
        }

        if (statePromises.length === 0) { logger.warn('[Scanner fetchPoolStates] No valid pools to fetch states for.'); return {}; }

        const livePoolStates = {};
        try {
            const results = await Promise.all(statePromises);
            for (const stateResult of results) {
                const { poolInfo, slot0Result, liquidityResult } = stateResult;
                const address = poolInfo.address;
                if (slot0Result.status !== 'fulfilled' || liquidityResult.status !== 'fulfilled') {
                    const reason = slot0Result.reason?.message || liquidityResult.reason?.message || 'Unknown Error';
                    logger.warn(`[Scanner] Pool ${address} (Fee: ${poolInfo.fee}bps) State Fetch FAIL: ${reason}`); continue;
                }
                const slot0 = slot0Result.value; const liquidity = liquidityResult.value;
                if (slot0 == null || typeof slot0.sqrtPriceX96 === 'undefined' || typeof slot0.tick === 'undefined' || liquidity == null) {
                    logger.warn(`[Scanner] Pool ${address} (Fee: ${poolInfo.fee}bps) Invalid State Data.`); continue;
                }
                 const currentSqrtPriceX96 = BigInt(slot0.sqrtPriceX96);
                 const currentLiquidity = BigInt(liquidity);
                 const currentTick = BigInt(slot0.tick);
                 if (currentLiquidity > MAX_UINT128) {
                      logger.warn(`[Scanner] Pool ${address} (Fee: ${poolInfo.fee}bps) Liquidity > MAX_UINT128.`); continue;
                 }
                const token0 = TOKENS[poolInfo.token0Symbol]; const token1 = TOKENS[poolInfo.token1Symbol];
                if (!(token0 instanceof Token) || !(token1 instanceof Token)) {
                    logger.error(`[Scanner] Internal Error: Could not resolve SDK Tokens for pool ${address}.`); continue;
                }
                 try {
                    livePoolStates[address.toLowerCase()] = {
                        address: address, fee: poolInfo.fee, tick: currentTick,
                        liquidity: currentLiquidity, sqrtPriceX96: currentSqrtPriceX96,
                        tickSpacing: getTickSpacingFromFeeBps(poolInfo.fee),
                        token0: token0, token1: token1,
                        token0Symbol: poolInfo.token0Symbol, token1Symbol: poolInfo.token1Symbol,
                        groupName: poolInfo.groupName || 'N/A',
                    };
                 } catch (sdkError) {
                      logger.error(`[Scanner] Pool ${address} Error creating state object: ${sdkError.message}`);
                      if (typeof handleError === 'function') handleError(sdkError, `PoolScanner.CreatePoolStateObject (${address})`);
                 }
            }
        } catch (error) {
            logger.error(`[Scanner fetchPoolStates] CRITICAL Error processing pool states: ${error.message}`);
            if (typeof handleError === 'function') handleError(error, 'PoolScanner.fetchPoolStates'); return {};
        }
        const finalCount = Object.keys(livePoolStates).length;
        logger.info(`[Scanner] Successfully fetched and processed states for ${finalCount} pools.`);
        if(finalCount === 0 && validPoolConfigsForStateFetch.length > 0) { logger.warn(`[Scanner] Fetched 0 valid states despite attempting ${validPoolConfigsForStateFetch.length}.`); }
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

         // Build Token Graph
         const tokenGraph = {};
         if (LOG_ALL_TRIANGLES) logger.debug('[Scanner] Building token graph...');
         for (const poolAddress in livePoolStatesMap) {
             const poolState = livePoolStatesMap[poolAddress];
             if (!poolState?.token0Symbol || !poolState?.token1Symbol || !poolState?.sqrtPriceX96) continue;
             const sym0 = poolState.token0Symbol; const sym1 = poolState.token1Symbol;
             if (!tokenGraph[sym0]) tokenGraph[sym0] = {}; if (!tokenGraph[sym0][sym1]) tokenGraph[sym0][sym1] = []; tokenGraph[sym0][sym1].push(poolState);
             if (!tokenGraph[sym1]) tokenGraph[sym1] = {}; if (!tokenGraph[sym1][sym0]) tokenGraph[sym1][sym0] = []; tokenGraph[sym1][sym0].push(poolState);
         }
         if (LOG_ALL_TRIANGLES) logger.debug(`[Scanner] Token graph built. Tokens: ${Object.keys(tokenGraph).join(', ')}`);

         // Triangle Detection
         logger.debug(`[Scanner] Starting triangle detection (BigInt)...`);
         const checkedTriangles = new Set();

         for (const tokenASymbol in tokenGraph) {
             for (const tokenBSymbol in tokenGraph[tokenASymbol]) {
                 for (const poolAB of tokenGraph[tokenASymbol][tokenBSymbol]) {
                     if (!poolAB?.sqrtPriceX96 || !tokenGraph[tokenBSymbol]) continue;
                     for (const tokenCSymbol in tokenGraph[tokenBSymbol]) {
                         if (tokenCSymbol === tokenASymbol) continue;
                         for (const poolBC of tokenGraph[tokenBSymbol][tokenCSymbol]) {
                              if (!poolBC?.sqrtPriceX96 || !tokenGraph[tokenCSymbol]?.[tokenASymbol]) continue;
                              for (const poolCA of tokenGraph[tokenCSymbol][tokenASymbol]) {
                                     if (!poolCA?.sqrtPriceX96) continue;
                                     const pools = [poolAB, poolBC, poolCA];
                                     const triangleId = pools.map(p => p.address).sort().join('-');
                                     if (checkedTriangles.has(triangleId)) continue;
                                     checkedTriangles.add(triangleId);
                                     const pathSymbols = [tokenASymbol, tokenBSymbol, tokenCSymbol, tokenASymbol];
                                     const pathPools = pools.map(p=>p.address); const pathFees = pools.map(p=>p.fee);
                                     if (LOG_ALL_TRIANGLES) logger.debug(`--- Checking Triangle: ${pathSymbols.join('->')} Fees: ${pathFees.join(',')} ---`);

                                     try {
                                         // --- Use imported helper --- Pass BIGNUM_SCALE ---
                                         const priceRatioAB_scaled = getScaledPriceRatio(poolAB.sqrtPriceX96, BIGNUM_SCALE);
                                         const priceRatioBC_scaled = getScaledPriceRatio(poolBC.sqrtPriceX96, BIGNUM_SCALE);
                                         const priceRatioCA_scaled = getScaledPriceRatio(poolCA.sqrtPriceX96, BIGNUM_SCALE);
                                         if (priceRatioAB_scaled === null || priceRatioBC_scaled === null || priceRatioCA_scaled === null) {
                                             logger.warn(`[Scanner] Skipping ${triangleId}: PriceRatio calculation error.`); continue;
                                         }

                                         let scaledPrice_AtoB, scaledPrice_BtoC, scaledPrice_CtoA;
                                         // Calculation logic using priceRatio*_scaled... (same as before)
                                         // Price A -> B
                                         const decimals_T0_AB = BigInt(poolAB.token0.decimals); const decimals_T1_AB = BigInt(poolAB.token1.decimals); const decimalDiff_AB = decimals_T1_AB - decimals_T0_AB;
                                         const price_T1T0_adj_scaled_AB = decimalDiff_AB >= 0n ? priceRatioAB_scaled * (10n ** decimalDiff_AB) : priceRatioAB_scaled / (10n ** (-decimalDiff_AB));
                                         if (poolAB.token0Symbol === tokenASymbol) { scaledPrice_AtoB = price_T1T0_adj_scaled_AB; }
                                         else { if (price_T1T0_adj_scaled_AB === 0n) throw new Error('Zero adjusted price A->B'); scaledPrice_AtoB = (BIGNUM_SCALE * BIGNUM_SCALE) / price_T1T0_adj_scaled_AB; }
                                         // Price B -> C
                                         const decimals_T0_BC = BigInt(poolBC.token0.decimals); const decimals_T1_BC = BigInt(poolBC.token1.decimals); const decimalDiff_BC = decimals_T1_BC - decimals_T0_BC;
                                         const price_T1T0_adj_scaled_BC = decimalDiff_BC >= 0n ? priceRatioBC_scaled * (10n ** decimalDiff_BC) : priceRatioBC_scaled / (10n ** (-decimalDiff_BC));
                                         if (poolBC.token0Symbol === tokenBSymbol) { scaledPrice_BtoC = price_T1T0_adj_scaled_BC; }
                                         else { if (price_T1T0_adj_scaled_BC === 0n) throw new Error('Zero adjusted price B->C'); scaledPrice_BtoC = (BIGNUM_SCALE * BIGNUM_SCALE) / price_T1T0_adj_scaled_BC; }
                                         // Price C -> A
                                         const decimals_T0_CA = BigInt(poolCA.token0.decimals); const decimals_T1_CA = BigInt(poolCA.token1.decimals); const decimalDiff_CA = decimals_T1_CA - decimals_T0_CA;
                                         const price_T1T0_adj_scaled_CA = decimalDiff_CA >= 0n ? priceRatioCA_scaled * (10n ** decimalDiff_CA) : priceRatioCA_scaled / (10n ** (-decimalDiff_CA));
                                         if (poolCA.token0Symbol === tokenCSymbol) { scaledPrice_CtoA = price_T1T0_adj_scaled_CA; }
                                         else { if (price_T1T0_adj_scaled_CA === 0n) throw new Error('Zero adjusted price C->A'); scaledPrice_CtoA = (BIGNUM_SCALE * BIGNUM_SCALE) / price_T1T0_adj_scaled_CA; }

                                         // Raw Rate & Fee Multiplier (same as before)
                                         const rawRate_scaled = (scaledPrice_AtoB * scaledPrice_BtoC * scaledPrice_CtoA) / (BIGNUM_SCALE * BIGNUM_SCALE);
                                         const feeAB_bps = BigInt(poolAB.fee); const feeBC_bps = BigInt(poolBC.fee); const feeCA_bps = BigInt(poolCA.fee); const TEN_THOUSAND = 10000n;
                                         const feeNum_scaled = (TEN_THOUSAND - feeAB_bps) * (TEN_THOUSAND - feeBC_bps) * (TEN_THOUSAND - feeCA_bps) * BIGNUM_SCALE;
                                         const feeDenom = TEN_THOUSAND * TEN_THOUSAND * TEN_THOUSAND;
                                         const feeMultiplier_scaled = feeDenom > 0n ? feeNum_scaled / feeDenom : 0n;
                                         const rateWithFees_scaled = (rawRate_scaled * feeMultiplier_scaled) / BIGNUM_SCALE;

                                         // --- Use imported helper for logging ---
                                         if (LOG_ALL_TRIANGLES) {
                                             logger.debug(`  Raw Rate: ${formatScaledBigIntForLogging(rawRate_scaled)}`);
                                             logger.debug(`  Fee Mult: ${formatScaledBigIntForLogging(feeMultiplier_scaled)}`);
                                             logger.debug(`  Est Rate: ${formatScaledBigIntForLogging(rateWithFees_scaled)}`);
                                         }

                                         // Profitability Check & Opportunity Creation (same as before)
                                         if (rateWithFees_scaled > PROFIT_THRESHOLD_SCALED) {
                                             logger.info(`[Scanner] >>> POTENTIAL TRIANGULAR OPPORTUNITY FOUND <<<`);
                                             logger.info(`  Path: ${pathSymbols.join(' -> ')} Pools: ${pathPools.join(' -> ')} Fees: ${pathFees.join(' -> ')}`);
                                             logger.info(`  Est Rate: ${formatScaledBigIntForLogging(rateWithFees_scaled)} > Threshold: ${formatScaledBigIntForLogging(PROFIT_THRESHOLD_SCALED)}`);
                                             const opportunity = {
                                                 type: 'triangular', pathSymbols: pathSymbols,
                                                 pools: [poolAB, poolBC, poolCA], // Pass full state objects
                                                 estimatedRate: rateWithFees_scaled.toString(),
                                                 rawRate: rawRate_scaled.toString(),
                                                 groupName: poolAB.groupName || 'N/A'
                                             };
                                             opportunities.push(opportunity);
                                         }
                                     } catch (error) {
                                         logger.error(`[Scanner] Error calc rates for ${triangleId}: ${error.message}`);
                                         if (typeof handleError === 'function') handleError(error, `Triangle Calc ${triangleId}`);
                                     }
                                 } // end poolCA loop
                             } // end poolBC loop
                         } // end tokenCSymbol loop
                     } // end poolAB loop
                 } // end tokenBSymbol loop
             } // end tokenASymbol loop
         logger.info(`[Scanner] Scan finished. Found ${opportunities.length} potential opportunities meeting threshold.`);
         return opportunities;
     } // --- END findOpportunities ---

} // --- END PoolScanner Class ---

module.exports = { PoolScanner }; // Export the class
