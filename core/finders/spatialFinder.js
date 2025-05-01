// core/finders/spatialFinder.js
// --- VERSION v1.9 --- Corrected validation for 0n values in constructor. Filters out paths requiring DODO quote sell as first hop.

const { ethers, formatUnits } = require('ethers');
const logger = require('../../utils/logger');
const { getCanonicalPairKey } = require('../../utils/pairUtils');
const { getUniV3Price, getV2Price, getDodoPrice, BIGNUMBER_1E18 } = require('../../utils/priceUtils');
const { TOKENS } = require('../../constants/tokens'); // Ensure TOKENS is imported

const BASIS_POINTS_DENOMINATOR = 10000n;

class SpatialFinder {
    constructor(config) {
        logger.debug('[SpatialFinder] Initializing...');

        // --- CORRECTED CONSTRUCTOR VALIDATION ---
        // Ensure essential settings are present in the config object.
        // Check for null or undefined explicitly, as 0n (BigInt zero) is a valid value but falsy.
        const finderSettings = config?.FINDER_SETTINGS;
        const simulationAmounts = finderSettings?.SPATIAL_SIMULATION_INPUT_AMOUNTS;

        if (
            // Check if FINDER_SETTINGS object itself is null or undefined
            finderSettings === undefined || finderSettings === null ||
            // Check if required specific properties within FINDER_SETTINGS are null or undefined
            finderSettings.SPATIAL_MIN_NET_PRICE_DIFFERENCE_BIPS === undefined || finderSettings.SPATIAL_MIN_NET_PRICE_DIFFERENCE_BIPS === null ||
            finderSettings.SPATIAL_MAX_REASONABLE_PRICE_DIFF_BIPS === undefined || finderSettings.SPATIAL_MAX_REASONABLE_PRICE_DIFF_BIPS === null ||
            // Check if the SPATIAL_SIMULATION_INPUT_AMOUNTS object itself is null or undefined
            simulationAmounts === undefined || simulationAmounts === null ||
            // Check if the 'DEFAULT' key within SPATIAL_SIMULATION_INPUT_AMOUNTS is null or undefined
            simulationAmounts['DEFAULT'] === undefined || simulationAmounts['DEFAULT'] === null
        ) {
            // Construct a list of missing settings for a clear error message
            const missingSettings = [];
            if (finderSettings === undefined || finderSettings === null) missingSettings.push('FINDER_SETTINGS object');
            if (finderSettings?.SPATIAL_MIN_NET_PRICE_DIFFERENCE_BIPS === undefined || finderSettings?.SPATIAL_MIN_NET_PRICE_DIFFERENCE_BIPS === null) missingSettings.push('SPATIAL_MIN_NET_PRICE_DIFFERENCE_BIPS');
            if (finderSettings?.SPATIAL_MAX_REASONABLE_PRICE_DIFF_BIPS === undefined || finderSettings?.SPATIAL_MAX_REASONABLE_PRICE_DIFF_BIPS === null) missingSettings.push('SPATIAL_MAX_REASONABLE_PRICE_DIFF_BIPS');
            if (simulationAmounts === undefined || simulationAmounts === null) missingSettings.push('SPATIAL_SIMULATION_INPUT_AMOUNTS object');
            if (simulationAmounts?.['DEFAULT'] === undefined || simulationAmounts?.['DEFAULT'] === null) missingSettings.push('SPATIAL_SIMULATION_INPUT_AMOUNTS.DEFAULT');

            // Create and throw a specific error instance
            const err = new Error(`Missing or invalid required FINDER_SETTINGS in configuration: ${missingSettings.join(', ')}`);
            err.type = 'SpatialFinder: Init Failed'; // Custom error type for easier handling upstream
            err.details = { configSection: config?.FINDER_SETTINGS, missing: missingSettings }; // Include details for debugging
            logger.error('[SpatialFinder Init] CRITICAL ERROR:', err); // Log the critical error
            throw err; // Stop initialization if essential config is missing
        }
        // --- END CORRECTED VALIDATION ---

        this.config = config; // Store the full configuration object
        this.pairRegistry = new Map(); // Initialize an empty registry to store pool addresses per canonical pair
        // Read and store specific config values used frequently as class properties
        // Ensure they are BigInts if expected (safeParseBigInt in configLoader should handle this)
        this.minNetPriceDiffBips = BigInt(finderSettings.SPATIAL_MIN_NET_PRICE_DIFFERENCE_BIPS);
        this.maxReasonablePriceDiffBips = BigInt(finderSettings.SPATIAL_MAX_REASONABLE_PRICE_DIFF_BIPS);
        this.simulationInputAmounts = simulationAmounts; // Store the simulation amounts object

        // Log successful initialization with key parameters
        logger.info(`[SpatialFinder v1.9] Initialized. Min Net BIPS: ${this.minNetPriceDiffBips}, Max Diff BIPS: ${this.maxReasonablePriceDiffBips}, Sim Amounts Loaded: ${Object.keys(this.simulationInputAmounts).length} (Filters DODO Quote Sell)`);
    }

