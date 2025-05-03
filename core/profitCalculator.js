// core/profitCalculator.js
// --- VERSION v2.9 --- Added robust safeguard for gas estimation failures in calculate method.

const { ethers } = require('ethers');
const logger = require('../utils/logger');
const { calculateEffectivePrices, PRICE_SCALE, TEN_THOUSAND } = require('./calculation/priceCalculation'); // Import price calc functions, PRICE_SCALE, TEN_THOUSAND
const { ArbitrageError } = require('../utils/errorHandler');
const { TOKENS } = require('../constants/tokens'); // Import TOKENS to look up token objects

class ProfitCalculator {
    constructor(config, provider, swapSimulator, gasEstimator) {
        logger.info('[ProfitCalculator v2.9] Initializing. Helpers moved to profitCalcUtils. Handles Aave fee (9 BPS).');
        if (!config) throw new ArbitrageError('ProfitCalculatorInit', 'Missing config.');
        if (!provider) throw new ArbitrageError('ProfitCalculatorInit', 'Missing provider.');
        if (!swapSimulator?.simulateSwap) throw new ArbitrageError('ProfitCalculatorInit', 'Invalid SwapSimulator instance.');
        if (!gasEstimator?.estimateTxGasCost) throw new ArbitrageError('ProfitCalculatorInit', 'Invalid GasEstimator instance.');

        this.config = config;
        this.provider = provider;
        this.swapSimulator = swapSimulator;
        this.gasEstimator = gasEstimator;

        // Read config values, converting BigInt strings if necessary
        // Assuming these are already BigInts from config loader if defined in network files
        this.minProfitThresholds = config.MIN_PROFIT_THRESHOLDS; // Should be an object { SYMBOL: number, ... } - Note: these are numbers in config, converted to BigInt later
        this.profitBufferPercent = BigInt(config.PROFIT_BUFFER_PERCENT); // Percentage as BigInt
        this.aaveFlashLoanFeeBps = BigInt(config.AAVE_FLASH_LOAN_FEE_BPS); // Basis points as BigInt

        // Find Native Currency Token object from config.TOKENS
        this.nativeCurrencyToken = Object.values(this.config.TOKENS).find(
             token => token.symbol?.toUpperCase() === this.config.NATIVE_CURRENCY_SYMBOL?.toUpperCase()
         );

         if (!this.nativeCurrencyToken) {
             logger.warn(`[ProfitCalculator v2.9] Could not identify Native Currency Token object from config.`);
             // Create a fallback token object if not found (assuming 18 decimals)
             this.nativeCurrencyToken = {
                 symbol: this.config.NATIVE_CURRENCY_SYMBOL || 'ETH',
                 decimals: 18,
                 address: ethers.ZeroAddress // Use ZeroAddress as a placeholder for native
             };
             logger.info(`[ProfitCalculator v2.9] Created fallback Native Currency Token object: ${this.nativeCurrencyToken.symbol}`);
         }

        logger.debug('[ProfitCalculator v2.9] Initialized with config:', {
            minProfitThresholds: this.minProfitThresholds, // Log the object structure
            profitBufferPercent: this.profitBufferPercent.toString(),
            aaveFlashLoanFeeBps: this.aaveFlashLoanFeeBps.toString(),
            nativeCurrencySymbol: this.nativeCurrencyToken.symbol,
            nativeCurrencyDecimals: this.nativeCurrencyToken.decimals
        });
    }


