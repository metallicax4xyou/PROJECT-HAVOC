// core/finders/spatialFinder.js
// --- VERSION v1.33 ---
// Reverted V3-only filter, restored default BIPS threshold.

const { ethers } = require('ethers');
const { formatUnits } = require('ethers'); // Added for logging convenience
const logger = require('../../utils/logger'); // Adjust path if needed
const { getCanonicalPairKey } = require('../../utils/pairUtils'); // Adjust path if needed
const { getUniV3Price, getV2Price, getDodoPrice, BIGNUMBER_1E18 } = require('../../utils/priceUtils'); // Adjust path if needed
const { TOKENS } = require('../../constants/tokens'); // Adjust path if needed

// --- Configuration ---
// *** RESTORED THRESHOLD - ADJUST AS NEEDED ***
// Minimum net difference (after fees) between the buy price on one pool
// and the sell price on another, expressed in basis points (1/100th of 1%).
// Example: 5n = 0.05% net profit margin required *before* gas costs.
const MIN_NET_PRICE_DIFFERENCE_BIPS = 5n; // Restore to your preferred value!
// *** --- ***
const MAX_REASONABLE_PRICE_DIFF_BIPS = 5000n; // 50% sanity check
const BASIS_POINTS_DENOMINATOR = 10000n;

// Simulation Input Amounts (Consider centralizing this in config/constants)
const SIMULATION_INPUT_AMOUNTS = {
    'USDC':   ethers.parseUnits('100', 6), 'USDC.e': ethers.parseUnits('100', 6),
    'USDT':   ethers.parseUnits('100', 6), 'DAI':    ethers.parseUnits('100', 18),
    'WETH':   ethers.parseUnits('0.1', 18), 'WBTC':   ethers.parseUnits('0.01', 8),
    // Add others as needed
};

class SpatialFinder {
    constructor(config) {
        // Store the main config object if needed for other thresholds later
        this.config = config; // Keep if MAIN_PROFIT_THRESHOLD etc. are needed here
        this.pairRegistry = new Map();
        logger.info(`[SpatialFinder v1.33] Initialized. Min Net BIPS Threshold: ${MIN_NET_PRICE_DIFFERENCE_BIPS}`);
    }

    updatePairRegistry(registry) {
        if (!registry || !(registry instanceof Map)) { logger.warn('[SF] Invalid registry update.'); return; }
        this.pairRegistry = registry;
        logger.debug(`[SF] Pair registry updated. Size: ${this.pairRegistry.size}`);
    }

    _calculatePrice(poolState) {
        const { dexType, token0, token1 } = poolState;
        if (!token0 || !token1) { logger.warn(`[SF._CalcPrice] Missing tokens ${poolState.address}`); return null; }
        try {
            switch (dexType?.toLowerCase()) {
                case 'uniswapv3':
                    if (poolState.sqrtPriceX96) { return getUniV3Price(poolState.sqrtPriceX96, token0, token1); }
                    break;
                case 'sushiswap': // Assuming V2 logic
                    if (poolState.reserve0 !== undefined && poolState.reserve1 !== undefined) {
                        if (poolState.reserve0 === 0n || poolState.reserve1 === 0n) return null; // Avoid division by zero
                        return getV2Price(poolState.reserve0, poolState.reserve1, token0, token1);
                    }
                    break;
                case 'dodo':
                    if (poolState.queryAmountOutWei !== undefined && poolState.queryBaseToken && poolState.queryQuoteToken) {
                        // DODO price logic needs careful handling based on which token is base/quote
                        const priceBaseInQuote = getDodoPrice(poolState.queryAmountOutWei, poolState.queryBaseToken, poolState.queryQuoteToken);
                        if (priceBaseInQuote === null) return null;
                        // We need the price of token0 in terms of token1 (like UniV3/V2)
                        // Check if pool's baseToken matches our token0
                        if (token0.address.toLowerCase() === poolState.queryBaseToken.address.toLowerCase()) {
                            return priceBaseInQuote; // Price is already token0 quoted in token1
                        } else {
                            // The pool's base is our token1, so we need the inverse price
                            if (priceBaseInQuote === 0n) return null; // Avoid division by zero
                            // Inverse: price(T0 in T1) = 1 / price(T1 in T0) -> Scaled: (1e18 * 1e18) / priceBaseInQuote
                            return (BIGNUMBER_1E18 * BIGNUMBER_1E18) / priceBaseInQuote;
                        }
                    }
                    break;
                 // Add Camelot fetcher case if/when integrated
                // case 'camelot':
                //     if (poolState.reserve0 !== undefined && poolState.reserve1 !== undefined) {
                //        // Assuming standard V2 logic for Camelot for now
                //        return getV2Price(poolState.reserve0, poolState.reserve1, token0, token1);
                //     }
                //     break;
                default:
                    logger.warn(`[SF._CalcPrice] Unknown or unsupported dexType for price calculation: ${dexType} for pool ${poolState.address}`);
            }
        } catch (error) { logger.error(`[SF._CalcPrice] Error calculating price for ${poolState.name || poolState.address}: ${error.message}`); }
        return null;
    }

