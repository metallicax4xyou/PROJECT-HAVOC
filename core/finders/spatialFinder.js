// core/finders/spatialFinder.js
const { ethers } = require('ethers');
const logger = require('../../utils/logger');
const { getCanonicalPairKey } = require('../../utils/pairUtils');
const { getUniV3Price, getV2Price, getDodoPrice, BIGNUMBER_1E18 } = require('../../utils/priceUtils');
const { TOKENS } = require('../../constants/tokens');

// --- Configuration ---
// *** RESTORED REALISTIC THRESHOLD ***
const MIN_NET_PRICE_DIFFERENCE_BIPS = 5n; // 0.05% net difference threshold
// *** --- ***
const MAX_REASONABLE_PRICE_DIFF_BIPS = 5000n;
const BASIS_POINTS_DENOMINATOR = 10000n;

const SIMULATION_INPUT_AMOUNTS = { /* ... as before ... */ };

class SpatialFinder {
    constructor(config) { /* ... */ logger.info(`[SpatialFinder v1.30] Initialized.`); }
    updatePairRegistry(registry) { /* ... */ }
    _calculatePrice(poolState) { /* ... unchanged ... */ }
    findArbitrage(poolStates) { /* ... unchanged main loop logic ... */
        // Ensure the comparison uses MIN_NET_PRICE_DIFFERENCE_BIPS which is now 5n
    }
     _createOpportunity(poolBuy, poolSell, canonicalKey) { /* ... unchanged ... */ }
}

module.exports = SpatialFinder;

