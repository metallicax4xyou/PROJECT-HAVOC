// core/tradeHandler.js
// --- VERSION v2.2 --- Removed redundant calldata logging block as encoding happens in txExecutor.

const { ethers } require('ethers');
const logger = require('../utils/logger'); // Use injected logger instance when possible
const ErrorHandler = require('../utils/errorHandler'); // Centralized error handling
// Import the new parameter preparer utility
const { prepareExecutionParams } = require('./tx/txParameterPreparer');
// Import the transaction execution utility
const { executeTransaction } } = require('./tx/index'); // ASSUMING this import path is correct


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
        const logPrefix = '[TradeHandler v2.2 Init]'; // Version bump
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
         // Validate prepareExecutionParams function exists
         if (typeof prepareExecutionParams !== 'function') {
              loggerInstance.error(`${logPrefix} Critical: prepareExecutionParams function not found. Is ./tx/txParameterPreparer.js imported correctly?`);
              throw new Error('TradeHandler Init: prepareExecutionParams function not available.');
         }


        this.flashSwapManager = flashSwapManager;
        this.gasEstimator = gasEstimator;
        this.logger = loggerInstance; // Use injected logger
        this.isDryRun = this.config.DRY_RUN === 'true' || this.config.DRY_RUN === true;

        // Retrieve Tithe Recipient from Config during initialization
        this.titheRecipient = this.config.TITHE_WALLET_ADDRESS;
         // Basic validation - critical config should ideally be validated by loadConfig/initializer
        if (!this.titheRecipient || typeof this.titheRecipient !== 'string' || !ethers.isAddress(this.titheRecipient)) { // Added type check
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
        const logPrefix = '[TradeHandler v2.2]'; // Version bump

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
             // AE already logs details in dry run via tradeLogger. No need to re-log here.
            this.logger.info(`${logPrefix} Dry run processing complete (Details logged by ArbitrageEngine/TradeLogger).`);
            return; // EXIT for DRY_RUN
        }

        // --- NOT DRY RUN: Proceed with execution prep ---
        this.logger.info(`${logPrefix} DRY_RUN=false. Processing ${trades.length} trades for potential execution...`);

        // Sort and select the best trade (highest estimatedProfitNativeWei)
        // The trades array should already be augmented with netProfitNativeWei by ProfitCalculator
        // Sort by netProfitNativeWei (after gas/fee, before tithe)
        trades.sort((a, b) => (BigInt(b.netProfitNativeWei || 0n)) - (BigInt(a.netProfitNativeWei || 0n)));
        const tradeToExecute = trades[0];

        // Ensure the trade object contains the required gas estimate details from ProfitCalculator
        if (!tradeToExecute.gasEstimate || tradeToExecute.gasEstimate.pathGasLimit === undefined || tradeToExecute.gasEstimate.pathGasLimit === null || tradeToExecute.gasEstimate.effectiveGasPrice === undefined || tradeToExecute.gasEstimate.effectiveGasPrice === null || tradeToExecute.gasEstimate.totalCostWei === undefined || tradeToExecute.gasEstimate.totalCostWei === null) {
             const errorMsg = `Best trade missing required gas estimate details (pathGasLimit, effectiveGasPrice, totalCostWei). Cannot execute.`;
             this.logger.error(`${logPrefix} CRITICAL: ${errorMsg}`, { gasEstimate: tradeToExecute.gasEstimate });
             ErrorHandler.handleError(new Error(errorMsg), 'TradeHandlerMissingGasEstimate'); // Use ErrorHandler
             return;
        }
        const gasLimit = BigInt(tradeToExecute.gasEstimate.pathGasLimit); // Use the calculated limit
        const effectiveGasPrice = BigInt(tradeToExecute.gasEstimate.effectiveGasPrice); // Use calculated effective price
        const totalGasCostWei = BigInt(tradeToExecute.gasEstimate.totalCostWei); // Use calculated total cost

        // Double check netProfit calculation vs threshold here before execution (ProfitCalculator should have done this, but safety first)
        const threshold = BigInt(this.config.PROFIT_THRESHOLD_NATIVE_WEI || 0n); // Assuming this is already in Wei
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
            // prepareExecutionParams returns { contractFunctionName, flashLoanArgs, providerType, gasLimit }
            // Note: The gasLimit returned by the preparer is redundant if we already get it from tradeToExecute.
            // Let's use the one from tradeToExecute as it came from the ProfitCalculator's estimation process.
            const { contractFunctionName, flashLoanArgs, providerType } = await prepareExecutionParams(
                tradeToExecute,
                this.config,
                this.flashSwapManager, // Pass FSM, needed by some builders (e.g., Aave V3 for signer address)
                this.titheRecipient // Pass tithe recipient
            );
             // Validate preparer output
             if (!contractFunctionName || !Array.isArray(flashLoanArgs)) {
                  throw new Error(`Parameter preparer failed to return function name or arguments.`);
             }
            this.logger.debug(`${logPrefix} Parameter preparation complete. Function: ${contractFunctionName}, Provider: ${providerType}`);


            // --- 2. Get Current Fee Data (Needed for tx options) ---
             // We need fresh fee data right before sending the tx.
            const feeData = await this.gasEstimator.getFeeData();
            if (!feeData || (!feeData.maxFeePerGas && !feeData.gasPrice)) {
                const errorMsg = "Failed to get valid fee data for execution transaction right before sending.";
                this.logger.error(`${logPrefix} CRITICAL: ${errorMsg}`);
                 throw new Error(errorMsg); // Throw to be caught below
            }
             // Log current fee data (optional, but good for debugging)
             this.logger.debug(`${logPrefix} Current Fee Data: maxFeePerGas=${feeData.maxFeePerGas?.toString()}, maxPriorityFeePerGas=${feeData.maxPriorityFeePerGas?.toString()}, gasPrice=${feeData.gasPrice?.toString()}`);
             // We already used effectiveGasPrice from gasEstimate for profit calc.
             // Use the fresh feeData directly in executeTransaction options.


            // --- 3. Execute ---
            // Call the executeTransaction utility function with the prepared params and gas limit
            this.logger.warn(`${logPrefix} >>> ATTEMPTING EXECUTION via ${providerType} path (${contractFunctionName}) <<<`);
            this.logger.debug(`${logPrefix} Calling executeTransaction with gasLimit=${gasLimit.toString()}, function ${contractFunctionName}, args [...]`);

            // Removed the manual calldata encoding block here

            const executionResult = await executeTransaction(
                contractFunctionName, // Function name on FlashSwap.sol
                flashLoanArgs,            // Arguments for that function (prepared by txParameterPreparer)
                this.flashSwapManager,    // Manager instance (contains signer and contract)
                gasLimit,                 // Use the determined estimated gas limit from ProfitCalculator
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
                 // ErrorHandler utility logs the error details from the executionResult already within executeTransaction.
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
