// /workspaces/arbitrum-flash/core/poolScanner.js
const { ethers } = require('ethers'); // Keep ethers for constants like ZeroAddress if needed, but remove FixedNumber
const { Token } = require('@uniswap/sdk-core');
const { ABIS } = require('../constants/abis');
const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler');
// Removed getPoolInfo require (redundant)
const { TOKENS } = require('../constants/tokens'); // Use the SDK Token objects directly

const MAX_UINT128 = (1n << 128n) - 1n;
const Q96 = 1n << 96n;
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
    if (sqrtPriceX96 === 0n) return 0n; // Avoid division by zero if Q192 is used incorrectly below, though it shouldn't be 0
    if (Q192 === 0n) { // Safety check, should never happen with constants defined above
        logger.error("[getScaledPriceRatio] Q192 constant is zero!");
        return null;
    }
    try {
        // Calculate numerator = (sqrtPriceX96^2) * SCALE
        // Perform multiplication before division to maintain precision
        const sqrtP_squared = sqrtPriceX96 * sqrtPriceX96;
        const numerator = sqrtP_squared * BIGNUM_SCALE;

        // Calculate priceRatioScaled = numerator / Q192
        const priceRatioScaled = numerator / Q192;
        return priceRatioScaled;
    } catch (error) {
        // Catch potential BigInt errors (e.g., overflow if sqrtPriceX96 is absurdly large, though unlikely)
        logger.error(`[getScaledPriceRatio] Error calculating scaled price ratio: ${error.message} for sqrtP=${sqrtPriceX96}`);
        return null;
    }
}


// --- Helper to format scaled BigInt for logging (Safer) ---
function formatScaledBigIntForLogging(scaledValue, scaleDecimals = BIGNUM_SCALE_DECIMALS, displayDecimals = 8) {
    if (typeof scaledValue !== 'bigint') return 'N/A';
    try {
        const scaleFactor = 10n ** BigInt(scaleDecimals);
        if (scaleFactor === 0n) return scaledValue.toString() + ' (Scale Factor Zero)'; // Avoid division by zero

        const isNegative = scaledValue < 0n;
        const absValue = isNegative ? -scaledValue : scaledValue;

        const integerPart = absValue / scaleFactor;
        const fractionalPart = absValue % scaleFactor;

        // Pad fractional part with leading zeros if needed
        const fractionalString = fractionalPart.toString().padStart(scaleDecimals, '0');
        // Slice to the desired number of display decimals
        const displayFractional = fractionalString.slice(0, displayDecimals);

        return `${isNegative ? '-' : ''}${integerPart}.${displayFractional}`;
    } catch (e) {
        logger.error(`Error formatting BigInt ${scaledValue} for logging: ${e.message}`);
        // Fallback to raw string representation with scale info
        return scaledValue.toString() + ` (Scale ${scaleDecimals})`;
    }
}


class PoolScanner {
    // --- Constructor ---
    constructor(config, provider) {
        logger.debug(`[Scanner Constructor] Initializing...`);
        if (!config || !provider) {
            const errMsg = 'PoolScanner requires config and provider.';
            // Use handleError if available, otherwise console.error
            if (typeof handleError === 'function') handleError(new Error(errMsg), 'ScannerInit'); else console.error(errMsg);
            throw new ArbitrageError(errMsg, 'INITIALIZATION_ERROR');
        }
        this.config = config;
        this.provider = provider;
        this.poolContractCache = {}; // Cache for ethers.Contract instances
        logger.debug(`[Scanner Constructor] Config object received keys: ${Object.keys(config || {}).join(', ')}`);
        logger.info(`[Scanner] Initialized.`);
    }

    // --- _getPoolContract ---
    _getPoolContract(poolAddress) {
        const lowerCaseAddress = poolAddress.toLowerCase();
        if (!this.poolContractCache[lowerCaseAddress]) {
            try {
                // Ensure ABIS and the specific ABI are loaded correctly
                if (!ABIS || !ABIS.UniswapV3Pool) { throw new Error("UniswapV3Pool ABI not found in constants/abis."); }
                this.poolContractCache[lowerCaseAddress] = new ethers.Contract(
                    poolAddress, // Use original casing for contract constructor
                    ABIS.UniswapV3Pool,
                    this.provider
                );
            } catch (error) {
                 logger.error(`[Scanner _getPoolContract] Error creating contract instance for ${poolAddress}: ${error.message}`);
                 if (typeof handleError === 'function') handleError(error, `PoolScanner._getPoolContract (${poolAddress})`);
                 // Re-throw the error to prevent proceeding with an invalid contract instance
                 throw error;
            }
        }
        return this.poolContractCache[lowerCaseAddress];
    }

