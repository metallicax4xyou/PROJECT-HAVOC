// core/tradeHandler.js
// --- VERSION v2.3 --- Updated to use the refactored TxExecutor class instance.

const { ethers } = require('ethers');
const logger = require('../utils/logger'); // Use injected logger instance when possible
const ErrorHandler = require('../utils/errorHandler'); // Centralized error handling
// Import the new parameter preparer utility
const { prepareExecutionParams } = require('./tx/txParameterPreparer');
// Import the TxExecutor CLASS (assuming it's now in ./tx/txExecutor.js)
const TxExecutor = require('./tx/txExecutor'); // <-- UPDATED IMPORT


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
     * @param {object} nonceManager - The NonceManager instance. // TradeHandler needs NonceManager to pass to TxExecutor
     * @param {object} loggerInstance - The logger instance.
     */
    constructor(config, provider, flashSwapManager, gasEstimator, nonceManager, loggerInstance = logger) { // <-- Added nonceManager parameter
        const logPrefix = '[TradeHandler v2.3 Init]'; // Version bump
        this.config = config;
        this.provider = provider;
        // Validate dependencies
        if (!flashSwapManager || typeof flashSwapManager.initiateAaveFlashLoan !== 'function' || typeof flashSwapManager.getFlashSwapContract !== 'function') {
             loggerInstance.error(`${logPrefix} Invalid FlashSwapManager instance.`);
             throw new Error('TradeHandler Init: Invalid FlashSwapManager instance.');
        }
        if (!gasEstimator || typeof gasEstimator.getFeeData !== 'function' || typeof gasEstimator.getEffectiveGasPrice !== 'function') {
             loggerInstance.error(`${logPrefix} Invalid GasEstimator instance.`);
             throw new Error('TradeHandler Init: Invalid GasEstimator instance.');
        }
         // Validate NonceManager instance
         if (!nonceManager || typeof nonceManager.sendTransaction !== 'function') {
              loggerInstance.error(`${logPrefix} Invalid NonceManager instance.`);
              throw new Error('TradeHandler Init: Invalid NonceManager instance.');
         }
         // Validate prepareExecutionParams function exists
         if (typeof prepareExecutionParams !== 'function') {
              loggerInstance.error(`${logPrefix} Critical: prepareExecutionParams function not found. Is ./tx/txParameterPreparer.js imported correctly?`);
              throw new Error('TradeHandler Init: prepareExecutionParams function not available.');
         }
         // Validate TxExecutor CLASS exists
         if (typeof TxExecutor !== 'function') { // Check if TxExecutor is a class constructor
              loggerInstance.error(`${logPrefix} Critical: TxExecutor class not found. Is ./tx/txExecutor.js imported correctly and exporting the class?`);
              throw new Error('TradeHandler Init: TxExecutor class not available.');
         }


        this.flashSwapManager = flashSwapManager;
        this.gasEstimator = gasEstimator;
        this.logger = loggerInstance; // Use injected logger
        this.isDryRun = this.config.DRY_RUN === 'true' || this.config.DRY_RUN === true;

        // Retrieve Tithe Recipient from Config during initialization
        this.titheRecipient = this.config.TITHE_WALLET_ADDRESS;
         // Basic validation - critical config should ideally be validated by loadConfig/initializer
        if (!this.titheRecipient || typeof this.titheRecipient !== 'string' || !ethers.isAddress(this.titheRecipient)) {
             this.logger.error(`${logPrefix} CRITICAL ERROR: TITHE_WALLET_ADDRESS is missing or invalid in configuration.`);
             throw new Error('TITHE_WALLET_ADDRESS is missing or invalid in configuration.');
        }
        this.logger.debug(`${logPrefix} Initialized. Tithe Recipient: ${this.titheRecipient}`); // Debug log

        // --- Initialize TxExecutor instance ---
        // TxExecutor requires config, provider, and NonceManager
        this.txExecutor = new TxExecutor(config, provider, nonceManager); // <-- NEW INSTANCE CREATION
        this.logger.debug(`${logPrefix} TxExecutor instance created.`);


         if (this.isDryRun) {
             this.logger.info(`${logPrefix} Running in DRY_RUN mode. Transactions will be simulated but NOT sent.`);
         }
    }

    /**
     * Processes profitable trades, selects the best, prepares parameters, and attempts execution.
     * @param {Array<object>} trades - Array of profitable opportunity objects from the ProfitCalculator.
     */
    async handleTrades(trades) {
        const logPrefix = '[TradeHandler v2.3]'; // Version bump

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
        trades.sort((a, b) => (BigInt(b.netProfitNativeWei || 0n)) - (BigInt(a.netProfitNativeWei || 0n)));
        const tradeToExecute = trades[0];

        // Ensure the trade object contains the required gas estimate details from ProfitCalculator
        // Now checks for pathGasLimit, effectiveGasPrice, AND totalCostWei which are expected on the gasEstimate object
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
             // Pass the fresh feeData directly to TxExecutor.


            // --- 3. Execute ---
            // Call the executeTransaction method on the TxExecutor instance
            this.logger.warn(`${logPrefix} >>> ATTEMPTING EXECUTION via ${providerType} path (${contractFunctionName}) <<<`);
            // Note: FlashSwapManager instance has the FlashSwap contract and signer within it
            // We pass FSM instance to TxExecutor constructor (or executeTransaction?)
            // Looking at TxExecutor constructor (v1.4), it takes FlashSwapManager (or NonceManager?)
            // The refactored TxExecutor v1.4 constructor takes config, provider, NonceManager.
            // The TradeHandler constructor now also needs NonceManager to pass to TxExecutor.
            // The TxExecutor instance will get the signer and contract from the NonceManager it's given.
            // TradeHandler needs to pass FlashSwapManager address to TxExecutor's executeTransaction method.

            // --- Re-evaluate TxExecutor executeTransaction signature ---
            // The refactored TxExecutor's executeTransaction takes:
            // (toAddress, calldata, estimatedGasLimit, feeData, opportunityDetails, isDryRun)
            // Where does calldata come from? It needs to be encoded.
            // The TradeHandler has contractFunctionName and flashLoanArgs from prepareExecutionParams.
            // The calldata encoding should happen right *before* sending the transaction in TxExecutor,
            // using the Encoder utility.

            // --- MODIFIED TRADEHANDLER EXECUTION FLOW ---
            // The TradeHandler should pass contractFunctionName and flashLoanArgs to TxExecutor.executeTransaction.
            // The TxExecutor should then call the Encoder to get the calldata.
            // The TxExecutor constructor also needs FlashSwapManager instance (to get contract address and pass to Encoder if needed?)
            // Or TxExecutor just needs the contract address and the Encoder needs FlashSwap ABI (which it gets from ABIS constants)

            // Let's revise the interaction:
            // TradeHandler calls: this.txExecutor.executeTransaction(contractFunctionName, flashLoanArgs, gasLimit, feeData, opportunityDetails, isDryRun);
            // TxExecutor calls: const calldata = Encoder.encodeFlashSwapCall(contractFunctionName, flashLoanArgs);
            // TxExecutor then uses calldata to build the transaction.

            // Modify the call to this.txExecutor.executeTransaction:
            const executionResult = await this.txExecutor.executeTransaction( // <-- Call method on instance
                this.flashSwapManager.getFlashSwapContract()?.target, // Pass the FlashSwap contract address
                contractFunctionName, // Pass function name
                flashLoanArgs, // Pass function args array
                gasLimit,                 // Use the determined estimated gas limit
                feeData,                  // Pass fresh fee data for transaction options
                logPrefix, // Pass logPrefix for TxExecutor logging
                this.isDryRun             // isDryRun status (should be false here)
            );


            // --- 4. Log Result & Handle Stop ---
            if (executionResult?.success) { // Check executionResult object structure
                this.logger.info(`${logPrefix} 🎉🎉🎉 SUCCESSFULLY EXECUTED via ${providerType}. Tx: ${executionResult.txHash}`);
                // Log Tithe Recipient on Success (it was passed to builder and encoded)
                this.logger.info(`${logPrefix} Tithe Destination (encoded in params): ${this.titheRecipient}`);

                // Signal stop if configured
                if (this.config.STOP_ON_FIRST_EXECUTION) {
                    this.logger.warn(`${logPrefix} STOP_ON_FIRST_EXECUTION is true. Signaling process exit...`);
                    process.exit(0);
                }
            } else {
                 // executionResult is null or success is false (TxExecutor returns null on failure)
                this.logger.error(`${logPrefix} Execution FAILED via ${providerType}. See logs above for details.`);
                 // executionResult might contain txHash and error details if TxExecutor returns an object on failure
                 this.logger.error(`${logPrefix} Failed Tx Hash: ${executionResult?.txHash || 'N/A'}`);
                 this.logger.error(`${logPrefix} Error Message: ${executionResult?.error?.message || 'N/A'}`);
            }

        } catch (execError) {
            // Catch errors thrown during parameter preparation or other steps before executeTransaction
            this.logger.error(`${logPrefix} Uncaught error during trade execution attempt: ${execError.message}`, execError);
            ErrorHandler.handleError(execError, 'TradeHandlerExecutionAttemptCatch');
        }
    } // End handleTrades method

} // End TradeHandler class

// Export the class
module.exports = TradeHandler;
