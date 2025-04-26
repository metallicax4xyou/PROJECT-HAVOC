// core/tradeHandler.js
// --- VERSION v1.1 --- Removes unsupported path builders (V3<->Sushi).

const { ethers } = require('ethers');
const logger = require('../utils/logger');
const ErrorHandler = require('../utils/errorHandler');
const TxParamBuilder = require('./tx/paramBuilder');
// const TxEncoder = require('./tx/encoder'); // Encoder logic is simple enough to do inline here
const { executeTransaction } = require('./txExecutor');

/**
 * Processes profitable trades, selects the best, builds/encodes, and executes it.
 * Handles V3->V3 (TwoHop) and Triangular paths based on FlashSwap.sol v3.0+.
 */
async function processAndExecuteTrades(
    trades,
    config,
    flashSwapManagerInstance,
    gasEstimatorInstance,
    loggerInstance = logger
) {
    const isDryRun = config.DRY_RUN === 'true' || config.DRY_RUN === true;
    const logPrefix = '[TradeHandler v1.1]';

    if (!flashSwapManagerInstance || trades.length === 0) {
        loggerInstance.info(`${logPrefix} No trades or FlashSwapManager missing. Skipping.`);
        return;
    }

    if (isDryRun) {
        loggerInstance.info(`${logPrefix} DRY_RUN=true. Logging opportunities, skipping execution.`);
        trades.forEach((trade, index) => {
            loggerInstance.info(`${logPrefix} [DRY RUN Trade ${index + 1}] Type: ${trade.type}, Path: ${trade.path?.map(p=>p.dex).join('->') || 'N/A'}, Profit: ${ethers.formatEther(trade.netProfitNativeWei || 0n)} ${config.NATIVE_CURRENCY_SYMBOL}`);
        });
        return;
    }

    loggerInstance.info(`${logPrefix} DRY_RUN=false. Processing ${trades.length} trades for potential execution...`);

    trades.sort((a, b) => (BigInt(b.netProfitNativeWei || 0n)) - (BigInt(a.netProfitNativeWei || 0n)));
    const tradeToExecute = trades[0];
    loggerInstance.info(`${logPrefix} Prioritizing best trade. Type: ${tradeToExecute.type}, Path: ${tradeToExecute.path?.map(p=>p.dex).join('->') || 'N/A'}, Est. Net Profit: ${ethers.formatEther(tradeToExecute.netProfitNativeWei || 0n)} ${config.NATIVE_CURRENCY_SYMBOL}`);

    try {
        // 1. Get Current Fee Data
        const feeData = await gasEstimatorInstance.getFeeData();
        if (!feeData || (!feeData.maxFeePerGas && !feeData.gasPrice)) {
            throw new Error("Failed to get valid fee data for execution.");
        }

        // 2. Select Builder Function based on SUPPORTED paths
        let builderFunction;
        if (!tradeToExecute.path || !Array.isArray(tradeToExecute.path) || tradeToExecute.path.length === 0) {
             throw new Error(`Trade object missing valid path information.`);
        }
        const dexPath = tradeToExecute.path.map(p => p.dex).join('->');
        loggerInstance.debug(`${logPrefix} Determining builder for type: ${tradeToExecute.type}, path: ${dexPath}`);

        if (tradeToExecute.type === 'spatial' && dexPath === 'uniswapV3->uniswapV3') {
             builderFunction = TxParamBuilder.buildTwoHopParams; // For initiateFlashSwap
        } else if (tradeToExecute.type === 'triangular') {
             builderFunction = TxParamBuilder.buildTriangularParams; // For initiateTriangularFlashSwap
             loggerInstance.warn(`${logPrefix} Using triangular builder. Ensure paramBuilder TODO is resolved.`);
        } else {
             // Log unsupported paths instead of throwing immediately, maybe finder is wrong?
             loggerInstance.warn(`${logPrefix} Skipping trade: Unsupported type/path for execution: ${tradeToExecute.type} / ${dexPath}`);
             return; // Exit processing for this trade
        }
        loggerInstance.debug(`${logPrefix} Selected builder: ${builderFunction.name}`);

        // 3. Prepare Simulation Data for Builder
        // *** CRITICAL ASSUMPTION: ProfitCalculator provides necessary data ***
        const simResultForBuilder = {
            initialAmount: BigInt(tradeToExecute.amountIn || 0n),
            // Required by buildTwoHopParams
            hop1AmountOut: BigInt(tradeToExecute.intermediateAmountOut || 0n),
            finalAmount: BigInt(tradeToExecute.amountOut || 0n),
            // Add other fields if needed by triangular builder
        };
        if (!simResultForBuilder.initialAmount || !simResultForBuilder.finalAmount || (tradeToExecute.type === 'spatial' && !simResultForBuilder.hop1AmountOut)) {
            loggerInstance.error(`${logPrefix} tradeData missing required amount fields for builder.`, { tradeDataKeys: Object.keys(tradeToExecute), simResultForBuilder });
            throw new Error(`Incomplete trade data for builder - missing amount fields.`);
        }

        // 4. Call Builder
        const buildResult = builderFunction(tradeToExecute, simResultForBuilder, config);
        if (!buildResult || !buildResult.params || !buildResult.borrowTokenAddress || !buildResult.borrowAmount || !buildResult.typeString || !buildResult.contractFunctionName) {
            throw new Error("Parameter builder failed to return expected structure.");
        }

        // 5. Encode Parameters Struct
        const encodedParamsBytes = ethers.AbiCoder.defaultAbiCoder().encode([buildResult.typeString], [buildResult.params]);

        // 6. Determine amount0/amount1 for flash() call
        const borrowPoolState = tradeToExecute.path[0].poolState; // Assumes V3 borrow pool is path[0]
        if (!borrowPoolState || !borrowPoolState.token0?.address || !borrowPoolState.token1?.address || tradeToExecute.path[0].dex !== 'uniswapV3') {
            loggerInstance.error(`${logPrefix} Cannot determine flash loan amounts: Borrow must originate from a V3 pool defined in path[0].`, { path0: tradeToExecute.path[0] });
            throw new Error("Cannot determine flash loan amounts: Invalid borrow pool state or not V3.");
        }
        let amount0ToBorrow = 0n; let amount1ToBorrow = 0n;
        const borrowTokenAddrLower = buildResult.borrowTokenAddress.toLowerCase();
        if (borrowTokenAddrLower === borrowPoolState.token0.address.toLowerCase()) amount0ToBorrow = buildResult.borrowAmount;
        else if (borrowTokenAddrLower === borrowPoolState.token1.address.toLowerCase()) amount1ToBorrow = buildResult.borrowAmount;
        else { throw new Error(`Borrow token ${buildResult.borrowTokenAddress} does not match borrow pool tokens ${borrowPoolState.token0.address}/${borrowPoolState.token1.address}`); }
        loggerInstance.debug(`${logPrefix} Flash Loan Amounts: Amt0=${amount0ToBorrow}, Amt1=${amount1ToBorrow}`);

        // 7. Prepare Contract Call Arguments (Verified against FlashSwap.sol)
        const contractCallArgs = [
            borrowPoolState.address, // address _poolAddress
            amount0ToBorrow,         // uint _amount0
            amount1ToBorrow,         // uint _amount1
            encodedParamsBytes       // bytes calldata _params
        ];
        loggerInstance.debug(`${logPrefix} Prepared contract arguments for function ${buildResult.contractFunctionName}`);

        // 8. Get Gas Limit from trade data
        // *** CRITICAL ASSUMPTION: ProfitCalculator provides 'gasEstimate' (BigInt limit) ***
        const gasLimit = BigInt(tradeToExecute.gasEstimate || 0n);
        if (gasLimit <= 0n) {
            throw new Error("Missing or invalid gas estimate (gasLimit) on trade data.");
        }
        loggerInstance.debug(`${logPrefix} Using Gas Limit: ${gasLimit.toString()}`);

        // 9. Execute
        loggerInstance.warn(`${logPrefix} >>> ATTEMPTING EXECUTION of ${buildResult.contractFunctionName} <<<`);
        const executionResult = await executeTransaction(
            buildResult.contractFunctionName, // Function name from builder
            contractCallArgs,                 // Arguments for the contract function
            flashSwapManagerInstance,         // Manager instance
            gasLimit,                         // Gas limit from profitable trade data
            feeData,                          // Fetched fee data
            loggerInstance,                   // Logger instance
            false                             // isDryRun = false
        );

        // 10. Log Result & Handle Stop
        if (executionResult.success) {
            loggerInstance.info(`${logPrefix} 🎉🎉🎉 SUCCESSFULLY EXECUTED Transaction: ${executionResult.txHash}`);
            if (config.STOP_ON_FIRST_EXECUTION) {
                loggerInstance.warn(`${logPrefix} STOP_ON_FIRST_EXECUTION is true. Signaling stop... (Manual restart needed)`);
                // We don't have access to gracefulShutdown here easily.
                // For now, just exit. A more elegant solution involves IPC or shared state.
                process.exit(0);
            }
        } else {
            loggerInstance.error(`${logPrefix} Execution FAILED. See logs above for details. Hash: ${executionResult.txHash || 'N/A'}`);
        }

    } catch (execError) {
        loggerInstance.error(`${logPrefix} Error processing trade for execution: ${execError.message}`, execError);
        ErrorHandler?.handleError(execError, 'TradeHandlerExecution');
    }
} // End processAndExecuteTrades

module.exports = {
    processAndExecuteTrades,
};
