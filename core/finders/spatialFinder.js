// core/finders/spatialFinder.js
const { ethers } = require('ethers');
const logger = require('../../utils/logger');
const { getCanonicalPairKey } = require('../../utils/pairUtils');
const { getUniV3Price, getV2Price, getDodoPrice, BIGNUMBER_1E18 } = require('../../utils/priceUtils');
const { TOKENS } = require('../../constants/tokens');

// --- Configuration ---
// *** KEEPING THRESHOLD AT 0 FOR THIS TEST ***
const MIN_NET_PRICE_DIFFERENCE_BIPS = 0n; // TEMPORARY: Allow *any* net difference > 0 for testing gas calc
// *** --- ***
const MAX_REASONABLE_PRICE_DIFF_BIPS = 5000n; // 50% sanity check
const BASIS_POINTS_DENOMINATOR = 10000n;

// Simulation Input Amounts (Copied here for _createOpportunity, consider centralizing)
const SIMULATION_INPUT_AMOUNTS = { /* ... unchanged ... */
    'USDC':   ethers.parseUnits('100', 6), 'USDC.e': ethers.parseUnits('100', 6),
    'USDT':   ethers.parseUnits('100', 6), 'DAI':    ethers.parseUnits('100', 18),
    'WETH':   ethers.parseUnits('0.1', 18), 'WBTC':   ethers.parseUnits('0.01', 8),
};

class SpatialFinder {
    constructor(config) {
        this.config = config;
        this.pairRegistry = new Map();
        logger.info(`[SpatialFinder v1.27] Initialized (Detailed Price Logging Added).`);
    }

    updatePairRegistry(registry) { /* ... unchanged ... */
        if (!registry || !(registry instanceof Map)) { logger.warn('[SF] Invalid registry update.'); return; }
        this.pairRegistry = registry; logger.debug(`[SF] Pair registry updated. Size: ${this.pairRegistry.size}`);
     }

    _calculatePrice(poolState) { /* ... unchanged ... */
        const { dexType, token0, token1 } = poolState; if (!token0 || !token1) { logger.warn(`[SF._CalcPrice] Missing tokens ${poolState.address}`); return null; } try { switch (dexType) { case 'uniswapV3': if (poolState.sqrtPriceX96) { return getUniV3Price(poolState.sqrtPriceX96, token0, token1); } break; case 'sushiswap': if (poolState.reserve0 !== undefined && poolState.reserve1 !== undefined) { if (poolState.reserve0 === 0n || poolState.reserve1 === 0n) return null; return getV2Price(poolState.reserve0, poolState.reserve1, token0, token1); } break; case 'dodo': if (poolState.queryAmountOutWei !== undefined && poolState.queryBaseToken && poolState.queryQuoteToken) { const priceBaseInQuote = getDodoPrice(poolState.queryAmountOutWei, poolState.queryBaseToken, poolState.queryQuoteToken); if (priceBaseInQuote === null) return null; if (token0.address.toLowerCase() === poolState.queryBaseToken.address.toLowerCase()) { return priceBaseInQuote; } else { if (priceBaseInQuote === 0n) return null; return (BIGNUMBER_1E18 * BIGNUMBER_1E18) / priceBaseInQuote; } } break; default: logger.warn(`[SF._CalcPrice] Unknown dexType ${dexType}`); } } catch (error) { logger.error(`[SF._CalcPrice] Error for ${poolState.address}: ${error.message}`); } return null;
    }

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

            logger.debug(`[SpatialFinder] Comparing ${poolsWithPrices.length} pools for pair ${canonicalKey}...`); // Log pair being compared

