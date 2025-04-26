// core/finders/spatialFinder.js
// --- VERSION v1.7 --- Removes V3 start enforcement. Allows Aave paths.

const { ethers, formatUnits } = require('ethers');
const logger = require('../../utils/logger');
const { getCanonicalPairKey } = require('../../utils/pairUtils');
const { getUniV3Price, getV2Price, getDodoPrice, BIGNUMBER_1E18 } = require('../../utils/priceUtils');
const { TOKENS } = require('../../constants/tokens');

const BASIS_POINTS_DENOMINATOR = 10000n;

class SpatialFinder {
    constructor(config) {
        // --- Constructor remains unchanged (v1.6) ---
        if (!config?.FINDER_SETTINGS?.SPATIAL_MIN_NET_PRICE_DIFFERENCE_BIPS || !config?.FINDER_SETTINGS?.SPATIAL_MAX_REASONABLE_PRICE_DIFF_BIPS || !config?.FINDER_SETTINGS?.SPATIAL_SIMULATION_INPUT_AMOUNTS || !config?.FINDER_SETTINGS?.SPATIAL_SIMULATION_INPUT_AMOUNTS['DEFAULT']) { throw new Error("[SpatialFinder Init] Missing required FINDER_SETTINGS (or DEFAULT sim amount) in configuration."); } this.config = config; this.pairRegistry = new Map(); this.minNetPriceDiffBips = BigInt(this.config.FINDER_SETTINGS.SPATIAL_MIN_NET_PRICE_DIFFERENCE_BIPS); this.maxReasonablePriceDiffBips = BigInt(this.config.FINDER_SETTINGS.SPATIAL_MAX_REASONABLE_PRICE_DIFF_BIPS); this.simulationInputAmounts = this.config.FINDER_SETTINGS.SPATIAL_SIMULATION_INPUT_AMOUNTS; logger.info(`[SpatialFinder v1.7] Initialized. Min Net BIPS: ${this.minNetPriceDiffBips}, Max Diff BIPS: ${this.maxReasonablePriceDiffBips}, Sim Amounts Loaded: ${Object.keys(this.simulationInputAmounts).length} (Removed V3 start enforce)`);
    }

    updatePairRegistry(registry) {
        // --- updatePairRegistry remains unchanged ---
        if (!registry || !(registry instanceof Map)) { logger.warn('[SF] Invalid registry update.'); return; } this.pairRegistry = registry; logger.debug(`[SF] Pair registry updated. Size: ${this.pairRegistry.size}`);
    }

    _calculatePrice(poolState) {
        // --- _calculatePrice remains unchanged ---
        const { dexType, token0, token1 } = poolState; if (!token0 || !token1) { logger.warn(`[SF._CalcPrice] Missing tokens ${poolState.address}`); return null; } try { switch (dexType?.toLowerCase()) { case 'uniswapv3': if (poolState.sqrtPriceX96) { return getUniV3Price(poolState.sqrtPriceX96, token0, token1); } break; case 'sushiswap': if (poolState.reserve0 !== undefined && poolState.reserve1 !== undefined) { if (poolState.reserve0 === 0n || poolState.reserve1 === 0n) return null; return getV2Price(poolState.reserve0, poolState.reserve1, token0, token1); } break; case 'dodo': if (poolState.queryAmountOutWei !== undefined && poolState.queryBaseToken && poolState.queryQuoteToken) { const priceBaseInQuote = getDodoPrice(poolState.queryAmountOutWei, poolState.queryBaseToken, poolState.queryQuoteToken); if (priceBaseInQuote === null) return null; if (token0.address.toLowerCase() === poolState.queryBaseToken.address.toLowerCase()) { return priceBaseInQuote; } else if (token1.address.toLowerCase() === poolState.queryBaseToken.address.toLowerCase()) { if (priceBaseInQuote === 0n) return null; return (BIGNUMBER_1E18 * BIGNUMBER_1E18) / priceBaseInQuote; } else { logger.warn(`[SF._CalcPrice] DODO pool tokens don't match expected base/quote for ${poolState.address}`); return null; } } break; default: logger.warn(`[SF._CalcPrice] Unknown dexType for price calc: ${dexType} @ ${poolState.address}`); } } catch (error) { logger.error(`[SF._CalcPrice] Error calc price ${poolState.address}: ${error.message}`); } return null;
    }

