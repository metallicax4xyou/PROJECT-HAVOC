// core/finders/spatialFinder.js
// Finds spatial arbitrage opportunities between pools of the same token pair across different DEXs.
// --- VERSION v1.28 --- Corrected import path and function names for price calculation from utils/priceUtils.

const { ethers, formatUnits } = require('ethers');
const logger = require('../../utils/logger');
const { getCanonicalPairKey } = require('../../utils/pairUtils');
// Import the correct price calculation functions and constants from utils/priceUtils.js
// CORRECTED PATH AND FUNCTION NAMES
const {
    calculateV3PriceT0_T1_scaled,
    calculateV2PriceT0_T1_scaled, // Corrected function name for V2/SushiSwap
    calculateDodoPriceT0_T1_scaled, // Corrected function name for DODO
    PRICE_SCALE // Import PRICE_SCALE constant
} = require('../../utils/priceUtils'); // CORRECTED IMPORT PATH

const { TOKENS } = require('../../constants/tokens'); // Ensure TOKENS is imported

const BASIS_POINTS_DENOMINATOR = 10000n; // Constant for basis points calculation

class SpatialFinder {
    /**
     * @param {object} config - The application configuration object.
     */
    constructor(config) {
        logger.debug('[SpatialFinder v1.28] Initializing...'); // Version bump

        const finderSettings = config?.FINDER_SETTINGS;
        const simulationAmounts = finderSettings?.SPATIAL_SIMULATION_INPUT_AMOUNTS;

        // Add debug log to see the incoming finderSettings
        // Use a replacer function for JSON.stringify to handle BigInt
        logger.debug('[SpatialFinder Constructor] Received finderSettings:', JSON.stringify(finderSettings, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));


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
            const missingSettings = [];
            if (finderSettings === undefined || finderSettings === null) missingSettings.push('FINDER_SETTINGS object');
            if (finderSettings?.SPATIAL_MIN_NET_PRICE_DIFFERENCE_BIPS === undefined || finderSettings?.SPATIAL_MIN_NET_PRICE_DIFFERENCE_BIPS === null) missingSettings.push('SPATIAL_MIN_NET_PRICE_DIFFERENCE_BIPS');
            if (finderSettings?.SPATIAL_MAX_REASONABLE_PRICE_DIFF_BIPS === undefined || finderSettings?.SPATIAL_MAX_REASONABLE_PRICE_DIFF_BIPS === null) missingSettings.push('SPATIAL_MAX_REASONABLE_PRICE_DIFF_BIPS');
            if (simulationAmounts === undefined || simulationAmounts === null) missingSettings.push('SPATIAL_SIMULATION_INPUT_AMOUNTS object');
            if (simulationAmounts?.['DEFAULT'] === undefined || simulationAmounts?.['DEFAULT'] === null) missingSettings.push('SPATIAL_SIMULATION_INPUT_AMOUNTS.DEFAULT');

            const err = new Error(`Missing or invalid required FINDER_SETTINGS in configuration: ${missingSettings.join(', ')}`);
            err.type = 'SpatialFinder: Init Failed'; // Custom error type for easier handling upstream
            err.details = { configSection: config?.FINDER_SETTINGS, missing: missingSettings }; // Include details for debugging
            logger.error('[SpatialFinder Init] CRITICAL ERROR:', err); // Log the critical error
            throw err; // Stop initialization if essential config is missing
        }

        this.config = config; // Store the full configuration object for later use
        // Read and store specific config values used frequently as class properties.

        // Add debug logs before conversion
        logger.debug('[SpatialFinder Constructor] Value for SPATIAL_MIN_NET_PRICE_DIFFERENCE_BIPS:', finderSettings.SPATIAL_MIN_NET_PRICE_DIFFERENCE_BIPS);
        logger.debug('[SpatialFinder Constructor] Value for SPATIAL_MAX_REASONABLE_PRICE_DIFF_BIPS:', finderSettings.SPATIAL_MAX_REASONABLE_PRICE_DIFF_BIPS);

        try {
             // Ensure these are cast to BigInt just in case they came from config as numbers
             this.minNetPriceDiffBips = BigInt(finderSettings.SPATIAL_MIN_NET_PRICE_DIFFERENCE_BIPS);
             this.maxReasonablePriceDiffBips = BigInt(finderSettings.SPATIAL_MAX_REASONABLE_PRICE_DIFF_BIPS);
        } catch (bigIntError) {
             logger.error('[SpatialFinder Constructor] Error converting BIPS settings to BigInt:', bigIntError.message);
             const err = new Error(`Invalid BIPS setting format: ${bigIntError.message}`);
             err.type = 'SpatialFinder: Init Failed';
             throw err; // Re-throw with context
        }