    /**
     * Calculates the profitability of a given arbitrage opportunity.
     * This involves simulating the swaps, estimating gas costs, and applying fees/thresholds.
     * @param {Array<object>} opportunities - Array of potential opportunity objects from finders.
     * @param {string} signerAddress - The address that will execute the transaction (used for gas estimation).
     * @returns {Promise<Array<object>>} Array of profitable opportunity objects, augmented with profit/cost details.
     */
    async calculate(opportunities, signerAddress) {
        logger.debug(`[ProfitCalculator] Calculating profitability for ${opportunities.length} opportunities...`);
        const profitableTrades = [];

        // --- Ensure signerAddress is valid before starting calculation loop ---
        if (!signerAddress || !ethers.isAddress(signerAddress)) {
             const errorMsg = "Invalid signerAddress provided for profitability calculation.";
             logger.error(`[ProfitCalculator] ${errorMsg}. Skipping all opportunities.`);
             // Return empty array as no calculations can be performed without a signer
             return [];
        }
        logger.debug(`[ProfitCalculator] Using signer address for gas estimation: ${signerAddress}`);


        for (const opportunity of opportunities) {
            const logPrefix = `[ProfitCalc ${opportunity.type} ${opportunity.pairKey}]`;
            //logger.debug(`${logPrefix} Processing opportunity:`, opportunity); // Too verbose, only log if issues

            // --- 1. Simulate the swap path ---
            let currentAmountIn = opportunity.amountIn; // Starting amount (borrowed)
            let simulationSuccess = true;
            let currentAmountOut = 0n; // Amount after the final swap
            let intermediateAmountOut = 0n; // Amount after the first swap

            logger.debug(`${logPrefix} Starting simulation with initial amountIn: ${currentAmountIn.toString()} (raw)`);

            // Iterate through each step in the swap path
            for (let i = 0; i < opportunity.path.length; i++) {
                const step = opportunity.path[i];

                // Get Token objects for the CURRENT step's input/output
                // Use the token symbols from the step to look up the actual Token objects from config.TOKENS
                const stepTokenIn = this.config.TOKENS[step.tokenInSymbol];
                const stepTokenOut = this.config.TOKENS[step.tokenOutSymbol];

                if (!stepTokenIn || !stepTokenOut) {
                    const errorMsg = `Missing Token object for step ${i} (${step.tokenInSymbol}->${step.tokenOutSymbol}).`;
                    logger.error(`${logPrefix} ${errorMsg}`);
                    simulationSuccess = false;
                    opportunity.simulationError = errorMsg; // Add error detail to opportunity
                    break; // Exit the loop if we can't find the token objects
                }

                // Call the SwapSimulator for this step
                const simResult = await this.swapSimulator.simulateSwap(
                    step.poolState, // poolState for the current step (contains dexType, address, etc.)
                    stepTokenIn, // Pass the correct Token object for this step's input
                    currentAmountIn // amountIn for the current step (output from previous step, or initial amountIn)
                );

                if (!simResult.success) {
                    simulationSuccess = false;
                    logger.debug(`${logPrefix} Simulation failed or returned invalid data for step ${i}. Reason: ${simResult.error}`);
                    opportunity.simulationError = simResult.error; // Store simulation error reason
                    break; // Exit the loop if any simulation step fails
                }

                // Update currentAmountIn for the next step or store final amountOut
                currentAmountIn = simResult.amountOut; // Output of current step is input for next

                if (i === 0) {
                    intermediateAmountOut = simResult.amountOut; // Store amount after the first swap
                }
                if (i === opportunity.path.length - 1) {
                    currentAmountOut = simResult.amountOut; // Store final output after the last swap
                }
            } // End path iteration

            // If simulation failed for any step, skip this opportunity
            if (!simulationSuccess || currentAmountOut <= 0n) {
                logger.debug(`${logPrefix} Simulation failed or yielded non-positive output (${currentAmountOut}). Skipping.`);
                continue; // Skip to the next opportunity
            }

            // Augment opportunity object with simulation results
            opportunity.amountOut = currentAmountOut;
            opportunity.intermediateAmountOut = intermediateAmountOut;
            logger.debug(`${logPrefix} Simulation successful. Final amountOut: ${currentAmountOut.toString()} (raw)`);


            // --- 2. Estimate Gas Cost ---
            let gasCostNativeWei;
            try {
                // Estimate gas for the entire transaction using the path and other data
                const gasCostNativeWeiResult = await this.gasEstimator.estimateTxGasCost(
                    opportunity.type, // e.g., 'spatial'
                    opportunity.path, // The simulated path details
                    opportunity.amountIn, // Initial borrowed amount
                    signerAddress // Address sending the transaction (guaranteed valid by outer check)
                    // Add other necessary parameters for gas estimation if needed (e.g., slippage)
                );

                // Validate the returned value from the estimator
                if (gasCostNativeWeiResult === null || gasCostNativeWeiResult === undefined || typeof gasCostNativeWeiResult !== 'bigint' || gasCostNativeWeiResult < 0n) {
                     const errorMsg = `Gas estimation returned invalid value: ${gasCostNativeWeiResult}.`;
                     logger.error(`${logPrefix} ${errorMsg}`);
                     opportunity.gasEstimationError = errorMsg;
                     continue; // Skip opportunity if the returned value is invalid
                }
                 gasCostNativeWei = gasCostNativeWeiResult; // Assign the validated result
                 opportunity.gasEstimate = gasCostNativeWei; // Augment opportunity object *after* validation

                 logger.debug(`${logPrefix} Gas estimation successful: ${gasCostNativeWei.toString()} wei`);

            } catch (gasError) {
                 // This catches errors THROWN by the estimator
                 const errorMsg = `Gas estimation failed: ${gasError.message}`;
                 logger.error(`${logPrefix} ${errorMsg}`, gasError);
                 opportunity.gasEstimationError = errorMsg; // Store error message
                 continue; // Skip to the next opportunity if gas estimation throws
            }


            // --- 3. Calculate Net Profit ---
            // Net Profit = Amount Out (Borrowed) - Amount In (Borrowed) - Flash Loan Fee (Borrowed) - Gas Cost (Native converted from Borrowed) - Tithe (Native)
            // Net Profit calculations below are based on the simplified mock logic from previous versions.
            // This section needs to be reviewed and potentially replaced with accurate cross-token/cross-dex calculations.

            // Calculate Gross Profit in borrowed token wei
            const grossProfitBorrowedTokenWei = currentAmountOut - opportunity.amountIn;

            // Calculate Flash Loan Fee in borrowed token wei (Assuming Aave fee is on the borrowed amount itself)
            const flashLoanFeeBorrowedTokenWei = (opportunity.amountIn * this.aaveFlashLoanFeeBps) / TEN_THOUSAND;
            opportunity.flashLoanDetails = { // Add details to opportunity for logging
                token: opportunity.tokenIn, // Borrowed token
                amount: opportunity.amountIn, // Borrowed amount
                feeBps: this.aaveFlashLoanFeeBps,
                feeBorrowedTokenWei: flashLoanFeeBorrowedTokenWei, // Fee in borrowed token wei
                feeNativeWei: 0n // Placeholder, calculated below
            };
            logger.debug(`${logPrefix} Gross Profit (Borrowed): ${grossProfitBorrowedTokenWei.toString()} wei. FL Fee (Borrowed): ${flashLoanFeeBorrowedTokenWei.toString()} wei.`);

            const netProfitPreGasBorrowedTokenWei = grossProfitBorrowedTokenWei - flashLoanFeeBorrowedTokenWei;
            logger.debug(`${logPrefix} Net Profit (Pre-Gas, Borrowed): ${netProfitPreGasBorrowedTokenWei.toString()} wei.`);

            if (netProfitPreGasBorrowedTokenWei <= 0n) {
                logger.debug(`${logPrefix} Net Profit (Pre-Gas) is non-positive (${netProfitPreGasBorrowedTokenWei}). Skipping.`);
                continue; // Skip if not profitable before gas and price conversion
            }


            // Convert Net Profit (Pre-Gas, Borrowed Token Wei) to Native Wei
            // This requires the price of Borrowed Token relative to Native Token.
            // Using a mock conversion helper for now. This needs a robust price feed or graph traversal.
            let netProfitPreGasNativeWei = 0n;
            try {
                 netProfitPreGasNativeWei = await this._convertToNativeWei(netProfitPreGasBorrowedTokenWei, opportunity.tokenIn);
                 // Convert Flash Loan Fee (Borrowed Wei) to Native Wei for logging
                 opportunity.flashLoanDetails.feeNativeWei = await this._convertToNativeWei(flashLoanFeeBorrowedTokenWei, opportunity.tokenIn);

                 logger.debug(`${logPrefix} Net Profit (Pre-Gas, Native): ${netProfitPreGasNativeWei.toString()} wei`);

            } catch (conversionError) {
                 logger.error(`${logPrefix} Error converting Net Profit (Borrowed) to Native Wei: ${conversionError.message}`, conversionError);
                 opportunity.conversionError = conversionError.message;
                 continue; // Skip if conversion fails
            }


            // Subtract Gas Cost (already in Native Wei)
             if (netProfitPreGasNativeWei < gasCostNativeWei) {
                 logger.debug(`${logPrefix} Net profit (${netProfitPreGasNativeWei}) less than gas cost (${gasCostNativeWei}). Skipping.`);
                 continue; // Skip if not profitable after gas
             }
            const netProfitAfterGasNativeWei = netProfitPreGasNativeWei - gasCostNativeWei;
            opportunity.netProfitNativeWei = netProfitAfterGasNativeWei; // Augment opportunity object
            logger.debug(`${logPrefix} Net Profit (After Gas, Native): ${netProfitAfterGasNativeWei.toString()} wei`);


            // Apply Minimum Profit Threshold
            // The threshold is defined in the config (in Native Standard units). Convert to Native Wei.
             const thresholdInNativeStandardUnits = this.minProfitThresholds[opportunity.borrowTokenSymbol] || this.minProfitThresholds.DEFAULT;
             const minProfitThresholdNativeWei = BigInt(Math.round(thresholdInNativeStandardUnits * (10 ** this.nativeCurrencyToken.decimals))); // Convert to native wei smallest units
             opportunity.thresholdNativeWei = minProfitThresholdNativeWei; // Store threshold in native wei

            if (netProfitAfterGasNativeWei <= minProfitThresholdNativeWei) {
                logger.debug(`${logPrefix} Net profit (${netProfitAfterGasNativeWei}) below threshold (${minProfitThresholdNativeWei}). Skipping.`);
                continue; // Skip if profit is below threshold
            }
            logger.debug(`${logPrefix} Net profit (${netProfitAfterGasNativeWei}) meets threshold (${minProfitThresholdNativeWei}).`);


            // --- 4. Calculate Tithe ---
            // Tithe is a percentage of the Net Profit (After Gas)
            // Tithe Amount (Native Wei) = Net Profit After Gas (Native Wei) * Tithe Percentage / 100
            // Assuming Tithe Percentage is hardcoded in the contract (30%) or config (need to confirm config source)
            // The contract is coded for 30% (3000 BPS). Let's use that.
            const titheBps = 3000n; // Hardcoded 30% = 3000 BPS
            const titheAmountNativeWei = (netProfitAfterGasNativeWei * titheBps) / TEN_THOUSAND; // Tithe calculated in Native Wei
            opportunity.titheAmountNativeWei = titheAmountNativeWei; // Augment opportunity object
            logger.debug(`${logPrefix} Tithe Amount (Native): ${titheAmountNativeWei.toString()} wei (${titheBps * 100n / TEN_THOUSAND}% of ${netProfitAfterGasNativeWei})`);

            // Calculate Profit Percentage relative to the borrowed amount in Native Wei (for scoring/logging)
            let profitPercentage = 0;
            // Need the borrowed amount in Native Wei for this calculation
            let borrowedAmountNativeWei_ForPercent = 0n;
             try {
                 borrowedAmountNativeWei_ForPercent = await this._convertToNativeWei(opportunity.amountIn, opportunity.tokenIn);
             } catch (conversionError) {
                  logger.warn(`${logPrefix} Error converting borrowed amount to Native for percent calc: ${conversionError.message}`);
                  // Continue, just profitPercentage will remain 0
             }

            if (borrowedAmountNativeWei_ForPercent > 0n) {
                // Percentage = (Net Profit After Gas Native Wei * 10000) / Borrowed Amount Native Wei (in BPS)
                // Convert BPS to percentage by dividing by 100
                profitPercentage = Number((netProfitAfterGasNativeWei * 10000n) / borrowedAmountNativeWei_ForPercent) / 100;
            }
            opportunity.profitPercentage = profitPercentage; // Augment opportunity object
            logger.debug(`${logPrefix} Estimated Profit Percentage: ${profitPercentage}%`);


            // Augment opportunity object with final profit details
            opportunity.estimatedProfit = netProfitAfterGasNativeWei; // Net profit after gas (before tithe)
            const estimatedProfitForExecutorNativeWei = netProfitAfterGasNativeWei - titheAmountNativeWei;
            opportunity.estimatedProfitForExecutorNativeWei = estimatedProfitForExecutorNativeWei; // Profit left for bot after tithe transfer


            // --- 5. Add to Profitable Trades List ---
            profitableTrades.push(opportunity);
            logger.debug(`${logPrefix} Added to profitable trades list.`);

        } // End opportunity loop

        logger.debug(`[ProfitCalculator] Finished calculation. Found ${profitableTrades.length} profitable trades.`);
        logger.info(`[ProfitCalculator] Found ${profitableTrades.length} profitable trades (after gas/threshold).`); // Keep this info log

        return profitableTrades; // Return list of profitable trades
    }