    findArbitrage(poolStates) {
        // --- findArbitrage loop structure remains unchanged ---
        logger.info(`[SpatialFinder] Finding spatial arbitrage from ${poolStates.length} pool states...`); const opportunities = []; if (poolStates.length < 2 || this.pairRegistry.size === 0) { return opportunities; } const poolStateMap = new Map(); poolStates.forEach(state => { if (state?.address) poolStateMap.set(state.address.toLowerCase(), state); }); for (const [canonicalKey, poolAddressesSet] of this.pairRegistry.entries()) { if (poolAddressesSet.size < 2) continue; const relevantPoolStates = []; poolAddressesSet.forEach(addr => { const state = poolStateMap.get(addr.toLowerCase()); if (state) relevantPoolStates.push(state); }); if (relevantPoolStates.length < 2) continue; const poolsWithPrices = relevantPoolStates.map(pool => ({ ...pool, price0_1_scaled: this._calculatePrice(pool) })).filter(p => p.price0_1_scaled !== null && p.price0_1_scaled > 0n); if (poolsWithPrices.length < 2) continue; for (let i = 0; i < poolsWithPrices.length; i++) { for (let j = i + 1; j < poolsWithPrices.length; j++) { const poolA = poolsWithPrices[i]; const poolB = poolsWithPrices[j]; if (!poolA.token0?.address || !poolA.token1?.address || !poolB.token0?.address || !poolB.token1?.address) { logger.warn(`[SF] Missing token ADDRESS during comparison: A=${poolA.address} vs B=${poolB.address}`); continue; } if (poolA.token0.address.toLowerCase() !== poolB.token0.address.toLowerCase() || poolA.token1.address.toLowerCase() !== poolB.token1.address.toLowerCase()) { logger.error(`[SF CRITICAL LOGIC ERROR] Comparing pools from different pairs! Key: ${canonicalKey}, PoolA: ${poolA.address} (${poolA.token0.symbol}/${poolA.token1.symbol}), PoolB: ${poolB.address} (${poolB.token0.symbol}/${poolB.token1.symbol}). Check pairRegistry population.`); continue; } const rawPriceA = poolA.price0_1_scaled; const rawPriceB = poolB.price0_1_scaled; const rawPriceDiff = rawPriceA > rawPriceB ? rawPriceA - rawPriceB : rawPriceB - rawPriceA; const minRawPrice = rawPriceA < rawPriceB ? rawPriceA : rawPriceB; if (minRawPrice === 0n) continue; const rawDiffBips = (rawPriceDiff * BASIS_POINTS_DENOMINATOR) / minRawPrice; if (rawDiffBips > this.maxReasonablePriceDiffBips) { continue; } const feeA_bips = BigInt(poolA.fee ?? (poolA.dexType === 'sushiswap' ? 30 : (poolA.dexType === 'dodo' ? 10 : 30))); const feeB_bips = BigInt(poolB.fee ?? (poolB.dexType === 'sushiswap' ? 30 : (poolB.dexType === 'dodo' ? 10 : 30))); const sellMultiplierA = BASIS_POINTS_DENOMINATOR - feeA_bips; const sellMultiplierB = BASIS_POINTS_DENOMINATOR - feeB_bips; const effectiveSellPriceA_0for1 = (rawPriceA * sellMultiplierA) / BASIS_POINTS_DENOMINATOR; const effectiveSellPriceB_0for1 = (rawPriceB * sellMultiplierB) / BASIS_POINTS_DENOMINATOR; let poolBuy = null; let poolSell = null; let netDiffBips = 0n; if (effectiveSellPriceB_0for1 > rawPriceA) { netDiffBips = ((effectiveSellPriceB_0for1 - rawPriceA) * BASIS_POINTS_DENOMINATOR) / rawPriceA; if (netDiffBips >= this.minNetPriceDiffBips) { poolBuy = poolA; poolSell = poolB; } } if (!poolBuy && effectiveSellPriceA_0for1 > rawPriceB) { netDiffBips = ((effectiveSellPriceA_0for1 - rawPriceB) * BASIS_POINTS_DENOMINATOR) / rawPriceB; if (netDiffBips >= this.minNetPriceDiffBips) { poolBuy = poolB; poolSell = poolA; } } if (poolBuy && poolSell) { const t0Sym = poolA.token0.symbol; const t1Sym = poolA.token1.symbol; logger.info(`[SpatialFinder] NET Opportunity Found! Pair: ${t0Sym}/${t1Sym} (Diff: ${netDiffBips} Bips >= Threshold: ${this.minNetPriceDiffBips})`); logger.info(`  Buy ${t0Sym} on ${poolBuy.dexType} (${poolBuy.address.substring(0,6)}...) | Sell ${t0Sym} on ${poolSell.dexType} (${poolSell.address.substring(0,6)}...)`); const opportunity = this._createOpportunity(poolBuy, poolSell, canonicalKey); if (opportunity) { opportunities.push(opportunity); } } } } } logger.info(`[SpatialFinder] Finished scan. Found ${opportunities.length} potential spatial opportunities (using NET threshold: ${this.minNetPriceDiffBips}).`); return opportunities;
    }

