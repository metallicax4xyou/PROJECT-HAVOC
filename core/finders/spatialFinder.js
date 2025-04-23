// core/finders/spatialFinder.js
const { ethers } = require('ethers'); // Need ethers potentially for formatting logs
const logger = require('../../utils/logger'); // Adjust path if needed
const { getCanonicalPairKey } = require('../../utils/pairUtils'); // Adjust path if needed
const { getUniV3Price, getV2Price, getDodoPrice, BIGNUMBER_1E18 } = require('../../utils/priceUtils'); // Adjust path if needed
const { TOKENS } = require('../../constants/tokens'); // Adjust path if needed

// --- Configuration ---
// TODO: Move these to the main config object later
const MIN_NET_PRICE_DIFFERENCE_BIPS = 0n; // Example: Look for at least 0.05% net difference (Adjust!)
const MAX_REASONABLE_PRICE_DIFF_BIPS = 5000n; // 50% sanity check for raw price diff
const BASIS_POINTS_DENOMINATOR = 10000n;

// Define simulation input amounts here or import from ProfitCalculator/config
// TODO: Centralize this definition
const SIMULATION_INPUT_AMOUNTS = {
    'USDC':   ethers.parseUnits('100', 6),
    'USDC.e': ethers.parseUnits('100', 6),
    'USDT':   ethers.parseUnits('100', 6),
    'DAI':    ethers.parseUnits('100', 18),
    'WETH':   ethers.parseUnits('0.1', 18),
    'WBTC':   ethers.parseUnits('0.01', 8),
    // Add others as needed
};

class SpatialFinder {
    constructor(config) {
        this.config = config;
        this.pairRegistry = new Map();
        logger.info(`[SpatialFinder v1.26] Initialized (Includes Pool State in Opportunity).`);
    }

    /**
     * Updates the internal pair registry. Called by ArbitrageEngine.
     * @param {Map<string, Set<string>>} registry Map<canonicalPairKey, Set<poolAddress>>
     */
    updatePairRegistry(registry) {
        if (!registry || !(registry instanceof Map)) { logger.warn('[SpatialFinder] Invalid registry update.'); return; }
        this.pairRegistry = registry;
        logger.debug(`[SpatialFinder] Pair registry updated. Size: ${this.pairRegistry.size}`);
    }

    /**
     * Calculates the price for a given pool state.
     * Price is represented as the amount of token1 needed to buy 1 unit of token0, scaled by 1e18.
     * @param {object} poolState The pool state object from PoolScanner.
     * @returns {bigint|null} Scaled price (token0 in terms of token1 * 1e18) or null if calculation fails.
     */
    _calculatePrice(poolState) {
        const { dexType, token0, token1 } = poolState;
        if (!token0 || !token1) { logger.warn(`[SF._CalcPrice] Missing token objects for ${poolState.address}`); return null; }
        try {
            switch (dexType) {
                case 'uniswapV3':
                    if (poolState.sqrtPriceX96) { return getUniV3Price(poolState.sqrtPriceX96, token0, token1); } break;
                case 'sushiswap':
                    if (poolState.reserve0 !== undefined && poolState.reserve1 !== undefined) { if (poolState.reserve0 === 0n || poolState.reserve1 === 0n) return null; return getV2Price(poolState.reserve0, poolState.reserve1, token0, token1); } break;
                case 'dodo':
                    if (poolState.queryAmountOutWei !== undefined && poolState.queryBaseToken && poolState.queryQuoteToken) {
                        const priceBaseInQuote = getDodoPrice(poolState.queryAmountOutWei, poolState.queryBaseToken, poolState.queryQuoteToken);
                        if (priceBaseInQuote === null) return null;
                        // Ensure token0 and queryBaseToken addresses are comparable
                        if (token0.address.toLowerCase() === poolState.queryBaseToken.address.toLowerCase()) { return priceBaseInQuote; }
                        else { if (priceBaseInQuote === 0n) return null; return (BIGNUMBER_1E18 * BIGNUMBER_1E18) / priceBaseInQuote; }
                    } break;
                default: logger.warn(`[SF._CalcPrice] Unknown dexType ${dexType}`);
            }
        } catch (error) { logger.error(`[SF._CalcPrice] Error for ${poolState.address}: ${error.message}`); }
        return null;
    }