            for (let i = 0; i < poolsWithPrices.length; i++) {
                for (let j = i + 1; j < poolsWithPrices.length; j++) {
                    const poolA = poolsWithPrices[i];
                    const poolB = poolsWithPrices[j];
                    const rawPriceA = poolA.price0_1_scaled;
                    const rawPriceB = poolB.price0_1_scaled;
                    const token0Symbol = poolA.token0?.symbol || '?';
                    const token1Symbol = poolA.token1?.symbol || '?';

                    // Sanity Check
                    const rawPriceDiff = rawPriceA > rawPriceB ? rawPriceA - rawPriceB : rawB - rawPriceA;
                    const minRawPrice = rawPriceA < rawPriceB ? rawPriceA : rawPriceB;
                    if (minRawPrice === 0n) continue;
                    const rawDiffBips = (rawPriceDiff * BASIS_POINTS_DENOMINATOR) / minRawPrice;
                    if (rawDiffBips > MAX_REASONABLE_PRICE_DIFF_BIPS) { logger.warn(`[SF] Implausible RAW diff (${rawDiffBips} bips) btw ${poolA.dexType}/${poolA.address.substring(0,6)} & ${poolB.dexType}/${poolB.address.substring(0,6)}. Skip.`); continue; }

                    // Fee Adjustment
                    const feeA_bips = BigInt(poolA.fee ?? 30);
                    const feeB_bips = BigInt(poolB.fee ?? 30);
                    const sellMultiplierA = BASIS_POINTS_DENOMINATOR - feeA_bips;
                    const sellMultiplierB = BASIS_POINTS_DENOMINATOR - feeB_bips;
                    const effectiveSellPriceA = (rawPriceA * sellMultiplierA) / BASIS_POINTS_DENOMINATOR;
                    const effectiveSellPriceB = (rawPriceB * sellMultiplierB) / BASIS_POINTS_DENOMINATOR;

                    // *** DETAILED LOGGING FOR COMPARISON ***
                    logger.debug(`[SF Compare] ${token0Symbol}/${token1Symbol} | ${poolA.dexType}(${poolA.address.substring(0,4)}.. Fee:${feeA_bips}) vs ${poolB.dexType}(${poolB.address.substring(0,4)}.. Fee:${feeB_bips})`);
                    logger.debug(`  Raw Prices (0->1): A=${ethers.formatEther(rawPriceA)} | B=${ethers.formatEther(rawPriceB)}`);
                    logger.debug(`  Eff.Sell Prices:   A=${ethers.formatEther(effectiveSellPriceA)} | B=${ethers.formatEther(effectiveSellPriceB)}`);
                    const comparisonBvsA = effectiveSellPriceB > rawPriceA;
                    const comparisonAvsB = effectiveSellPriceA > rawPriceB;
                    logger.debug(`  Check (Sell B > Raw A): ${comparisonBvsA} | Check (Sell A > Raw B): ${comparisonAvsB}`);
                    // *** END DETAILED LOGGING ***

                    let poolBuy = null, poolSell = null, netDiffBips = 0n;

                    if (comparisonBvsA) { // Sell on B, Buy on A
                        netDiffBips = ((effectiveSellPriceB - rawPriceA) * BASIS_POINTS_DENOMINATOR) / rawPriceA;
                        if (netDiffBips >= MIN_NET_PRICE_DIFFERENCE_BIPS) { poolBuy = poolA; poolSell = poolB; }
                    } else if (comparisonAvsB) { // Sell on A, Buy on B
                        netDiffBips = ((effectiveSellPriceA - rawPriceB) * BASIS_POINTS_DENOMINATOR) / rawPriceB;
                         if (netDiffBips >= MIN_NET_PRICE_DIFFERENCE_BIPS) { poolBuy = poolB; poolSell = poolA; }
                    }

                    if (poolBuy && poolSell) { // Opportunity found (Net Diff >= 0 with current threshold)
                        const t0Sym = poolA.token0.symbol; const t1Sym = poolA.token1.symbol;
                        const buyP = ethers.formatUnits(poolBuy.price0_1_scaled, 18);
                        const sellP = ethers.formatUnits(poolSell === poolA ? effectiveSellPriceA : effectiveSellPriceB, 18);
                        logger.info(`[SpatialFinder] NET Opportunity Found! Pair: ${t0Sym}/${t1Sym}`);
                        logger.info(`  Buy ${t0Sym} on ${poolBuy.dexType} (${poolBuy.address.substring(0,6)}) @ Raw Price ~${buyP} ${t1Sym}`);
                        logger.info(`  Sell ${t0Sym} on ${poolSell.dexType} (${poolSell.address.substring(0,6)}) @ Eff. Price ~${sellP} ${t1Sym}`);
                        logger.info(`  Net Diff (Bips): ${netDiffBips.toString()} (Threshold: ${MIN_NET_PRICE_DIFFERENCE_BIPS.toString()})`);
                        const opportunity = this._createOpportunity(poolBuy, poolSell, canonicalKey);
                        opportunities.push(opportunity);
                    } else if (netDiffBips > -50n) { // Log near misses (e.g., diff is slightly negative up to -0.5%)
                        logger.debug(`  Near Miss: Net diff ${netDiffBips.toString()} bips.`);
                    }
                }
            }
        }

        logger.info(`[SpatialFinder] Finished scan. Found ${opportunities.length} potential spatial opportunities (using NET threshold: ${MIN_NET_PRICE_DIFFERENCE_BIPS}).`);
        return opportunities;
    }

    _createOpportunity(poolBuy, poolSell, canonicalKey) { /* ... unchanged ... */
        const targetToken = poolBuy.token0; const quoteToken = poolBuy.token1; const initialTokenSymbol = quoteToken.symbol; const simulationAmountIn = SIMULATION_INPUT_AMOUNTS[initialTokenSymbol] || SIMULATION_INPUT_AMOUNTS['WETH'] || ethers.parseEther('0.1'); const getPairSymbols = (pool) => [pool.token0?.symbol || '?', pool.token1?.symbol || '?']; const extractSimState = (pool) => ({ address: pool.address, dexType: pool.dexType, fee: pool.fee, sqrtPriceX96: pool.sqrtPriceX96, reserve0: pool.reserve0, reserve1: pool.reserve1, token0: pool.token0, token1: pool.token1, baseTokenSymbol: pool.baseTokenSymbol, tick: pool.tick });
        return { type: 'spatial', pairKey: canonicalKey, tokenIn: quoteToken.symbol, tokenIntermediate: targetToken.symbol, tokenOut: quoteToken.symbol, path: [ { dex: poolBuy.dexType, address: poolBuy.address, pairSymbols: getPairSymbols(poolBuy), action: 'buy', tokenInSymbol: quoteToken.symbol, tokenOutSymbol: targetToken.symbol, priceScaled: poolBuy.price0_1_scaled.toString(), poolState: extractSimState(poolBuy) }, { dex: poolSell.dexType, address: poolSell.address, pairSymbols: getPairSymbols(poolSell), action: 'sell', tokenInSymbol: targetToken.symbol, tokenOutSymbol: quoteToken.symbol, priceScaled: poolSell.price0_1_scaled.toString(), poolState: extractSimState(poolSell) } ], amountIn: simulationAmountIn ? simulationAmountIn.toString() : '0', amountOut: '0', timestamp: Date.now() };
    }
}

module.exports = SpatialFinder;