    // --- _createOpportunity MODIFIED (Removed V3 start check) ---
    _createOpportunity(poolBuy, poolSell, canonicalKey) {
        const logPrefix = `[SF._createOpp ${canonicalKey}]`;

        // --- V3 Start Check REMOVED ---
        // if (poolBuy.dexType?.toLowerCase() !== 'uniswapV3') {
        //      logger.debug(`${logPrefix} Skipping opportunity creation: First hop (poolBuy) is not Uniswap V3 (${poolBuy.dexType}). Required for flash loan origination.`);
        //      return null; // Cannot create this opportunity as it's not executable
        // }
        // --- END REMOVED CHECK ---

        // Determine token flow based on price comparison (Buy T0 low, Sell T0 high)
        // Assuming poolBuy is where T0 is cheaper relative to T1
        const tokenIntermediate = poolBuy.token0; // T0
        const tokenBorrowedOrRepaid = poolBuy.token1; // T1

        if (!tokenBorrowedOrRepaid || !tokenIntermediate) {
            logger.error(`${logPrefix} Critical: Missing token definitions for pools ${poolBuy.name} / ${poolSell.name}`);
            return null;
        }

        // Use the token being borrowed/repaid for simulation amount lookup
        const simulationAmountIn = this.simulationInputAmounts[tokenBorrowedOrRepaid.symbol] || this.simulationInputAmounts['DEFAULT'];
        if (!simulationAmountIn || typeof simulationAmountIn !== 'bigint' || simulationAmountIn <= 0n) {
             logger.error(`${logPrefix} Could not determine valid simulation input amount for ${tokenBorrowedOrRepaid.symbol}. Using DEFAULT failed or invalid.`);
             return null;
        }

        const extractSimState = (pool) => ({ address: pool.address, dexType: pool.dexType, fee: pool.fee, sqrtPriceX96: pool.sqrtPriceX96, tick: pool.tick, reserve0: pool.reserve0, reserve1: pool.reserve1, queryAmountOutWei: pool.queryAmountOutWei, baseTokenSymbol: pool.baseTokenSymbol, queryBaseToken: pool.queryBaseToken, queryQuoteToken: pool.queryQuoteToken, token0: pool.token0, token1: pool.token1 });

        // Construct the path object: Borrow T1 -> Swap T1->T0 (poolBuy) -> Swap T0->T1 (poolSell) -> Repay T1
        return {
            type: 'spatial', pairKey: canonicalKey,
            tokenIn: tokenBorrowedOrRepaid, // T1 is the entry/exit token for the flash loan
            tokenIntermediate: tokenIntermediate, // T0 is the intermediate token
            tokenOut: tokenBorrowedOrRepaid, // Should end with T1
            path: [
                // Hop 1: Buy T0 using T1 on poolBuy
                {
                    dex: poolBuy.dexType, address: poolBuy.address, fee: poolBuy.fee,
                    tokenInSymbol: tokenBorrowedOrRepaid.symbol, tokenOutSymbol: tokenIntermediate.symbol,
                    tokenInAddress: tokenBorrowedOrRepaid.address, tokenOutAddress: tokenIntermediate.address,
                    poolState: extractSimState(poolBuy),
                },
                // Hop 2: Sell T0 for T1 on poolSell
                {
                    dex: poolSell.dexType, address: poolSell.address, fee: poolSell.fee,
                    tokenInSymbol: tokenIntermediate.symbol, tokenOutSymbol: tokenBorrowedOrRepaid.symbol,
                    tokenInAddress: tokenIntermediate.address, tokenOutAddress: tokenBorrowedOrRepaid.address,
                    poolState: extractSimState(poolSell),
                }
            ],
            amountIn: simulationAmountIn.toString(), // Amount of T1 to simulate borrowing
            amountOut: '0', gasEstimate: '0', estimatedProfit: '0', timestamp: Date.now()
        };
     }
} // End SpatialFinder class

module.exports = SpatialFinder;
