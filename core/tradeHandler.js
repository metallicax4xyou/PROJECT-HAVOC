// core/tradeHandler.js
// --- VERSION v2.0 --- Refactored into a class with handleTrades method.

const { ethers } = require('ethers');
const logger = require('../utils/logger'); // Use injected logger instance when possible
const ErrorHandler = require('../utils/errorHandler'); // Centralized error handling
// Lazy require TxParamBuilder as it might have circular deps back to core
// const TxParamBuilder = require('./tx/paramBuilder');

/**
 * Handles the processing and execution of profitable trade opportunities.
 * Selects the best trade, determines flash loan provider, builds/encodes parameters,
 * and triggers the transaction execution.
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
        this.config = config;
        this.provider = provider;
        // Validate dependencies (more robust checks can be added)
        if (!flashSwapManager || typeof flashSwapManager.initiateAaveFlashLoan !== 'function') {
             throw new Error('[TradeHandler Init] Invalid FlashSwapManager instance.');
        }
        if (!gasEstimator || typeof gasEstimator.getFeeData !== 'function') {
             throw new Error('[TradeHandler Init] Invalid GasEstimator instance.');
        }
        this.flashSwapManager = flashSwapManager;
        this.gasEstimator = gasEstimator;
        this.logger = loggerInstance; // Use injected logger
        this.isDryRun = this.config.DRY_RUN === 'true' || this.config.DRY_RUN === true;

        // Retrieve Tithe Recipient from Config during initialization
        this.titheRecipient = this.config.TITHE_WALLET_ADDRESS;
         // Basic validation - critical config should ideally be validated by loadConfig
        if (!this.titheRecipient || !ethers.isAddress(this.titheRecipient)) {
             this.logger.error('[TradeHandler Init] CRITICAL ERROR: TITHE_WALLET_ADDRESS is missing or invalid in configuration.');
             // Depending on requirements, you might throw here or proceed with a warning.
             // For critical address, throwing is safer if execution relies on it.
             // Let's throw to ensure bot doesn't try to send TXs without a valid tithe address.
             throw new Error('TITHE_WALLET_ADDRESS is missing or invalid.');
        }
        this.logger.debug(`[TradeHandler v2.0] Initialized. Tithe Recipient: ${this.titheRecipient}`); // Version bump
    }

    /**
     * Processes profitable trades, selects the best, and attempts execution.
     * @param {Array<object>} trades - Array of profitable opportunity objects from the ProfitCalculator.
     */
    async handleTrades(trades) {
        const logPrefix = '[TradeHandler v2.0]'; // Version bump

        if (!this.flashSwapManager || trades.length === 0) {
            this.logger.debug(`${logPrefix} No trades or FlashSwapManager missing. Skipping.`);
            return;
        }

        if (this.isDryRun) {
            this.logger.info(`${logPrefix} DRY_RUN=true. Logging opportunities, skipping execution.`);
            trades.forEach((trade, index) => {
                 // Determine potential provider for logging clarity
                 let providerType = 'UNKNOWN';
                 if (trade.path && trade.path.length > 0) {
                     providerType = (trade.path[0].dex === 'uniswapV3') ? 'UNIV3' : 'AAVE';
                 }
                this.logger.info(`${logPrefix} [DRY RUN Trade ${index + 1}] Provider: ${providerType}, Type: ${trade.type}, Path: ${trade.path?.map(p=>p.dex).join('->') || 'N/A'}, Profit: ${ethers.formatEther(trade.netProfitNativeWei || 0n)} ${this.config.NATIVE_CURRENCY_SYMBOL}`);
                // Log Tithe Recipient in Dry Run if desired - added in constructor
                 // this.logger.debug(`${logPrefix} [DRY RUN Trade ${index + 1}] Tithe Recipient: ${this.titheRecipient}`);
            });
            return;
        }

        this.logger.info(`${logPrefix} DRY_RUN=false. Processing ${trades.length} trades for potential execution...`);

        // Sort and select the best trade (highest estimatedProfitNativeWei)
        // The trades array should already be augmented with estimatedProfitNativeWei by ProfitCalculator
        trades.sort((a, b) => (BigInt(b.estimatedProfitNativeWei || 0n)) - (BigInt(a.estimatedProfitNativeWei || 0n)));
        const tradeToExecute = trades[0];
        this.logger.info(`${logPrefix} Prioritizing best trade. Type: ${tradeToExecute.type}, Path: ${tradeToExecute.path?.map(p=>p.dex).join('->') || 'N/A'}, Est. Net Profit (After Gas, Before Tithe): ${ethers.formatEther(tradeToExecute.netProfitNativeWei || 0n)} ${this.config.NATIVE_CURRENCY_SYMBOL}`);
        // Log profit for executor *after* tithe
        this.logger.info(`${logPrefix} Est. Profit For Executor (After Tithe): ${ethers.formatEther(tradeToExecute.estimatedProfitForExecutorNativeWei || 0n)} ${this.config.NATIVE_CURRENCY_SYMBOL}`);


        let providerType = 'UNKNOWN'; // 'UNIV3' or 'AAVE'
        let contractFunctionName = 'unknownFunction'; // Function to call on FlashSwap.sol

        try {
            // --- Validate trade path exists ---
            if (!tradeToExecute.path || !Array.isArray(tradeToExecute.path) || tradeToExecute.path.length === 0) {
                 throw new Error(`Trade object missing valid path information.`);
            }

            // --- 1. Determine Flash Loan Provider ---
            if (tradeToExecute.path[0].dex === 'uniswapV3') {
                providerType = 'UNIV3';
                this.logger.info(`${logPrefix} First hop is UniV3. Preparing for UniV3 Flash Loan.`);
            } else {
                providerType = 'AAVE';
                this.logger.info(`${logPrefix} First hop is ${tradeToExecute.path[0].dex}. Preparing for AAVE Flash Loan.`);
                // Add check if Aave is configured/enabled?
                if (!this.config.AAVE_POOL_ADDRESS) {
                     this.logger.error(`${logPrefix} Cannot use Aave provider: AAVE_POOL_ADDRESS not configured.`);
                     // Return or throw depending on desired strictness
                     throw new Error("Aave provider selected but AAVE_POOL_ADDRESS not configured.");
                }
            }


            // --- 2. Get Current Fee Data (Needed for tx options) ---
            const feeData = await this.gasEstimator.getFeeData();
            if (!feeData || (!feeData.maxFeePerGas && !feeData.gasPrice)) {
                throw new Error("Failed to get valid fee data for execution transaction.");
            }
            // Use the GasEstimator's method to get clamped effective price
            const effectiveGasPrice = this.gasEstimator.getEffectiveGasPrice(feeData);
            if (!effectiveGasPrice) {
                 throw new Error("Failed to determine effective gas price for execution.");
            }
             this.logger.debug(`${logPrefix} Using Effective Gas Price: ${ethers.formatUnits(effectiveGasPrice, 'gwei')} Gwei`);


            // --- 3. Prepare Transaction Parameters based on Provider Type ---
            // Lazy require TxParamBuilder here to avoid potential circular dependencies on startup
            const TxParamBuilder = require('./tx/paramBuilder');
             if (!TxParamBuilder) throw new Error("TxParamBuilder could not be loaded.");

            let buildResult;
            let flashLoanArgs; // Arguments passed to the actual FlashSwap contract function (initiateAaveFlashLoan or flash)

            // --- 3.A. Prepare Simulation Data for Builder ---
            // Builders need consistent input regardless of provider
            const simResultForBuilder = {
                initialAmount: BigInt(tradeToExecute.amountIn || 0n), // Borrowed amount
                hop1AmountOut: BigInt(tradeToExecute.intermediateAmountOut || 0n), // Amount after first hop
                finalAmount: BigInt(tradeToExecute.amountOut || 0n), // Amount after final hop
                // Add other fields if needed by other builders (e.g., triangular)
            };
            if (simResultForBuilder.initialAmount <= 0n || simResultForBuilder.finalAmount < 0n) { // initialAmount must be > 0
                this.logger.error(`${logPrefix} tradeData missing required amountIn/amountOut fields or amounts are invalid for builder.`);
                throw new Error(`Incomplete or invalid trade data for builder.`);
            }


            if (providerType === 'UNIV3') {
                // --- 3.A.1 Select UniV3 Builder ---
                let builderFunction;
                const dexPath = tradeToExecute.path.map(p => p.dex).join('->');
                if (tradeToExecute.type === 'spatial' && dexPath === 'uniswapV3->uniswapV3') {
                     // Assuming two-hop spatial arbitrage uses buildTwoHopParams
                     builderFunction = TxParamBuilder.buildTwoHopParams;
                     contractFunctionName = 'initiateUniswapV3FlashLoan'; // Function name on FlashSwap.sol
                     // Note: FlashSwap contract might have a specific function for V3 flash loans
                     // Let's assume `initiateUniswapV3FlashLoan` takes CallbackType, poolAddress, amount0, amount1, bytes params
                } else if (tradeToExecute.type === 'triangular') { // Assuming triangular always uses UniV3 loan from the first pool
                     builderFunction = TxParamBuilder.buildTriangularParams;
                     contractFunctionName = 'initiateUniswapV3FlashLoan'; // Assuming same function for triangular V3 loan
                     this.logger.warn(`${logPrefix} Using triangular builder (UniV3 Loan). Ensure paramBuilder TODO is resolved.`);
                } else {
                     this.logger.warn(`${logPrefix} Skipping trade: Unsupported type/path for UniV3 Flash Loan: ${tradeToExecute.type} / ${dexPath}`);
                     return;
                }
                 if (!builderFunction) throw new Error(`UniV3 builder function not found for type ${tradeToExecute.type} / path ${dexPath} in TxParamBuilder.`);
                 this.logger.debug(`${logPrefix} Selected builder: ${builderFunction.name}`);

                // --- 3.A.2 Call UniV3 Builder ---
                // Pass the titheRecipient to the builder
                buildResult = builderFunction(tradeToExecute, simResultForBuilder, this.config, this.titheRecipient);
                if (!buildResult || buildResult.params === undefined || buildResult.borrowTokenAddress === undefined || buildResult.borrowAmount === undefined || buildResult.typeString === undefined || buildResult.contractFunctionName !== contractFunctionName) {
                    // Check that the function name returned by the builder matches what we expect to call
                    throw new Error(`UniV3 parameter builder failed to return expected structure or function name (${contractFunctionName}).`);
                }

                // --- 3.A.3 Encode Parameters Struct ---
                const encodedParamsBytes = ethers.AbiCoder.defaultAbiCoder().encode([buildResult.typeString], [buildResult.params]);

                // --- 3.A.4 Determine amount0/amount1 for FlashSwap.sol::flash() or similar UniV3 entry ---
                const borrowPoolState = tradeToExecute.path[0].poolState; // Already checked path[0] exists and is V3
                if (!borrowPoolState || !borrowPoolState.token0?.address || !borrowPoolState.token1?.address) {
                     throw new Error("Cannot determine flash loan amounts: Invalid borrow pool state for UniV3 loan.");
                }
                let amount0ToBorrow = 0n; let amount1ToBorrow = 0n;
                const borrowTokenAddrLower = buildResult.borrowTokenAddress.toLowerCase();
                if (borrowTokenAddrLower === borrowPoolState.token0.address.toLowerCase()) amount0ToBorrow = buildResult.borrowAmount;
                else if (borrowTokenAddrLower === borrowPoolState.token1.address.toLowerCase()) amount1ToBorrow = buildResult.borrowAmount;
                else { throw new Error(`Borrow token ${buildResult.borrowTokenAddress} does not match UniV3 borrow pool tokens ${borrowPoolState.token0.address}/${borrowPoolState.token1.address}`); }
                 this.logger.debug(`${logPrefix} UniV3 Flash Loan Amounts: Amt0=${amount0ToBorrow.toString()}, Amt1=${amount1ToBorrow.toString()}`);


                // --- 3.A.5 Prepare Flash Loan Initiation Arguments for FlashSwap.sol ---
                 // FlashSwap.sol function signature for UniV3 Loan assumed:
                 // function initiateUniswapV3FlashLoan(CallbackType callbackType, address poolAddress, uint256 amount0, uint256 amount1, bytes calldata params)
                 let callbackTypeEnum; // Need to map trade type to enum
                 if (tradeToExecute.type === 'spatial' && dexPath === 'uniswapV3->uniswapV3') callbackTypeEnum = 0; // Assuming 0 for TwoHop
                 else if (tradeToExecute.type === 'triangular') callbackTypeEnum = 1; // Assuming 1 for Triangular
                 else throw new Error(`Cannot map UniV3 trade type ${tradeToExecute.type} to CallbackType enum.`);


                 flashLoanArgs = [
                     callbackTypeEnum,        // CallbackType enum (uint8 in Solidity)
                     borrowPoolState.address, // address poolAddress
                     amount0ToBorrow,         // uint256 amount0
                     amount1ToBorrow,         // uint256 amount1
                     encodedParamsBytes       // bytes calldata params (encoded builder struct)
                 ];


            } else if (providerType === 'AAVE') {
                // --- 3.B.1 Call Aave Builder ---
                 if (!TxParamBuilder.buildAavePathParams) { // Check if builder exists
                     throw new Error("Aave parameter builder (buildAavePathParams) not found in paramBuilder index.");
                 }
                 contractFunctionName = 'initiateAaveFlashLoan'; // Function name on FlashSwap.sol
                 // Pass the titheRecipient to the Aave builder
                 // buildAavePathParams signature: (opportunity, simResult, config, flashSwapManagerInstance, titheRecipient)
                 buildResult = await TxParamBuilder.buildAavePathParams(tradeToExecute, simResultForBuilder, this.config, this.flashSwapManager, this.titheRecipient);
                 if (!buildResult || buildResult.params === undefined || buildResult.borrowTokenAddress === undefined || buildResult.borrowAmount === undefined || buildResult.typeString === undefined || buildResult.contractFunctionName !== contractFunctionName) {
                      throw new Error(`Aave parameter builder failed to return expected structure or function name (${contractFunctionName}).`);
                 }

                 // --- 3.B.2 Encode Parameters Struct (ArbParams) ---
                 const encodedArbParamsBytes = ethers.AbiCoder.defaultAbiCoder().encode([buildResult.typeString], [buildResult.params]);

                 // --- 3.B.3 Prepare Flash Loan Initiation Arguments for FlashSwap.sol ---
                 // FlashSwap.sol function signature for Aave Loan assumed:
                 // function initiateAaveFlashLoan(address[] assets, uint256[] amounts, bytes params)
                 flashLoanArgs = [
                     [buildResult.borrowTokenAddress], // address[] memory assets (array of one asset)
                     [buildResult.borrowAmount],       // uint256[] memory amounts (array of one amount)
                     encodedArbParamsBytes             // bytes memory params (encoded builder struct containing path + titheRecipient)
                 ];


            } else {
                 // Should not happen due to initial check, but safeguard
                 throw new Error("Unknown providerType determined.");
            }


            // --- 4. Get Gas Limit ---
            // Use the gas estimate from the profitable trade data (calculated by ProfitCalculator)
            // This should be `tradeToExecute.gasEstimate` (totalCostWei / effectiveGasPrice) if ProfitCalculator is updated to store it correctly.
            // Re-reading ProfitCalculator, it stores `tradeToExecute.gasEstimate` as the `totalCostWei`.
            // Let's use the pathGasLimit stored by GasEstimator, which ProfitCalculator should propagate or recalculate.
            // The GasEstimator returns { pathGasLimit, effectiveGasPrice, totalCostWei, estimateGasSuccess }
            // ProfitCalculator stores totalCostWei as gasEstimate.
            // Let's pass the *estimated gas limit* (pathGasLimit) from the gas estimation result.
            // ProfitCalculator should store this as well, or we need to call gasEstimator again here just for the limit.
            // Let's update ProfitCalculator to store pathGasLimit.

             // --- Re-Calculate Gas Estimation Result (Temporary until ProfitCalc stores limit) ---
             // This is redundant but ensures we have the limit. Needs refactoring in ProfitCalculator.
             const gasEstimationResult = await this.gasEstimator.estimateTxGasCost(
                tradeToExecute, // Pass the trade
                await this.flashSwapManager.getSignerAddress() // Pass the signer address
             );

             if (!gasEstimationResult || !gasEstimationResult.estimateGasSuccess) {
                 this.logger.warn(`${logPrefix} Skipping trade execution: Final gas estimation check failed or returned invalid result.`);
                 return; // Skip execution if final check fails
             }
             const gasLimit = gasEstimationResult.pathGasLimit; // Use the estimated limit


             if (gasLimit <= 0n) {
                 this.logger.error(`${logPrefix} Cannot execute: Invalid gas limit determined (${gasLimit}).`);
                 throw new Error(`Invalid gas limit (${gasLimit}) for execution.`);
             }
             this.logger.debug(`${logPrefix} Using Gas Limit: ${gasLimit.toString()}`);


            // --- 5. Execute ---
            this.logger.warn(`${logPrefix} >>> ATTEMPTING EXECUTION via ${providerType} path (${contractFunctionName}) <<<`);
            this.logger.debug(`${logPrefix} Contract Call: ${this.flashSwapManager.getFlashSwapContract()?.target}.${contractFunctionName}(...)`);

            // Call the executeTransaction utility function
            const executionResult = await executeTransaction(
                contractFunctionName, // Function name on FlashSwap.sol
                flashLoanArgs,            // Arguments for that function
                this.flashSwapManager,    // Manager instance
                gasLimit,                 // Estimated gas limit
                feeData,                  // Fetched fee data (for price)
                this.logger,              // Logger instance
                this.isDryRun             // isDryRun status (should be false here)
            );

            // --- 6. Log Result ---
            if (executionResult.success) {
                this.logger.info(`${logPrefix} 🎉🎉🎉 SUCCESSFULLY EXECUTED via ${providerType}. Tx: ${executionResult.txHash}`);
                // --- Log Tithe Recipient on Success ---
                this.logger.info(`${logPrefix} Tithe Destination: ${this.titheRecipient}`);

                // Signal stop if configured
                if (this.config.STOP_ON_FIRST_EXECUTION) {
                    this.logger.warn(`${logPrefix} STOP_ON_FIRST_EXECUTION is true. Signaling stop...`);
                    process.exit(0); // Exit process
                }
            } else {
                 // executionResult includes details like txHash, receipt (if available), error
                this.logger.error(`${logPrefix} Execution FAILED via ${providerType}. See logs above for details.`);
                this.logger.error(`${logPrefix} Failed Tx Hash: ${executionResult.txHash || 'N/A'}`);
                this.logger.error(`${logPrefix} Error Message: ${executionResult.error?.message || 'N/A'}`);
                 if (executionResult.error?.receipt) {
                      this.logger.error(`${logPrefix} Revert Reason: ${executionResult.error.receipt.revertReason || 'N/A'}`);
                      this.logger.error(`${logPrefix} Gas Used: ${executionResult.error.receipt.gasUsed?.toString() || 'N/A'}`);
                 }

                 // Do NOT process.exit(1) here. Let the cycle continue/complete.
                 // The error has been logged by executeTransaction and here.
            }

        } catch (execError) {
            // Catch errors thrown during preparation or FlashSwapManager calls
            this.logger.error(`${logPrefix} Uncaught error during trade execution attempt (Provider Path: ${providerType}, Function: ${contractFunctionName}): ${execError.message}`, execError);
            ErrorHandler?.handleError(execError, `TradeHandlerExecutionUncaught (${providerType})`);
        }
    } // End handleTrades method

    // If TradeHandler needed other methods (e.g. handleTriangularArbitrage), they would be here.
    // But for now, handleTrades is the main entry point called by ArbitrageEngine.

} // End TradeHandler class

// Export the class
module.exports = TradeHandler;