    /**
     * Updates the internal pair registry with the latest pool states fetched by the PoolScanner.
     * The registry maps canonical pair keys (e.g., "WETH/USDC") to sets of pool addresses
     * for that pair across all enabled DEXs.
     * @param {Map<string, Set<string>>} registry - The updated pair registry (canonicalKey -> Set<poolAddress>).
     */
    updatePairRegistry(registry) {
        if (!registry || !(registry instanceof Map)) {
            logger.warn('[SF.updateRegistry] Invalid registry update received. Must be a Map.');
            return; // Do not update the registry with invalid data
        }
        this.pairRegistry = registry;
        logger.debug(`[SF.updateRegistry] Pair registry updated. Size: ${this.pairRegistry.size}`);
    }

    /**
     * Calculates the price of token0 in terms of token1 (token0/token1) for a given pool state.
     * The price is returned as a BigInt scaled by 1e18 (or potentially 1e36 depending on implementation details).
     * This scaled price is used for comparing prices across different pools and DEX types.
     * @param {object} poolState - The state object for a specific pool, including token info and DEX-specific data (e.g., sqrtPriceX96, reserves).
     * @returns {bigint | null} The price of token0 in token1 scaled by 1e18 (or relevant scale), or null if calculation fails or data is insufficient.
     */
    _calculatePrice(poolState) {
        // Extract necessary properties from the pool state
        const { dexType, token0, token1 } = poolState;

        // Essential checks for token data needed for price calculation
        if (!token0 || !token1 || !token0.address || !token1.address || token0.decimals === undefined || token1.decimals === undefined) {
            logger.warn(`[SF._CalcPrice] Missing required token info (address/decimals) for pool ${poolState.address}`);
            return null; // Cannot calculate price without complete token data
        }

        try {
            // Delegate price calculation to priceUtils based on the DEX type
            switch (dexType?.toLowerCase()) {
                case 'uniswapv3':
                    // UniV3 price is calculated from sqrtPriceX96
                    if (poolState.sqrtPriceX96) {
                        // getUniV3Price returns price T0/T1 scaled by 1e18
                        return getUniV3Price(BigInt(poolState.sqrtPriceX96), token0, token1); // Ensure sqrtPriceX96 is BigInt
                    }
                    break; // Exit switch if sqrtPriceX96 is missing

                case 'sushiswap': // Assuming SushiSwap uses Uniswap V2 logic
                    // V2 price is calculated from reserves
                    if (poolState.reserve0 !== undefined && poolState.reserve1 !== undefined) {
                        // Avoid division by zero if reserves are zero
                        if (BigInt(poolState.reserve0) === 0n || BigInt(poolState.reserve1) === 0n) {
                            // logger.debug(`[SF._CalcPrice] V2 pool ${poolState.address} has zero reserves.`);
                            return null; // Cannot calculate price from zero reserves
                        }
                        // getV2Price returns price T0/T1 scaled by 1e18
                        return getV2Price(BigInt(poolState.reserve0), BigInt(poolState.reserve1), token0, token1); // Ensure reserves are BigInts
                    }
                    break; // Exit switch if reserves are missing

                case 'dodo':
                    // DODO price calculation is more complex and needs amount out query results from the fetcher.
                    // The DodoFetcher queries the pool for amount out when selling/buying a standard amount (e.g., 1e18 Base or 1e6 Quote).
                    // We need `queryAmountOutWei`, `queryBaseToken`, and `queryQuoteToken` from the pool state added by the fetcher.
                    if (poolState.queryAmountOutWei !== undefined && poolState.queryBaseToken && poolState.queryQuoteToken) {
                        // getDodoPrice calculates the effective price Base/Quote based on the query results.
                        // queryAmountOutWei is the amount received when selling a standard input amount (defined in the fetcher).
                        // The standard input amount is assumed to be 1 unit of the queryBaseToken (scaled by its decimals).
                        // If the fetcher uses a different standard input (e.g., 1 of Quote), getDodoPrice needs adjustment.
                        // getDodoPrice returns price Base/Quote scaled by 1e18.
                        const priceBaseInQuote = getDodoPrice(BigInt(poolState.queryAmountOutWei), poolState.queryBaseToken, poolState.queryQuoteToken);

                        if (priceBaseInQuote === null) {
                             // logger.debug(`[SF._CalcPrice] getDodoPrice failed for pool ${poolState.address}.`);
                            return null; // getDodoPrice failed (e.g. division by zero or input amounts)
                        }

                        // The returned price `priceBaseInQuote` is Price(Base in Quote), scaled by 1e18.
                        // We need the price T0/T1, scaled by 1e18.
                        // Check if token0 is the base token for this DODO pool.
                        if (token0.address.toLowerCase() === poolState.queryBaseToken.address.toLowerCase()) {
                            // If token0 is Base and token1 is Quote, priceBaseInQuote is already Price(T0 in T1).
                            return priceBaseInQuote;
                        } else {
                            // If token1 is Base and token0 is Quote, priceBaseInQuote is Price(T1 in T0).
                            // We need the inverse Price(T0 in T1) = 1 / Price(T1 in T0).
                            // Inverting a scaled price P/S becomes S*S/P. Here S=1e18.
                            // Price(T0 in T1) = (1e18 * 1e18) / priceBaseInQuote (scaled).
                            if (priceBaseInQuote === 0n) return null; // Avoid division by zero
                            // This calculation `(BIGNUMBER_1E18 * BIGNUMBER_1E18) / priceBaseInQuote`
                            // effectively scales the inverse price by 1e18 * 1e18. Let's stick to 1e18 scaling.
                            // Correct inverse scaling for price T1/T0 scaled by 1e18 to get T0/T1 scaled by 1e18:
                            // Price(T0/T1) = (Amount of T0) / (Amount of T1)
                            // Price(T1/T0) = (Amount of T1) / (Amount of T0)
                            // If priceBaseInQuote is Price(T1 in T0) scaled by 1e18, and T1 is Base, T0 is Quote:
                            // priceBaseInQuote = (Amount of T1 / Amount of T0) * 1e18
                            // We need Price(T0 in T1) = (Amount of T0 / Amount of T1) * 1e18
                            // This is 1 / (priceBaseInQuote / 1e18) * 1e18 = (1e18 * 1e18) / priceBaseInQuote.
                            // Yes, the original formula `(BIGNUMBER_1E18 * BIGNUMBER_1E18) / priceBaseInQuote`
                            // seems correct for getting T0/T1 scaled by 1e18 if priceBaseInQuote is T1/T0 scaled by 1e18.
                            return (BIGNUMBER_1E18 * BIGNUMBER_1E18) / priceBaseInQuote; // Price T0/T1 scaled by 1e18
                        }
                    }
                     // If DODO state doesn't have query results, cannot calculate price
                    logger.warn(`[SF._CalcPrice] DODO pool state missing query results for price calculation: ${poolState.address}`);
                    return null; // Cannot calculate price without query data

                // Add cases for other DEX types if needed (e.g., camelot)
                // case 'camelot': ... break;

                default:
                    // Log a warning if the DEX type is unknown or not supported for price calculation
                    logger.warn(`[SF._CalcPrice] Unknown or unsupported dexType for price calculation: ${dexType} for pool ${poolState.address}`);
            }
        } catch (error) {
            // Catch and log any errors during price calculation
            logger.error(`[SF._CalcPrice] Error calculating price for ${poolState.address}: ${error.message}`, error);
        }
        return null; // Return null if price calculation fails for any reason
    }


