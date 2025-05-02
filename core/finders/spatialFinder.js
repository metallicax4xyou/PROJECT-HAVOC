// core/finders/spatialFinder.js
// --- VERSION v1.16 --- Updated V3 price calculation call and inversion.

const { ethers, formatUnits } = require('ethers');
const logger = require('../../utils/logger');
const { getCanonicalPairKey } = require('../../utils/pairUtils');
// Import the correct price calculation functions from priceCalculation.js
const { calculateV3PriceT1_T0_scaled, calculateSushiPrice, calculateDodoPrice, PRICE_SCALE } = require('../calculation/priceCalculation');
const { TOKENS } = require('../../constants/tokens'); // Ensure TOKENS is imported

const BASIS_POINTS_DENOMINATOR = 10000n; // Constant for basis points calculation

class SpatialFinder {
    /**
     * @param {object} config - The application configuration object.
     */
    constructor(config) {
        logger.debug('[SpatialFinder] Initializing...');

        // --- CORRECTED CONSTRUCTOR VALIDATION ---
        // Ensure essential settings are present in the config object.
        // Check for null or undefined explicitly, as 0n (BigInt zero) is a valid value but falsy in a boolean context.
        const finderSettings = config?.FINDER_SETTINGS;
        const simulationAmounts = finderSettings?.SPATIAL_SIMULATION_INPUT_AMOUNTS;

        if (
            // Check if FINDER_SETTINGS object itself is null or undefined
            finderSettings === undefined || finderSettings === null ||
            // Check if required specific properties within FINDER_SETTINGS are null or undefined
            // These properties are expected to be BigInts, so checking for undefined/null is sufficient.
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

        this.config = config; // Store the full configuration object for later use
        this.pairRegistry = new Map(); // Initialize an empty registry to store pool addresses per canonical pair
        // Read and store specific config values used frequently as class properties.
        // Ensure they are BigInts by casting, although configLoader should handle this if using safeParseBigInt.
        this.minNetPriceDiffBips = BigInt(finderSettings.SPATIAL_MIN_NET_PRICE_DIFFERENCE_BIPS);
        this.maxReasonablePriceDiffBips = BigInt(finderSettings.SPATIAL_MAX_REASONABLE_PRICE_DIFF_BIPS);
        this.simulationInputAmounts = simulationAmounts; // Store the simulation amounts object

        // Log successful initialization with key parameters
        logger.info(`[SpatialFinder v1.16] Initialized. Min Net BIPS: ${this.minNetPriceDiffBips}, Max Diff BIPS: ${this.maxReasonablePriceDiffBips}, Sim Amounts Loaded: ${Object.keys(this.simulationInputAmounts).length} (Filters DODO Quote Sell)`); // Updated version log
    }

    /**
     * Updates the internal pair registry with the latest pool states fetched by the PoolScanner.
     * The registry maps canonical pair keys (e.g., "WETH/USDC") to sets of pool addresses
     * for that pair across all enabled DEXs. This allows the finder to quickly identify
     * all pools for a given pair.
     * @param {Map<string, Set<string>>} registry - The updated pair registry (canonicalKey -> Set<poolAddress>).
     */
    updatePairRegistry(registry) {
        // Validate the input registry
        if (!registry || !(registry instanceof Map)) {
            logger.warn('[SF.updateRegistry] Invalid registry update received. Must be a Map.');
            return; // Do not update the registry with invalid data
        }
        this.pairRegistry = registry; // Update the internal registry
        logger.debug(`[SF.updateRegistry] Pair registry updated. Size: ${this.pairRegistry.size}`);
    }

    /**
     * Calculates the price of token0 in terms of token1 (token0/token1) for a given pool state.
     * Returns the price scaled by PRICE_SCALE (1e18) for consistent BigInt arithmetic.
     * This scaled price is used for comparing prices across different pools and DEX types.
     * @param {object} poolState - The state object for a specific pool, including token info and DEX-specific data (e.g., sqrtPriceX96, reserves).
     * @returns {bigint | null} The price of token0 in token1 scaled by PRICE_SCALE, or null if calculation fails or data is insufficient.
     */
    _calculatePrice(poolState) {
        // Extract necessary properties from the pool state
        const { dexType, token0, token1 } = poolState;
        let price0_1_scaled = null; // Initialize price

        // Essential checks for token data needed for price calculation
        if (!token0 || !token1 || !token0.address || !token1.address || token0.decimals === undefined || token1.decimals === undefined) {
            logger.warn(`[SF._CalcPrice] Missing required token info (address/decimals) for pool ${poolState.address}`);
            // --- ADD DEBUG LOG ---
             logger.debug(`[SF._CalcPrice] Pool ${poolState.address} (${poolState.dexType}) - Missing token info. Returning null.`);
            // --- END DEBUG LOG ---
            return null; // Cannot calculate price without complete token data
        }

        try {
            // Delegate price calculation to priceCalculation functions based on the DEX type
            switch (dexType?.toLowerCase()) {
                case 'uniswapv3':
                    // Call the function that calculates T1/T0 scaled by PRICE_SCALE
                    const priceT1_T0_scaled = calculateV3PriceT1_T0_scaled(poolState);
                    if (priceT1_T0_scaled !== null && priceT1_T0_scaled > 0n) {
                        // Invert to get T0/T1 scaled by PRICE_SCALE
                        price0_1_scaled = (PRICE_SCALE * PRICE_SCALE) / priceT1_T0_scaled;
                    } else {
                        logger.debug(`[SF._CalcPrice] V3 pool ${poolState.address} calculateV3PriceT1_T0_scaled returned null or zero.`);
                        price0_1_scaled = null; // Calculation failed or resulted in zero
                    }
                    break;

                case 'sushiswap': // Assuming SushiSwap uses Uniswap V2 logic
                    // calculateSushiPrice already returns T0/T1 scaled by PRICE_SCALE
                    price0_1_scaled = calculateSushiPrice(poolState);
                    break;

                case 'dodo':
                    // calculateDodoPrice already returns T0/T1 scaled by PRICE_SCALE (assuming T0 is Base, T1 is Quote or handles inverse)
                    price0_1_scaled = calculateDodoPrice(poolState);
                    break;

                // Add cases for other DEX types if needed (e.g., camelot)
                // case 'camelot': ... break;

                default:
                    // Log a warning if the DEX type is unknown or not supported for price calculation
                    logger.warn(`[SF._CalcPrice] Unknown or unsupported dexType for price calculation: ${dexType} for pool ${poolState.address}`);
                    price0_1_scaled = null; // Unknown type, cannot calculate price
            }
        } catch (error) {
            // Catch and log any errors during price calculation
            logger.error(`[SF._CalcPrice] Error calculating price for ${poolState.address}: ${error.message}`, error);
            price0_1_scaled = null; // Calculation failed
        }

        // --- ADD DEBUG LOG FOR FINAL CALCULATED PRICE ---
        if (price0_1_scaled !== null && price0_1_scaled > 0n) {
             try {
                 // Attempt to format the price for human readability in the log
                 // Price is T0/T1 scaled by PRICE_SCALE (1e18)
                  const priceFormatted = ethers.formatUnits(price0_1_scaled, 18); // Format as if T1 has 18 decimals
                  // Inverse price (T1/T0) scaled by 1e18
                  const priceInverseScaled = (PRICE_SCALE * PRICE_SCALE) / price0_1_scaled;
                  const priceInverseFormatted = ethers.formatUnits(priceInverseScaled, 18); // Format as if T0 has 18 decimals

                  logger.debug(`[SF._CalcPrice] Pool ${poolState.address.substring(0,6)} (${poolState.dexType} ${poolState.token0?.symbol}/${poolState.token1?.symbol}) Price (T0/T1 scaled): ${price0_1_scaled.toString()} | T0/T1 (Approx): ${priceFormatted} | T1/T0 (Approx): ${priceInverseFormatted}. Returning price.`);
             } catch (formatError) {
                 logger.error(`[SF._CalcPrice] Error formatting price for log for pool ${poolState.address}: ${formatError.message}`);
                 logger.debug(`[SF._CalcPrice] Pool ${poolState.address.substring(0,6)} (${poolState.dexType} ${poolState.token0?.symbol}/${poolState.token1?.symbol}) Price (T0/T1 scaled): ${price0_1_scaled.toString()}. Returning price.`);
             }
        } else {
             logger.debug(`[SF._CalcPrice] Pool ${poolState.address.substring(0,6)} (${poolState.dexType} ${poolState.token0?.symbol}/${poolState.token1?.symbol}). Price calculation failed or resulted in zero. Returning null.`);
        }
        // --- END DEBUG LOG ---

        return price0_1_scaled; // Return the calculated price or null
    }

    /**
     * Finds potential spatial arbitrage opportunities among the provided pool states.
     * Spatial arbitrage involves discrepancies between the price of the same token pair
     * on different DEX pools.
     * @param {Array<object>} poolStates - An array of pool state objects fetched by the PoolScanner.
     * @returns {Array<object>} An array of potential arbitrage opportunity objects.
     */
    findArbitrage(poolStates) {
        // Change this from info to debug for less verbose per-cycle logs
        logger.debug(`[SpatialFinder] Finding spatial arbitrage from ${poolStates.length} pool states...`);
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

            // --- ADD DEBUG LOG FOR SPECIFIC PAIR ---
             // Focus on the pair we manipulated (USDC-WETH)
             if (canonicalKey === 'USDC-WETH' || canonicalKey === 'WETH-USDC') {
                 logger.debug(`[SF.findArbitrage] Processing canonical pair: ${canonicalKey}. Pools in registry: [${Array.from(poolAddressesSet).join(', ')}]`);
             }
            // --- END DEBUG LOG ---

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


            // --- ADD DEBUG LOG FOR SPECIFIC PAIR AFTER PRICE CALC ---
            // Focus on the pair we manipulated (USDC-WETH or WETH-USDC)
            if (canonicalKey === 'USDC-WETH' || canonicalKey === 'WETH-USDC') {
                logger.debug(`[SF.findArbitrage] Canonical pair ${canonicalKey} after price calculation & filter: ${poolsWithPrices.length} pools with valid prices.`);
                 poolsWithPrices.forEach(p => {
                     try {
                          // Use formatEther for price scaled by 1e18
                          const priceFormatted = ethers.formatEther(p.price0_1_scaled); // Format as if scaled by 1e18
                          // Recalculate inverse for logging clarity
                          const priceInverseScaled = (PRICE_SCALE * PRICE_SCALE) / p.price0_1_scaled;
                          const priceInverseFormatted = ethers.formatEther(priceInverseScaled);

                          logger.debug(`  - Pool ${p.address} (${p.dexType} ${p.token0?.symbol}/${p.token1?.symbol}): Price T0/T1 scaled=${p.price0_1_scaled.toString()} (~${priceFormatted}) | T1/T0 (Approx): ~${priceInverseFormatted}`);
                     } catch (formatError) {
                          logger.error(`Error logging price for pool ${p.address}: ${formatError.message}`);
                          logger.debug(`  - Pool ${p.address} (${p.dexType} ${p.token0?.symbol}/${p.token1?.symbol}): Price T0/T1 scaled=${p.price0_1_scaled.toString()}`);
                     }
                 });
            }
            // --- END DEBUG LOG ---


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
                         logger.error(`[SF CRITICAL LOGIC ERROR] Token mismatch during pool comparison for key ${canonicalKey}! Pools: ${poolA.address} (${poolA.token0?.symbol}/${poolA.token1?.symbol}), ${poolB.address} (${poolB.token0?.symbol}/${poolB.token1?.symbol}).`);
                         continue; // Skip this invalid comparison
                    }

                    const priceA_0_per_1_scaled = poolA.price0_1_scaled; // Price T0/T1 scaled on pool A (1e18)
                    const priceB_0_per_1_scaled = poolB.price0_1_scaled; // Price T0/T1 scaled on pool B (1e18)

                    // --- Determine Buy/Sell Pools based on T0/T1 Price ---
                    let poolLowPrice0_1, poolHighPrice0_1; // poolLowPrice0_1 is where T0 is cheapest (good for buying T0 with T1)
                                                          // poolHighPrice0_1 is where T0 is most expensive (good for selling T0 for T1)

                    if (priceA_0_per_1_scaled < priceB_0_per_1_scaled) { // Pool A has lower T0/T1 price
                        poolLowPrice0_1 = poolA;
                        poolHighPrice0_1 = poolB;
                    } else if (priceB_0_per_1_scaled < priceA_0_per_1_scaled) { // Pool B has lower T0/T1 price
                         poolLowPrice0_1 = poolB;
                         poolHighPrice0_1 = poolA;
                    } else {
                         // Prices are equal or effectively equal, no arbitrage opportunity for this pair combination.
                        continue; // Skip to the next pair of pools
                    }

                    // Sanity check the raw price difference percentage *between the buy and sell pools*
                    // The difference is calculated relative to the 'buy' price (where T0 is cheaper, i.e., poolLowPrice0_1).
                    const rawPriceDiff = poolHighPrice0_1.price0_1_scaled - poolLowPrice0_1.price0_1_scaled; // Difference between high and low price
                    const minRawPrice = poolLowPrice0_1.price0_1_scaled; // The 'buy' price (T0/T1) is the lower one

                    // Avoid division by zero if the lower price is zero (should be caught by filter(p => p.price0_1_scaled > 0n) but double check)
                    if (minRawPrice === 0n) continue;

                    // Calculate the percentage difference in basis points: (High Price - Low Price) / Low Price * 10000
                    // Need to be careful with scaling. Prices are scaled by PRICE_SCALE (1e18).
                    // (rawPriceDiff / PRICE_SCALE) / (minRawPrice / PRICE_SCALE) * 10000
                    // = (rawPriceDiff * PRICE_SCALE) / (minRawPrice * PRICE_SCALE) * 10000 -- no, this cancels PRICE_SCALE
                    // = (rawPriceDiff * 10000) / minRawPrice --- This seems correct for prices scaled by the SAME factor.
                    const rawDiffBips = (rawPriceDiff * BASIS_POINTS_DENOMINATOR) / minRawPrice;

                    // Filter out opportunities with implausibly large raw price differences (potential data errors or manipulations)
                    if (rawDiffBips > this.maxReasonablePriceDiffBips) {
                         // Use the correct variables for logging
                         logger.debug(`[SF] Skipping implausible raw price diff > ${this.maxReasonablePriceDiffBips} BIPS between ${poolLowPrice0_1.name} and ${poolHighPrice0_1.name}`);
                        continue; // Skip opportunities with huge price gaps (often indicate data issues)
                    }

                    // Filter based on the minimum required net price difference (config.MIN_NET_PRICE_DIFFERENCE_BIPS)
                    // This check is a first pass filter based on raw prices.
                    // The ProfitCalculator will later do a more accurate calculation considering fees, gas, slippage, etc.
                    // We only proceed to create an opportunity object if this initial raw difference threshold is met.
                    if (rawDiffBips >= this.minNetPriceDiffBips) {
                         // Get token objects for the pair. Use tokens from either pool (they should be the same for this canonical key)
                         const tokenT0 = poolA.token0; // Token 0 of the canonical pair
                         const tokenT1 = poolA.token1; // Token 1 of the canonical pair

                         // Determine which token is being borrowed/repaid and which is intermediate for the path T1->T0->T1
                         // In the strategy Borrow T1 -> T1->T0 -> T0->T1 -> Repay T1:
                         // tokenBorrowedOrRepaid = T1
                         // tokenIntermediate = T0
                         // Note: This assumes T1 is always the borrowed token. The bot should potentially support borrowing either T0 or T1.
                         // A more flexible approach would involve checking which token can be borrowed (e.g., from Aave)
                         // and constructing paths starting with that token.
                         const tokenBorrowedOrRepaid = tokenT1; // Assuming T1 is the borrow token for this strategy
                         const tokenIntermediate = tokenT0; // Assuming T0 is the intermediate token


                         // Ensure tokens are loaded (safety check, should be done earlier in config/tokenUtils)
                         if (!tokenBorrowedOrRepaid || !tokenIntermediate || !tokenBorrowedOrRepaid.address || !tokenIntermediate.address) {
                             logger.error(`[SF.findArbitrage] Token objects missing or invalid for opportunity creation after price check for pair ${canonicalKey}.`);
                             continue; // Skip creating opportunity if token objects is invalid
                         }


                         // Create the potential opportunity object using the determined buy/sell pools and tokens
                         // Pass the pools in the order of the planned swaps: (Borrowed -> Intermediate) then (Intermediate -> Borrowed)
                         const opportunity = this._createOpportunity(
                             poolLowPrice0_1, // This pool is used for the first swap: tokenBorrowedOrRepaid (T1) -> tokenIntermediate (T0) - Needs T1/T0 price to be high, meaning T0/T1 price is LOW
                             poolHighPrice0_1, // This pool is used for the second swap: tokenIntermediate (T0) -> tokenBorrowedOrRepaid (T1) - Needs T0/T1 price to be high
                             canonicalKey, // Canonical key of the pair
                             tokenBorrowedOrRepaid, // The token assumed to be borrowed/repaid (T1)
                             tokenIntermediate, // The intermediate token (T0)
                             rawDiffBips // Pass the raw difference for potential logging/scoring later
                         );

                         // Add the created opportunity to the list if it was successfully created (_createOpportunity didn't return null)
                         if (opportunity) {
                             opportunities.push(opportunity);
                         }
                    } // End if rawDiffBips >= minNetPriceDiffBips
                } // End inner loop (j) comparing poolB
            } // End outer loop (i) comparing poolA
        } // End loop over canonical pairs

        // Change this from info to debug for less verbose per-cycle logs
        logger.debug(`[SpatialFinder] Finished scan. Found ${opportunities.length} potential spatial opportunities (meeting Raw Diff threshold: ${this.minNetPriceDiffBips}).`);
        return opportunities; // Return the array of potential opportunities found
    }

    // --- _createOpportunity MODIFIED (Accepts pools and tokens based on swap direction) ---
    /**
     * Creates a structured opportunity object for a spatial arbitrage trade.
     * Assumes the flow is: Borrow tokenBorrowedOrRepaid -> Swap tokenBorrowedOrRepaid to tokenIntermediate
     * on poolSwapT1toT0 -> Swap tokenIntermediate to tokenBorrowedOrRepaid on poolSwapT0toT1 -> Repay tokenBorrowedOrRepaid.
     * This object is passed to the ProfitCalculator and TxParamBuilders.
     * @param {object} poolSwapT1toT0 - The pool state for the first swap (Borrow Token -> Intermediate Token). This pool should have a LOW T0/T1 price (high T1/T0 price).
     * @param {object} poolSwapT0toT1 - The pool state for the second swap (Intermediate Token -> Borrow Token). This pool should have a HIGH T0/T1 price.
     * @param {string} canonicalKey - The canonical key of the pair (e.g., "WETH/USDC").
     * @param {object} tokenBorrowedOrRepaid - The Token object for the asset being borrowed and repaid.
     * @param {object} tokenIntermediate - The Token object for the intermediate asset.
     * @param {bigint} rawDiffBips - The raw price difference in basis points for logging/debugging.
     * @returns {object | null} A structured opportunity object representing the potential trade, or null if filtering/checks fail within this function.
     */
    _createOpportunity(poolSwapT1toT0, poolSwapT0toT1, canonicalKey, tokenBorrowedOrRepaid, tokenIntermediate, rawDiffBips) {
        // Log prefix for clarity, includes the canonical key and finder version
        const logPrefix = `[SF._createOpp ${canonicalKey} v1.16]`; // Updated version log

        // Ensure essential inputs are valid Token objects with addresses
        if (!tokenBorrowedOrRepaid?.address || !tokenIntermediate?.address) {
            logger.error(`${logPrefix} Critical: Missing token address definitions for opportunity pools.`);
            return null; // Cannot create opportunity without valid token addresses
        }

        // --- CORRECTED VALIDATION: Check pool's token0/token1 match expected swap direction ---
        // We expect poolSwapT1toT0 to handle T1 -> T0 swap.
        // We expect poolSwapT0toT1 to handle T0 -> T1 swap.

        // Check poolSwapT1toT0
        const pool1InputAddress = poolSwapT1toT0.token0?.address?.toLowerCase() === tokenBorrowedOrRepaid.address.toLowerCase() ? poolSwapT1toT0.token0.address.toLowerCase() : (poolSwapT1toT0.token1?.address?.toLowerCase() === tokenBorrowedOrRepaid.address.toLowerCase() ? poolSwapT1toT0.token1.address.toLowerCase() : null);
        const pool1OutputAddress = poolSwapT1toT0.token0?.address?.toLowerCase() === tokenBorrowedOrRepaid.address.toLowerCase() ? poolSwapT1toT0.token1.address.toLowerCase() : (poolSwapT1toT0.token1?.address?.toLowerCase() === tokenBorrowedOrRepaid.address.toLowerCase() ? poolSwapT1toT0.token0.address.toLowerCase() : null);

        if (pool1InputAddress !== tokenBorrowedOrRepaid.address.toLowerCase() || pool1OutputAddress !== tokenIntermediate.address.toLowerCase()) {
            logger.error(`${logPrefix} Critical: First pool token mismatch with expected swap direction (${tokenBorrowedOrRepaid.symbol}->${tokenIntermediate.symbol}). Pool ${poolSwapT1toT0.address} has tokens ${poolSwapT1toT0.token0?.symbol}/${poolSwapT1toT0.token1?.symbol}.`);
            return null;
        }

        // Check poolSwapT0toT1
        const pool2InputAddress = poolSwapT0toT1.token0?.address?.toLowerCase() === tokenIntermediate.address.toLowerCase() ? poolSwapT0toT1.token0.address.toLowerCase() : (poolSwapT0toT1.token1?.address?.toLowerCase() === tokenIntermediate.address.toLowerCase() ? poolSwapT0toT1.token1.address.toLowerCase() : null);
        const pool2OutputAddress = poolSwapT0toT1.token0?.address?.toLowerCase() === tokenIntermediate.address.toLowerCase() ? poolSwapT0toT1.token1.address.toLowerCase() : (poolSwapT0toT1.token1?.address?.toLowerCase() === tokenIntermediate.address.toLowerCase() ? poolSwapT0toT1.token0.address.toLowerCase() : null);

         if (pool2InputAddress !== tokenIntermediate.address.toLowerCase() || pool2OutputAddress !== tokenBorrowedOrRepaid.address.toLowerCase()) {
             logger.error(`${logPrefix} Critical: Second pool token mismatch with expected swap direction (${tokenIntermediate.symbol}->${tokenBorrowedOrRepaid.symbol}). Pool ${poolSwapT0toT1.address} has tokens ${poolSwapT0toT1.token0?.symbol}/${poolSwapT0toT1.token1?.symbol}.`);
             return null;
         }
        // --- END CORRECTED VALIDATION ---


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
                 // If it's not the base token, it must be the quote token (assuming a standard DODO pair).
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
                     // The filter check `tokenBorrowedOrRepaid.address.toLowerCase() !== baseTokenAddress.toLowerCase()`
                     // is checking if T1 (the borrowed token, input to first swap) is NOT the base token.
                     // If T1 is NOT base, it's quote. So this check fires if T1 is Quote.
                     // This correctly filters the scenario where the first hop inputs the Quote token (T1) to get the Base token (T0).

                     // Keeping this specific filter message at DEBUG level as it indicates a known limitation/filter
                     logger.debug(`${logPrefix} Skipping opportunity: First hop is DODO "Buy Base with Quote" / "Sell Quote" (Swap ${tokenBorrowedOrRepaid.symbol} -> ${tokenIntermediate.symbol} on DODO ${poolSwapT1toT0.address}), which is currently disabled/filtered in SpatialFinder.`);
                     return null; // Filter out this opportunity
                 }
            }
        }
        // --- *** END ADDED FILTER *** ---


        // Determine the amount of the borrowed token (tokenBorrowedOrRepaid) to simulate swapping.
        // Look up the simulation amount first by the token's symbol. If not found, use the 'DEFAULT' amount.
        const simulationAmountIn = this.simulationInputAmounts[tokenBorrowedOrRepaid.symbol] || this.simulationInputAmounts['DEFAULT'];

        // Validate the simulation amount
        if (!simulationAmountIn || typeof simulationAmountIn !== 'bigint' || simulationAmountIn <= 0n) {
             logger.error(`${logPrefix} Could not determine valid simulation input amount for ${tokenBorrowedOrRepaid.symbol}. Using DEFAULT: ${this.simulationInputAmounts['DEFAULT']}. Final Amount: ${simulationAmountIn}`);
             return null; // Cannot create opportunity without a valid, positive simulation amount
        }

        // Helper function to extract essential pool state data needed for simulation and building transaction parameters.
        // Only include properties relevant for simulation or transaction encoding.
        const extractSimState = (pool) => {
             // Basic validation for the pool object
             if (!pool || !pool.address || pool.dexType === undefined || !pool.token0?.address || !pool.token1?.address) {
                  logger.warn(`${logPrefix} Attempted to extract state from invalid pool object.`);
                  return null; // Return null if the pool object is invalid
             }
             // Start with common properties
             const state = {
                 address: pool.address,
                 dexType: pool.dexType,
                 fee: pool.fee, // V3 fee (uint24), V2/DODO default fee (number) - ensure this is consistently handled downstream
                 // Include token objects with full details (address, decimals, symbol, etc.). This is crucial.
                 token0: pool.token0,
                 token1: pool.token1,
                 groupName: pool.groupName // Include group name for context/logging
             };
             // Add DEX-specific state properties needed for simulation/encoding if they exist
             if (pool.dexType === 'uniswapv3') {
                 state.sqrtPriceX96 = pool.sqrtPriceX96;
                 state.tick = pool.tick;
                 state.tickSpacing = pool.tickSpacing;
             } else if (pool.dexType === 'sushiswap') {
                 state.reserve0 = pool.reserve0;
                 state.reserve1 = pool.reserve1;
             } else if (pool.dexType === 'dodo') {
                 // DODO-specific state (assuming fetcher adds these based on its queries)
                 state.queryAmountOutWei = pool.queryAmountOutWei; // Result of amount out query
                 state.queryBaseToken = pool.queryBaseToken; // Base token object used in query
                 state.queryQuoteToken = pool.queryQuoteToken; // Quote token object used in query
                 state.baseTokenSymbol = pool.baseTokenSymbol; // Base token symbol from config/pool file
             }
             // Add Camelot if implemented and needs specific state
             // else if (pool.dexType === 'camelot') { ... }
             return state; // Return the extracted state object
        };

        // Construct the path object representation for the arbitrage opportunity.
        // This structured object is passed through the ProfitCalculator and used by the TxParamBuilders.
        return {
            type: 'spatial', // Type of arbitrage (spatial, triangular, etc.)
            pairKey: canonicalKey, // Canonical key of the token pair involved (e.g., "WETH/USDC")
            tokenIn: tokenBorrowedOrRepaid, // The token that will be borrowed for the flash loan (e.g., T1)
            tokenIntermediate: tokenIntermediate, // The intermediate token received after the first swap (e.g., T0)
            tokenOut: tokenBorrowedOrRepaid, // The token expected to be received after the final swap (should be same as tokenIn)

            // Define the sequence of swaps as an array of SwapStep objects
            path: [
                // Step 1: Swap from tokenIn (T1) to tokenIntermediate (T0) on the first pool
                {
                    dex: poolSwapT1toT0.dexType, // DEX type (e.g., 'uniswapv3', 'sushiswap', 'dodo')
                    address: poolSwapT1toT0.address, // Address of the pool for this step
                    fee: poolSwapT1toT0.fee, // Fee for this pool (relevant for V3)
                    tokenInSymbol: tokenBorrowedOrRepaid.symbol, // Input token symbol for this step
                    tokenOutSymbol: tokenIntermediate.symbol, // Output token symbol for this step
                    tokenInAddress: tokenBorrowedOrRepaid.address, // Input token address
                    tokenOutAddress: tokenIntermediate.address, // Output token address
                    poolState: extractSimState(poolSwapT1toT0), // Include relevant pool state for simulation/encoding
                    minOut: 0n // Minimum output amount for intermediate swaps is typically 0
                },
                // Step 2: Swap from tokenIntermediate (T0) to tokenOut (T1) on the second pool
                {
                    dex: poolSwapT0toT1.dexType,
                    address: poolSwapT0toT1.address,
                    fee: poolSwapT0toT1.fee,
                    tokenInSymbol: tokenIntermediate.symbol,
                    tokenOutSymbol: tokenBorrowedOrRepaid.symbol,
                    tokenInAddress: tokenIntermediate.address,
                    tokenOutAddress: tokenBorrowedOrRepaid.address,
                    poolState: extractSimState(poolSwapT0toT1),
                     // minOut for the final swap will be calculated by ProfitCalculator based on slippage
                    minOut: 0n // Placeholder - ProfitCalculator will set the real minOut for the last step
                }
                // Add more steps here for potentially longer spatial opportunities if needed
            ],

            amountIn: simulationAmountIn, // The amount of tokenIn (borrowed token) used for simulation (BigInt)

            // Placeholders for values calculated by the ProfitCalculator and GasEstimator
            amountOut: 0n, // Amount of tokenOut received after simulation (BigInt)
            intermediateAmountOut: 0n, // Amount of intermediate token received after the first swap (BigInt)
            gasEstimate: 0n, // Estimated total gas cost for the transaction (BigInt)
            estimatedProfit: 0n, // Estimated net profit (after fees and gas) (BigInt)
            profitabilityScore: 0, // Placeholder for a score, e.g., profit per gas

            timestamp: Date.now(), // Timestamp when the opportunity was found
            rawDiffBips: rawDiffBips, // Include the raw BIPS difference for logging/debugging
            borrowTokenSymbol: tokenBorrowedOrRepaid.symbol // Explicitly state the borrow token symbol
        };
     }
} // End SpatialFinder class

module.exports = SpatialFinder;