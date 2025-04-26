// core/finders/spatialFinder.js
// --- VERSION v1.4 --- Reads thresholds and sim amounts from config.

const { ethers, formatUnits } = require('ethers'); // Import formatUnits for logging if needed
const logger = require('../../utils/logger');
const { getCanonicalPairKey } = require('../../utils/pairUtils');
const { getUniV3Price, getV2Price, getDodoPrice, BIGNUMBER_1E18 } = require('../../utils/priceUtils');
const { TOKENS } = require('../../constants/tokens'); // Still needed for token info fallback if not on pool state

// --- Constants ---
const BASIS_POINTS_DENOMINATOR = 10000n;

class SpatialFinder {
    constructor(config) {
        // Validate that required settings exist in the passed config
        if (!config?.FINDER_SETTINGS?.SPATIAL_MIN_NET_PRICE_DIFFERENCE_BIPS ||
            !config?.FINDER_SETTINGS?.SPATIAL_MAX_REASONABLE_PRICE_DIFF_BIPS ||
            !config?.FINDER_SETTINGS?.SPATIAL_SIMULATION_INPUT_AMOUNTS ||
            !config?.FINDER_SETTINGS?.SPATIAL_SIMULATION_INPUT_AMOUNTS['DEFAULT']) { // Ensure DEFAULT exists
            throw new Error("[SpatialFinder Init] Missing required FINDER_SETTINGS (or DEFAULT sim amount) in configuration.");
        }
        this.config = config;
        this.pairRegistry = new Map();

        // Read values from config and store them on the instance
        this.minNetPriceDiffBips = BigInt(this.config.FINDER_SETTINGS.SPATIAL_MIN_NET_PRICE_DIFFERENCE_BIPS);
        this.maxReasonablePriceDiffBips = BigInt(this.config.FINDER_SETTINGS.SPATIAL_MAX_REASONABLE_PRICE_DIFF_BIPS);
        // Store the simulation amounts map directly
        this.simulationInputAmounts = this.config.FINDER_SETTINGS.SPATIAL_SIMULATION_INPUT_AMOUNTS;

        logger.info(`[SpatialFinder v1.4] Initialized. Min Net BIPS: ${this.minNetPriceDiffBips}, Max Diff BIPS: ${this.maxReasonablePriceDiffBips}, Sim Amounts Loaded: ${Object.keys(this.simulationInputAmounts).length}`);
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
                        // Ensure token addresses are compared case-insensitively
                        if (token0.address.toLowerCase() === poolState.queryBaseToken.address.toLowerCase()) {
                            return priceBaseInQuote; // Price is already token0 quoted in token1
                        } else if (token1.address.toLowerCase() === poolState.queryBaseToken.address.toLowerCase()) {
                            // The pool's base is our token1, so we need the inverse price
                            if (priceBaseInQuote === 0n) return null; // Avoid division by zero
                            return (BIGNUMBER_1E18 * BIGNUMBER_1E18) / priceBaseInQuote;
                        } else {
                             logger.warn(`[SF._CalcPrice] DODO pool tokens don't match expected base/quote for ${poolState.address}`);
                             return null;
                        }
                    }
                    break;
                default:
                    logger.warn(`[SF._CalcPrice] Unknown dexType for price calc: ${dexType} @ ${poolState.address}`);
            }
        } catch (error) { logger.error(`[SF._CalcPrice] Error calc price ${poolState.address}: ${error.message}`); }
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

                    if (!poolA.token0 || !poolA.token1 || !poolB.token0 || !poolB.token1) { continue; }
                    // Ensure tokens match (case-insensitive address check)
                    if (poolA.token0.address.toLowerCase() !== poolB.token0.address.toLowerCase() ||
                        poolA.token1.address.toLowerCase() !== poolB.token1.address.toLowerCase()) {
                            logger.warn(`[SF] Token mismatch within canonical pair comparison: ${poolA.name} vs ${poolB.name}`);
                            continue;
                    }

                    const rawPriceA = poolA.price0_1_scaled; // Price of T0 in terms of T1
                    const rawPriceB = poolB.price0_1_scaled; // Price of T0 in terms of T1

                    // --- Sanity Check --- Use value from config ---
                    const rawPriceDiff = rawPriceA > rawPriceB ? rawPriceA - rawPriceB : rawPriceB - rawPriceA;
                    const minRawPrice = rawPriceA < rawPriceB ? rawPriceA : rawPriceB;
                    if (minRawPrice === 0n) continue; // Avoid division by zero
                    const rawDiffBips = (rawPriceDiff * BASIS_POINTS_DENOMINATOR) / minRawPrice;
                    if (rawDiffBips > this.maxReasonablePriceDiffBips) { // Use config value
                        // logger.warn(`[SF] Skipping implausible raw price diff > ${this.maxReasonablePriceDiffBips} BIPS between ${poolA.name} and ${poolB.name}`);
                        continue;
                    }

                    // --- Fee Adjustment ---
                    // TODO: Improve fee handling - maybe fetcher provides better fee data?
                    // Using low defaults for DODO based on comment in config file. Verify these!
                    const feeA_bips = BigInt(poolA.fee ?? (poolA.dexType === 'sushiswap' ? 30 : (poolA.dexType === 'dodo' ? 10 : 30)));
                    const feeB_bips = BigInt(poolB.fee ?? (poolB.dexType === 'sushiswap' ? 30 : (poolB.dexType === 'dodo' ? 10 : 30)));
                    const sellMultiplierA = BASIS_POINTS_DENOMINATOR - feeA_bips;
                    const sellMultiplierB = BASIS_POINTS_DENOMINATOR - feeB_bips;

                    const effectiveSellPriceA_0for1 = (rawPriceA * sellMultiplierA) / BASIS_POINTS_DENOMINATOR;
                    const effectiveSellPriceB_0for1 = (rawPriceB * sellMultiplierB) / BASIS_POINTS_DENOMINATOR;

                    let poolBuy = null; let poolSell = null; let netDiffBips = 0n;

                    // Scenario 1: Buy T0 on A, Sell T0 on B
                    if (effectiveSellPriceB_0for1 > rawPriceA) {
                        netDiffBips = ((effectiveSellPriceB_0for1 - rawPriceA) * BASIS_POINTS_DENOMINATOR) / rawPriceA;
                        if (netDiffBips >= this.minNetPriceDiffBips) { // Use config value
                            poolBuy = poolA; poolSell = poolB;
                        }
                    }

                    // Scenario 2: Buy T0 on B, Sell T0 on A
                    if (!poolBuy && effectiveSellPriceA_0for1 > rawPriceB) {
                        netDiffBips = ((effectiveSellPriceA_0for1 - rawPriceB) * BASIS_POINTS_DENOMINATOR) / rawPriceB;
                        if (netDiffBips >= this.minNetPriceDiffBips) { // Use config value
                            poolBuy = poolB; poolSell = poolA;
                        }
                    }

                    if (poolBuy && poolSell) {
                        const t0Sym = poolA.token0.symbol; const t1Sym = poolA.token1.symbol;
                        logger.info(`[SpatialFinder] NET Opportunity Found! Pair: ${t0Sym}/${t1Sym} (Diff: ${netDiffBips} Bips >= Threshold: ${this.minNetPriceDiffBips})`);
                        logger.info(`  Buy ${t0Sym} on ${poolBuy.dexType} (${poolBuy.address.substring(0,6)}...) | Sell ${t0Sym} on ${poolSell.dexType} (${poolSell.address.substring(0,6)}...)`);

                        const opportunity = this._createOpportunity(poolBuy, poolSell, canonicalKey);
                        if (opportunity) { opportunities.push(opportunity); }
                    }
                } // End inner loop (j)
            } // End outer loop (i)
        } // End loop over canonical pairs

        logger.info(`[SpatialFinder] Finished scan. Found ${opportunities.length} potential spatial opportunities (using NET threshold: ${this.minNetPriceDiffBips}).`);
        return opportunities;
    }

    _createOpportunity(poolBuy, poolSell, canonicalKey) {
        // Determine the initial token to borrow (T1) and intermediate token (T0)
        // Assuming T0/T1 are consistent within the canonical pair
        const tokenToBorrow = poolBuy.token1; // Borrow T1
        const tokenIntermediate = poolBuy.token0; // Intermediate T0

        if (!tokenToBorrow || !tokenIntermediate) {
            logger.error(`[SF._createOpp] Critical: Missing token definitions for pools ${poolBuy.name} / ${poolSell.name}`);
            return null;
        }

        // Determine simulation amount based on the token we BORROW (T1) using config map
        // Use BigInt directly from config map, falling back to DEFAULT
        const simulationAmountIn = this.simulationInputAmounts[tokenToBorrow.symbol] || this.simulationInputAmounts['DEFAULT'];
        if (!simulationAmountIn || typeof simulationAmountIn !== 'bigint' || simulationAmountIn <= 0n) {
             logger.error(`[SF._createOpp] Could not determine valid simulation input amount for ${tokenToBorrow.symbol}. Using DEFAULT failed or invalid.`);
             return null; // Cannot create opportunity without valid input amount
        }


        // Function to extract only necessary state for simulation
        // Ensure all fields potentially needed by any simulator are included
        const extractSimState = (pool) => ({
             address: pool.address, dexType: pool.dexType, fee: pool.fee,
             // V3
             sqrtPriceX96: pool.sqrtPriceX96, tick: pool.tick,
             // V2
             reserve0: pool.reserve0, reserve1: pool.reserve1,
             // DODO (pass all potentially relevant fetched fields)
             queryAmountOutWei: pool.queryAmountOutWei,
             baseTokenSymbol: pool.baseTokenSymbol, // Needed by DODO sim
             queryBaseToken: pool.queryBaseToken, // Needed by DODO sim
             queryQuoteToken: pool.queryQuoteToken, // Needed by DODO sim
             // Always include tokens (ensure they are objects)
             token0: pool.token0, token1: pool.token1
        });

        // Construct the path object for the opportunity
        return {
            type: 'spatial',
            pairKey: canonicalKey,
            tokenIn: tokenToBorrow, // Token object to borrow (T1)
            tokenIntermediate: tokenIntermediate, // Intermediate token object (T0)
            tokenOut: tokenToBorrow, // Token object to repay (T1)

            path: [
                // Hop 1: Buy T0 using T1 on poolBuy
                {
                    dex: poolBuy.dexType,
                    address: poolBuy.address,
                    fee: poolBuy.fee,
                    // Pass symbols/addresses for clarity/potential use elsewhere if needed
                    tokenInSymbol: tokenToBorrow.symbol,
                    tokenOutSymbol: tokenIntermediate.symbol,
                    tokenInAddress: tokenToBorrow.address,
                    tokenOutAddress: tokenIntermediate.address,
                    poolState: extractSimState(poolBuy), // Pass necessary state for simulation
                },
                // Hop 2: Sell T0 for T1 on poolSell
                {
                    dex: poolSell.dexType,
                    address: poolSell.address,
                    fee: poolSell.fee,
                    // Pass symbols/addresses
                    tokenInSymbol: tokenIntermediate.symbol,
                    tokenOutSymbol: tokenToBorrow.symbol,
                    tokenInAddress: tokenIntermediate.address,
                    tokenOutAddress: tokenToBorrow.address,
                    poolState: extractSimState(poolSell), // Pass necessary state for simulation
                }
            ],
            // Use BigInt amount from config map, convert to string for the object
            amountIn: simulationAmountIn.toString(),
            amountOut: '0', // Placeholder, filled by ProfitCalculator
            gasEstimate: '0', // Placeholder, filled by ProfitCalculator
            estimatedProfit: '0', // Placeholder, maybe not used?
            timestamp: Date.now()
        };
     }
} // End SpatialFinder class

module.exports = SpatialFinder;