        // Ensure simulation input amounts are BigInts where expected
        const processedSimulationAmounts = {};
        for (const [key, value] of Object.entries(simulationAmounts)) {
            try {
                 // Check if the token key exists in the TOKENS constant and is a valid number/string that can be converted to BigInt
                 const tokenExists = TOKENS[key] !== undefined;
                 const isConvertible = typeof value === 'number' || (typeof value === 'string' && !isNaN(Number(value)));

                 if (tokenExists && isConvertible) {
                     // Convert to BigInt, scaling by token decimals IF the value represents standard units (e.g., 100 USDC)
                     // NOTE: The config currently stores simulation amounts in *standard units*.
                     // We need to convert them to *smallest units* (wei/satoshi) using token decimals *before* storing as BigInt.
                     const token = TOKENS[key];
                     processedSimulationAmounts[key] = ethers.parseUnits(value.toString(), token.decimals); // Convert value in standard units to smallest units (BigInt)
                     logger.debug(`[SpatialFinder Constructor] Converted simulation amount for ${key} (${value}) to smallest units: ${processedSimulationAmounts[key].toString()} (decimals: ${token.decimals})`);

                 } else if (key === 'DEFAULT' && isConvertible) {
                      // Handle the default case - needs conversion to smallest units based on a default token (like WETH) or should it be in smallest units already?
                      // Assuming DEFAULT is in standard units of the native currency (ETH/WETH)
                      const nativeToken = TOKENS[config.NATIVE_CURRENCY_SYMBOL || 'WETH']; // Default to WETH if native symbol not clear
                       if (nativeToken && nativeToken.decimals !== undefined) {
                            processedSimulationAmounts[key] = ethers.parseUnits(value.toString(), nativeToken.decimals);
                            logger.debug(`[SpatialFinder Constructor] Converted DEFAULT simulation amount (${value}) based on ${nativeToken.symbol} to smallest units: ${processedSimulationAmounts[key].toString()} (decimals: ${nativeToken.decimals})`);
                       } else {
                            logger.warn(`[SpatialFinder Constructor] Could not determine native token decimals for DEFAULT simulation amount conversion. Value: ${value}. Storing as raw BigInt.`);
                            processedSimulationAmounts[key] = BigInt(value); // Store as raw BigInt if conversion failed
                       }
                 }
                 else {
                      // Store raw BigInt if it's already one, or if conversion logic isn't applicable
                      processedSimulationAmounts[key] = BigInt(value); // Keep raw BigInt or attempt conversion if not already BigInt
                      logger.debug(`[SpatialFinder Constructor] Storing simulation amount for ${key} as raw BigInt or failed conversion: ${processedSimulationAmounts[key].toString()}`);
                 }
            } catch (e) {
                 logger.warn(`[SpatialFinder Constructor] Could not process simulation input amount for key '${key}'. Value: ${value}. Error: ${e.message}`);
                 // Decide how to handle errors: skip the token, use default, or throw?
                 // For now, log and continue, potentially leaving it unprocessed or using a fallback.
                 // A robust system might skip this token or use a safe fallback.
                 // Ensure DEFAULT is handled. If the DEFAULT conversion failed above, this might leave it in a bad state.
            }
        }
         // Double-check DEFAULT is a BigInt after processing
         if (processedSimulationAmounts['DEFAULT'] !== undefined && typeof processedSimulationAmounts['DEFAULT'] !== 'bigint') {
             logger.error('[SpatialFinder Constructor] CRITICAL: DEFAULT simulation input amount is not a BigInt after processing.');
             const err = new Error('Invalid format for DEFAULT simulation input amount after processing.');
             err.type = 'SpatialFinder: Init Failed';
             throw err; // Stop initialization
         }

        this.simulationInputAmounts = processedSimulationAmounts;


