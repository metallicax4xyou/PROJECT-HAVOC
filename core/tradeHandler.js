// core/tradeHandler.js
// Handles processing and execution of profitable trades.

const { ethers } = require('ethers');
const logger = require('../utils/logger');
const ErrorHandler = require('../utils/errorHandler');
const TxParamBuilder = require('./tx/paramBuilder');
const TxEncoder = require('./tx/encoder'); // Assuming encoder logic is needed directly or use its functions
const { executeTransaction } = require('./txExecutor');

/**
 * Processes profitable trades, selects the best, builds/encodes, and executes it.
 * @param {Array<object>} trades - Array of profitable tradeData objects from ProfitCalculator.
 * @param {object} config - The main config object.
 * @param {FlashSwapManager} flashSwapManagerInstance - Initialized FlashSwapManager.
 * @param {GasEstimator} gasEstimatorInstance - Initialized GasEstimator.
 * @param {object} loggerInstance - The logger instance (can default to global logger).
 */
async function processAndExecuteTrades(
    trades,
    config,
    flashSwapManagerInstance,
    gasEstimatorInstance,
    loggerInstance = logger // Use passed logger or default global one
) {
    const isDryRun = config.DRY_RUN === 'true' || config.DRY_RUN === true;
    const logPrefix = '[TradeHandler]'; // Changed prefix for clarity

    if (!flashSwapManagerInstance || trades.length === 0) {
        loggerInstance.info(`${logPrefix} No trades or FlashSwapManager missing. Skipping.`);
        return;
    }

    if (isDryRun) {
        loggerInstance.info(`${logPrefix} DRY_RUN=true. Logging opportunities, skipping execution.`);
        trades.forEach((trade, index) => {
            loggerInstance.info(`${logPrefix} [DRY RUN Trade ${index + 1}] Type: ${trade.type}, Profit: ${ethers.formatEther(trade.netProfitNativeWei || 0n)} ${config.NATIVE_CURRENCY_SYMBOL}`);
            // Add more details as needed
        });
        return;
    }

    // --- Execution Logic ---
    loggerInstance.info(`${logPrefix} DRY_RUN=false. Processing ${trades.length} trades for potential execution...`);

    // 1. Select best trade (sort descending by netProfitNativeWei)
    // Ensure sorting handles potential undefined/null profits gracefully
    trades.sort((a, b) => (BigInt(b.netProfitNativeWei || 0n)) - (BigInt(a.netProfitNativeWei || 0n)));
    const tradeToExecute = trades[0]; // Execute only the best one per event emission
    loggerInstance.info(`${logPrefix} Prioritizing best trade. Est. Net Profit: ${ethers.formatEther(tradeToExecute.netProfitNativeWei || 0n)} ${config.NATIVE_CURRENCY_SYMBOL}`);

    try {
        // 2. Get Current Fee Data for Execution
        const feeData = await gasEstimatorInstance.getFeeData();
        if (!feeData || (!feeData.maxFeePerGas && !feeData.gasPrice)) {
            throw new Error("Failed to get valid fee data for execution.");
        }

        // 3. Select Builder Function
        let builderFunction;
        if (!tradeToExecute.path || !Array.isArray(tradeToExecute.path) || tradeToExecute.path.length === 0) {
             throw new Error(`Trade object missing valid path information.`);
        }
        const dexPath = tradeToExecute.path.map(p => p.dex).join('->');
        loggerInstance.debug(`${logPrefix} Determining builder for path: ${dexPath}`);

        if (tradeToExecute.type === 'spatial') {
            if (dexPath === 'uniswapV3->uniswapV3') builderFunction = TxParamBuilder.buildTwoHopParams;
            else if (dexPath === 'uniswapV3->sushiswap') builderFunction = TxParamBuilder.buildV3SushiParams;
            else if (dexPath === 'sushiswap->uniswapV3') builderFunction = TxParamBuilder.buildSushiV3Params;
            // Add other supported paths here...
            else { throw new Error(`Unsupported spatial DEX path for execution: ${dexPath}`); }
        } else if (tradeToExecute.type === 'triangular') {
            builderFunction = TxParamBuilder.buildTriangularParams;
            loggerInstance.warn(`${logPrefix} Using triangular builder. Ensure it matches FlashSwap.sol v3.0+ and paramBuilder TODO is resolved.`);
        } else {
            throw new Error(`Unsupported trade type for execution: ${tradeToExecute.type}`);
        }
        loggerInstance.debug(`${logPrefix} Selected builder: ${builderFunction.name}`);

        // 4. Prepare Simulation Data for Builder
        // *** CRITICAL ASSUMPTION: ProfitCalculator must add necessary intermediate amounts to tradeData ***
        const simResultForBuilder = {
            initialAmount: BigInt(tradeToExecute.amountIn || 0n),
            // --- THIS NEEDS VERIFICATION ---
            hop1AmountOut: BigInt(tradeToExecute.intermediateAmountOut || 0n), // Placeholder name - VERIFY FIELD NAME
            // --- END VERIFICATION ---
            finalAmount: BigInt(tradeToExecute.amountOut || 0n),
        };
        if (!simResultForBuilder.initialAmount || !simResultForBuilder.finalAmount || (tradeToExecute.type === 'spatial' && !simResultForBuilder.hop1AmountOut)) {
            loggerInstance.error(`${logPrefix} tradeData object missing required amount fields for builder.`, { tradeDataKeys: Object.keys(tradeToExecute), simResultForBuilder });
            throw new Error(`Incomplete trade data for builder - missing amount fields.`);
        }

        // 5. Call Builder
        const buildResult = builderFunction(tradeToExecute, simResultForBuilder, config);
        if (!buildResult || !buildResult.params || !buildResult.borrowTokenAddress || !buildResult.borrowAmount || !buildResult.typeString || !buildResult.contractFunctionName) {
            throw new Error("Parameter builder failed to return expected structure.");
        }

        // 6. Encode Parameters Struct
        const encodedParamsBytes = ethers.AbiCoder.defaultAbiCoder().encode([buildResult.typeString], [buildResult.params]);

        // 7. Determine amount0/amount1 for flash() call
        // *** CRITICAL: This logic assumes borrow originates from path[0] V3 pool ***
        const borrowPoolState = tradeToExecute.path[0].poolState;
        if (!borrowPoolState || !borrowPoolState.token0?.address || !borrowPoolState.token1?.address || tradeToExecute.path[0].dex !== 'uniswapV3') {
            // Add stricter check: borrow MUST originate from V3 for this logic
             loggerInstance.error(`${logPrefix} Cannot determine flash loan amounts: Borrow must originate from a V3 pool defined in path[0].`, { path0: tradeToExecute.path[0] });
            throw new Error("Cannot determine flash loan amounts: Invalid borrow pool state or not V3.");
        }
        let amount0ToBorrow = 0n; let amount1ToBorrow = 0n;
        const borrowTokenAddrLower = buildResult.borrowTokenAddress.toLowerCase();
        if (borrowTokenAddrLower === borrowPoolState.token0.address.toLowerCase()) amount0ToBorrow = buildResult.borrowAmount;
        else if (borrowTokenAddrLower === borrowPoolState.token1.address.toLowerCase()) amount1ToBorrow = buildResult.borrowAmount;
        else { throw new Error(`Borrow token ${buildResult.borrowTokenAddress} does not match borrow pool tokens ${borrowPoolState.token0.address}/${borrowPoolState.token1.address}`); }
        loggerInstance.debug(`${logPrefix} Flash Loan Amounts: Amt0=${amount0ToBorrow}, Amt1=${amount1ToBorrow}`);

        // 8. Prepare Contract Call Arguments
        // *** CRITICAL: Verify this array matches the specific contract function's signature ***
        const contractCallArgs = [
            borrowPoolState.address, // address _poolAddress (V3 pool to borrow from) - VERIFY THIS IS CORRECT POOL
            amount0ToBorrow,         // uint _amount0
            amount1ToBorrow,         // uint _amount1
            encodedParamsBytes       // bytes calldata _params (The encoded struct)
        ];
        loggerInstance.debug(`${logPrefix} Prepared contract arguments for function ${buildResult.contractFunctionName}`);

        // 9. Get Gas Limit from trade data
        // *** CRITICAL ASSUMPTION: ProfitCalculator adds 'gasEstimate' (BigInt limit) to tradeData ***
        const gasLimit = BigInt(tradeToExecute.gasEstimate || 0n); // VERIFY FIELD NAME
        if (gasLimit <= 0n) {
            throw new Error("Missing or invalid gas estimate (gasLimit) on trade data.");
        }
        loggerInstance.debug(`${logPrefix} Using Gas Limit: ${gasLimit.toString()}`);

        // 10. Execute
        loggerInstance.warn(`${logPrefix} >>> ATTEMPTING EXECUTION of ${buildResult.contractFunctionName} <<<`);
        const executionResult = await executeTransaction(
            buildResult.contractFunctionName, // Function name from builder
            contractCallArgs,                 // Arguments for the contract function
            flashSwapManagerInstance,         // Manager instance
            gasLimit,                         // Gas limit from profitable trade data
            feeData,                          // Fetched fee data
            loggerInstance,                   // Logger instance
            false                             // isDryRun = false (already checked)
        );

        // 11. Log Result
        if (executionResult.success) {
            loggerInstance.info(`${logPrefix} 🎉🎉🎉 SUCCESSFULLY EXECUTED Transaction: ${executionResult.txHash}`);
            // Optional: Implement STOP_ON_FIRST_EXECUTION logic (needs gracefulShutdown passed or handled differently)
            // if (config.STOP_ON_FIRST_EXECUTION) {
            //     loggerInstance.warn(`${logPrefix} STOP_ON_FIRST_EXECUTION is true. Signaling stop...`);
            //     // Need a way to signal back to main process to shutdown gracefully
            // }
        } else {
            loggerInstance.error(`${logPrefix} Execution FAILED. See logs above for details. Hash: ${executionResult.txHash || 'N/A'}`);
        }

    } catch (execError) {
        loggerInstance.error(`${logPrefix} Error processing trade for execution: ${execError.message}`, execError);
        // Use global ErrorHandler if available
        ErrorHandler?.handleError(execError, 'TradeHandlerExecution');
    }
}

module.exports = {
    processAndExecuteTrades,
};
