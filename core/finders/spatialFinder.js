// core/finders/spatialFinder.js
// --- VERSION v1.8 --- Filters out paths requiring DODO quote sell as first hop.

const { ethers, formatUnits } = require('ethers');
const logger = require('../../utils/logger');
const { getCanonicalPairKey } = require('../../utils/pairUtils');
const { getUniV3Price, getV2Price, getDodoPrice, BIGNUMBER_1E18 } = require('../../utils/priceUtils');
const { TOKENS } = require('../../constants/tokens'); // Ensure TOKENS is imported

const BASIS_POINTS_DENOMINATOR = 10000n;

class SpatialFinder {
    constructor(config) {
        // Constructor validation checks for necessary settings
        if (
            !config?.FINDER_SETTINGS?.SPATIAL_MIN_NET_PRICE_DIFFERENCE_BIPS ||
            !config?.FINDER_SETTINGS?.SPATIAL_MAX_REASONABLE_PRICE_DIFF_BIPS ||
            !config?.FINDER_SETTINGS?.SPATIAL_SIMULATION_INPUT_AMOUNTS ||
            !config?.FINDER_SETTINGS?.SPATIAL_SIMULATION_INPUT_AMOUNTS['DEFAULT']
        ) {
            throw new Error("[SpatialFinder Init] Missing required FINDER_SETTINGS (or DEFAULT sim amount) in configuration.");
        }
        this.config = config; // Store full config
        this.pairRegistry = new Map();
        // Read and store config values used frequently
        this.minNetPriceDiffBips = BigInt(this.config.FINDER_SETTINGS.SPATIAL_MIN_NET_PRICE_DIFFERENCE_BIPS);
        this.maxReasonablePriceDiffBips = BigInt(this.config.FINDER_SETTINGS.SPATIAL_MAX_REASONABLE_PRICE_DIFF_BIPS);
        this.simulationInputAmounts = this.config.FINDER_SETTINGS.SPATIAL_SIMULATION_INPUT_AMOUNTS;
        logger.info(`[SpatialFinder v1.8] Initialized. Min Net BIPS: ${this.minNetPriceDiffBips}, Max Diff BIPS: ${this.maxReasonablePriceDiffBips}, Sim Amounts Loaded: ${Object.keys(this.simulationInputAmounts).length} (Filters DODO Quote Sell)`);
    }

    updatePairRegistry(registry) {
        if (!registry || !(registry instanceof Map)) {
            logger.warn('[SF] Invalid registry update received.');
            return;
        }
        this.pairRegistry = registry;
        logger.debug(`[SF] Pair registry updated. Size: ${this.pairRegistry.size}`);
    }

