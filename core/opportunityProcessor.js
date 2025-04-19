// core/opportunityProcessor.js
// --- VERSION UPDATED FOR ETHERS V6 UTILS & PHASE 1 REFACTOR ---
// Integrates new GasEstimator & ProfitCalculator classes and revised txExecutor call

const { ethers } = require('ethers'); // Ethers v6+
const { Token } = require('@uniswap/sdk-core'); // Ensure this is the correct import for your SDK version
const logger = require('../utils/logger'); // Use the global logger instance
const { ArbitrageError, handleError } = require('../utils/errorHandler');
// No need to import ProfitCalculator/GasEstimator class here if instances are passed in context
const { executeTransaction } = require('./txExecutor'); // Import the refactored executor
const { stringifyPoolState } = require('./simulationHelpers'); // Keep simulation helpers if used
const TxUtils = require('./tx'); // ParamBuilder, Encoder from the tx module index

async function processOpportunity(opp, engineContext) {
    // Destructure instances and *parsed* config values from context
    const {
        config, // Expect raw config + parsed values like { parsed: { minProfitWei, maxGasWei, ... } }
        manager, // FlashSwapManager instance
        gasEstimator, // Instance of new GasEstimator class
        profitCalculator, // Instance of new ProfitCalculator class
        quoteSimulator, // Instance of QuoteSimulator
        // logger: contextLogger // Use the global logger directly unless contextLogger has specific tags
    } = engineContext;

    // Use the global logger instance, adding context via prefix
    const logPrefix = `[OppProcessor Type: ${opp?.type || 'N/A'}, Group: ${opp?.groupName || 'N/A'}]`;
    logger.info(`${logPrefix} Processing potential opportunity... ID: ${opp?.id || 'N/A'}`); // Add opp ID if available

    // --- Input Validations ---
    if (!config || !config.parsed || !manager || !gasEstimator || !profitCalculator || !quoteSimulator) {
        const errMsg = `${logPrefix} Missing critical dependencies or parsed config in engineContext. Aborting.`;
        logger.error(errMsg, {
            hasConfig: !!config, hasParsedConfig: !!config?.parsed, hasManager: !!manager,
            hasGasEstimator: !!gasEstimator, hasProfitCalculator: !!profitCalculator, hasQuoteSimulator: !!quoteSimulator
        });
        return { executed: false, success: false, txHash: null, error: new ArbitrageError(errMsg, 'INTERNAL_ERROR'), simulationResult: null, profitabilityResult: null };
    }
    if (!opp || typeof opp !== 'object' || !opp.type || !opp.groupName) {
         logger.error(`${logPrefix} Invalid or incomplete opportunity object received.`, opp);
         return { executed: false, success: false, txHash: null, error: new ArbitrageError('Invalid opportunity object', 'INTERNAL_ERROR'), simulationResult: null, profitabilityResult: null };
    }
    if (opp.type !== 'triangular') {
         logger.warn(`${logPrefix} Skipping opportunity type '${opp.type}' - only 'triangular' is currently implemented for execution.`);
         return { executed: false, success: false, txHash: null, error: null, reason: 'UNSUPPORTED_TYPE', simulationResult: null, profitabilityResult: null };
    }
    // --- End Validations ---

    let simulationResult = null;
    let profitabilityResult = null; // Stores result from profitCalculator
    let feeData = null; // Store fee data fetched early
    let txRequestForGas = null; // Store the request used for gas estimation
    let gasEstimate = null; // Store the final gas estimate (BigInt)
    let buildResult = null; // Store result from ParamBuilder
    let flashSwapInterface = null; // Store interface for re-use

    try {
        // --- 1. Fetch Fee Data and Check Max Gas Price ---
        logger.debug(`${logPrefix} Fetching current fee data...`);
        feeData = await gasEstimator.getFeeData();
        const maxGasWei = config.parsed.maxGasWei; // Already BigInt from engine constructor
        if (!feeData || (!feeData.maxFeePerGas && !feeData.gasPrice)) { // Check both fee types
             throw new ArbitrageError(`${logPrefix} Failed to fetch valid fee data (maxFeePerGas or gasPrice). Cannot proceed.`, 'NETWORK_ERROR');
        }

        let currentGasPriceGwei;
        if (feeData.maxFeePerGas) { // Prioritize EIP-1559
             currentGasPriceGwei = ethers.formatUnits(feeData.maxFeePerGas, 'gwei');
             logger.info(`${logPrefix} Current Gas (Gwei): Max=${currentGasPriceGwei}, Priority=${feeData.maxPriorityFeePerGas ? ethers.formatUnits(feeData.maxPriorityFeePerGas, 'gwei') : 'N/A'}`);
             if (feeData.maxFeePerGas > maxGasWei) { // BigInt comparison
                 logger.warn(`${logPrefix} ⛽ Max Fee Per Gas too high (${currentGasPriceGwei} Gwei > Max ${ethers.formatUnits(maxGasWei, 'gwei')} Gwei). Skipping.`);
                 return { executed: false, success: false, txHash: null, error: null, reason: 'GAS_PRICE_TOO_HIGH', simulationResult, profitabilityResult };
             }
        } else { // Fallback to Legacy
             currentGasPriceGwei = ethers.formatUnits(feeData.gasPrice, 'gwei');
             logger.warn(`${logPrefix} Using legacy gasPrice (${currentGasPriceGwei} Gwei) as maxFeePerGas is unavailable.`);
             if (feeData.gasPrice > maxGasWei) { // BigInt comparison
                  logger.warn(`${logPrefix} ⛽ Legacy Gas price too high (${currentGasPriceGwei} Gwei > Max ${ethers.formatUnits(maxGasWei, 'gwei')} Gwei). Skipping.`);
                  return { executed: false, success: false, txHash: null, error: null, reason: 'GAS_PRICE_TOO_HIGH', simulationResult, profitabilityResult };
             }
        }


        // --- 2. Find Group Config & Validate ---
        const groupConfig = config.POOL_GROUPS.find(g => g.name === opp.groupName);
        if (!groupConfig) { throw new ArbitrageError(`${logPrefix} Configuration for group '${opp.groupName}' not found.`, 'CONFIG_ERROR'); }
        // Check borrowAmount is BigInt (should be from poolProcessor)
        if (!groupConfig.sdkBorrowToken || !groupConfig.borrowAmount || typeof groupConfig.borrowAmount !== 'bigint') {
            throw new ArbitrageError(`${logPrefix} Incomplete/invalid config for group '${opp.groupName}' (missing/invalid sdkBorrowToken or borrowAmount).`, 'CONFIG_ERROR', { groupConfig });
        }


        // --- 3. Prepare for Simulation ---
        const borrowTokenSymbol = groupConfig.borrowTokenSymbol;
        if (!opp.pathSymbols || opp.pathSymbols.length !== 4 || opp.pathSymbols[0] !== borrowTokenSymbol || opp.pathSymbols[3] !== borrowTokenSymbol) {
             throw new ArbitrageError(`${logPrefix} Invalid opportunity path symbols for triangular arbitrage.`, 'CONFIG_ERROR', { path: opp.pathSymbols });
        }
        const initialAmount = groupConfig.borrowAmount; // Already BigInt


        // --- 4. Simulate Arbitrage Path ---
        // --- Use ethers.formatUnits (v6 syntax) ---
        logger.info(`${logPrefix} Simulating path: ${opp.pathSymbols.join(' -> ')} with Input: ${ethers.formatUnits(initialAmount, groupConfig.sdkBorrowToken.decimals)} ${borrowTokenSymbol}`);

        if (!opp.pools || opp.pools.length !== 3) {
            throw new ArbitrageError(`${logPrefix} Invalid number of pools for triangular opportunity (${opp.pools?.length}).`, 'INTERNAL_ERROR', { opp });
        }
        const [pool1, pool2, pool3] = opp.pools;
        if (!pool1 || !pool2 || !pool3) { throw new ArbitrageError(`${logPrefix} One or more pools are undefined.`, 'INTERNAL_ERROR'); }

        // Resolve Tokens (Ensure they are SDK Token instances from the Pool objects)
        const tokenA = groupConfig.sdkBorrowToken; // Use the one from config
        const tokenB = (pool1.token0?.address === tokenA.address) ? pool1.token1 : pool1.token0;
        const tokenC = (pool2.token0?.address === tokenB?.address) ? pool2.token1 : pool2.token0;

        if (!(tokenB instanceof Token) || !(tokenC instanceof Token)) {
            throw new ArbitrageError(`${logPrefix} Failed to resolve SDK Token instances for B or C. B=${tokenB?.symbol}, C=${tokenC?.symbol}`, 'INTERNAL_ERROR');
        }

        // Execute simulation hops (Keep existing logic using quoteSimulator)
        logger.debug(`${logPrefix} Simulating Hop 1 (${tokenA.symbol}->${tokenB.symbol}) on Pool ${pool1.address}...`);
        const hop1Result = await quoteSimulator.simulateSingleSwapExactIn(pool1, tokenA, tokenB, initialAmount);
        // Use ethers.toBigInt for consistent BigInt handling and comparison
        if (!hop1Result || !ethers.isBigNumberish(hop1Result.amountOut) || ethers.toBigInt(hop1Result.amountOut) <= 0n) {
             throw new ArbitrageError(`${logPrefix} Hop 1 simulation failed or returned zero/negative output.`, 'SIMULATION_ERROR', { hop: 1, result: hop1Result });
        }
        const amountB_Received = ethers.toBigInt(hop1Result.amountOut); // Ensure BigInt
        // --- Use ethers.formatUnits (v6 syntax) ---
        logger.info(`[SIM Hop 1 ${tokenA.symbol}->${tokenB.symbol}] Output: ${ethers.formatUnits(amountB_Received, tokenB.decimals)} ${tokenB.symbol}`);

        logger.debug(`${logPrefix} Simulating Hop 2 (${tokenB.symbol}->${tokenC.symbol}) on Pool ${pool2.address}...`);
        const hop2Result = await quoteSimulator.simulateSingleSwapExactIn(pool2, tokenB, tokenC, amountB_Received);
        if (!hop2Result || !ethers.isBigNumberish(hop2Result.amountOut) || ethers.toBigInt(hop2Result.amountOut) <= 0n) {
             throw new ArbitrageError(`${logPrefix} Hop 2 simulation failed or returned zero/negative output.`, 'SIMULATION_ERROR', { hop: 2, result: hop2Result });
        }
        const amountC_Received = ethers.toBigInt(hop2Result.amountOut);
        // --- Use ethers.formatUnits (v6 syntax) ---
        logger.info(`[SIM Hop 2 ${tokenB.symbol}->${tokenC.symbol}] Output: ${ethers.formatUnits(amountC_Received, tokenC.decimals)} ${tokenC.symbol}`);

        logger.debug(`${logPrefix} Simulating Hop 3 (${tokenC.symbol}->${tokenA.symbol}) on Pool ${pool3.address}...`);
        const hop3Result = await quoteSimulator.simulateSingleSwapExactIn(pool3, tokenC, tokenA, amountC_Received);
        if (!hop3Result || !ethers.isBigNumberish(hop3Result.amountOut) || ethers.toBigInt(hop3Result.amountOut) <= 0n) {
             throw new ArbitrageError(`${logPrefix} Hop 3 simulation failed or returned zero/negative output.`, 'SIMULATION_ERROR', { hop: 3, result: hop3Result });
        }
        const finalAmount = ethers.toBigInt(hop3Result.amountOut);
        // --- Use ethers.formatUnits (v6 syntax) ---
        logger.info(`[SIM Hop 3 ${tokenC.symbol}->${tokenA.symbol}] Output: ${ethers.formatUnits(finalAmount, tokenA.decimals)} ${tokenA.symbol}`);


        // --- 5. Calculate Gross Profit & Check ---
        const grossProfit = finalAmount - initialAmount; // BigInt subtraction
        simulationResult = {
            profitable: grossProfit > 0n, // BigInt comparison
            error: null, initialAmount, finalAmount, grossProfit, // BigInts
            details: { tokenA, tokenB, tokenC, hop1Result, hop2Result, hop3Result } // Include resolved SDK tokens
        };

        if (!simulationResult.profitable) {
            // --- Use ethers.formatUnits (v6 syntax) ---
            logger.info(`${logPrefix} Simulation shows NO gross profit (${ethers.formatUnits(simulationResult.grossProfit, tokenA.decimals)} ${tokenA.symbol}). Skipping.`);
            return { executed: false, success: false, txHash: null, error: null, reason: 'NO_GROSS_PROFIT', simulationResult, profitabilityResult };
        }
        // --- Use ethers.formatUnits (v6 syntax) ---
        logger.info(`${logPrefix} ✅ Simulation shows POSITIVE gross profit: ${ethers.formatUnits(simulationResult.grossProfit, tokenA.decimals)} ${tokenA.symbol}`);


        // --- 6. Prepare Transaction Request for Gas Estimation ---
        try {
            logger.debug(`${logPrefix} Preparing transaction request using ParamBuilder...`);
            buildResult = TxUtils.ParamBuilder.buildTriangularParams(opp, simulationResult, config);
            if (!buildResult || !buildResult.params || !buildResult.typeString || !buildResult.contractFunctionName || !buildResult.borrowTokenAddress || !buildResult.borrowAmount) {
                 throw new Error("ParamBuilder did not return expected structure.");
            }

            const encodedParams = TxUtils.Encoder.encodeParams(buildResult.params, buildResult.typeString);
            const borrowPoolAddress = opp.pools[0].address;
            const borrowTokenAddress = buildResult.borrowTokenAddress; // Should match tokenA.address
            const borrowAmountBigInt = ethers.toBigInt(buildResult.borrowAmount); // Ensure BigInt

            const pool1Token0Addr = opp.pools[0].token0?.address;
            const pool1Token1Addr = opp.pools[0].token1?.address;
            if (!pool1Token0Addr || !pool1Token1Addr) { throw new Error(`Pool 1 (${borrowPoolAddress}) token addresses missing.`); }

            let amount0ToBorrow = 0n; // Use BigInt literal
            let amount1ToBorrow = 0n;
             // --- Use ethers.getAddress (v6 syntax) ---
            if (ethers.getAddress(borrowTokenAddress) === ethers.getAddress(pool1Token0Addr)) { amount0ToBorrow = borrowAmountBigInt; }
            else if (ethers.getAddress(borrowTokenAddress) === ethers.getAddress(pool1Token1Addr)) { amount1ToBorrow = borrowAmountBigInt; }
            else { throw new Error(`Borrowed token address ${borrowTokenAddress} mismatch for borrow pool ${borrowPoolAddress}.`); }

            const flashSwapContract = manager.getFlashSwapContract();
            const flashSwapAddress = await flashSwapContract.getAddress();
            flashSwapInterface = flashSwapContract.interface; // Store interface
            const signerAddress = await manager.getSignerAddress();

            const contractFunctionName = buildResult.contractFunctionName;
            const contractCallArgs = [borrowPoolAddress, amount0ToBorrow, amount1ToBorrow, encodedParams]; // Args for estimate/execute
            const encodedFunctionData = flashSwapInterface.encodeFunctionData(contractFunctionName, contractCallArgs);

            txRequestForGas = { to: flashSwapAddress, data: encodedFunctionData, from: signerAddress, value: 0n }; // Use BigInt 0n
            logger.debug(`${logPrefix} Transaction request prepared for gas estimation: To=${txRequestForGas.to}, From=${txRequestForGas.from}, Data=${txRequestForGas.data.substring(0,10)}...`);

        } catch (prepError) {
            logger.error(`${logPrefix} Error preparing transaction request for gas estimation: ${prepError.message}`, prepError);
            throw new ArbitrageError(`Failed to prepare TX for gas estimate: ${prepError.message}`, 'INTERNAL_ERROR', prepError);
        }


        // --- 7. Estimate Gas ---
        logger.info(`${logPrefix} Estimating gas for the transaction call '${buildResult.contractFunctionName}'...`);
        gasEstimate = await gasEstimator.estimateGasForTx(txRequestForGas); // Returns BigInt
        // Compare gasEstimate (BigInt) with fallbackGasLimit (BigInt stored in estimator)
        if (gasEstimate === gasEstimator.fallbackGasLimit) { // Direct BigInt comparison
             logger.warn(`${logPrefix} ⚠️ Gas estimation resulted in fallback limit (${gasEstimate.toString()}). Transaction might fail or be unprofitable. Proceeding cautiously.`);
        } else {
             logger.info(`${logPrefix} Gas estimate (buffered): ${gasEstimate.toString()}`);
        }


        // --- 8. Net Profit Check ---
        logger.info(`${logPrefix} Performing Net Profit Check using ProfitCalculator...`);
        profitabilityResult = await profitCalculator.calculateNetProfit({
            simulationResult, // Contains BigInt grossProfit
            gasEstimate,      // Pass the final BigInt estimate
            feeData           // Pass the FeeData object
        });

        if (!profitabilityResult || !profitabilityResult.isProfitable) {
            const reason = profitabilityResult?.details
                 ? `Net=${profitabilityResult.details.netProfitFormatted}, BufferedNet=${profitabilityResult.details.bufferedNetProfitFormatted}, Min=${profitabilityResult.details.minProfitFormatted}`
                 : 'Calculation Error or Invalid Result';
            logger.info(`${logPrefix} ❌ Opportunity NOT Profitable after estimated gas (${reason}). Skipping.`);
            return { executed: false, success: false, txHash: null, error: null, reason: 'NOT_PROFITABLE_POST_GAS', simulationResult, profitabilityResult };
        }
        logger.info(`${logPrefix} ✅✅ Opportunity IS Profitable after estimated gas!`);
        logger.info(`${logPrefix} Profit Breakdown: Gross=${profitabilityResult.details.grossProfitWeiFormatted} | Gas=${profitabilityResult.details.gasCostFormatted} | Net=${profitabilityResult.details.netProfitFormatted} | BufferedNet=${profitabilityResult.details.bufferedNetProfitFormatted} (MinRequired: ${profitabilityResult.details.minProfitFormatted})`);


        // --- 9. Execute Transaction ---
        logger.info(`${logPrefix} >>> Attempting Execution... <<<`);
        const dryRun = config.DRY_RUN === 'true' || config.DRY_RUN === true;

        // Prepare arguments for the executor - reuse args from step 6 if possible and safe
        // Ensure args passed to executeTransaction match exactly what the contract expects
        const executorContractCallArgs = [
             opp.pools[0].address, // borrowPoolAddress
             amount0ToBorrow,      // Use amount calculated in step 6
             amount1ToBorrow,      // Use amount calculated in step 6
             encodedParams         // Use encoded params from step 6
        ];

        // Call the refactored executeTransaction
        const executionResult = await executeTransaction(
            buildResult.contractFunctionName, // From step 6
            executorContractCallArgs,         // Args prepared above
            manager,
            gasEstimate,                      // From step 7 (BigInt)
            feeData,                          // From step 1
            logger,                           // Global logger
            dryRun
        );

        // --- 10. Handle Execution Result ---
        if (executionResult.success) {
            logger.info(`${logPrefix} 🎉🎉🎉 SUCCESSFULLY ${dryRun ? 'DRY RUN' : 'EXECUTED'} Transaction: ${executionResult.txHash}`);
            return { executed: true, success: true, txHash: executionResult.txHash, error: null, simulationResult, profitabilityResult };
        } else {
            logger.error(`${logPrefix} Transaction execution failed. Hash: ${executionResult.txHash || 'N/A'}, Reason: ${executionResult.error?.message || 'Unknown Error'}`, { errorObj: executionResult.error });
            const finalError = executionResult.error instanceof Error ? executionResult.error : new ArbitrageError(executionResult.error?.message || 'Execution failed', 'EXECUTION_ERROR');
            return { executed: true, success: false, txHash: executionResult.txHash, error: finalError, simulationResult, profitabilityResult };
        } // END of else block for executionResult handling

    } catch (oppError) { // Catch errors from any step above
        const message = oppError.message || 'Unknown error';
        logger.error(`${logPrefix} Error processing opportunity: ${message}`, {
             errorName: oppError.name,
             errorCode: oppError.code,
             // errorStack: oppError.stack // Uncomment for deep debugging
        });
        if (typeof handleError === 'function') { handleError(oppError, `Opportunity Processor (${opp?.groupName || opp?.type || 'Unknown'})`); }
        const returnError = (oppError instanceof ArbitrageError) ? oppError : new ArbitrageError(`Unhandled error: ${message}`, 'PROCESSOR_ERROR', oppError);
        return { executed: false, success: false, txHash: null, error: returnError, simulationResult, profitabilityResult };
    } // END of main try...catch block
} // END of processOpportunity function

module.exports = { processOpportunity }; // Export the function