    /**
     * Finds spatial arbitrage opportunities by comparing prices across different DEXs.
     * @param {Array<object>} poolStates - Array of fetched pool state objects from PoolScanner.
     * @returns {Array<object>} - Array of potential spatial arbitrage opportunity objects.
     */
    findArbitrage(poolStates) {
        logger.info(`[SpatialFinder] Finding spatial arbitrage from ${poolStates.length} pool states...`);
        const opportunities = [];
        if (poolStates.length < 2 || this.pairRegistry.size === 0) return opportunities;

        const poolStateMap = new Map();
        poolStates.forEach(state => { if (state?.address) poolStateMap.set(state.address.toLowerCase(), state); });

        for (const [canonicalKey, poolAddressesSet] of this.pairRegistry.entries()) {
            if (poolAddressesSet.size < 2) continue;

            const relevantPoolStates = [];
            poolAddressesSet.forEach(addr => { const state = poolStateMap.get(addr.toLowerCase()); if (state) relevantPoolStates.push(state); });
            if (relevantPoolStates.length < 2) continue;

            const poolsWithPrices = relevantPoolStates.map(pool => ({
                 ...pool, price0_1_scaled: this._calculatePrice(pool)
            })).filter(p => p.price0_1_scaled !== null && p.price0_1_scaled > 0n);

            if (poolsWithPrices.length < 2) continue;

            for (let i = 0; i < poolsWithPrices.length; i++) {
                for (let j = i + 1; j < poolsWithPrices.length; j++) {
                    const poolA = poolsWithPrices[i];
                    const poolB = poolsWithPrices[j];
                    const rawPriceA = poolA.price0_1_scaled;
                    const rawPriceB = poolB.price0_1_scaled;

                    // Sanity check raw price diff
                    const rawPriceDiff = rawPriceA > rawPriceB ? rawPriceA - rawPriceB : rawPriceB - rawPriceA;
                    const minRawPrice = rawPriceA < rawPriceB ? rawPriceA : rawPriceB;
                    if (minRawPrice === 0n) continue;
                    const rawDiffBips = (rawPriceDiff * BASIS_POINTS_DENOMINATOR) / minRawPrice;
                    if (rawDiffBips > MAX_REASONABLE_PRICE_DIFF_BIPS) {
                         logger.warn(`[SpatialFinder] Implausible RAW price diff (${rawDiffBips} bips) between ${poolA.dexType}/${poolA.address.substring(0,6)} and ${poolB.dexType}/${poolB.address.substring(0,6)}. Skipping.`);
                         continue;
                    }

                    // Fee Adjustment & Net Comparison
                    // Use BigInt for fee calculations
                    const feeA_bips = BigInt(poolA.fee ?? 30); // Default needs careful consideration
                    const feeB_bips = BigInt(poolB.fee ?? 30);
                    const sellMultiplierA = BASIS_POINTS_DENOMINATOR - feeA_bips;
                    const sellMultiplierB = BASIS_POINTS_DENOMINATOR - feeB_bips;
                    const effectiveSellPriceA = (rawPriceA * sellMultiplierA) / BASIS_POINTS_DENOMINATOR;
                    const effectiveSellPriceB = (rawPriceB * sellMultiplierB) / BASIS_POINTS_DENOMINATOR;

                    let poolBuy = null, poolSell = null, netDiffBips = 0n;

                    // Compare effective sell price vs raw buy price
                    if (effectiveSellPriceB > rawPriceA) { // Sell on B, Buy on A
                        netDiffBips = ((effectiveSellPriceB - rawPriceA) * BASIS_POINTS_DENOMINATOR) / rawPriceA;
                        if (netDiffBips >= MIN_NET_PRICE_DIFFERENCE_BIPS) { poolBuy = poolA; poolSell = poolB; }
                    } else if (effectiveSellPriceA > rawPriceB) { // Sell on A, Buy on B
                        netDiffBips = ((effectiveSellPriceA - rawPriceB) * BASIS_POINTS_DENOMINATOR) / rawPriceB;
                         if (netDiffBips >= MIN_NET_PRICE_DIFFERENCE_BIPS) { poolBuy = poolB; poolSell = poolA; }
                    }

                    if (poolBuy && poolSell) {
                        const token0 = poolA.token0; const token1 = poolA.token1;
                        const buyPriceFormatted = ethers.formatUnits(poolBuy.price0_1_scaled, 18); // Approx raw buy price
                        const sellPriceFormatted = ethers.formatUnits(poolSell === poolA ? effectiveSellPriceA : effectiveSellPriceB, 18); // Approx effective sell price

                        logger.info(`[SpatialFinder] NET Opportunity Found! Pair: ${token0.symbol}/${token1.symbol}`);
                        logger.info(`  Buy ${token0.symbol} on ${poolBuy.dexType} (${poolBuy.address.substring(0,6)}) @ Raw Price ~${buyPriceFormatted} ${token1.symbol}`);
                        logger.info(`  Sell ${token0.symbol} on ${poolSell.dexType} (${poolSell.address.substring(0,6)}) @ Eff. Price ~${sellPriceFormatted} ${token1.symbol}`);
                        logger.info(`  Net Diff (Bips): ${netDiffBips.toString()} (Threshold: ${MIN_NET_PRICE_DIFFERENCE_BIPS.toString()})`);

                        // *** Create opportunity object WITH poolState included ***
                        const opportunity = this._createOpportunity(poolBuy, poolSell, canonicalKey);
                        opportunities.push(opportunity);
                    }
                }
            }
        }

        logger.info(`[SpatialFinder] Finished scan. Found ${opportunities.length} potential spatial opportunities (after fee adj).`);
        return opportunities;
    }