        // Log successful initialization with key parameters
        logger.info(`[SpatialFinder v1.28] Initialized. Min Net BIPS: ${this.minNetPriceDiffBips}, Max Diff BIPS: ${this.maxReasonablePriceDiffBips}, Sim Amounts Loaded: ${Object.keys(this.simulationInputAmounts).length}.`); // Updated version log
        // Log simulation amounts after processing
        logger.debug(`[SpatialFinder v1.28] Processed Simulation Input Amounts (in smallest units):`, JSON.stringify(this.simulationInputAmounts, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));

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
             logger.debug(`[SF._CalcPrice] Pool ${poolState.address?.substring(0,6)} (${poolState.dexType}) - Missing token info. Returning null.`);
            return null; // Cannot calculate price without complete token data
        }

        try {
            // Delegate price calculation to price calculation functions from utils/priceUtils based on the DEX type
            switch (dexType?.toLowerCase()) {
                case 'uniswapv3':
                    // Call the function that calculates T0/T1 scaled by PRICE_SCALE for V3
                    price0_1_scaled = calculateV3PriceT0_T1_scaled(poolState); // Correct name
                    break;

                case 'sushiswap': // Assuming SushiSwap uses Uniswap V2 logic
                    // Call the function that calculates T0/T1 scaled by PRICE_SCALE for V2/SushiSwap
                    price0_1_scaled = calculateV2PriceT0_T1_scaled(poolState); // Corrected function name
                    break;

                case 'dodo':
                    // Call the function that calculates T0/T1 scaled by PRICE_SCALE for DODO
                    price0_1_scaled = calculateDodoPriceT0_T1_scaled(poolState); // Corrected function name
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
        // Only log if price calculation was attempted (not null/undefined)
        if (price0_1_scaled !== null && price0_1_scaled !== undefined && price0_1_scaled > 0n) {
             // Only log if the price is positive, otherwise it's likely still an issue or zero liquidity
             if (price0_1_scaled > 0n) {
                 try {
                     // Attempt to format the price for human readability in the log
                     // Price is T0/T1 scaled by PRICE_SCALE (1e18)
                      // Use formatUnits with 18 decimals for the scaled price
                      const priceFormatted_T0_T1 = ethers.formatUnits(price0_1_scaled, 18);

                      // Calculate inverse price (T1/T0) scaled by 1e18 for logging clarity
                      let priceInverseFormatted_T1_T0 = 'N/A';
                      // Ensure no division by zero for inverse calculation
                      if (price0_1_scaled > 0n) {
                          const priceInverseScaled = (PRICE_SCALE * PRICE_SCALE) / price0_1_scaled;
                               // Handle potential division by zero if price0_1_scaled is unexpectedly large after filter? Unlikely but safe.
                              if (priceInverseScaled > 0n) {
                                  priceInverseFormatted_T1_T0 = ethers.formatUnits(priceInverseScaled, 18);
                              } else {
                                  priceInverseFormatted_T1_T0 = 'Calculated 0'; // Inverse results in zero (very large price)
                              }
                          }

                      logger.debug(`[SF._CalcPrice] Pool ${poolState.address?.substring(0,6)} (${poolState.dexType} ${poolState.token0?.symbol}/${poolState.token1?.symbol}) Price (T0/T1 scaled): ${price0_1_scaled.toString()} | T0/T1 (Approx): ${priceFormatted_T0_T1} | T1/T0 (Approx): ${priceInverseFormatted_T1_T0}. Returning price.`);
                 } catch (formatError) {
                      logger.error(`[SF._CalcPrice] Error formatting price for log for pool ${poolState.address}: ${formatError.message}`);
                      logger.debug(`[SF._CalcPrice] Pool ${poolState.address?.substring(0,6)} (${poolState.dexType} ${poolState.token0?.symbol}/${poolState.token1?.symbol}) Price (T0/T1 scaled): ${price0_1_scaled.toString()}`);
                 }
             } else {
                  // Log if price is 0 after calculation (should be caught by filter but for debug)
                  logger.debug(`[SF._CalcPrice] Pool ${poolState.address?.substring(0,6)} (${poolState.dexType} ${poolState.token0?.symbol}/${poolState.token1?.symbol}). Calculated price is 0. Returning null.`);
             }
        } else {
             logger.debug(`[SF._CalcPrice] Pool ${poolState.address?.substring(0,6)} (${poolState.dexType} ${poolState.token0?.symbol}/${poolState.token1?.symbol}). Price calculation failed or resulted in null/undefined. Returning null.`);
        }
        // --- END DEBUG LOG ---

        // Ensure the returned price is null if it's 0 or invalid, so the filter works
        return (price0_1_scaled !== null && price0_1_scaled !== undefined && price0_1_scaled > 0n) ? price0_1_scaled : null;
    }

    /**
     * Finds potential spatial arbitrage opportunities among the provided pool states.
     * Spatial arbitrage involves discrepancies between the price of the same token pair
     * on different DEX pools.
     * @param {Array<object>} poolStates - An array of pool state objects fetched by the PoolScanner.
     * @param {Map<string, Set<string>>} pairRegistry - The pair registry mapping canonicalKey -> Set<poolAddress>. <-- ACCEPT THIS PARAMETER
     * @returns {Array<object>} An array of potential arbitrage opportunity objects.
     */
    findArbitrage(poolStates, pairRegistry) { // <-- ACCEPT THIS PARAMETER
        // Change this from info to debug for less verbose per-cycle logs
        logger.debug(`[SpatialFinder] Finding spatial arbitrage from ${poolStates?.length || 0} pool states...`);
        const opportunities = []; // Array to store found opportunities

        // Use the provided pairRegistry instead of an internal one
        if (!pairRegistry || !(pairRegistry instanceof Map)) {
             logger.error('[SpatialFinder] CRITICAL: Invalid pairRegistry received. Must be a Map.');
             return opportunities; // Cannot proceed without a valid registry
        }

        // Need at least 2 pools overall and a populated pair registry
        if (poolStates?.length < 2 || pairRegistry.size === 0) { // Use the provided pairRegistry here
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
        for (const [canonicalKey, poolAddressesSet] of pairRegistry.entries()) { // Use the provided pairRegistry here

            // --- ADD DEBUG LOG FOR SPECIFIC PAIR ---
             // Focus on pairs likely to cause issues or be involved in tests
             // if (canonicalKey === 'USDC-WETH' || canonicalKey === 'WETH-USDC' || canonicalKey === 'USDC.E-WETH' || canonicalKey === 'WETH-USDC.E' || canonicalKey === 'USDC.E-USDT' || canonicalKey === 'USDT-USDC.E') {
                 logger.debug(`[SF.findArbitrage] Processing canonical pair: ${canonicalKey}. Pools in registry: [${Array.from(poolAddressesSet).join(', ')}]`);
             // }
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
                .map(pool => ({ ...pool, price0_1_scaled: this._calculatePrice(pool) })) // <-- Calling _calculatePrice here
                .filter(p => p.price0_1_scaled !== null && p.price0_1_scaled !== undefined && p.price0_1_scaled > 0n); // Ensure price is valid, defined, and positive


            // --- ADD DEBUG LOG FOR SPECIFIC PAIR AFTER PRICE CALC ---
            // Focus on pairs likely to cause issues or be involved in tests
            // if (canonicalKey === 'USDC-WETH' || canonicalKey === 'WETH-USDC' || canonicalKey === 'USDC.E-WETH' || canonicalKey === 'WETH-USDC.E' || canonicalKey === 'USDC.E-USDT' || canonicalKey === 'USDT-USDC.E') {
                logger.debug(`[SF.findArbitrage] Canonical pair ${canonicalKey} after price calculation & filter: ${poolsWithPrices.length} pools with valid prices.`);
                 poolsWithPrices.forEach(p => {
                     try {
                          // Use formatEther for price scaled by 1e18
                          const priceFormatted_T0_T1 = ethers.formatUnits(p.price0_1_scaled, 18); // Format as if scaled by 1e18

                          // Calculate inverse price (T1/T0) scaled by 1e18 for logging clarity
                          let priceInverseFormatted_T1_T0 = 'N/A';
                          // Ensure no division by zero for inverse calculation
                          if (p.price0_1_scaled > 0n) {
                              const priceInverseScaled = (PRICE_SCALE * PRICE_SCALE) / p.price0_1_scaled;
                               // Handle potential division by zero if price0_1_scaled is unexpectedly large after filter? Unlikely but safe.
                              if (priceInverseScaled > 0n) {
                                  priceInverseFormatted_T1_T0 = ethers.formatUnits(priceInverseScaled, 18);
                              } else {
                                  priceInverseFormatted_T1_T0 = 'Calculated 0'; // Inverse results in zero (very large price)
                              }
                          }

                          logger.debug(`  - Pool ${p.address?.substring(0,6)} (${p.dexType} ${p.token0?.symbol}/${p.token1?.symbol}) Price (T0/T1 scaled): ${p.price0_1_scaled.toString()} | T0/T1 (Approx): ${priceFormatted_T0_T1} | T1/T0 (Approx): ${priceInverseFormatted_T1_T0}.`);
                     } catch (formatError) {
                          logger.error(`[SF.findArbitrage] Error logging price for pool ${p.address}: ${formatError.message}`);
                          logger.debug(`  - Pool ${p.address?.substring(0,6)} (${p.dexType} ${p.token0?.symbol}/${p.token1?.symbol}) Price (T0/T1 scaled): ${p.price0_1_scaled.toString()}`);
                     }
                 });
            // }
            // --- END DEBUG LOG ---


            // Need at least 2 pools with valid prices for this pair to find an opportunity
            if (poolsWithPrices.length < 2) {
                 logger.debug(`[SF] Skipping canonical pair ${canonicalKey}: Only ${poolsWithPrices.length} pools with valid prices found.`);
                continue; // Skip to the next canonical pair
            }

            // Now, compare every unique pair of pools for this canonical pair to find arbitrage opportunities.
            // The strategy is: Borrow T1 -> Swap T1->T0 on Pool X -> Swap T0->T1 on Pool Y -> Repay T1.
            // Profit occurs if you get back more T1 than you borrowed.
            // To maximize T0 received for T1 spent: Swap T1->T0 on the pool where T1/T0 price is HIGH, meaning T0/T1 price is LOW.
            // To maximize T1 received for T0 spent: Swap T0->T1 on the pool where T0/T1 price is HIGH.
            // So, for Borrow T1 -> T1->T0 (Pool A) -> T0->T1 (Pool B) -> Repay T1:
            // Pool A: Where price T0/T1 is LOW. (Buy T0 here - T1 is cheap relative to T0)
            // Pool B: Where price T0/T1 is HIGH. (Sell T0 here - T0 is expensive relative to T1)

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

                    // Determine the Pool to BUY T0 (Sell T1) and the Pool to SELL T0 (Buy T1)
                    // poolBuyT0: Where T0/T1 price is LOW (where you swap T1 -> T0)
                    // poolSellT0: Where T0/T1 price is HIGH (where you swap T0 -> T1)
                    let poolBuyT0, poolSellT0;

                    if (priceA_0_per_1_scaled < priceB_0_per_1_scaled) { // Pool A has lower T0/T1 price
                        poolBuyT0 = poolA; // Buy T0 on Pool A (Swap T1->T0)
                        poolSellT0 = poolB; // Sell T0 on Pool B (Swap T0->T1)
                    } else if (priceB_0_per_1_scaled < priceA_0_per_1_scaled) { // Pool B has lower T0/T1 price
                         poolBuyT0 = poolB; // Buy T0 on Pool B (Swap T1->T0)
                         poolSellT0 = poolA; // Sell T0 on Pool A (Swap T0->T1)
                    } else {
                         // Prices are equal or effectively equal, no arbitrage opportunity for this pair combination.
                         // logger.debug(`[SF] Prices are equal for ${canonicalKey} between ${poolA.name||poolA.address.substring(0,6)} and ${poolB.name||poolB.address.substring(0,6)}. Skipping.`);
                        continue; // Skip to the next pair of pools
                    }

                    // Sanity check the raw price difference percentage *between the buy and sell pools*
                    // The difference is calculated relative to the 'buy' price (where T0 is cheaper relative to T1, i.e., poolBuyT0).
                    const rawPriceDiff = poolSellT0.price0_1_scaled - poolBuyT0.price0_1_scaled; // Difference between high and low price (T0/T1)
                    const minRawPrice = poolBuyT0.price0_1_scaled; // The 'buy' price (T0/T1) is the lower one

                    // Avoid division by zero if the lower price is zero (should be caught by filter(p => p.price0_1_scaled > 0n) but double check)
                    if (minRawPrice === 0n) continue;

                    // Calculate the percentage difference in basis points: (High Price - Low Price) / Low Price * 10000
                    const rawDiffBips = (rawPriceDiff * BASIS_POINTS_DENOMINATOR) / minRawPrice;

                    // Filter out opportunities with implausibly large raw price differences (potential data errors or manipulations)
                    if (rawDiffBips > this.maxReasonablePriceDiffBips) {
                         // Use the correct variables for logging
                         logger.debug(`[SF] Skipping implausible raw price diff > ${this.maxReasonablePriceDiffBips} BIPS between ${poolBuyT0.name || poolBuyT0.address?.substring(0,6)} (Low T0/T1) and ${poolSellT0.name || poolSellT0.address?.substring(0,6)} (High T0/T1). Diff: ${rawDiffBips} BIPS.`); // Added BIPS suffix
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
                         const tokenIntermediate = tokenT0; // The intermediate token is the OTHER token in the pair


                         // Ensure tokens are loaded (safety check, should be done earlier in config/tokenUtils)
                         if (!tokenBorrowedOrRepaid?.address || !tokenIntermediate?.address) {
                             logger.error(`[SF CRITICAL] Token objects missing or invalid for opportunity creation after price check for pair ${canonicalKey}.`); // Added CRITICAL log level
                             continue; // Skip creating opportunity if token objects is invalid
                         }


                         // Create the potential opportunity object using the determined buy/sell pools and tokens
                         // Pass the pools in the order of the planned swaps: (Borrowed -> Intermediate) then (Intermediate -> Borrowed)
                         // The first swap is T1 -> T0, which happens on the pool where T0/T1 price is LOW (poolBuyT0).
                         // The second swap is T0 -> T1, which happens on the pool where T0/T1 price is HIGH (poolSellT0).
                         const opportunity = this._createOpportunity(
                             poolBuyT0, // This pool is used for the first swap: tokenBorrowedOrRepaid (T1) -> tokenIntermediate (T0) - Needs Price(T0/T1) LOW
                             poolSellT0, // This pool is used for the second swap: tokenIntermediate (T0) -> tokenBorrowedOrRepaid (T1) - Needs Price(T0/T1) HIGH
                             canonicalKey, // Canonical key of the pair
                             tokenBorrowedOrRepaid, // The token assumed to be borrowed/repaid (T1)
                             tokenIntermediate, // The intermediate token (T0)
                             rawDiffBips // Pass the raw difference for potential logging/debugging later
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

    /**
     * Creates a structured opportunity object for a spatial arbitrage trade.
     * Assumes the flow is: Borrow tokenBorrowedOrRepaid -> Swap tokenBorrowedOrRepaid to tokenIntermediate
     * on poolSwapBorrowedToIntermediate -> Swap tokenIntermediate to tokenBorrowedOrRepaid on poolSwapIntermediateToBorrowed -> Repay tokenBorrowedOrRepaid.
     * This object is passed to the ProfitCalculator and TxParamBuilders.
     * @param {object} poolSwapBorrowedToIntermediate - The pool state for the first swap (Borrow Token -> Intermediate Token). This pool should have a LOW Price(Intermediate/Borrowed).
     * @param {object} poolSwapIntermediateToBorrowed - The pool state for the second swap (Intermediate Token -> Borrow Token). This pool should have a HIGH Price(Borrowed/Intermediate).
     * @param {string} canonicalKey - The canonical key of the pair (e.g., "WETH/USDC").
     * @param {object} tokenBorrowedOrRepaid - The Token object for the asset being borrowed and repaid.
     * @param {object} tokenIntermediate - The Token object for the intermediate asset.
     * @param {bigint} rawDiffBips - The raw price difference in basis points for logging/debugging.
     * @returns {object | null} A structured opportunity object representing the potential trade, or null if filtering/checks fail within this function.
     */
    _createOpportunity(poolSwapBorrowedToIntermediate, poolSwapIntermediateToBorrowed, canonicalKey, tokenBorrowedOrRepaid, tokenIntermediate, rawDiffBips) {
        // Log prefix for clarity, includes the canonical key and finder version
        const logPrefix = `[SF._createOpp ${canonicalKey} v1.28]`; // Updated version log

        // Ensure essential inputs are valid Token objects with addresses
        if (!tokenBorrowedOrRepaid?.address || !tokenIntermediate?.address) {
            logger.error(`${logPrefix} Critical: Missing token address definitions for opportunity pools.`);
            return null; // Cannot create opportunity without valid token addresses
        }

        // --- DEBUG LOGGING INPUT POOL OBJECTS BEFORE EXTRACTION ---
         // Use a replacer function for JSON.stringify to handle BigInt
         logger.debug(`${logPrefix} Input Pool 1 (Swap Borrowed->Intermediate) before extractSimState:`, JSON.stringify(poolSwapBorrowedToIntermediate, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
         logger.debug(`${logPrefix} Input Pool 2 (Swap Intermediate->Borrowed) before extractSimState:`, JSON.stringify(poolSwapIntermediateToBorrowed, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
        // --- END DEBUG LOGGING ---


        // --- CORRECTED VALIDATION: Check pool's token0/token1 match expected swap direction ---
        // We expect poolSwapBorrowedToIntermediate to handle tokenBorrowedOrRepaid -> tokenIntermediate swap.
        // We expect poolSwapIntermediateToBorrowed to handle tokenIntermediate -> tokenBorrowedOrRepaid swap.

        // Check poolSwapBorrowedToIntermediate (needs tokenBorrowedOrRepaid -> tokenIntermediate swap)
        const pool1InputToken = (poolSwapBorrowedToIntermediate.token0?.address?.toLowerCase() === tokenBorrowedOrRepaid.address.toLowerCase()) ? poolSwapBorrowedToIntermediate.token0 :
                                (poolSwapBorrowedToIntermediate.token1?.address?.toLowerCase() === tokenBorrowedToIntermediate.address.toLowerCase()) ? poolSwapBorrowedToIntermediate.token1 : null; // Fix: Compare with tokenIntermediate

        const pool1OutputToken = (poolSwapBorrowedToIntermediate.token0?.address?.toLowerCase() === tokenBorrowedOrRepaid.address.toLowerCase()) ? poolSwapBorrowedToIntermediate.token1 :
                                 (poolSwapBorrowedToIntermediate.token1?.address?.toLowerCase() === tokenBorrowedToIntermediate.address.toLowerCase()) ? poolSwapBorrowedToIntermediate.token0 : null; // Fix: Compare with tokenIntermediate


        if (!pool1InputToken || !pool1OutputToken || pool1InputToken.address.toLowerCase() !== tokenBorrowedOrRepaid.address.toLowerCase() || pool1OutputToken.address.toLowerCase() !== tokenIntermediate.address.toLowerCase()) {
            logger.error(`${logPrefix} Critical: First pool token mismatch with expected swap direction (${tokenBorrowedOrRepaid.symbol}->${tokenIntermediate.symbol}). Pool ${poolSwapBorrowedToIntermediate.address?.substring(0,6)} has tokens ${poolSwapBorrowedToIntermediate.token0?.symbol}/${poolSwapBorrowedToIntermediate.token1?.symbol}. Determined Input: ${pool1InputToken?.symbol}, Output: ${pool1OutputToken?.symbol}.`);
            return null;
        }

        // Check poolSwapIntermediateToBorrowed (needs tokenIntermediate -> tokenBorrowedOrRepaid swap)
        const pool2InputToken = (poolSwapIntermediateToBorrowed.token0?.address?.toLowerCase() === tokenIntermediate.address.toLowerCase()) ? poolSwapIntermediateToBorrowed.token0 :
                                (poolSwapIntermediateToBorrowed.token1?.address?.toLowerCase() === tokenBorrowedOrRepaid.address.toLowerCase()) ? poolSwapIntermediateToBorrowed.token1 : null; // Fix: Compare with tokenBorrowedOrRepaid

        const pool2OutputToken = (poolSwapIntermediateToBorrowed.token0?.address?.toLowerCase() === tokenIntermediate.address.toLowerCase()) ? poolSwapIntermediateToBorrowed.token1 :
                                 (poolSwapIntermediateToBorrowed.token1?.address?.toLowerCase() === tokenBorrowedOrRepaid.address.toLowerCase()) ? poolSwapIntermediateToBorrowed.token0 : null; // Fix: Compare with tokenBorrowedOrRepaid

         if (!pool2InputToken || !pool2OutputToken || pool2InputToken.address.toLowerCase() !== tokenIntermediate.address.toLowerCase() || pool2OutputToken.address.toLowerCase() !== tokenBorrowedOrRepaid.address.toLowerCase()) {
             logger.error(`${logPrefix} Critical: Second pool token mismatch with expected swap direction (${tokenIntermediate.symbol}->${tokenBorrowedOrRepaid.symbol}). Pool ${poolSwapIntermediateToBorrowed.address?.substring(0,6)} has tokens ${poolSwapIntermediateToBorrowed.token0?.symbol}/${poolSwapIntermediateToBorrowed.token1?.symbol}. Determined Input: ${pool2InputToken?.symbol}, Output: ${pool2OutputToken?.symbol}.`);
             return null;
         }
        // --- END CORRECTED VALIDATION ---


        // --- *** ADDED DODO QUOTE SELL FILTER (First Hop Only) *** ---
        // Filter out opportunities where the first hop (Swap Borrowed -> Intermediate)
        // involves a DODO pool where the *input token* (tokenBorrowedOrRepaid) is the DODO quote token.
        // This is effectively filtering DODO 'buyBase' operations as the first step.
        if (poolSwapBorrowedToIntermediate.dexType?.toLowerCase() === 'dodo') {
            // Need the DODO pool's base token address to determine if the input token for this step (tokenBorrowedOrRepaid) is the quote token.
            // Use the baseTokenSymbol stored in the poolState itself by the DodoFetcher.
            const dodoPoolBaseTokenSymbol = poolSwapBorrowedToIntermediate.baseTokenSymbol;
            const dodoPoolBaseToken = dodoPoolBaseTokenSymbol ? TOKENS[dodoPoolBaseTokenSymbol] : null; // Use TOKENS constant
            const dodoPoolBaseTokenAddress = dodoPoolBaseToken?.address;

            if (!dodoPoolBaseTokenAddress) {
                // If we can't determine the base token address for this DODO pool from poolState, we cannot reliably apply the filter.
                logger.error(`${logPrefix} Cannot determine base token address for DODO pool ${poolSwapBorrowedToIntermediate.address?.substring(0,6)} from poolState. Cannot filter quote sell reliably. Skipping opportunity.`);
                 return null; // Safer to skip the opportunity if DODO base token is unknown
            } else {
                 // Check if the input token for the first hop (tokenBorrowedOrRepaid) is NOT the DODO pool's base token.
                 // If it's not the base token, it must be the quote token (assuming a standard DODO pair).
                 if (tokenBorrowedOrRepaid.address.toLowerCase() !== dodoPoolBaseTokenAddress.toLowerCase()) {
                     // The input token (tokenBorrowedOrRepaid) is NOT the base token of the DODO pool.
                     // This means it's the Quote token. We are trying to swap Quote -> Base.
                     // This is a 'buyBase' operation on DODO. The filter disables this as the first step.
                     // Keeping this specific filter message at DEBUG level as it indicates a known limitation/filter
                     logger.debug(`${logPrefix} Skipping opportunity: First hop is DODO "Buy Base with Quote" / "Sell Quote" (Swap ${tokenBorrowedOrRepaid.symbol} -> ${tokenIntermediate.symbol} on DODO ${poolSwapBorrowedToIntermediate.address?.substring(0,6)}), which is currently disabled/filtered in SpatialFinder.`);
                     return null; // Filter out this opportunity
                 }
            }
        }
        // --- *** END ADDED FILTER *** ---


        // Determine the amount of the borrowed token (tokenBorrowedOrRepaid) to simulate swapping.
        // Look up the simulation amount first by the token's symbol. If not found, use the 'DEFAULT' amount.
        // Ensure the retrieved amount is a BigInt (in smallest units).
        let simulationAmountIn = this.simulationInputAmounts[tokenBorrowedOrRepaid.symbol]; // Get the pre-calculated BigInt smallest unit amount

         // If specific amount not found, use DEFAULT amount.
         if (simulationAmountIn === undefined || simulationAmountIn === null) {
              simulationAmountIn = this.simulationInputAmounts['DEFAULT'];
              logger.debug(`${logPrefix} Using DEFAULT simulation amount for ${tokenBorrowedOrRepaid.symbol}: ${simulationAmountIn.toString()} (smallest units).`);
         } else {
              logger.debug(`${logPrefix} Using specific simulation amount for ${tokenBorrowedOrRepaid.symbol}: ${simulationAmountIn.toString()} (smallest units).`);
         }


        // Validate the simulation amount
        if (simulationAmountIn === undefined || simulationAmountIn === null || typeof simulationAmountIn !== 'bigint' || simulationAmountIn <= 0n) {
             logger.error(`${logPrefix} Could not determine valid BigInt simulation input amount for ${tokenBorrowedOrRepaid.symbol}. Final Amount is invalid: ${simulationAmountIn}`);
             return null; // Cannot create opportunity without a valid, positive BigInt simulation amount
        }


        // Helper function to extract essential pool state data needed for simulation and building transaction parameters.
        // Ensure this handles all necessary fields from fetcher outputs.
        const extractSimState = (pool) => {
             if (!pool || !pool.address || pool.dexType === undefined || !pool.token0?.address || !pool.token1?.address) {
                  logger.warn(`${logPrefix} Attempted to extract state from invalid pool object.`);
                  return null; // Return null if the pool object is invalid
             }
             const state = {
                 address: pool.address,
                 dexType: pool.dexType,
                 fee: pool.fee, // Hopefully in BPS if V2/DODO, uint24 if V3 from config
                 token0: pool.token0,
                 token1: pool.token1,
                 groupName: pool.groupName
             };
             // Add DEX-specific state properties needed for simulation/encoding
             if (pool.dexType?.toLowerCase() === 'uniswapv3') {
                 state.sqrtPriceX96 = pool.sqrtPriceX96;
                 state.tick = pool.tick;
                 state.tickSpacing = pool.tickSpacing;
                 state.liquidity = pool.liquidity;
             } else if (pool.dexType?.toLowerCase() === 'sushiswap') { // V2-like pools
                 state.reserve0 = pool.reserve0;
                 state.reserve1 = pool.reserve1;
             } else if (pool.dexType?.toLowerCase() === 'dodo') {
                 // Include fetched PMM State object if fetcher provides it
                 state.pmmState = pool.pmmState; // Should be the { i, K, B, Q, B0, Q0, R } object
                  // Need baseTokenSymbol for DODO price/swap calcs
                 state.baseTokenSymbol = pool.baseTokenSymbol; // Base token symbol from config/pool file
                  // Need queryAmountOutWei IF used directly in simulator/tx building for DODO
                  // state.queryAmountOutWei = pool.queryAmountOutWei; // Uncomment if needed
                  // state.queryBaseToken = pool.queryBaseToken; // Uncomment if needed
                  // state.queryQuoteToken = pool.queryQuoteToken; // Uncomment if needed
             }
             return state;
        };

        // Construct the path object representation for the arbitrage opportunity.
        // Order of pools in path array matters for transaction building.
        // The first swap is tokenBorrowedOrRepaid (T1) -> tokenIntermediate (T0) on poolSwapBorrowedToIntermediate.
        // The second swap is tokenIntermediate (T0) -> tokenBorrowedOrRepaid (T1) on poolSwapIntermediateToBorrowed.
        const step1PoolState = extractSimState(poolSwapBorrowedToIntermediate);
        const step2PoolState = extractSimState(poolSwapIntermediateToBorrowed);

         if (!step1PoolState || !step2PoolState) {
             logger.error(`${logPrefix} Critical: Failed to extract valid simulation state from one or both pools. Skipping opportunity creation.`);
             return null;
         }


        return {
            type: 'spatial', // Type of arbitrage
            pairKey: canonicalKey, // Canonical key of the token pair
            tokenIn: tokenBorrowedOrRepaid, // The token borrowed (T1)
            tokenIntermediate: tokenIntermediate, // The intermediate token (T0)
            tokenOut: tokenBorrowedOrRepaid, // The token repaid (T1)

            // Define the sequence of swaps as an array of SwapStep objects
            // Order: Borrowed Token -> Intermediate Token on poolSwapBorrowedToIntermediate
            // Then: Intermediate Token -> Borrowed Token on poolSwapIntermediateToBorrowed
            path: [
                // Step 1: Swap from tokenBorrowedOrRepaid to tokenIntermediate
                {
                    dex: poolSwapBorrowedToIntermediate.dexType,
                    address: poolSwapBorrowedToIntermediate.address,
                    fee: poolSwapBorrowedToIntermediate.fee, // Use the fee from the pool state
                    tokenInSymbol: tokenBorrowedOrRepaid.symbol,
                    tokenOutSymbol: tokenIntermediate.symbol,
                    tokenInAddress: tokenBorrowedOrRepaid.address,
                    tokenOutAddress: tokenIntermediate.address,
                    poolState: step1PoolState, // Include extracted pool state
                    minOut: 0n // Min output for intermediate steps typically 0
                },
                // Step 2: Swap from tokenIntermediate to tokenBorrowedOrRepaid
                {
                    dex: poolSwapIntermediateToBorrowed.dexType,
                    address: poolSwapIntermediateToBorrowed.address,
                    fee: poolSwapIntermediateToBorrowed.fee, // Use the fee from the pool state
                    tokenInSymbol: tokenIntermediate.symbol,
                    tokenOutSymbol: tokenBorrowedOrRepaid.symbol,
                    tokenInAddress: tokenIntermediate.address,
                    tokenOutAddress: tokenBorrowedOrRepaid.address,
                    poolState: step2PoolState, // Include extracted pool state
                    minOut: 0n // Placeholder - ProfitCalculator sets real minOut for last step
                }
            ],

            amountIn: simulationAmountIn, // Borrowed amount for simulation (BigInt, in smallest units)

            // Placeholders for values calculated by ProfitCalculator and GasEstimator
            amountOut: 0n, // Amount of tokenOut received after simulation (BigInt)
            intermediateAmountOut: 0n, // Amount after first swap (BigInt)
            gasEstimate: 0n, // Total estimated gas cost (Native Wei)
            estimatedProfit: 0n, // Estimated net profit (Native Wei, after gas, before tithe)
            netProfitNativeWei: 0n, // Same as estimatedProfit, clearer naming
            estimatedProfitForExecutorNativeWei: 0n, // Profit left after tithe (Native Wei)
            titheAmountNativeWei: 0n, // Tithe amount (Native Wei)
            thresholdNativeWei: 0n, // Minimum profit threshold (Native Wei)
            profitPercentage: 0, // Profit % relative to borrowed amount in native terms

            timestamp: Date.now(), // Timestamp when found
            rawDiffBips: rawDiffBips, // Raw price difference in BIPS
            borrowTokenSymbol: tokenBorrowedOrRepaid.symbol // Borrow token symbol
        };
     }
} // End SpatialFinder class

// Export the class
module.exports = SpatialFinder;