// NOTE: Copy the full implementation of the methods from Response #47 / #49
// into the SpatialFinder class above if needed. The key change is just the threshold constant.
// --- Full findArbitrage and _createOpportunity from Response #49 for completeness ---
    findArbitrage(poolStates) {
        logger.info(`[SpatialFinder] Finding spatial arbitrage from ${poolStates.length} pool states...`);
        const opportunities = []; if (poolStates.length < 2 || this.pairRegistry.size === 0) return opportunities;
        const poolStateMap = new Map(); poolStates.forEach(state => { if (state?.address) poolStateMap.set(state.address.toLowerCase(), state); });
        for (const [canonicalKey, poolAddressesSet] of this.pairRegistry.entries()) {
            if (poolAddressesSet.size < 2) continue;
            const relevantPoolStates = []; poolAddressesSet.forEach(addr => { const state = poolStateMap.get(addr.toLowerCase()); if (state) relevantPoolStates.push(state); }); if (relevantPoolStates.length < 2) continue;
            const poolsWithPrices = relevantPoolStates.map(pool => ({ ...pool, price0_1_scaled: this._calculatePrice(pool) })).filter(p => p.price0_1_scaled !== null && p.price0_1_scaled > 0n); if (poolsWithPrices.length < 2) continue;
            // logger.debug(`[SpatialFinder] Comparing ${poolsWithPrices.length} pools for pair ${canonicalKey}...`);

            for (let i = 0; i < poolsWithPrices.length; i++) {
                for (let j = i + 1; j < poolsWithPrices.length; j++) {
                    const poolA = poolsWithPrices[i]; const poolB = poolsWithPrices[j]; const rawPriceA = poolA.price0_1_scaled; const rawPriceB = poolB.price0_1_scaled; const token0Symbol = poolA.token0?.symbol || '?'; const token1Symbol = poolA.token1?.symbol || '?';
                    const rawPriceDiff = rawPriceA > rawPriceB ? rawPriceA - rawPriceB : rawPriceB - rawPriceA; const minRawPrice = rawPriceA < rawPriceB ? rawPriceA : rawPriceB; if (minRawPrice === 0n) continue; const rawDiffBips = (rawPriceDiff * BASIS_POINTS_DENOMINATOR) / minRawPrice; if (rawDiffBips > MAX_REASONABLE_PRICE_DIFF_BIPS) { logger.warn(`[SF] Implausible RAW diff (${rawDiffBips} bips). Skip.`); continue; }
                    const feeA_bips = BigInt(poolA.fee ?? 30); const feeB_bips = BigInt(poolB.fee ?? 30); const sellMultiplierA = BASIS_POINTS_DENOMINATOR - feeA_bips; const sellMultiplierB = BASIS_POINTS_DENOMINATOR - feeB_bips; const effectiveSellPriceA = (rawPriceA * sellMultiplierA) / BASIS_POINTS_DENOMINATOR; const effectiveSellPriceB = (rawPriceB * sellMultiplierB) / BASIS_POINTS_DENOMINATOR;
                    const comparisonBvsA = effectiveSellPriceB > rawPriceA; const comparisonAvsB = effectiveSellPriceA > rawPriceB;
                    // logger.debug(`[SF Compare] ...`); // Keep commented unless necessary

                    let poolBuy = null, poolSell = null, netDiffBips = 0n;
                    if (comparisonBvsA) { netDiffBips = ((effectiveSellPriceB - rawPriceA) * BASIS_POINTS_DENOMINATOR) / rawPriceA; if (netDiffBips >= MIN_NET_PRICE_DIFFERENCE_BIPS) { poolBuy = poolA; poolSell = poolB; } }
                    else if (comparisonAvsB) { netDiffBips = ((effectiveSellPriceA - rawPriceB) * BASIS_POINTS_DENOMINATOR) / rawPriceB; if (netDiffBips >= MIN_NET_PRICE_DIFFERENCE_BIPS) { poolBuy = poolB; poolSell = poolA; } }

                    if (poolBuy && poolSell) {
                        const t0Sym = poolA.token0.symbol; const t1Sym = poolA.token1.symbol; const buyP = ethers.formatUnits(poolBuy.price0_1_scaled, 18); const sellP = ethers.formatUnits(poolSell === poolA ? effectiveSellPriceA : effectiveSellPriceB, 18);
                        logger.info(`[SpatialFinder] NET Opportunity Found! Pair: ${t0Sym}/${t1Sym}`); logger.info(`  Buy ${t0Sym} on ${poolBuy.dexType} (${poolBuy.address.substring(0,6)}) @ Raw Price ~${buyP} ${t1Sym}`); logger.info(`  Sell ${t0Sym} on ${poolSell.dexType} (${poolSell.address.substring(0,6)}) @ Eff. Price ~${sellP} ${t1Sym}`); logger.info(`  Net Diff (Bips): ${netDiffBips.toString()} (Threshold: ${MIN_NET_PRICE_DIFFERENCE_BIPS.toString()})`);
                        const opportunity = this._createOpportunity(poolBuy, poolSell, canonicalKey); opportunities.push(opportunity);
                    } // else if (netDiffBips > -50n) { logger.debug(`  Near Miss: Net diff ${netDiffBips.toString()} bips.`); }
                }
            }
        }
        logger.info(`[SpatialFinder] Finished scan. Found ${opportunities.length} potential spatial opportunities (using NET threshold: ${MIN_NET_PRICE_DIFFERENCE_BIPS}).`);
        return opportunities;
    }
    _createOpportunity(poolBuy, poolSell, canonicalKey) { /* ... unchanged from Response #49 ... */
         const targetToken = poolBuy.token0; const quoteToken = poolBuy.token1; const initialTokenSymbol = quoteToken.symbol; const simulationAmountIn = SIMULATION_INPUT_AMOUNTS[initialTokenSymbol] || SIMULATION_INPUT_AMOUNTS['WETH'] || ethers.parseEther('0.1'); const getPairSymbols = (pool) => [pool.token0?.symbol || '?', pool.token1?.symbol || '?']; const extractSimState = (pool) => ({ address: pool.address, dexType: pool.dexType, fee: pool.fee, sqrtPriceX96: pool.sqrtPriceX96, reserve0: pool.reserve0, reserve1: pool.reserve1, token0: pool.token0, token1: pool.token1, baseTokenSymbol: pool.baseTokenSymbol, tick: pool.tick, queryAmountOutWei: pool.queryAmountOutWei, queryBaseToken: pool.queryBaseToken, queryQuoteToken: pool.queryQuoteToken });
         return { type: 'spatial', pairKey: canonicalKey, tokenIn: quoteToken.symbol, tokenIntermediate: targetToken.symbol, tokenOut: quoteToken.symbol, path: [ { dex: poolBuy.dexType, address: poolBuy.address, pairSymbols: getPairSymbols(poolBuy), action: 'buy', tokenInSymbol: quoteToken.symbol, tokenOutSymbol: targetToken.symbol, priceScaled: poolBuy.price0_1_scaled?.toString() || '0', poolState: extractSimState(poolBuy) }, { dex: poolSell.dexType, address: poolSell.address, pairSymbols: getPairSymbols(poolSell), action: 'sell', tokenInSymbol: targetToken.symbol, tokenOutSymbol: quoteToken.symbol, priceScaled: poolSell.price0_1_scaled?.toString() || '0', poolState: extractSimState(poolSell) } ], amountIn: simulationAmountIn ? simulationAmountIn.toString() : '0', amountOut: '0', timestamp: Date.now() };
    }
// --- End of Class ---