    _calculatePrice(poolState) {
        const { dexType, token0, token1 } = poolState;
        if (!token0 || !token1 || !token0.address || !token1.address || token0.decimals === undefined || token1.decimals === undefined) {
            logger.warn(`[SF._CalcPrice] Missing required token info (address/decimals) for pool ${poolState.address}`);
            return null;
        }
        try {
            switch (dexType?.toLowerCase()) {
                case 'uniswapv3':
                    if (poolState.sqrtPriceX96) {
                        return getUniV3Price(poolState.sqrtPriceX96, token0, token1);
                    }
                    break;
                case 'sushiswap':
                    if (poolState.reserve0 !== undefined && poolState.reserve1 !== undefined) {
                        if (poolState.reserve0 === 0n || poolState.reserve1 === 0n) return null; // Avoid division by zero
                        return getV2Price(poolState.reserve0, poolState.reserve1, token0, token1);
                    }
                    break;
                case 'dodo':
                    // DODO price calculation needs the explicit base/quote token info
                    if (poolState.queryAmountOutWei !== undefined && poolState.queryBaseToken && poolState.queryQuoteToken) {
                        const priceBaseInQuote = getDodoPrice(poolState.queryAmountOutWei, poolState.queryBaseToken, poolState.queryQuoteToken);
                        if (priceBaseInQuote === null) return null;

                        // Check if the pool's base/quote match the canonical token0/token1 order
                        if (token0.address.toLowerCase() === poolState.queryBaseToken.address.toLowerCase()) {
                            // Price is already token0 (Base) quoted in token1 (Quote)
                            return priceBaseInQuote;
                        } else if (token1.address.toLowerCase() === poolState.queryBaseToken.address.toLowerCase()) {
                            // Price is token1 (Base) quoted in token0 (Quote). We need the inverse for token0/token1 price.
                            if (priceBaseInQuote === 0n) return null; // Avoid division by zero
                            return (BIGNUMBER_1E18 * BIGNUMBER_1E18) / priceBaseInQuote; // Scaled inverse
                        } else {
                            // This case indicates a mismatch between the canonical pair order and DODO's base/quote assignment
                            logger.warn(`[SF._CalcPrice] DODO pool tokens (${poolState.token0Symbol}/${poolState.token1Symbol}) order might not match canonical pair used for base/quote (${poolState.queryBaseToken.symbol}/${poolState.queryQuoteToken.symbol}) for pool ${poolState.address}`);
                            // Attempt calculation based on known base/quote, assuming token0 is base
                            if (token0.address.toLowerCase() === poolState.queryBaseToken.address.toLowerCase()) return priceBaseInQuote;
                            // Add inverse calculation if token1 is base
                            if (token1.address.toLowerCase() === poolState.queryBaseToken.address.toLowerCase() && priceBaseInQuote > 0n) return (BIGNUMBER_1E18 * BIGNUMBER_1E18) / priceBaseInQuote;
                            return null; // Fallback if uncertain
                        }
                    }
                    break;
                default:
                    logger.warn(`[SF._CalcPrice] Unknown or unsupported dexType for price calculation: ${dexType} for pool ${poolState.address}`);
            }
        } catch (error) {
            logger.error(`[SF._CalcPrice] Error calculating price for ${poolState.address}: ${error.message}`);
        }
        return null;
    }