    /**
     * Finds potential spatial arbitrage opportunities among the provided pool states.
     * Spatial arbitrage involves discrepancies between the price of the same token pair
     * on different DEX pools.
     * @param {Array<object>} poolStates - An array of pool state objects fetched by the PoolScanner.
     * @returns {Array<object>} An array of potential arbitrage opportunity objects.
     */
    findArbitrage(poolStates) {
        logger.info(`[SpatialFinder] Finding spatial arbitrage from ${poolStates.length} pool states...`);
        const opportunities = []; // Array to store found opportunities

        // Need at least 2 pools for spatial arbitrage and a populated pair registry
        if (poolStates.length < 2 || this.pairRegistry.size === 0) {
            logger.debug('[SpatialFinder] Skipping scan: Not enough pools or empty registry.');
            return opportunities; // Return empty array if prerequisites not met
        }

        // Create a map of pool addresses to their states for quick lookup (lowercase addresses)
        const poolStateMap = new Map();
        poolStates.forEach(state => {
            if (state?.address) {
                 // Store with lowercase address for case-insensitive lookup
                poolStateMap.set(state.address.toLowerCase(), state);
            } else {
                 // Log a warning for any pool states missing an address
                 logger.warn('[SF.findArbitrage] Skipping pool state with missing address:', state);
            }
        });

        // Iterate over each canonical token pair registered in the pairRegistry
        for (const [canonicalKey, poolAddressesSet] of this.pairRegistry.entries()) {
            // Need at least 2 pools for a specific pair to find an arbitrage opportunity for that pair
            if (poolAddressesSet.size < 2) {
                 logger.debug(`[SF] Skipping canonical pair ${canonicalKey}: Only ${poolAddressesSet.size} pools found in registry.`);
                continue; // Skip to the next canonical pair
            }

            // Get the current pool states for this specific pair from the poolStateMap
            const relevantPoolStates = [];
            poolAddressesSet.forEach(addr => {
                const state = poolStateMap.get(addr.toLowerCase());
                if (state) relevantPoolStates.push(state);
                // Note: If a pool address registered for a pair is not found in the current scan's poolStates, it's simply skipped for this cycle.
            });

            // Need at least 2 *available* pool states with fresh data for this pair
            if (relevantPoolStates.length < 2) {
                 logger.debug(`[SF] Skipping canonical pair ${canonicalKey}: Only ${relevantPoolStates.length} relevant pool states found in current scan.`);
                continue; // Skip to the next canonical pair
            }

            // Calculate the price (T0/T1 scaled) for each relevant pool state and filter out failures
            const poolsWithPrices = relevantPoolStates
                .map(pool => ({ ...pool, price0_1_scaled: this._calculatePrice(pool) }))
                .filter(p => p.price0_1_scaled !== null && p.price0_1_scaled !== undefined && p.price0_1_scaled > 0n); // Ensure price is valid, defined, and positive

            // Need at least 2 pools with valid prices for this pair to find an opportunity
            if (poolsWithPrices.length < 2) {
                 logger.debug(`[SF] Skipping canonical pair ${canonicalKey}: Only ${poolsWithPrices.length} pools with valid prices found.`);
                continue; // Skip to the next canonical pair
            }

            // Now, compare every unique pair of pools for this canonical pair to find arbitrage opportunities.
            // The strategy is: Borrow T1 -> Swap T1->T0 on Pool X -> Swap T0->T1 on Pool Y -> Repay T1.
            // Profit occurs if you get back more T1 than you borrowed.
            // To maximize T0 received for T1 spent: Swap T1->T0 on the pool where T0/T1 price is HIGH (you get more T0 per T1).
            // To maximize T1 received for T0 spent: Swap T0->T1 on the pool where T1/T0 price is HIGH, which means T0/T1 price is LOW.
            // So, for Borrow T1 -> T1->T0 -> T0->T1 -> Repay T1:
            // Pool X (T1->T0): Where price T0/T1 is HIGH.
            // Pool Y (T0->T1): Where price T0/T1 is LOW.

            for (let i = 0; i < poolsWithPrices.length; i++) {
                for (let j = i + 1; j < poolsWithPrices.length; j++) {
                    const poolA = poolsWithPrices[i];
                    const poolB = poolsWithPrices[j];

                    // Ensure tokens match (redundant with pairRegistry loop but safe)
                    if (!poolA.token0?.address || !poolA.token1?.address || !poolB.token0?.address || !poolB.token1?.address ||
                        poolA.token0.address.toLowerCase() !== poolB.token0.address.toLowerCase() ||
                        poolA.token1.address.toLowerCase() !== poolB.token1.address.toLowerCase()) {
                         logger.error(`[SF CRITICAL LOGIC ERROR] Token mismatch during pool comparison for key ${canonicalKey}! Pools: ${poolA.address}, ${poolB.address}.`);
                         continue; // Skip this invalid comparison
                    }

                    const priceA_0_per_1_scaled = poolA.price0_1_scaled; // Price T0/T1 scaled on pool A
                    const priceB_0_per_1_scaled = poolB.price0_1_scaled; // Price T0/T1 scaled on pool B

                    // Determine the BUY T0 (using T1) pool and SELL T0 (for T1) pool based on T0/T1 price
                    let poolBuyT0WithT1, poolSellT0ForT1;
                    if (priceA_0_per_1_scaled > priceB_0_per_1_scaled) {
                        // T0 is more expensive on Pool A (get more T0 for same T1 on B).
                        // Buy T0 on Pool B (where T0/T1 is LOW).
                        // Sell T0 on Pool A (where T0/T1 is HIGH).
                        poolBuyT0WithT1 = poolB; // This pool is used for T1 -> T0 swap
                        poolSellT0ForT1 = poolA; // This pool is used for T0 -> T1 swap
                    } else if (priceB_0_per_1_scaled > priceA_0_per_1_scaled) {
                        // T0 is more expensive on Pool B (get more T0 for same T1 on A).
                        // Buy T0 on Pool A (where T0/T1 is LOW).
                        // Sell T0 on Pool B (where T0/T1 is HIGH).
                        poolBuyT0WithT1 = poolA; // This pool is used for T1 -> T0 swap
                        poolSellT0ForT1 = poolB; // This pool is used for T0 -> T1 swap
                    } else {
                         // Prices are equal or effectively equal, no arbitrage opportunity.
                        continue; // Skip to the next pair of pools
                    }

                    // Sanity check the raw price difference percentage *between the buy and sell pools*
             /**
     * Finds potential spatial arbitrage opportunities among the provided pool states.
     * Spatial arbitrage involves discrepancies between the price of the same token pair
     * on different DEX pools.
     * @param {Array<object>} poolStates - An array of pool state objects fetched by the PoolScanner.
     * @returns {Array<object>} An array of potential arbitrage opportunity objects.
     */
    findArbitrage(poolStates) {
        logger.info(`[SpatialFinder] Finding spatial arbitrage from ${poolStates.length} pool states...`);
        const opportunities = []; // Array to store found opportunities

        // Need at least 2 pools for spatial arbitrage and a populated pair registry
        if (poolStates.length < 2 || this.pairRegistry.size === 0) {
            logger.debug('[SpatialFinder] Skipping scan: Not enough pools or empty registry.');
            return opportunities; // Return empty array if prerequisites not met
        }

        // Create a map of pool addresses to their states for quick lookup (lowercase addresses)
        const poolStateMap = new Map();
        poolStates.forEach(state => {
            if (state?.address) {
                 // Store with lowercase address for case-insensitive lookup
                poolStateMap.set(state.address.toLowerCase(), state);
            } else {
                 // Log a warning for any pool states missing an address
                 logger.warn('[SF.findArbitrage] Skipping pool state with missing address:', state);
            }
        });

        // Iterate over each canonical token pair registered in the pairRegistry
        for (const [canonicalKey, poolAddressesSet] of this.pairRegistry.entries()) {
            // Need at least 2 pools for a specific pair to find an arbitrage opportunity for that pair
            if (poolAddressesSet.size < 2) {
                 logger.debug(`[SF] Skipping canonical pair ${canonicalKey}: Only ${poolAddressesSet.size} pools found in registry.`);
                continue; // Skip to the next canonical pair
            }

            // Get the current pool states for this specific pair from the poolStateMap
            const relevantPoolStates = [];
            poolAddressesSet.forEach(addr => {
                const state = poolStateMap.get(addr.toLowerCase());
                if (state) relevantPoolStates.push(state);
                // Note: If a pool address registered for a pair is not found in the current scan's poolStates, it's simply skipped for this cycle.
            });

            // Need at least 2 *available* pool states with fresh data for this pair
            if (relevantPoolStates.length < 2) {
                 logger.debug(`[SF] Skipping canonical pair ${canonicalKey}: Only ${relevantPoolStates.length} relevant pool states found in current scan.`);
                continue; // Skip to the next canonical pair
            }

            // Calculate the price (T0/T1 scaled) for each relevant pool state and filter out failures
            const poolsWithPrices = relevantPoolStates
                .map(pool => ({ ...pool, price0_1_scaled: this._calculatePrice(pool) }))
                .filter(p => p.price0_1_scaled !== null && p.price0_1_scaled !== undefined && p.price0_1_scaled > 0n); // Ensure price is valid, defined, and positive

            // Need at least 2 pools with valid prices for this pair to find an opportunity
            if (poolsWithPrices.length < 2) {
                 logger.debug(`[SF] Skipping canonical pair ${canonicalKey}: Only ${poolsWithPrices.length} pools with valid prices found.`);
                continue; // Skip to the next canonical pair
            }

            // Now, compare every unique pair of pools for this canonical pair to find arbitrage opportunities.
            // The strategy is: Borrow T1 -> Swap T1->T0 on Pool X -> Swap T0->T1 on Pool Y -> Repay T1.
            // Profit occurs if you get back more T1 than you borrowed.
            // To maximize T0 received for T1 spent: Swap T1->T0 on the pool where T0/T1 price is HIGH (you get more T0 per T1).
            // To maximize T1 received for T0 spent: Swap T0->T1 on the pool where T1/T0 price is HIGH, which means T0/T1 price is LOW.
            // So, for Borrow T1 -> T1->T0 -> T0->T1 -> Repay T1:
            // Pool X (T1->T0): Where price T0/T1 is HIGH.
            // Pool Y (T0->T1): Where price T0/T1 is LOW.

            for (let i = 0; i < poolsWithPrices.length; i++) {
                for (let j = i + 1; j < poolsWithPrices.length; j++) {
                    const poolA = poolsWithPrices[i];
                    const poolB = poolsWithPrices[j];

                    // Ensure tokens match (redundant with pairRegistry loop but safe)
                    if (!poolA.token0?.address || !poolA.token1?.address || !poolB.token0?.address || !poolB.token1?.address ||
                        poolA.token0.address.toLowerCase() !== poolB.token0.address.toLowerCase() ||
                        poolA.token1.address.toLowerCase() !== poolB.token1.address.toLowerCase()) {
                         logger.error(`[SF CRITICAL LOGIC ERROR] Token mismatch during pool comparison for key ${canonicalKey}! Pools: ${poolA.address}, ${poolB.address}.`);
                         continue; // Skip this invalid comparison
                    }

                    const priceA_0_per_1_scaled = poolA.price0_1_scaled; // Price T0/T1 scaled on pool A
                    const priceB_0_per_1_scaled = poolB.price0_1_scaled; // Price T0/T1 scaled on pool B

                    // Determine the BUY T0 (using T1) pool and SELL T0 (for T1) pool based on T0/T1 price
                    let poolBuyT0WithT1, poolSellT0ForT1;
                    if (priceA_0_per_1_scaled > priceB_0_per_1_scaled) {
                        // T0 is more expensive on Pool A (get more T0 for same T1 on B).
                        // Buy T0 on Pool B (where T0/T1 is LOW).
                        // Sell T0 on Pool A (where T0/T1 is HIGH).
                        poolBuyT0WithT1 = poolB; // This pool is used for T1 -> T0 swap
                        poolSellT0ForT1 = poolA; // This pool is used for T0 -> T1 swap
                    } else if (priceB_0_per_1_scaled > priceA_0_per_1_scaled) {
                        // T0 is more expensive on Pool B (get more T0 for same T1 on A).
                        // Buy T0 on Pool A (where T0/T1 is LOW).
                        // Sell T0 on Pool B (where T0/T1 is HIGH).
                        poolBuyT0WithT1 = poolA; // This pool is used for T1 -> T0 swap
                        poolSellT0ForT1 = poolB; // This pool is used for T0 -> T1 swap
                    } else {
                         // Prices are equal or effectively equal, no arbitrage opportunity.
                        continue; // Skip to the next pair of pools
                    }

                    // Sanity check the raw price difference percentage *between the buy and sell pools*
                    // The difference is calculated relative to the 'buy' price (where T0 is cheaper)
                    const rawPriceDiff = poolSellT0ForT1.price0_1_scaled > poolBuyT0WithT1.price0_1_scaled ?
                                         poolSellT0ForT1.price0_1_scaled - poolBuyT0WithT1.price0_1_scaled :
                                         poolBuyT0WithT1.price0_1_scaled - poolSellT0ForT1.price0_1_scaled;
                    const minRawPrice = poolBuyT0WithT1.price0_1_scaled; // The 'buy' price (T0/T1) is the lower one

                    // Avoid division by zero if the lower price is zero
                    if (minRawPrice === 0n) continue;

                    // Calculate the percentage difference in basis points
                    const rawDiffBips = (rawPriceDiff * BASIS_POINTS_DENOMINATOR) / minRawPrice;

                    // Filter out opportunities with implausibly large raw price differences (potential data errors)
                    if (rawDiffBips > this.maxReasonablePriceDiffBips) {
                         logger.debug(`[SF] Skipping implausible raw price diff > ${this.maxReasonablePriceDiffBips} BIPS between ${poolBuyT0WithT1.name} and ${poolSellT0ForT1.name}`);
                        continue; // Skip opportunities with huge price gaps (often indicate data issues)
                    }

                    // Filter based on the minimum required net price difference (config.MIN_NET_PRICE_DIFFERENCE_BIPS)
                    // This check is a first pass filter based on raw prices.
                    // The ProfitCalculator will later do a more accurate calculation considering fees, gas, slippage, etc.
                    if (rawDiffBips >= this.minNetPriceDiffBips) {
                         // Get token objects for the pair. Use tokens from either pool (they should be the same)
                         const tokenT0 = poolA.token0; // Token 0 of the canonical pair
                         const tokenT1 = poolA.token1; // Token 1 of the canonical pair

                         // Determine which token is being borrowed/repaid and which is intermediate for the path T1->T0->T1
                         // In the strategy Borrow T1 -> T1->T0 -> T0->T1 -> Repay T1:
                         // tokenBorrowedOrRepaid = T1
                         // tokenIntermediate = T0
                         const tokenBorrowedOrRepaid = tokenT1; // Assuming T1 is the borrow token for this strategy
                         const tokenIntermediate = tokenT0; // Assuming T0 is the intermediate token


                         // Ensure tokens are loaded (safety check, should be done earlier in config/tokenUtils)
                         if (!tokenBorrowedOrRepaid || !tokenIntermediate || !tokenBorrowedOrRepaid.address || !tokenIntermediate.address) {
                             logger.error(`[SF.findArbitrage] Token objects missing or invalid for opportunity creation after price check for pair ${canonicalKey}.`);
                             continue; // Skip creating opportunity if token objects are invalid
                         }


                         // Create the potential opportunity object using the determined buy/sell pools and tokens
                         const opportunity = this._createOpportunity(
                             poolBuyT0WithT1, // This pool is used for the first swap: tokenBorrowedOrRepaid (T1) -> tokenIntermediate (T0)
                             poolSellT0ForT1, // This pool is used for the second swap: tokenIntermediate (T0) -> tokenBorrowedOrRepaid (T1)
                             canonicalKey, // Canonical key of the pair
                             tokenBorrowedOrRepaid, // The token assumed to be borrowed/repaid (T1)
                             tokenIntermediate // The intermediate token (T0)
                         );

                         // Add the created opportunity to the list if it was successfully created (_createOpportunity didn't return null)
                         if (opportunity) {
                             opportunities.push(opportunity);
                         }
                    } // End if rawDiffBips >= minNetPriceDiffBips
                } // End inner loop (j) comparing poolB
            } // End outer loop (i) comparing poolA
        } // End loop over canonical pairs

        // Log the total number of potential opportunities found after the initial filtering
        logger.info(`[SpatialFinder] Finished scan. Found ${opportunities.length} potential spatial opportunities (meeting Raw Diff threshold: ${this.minNetPriceDiffBips}).`);
        return opportunities; // Return the array of potential opportunities found
    }

    // --- _createOpportunity MODIFIED (Accepts pools and tokens based on swap direction) ---
    /**
     * Creates a structured opportunity object for a spatial arbitrage trade.
     * Assumes the flow is: Borrow tokenBorrowedOrRepaid -> Swap tokenBorrowedOrRepaid to tokenIntermediate
     * on poolSwapT1toT0 -> Swap tokenIntermediate to tokenBorrowedOrRepaid on poolSwapT0toT1 -> Repay tokenBorrowedOrRepaid.
     * This object is passed to the ProfitCalculator and TxParamBuilders.
     * @param {object} poolSwapT1toT0 - The pool state for the first swap (Borrow Token -> Intermediate Token).
     * @param {object} poolSwapT0toT1 - The pool state for the second swap (Intermediate Token -> Borrow Token).
     * @param {string} canonicalKey - The canonical key of the pair (e.g., "WETH/USDC").
     * @param {object} tokenBorrowedOrRepaid - The Token object for the asset being borrowed and repaid.
     * @param {object} tokenIntermediate - The Token object for the intermediate asset.
     * @returns {object | null} A structured opportunity object representing the potential trade, or null if filtering/checks fail within this function.
     */
    _createOpportunity(poolSwapT1toT0, poolSwapT0toT1, canonicalKey, tokenBorrowedOrRepaid, tokenIntermediate) {
        // Log prefix for clarity, includes the canonical key and finder version
        const logPrefix = `[SF._createOpp ${canonicalKey} v1.9]`;

        // Ensure essential inputs are valid Token objects with addresses
        if (!tokenBorrowedOrRepaid?.address || !tokenIntermediate?.address) {
            logger.error(`${logPrefix} Critical: Missing token address definitions for opportunity pools.`);
            return null; // Cannot create opportunity without valid token addresses
        }

        // Ensure the pools provided match the expected token flow directions based on the determined borrow/intermediate tokens
        // First hop validation: poolSwapT1toT0 should swap from tokenBorrowedOrRepaid to tokenIntermediate
        if (poolSwapT1toT0.tokenIn?.address?.toLowerCase() !== tokenBorrowedOrRepaid.address.toLowerCase() ||
            poolSwapT1toT0.tokenOut?.address?.toLowerCase() !== tokenIntermediate.address.toLowerCase()) {
             logger.error(`${logPrefix} Critical: First pool token order mismatch. Expected ${tokenBorrowedOrRepaid.symbol}->${tokenIntermediate.symbol} on ${poolSwapT1toT0.address}. Actual: ${poolSwapT1toT0.tokenIn?.symbol}->${poolSwapT1toT0.tokenOut?.symbol}`);
             return null; // Skip if the first pool's defined tokens don't match the expected swap direction
        }
        // Second hop validation: poolSwapT0toT1 should swap from tokenIntermediate to tokenBorrowedOrRepaid
         if (poolSwapT0toT1.tokenIn?.address?.toLowerCase() !== tokenIntermediate.address.toLowerCase() ||
            poolSwapT0toT1.tokenOut?.address?.toLowerCase() !== tokenBorrowedOrRepaid.address.toLowerCase()) {
             logger.error(`${logPrefix} Critical: Second pool token order mismatch. Expected ${tokenIntermediate.symbol}->${tokenBorrowedOrRepaid.symbol} on ${poolSwapT0toT1.address}. Actual: ${poolSwapT0toT1.tokenIn?.symbol}->${poolSwapT0toT1.tokenOut?.symbol}`);
             return null; // Skip if the second pool's defined tokens don't match the expected swap direction
         }


        // --- *** ADDED DODO QUOTE SELL FILTER *** ---
        // Filter out opportunities where the first hop (Swap T1->T0) involves selling the quote token on a DODO pool.
        // This filter is based on the assumption that selling the quote token directly might not be supported
        // or might have different logic than selling the base token via the DODO pool's sellBase/buyBase functions.
        // If the first pool is a DODO pool:
        if (poolSwapT1toT0.dexType?.toLowerCase() === 'dodo') {
            // Need the DODO pool's base token address to determine if the input token for this step (tokenBorrowedOrRepaid) is the quote token.
            let baseTokenAddress = null;
            // Prioritize getting the baseToken address from the fetcher's added state properties if available (more accurate for specific pool type)
            if (poolSwapT1toT0.queryBaseToken?.address) {
                 baseTokenAddress = poolSwapT1toT0.queryBaseToken.address;
            } else {
                 // Fallback: look up the DODO pool's baseTokenSymbol from config's POOL_CONFIGS and find the corresponding token address in the global TOKENS map
                 // This relies on accurate `baseTokenSymbol` configuration in your pool definition files (e.g., config/pools/arbitrum/dodo.js)
                 const poolInfo = this.config.POOL_CONFIGS?.find(p => p.address.toLowerCase() === poolSwapT1toT0.address.toLowerCase() && p.dexType === 'dodo');
                 const baseTokenSymbol = poolInfo?.baseTokenSymbol;
                 const baseTokenConfig = baseTokenSymbol ? this.config.TOKENS[baseTokenSymbol] : null; // Find the actual Token object
                 baseTokenAddress = baseTokenConfig?.address; // Get the address from the Token object
            }

            if (!baseTokenAddress) {
                // If we can't determine the base token address for this DODO pool, we cannot reliably apply the filter.
                logger.error(`${logPrefix} Cannot determine base token address for DODO pool ${poolSwapT1toT0.address}. Cannot filter quote sell reliably. Skipping opportunity.`);
                 return null; // Safer to skip the opportunity if DODO base token is unknown
            } else {
                 // Check if the input token for the first hop (tokenBorrowedOrRepaid) is NOT the DODO pool's base token.
                 // If the input token is not the base token, it is the quote token (assuming a standard DODO pair).
                 // Swapping quote token -> base token is often done via a 'buyBase' type function,
                 // but the filter is specifically for selling the quote token *as the input*.
                 // Let's refine the check: Is the INPUT token (tokenBorrowedOrRepaid) the DODO pool's quote token?
                 // Quote token address is the base token address if the input token is NOT the base token.
                 if (tokenBorrowedOrRepaid.address.toLowerCase() !== baseTokenAddress.toLowerCase()) {
                     // The input token (tokenBorrowedOrRepaid) is NOT the base token, so it's the quote token.
                     // We are trying to swap Quote -> Base on this DODO pool. This is usually a 'buyBase' operation.
                     // The filter logic here is intended to disable 'Sell Quote' as the first step.
                     // A 'Sell Quote' means you are inputting the quote token to get the base token.
                     // The `poolSwapT1toT0` definition is T1 -> T0.
                     // If T1 is the Quote token, then T0 must be the Base token. Swap Quote -> Base.
                     // Yes, this is a 'buyBase' operation on DODO, inputting Quote to buy Base.
                     // The comment says "filter out paths requiring DODO quote sell". This wording might be confusing.
                     // It likely means disabling the swap direction where you *sell* the quote token *for* the base token *as the first step*.
                     // In the T1->T0 flow: If T1 is Quote, and T0 is Base, you are SELLING the Quote token to BUY the Base token.
                     // The filter check `tokenBorrowedOrRepaid.address.toLowerCase() !== baseTokenAddress.toLowerCase()`
                     // is checking if T1 (the borrowed token, input to first swap) is NOT the base token.
                     // If T1 is NOT base, it's quote. So this check fires if T1 is Quote.
                     // This correctly filters the scenario where the first hop inputs the Quote token (T1) to get the Base token (T0).

                     logger.warn(`${logPrefix} Skipping opportunity: First hop is DODO "Buy Base with Quote" / "Sell Quote" (Swap ${tokenBorrowedOrRepaid.symbol} -> ${tokenIntermediate.symbol} on DODO ${poolSwapT1toT0.address}), which is currently disabled/filtered in SpatialFinder.`);
                     return null; // Filter out this opportunity
                 }
            }
        }
        // --- *** END AD
