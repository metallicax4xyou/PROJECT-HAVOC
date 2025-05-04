// core/profitCalculator.js
// --- VERSION v2.12 --- Extracted detailed profit calculation to core/calculation/profitDetailCalculator.js.

const { ethers } = require('ethers');
const logger = require('../utils/logger');
// Removed PRICE_SCALE, TEN_THOUSAND import from priceCalculation as they are now used in profitDetailCalculator
const { calculateEffectivePrices } = require('./calculation/priceCalculation'); // Only need price calc functions if used here
const { ArbitrageError } = require('../utils/errorHandler');
const { TOKENS } = require('../constants/tokens'); // Import TOKENS to look up token objects
const priceConverter = require('../utils/priceConverter'); // Import the price converter utility
// Import the new detailed profit calculator utility
const { calculateDetailedProfit } = require('./calculation/profitDetailCalculator'); // <-- NEW IMPORT

class ProfitCalculator {
    constructor(config, provider, swapSimulator, gasEstimator, flashSwapManager) {
        logger.info('[ProfitCalculator v2.12] Initializing. Detailed calculation moved to profitDetailCalculator.'); // Version bump
        if (!config) throw new ArbitrageError('ProfitCalculatorInit', 'Missing config.');
        if (!provider) throw new ArbitrageError('ProfitCalculatorInit', 'Missing provider.');
        if (!swapSimulator?.simulateSwap) throw new ArbitrageError('ProfitCalculatorInit', 'Invalid SwapSimulator instance.');
        if (!gasEstimator?.estimateTxGasCost || typeof gasEstimator.estimateTxGasCost !== 'function') throw new ArbitrageError('ProfitCalculatorInit', 'Invalid GasEstimator instance or missing method.');
         if (!flashSwapManager || typeof flashSwapManager.getSignerAddress !== 'function') {
             throw new ArbitrageError('ProfitCalculatorInit', 'Invalid FlashSwapManager instance.');
         }


        this.config = config;
        this.provider = provider;
        this.swapSimulator = swapSimulator;
        this.gasEstimator = gasEstimator;
        this.flashSwapManager = flashSwapManager;

        // Read config values, converting BigInt strings if necessary
         this.minProfitThresholds = config.MIN_PROFIT_THRESHOLDS; // Used directly in calculateDetailedProfit
         // Safely read AAVE_FLASH_LOAN_FEE_BPS, default to 9 (basis points) if missing/invalid
         this.aaveFlashLoanFeeBps = BigInt(config.AAVE_FLASH_LOAN_FEE_BPS || 9);
         if (this.aaveFlashLoanFeeBps < 0n) { // Allow 0 fee
              logger.warn('[ProfitCalculator Init] AAVE_FLASH_LOAN_FEE_BPS is negative. Ensure this is intended.');
              // Don't change to 0n, pass the configured value, calculation utility should handle non-negative fees.
         }

        // Find Native Currency Token object from config.TOKENS
        this.nativeCurrencyToken = Object.values(this.config.TOKENS).find(
             token => token.symbol?.toUpperCase() === this.config.NATIVE_CURRENCY_SYMBOL?.toUpperCase()
             || (this.config.NATIVE_CURRENCY_ADDRESS && token.address?.toLowerCase() === this.config.NATIVE_CURRENCY_ADDRESS.toLowerCase())
         );

         if (!this.nativeCurrencyToken) {
              const wethAddr = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1'.toLowerCase(); // Arbitrum WETH
              const ethSymbol = 'ETH';
              const foundWethOrEth = Object.values(this.config.TOKENS).find(
                 token => token.symbol?.toUpperCase() === ethSymbol || token.address?.toLowerCase() === wethAddr
              );

              if (foundWethOrEth) {
                  this.nativeCurrencyToken = foundWethOrEth;
                   logger.warn(`[ProfitCalculator v2.12] Could not identify Native Currency Token by config.NATIVE_CURRENCY_SYMBOL/ADDRESS, but found a potential match (${this.nativeCurrencyToken.symbol}) in TOKENS. Using this as fallback.`); // Version bump
              } else {
                 logger.error(`[ProfitCalculator v2.12] CRITICAL: Could not identify Native Currency Token object from config.TOKENS by symbol "${this.config.NATIVE_CURRENCY_SYMBOL}" or address "${this.config.NATIVE_CURRENCY_ADDRESS}".`); // Version bump
                 // Create a minimal fallback token object if not found (assuming 18 decimals) - This is a last resort!
                 this.nativeCurrencyToken = {
                     symbol: this.config.NATIVE_CURRENCY_SYMBOL || 'ETH', // Use configured symbol or default
                     decimals: 18, // Assume 18 decimals for native like ETH/WETH
                     address: this.config.NATIVE_CURRENCY_ADDRESS || ethers.ZeroAddress // Use configured address or ZeroAddress
                 };
                 logger.error(`[ProfitCalculator v2.12] Using minimal fallback Native Currency Token object: ${this.nativeCurrencyToken.symbol} (${this.nativeCurrencyToken.address}) with ${this.nativeCurrencyToken.decimals} decimals. Price conversions may be inaccurate or fail.`); // Version bump
              }
         }

        logger.debug('[ProfitCalculator v2.12] Initialized with config:', { // Version bump
            // minProfitThresholds: this.minProfitThresholds, // Don't log full object here, used in detail calc
            aaveFlashLoanFeeBps: this.aaveFlashLoanFeeBps.toString(),
            nativeCurrencySymbol: this.nativeCurrencyToken.symbol,
            nativeCurrencyDecimals: this.nativeCurrencyToken.decimals,
             nativeCurrencyAddress: this.nativeCurrencyToken.address
        });
    }