    // --- fetchPoolStates ---
    // Fetches slot0 and liquidity for a list of pool configurations
    async fetchPoolStates(poolInfos) {
        logger.debug(`[Scanner fetchPoolStates] Received ${poolInfos?.length ?? 0} poolInfos to fetch.`);
        if (!poolInfos || poolInfos.length === 0) {
            logger.warn('[Scanner fetchPoolStates] No pool configurations provided. Cannot fetch states.');
            return {}; // Return empty map if no pools to check
        }
        logger.info(`[Scanner] Fetching live states for ${poolInfos.length} configured pools...`);

        const statePromises = [];
        const validPoolConfigsForStateFetch = []; // Keep track of configs we attempt to fetch

        for (const poolInfo of poolInfos) {
            // Validate basic poolInfo structure needed for fetching
            if (!poolInfo || !poolInfo.address || !ethers.isAddress(poolInfo.address) || poolInfo.address === ethers.ZeroAddress || typeof poolInfo.fee !== 'number') {
                logger.warn(`[Scanner fetchPoolStates] Skipping invalid poolInfo: ${JSON.stringify(poolInfo)}`);
                continue; // Skip this invalid config
            }

            try {
                const poolContract = this._getPoolContract(poolInfo.address);
                // Fetch slot0 and liquidity using Promise.allSettled for resilience
                statePromises.push(
                    Promise.allSettled([
                        poolContract.slot0({ blockTag: 'latest' }),
                        poolContract.liquidity({ blockTag: 'latest' })
                    ]).then(results => ({
                        poolInfo, // Pass the original config through
                        slot0Result: results[0],
                        liquidityResult: results[1]
                    }))
                );
                validPoolConfigsForStateFetch.push(poolInfo); // Mark as attempted
            } catch (error) {
                // Error likely from _getPoolContract (e.g., invalid ABI)
                logger.error(`[Scanner fetchPoolStates] Error preparing fetch for pool ${poolInfo.address}: ${error.message}`);
                // Do not add to statePromises if contract instantiation failed
            }
        }

        if (statePromises.length === 0) {
            logger.warn('[Scanner fetchPoolStates] No valid pools to fetch states for after preparation.');
            return {};
        }

        const livePoolStates = {}; // Map: poolAddress -> poolState object

        try {
            const results = await Promise.all(statePromises); // Wait for all fetches to settle

            for (const stateResult of results) {
                const { poolInfo, slot0Result, liquidityResult } = stateResult;
                const address = poolInfo.address; // Use address from original config

                // Check if fetches were successful
                if (slot0Result.status !== 'fulfilled' || liquidityResult.status !== 'fulfilled') {
                    const reason = slot0Result.reason?.message || liquidityResult.reason?.message || 'Unknown RPC/Contract Error';
                    logger.warn(`[Scanner] Pool ${address} (Fee: ${poolInfo.fee}bps) State Fetch FAIL: ${reason}`);
                    continue; // Skip processing this pool
                }

                const slot0 = slot0Result.value;
                const liquidity = liquidityResult.value;

                // Validate the structure of returned data
                if (slot0 == null || typeof slot0.sqrtPriceX96 === 'undefined' || typeof slot0.tick === 'undefined' || liquidity == null) {
                    logger.warn(`[Scanner] Pool ${address} (Fee: ${poolInfo.fee}bps) Invalid State Data: SqrtPrice=${slot0?.sqrtPriceX96}, Tick=${slot0?.tick}, Liquidity=${liquidity}`);
                    continue; // Skip processing this pool
                }

                 // Convert results to BigInt
                 const currentSqrtPriceX96 = BigInt(slot0.sqrtPriceX96);
                 const currentLiquidity = BigInt(liquidity);
                 const currentTick = BigInt(slot0.tick); // Keep tick as BigInt initially

                 // Check for invalid liquidity value
                 if (currentLiquidity > MAX_UINT128) {
                      logger.warn(`[Scanner] Pool ${address} (Fee: ${poolInfo.fee}bps) Liquidity value > MAX_UINT128 (${currentLiquidity}). Skipping.`);
                      continue; // Skip pools with invalid liquidity
                 }

                // Get SDK Token instances using symbols from poolInfo and the global TOKENS map
                const token0 = TOKENS[poolInfo.token0Symbol];
                const token1 = TOKENS[poolInfo.token1Symbol];

                // Ensure we got valid SDK Token instances
                if (!(token0 instanceof Token) || !(token1 instanceof Token)) {
                    logger.error(`[Scanner] Internal Error: Could not resolve SDK Token instances for pool ${address} (${poolInfo.token0Symbol}/${poolInfo.token1Symbol}). Check constants/tokens.js.`);
                    continue; // Skip if tokens are invalid
                }

                // Build the pool state object
                 try {
                    livePoolStates[address.toLowerCase()] = { // Use lowercase address as key for consistency
                        address: address, // Keep original casing for reference
                        fee: poolInfo.fee,
                        tick: currentTick, // Store as BigInt
                        liquidity: currentLiquidity,
                        sqrtPriceX96: currentSqrtPriceX96,
                        tickSpacing: getTickSpacingFromFeeBps(poolInfo.fee), // Calculate tick spacing
                        token0: token0, // Store SDK Token instance
                        token1: token1, // Store SDK Token instance
                        token0Symbol: poolInfo.token0Symbol, // Store symbol for convenience
                        token1Symbol: poolInfo.token1Symbol, // Store symbol for convenience
                    };
                 } catch (sdkError) { // Catch potential errors during state object creation (less likely here)
                      logger.error(`[Scanner fetchPoolStates] Pool ${address} Error creating state object: ${sdkError.message}`);
                      if (typeof handleError === 'function') handleError(sdkError, `PoolScanner.CreatePoolStateObject (${address})`);
                 }
            }
        } catch (error) {
            // Catch errors from Promise.all (less likely with allSettled but possible)
            logger.error(`[Scanner fetchPoolStates] CRITICAL Error processing pool states: ${error.message}`);
            if (typeof handleError === 'function') handleError(error, 'PoolScanner.fetchPoolStates');
            return {}; // Return empty map on critical failure
        }

        const finalCount = Object.keys(livePoolStates).length;
        logger.info(`[Scanner] Successfully fetched and processed states for ${finalCount} pools.`);
        if(finalCount === 0 && validPoolConfigsForStateFetch.length > 0){
            logger.warn(`[Scanner] Fetched 0 valid states despite attempting ${validPoolConfigsForStateFetch.length} pools. Check RPC and pool addresses in .env.`);
        }
        return livePoolStates; // Return map of address -> state object
    }


