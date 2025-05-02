// core/tradeHandler.js
// --- VERSION v1.3 --- Passes titheRecipient from config to builders.

const { ethers } = require('ethers');
const logger = require('../utils/logger');
const ErrorHandler = require('../utils/errorHandler');
const TxParamBuilder = require('./tx/paramBuilder'); // Now includes aavePathBuilder
const { executeTransaction } = require('./txExecutor');

/**
 * Processes profitable trades, selects the best, determines flash loan provider (UniV3 or Aave),
 * builds/encodes parameters, and executes the appropriate transaction.
 * Handles V3->V3 (UniV3 FlashLoan) and any path starting non-V3 (Aave FlashLoan).
 * Now retrieves and passes the titheRecipient from config to the builders.
 */
async function processAndExecuteTrades(
    trades,
    config,
    flashSwapManagerInstance,
    gasEstimatorInstance,
    loggerInstance = logger // Allow passing logger, default to global
) {
    const isDryRun = config.DRY_RUN === 'true' || config.DRY_RUN === true;
    const logPrefix = '[TradeHandler v1.3]'; // Updated version

    // --- Retrieve Tithe Recipient from Config ---
    const titheRecipient = config.TITHE_WALLET_ADDRESS;
    if (!titheRecipient || !ethers.isAddress(titheRecipient)) {
        // This is a critical error, should have been caught by config validation,
        // but double-check here before attempting to use it.
        loggerInstance.error(`${logPrefix} CRITICAL ERROR: TITHE_WALLET_ADDRESS is missing or invalid in configuration. Cannot proceed with execution.`);
        // Depending on desired behavior, you might throw an error, exit, or log and return.
        // Returning allows other parts of the bot to potentially continue.
        return;
    }
    loggerInstance.debug(`${logPrefix} Tithe Recipient Address: ${titheRecipient}`);


    if (!flashSwapManagerInstance || trades.length === 0) {
        loggerInstance.info(`${logPrefix} No trades or FlashSwapManager missing. Skipping.`);
        return;
    }

    if (isDryRun) {
        loggerInstance.info(`${logPrefix} DRY_RUN=true. Logging opportunities, skipping execution.`);
        trades.forEach((trade, index) => {
             // Determine potential provider for logging clarity
             let providerType = 'UNKNOWN';
             if (trade.path && trade.path.length > 0) {
                 providerType = (trade.path[0].dex === 'uniswapV3') ? 'UNIV3' : 'AAVE';
             }
            loggerInstance.info(`${logPrefix} [DRY RUN Trade ${index + 1}] Provider: ${providerType}, Type: ${trade.type}, Path: ${trade.path?.map(p=>p.dex).join('->') || 'N/A'}, Profit: ${ethers.formatEther(trade.netProfitNativeWei || 0n)} ${config.NATIVE_CURRENCY_SYMBOL}`);
            // --- Log Tithe Recipient in Dry Run if desired ---
            // loggerInstance.debug(`${logPrefix} [DRY RUN Trade ${index + 1}] Tithe Recipient: ${titheRecipient}`);
        });
        return;
    }

    loggerInstance.info(`${logPrefix} DRY_RUN=false. Processing ${trades.length} trades for potential execution...`);

    // Sort and select the best trade
    trades.sort((a, b) => (BigInt(b.netProfitNativeWei || 0n)) - (BigInt(a.netProfitNativeWei || 0n)));
    const tradeToExecute = trades[0];
    loggerInstance.info(`${logPrefix} Prioritizing best trade. Type: ${tradeToExecute.type}, Path: ${tradeToExecute.path?.map(p=>p.dex).join('->') || 'N/A'}, Est. Net Profit: ${ethers.formatEther(tradeToExecute.netProfitNativeWei || 0n)} ${config.NATIVE_CURRENCY_SYMBOL}`);

    let providerType = 'UNKNOWN'; // 'UNIV3' or 'AAVE'

    try {
        // --- Validate trade path exists ---
        if (!tradeToExecute.path || !Array.isArray(tradeToExecute.path) || tradeToExecute.path.length === 0) {
             throw new Error(`Trade object missing valid path information.`);
        }

        // --- 1. Determine Flash Loan Provider ---
        if (tradeToExecute.path[0].dex === 'uniswapV3') {
            providerType = 'UNIV3';
            loggerInstance.info(`${logPrefix} First hop is UniV3. Selecting UniV3 Flash Loan provider.`);
        } else {
            providerType = 'AAVE';
            loggerInstance.info(`${logPrefix} First hop is ${tradeToExecute.path[0].dex}. Selecting AAVE Flash Loan provider.`);
            // Add check if Aave is configured/enabled?
            if (!config.AAVE_POOL_ADDRESS) {
                 loggerInstance.error(`${logPrefix} Cannot use Aave provider: AAVE_POOL_ADDRESS not configured.`);
                 return; // Exit if Aave selected but not configured
            }
        }

        // --- 2. Get Current Fee Data ---
        const feeData = await gasEstimatorInstance.getFeeData();
        if (!feeData || (!feeData.maxFeePerGas && !feeData.gasPrice)) {
            throw new Error("Failed to get valid fee data for execution.");
        }

        // --- 3. Prepare based on Provider Type ---
        let buildResult;
        let contractCallArgs;
        let encodedParamsBytes; // Needed for UniV3 args

        // --- 3.A. Prepare Simulation Data for Builder ---
        // Builders need consistent input regardless of provider
        const simResultForBuilder = {
            initialAmount: BigInt(tradeToExecute.amountIn || 0n),
            hop1AmountOut: BigInt(tradeToExecute.intermediateAmountOut || 0n), // Needed for buildTwoHopParams
            finalAmount: BigInt(tradeToExecute.amountOut || 0n),
            // Add other fields if needed by other builders (e.g., triangular)
        };
        if (!simResultForBuilder.initialAmount || !simResultForBuilder.finalAmount) {
            loggerInstance.error(`${logPrefix} tradeData missing required amountIn/amountOut fields for builder.`);
            throw new Error(`Incomplete trade data for builder - missing amountIn/amountOut.`);
        }


        if (providerType === 'UNIV3') {
            loggerInstance.debug(`${logPrefix} Preparing for UniV3 execution...`);
            // --- 3.A.1 Select UniV3 Builder ---
            let builderFunction;
            const dexPath = tradeToExecute.path.map(p => p.dex).join('->');
            if (tradeToExecute.type === 'spatial' && dexPath === 'uniswapV3->uniswapV3') {
                 builderFunction = TxParamBuilder.buildTwoHopParams;
            } else if (tradeToExecute.type === 'triangular') { // Assuming triangular always uses UniV3 loan
                 builderFunction = TxParamBuilder.buildTriangularParams;
                 loggerInstance.warn(`${logPrefix} Using triangular builder (UniV3 Loan). Ensure paramBuilder TODO is resolved.`);
            } else {
                 loggerInstance.warn(`${logPrefix} Skipping trade: Unsupported type/path for UniV3 Flash Loan: ${tradeToExecute.type} / ${dexPath}`);
                 return;
            }
            loggerInstance.debug(`${logPrefix} Selected builder: ${builderFunction.name}`);

            // --- 3.A.2 Call UniV3 Builder ---
            // --- PASSING titheRecipient to the builder ---
            buildResult = builderFunction(tradeToExecute, simResultForBuilder, config, titheRecipient); // <-- Passed titheRecipient here
            if (!buildResult || !buildResult.params || !buildResult.borrowTokenAddress || !buildResult.borrowAmount || !buildResult.typeString || !buildResult.contractFunctionName) {
                throw new Error("UniV3 parameter builder failed to return expected structure.");
            }

            // --- 3.A.3 Encode Parameters Struct ---
            encodedParamsBytes = ethers.AbiCoder.defaultAbiCoder().encode([buildResult.typeString], [buildResult.params]);

            // --- 3.A.4 Determine amount0/amount1 for flash() call ---
            const borrowPoolState = tradeToExecute.path[0].poolState; // Already checked path[0] exists and is V3
            if (!borrowPoolState || !borrowPoolState.token0?.address || !borrowPoolState.token1?.address) {
                 throw new Error("Cannot determine flash loan amounts: Invalid borrow pool state.");
            }
            let amount0ToBorrow = 0n; let amount1ToBorrow = 0n;
            const borrowTokenAddrLower = buildResult.borrowTokenAddress.toLowerCase();
            if (borrowTokenAddrLower === borrowPoolState.token0.address.toLowerCase()) amount0ToBorrow = buildResult.borrowAmount;
            else if (borrowTokenAddrLower === borrowPoolState.token1.address.toLowerCase()) amount1ToBorrow = buildResult.borrowAmount;
            else { throw new Error(`Borrow token ${buildResult.borrowTokenAddress} does not match borrow pool tokens ${borrowPoolState.token0.address}/${borrowPoolState.token1.address}`); }
            loggerInstance.debug(`${logPrefix} UniV3 Flash Loan Amounts: Amt0=${amount0ToBorrow}, Amt1=${amount1ToBorrow}`);

            // --- 3.A.5 Prepare Contract Call Arguments ---
            // Assuming FlashSwap.sol's flash() function signature is (address pool, uint256 amount0, uint256 amount1, bytes calldata data)
            contractCallArgs = [
                borrowPoolState.address, // address _poolAddress
                amount0ToBorrow,         // uint _amount0
                amount1ToBorrow,         // uint _amount1
                encodedParamsBytes       // bytes calldata _params (contains the actual swap params + titheRecipient)
            ];

        } else if (providerType === 'AAVE') {
            loggerInstance.debug(`${logPrefix} Preparing for Aave execution...`);
            // --- 3.B.1 Call Aave Builder ---
             if (!TxParamBuilder.buildAavePathParams) { // Check if builder exists
                 throw new Error("Aave parameter builder (buildAavePathParams) not found in paramBuilder index.");
             }
             // --- PASSING titheRecipient to the Aave builder ---
             buildResult = await TxParamBuilder.buildAavePathParams(tradeToExecute, simResultForBuilder, config, flashSwapManagerInstance, titheRecipient); // <-- Passed titheRecipient here
             if (!buildResult || !buildResult.params || !buildResult.borrowTokenAddress || !buildResult.borrowAmount || !buildResult.typeString || !buildResult.contractFunctionName) {
                 throw new Error("Aave parameter builder failed to return expected structure.");
             }
             if (buildResult.contractFunctionName !== 'initiateAaveFlashLoan') {
                 loggerInstance.warn(`${logPrefix} Aave builder returned unexpected function name: ${buildResult.contractFunctionName}`);
             }

             // --- 3.B.2 Encode Parameters Struct (ArbParams) ---
             const encodedArbParamsBytes = ethers.AbiCoder.defaultAbiCoder().encode([buildResult.typeString], [buildResult.params]);

             // --- 3.B.3 Prepare Contract Call Arguments ---
             // Assuming FlashSwap.sol's initiateAaveFlashLoan signature is (address[] assets, uint256[] amounts, bytes params)
             contractCallArgs = [
                 [buildResult.borrowTokenAddress], // address[] memory assets
                 [buildResult.borrowAmount],       // uint256[] memory amounts
                 encodedArbParamsBytes             // bytes memory params (contains the actual swap path + titheRecipient)
             ];

        } else {
             // Should not happen due to initial check, but safeguard
             throw new Error("Unknown providerType determined.");
        }


        // --- 4. Get Gas Limit ---
        // Note: Gas estimation should ideally happen AFTER params are fully built,
        // possibly simulating the *entire* flash loan call.
        // This current gas estimate is from the initial opportunity finding, which might be
        // less accurate for the final transaction. Consider refining gas estimation later (Phase 1).
        const gasLimit = BigInt(tradeToExecute.gasEstimate || 0n);
        if (gasLimit <= 0n) {
            // Log a warning or error, but maybe don't hard-fail if gasEstimatorInstance can provide a fallback?
            // For now, keep it as an error as in original code.
            throw new Error("Missing or invalid gas estimate (gasLimit) on trade data.");
        }
        loggerInstance.debug(`${logPrefix} Using Gas Limit: ${gasLimit.toString()}`);
        loggerInstance.debug(`${logPrefix} Prepared contract arguments for function ${buildResult.contractFunctionName}`);


        // --- 5. Execute ---
        loggerInstance.warn(`${logPrefix} >>> ATTEMPTING EXECUTION via ${providerType} path (${buildResult.contractFunctionName}) <<<`);
        const executionResult = await executeTransaction(
            buildResult.contractFunctionName, // Function name from builder
            contractCallArgs,                 // Arguments for the specific contract function
            flashSwapManagerInstance,         // Manager instance
            gasLimit,                         // Gas limit from profitable trade data
            feeData,                          // Fetched fee data
            loggerInstance,                   // Logger instance
            false                             // isDryRun = false
        );

        // --- 6. Log Result & Handle Stop ---
        if (executionResult.success) {
            loggerInstance.info(`${logPrefix} 🎉🎉🎉 SUCCESSFULLY EXECUTED via ${providerType}. Tx: ${executionResult.txHash}`);
            // --- Log Tithe Recipient on Success ---
            loggerInstance.info(`${logPrefix} Tithe Destination: ${titheRecipient}`);

            if (config.STOP_ON_FIRST_EXECUTION) {
                loggerInstance.warn(`${logPrefix} STOP_ON_FIRST_EXECUTION is true. Signaling stop... (Manual restart needed)`);
                process.exit(0); // Simple exit for now
            }
        } else {
            loggerInstance.error(`${logPrefix} Execution FAILED via ${providerType}. See logs above for details. Hash: ${executionResult.txHash || 'N/A'}`);
             // Log Tithe Recipient even on failure for debugging? Maybe too much info.
             // loggerInstance.debug(`${logPrefix} Tithe Destination (Attempted): ${titheRecipient}`);
        }

    } catch (execError) {
        loggerInstance.error(`${logPrefix} Error processing trade for execution (Provider Path: ${providerType}): ${execError.message}`, execError);
        ErrorHandler?.handleError(execError, `TradeHandlerExecution (${providerType})`);
    }
} // End processAndExecuteTrades

module.exports = {
    processAndExecuteTrades,
};