    findArbitrage(poolStates) {
        logger.info(`[SpatialFinder] Finding spatial arbitrage from ${poolStates.length} pool states...`);
        const opportunities = [];
        if (poolStates.length < 2 || this.pairRegistry.size === 0) {
            logger.debug('[SF] Insufficient pool states or empty pair registry.');
            return opportunities;
        }

        const poolStateMap = new Map();
        poolStates.forEach(state => { if (state?.address) poolStateMap.set(state.address.toLowerCase(), state); });

        for (const [canonicalKey, poolAddressesSet] of this.pairRegistry.entries()) {
            // logger.debug(`[SF] Processing pair: ${canonicalKey}`); // Uncomment for deep debug
            if (poolAddressesSet.size < 2) continue; // Need at least two pools for the same pair

            const relevantPoolStates = [];
            poolAddressesSet.forEach(addr => {
                const state = poolStateMap.get(addr.toLowerCase());
                if (state) relevantPoolStates.push(state);
            });
            if (relevantPoolStates.length < 2) continue;

            // Calculate prices *once* per pool state in this cycle
            const poolsWithPrices = relevantPoolStates
                .map(pool => ({ ...pool, price0_1_scaled: this._calculatePrice(pool) }))
                .filter(p => p.price0_1_scaled !== null && p.price0_1_scaled > 0n); // Filter out pools where price calc failed or is zero

            if (poolsWithPrices.length < 2) continue; // Need at least two valid prices to compare

            // logger.debug(`[SF] Comparing ${poolsWithPrices.length} pools for pair ${canonicalKey}...`); // Uncomment for deep debug

            // Compare every pool with every other pool for the same pair
            for (let i = 0; i < poolsWithPrices.length; i++) {
                for (let j = i + 1; j < poolsWithPrices.length; j++) {
                    const poolA = poolsWithPrices[i];
                    const poolB = poolsWithPrices[j];

                    // Ensure tokens are valid before proceeding (should be guaranteed by registry, but belt-and-suspenders)
                    if (!poolA.token0 || !poolA.token1 || !poolB.token0 || !poolB.token1) {
                         logger.warn(`[SF] Missing token info during comparison: ${poolA.address} vs ${poolB.address}`);
                         continue;
                    }
                     // Ensure tokens match canonical key (should be guaranteed, but check)
                    if (poolA.token0.address !== poolB.token0.address || poolA.token1.address !== poolB.token1.address) {
                         logger.warn(`[SF] Token mismatch within canonical pair comparison: ${poolA.name} vs ${poolB.name}`);
                         continue;
                    }

                    const rawPriceA = poolA.price0_1_scaled; // Price of T0 in terms of T1 on Pool A
                    const rawPriceB = poolB.price0_1_scaled; // Price of T0 in terms of T1 on Pool B

                    // --- Sanity Check: Prevent huge unrealistic differences ---
                    const rawPriceDiff = rawPriceA > rawPriceB ? rawPriceA - rawPriceB : rawPriceB - rawPriceA;
                    const minRawPrice = rawPriceA < rawPriceB ? rawPriceA : rawPriceB;
                    if (minRawPrice === 0n) continue; // Avoid division by zero if a price somehow is zero
                    const rawDiffBips = (rawPriceDiff * BASIS_POINTS_DENOMINATOR) / minRawPrice;
                    if (rawDiffBips > MAX_REASONABLE_PRICE_DIFF_BIPS) {
                        // logger.warn(`[SF] Skipping implausible raw price diff > ${MAX_REASONABLE_PRICE_DIFF_BIPS} BIPS between ${poolA.name} (${formatUnits(rawPriceA, 18)}) and ${poolB.name} (${formatUnits(rawPriceB, 18)})`);
                        continue;
                    }

                    // --- Fee Adjustment ---
                    // Get fees - Use defaults if missing (though they should be fetched)
                    // Note: DODO fees are complex (base/quote side, taker/maker), using a placeholder for now. Needs refinement.
                    // Note: Sushi uses a standard 30 bips usually.
                    const feeA_bips = BigInt(poolA.fee ?? (poolA.dexType === 'sushiswap' ? 30 : (poolA.dexType === 'dodo' ? 30 : 30))); // Default 30 bips (0.3%) if fee missing/unexpected DEX
                    const feeB_bips = BigInt(poolB.fee ?? (poolB.dexType === 'sushiswap' ? 30 : (poolB.dexType === 'dodo' ? 30 : 30)));
                    const sellMultiplierA = BASIS_POINTS_DENOMINATOR - feeA_bips;
                    const sellMultiplierB = BASIS_POINTS_DENOMINATOR - feeB_bips;

                    // Effective price when SELLING token0 on each pool (receive token1)
                    const effectiveSellPriceA_0for1 = (rawPriceA * sellMultiplierA) / BASIS_POINTS_DENOMINATOR;
                    const effectiveSellPriceB_0for1 = (rawPriceB * sellMultiplierB) / BASIS_POINTS_DENOMINATOR;

                    // Opportunity: Buy T0 low on Pool X, Sell T0 high on Pool Y
                    // We need to compare the *effective sell price* on one pool against the *raw buy price* on the other.
                    // Buy T0 on A (means paying rawPriceA T1 per T0), Sell T0 on B (means receiving effectiveSellPriceB_0for1 T1 per T0)
                    // Profit if effectiveSellPriceB_0for1 > rawPriceA

                    // Buy T0 on B (means paying rawPriceB T1 per T0), Sell T0 on A (means receiving effectiveSellPriceA_0for1 T1 per T0)
                    // Profit if effectiveSellPriceA_0for1 > rawPriceB

                    let poolBuy = null; // Pool where we buy T0 (pay T1)
                    let poolSell = null; // Pool where we sell T0 (receive T1)
                    let netDiffBips = 0n; // Net difference in basis points
                    let buyToken0 = false; // Flag: are we buying token0 or token1 initially?

                    // Scenario 1: Buy T0 on A, Sell T0 on B
                    if (effectiveSellPriceB_0for1 > rawPriceA) {
                        netDiffBips = ((effectiveSellPriceB_0for1 - rawPriceA) * BASIS_POINTS_DENOMINATOR) / rawPriceA;
                        if (netDiffBips >= MIN_NET_PRICE_DIFFERENCE_BIPS) {
                            poolBuy = poolA;
                            poolSell = poolB;
                            buyToken0 = true; // We are buying token0 on poolBuy, selling on poolSell
                            // logger.debug(`[SF] Scenario 1 Check: effSellB=${formatUnits(effectiveSellPriceB_0for1, 18)} > rawBuyA=${formatUnits(rawPriceA, 18)}. Net Bips: ${netDiffBips}`);
                        }
                    }

                    // Scenario 2: Buy T0 on B, Sell T0 on A
                    if (!poolBuy && effectiveSellPriceA_0for1 > rawPriceB) { // Check only if Scenario 1 wasn't profitable
                        netDiffBips = ((effectiveSellPriceA_0for1 - rawPriceB) * BASIS_POINTS_DENOMINATOR) / rawPriceB;
                        if (netDiffBips >= MIN_NET_PRICE_DIFFERENCE_BIPS) {
                            poolBuy = poolB;
                            poolSell = poolA;
                            buyToken0 = true; // We are buying token0 on poolBuy, selling on poolSell
                             // logger.debug(`[SF] Scenario 2 Check: effSellA=${formatUnits(effectiveSellPriceA_0for1, 18)} > rawBuyB=${formatUnits(rawPriceB, 18)}. Net Bips: ${netDiffBips}`);
                        }
                    }

                    // If an opportunity to buy/sell T0 was found, create the opportunity object
                    if (poolBuy && poolSell) {
                        const t0Sym = poolA.token0.symbol; const t1Sym = poolA.token1.symbol;
                        // Log prices consistently (price of T0 in terms of T1)
                        const buyPriceFormatted = formatUnits( poolBuy === poolA ? rawPriceA : rawPriceB, 18 );
                        const sellPriceFormatted = formatUnits( poolSell === poolA ? effectiveSellPriceA_0for1 : effectiveSellPriceB_0for1, 18 );

                        logger.info(`[SpatialFinder] NET Opportunity Found! Pair: ${t0Sym}/${t1Sym}`);
                        logger.info(`  Buy ${t0Sym} on ${poolBuy.dexType} (${poolBuy.address.substring(0,6)}...) @ Raw Price ~${buyPriceFormatted} ${t1Sym}/${t0Sym}`);
                        logger.info(`  Sell ${t0Sym} on ${poolSell.dexType} (${poolSell.address.substring(0,6)}...) @ Eff. Price ~${sellPriceFormatted} ${t1Sym}/${t0Sym}`);
                        logger.info(`  Net Diff (Bips): ${netDiffBips.toString()} (Threshold: ${MIN_NET_PRICE_DIFFERENCE_BIPS.toString()})`);

                        const opportunity = this._createOpportunity(poolBuy, poolSell, canonicalKey, buyToken0); // Pass buyToken0 flag
                        if (opportunity) { // Check if opportunity creation succeeded
                           opportunities.push(opportunity);
                        }
                    }
                } // End inner loop (j)
            } // End outer loop (i)
        } // End loop over canonical pairs

        logger.info(`[SpatialFinder] Finished scan. Found ${opportunities.length} potential spatial opportunities (using NET threshold: ${MIN_NET_PRICE_DIFFERENCE_BIPS}).`);
        return opportunities;
    }

