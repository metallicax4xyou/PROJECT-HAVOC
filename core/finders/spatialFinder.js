// core/finders/spatialFinder.js
const { ethers } = require('ethers');
const logger = require('../../utils/logger');
const { getCanonicalPairKey } = require('../../utils/pairUtils');
const { getUniV3Price, getV2Price, getDodoPrice, BIGNUMBER_1E18 } = require('../../utils/priceUtils');
const { TOKENS } = require('../../constants/tokens');

// --- Configuration ---
// *** RESTORED REALISTIC THRESHOLD ***
const MIN_NET_PRICE_DIFFERENCE_BIPS = 5n; // 0.05% net difference threshold
const MAX_REASONABLE_PRICE_DIFF_BIPS = 5000n;
const BASIS_POINTS_DENOMINATOR = 10000n;

const SIMULATION_INPUT_AMOUNTS = {
    'USDC':   ethers.parseUnits('100', 6), 'USDC.e': ethers.parseUnits('100', 6),
    'USDT':   ethers.parseUnits('100', 6), 'DAI':    ethers.parseUnits('100', 18),
    'WETH':   ethers.parseUnits('0.1', 18), 'WBTC':   ethers.parseUnits('0.01', 8),
};

class SpatialFinder {
    constructor(config) {
        this.config = config;
        this.pairRegistry = new Map();
        // Version reflects this corrected file state
        logger.info(`[SpatialFinder v1.31] Initialized (Syntax Corrected).`);
    } // *** ADDED missing closing brace for constructor ***

    updatePairRegistry(registry) {
        if (!registry || !(registry instanceof Map)) { logger.warn('[SF] Invalid registry update.'); return; }
        this.pairRegistry = registry;
        logger.debug(`[SF] Pair registry updated. Size: ${this.pairRegistry.size}`);
    } // *** ADDED missing closing brace for updatePairRegistry ***

    _calculatePrice(poolState) {
        const { dexType, token0, token1 } = poolState;
        if (!token0 || !token1) { logger.warn(`[SF._CalcPrice] Missing tokens ${poolState.address}`); return null; }
        try {
            switch (dexType?.toLowerCase()) { // Use optional chaining and lowercase
                case 'uniswapv3':
                    if (poolState.sqrtPriceX96) { return getUniV3Price(poolState.sqrtPriceX96, token0, token1); }
                    break;
                case 'sushiswap':
                    if (poolState.reserve0 !== undefined && poolState.reserve1 !== undefined) {
                        if (poolState.reserve0 === 0n || poolState.reserve1 === 0n) return null;
                        return getV2Price(poolState.reserve0, poolState.reserve1, token0, token1);
                    }
                    break;
                case 'dodo':
                    if (poolState.queryAmountOutWei !== undefined && poolState.queryBaseToken && poolState.queryQuoteToken) {
                        const priceBaseInQuote = getDodoPrice(poolState.queryAmountOutWei, poolState.queryBaseToken, poolState.queryQuoteToken);
                        if (priceBaseInQuote === null) return null;
                        if (token0.address.toLowerCase() === poolState.queryBaseToken.address.toLowerCase()) { return priceBaseInQuote; }
                        else { if (priceBaseInQuote === 0n) return null; return (BIGNUMBER_1E18 * BIGNUMBER_1E18) / priceBaseInQuote; }
                    }
                    break;
                default: logger.warn(`[SF._CalcPrice] Unknown dexType ${dexType}`);
            }
        } catch (error) { logger.error(`[SF._CalcPrice] Error for ${poolState.address}: ${error.message}`); }
        return null;
    } // *** ADDED missing closing brace for _calculatePrice ***

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

            const poolsWithPrices = relevantPoolStates.map(pool => ({ ...pool, price0_1_scaled: this._calculatePrice(pool) })).filter(p => p.price0_1_scaled !== null && p.price0_1_scaled > 0n);
            if (poolsWithPrices.length < 2) continue;

            // logger.debug(`[SpatialFinder] Comparing ${poolsWithPrices.length} pools for pair ${canonicalKey}...`); // Optional verbose log

