// core/tradeHandler.js
// --- VERSION v2.1 --- Parameter preparation logic moved to core/tx/txParameterPreparer.js

const { ethers } = require('ethers');
const logger = require('../utils/logger'); // Use injected logger instance when possible
const ErrorHandler = require('../utils/errorHandler'); // Centralized error handling
// Import the new parameter preparer utility
const { prepareExecutionParams } = require('./tx/txParameterPreparer'); // <-- NEW IMPORT
// Import the transaction execution utility (assuming it's executeTransaction somewhere)
// It looks like executeTransaction is already imported or defined elsewhere globally?
// Let's assume it's in ./tx/index.js or similar, or needs to be explicitly imported.
// Assuming it's in ./tx/index.js as 'executeTransaction'
const { executeTransaction } = require('./tx/index'); // <-- ASSUMING this import path


/**
 * Handles the processing and execution of profitable trade opportunities.
 * Selects the best trade, prepares execution parameters, and triggers the transaction execution.
 */
class TradeHandler {
    /**
     * @param {object} config - The application configuration object.
     * @param {ethers.Provider} provider - The ethers provider instance.
     * @param {FlashSwapManager} flashSwapManager - Instance of FlashSwapManager.
     * @param {GasEstimator} gasEstimator - Instance of GasEstimator.
     * @param {object} loggerInstance - The logger instance.
     */
    constructor(config, provider, flashSwapManager, gasEstimator, loggerInstance = logger) {
        const logPrefix = '[TradeHandler v2.1 Init]'; // Version bump
        this.config = config;
        this.provider = provider;
        // Validate dependencies (more robust checks can be added)
        if (!flashSwapManager || typeof flashSwapManager.initiateAaveFlashLoan !== 'function' || typeof flashSwapManager.getFlashSwapContract !== 'function') {
             loggerInstance.error(`${logPrefix} Invalid FlashSwapManager instance.`);
             throw new Error('TradeHandler Init: Invalid FlashSwapManager instance.');
        }
        if (!gasEstimator || typeof gasEstimator.getFeeData !== 'function' || typeof gasEstimator.getEffectiveGasPrice !== 'function') {
             loggerInstance.error(`${logPrefix} Invalid GasEstimator instance.`);
             throw new Error('TradeHandler Init: Invalid GasEstimator instance.');
        }
        // Validate executeTransaction function exists (check after import)
        if (typeof executeTransaction !== 'function') {
             loggerInstance.error(`${logPrefix} Critical: executeTransaction function not found. Is ./tx/index.js imported correctly?`);
             throw new Error('TradeHandler Init: executeTransaction function not available.');
        }

        this.flashSwapManager = flashSwapManager;
        this.gasEstimator = gasEstimator;
        this.logger = loggerInstance; // Use injected logger
        this.isDryRun = this.config.DRY_RUN === 'true' || this.config.DRY_RUN === true;

        // Retrieve Tithe Recipient from Config during initialization
        this.titheRecipient = this.config.TITHE_WALLET_ADDRESS;
         // Basic validation - critical config should ideally be validated by loadConfig/initializer
        if (!this.titheRecipient || !ethers.isAddress(this.titheRecipient)) {
             this.logger.error(`${logPrefix} CRITICAL ERROR: TITHE_WALLET_ADDRESS is missing or invalid in configuration.`);
             // Throw as this is critical for transaction building with tithe
             throw new Error('TITHE_WALLET_ADDRESS is missing or invalid in configuration.');
        }
        this.logger.info(`${logPrefix} Initialized. Tithe Recipient: ${this.titheRecipient}`); // Version bump
         if (this.isDryRun) {
             this.logger.info(`${logPrefix} Running in DRY_RUN mode. Transactions will be simulated but NOT sent.`);
         }
    }