    _createOpportunity(poolBuy, poolSell, canonicalKey, buyToken0) {
        // Determine the initial token to borrow based on the trade direction
        // If buyToken0 is true: We buy T0 on poolBuy (spending T1), sell T0 on poolSell (receiving T1)
        // -> Borrow T1, swap T1->T0 on poolBuy, swap T0->T1 on poolSell, repay T1
        // If buyToken0 is false: We buy T1 on poolBuy (spending T0), sell T1 on poolSell (receiving T0)
        // -> Borrow T0, swap T0->T1 on poolBuy, swap T1->T0 on poolSell, repay T0

        // Let's stick to the convention: price0_1 means price of T0 in terms of T1.
        // The logic above found opportunities based on buying/selling T0.
        // So, we borrow T1, buy T0 (poolBuy), sell T0 (poolSell), repay T1.

        const tokenToBorrow = poolBuy.token1; // T1
        const tokenIntermediate = poolBuy.token0; // T0

        if (!tokenToBorrow || !tokenIntermediate) {
            logger.error(`[SF._createOpp] Critical: Missing token definitions for pools ${poolBuy.name} / ${poolSell.name}`);
            return null;
        }

        // Determine simulation amount based on the token we BORROW (tokenToBorrow)
        const simulationAmountIn = SIMULATION_INPUT_AMOUNTS[tokenToBorrow.symbol] || SIMULATION_INPUT_AMOUNTS['WETH'] || ethers.parseEther('0.1'); // Fallback if symbol not in map

        const getPairSymbols = (pool) => [pool.token0?.symbol || '?', pool.token1?.symbol || '?'];
        const extractSimState = (pool) => ({
             address: pool.address, dexType: pool.dexType, fee: pool.fee,
             sqrtPriceX96: pool.sqrtPriceX96, tick: pool.tick, // V3 specific
             reserve0: pool.reserve0, reserve1: pool.reserve1, // V2 specific
             // DODO specific (pass what's needed for simulation)
             queryAmountOutWei: pool.queryAmountOutWei, // Or other relevant state like B, Q, K, R etc. if needed
             baseTokenSymbol: pool.baseTokenSymbol,
             queryBaseToken: pool.queryBaseToken,
             queryQuoteToken: pool.queryQuoteToken,
             // Pass tokens for simulation logic
             token0: pool.token0,
             token1: pool.token1
        });

        // Construct the path object carefully
        // Path describes the sequence of swaps needed to execute the arbitrage
        // We borrowed T1 (tokenToBorrow), need to end with more T1 to repay loan + profit
        // 1. Swap T1 -> T0 on poolBuy
        // 2. Swap T0 -> T1 on poolSell

        return {
            type: 'spatial',
            pairKey: canonicalKey,
            tokenIn: tokenToBorrow,         // Token to borrow (T1)
            tokenIntermediate: tokenIntermediate, // Intermediate token (T0)
            tokenOut: tokenToBorrow,        // Token to repay (T1)

            // Path structure matching simulator expectation:
            // Each element describes one swap hop.
            path: [
                // Hop 1: Buy T0 using T1 on poolBuy
                {
                    dex: poolBuy.dexType,
                    address: poolBuy.address,
                    // Swap T1 for T0
                    tokenInSymbol: tokenToBorrow.symbol,
                    tokenOutSymbol: tokenIntermediate.symbol,
                    tokenInAddress: tokenToBorrow.address,
                    tokenOutAddress: tokenIntermediate.address,
                    poolState: extractSimState(poolBuy), // Pass necessary state for simulation
                    fee: poolBuy.fee // Pass fee if needed by simulator
                },
                // Hop 2: Sell T0 for T1 on poolSell
                {
                    dex: poolSell.dexType,
                    address: poolSell.address,
                    // Swap T0 for T1
                    tokenInSymbol: tokenIntermediate.symbol,
                    tokenOutSymbol: tokenToBorrow.symbol,
                    tokenInAddress: tokenIntermediate.address,
                    tokenOutAddress: tokenToBorrow.address,
                    poolState: extractSimState(poolSell), // Pass necessary state for simulation
                    fee: poolSell.fee // Pass fee if needed by simulator
                }
            ],

            // Initial amount IN for simulation (amount of tokenToBorrow)
            amountIn: simulationAmountIn.toString(),
            // Placeholder for simulation result
            amountOut: '0',
            // Estimated gas (placeholder, filled by GasEstimator)
            gasEstimate: '0',
            // Estimated profit (placeholder, filled by ProfitCalculator)
            estimatedProfit: '0',
            // Timestamp for tracking
            timestamp: Date.now()
        };
     }
}

module.exports = SpatialFinder;