            for (let i = 0; i < poolsWithPrices.length; i++) {
                for (let j = i + 1; j < poolsWithPrices.length; j++) {
                    const poolA = poolsWithPrices[i]; const poolB = poolsWithPrices[j];
                    const rawPriceA = poolA.price0_1_scaled; const rawPriceB = poolB.price0_1_scaled;
                    const token0Symbol = poolA.token0?.symbol || '?'; const token1Symbol = poolA.token1?.symbol || '?';

                    // Sanity Check
                    const rawPriceDiff = rawPriceA > rawPriceB ? rawPriceA - rawPriceB : rawPriceB - rawPriceA;
                    const minRawPrice = rawPriceA < rawPriceB ? rawPriceA : rawPriceB;
                    if (minRawPrice === 0n) continue;
                    const rawDiffBips = (rawPriceDiff * BASIS_POINTS_DENOMINATOR) / minRawPrice;
                    if (rawDiffBips > MAX_REASONABLE_PRICE_DIFF_BIPS) { /* logger.warn(...) */ continue; }

                    // Fee Adjustment
                    const feeA_bips = BigInt(poolA.fee ?? 30); const feeB_bips = BigInt(poolB.fee ?? 30);
                    const sellMultiplierA = BASIS_POINTS_DENOMINATOR - feeA_bips; const sellMultiplierB = BASIS_POINTS_DENOMINATOR - feeB_bips;
                    const effectiveSellPriceA = (rawPriceA * sellMultiplierA) / BASIS_POINTS_DENOMINATOR;
                    const effectiveSellPriceB = (rawPriceB * sellMultiplierB) / BASIS_POINTS_DENOMINATOR;

                    // Comparisons defined *after* calculations
                    const comparisonBvsA = effectiveSellPriceB > rawPriceA;
                    const comparisonAvsB = effectiveSellPriceA > rawPriceB;

                    // logger.debug(`[SF Compare] ...`); // Keep commented unless debugging needed

                    let poolBuy = null, poolSell = null, netDiffBips = 0n;

                    if (comparisonBvsA) {
                        netDiffBips = ((effectiveSellPriceB - rawPriceA) * BASIS_POINTS_DENOMINATOR) / rawPriceA;
                        if (netDiffBips >= MIN_NET_PRICE_DIFFERENCE_BIPS) { poolBuy = poolA; poolSell = poolB; }
                    } else if (comparisonAvsB) {
                        netDiffBips = ((effectiveSellPriceA - rawPriceB) * BASIS_POINTS_DENOMINATOR) / rawPriceB;
                         if (netDiffBips >= MIN_NET_PRICE_DIFFERENCE_BIPS) { poolBuy = poolB; poolSell = poolA; }
                    }

                    if (poolBuy && poolSell) {
                        // logger.info(`[SpatialFinder] NET Opportunity Found! ...`); // Keep logs minimal now
                        const opportunity = this._createOpportunity(poolBuy, poolSell, canonicalKey); opportunities.push(opportunity);
                    }
                }
            }
        }
        logger.info(`[SpatialFinder] Finished scan. Found ${opportunities.length} potential spatial opportunities (using NET threshold: ${MIN_NET_PRICE_DIFFERENCE_BIPS}).`);
        return opportunities;
    } // *** ADDED missing closing brace for findArbitrage ***

     _createOpportunity(poolBuy, poolSell, canonicalKey) {
         const targetToken = poolBuy.token0; const quoteToken = poolBuy.token1; const initialTokenSymbol = quoteToken.symbol; const simulationAmountIn = SIMULATION_INPUT_AMOUNTS[initialTokenSymbol] || SIMULATION_INPUT_AMOUNTS['WETH'] || ethers.parseEther('0.1'); const getPairSymbols = (pool) => [pool.token0?.symbol || '?', pool.token1?.symbol || '?'];
         const extractSimState = (pool) => ({ address: pool.address, dexType: pool.dexType, fee: pool.fee, sqrtPriceX96: pool.sqrtPriceX96, reserve0: pool.reserve0, reserve1: pool.reserve1, token0: pool.token0, token1: pool.token1, baseTokenSymbol: pool.baseTokenSymbol, tick: pool.tick, queryAmountOutWei: pool.queryAmountOutWei, queryBaseToken: pool.queryBaseToken, queryQuoteToken: pool.queryQuoteToken });
         return { type: 'spatial', pairKey: canonicalKey, tokenIn: quoteToken.symbol, tokenIntermediate: targetToken.symbol, tokenOut: quoteToken.symbol, path: [ { dex: poolBuy.dexType, address: poolBuy.address, pairSymbols: getPairSymbols(poolBuy), action: 'buy', tokenInSymbol: quoteToken.symbol, tokenOutSymbol: targetToken.symbol, priceScaled: poolBuy.price0_1_scaled?.toString() || '0', poolState: extractSimState(poolBuy) }, { dex: poolSell.dexType, address: poolSell.address, pairSymbols: getPairSymbols(poolSell), action: 'sell', tokenInSymbol: targetToken.symbol, tokenOutSymbol: quoteToken.symbol, priceScaled: poolSell.price0_1_scaled?.toString() || '0', poolState: extractSimState(poolSell) } ], amountIn: simulationAmountIn ? simulationAmountIn.toString() : '0', amountOut: '0', timestamp: Date.now() };
     } // *** ADDED missing closing brace for _createOpportunity ***

} // *** ADDED missing closing brace for class SpatialFinder ***

module.exports = SpatialFinder;