    findArbitrage(poolStates) {
        logger.info(`[SpatialFinder] Finding spatial arbitrage from ${poolStates.length} pool states...`);
        const opportunities = [];
        if (poolStates.length < 2 || this.pairRegistry.size === 0) {
            return opportunities;
        }

        const poolStateMap = new Map();
        poolStates.forEach(state => { if (state?.address) poolStateMap.set(state.address.toLowerCase(), state); });

        for (const [canonicalKey, poolAddressesSet] of this.pairRegistry.entries()) {
            if (poolAddressesSet.size < 2) continue;

            const relevantPoolStates = [];
            poolAddressesSet.forEach(addr => {
                const state = poolStateMap.get(addr.toLowerCase());
                if (state) relevantPoolStates.push(state);
            });
            if (relevantPoolStates.length < 2) continue;

            const poolsWithPrices = relevantPoolStates
                .map(pool => ({ ...pool, price0_1_scaled: this._calculatePrice(pool) }))
                .filter(p => p.price0_1_scaled !== null && p.price0_1_scaled > 0n);

            if (poolsWithPrices.length < 2) continue;

            for (let i = 0; i < poolsWithPrices.length; i++) {
                for (let j = i + 1; j < poolsWithPrices.length; j++) {
                    const poolA = poolsWithPrices[i];
                    const poolB = poolsWithPrices[j];

                    // Ensure tokens are valid (address should exist)
                    if (!poolA.token0?.address || !poolA.token1?.address || !poolB.token0?.address || !poolB.token1?.address) {
                        logger.warn(`[SF] Missing token ADDRESS during comparison: A=${poolA.address} vs B=${poolB.address}`);
                        continue;
                    }
                    // Ensure tokens actually match within the canonical key group (should always pass if registry is correct)
                    if (poolA.token0.address.toLowerCase() !== poolB.token0.address.toLowerCase() ||
                        poolA.token1.address.toLowerCase() !== poolB.token1.address.toLowerCase()) {
                        // This indicates a fundamental issue in pairRegistry population or key generation
                        logger.error(`[SF CRITICAL LOGIC ERROR] Comparing pools from different pairs! Key: ${canonicalKey}, PoolA: ${poolA.address} (${poolA.token0.symbol}/${poolA.token1.symbol}), PoolB: ${poolB.address} (${poolB.token0.symbol}/${poolB.token1.symbol}). Check pairRegistry population.`);
                        continue; // Skip this invalid comparison
                    }

                    const rawPriceA = poolA.price0_1_scaled; // Price T0/T1 on A
                    const rawPriceB = poolB.price0_1_scaled; // Price T0/T1 on B

                    // Sanity check price difference
                    const rawPriceDiff = rawPriceA > rawPriceB ? rawPriceA - rawPriceB : rawPriceB - rawPriceA;
                    const minRawPrice = rawPriceA < rawPriceB ? rawPriceA : rawPriceB;
                    if (minRawPrice === 0n) continue;
                    const rawDiffBips = (rawPriceDiff * BASIS_POINTS_DENOMINATOR) / minRawPrice;
                    if (rawDiffBips > this.maxReasonablePriceDiffBips) {
                        // logger.debug(`[SF] Skipping implausible raw price diff > ${this.maxReasonablePriceDiffBips} BIPS between ${poolA.name} and ${poolB.name}`);
                        continue;
                    }

                    // Fee Adjustment (using defaults if fee missing)
                    const feeA_bips = BigInt(poolA.fee ?? (poolA.dexType === 'sushiswap' ? 30 : (poolA.dexType === 'dodo' ? 10 : 30)));
                    const feeB_bips = BigInt(poolB.fee ?? (poolB.dexType === 'sushiswap' ? 30 : (poolB.dexType === 'dodo' ? 10 : 30)));
                    const sellMultiplierA = BASIS_POINTS_DENOMINATOR - feeA_bips;
                    const sellMultiplierB = BASIS_POINTS_DENOMINATOR - feeB_bips;

                    const effectiveSellPriceA_0for1 = (rawPriceA * sellMultiplierA) / BASIS_POINTS_DENOMINATOR;
                    const effectiveSellPriceB_0for1 = (rawPriceB * sellMultiplierB) / BASIS_POINTS_DENOMINATOR;

                    // Opportunity Check
                    let poolBuy = null; let poolSell = null; let netDiffBips = 0n;
                    // Scenario 1: Buy T0 on A, Sell T0 on B (Profit if effSellB > rawPriceA)
                    if (effectiveSellPriceB_0for1 > rawPriceA) {
                        netDiffBips = ((effectiveSellPriceB_0for1 - rawPriceA) * BASIS_POINTS_DENOMINATOR) / rawPriceA;
                        if (netDiffBips >= this.minNetPriceDiffBips) { poolBuy = poolA; poolSell = poolB; }
                    }
                    // Scenario 2: Buy T0 on B, Sell T0 on A (Profit if effSellA > rawPriceB)
                    if (!poolBuy && effectiveSellPriceA_0for1 > rawPriceB) {
                        netDiffBips = ((effectiveSellPriceA_0for1 - rawPriceB) * BASIS_POINTS_DENOMINATOR) / rawPriceB;
                        if (netDiffBips >= this.minNetPriceDiffBips) { poolBuy = poolB; poolSell = poolA; }
                    }

                    // If potential opportunity found, create the object (will be filtered by _createOpportunity if needed)
                    if (poolBuy && poolSell) {
                        const t0Sym = poolA.token0.symbol; const t1Sym = poolA.token1.symbol;
                        logger.info(`[SpatialFinder] NET Opportunity Found! Pair: ${t0Sym}/${t1Sym} (Diff: ${netDiffBips} Bips >= Threshold: ${this.minNetPriceDiffBips})`);
                        logger.info(`  Buy ${t0Sym} on ${poolBuy.dexType} (${poolBuy.address.substring(0,6)}...) | Sell ${t0Sym} on ${poolSell.dexType} (${poolSell.address.substring(0,6)}...)`);
                        const opportunity = this._createOpportunity(poolBuy, poolSell, canonicalKey);
                        if (opportunity) { // Add to list only if _createOpportunity doesn't return null
                            opportunities.push(opportunity);
                        }
                    }
                } // End inner loop (j)
            } // End outer loop (i)
        } // End loop over canonical pairs

        logger.info(`[SpatialFinder] Finished scan. Found ${opportunities.length} potential spatial opportunities (using NET threshold: ${this.minNetPriceDiffBips}).`);
        return opportunities;
    }