    // Helper function to convert an amount of a token (in smallest units) to Native Wei
    // This is a MOCK placeholder and needs proper implementation using price feeds.
    // It should be moved to a dedicated price conversion utility eventually.
    async _convertToNativeWei(amountWei, tokenObject) {
         // --- MOCK IMPLEMENTATION ---
         if (!tokenObject?.address || tokenObject.decimals === undefined || tokenObject.decimals === null) {
             throw new ArbitrageError("_convertToNativeWei Mock", "Invalid token object for native conversion mock.");
         }
          if (amountWei === undefined || amountWei === null) return 0n; // Handle null/undefined amount
          if (amountWei === 0n) return 0n; // 0 wei of any token is 0 native wei

         // If token is native, return amount directly
         // Check address as well as symbol for robustness
         if (tokenObject.symbol === this.nativeCurrencyToken.symbol || tokenObject.address.toLowerCase() === this.nativeCurrencyToken.address.toLowerCase()) {
             return amountWei;
         }

         // For non-native tokens, use a mock price conversion
         // Need price of Token / Native (Scaled 1e18)
         let tokenNativePriceScaled = 0n;
         // MOCKING based on common tokens relative to WETH (assuming WETH is Native)
         if (this.nativeCurrencyToken.symbol !== 'WETH') {
              // If Native isn't WETH, this mock needs to be updated to convert to the *actual* native.
              // For localFork with Arbitrum Mainnet fork, Native is ETH, which is equivalent to WETH.
              // So this mock is okay for localFork.
              logger.warn(`[_convertToNativeWei Mock] Native currency is ${this.nativeCurrencyToken.symbol}. Mock price conversion might be inaccurate if not WETH/ETH.`);
         }


         if (tokenObject.symbol === 'USDC' || tokenObject.symbol === 'USDC.e' || tokenObject.symbol === 'USDT' || tokenObject.symbol === 'DAI' || tokenObject.symbol === 'FRAX') {
             // Assume stablecoin price relative to Native (~WETH/ETH) is ~1/1850 (using 1850 as ETH/Stablecoin price)
             // Price Stablecoin / Native Standard = 1 / Price Native / Stablecoin Standard
             // Price Native / Stablecoin Standard ~ 1850
             // Scaled Price Stablecoin / Native (1e18) = Price Standard * 1e18
             // Price Stablecoin / Native Standard = Price (Stablecoin wei / Native wei) * (10^NativeDecimals / 10^StablecoinDecimals)
             // Mock Price: Assume 1 Standard Stablecoin = 1/1850 Standard Native (Scaled 1e18)
              tokenNativePriceScaled = PRICE_SCALE / 1850n; // PRICE_SCALE is 1e18

         } else if (tokenObject.symbol === 'WBTC') {
              // Assume WBTC/Native price is ~50 (WBTC is worth about 50 WETH)
              // Mock Price: 1 Standard WBTC = 50 Standard Native (Scaled 1e18)
             tokenNativePriceScaled = 50n * PRICE_SCALE;

         } else {
             // For other tokens (ARB, LINK, GMX, MAGIC), let's just assume 1:1 with Native for testing
             tokenNativePriceScaled = PRICE_SCALE; // Mock Price: 1 Standard Token = 1 Standard Native, scaled by 1e18
         }

         if (tokenNativePriceScaled === 0n) {
              logger.warn(`[_convertToNativeWei Mock] Mock price for ${tokenObject.symbol}/${this.nativeCurrencyToken.symbol} is 0. Cannot convert.`);
              // Return 0n rather than throwing, allows the loop to continue
              return 0n;
         }

         // Convert amount (Token Wei) to Native Wei using the mock price (Price Token/Native, scaled 1e18)
         // Amount Native Wei = (Amount Token Wei * Price (Native/Token Standard)) * (10^NativeDecimals / 10^TokenDecimals)
         // Price (Native/Token Standard) = PRICE_SCALE / tokenNativePriceScaled (Scaled 1e18)
         // Amount Native Wei = (Amount Token Wei * (PRICE_SCALE / tokenNativePriceScaled)) * ((10n ** BigInt(this.nativeCurrencyToken.decimals)) / (10n ** BigInt(tokenObject.decimals)))
         // Amount Native Wei = (Amount Token Wei * PRICE_SCALE * (10^NativeDecimals)) / (tokenNativePriceScaled * (10^TokenDecimals))

         const tokenDecimals = BigInt(tokenObject.decimals);
         const nativeDecimals = BigInt(this.nativeCurrencyToken.decimals);

         const numerator = amountWei * PRICE_SCALE * (10n ** nativeDecimals);
         const denominator = tokenNativePriceScaled * (10n ** tokenDecimals);

         if (denominator === 0n) {
              logger.error(`[_convertToNativeWei Mock] Division by zero during conversion for ${tokenObject.symbol}.`);
              return 0n; // Return 0n on division by zero
         }

         const amountNativeWei = numerator / denominator;
         // logger.debug(`[_convertToNativeWei Mock] Converted ${amountWei.toString()} ${tokenObject.symbol} wei to ${amountNativeWei.toString()} ${this.nativeCurrencyToken.symbol} wei`); // Too verbose

         return amountNativeWei;
         // --- END MOCK IMPLEMENTATION ---
    }


} // End ProfitCalculator class

module.exports = ProfitCalculator;