    /**
     * Calculates the profitability of a given arbitrage opportunity.
     * This involves simulating the swaps, estimating gas costs, and applying fees/thresholds.
     * @param {Array<object>} opportunities - Array of potential opportunity objects from finders.
     * @returns {Promise<Array<object>>} Array of profitable opportunity objects, augmented with profit/cost details.
     */
    async calculate(opportunities) {
        const logPrefix = `[ProfitCalculator v2.12]`; // Version bump
        logger.debug(`${logPrefix} Calculating profitability for ${opportunities.length} opportunities...`);
        const profitableTrades = [];

        // Get signerAddress from the stored FlashSwapManager instance
        let signerAddress;
        try {
            const rawSignerInfo = await this.flashSwapManager.getSignerAddress();
             if (typeof rawSignerInfo === 'string' && ethers.isAddress(rawSignerInfo)) {
                 signerAddress = rawSignerInfo; // Use the string address if valid
                 logger.debug(`${logPrefix} Obtained signer address string from manager: ${signerAddress}`);
             } else {
                 const errorMsg = `FlashSwapManager.getSignerAddress returned unexpected format: ${rawSignerInfo}. Expected a string address.`;
                 logger.error(`${logPrefix} ${errorMsg}. Skipping all opportunities.`);
                 return []; // Return empty array as we cannot proceed without a valid signer address string
             }

        } catch (error) {
            const errorMsg = `Failed to get signer address from FlashSwapManager: ${error.message}`;
            logger.error(`${logPrefix} ${errorMsg}. Skipping all opportunities.`, error);
             return []; // Return empty array on error
        }

        // --- signerAddress is now guaranteed to be a string address if we reach here ---
        logger.debug(`${logPrefix} Using signer address for gas estimation: ${signerAddress}`);


        for (const opportunity of opportunities) {
            const opportunityLogPrefix = `${logPrefix} [${opportunity.type || '?'}-${opportunity.pairKey || '?'}]`;
            logger.debug(`${opportunityLogPrefix} Processing opportunity...`);

            // Ensure initial amountIn is valid before simulation
            const initialAmountIn = BigInt(opportunity.amountIn || 0n);
            if (initialAmountIn <= 0n) {
                 logger.debug(`${opportunityLogPrefix} Initial amountIn is non-positive (${initialAmountIn}). Skipping.`);
                 continue;
            }

            // --- 1. Simulate the swap path ---
            let simulationSuccess = true;
            let currentAmountIn = initialAmountIn;
            let currentAmountOut = 0n; // Amount after the final swap
            let intermediateAmountOut = 0n; // Amount after the first swap (needed for two-hop)
            let simulationError = null;

            logger.debug(`${opportunityLogPrefix} Starting simulation with initial amountIn: ${currentAmountIn.toString()} (raw)`);

            for (let i = 0; i < opportunity.path.length; i++) {
                const step = opportunity.path[i];

                const stepTokenIn = this.config.TOKENS[step.tokenInSymbol];
                const stepTokenOut = this.config.TOKENS[step.tokenOutSymbol];

                if (!stepTokenIn || !stepTokenOut) {
                    simulationError = `Missing Token object for step ${i} (${step.tokenInSymbol || '?' }->${step.tokenOutSymbol || '?'}).`;
                    logger.error(`${opportunityLogPrefix} ${simulationError}`);
                    simulationSuccess = false;
                    break;
                }

                const simResult = await this.swapSimulator.simulateSwap(
                    step.poolState,
                    stepTokenIn,
                    currentAmountIn
                );

                if (!simResult.success) {
                    simulationSuccess = false;
                    simulationError = simResult.error;
                    logger.debug(`${opportunityLogPrefix} Simulation failed for step ${i}. Reason: ${simulationError}`);
                    break;
                }

                currentAmountIn = BigInt(simResult.amountOut || 0n);

                if (i === 0) intermediateAmountOut = currentAmountIn;
                if (i === opportunity.path.length - 1) currentAmountOut = currentAmountIn;
            } // End path iteration

            opportunity.simulationError = simulationError; // Store simulation error reason
            opportunity.amountOut = currentAmountOut; // Final amount after all swaps
            opportunity.intermediateAmountOut = intermediateAmountOut; // Amount after first swap

            // If simulation failed or yielded non-positive output, skip this opportunity
            if (!simulationSuccess || currentAmountOut <= 0n) {
                logger.debug(`${opportunityLogPrefix} Simulation failed or yielded non-positive output (${currentAmountOut}). Skipping.`);
                continue; // Skip to the next opportunity
            }

            logger.debug(`${opportunityLogPrefix} Simulation successful. Final amountOut: ${currentAmountOut.toString()} (raw). Intermediate: ${intermediateAmountOut.toString()}`);


            // --- 2. Estimate Gas Cost ---
            let gasEstimationResult;
            try {
                // The estimator returns { pathGasLimit, effectiveGasPrice, totalCostWei, estimateGasSuccess, errorMessage }
                gasEstimationResult = await this.gasEstimator.estimateTxGasCost(
                    opportunity, // Pass the full opportunity object
                    signerAddress // Pass the VALID signerAddress obtained earlier
                );

                // Validate the returned object structure and success flag
                if (!gasEstimationResult || gasEstimationResult.totalCostWei === undefined || typeof gasEstimationResult.estimateGasSuccess !== 'boolean' || gasEstimationResult.pathGasLimit === undefined) {
                     const errorMsg = `Gas estimation returned invalid result object: ${JSON.stringify(gasEstimationResult)}.`;
                     logger.error(`${opportunityLogPrefix} ${errorMsg}`);
                     opportunity.gasEstimate = { totalCostWei: 0n, pathGasLimit: 0n, effectiveGasPrice: 0n, estimateGasSuccess: false, errorMessage: errorMsg }; // Store failed state
                     continue; // Skip opportunity if the returned value is invalid
                }
                 // Store the *entire* gas estimation result object on the opportunity
                 opportunity.gasEstimate = gasEstimationResult; // Store the object including pathGasLimit, effectiveGasPrice etc.
                 logger.debug(`${opportunityLogPrefix} Gas estimation successful. Total Cost: ${gasEstimationResult.totalCostWei.toString()} wei. EstimateGas check: ${gasEstimationResult.estimateGasSuccess}. Path Gas Limit: ${gasEstimationResult.pathGasLimit?.toString() || 'N/A'}`);

                 // If estimateGas check failed within the estimator, skip this opportunity
                if (!gasEstimationResult.estimateGasSuccess) {
                    logger.debug(`${opportunityLogPrefix} EstimateGas check failed: ${gasEstimationResult.errorMessage || 'No specific message'}. Skipping opportunity.`);
                    continue;
                }

            } catch (gasError) {
                 const errorMsg = `Gas estimation failed unexpectedly: ${gasError.message}`;
                 logger.error(`${opportunityLogPrefix} ${errorMsg}`, gasError);
                 opportunity.gasEstimate = { totalCostWei: 0n, pathGasLimit: 0n, effectiveGasPrice: 0n, estimateGasSuccess: false, errorMessage: errorMsg }; // Store failed state
                 continue; // Skip to the next opportunity if gas estimation throws
            }

            // --- Simulation and Gas Estimation are complete and validated ---
            // --- Now, calculate detailed profit metrics and check final profitability ---

            let isProfitable = false;
            try {
                // --- Use the extracted detailed profit calculator utility ---
                isProfitable = await calculateDetailedProfit(
                    opportunity, // This object will be augmented in place
                    { amountOut: opportunity.amountOut, intermediateAmountOut: opportunity.intermediateAmountOut }, // Pass simulation results
                    opportunity.gasEstimate, // Pass the gas estimation result object
                    this.config, // Pass necessary config parts
                    this.nativeCurrencyToken, // Pass native currency token object
                    this.aaveFlashLoanFeeBps // Pass Aave fee BPS
                );

                // If calculateDetailedProfit throws, it's caught by the outer loop catch block

            } catch (detailCalcError) {
                // This catch block specifically for errors *thrown* by calculateDetailedProfit
                 // The utility should throw ArbitrageErrors for critical issues.
                 logger.error(`${opportunityLogPrefix} Error during detailed profit calculation: ${detailCalcError.message}`, detailCalcError);
                 // The utility should handle its own specific logging inside.
                 // We catch here to prevent the main loop from crashing and continue with the next opportunity.
                 continue; // Skip this opportunity due to calculation error
            }


            // --- 3. Add to Profitable Trades List if deemed profitable ---
            // calculateDetailedProfit handles all the checks (threshold, gas success implicitly)
            if (isProfitable) {
                profitableTrades.push(opportunity);
                logger.debug(`${opportunityLogPrefix} Added to profitable trades list after detailed calculation.`);
            } else {
                 logger.debug(`${opportunityLogPrefix} Not profitable after detailed calculation checks. Skipping.`);
            }


        } // End opportunity loop (for...of)


        logger.info(`${logPrefix} Finished calculation cycle. Found ${profitableTrades.length} profitable trades (after simulation, gas, and detailed profit checks).`);

        return profitableTrades; // Return list of profitable trades that passed all checks
    }

    // --- _convertToNativeWei method removed ---


} // End ProfitCalculator class

module.exports = ProfitCalculator;