    // --- _createOpportunity MODIFIED (Added DODO Quote Sell Filter) ---
    _createOpportunity(poolBuy, poolSell, canonicalKey) {
        const logPrefix = `[SF._createOpp ${canonicalKey} v1.8]`; // Version bump

        // Determine token flow based on price comparison (Buy T0 low, Sell T0 high)
        const tokenIntermediate = poolBuy.token0; // T0 (Intermediate)
        const tokenBorrowedOrRepaid = poolBuy.token1; // T1 (Borrowed/Repaid)

        if (!tokenBorrowedOrRepaid?.address || !tokenIntermediate?.address) {
            logger.error(`${logPrefix} Critical: Missing token address definitions for pools ${poolBuy.address} / ${poolSell.address}`);
            return null;
        }

        // --- *** ADDED DODO QUOTE SELL FILTER *** ---
        // Check if the first hop involves selling the quote token on DODO
        if (poolBuy.dexType?.toLowerCase() === 'dodo') {
            // Need base token info for the buy pool from config or poolBuy state itself if fetcher adds it
            let baseTokenAddress = null;
            if (poolBuy.queryBaseToken?.address) {
                 baseTokenAddress = poolBuy.queryBaseToken.address; // Prefer state if available
            } else {
                 // Fallback to lookup via config - requires POOL_CONFIGS in this.config
                 const poolInfo = this.config.POOL_CONFIGS?.find(p => p.address.toLowerCase() === poolBuy.address.toLowerCase() && p.dexType === 'dodo');
                 const baseTokenSymbol = poolInfo?.baseTokenSymbol;
                 const baseTokenConfig = baseTokenSymbol ? this.config.TOKENS[baseTokenSymbol] : null;
                 baseTokenAddress = baseTokenConfig?.address;
            }

            if (!baseTokenAddress) {
                logger.error(`${logPrefix} Cannot determine base token address for DODO pool ${poolBuy.address}. Cannot filter quote sell reliably.`);
                // Decide whether to skip or allow proceeding with risk
                 return null; // Safer to skip if base token unknown
            } else {
                 // tokenBorrowedOrRepaid is T1 (token being input to poolBuy)
                 // We are swapping T1 -> T0 on poolBuy.
                 // Check if T1 (tokenBorrowedOrRepaid) is NOT the base token
                 if (tokenBorrowedOrRepaid.address.toLowerCase() !== baseTokenAddress.toLowerCase()) {
                     // We are trying to sell the quote token on DODO as the first step.
                     logger.warn(`${logPrefix} Skipping opportunity: First hop is DODO Quote Sell (Sell ${tokenBorrowedOrRepaid.symbol} for ${tokenIntermediate.symbol} on ${poolBuy.address}), which is currently disabled/filtered.`);
                     return null; // Filter out this opportunity
                 }
            }
        }
        // --- *** END ADDED FILTER *** ---


        // Use the token being borrowed/repaid for simulation amount lookup
        const simulationAmountIn = this.simulationInputAmounts[tokenBorrowedOrRepaid.symbol] || this.simulationInputAmounts['DEFAULT'];
        if (!simulationAmountIn || typeof simulationAmountIn !== 'bigint' || simulationAmountIn <= 0n) {
             logger.error(`${logPrefix} Could not determine valid simulation input amount for ${tokenBorrowedOrRepaid.symbol}. DEFAULT: ${this.simulationInputAmounts['DEFAULT']}`);
             return null;
        }

        // Helper to extract state needed for simulation/building
        const extractSimState = (pool) => ({
            address: pool.address, dexType: pool.dexType, fee: pool.fee,
            // V3
            sqrtPriceX96: pool.sqrtPriceX96, tick: pool.tick, tickSpacing: pool.tickSpacing,
            // V2
            reserve0: pool.reserve0, reserve1: pool.reserve1,
            // DODO (pass all relevant query/config info)
            queryAmountOutWei: pool.queryAmountOutWei, baseTokenSymbol: pool.baseTokenSymbol,
            queryBaseToken: pool.queryBaseToken, queryQuoteToken: pool.queryQuoteToken,
            // Always include tokens
            token0: pool.token0, token1: pool.token1,
            // Add groupName if needed downstream
            groupName: pool.groupName
        });

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
            // Placeholders - to be filled by ProfitCalculator
            amountOut: '0',
            intermediateAmountOut: '0', // Add placeholder for ProfitCalculator enrichment
            gasEstimate: '0',
            estimatedProfit: '0',
            timestamp: Date.now()
        };
     }
} // End SpatialFinder class

module.exports = SpatialFinder;