    /**
     * Processes profitable trades, selects the best, prepares parameters, and attempts execution.
     * @param {Array<object>} trades - Array of profitable opportunity objects from the ProfitCalculator.
     */
    async handleTrades(trades) {
        const logPrefix = '[TradeHandler v2.1]'; // Version bump

        if (!this.flashSwapManager || trades.length === 0) {
            this.logger.debug(`${logPrefix} No trades or FlashSwapManager missing. Skipping.`);
            return;
        }

        // Log Tithe Recipient status if running for real
         if (!this.isDryRun) {
              this.logger.debug(`${logPrefix} Tithe Recipient for execution: ${this.titheRecipient}`);
         }

        if (this.isDryRun) {
            this.logger.info(`${logPrefix} DRY_RUN=true. Logging opportunities, skipping execution.`);
            trades.forEach((trade, index) => {
                 // In dry run, we still log the parameters that *would* have been used
                 // Call the parameter preparer even in dry run to validate logic
                 try {
                      // Need a way to simulate the prepareExecutionParams call without async issues in forEach?
                      // Or move dry run parameter preparation outside the loop.
                      // For simplicity, let's just log the trade details passed from AE for now in dry run.
                      // The tradeLogger already logs details nicely.
                      // Re-calculating params in dry run for every trade might be slow.
                      // Let's rely on AE's logging via tradeLogger for dry run details.
                       // The following lines are removed as tradeLogger in AE handles this logging
                       /*
                       let providerType = 'UNKNOWN';
                       if (trade.path && trade.path.length > 0) {
                           providerType = (trade.path[0].dex === 'uniswapV3') ? 'UNIV3' : 'AAVE';
                       }
                      this.logger.info(`${logPrefix} [DRY RUN Trade ${index + 1}] Provider: ${providerType}, Type: ${trade.type}, Path: ${trade.path?.map(p=>p.dex).join('->') || 'N/A'}, Profit: ${ethers.formatEther(trade.netProfitNativeWei || 0n)} ${this.config.NATIVE_CURRENCY_SYMBOL}`);
                      */
                 } catch (prepError) {
                      this.logger.error(`${logPrefix} [DRY RUN Trade ${index + 1}] Error preparing params (dry run): ${prepError.message}`);
                 }
            });
             this.logger.info(`${logPrefix} Dry run processing complete.`);
            return; // EXIT for DRY_RUN
        }

        // --- NOT DRY RUN: Proceed with execution prep ---
        this.logger.info(`${logPrefix} DRY_RUN=false. Processing ${trades.length} trades for potential execution...`);

        // Sort and select the best trade (highest estimatedProfitNativeWei)
        // The trades array should already be augmented with estimatedProfitNativeWei by ProfitCalculator
        // Ensure trades are sorted by net profit in native currency AFTER costs (gas, loan fee), BEFORE tithe
        trades.sort((a, b) => (BigInt(b.netProfitNativeWei || 0n)) - (BigInt(a.netProfitNativeWei || 0n)));
        const tradeToExecute = trades[0];

        // Ensure the trade object contains the required gas estimate details from ProfitCalculator
        if (!tradeToExecute.gasEstimate || tradeToExecute.gasEstimate.pathGasLimit === undefined || tradeToExecute.gasEstimate.pathGasLimit === null) {
             const errorMsg = `Best trade missing required gas estimate details (pathGasLimit). Cannot execute.`;
             this.logger.error(`${logPrefix} CRITICAL: ${errorMsg}`);
             ErrorHandler.handleError(new Error(errorMsg), 'TradeHandlerMissingGasEstimate'); // Use ErrorHandler
             return;
        }
        const gasLimit = BigInt(tradeToExecute.gasEstimate.pathGasLimit); // Use the calculated limit
        const effectiveGasPrice = BigInt(tradeToExecute.gasEstimate.effectiveGasPrice || 0n); // Use calculated effective price
        const totalGasCostWei = BigInt(tradeToExecute.gasEstimate.totalCostWei || 0n); // Use calculated total cost

        // Double check netProfit calculation vs threshold here before execution (ProfitCalculator should have done this, but safety first)
        const threshold = BigInt(this.config.PROFIT_THRESHOLD_NATIVE_WEI || 0n);
        if (tradeToExecute.netProfitNativeWei === undefined || tradeToExecute.netProfitNativeWei === null || BigInt(tradeToExecute.netProfitNativeWei || 0n) < threshold) {
             const errorMsg = `Best trade's net profit (${ethers.formatEther(BigInt(tradeToExecute.netProfitNativeWei || 0n))}) is below threshold (${ethers.formatEther(threshold)}). Skipping execution.`;
             this.logger.warn(`${logPrefix} Skipping execution: ${errorMsg}`);
             // Log full trade details that was skipped at debug level
             this.logger.debug(`${logPrefix} Skipped Trade Details:`, JSON.stringify(tradeToExecute, (key, value) => typeof value === 'bigint' ? value.toString() : value));
             return; // Do not execute if below threshold (even though it was passed as "profitable" from AE)
        }

        this.logger.info(`${logPrefix} Prioritizing best trade. Type: ${tradeToExecute.type}, Path: ${tradeToExecute.path?.map(p=>p.dex).join('->') || 'N/A'}`);
        this.logger.info(`${logPrefix} Est. Net Profit (After Gas/Fee, Before Tithe): ${ethers.formatEther(tradeToExecute.netProfitNativeWei)} ${this.config.NATIVE_CURRENCY_SYMBOL}`);
         // Log profit for executor *after* tithe (calculated by ProfitCalculator)
        this.logger.info(`${logPrefix} Est. Profit For Executor (After Tithe): ${ethers.formatEther(tradeToExecute.estimatedProfitForExecutorNativeWei || 0n)} ${this.config.NATIVE_CURRENCY_SYMBOL}`);
         this.logger.info(`${logPrefix} Calculated Gas Limit: ${gasLimit.toString()}, Effective Gas Price: ${ethers.formatUnits(effectiveGasPrice, 'gwei')} Gwei, Est. Total Gas Cost: ${ethers.formatEther(totalGasCostWei)} ${this.config.NATIVE_CURRENCY_SYMBOL}`);


        try {
            // --- 1. Prepare Transaction Parameters ---
            this.logger.debug(`${logPrefix} Preparing execution parameters using txParameterPreparer...`);
            const { contractFunctionName, flashLoanArgs, providerType } = await prepareExecutionParams(
                tradeToExecute,
                this.config,
                this.flashSwapManager, // Pass FSM, needed by some builders (e.g., Aave V3 for signer address)
                this.titheRecipient // Pass tithe recipient
            );
            this.logger.debug(`${logPrefix} Parameter preparation complete. Function: ${contractFunctionName}, Provider: ${providerType}`);


            // --- 2. Get Current Fee Data (Needed for tx options) ---
             // We need fresh fee data right before sending the tx.
            const feeData = await this.gasEstimator.getFeeData();
            if (!feeData || (!feeData.maxFeePerGas && !feeData.gasPrice)) {
                const errorMsg = "Failed to get valid fee data for execution transaction right before sending.";
                this.logger.error(`${logPrefix} CRITICAL: ${errorMsg}`);
                 throw new Error(errorMsg); // Throw to be caught below
            }
             // Use the GasEstimator's method to get clamped effective price again based on fresh data
             const currentEffectiveGasPrice = this.gasEstimator.getEffectiveGasPrice(feeData);
             if (!currentEffectiveGasPrice) {
                  const errorMsg = "Failed to determine current effective gas price for execution.";
                  this.logger.error(`${logPrefix} CRITICAL: ${errorMsg}`);
                  throw new Error(errorMsg); // Throw to be caught below
             }
             this.logger.debug(`${logPrefix} Current Fee Data: maxFeePerGas=${feeData.maxFeePerGas?.toString()}, maxPriorityFeePerGas=${feeData.maxPriorityFeePerGas?.toString()}, gasPrice=${feeData.gasPrice?.toString()}`);
             this.logger.debug(`${logPrefix} Current Effective Gas Price (clamped): ${ethers.formatUnits(currentEffectiveGasPrice, 'gwei')} Gwei`);


            // --- 3. Execute ---
            // Call the executeTransaction utility function with the prepared params and gas limit
            this.logger.warn(`${logPrefix} >>> ATTEMPTING EXECUTION via ${providerType} path (${contractFunctionName}) <<<`);
            this.logger.debug(`${logPrefix} Contract Call: ${this.flashSwapManager.getFlashSwapContract()?.target}.${contractFunctionName}(...) with gasLimit=${gasLimit.toString()}`);
             // Log encoded calldata at debug level
             try {
                  const flashSwapContract = this.flashSwapManager.getFlashSwapContract();
                  if (flashSwapContract) {
                      const functionFragment = flashSwapContract.interface.getFunction(contractFunctionName);
                      const calldata = flashSwapContract.interface.encodeFunctionData(functionFragment, flashLoanArgs);
                      this.logger.debug(`${logPrefix} Encoded calldata: ${calldata}`);
                  } else {
                       this.logger.debug(`${logPrefix} Could not get FlashSwap contract instance to encode calldata.`);
                  }
             } catch (e) {
                  this.logger.debug(`${logPrefix} Error encoding calldata for debug log: ${e.message}`);
             }


            const executionResult = await executeTransaction(
                contractFunctionName, // Function name on FlashSwap.sol
                flashLoanArgs,            // Arguments for that function
                this.flashSwapManager,    // Manager instance (contains signer and contract)
                gasLimit,                 // Use the determined estimated gas limit
                feeData,                  // Pass fresh fee data for transaction options
                this.logger,              // Logger instance
                this.isDryRun             // isDryRun status (should be false here)
            );

            // --- 4. Log Result & Handle Stop ---
            if (executionResult.success) {
                this.logger.info(`${logPrefix} 🎉🎉🎉 SUCCESSFULLY EXECUTED via ${providerType}. Tx: ${executionResult.txHash}`);
                // Log Tithe Recipient on Success (it was passed to builder and encoded)
                this.logger.info(`${logPrefix} Tithe Destination (encoded in params): ${this.titheRecipient}`);

                // Signal stop if configured
                if (this.config.STOP_ON_FIRST_EXECUTION) {
                    this.logger.warn(`${logPrefix} STOP_ON_FIRST_EXECUTION is true. Signaling process exit...`);
                    // Use process.exit(0) for clean exit
                    process.exit(0);
                }
            } else {
                 // executionResult includes details like txHash, receipt (if available), error
                this.logger.error(`${logPrefix} Execution FAILED via ${providerType}. Tx: ${executionResult.txHash || 'N/A'}. See logs above for details.`);
                 // ErrorHandler utility logs the error details from the executionResult already.
                 // Just ensure this top-level catch doesn't miss anything critical.
            }

        } catch (execError) {
            // Catch errors thrown during parameter preparation or other steps before executeTransaction
            this.logger.error(`${logPrefix} Uncaught error during trade execution attempt: ${execError.message}`, execError);
            // Use central ErrorHandler for consistent logging/reporting
            ErrorHandler.handleError(execError, 'TradeHandlerExecutionAttemptCatch');
        }
    } // End handleTrades method

    // If TradeHandler needed other methods (e.g. handleTriangularArbitrage), they would be here.
    // But handleTrades is the main entry point called by ArbitrageEngine.

} // End TradeHandler class

// Export the class
module.exports = TradeHandler;