     // --- REFACTORED findOpportunities (Pure BigInt Pipeline) ---
     findOpportunities(livePoolStatesMap) {
         logger.info(`[Scanner] Starting opportunity scan with ${Object.keys(livePoolStatesMap || {}).length} live pool states.`);
         const opportunities = [];
         if (!livePoolStatesMap || Object.keys(livePoolStatesMap).length < 3) {
              logger.info('[Scanner] Not enough live pool states (< 3) to form triangular path.');
              return opportunities; // Return empty array
         }

         // --- Step 1: Build Token Graph ---
         // Graph structure: { tokenSymbol: { otherTokenSymbol: [poolState1, poolState2, ...] } }
         const tokenGraph = {};
         if (LOG_ALL_TRIANGLES) logger.debug('[Scanner] Building token graph...');
         for (const poolAddress in livePoolStatesMap) {
             const poolState = livePoolStatesMap[poolAddress];
             // Basic validation of pool state needed for graph
             if (!poolState || !poolState.token0Symbol || !poolState.token1Symbol || !poolState.token0 || !poolState.token1 || !poolState.sqrtPriceX96) {
                 logger.warn(`[Scanner] Pool ${poolAddress} missing required state for graph build. Skipping.`);
                 continue;
             }
             const sym0 = poolState.token0Symbol;
             const sym1 = poolState.token1Symbol;

             // Add edge sym0 -> sym1
             if (!tokenGraph[sym0]) tokenGraph[sym0] = {};
             if (!tokenGraph[sym0][sym1]) tokenGraph[sym0][sym1] = [];
             tokenGraph[sym0][sym1].push(poolState);

             // Add edge sym1 -> sym0
             if (!tokenGraph[sym1]) tokenGraph[sym1] = {};
             if (!tokenGraph[sym1][sym0]) tokenGraph[sym1][sym0] = [];
             tokenGraph[sym1][sym0].push(poolState);
         }
         if (LOG_ALL_TRIANGLES) logger.debug(`[Scanner] Token graph built. Tokens with edges: ${Object.keys(tokenGraph).join(', ')}`);
         // --- End Step 1 ---

         // --- Step 2 & 3: Triangle Detection, BigInt Price Calculation & Profit Check ---
         logger.debug(`[Scanner] Starting triangle detection (BigInt) (Raw Rate Threshold: ~${formatScaledBigIntForLogging(PROFIT_THRESHOLD_SCALED)} after fees)...`);
         const checkedTriangles = new Set(); // Avoid checking the same set of 3 pools multiple times

         // Iterate through potential starting tokens (A)
         for (const tokenASymbol in tokenGraph) {
             // Iterate through potential intermediate tokens (B) connected to A
             for (const tokenBSymbol in tokenGraph[tokenASymbol]) {
                 // Iterate through pools connecting A and B
                 for (const poolAB of tokenGraph[tokenASymbol][tokenBSymbol]) {
                     // Ensure poolAB state is valid (redundant check, but safe)
                     if (!poolAB || !poolAB.sqrtPriceX96) { continue; }

                     // Check if B is connected to other tokens (C)
                     if (!tokenGraph[tokenBSymbol]) continue;

                     // Iterate through potential end tokens (C) connected to B
                     for (const tokenCSymbol in tokenGraph[tokenBSymbol]) {
                         // Skip if C is the same as A (we need a triangle)
                         if (tokenCSymbol === tokenASymbol) continue;

                         // Iterate through pools connecting B and C
                         for (const poolBC of tokenGraph[tokenBSymbol][tokenCSymbol]) {
                              if (!poolBC || !poolBC.sqrtPriceX96) { continue; }

                             // Check if C is connected back to A
                             if (tokenGraph[tokenCSymbol] && tokenGraph[tokenCSymbol][tokenASymbol]) {
                                 // Iterate through pools connecting C and A
                                 for (const poolCA of tokenGraph[tokenCSymbol][tokenASymbol]) {
                                     if (!poolCA || !poolCA.sqrtPriceX96) { continue; }

                                     // Found a potential triangle A -> B -> C -> A
                                     const pools = [poolAB, poolBC, poolCA];
                                     // Create a unique ID for this set of pools, independent of path direction
                                     const triangleId = pools.map(p => p.address).sort().join('-');
                                     if (checkedTriangles.has(triangleId)) { continue; } // Already checked this triangle
                                     checkedTriangles.add(triangleId);

                                     // Define the path symbols for clarity
                                     const pathSymbols = [tokenASymbol, tokenBSymbol, tokenCSymbol, tokenASymbol];
                                     const pathPools = [poolAB.address, poolBC.address, poolCA.address];
                                     const pathFees = [poolAB.fee, poolBC.fee, poolCA.fee];

                                     if (LOG_ALL_TRIANGLES) logger.debug(`--- Checking Triangle: ${pathSymbols.join(' -> ')} Pools: ${pathPools.join(' , ')} Fees: ${pathFees.join(', ')} ---`);

                                     try {
                                         // 1. Get Base Scaled Price Ratios (Token1/Token0) * SCALE for each pool
                                         const priceRatioAB_scaled = getScaledPriceRatio(poolAB.sqrtPriceX96);
                                         const priceRatioBC_scaled = getScaledPriceRatio(poolBC.sqrtPriceX96);
                                         const priceRatioCA_scaled = getScaledPriceRatio(poolCA.sqrtPriceX96);

                                         // Check for calculation errors
                                         if (priceRatioAB_scaled === null || priceRatioBC_scaled === null || priceRatioCA_scaled === null) {
                                             logger.warn(`[Scanner] Skipping triangle ${triangleId} due to PriceRatio calculation error.`);
                                             continue; // Skip this triangle if any price ratio failed
                                         }

                                         // 2. Adjust Ratios for Direction (A->B, B->C, C->A) and Decimals
                                         let scaledPrice_AtoB, scaledPrice_BtoC, scaledPrice_CtoA;

                                         // Price A -> B calculation
                                         const decimals_T0_AB = BigInt(poolAB.token0.decimals);
                                         const decimals_T1_AB = BigInt(poolAB.token1.decimals);
                