    /**
      * Creates a structured opportunity object including necessary pool state for simulation.
      * Assumes we are buying token0 on poolBuy and selling token0 on poolSell.
      */
    _createOpportunity(poolBuy, poolSell, canonicalKey) {
        const targetToken = poolBuy.token0; // Token being arbitraged (buy low, sell high)
        const quoteToken = poolBuy.token1;  // Token used to buy/sell the target token

        // Determine initial simulation amount based on quote token
        const initialTokenSymbol = quoteToken.symbol;
        const simulationAmountIn = SIMULATION_INPUT_AMOUNTS[initialTokenSymbol] || SIMULATION_INPUT_AMOUNTS['WETH'] || ethers.parseEther('0.1'); // Default amount

        // Helper to get pair symbols safely
        const getPairSymbols = (pool) => [pool.token0?.symbol || '?', pool.token1?.symbol || '?'];

        // Helper to safely extract needed state properties
        const extractSimState = (pool) => ({
             address: pool.address,
             dexType: pool.dexType,
             fee: pool.fee,
             sqrtPriceX96: pool.sqrtPriceX96, // For V3
             reserve0: pool.reserve0,         // For V2
             reserve1: pool.reserve1,         // For V2
             token0: pool.token0,             // Need actual token objects
             token1: pool.token1,
             baseTokenSymbol: pool.baseTokenSymbol, // For DODO
             // Add other state if needed by simulator (e.g., tick for V3 if using advanced sim)
             tick: pool.tick
        });

        return {
            type: 'spatial',
            pairKey: canonicalKey,
            // --- Define the token flow ---
            tokenIn: quoteToken.symbol,           // Start with this token
            tokenIntermediate: targetToken.symbol, // Arb this token
            tokenOut: quoteToken.symbol,          // End with this token
            // --- Define the path with state needed for simulation ---
            path: [
                { // Step 1: Buy targetToken (token0) with quoteToken (token1) on cheaper pool
                    dex: poolBuy.dexType,
                    address: poolBuy.address,
                    pairSymbols: getPairSymbols(poolBuy), // For logging
                    action: 'buy',
                    tokenInSymbol: quoteToken.symbol,
                    tokenOutSymbol: targetToken.symbol,
                    priceScaled: poolBuy.price0_1_scaled.toString(), // Log raw buy price
                    // *** Include necessary state for simulation ***
                    poolState: extractSimState(poolBuy)
                },
                { // Step 2: Sell targetToken (token0) for quoteToken (token1) on expensive pool
                    dex: poolSell.dexType,
                    address: poolSell.address,
                    pairSymbols: getPairSymbols(poolSell), // For logging
                    action: 'sell',
                    tokenInSymbol: targetToken.symbol,
                    tokenOutSymbol: quoteToken.symbol,
                    priceScaled: poolSell.price0_1_scaled.toString(), // Log raw sell price
                    // *** Include necessary state for simulation ***
                    poolState: extractSimState(poolSell)
                }
            ],
             // --- Amount represents the SIMULATION input ---
            amountIn: simulationAmountIn ? simulationAmountIn.toString() : '0', // Amount of tokenIn used for sim
            amountOut: '0', // Placeholder - ProfitCalc will update this
            // --- ---
            timestamp: Date.now()
        };
    }
}

module.exports = SpatialFinder;
