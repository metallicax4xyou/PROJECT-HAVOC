// core/opportunityProcessor.js
// --- VERSION UPDATED FOR PHASE 1 REFACTOR ---
// Integrates new GasEstimator & ProfitCalculator classes and revised txExecutor call

const { ethers } = require('ethers');
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
        // Return error structure consistent with try/catch block
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
    let gasEstimate = null; // Store the final gas estimate
    let buildResult = null; // Store result from ParamBuilder

    try {
        // --- 1. Fetch Fee Data and Check Max Gas Price ---
        logger.debug(`${logPrefix} Fetching current fee data...`);
        feeData = await gasEstimator.getFeeData();
        if (!feeData || !feeData.maxFeePerGas) {
            // Handle potential legacy gasPrice case if necessary, but focus on EIP-1559
            if (!feeData?.gasPrice) {
                 throw new ArbitrageError(`${logPrefix} Failed to fetch valid fee data (maxFeePerGas or gasPrice). Cannot proceed.`, 'NETWORK_ERROR');
            }
            logger.warn(`${logPrefix} Using legacy gasPrice (${ethers.utils.formatUnits(feeData.gasPrice, 'gwei')} Gwei) as maxFeePerGas is unavailable.`);
            // Use gasPrice for the check if maxFee is missing
             if (feeData.gasPrice.gt(config.parsed.maxGasWei)) {
                  logger.warn(`${logPrefix} ⛽ Legacy Gas price too high (${ethers.utils.formatUnits(feeData.gasPrice, 'gwei')} Gwei > Max ${ethers.utils.formatUnits(config.parsed.maxGasWei, 'gwei')} Gwei). Skipping.`);
                  return { executed: false, success: false, txHash: null, error: null, reason: 'GAS_PRICE_TOO_HIGH', simulationResult, profitabilityResult };
             }
        } else {
            // EIP-1559 check
             logger.info(`${logPrefix} Current Gas (Gwei): Max=${ethers.utils.formatUnits(feeData.maxFeePerGas, 'gwei')}, Priority=${feeData.maxPriorityFeePerGas ? ethers.utils.formatUnits(feeData.maxPriorityFeePerGas, 'gwei') : 'N/A'}`);
             if (feeData.maxFeePerGas.gt(config.parsed.maxGasWei)) {
                 logger.warn(`${logPrefix} ⛽ Max Fee Per Gas too high (${ethers.utils.formatUnits(feeData.maxFeePerGas, 'gwei')} Gwei > Max ${ethers.utils.formatUnits(config.parsed.maxGasWei, 'gwei')} Gwei). Skipping.`);
                 return { executed: false, success: false, txHash: null, error: null, reason: 'GAS_PRICE_TOO_HIGH', simulationResult, profitabilityResult };
             }
        }


        // --- 2. Find Group Config & Validate ---
        const groupConfig = config.POOL_GROUPS.find(g => g.name === opp.groupName);
        if (!groupConfig) { throw new ArbitrageError(`${logPrefix} Configuration for group '${opp.groupName}' not found.`, 'CONFIG_ERROR'); }
        if (!groupConfig.sdkBorrowToken || !groupConfig.borrowAmount || !ethers.BigNumber.isBigNumber(groupConfig.borrowAmount) ) { // Check borrowAmount is BigNumber
            throw new ArbitrageError(`${logPrefix} Incomplete/invalid config for group '${opp.groupName}' (missing/invalid sdkBorrowToken or borrowAmount).`, 'CONFIG_ERROR', { groupConfig });
        }


        // --- 3. Prepare for Simulation ---
        const borrowTokenSymbol = groupConfig.borrowTokenSymbol;
        if (!opp.pathSymbols || opp.pathSymbols.length !== 4 || opp.pathSymbols[0] !== borrowTokenSymbol || opp.pathSymbols[3] !== borrowTokenSymbol) {
             throw new ArbitrageError(`${logPrefix} Invalid opportunity path symbols for triangular arbitrage.`, 'CONFIG_ERROR', { path: opp.pathSymbols });
        }
        const initialAmount = groupConfig.borrowAmount; // Already BigNumber from config loader


        // --- 4. Simulate Arbitrage Path ---
        logger.info(`${logPrefix} Simulating path: ${opp.pathSymbols.join(' -> ')} with Input: ${ethers.utils.formatUnits(initialAmount, groupConfig.sdkBorrowToken.decimals)} ${borrowTokenSymbol}`);

        if (!opp.pools || opp.pools.length !== 3) {
            throw new ArbitrageError(`${logPrefix} Invalid number of pools for triangular opportunity (${opp.pools?.length}).`, 'INTERNAL_ERROR', { opp });
        }
        const [pool1, pool2, pool3] = opp.pools;
        if (!pool1 || !pool2 || !pool3) { throw new ArbitrageError(`${logPrefix} One or more pools are undefined.`, 'INTERNAL_ERROR'); }

        // Resolve Tokens (Ensure they are SDK Token instances from the Pool objects)
        const tokenA = groupConfig.sdkBorrowToken; // Use the one from config
        const tokenB = (pool1.token0?.address === tokenA.address) ? pool1.token1 : pool1.token0;
        const tokenC = (pool2.token0?.address === tokenB?.address) ? pool2.token1 : pool2.token0;

        // Basic validation that tokens were resolved and match expected path logic
        if (!(tokenB instanceof Token) || !(tokenC instanceof Token)) {
            throw new ArbitrageError(`${logPrefix} Failed to resolve SDK Token instances for B or C. B=${tokenB?.symbol}, C=${tokenC?.symbol}`, 'INTERNAL_ERROR');
        }
        // Optional: Add more detailed pool pair matching checks if needed

        // Execute simulation hops (Keep existing logic using quoteSimulator)
        logger.debug(`${logPrefix} Simulating Hop 1 (${tokenA.symbol}->${tokenB.symbol}) on Pool ${pool1.address}...`);
        const hop1Result = await quoteSimulator.simulateSingleSwapExactIn(pool1, tokenA, tokenB, initialAmount);
        if (!hop1Result || !ethers.BigNumber.isBigNumber(hop1Result.amountOut) || hop1Result.amountOut.lte(0)) { throw new ArbitrageError(`${logPrefix} Hop 1 simulation failed or returned zero/negative output.`, 'SIMULATION_ERROR', { hop: 1, result: hop1Result }); }
        const amountB_Received = hop1Result.amountOut;
        logger.info(`[SIM Hop 1 ${tokenA.symbol}->${tokenB.symbol}] Output: ${ethers.utils.formatUnits(amountB_Received, tokenB.decimals)} ${tokenB.symbol}`);

        logger.debug(`${logPrefix} Simulating Hop 2 (${tokenB.symbol}->${tokenC.symbol}) on Pool ${pool2.address}...`);
        const hop2Result = await quoteSimulator.simulateSingleSwapExactIn(pool2, tokenB, tokenC, amountB_Received);
        if (!hop2Result || !ethers.BigNumber.isBigNumber(hop2Result.amountOut) || hop2Result.amountOut.lte(0)) { throw new ArbitrageError(`${logPrefix} Hop 2 simulation failed or returned zero/negative output.`, 'SIMULATION_ERROR', { hop: 2, result: hop2Result }); }
        const amountC_Received = hop2Result.amountOut;
        logger.info(`[SIM Hop 2 ${tokenB.symbol}->${tokenC.symbol}] Output: ${ethers.utils.formatUnits(amountC_Received, tokenC.decimals)} ${tokenC.symbol}`);

        logger.debug(`${logPrefix} Simulating Hop 3 (${tokenC.symbol}->${tokenA.symbol}) on Pool ${pool3.address}...`);
        const hop3Result = await quoteSimulator.simulateSingleSwapExactIn(pool3, tokenC, tokenA, amountC_Received);
        if (!hop3Result || !ethers.BigNumber.isBigNumber(hop3Result.amountOut) || hop3Result.amountOut.lte(0)) { throw new ArbitrageError(`${logPrefix} Hop 3 simulation failed or returned zero/negative output.`, 'SIMULATION_ERROR', { hop: 3, result: hop3Result }); }
        const finalAmount = hop3Result.amountOut;
        logger.info(`[SIM Hop 3 ${tokenC.symbol}->${tokenA.symbol}] Output: ${ethers.utils.formatUnits(finalAmount, tokenA.decimals)} ${tokenA.symbol}`);


        // --- 5. Calculate Gross Profit & Check ---
        const grossProfit = finalAmount.sub(initialAmount);
        simulationResult = {
            profitable: grossProfit.gt(0), // Ensure boolean
            error: null, initialAmount, finalAmount, grossProfit, // BigNumbers
            details: { tokenA, tokenB, tokenC, hop1Result, hop2Result, hop3Result } // Include resolved SDK tokens
        };

        if (!simulationResult.profitable) {
            logger.info(`${logPrefix} Simulation shows NO gross profit (${ethers.utils.formatUnits(simulationResult.grossProfit, tokenA.decimals)} ${tokenA.symbol}). Skipping.`);
            // Return non-executed state, include simulation result for context
            return { executed: false, success: false, txHash: null, error: null, reason: 'NO_GROSS_PROFIT', simulationResult, profitabilityResult };
        }
        logger.info(`${logPrefix} ✅ Simulation shows POSITIVE gross profit: ${ethers.utils.formatUnits(simulationResult.grossProfit, tokenA.decimals)} ${tokenA.symbol}`);


        // --- 6. Prepare Transaction Request for Gas Estimation ---
        try {
            logger.debug(`${logPrefix} Preparing transaction request using ParamBuilder...`);
            // Build Params - ensure ParamBuilder returns necessary structure
            buildResult = TxUtils.ParamBuilder.buildTriangularParams(opp, simulationResult, config);
            if (!buildResult || !buildResult.params || !buildResult.typeString || !buildResult.contractFunctionName || !buildResult.borrowTokenAddress || !buildResult.borrowAmount) {
                 throw new Error("ParamBuilder did not return expected structure.");
            }

            // Encode Params
            const encodedParams = TxUtils.Encoder.encodeParams(buildResult.params, buildResult.typeString);

            // Determine amount0/amount1 for flash swap call (based on pool1 tokens)
            const borrowPoolAddress = opp.pools[0].address; // Pool 1 is borrow pool
            const borrowTokenAddress = buildResult.borrowTokenAddress; // Should match tokenA.address
            const borrowAmount = buildResult.borrowAmount; // Should match initialAmount

            const pool1Token0Addr = opp.pools[0].token0?.address;
            const pool1Token1Addr = opp.pools[0].token1?.address;
            if (!pool1Token0Addr || !pool1Token1Addr) {
                 throw new Error(`Pool 1 (${borrowPoolAddress}) token addresses missing on opportunity object.`);
            }

            let amount0ToBorrow = ethers.BigNumber.from(0);
            let amount1ToBorrow = ethers.BigNumber.from(0);
            if (ethers.utils.getAddress(borrowTokenAddress) === ethers.utils.getAddress(pool1Token0Addr)) { amount0ToBorrow = borrowAmount; }
            else if (ethers.utils.getAddress(borrowTokenAddress) === ethers.utils.getAddress(pool1Token1Addr)) { amount1ToBorrow = borrowAmount; }
            else { throw new Error(`Borrowed token address ${borrowTokenAddress} mismatch for borrow pool ${borrowPoolAddress}. Expected ${pool1Token0Addr} or ${pool1Token1Addr}.`); }

            // Get Contract Details from Manager
            const flashSwapContract = manager.getFlashSwapContract();
            const flashSwapAddress = await flashSwapContract.getAddress();
            const flashSwapInterface = flashSwapContract.interface;
            const signerAddress = await manager.getSignerAddress(); // Get signer address

            // Assemble Arguments for contract call
            const contractFunctionName = buildResult.contractFunctionName; // e.g., 'initiateTriangularFlashSwap'
            const contractCallArgs = [borrowPoolAddress, amount0ToBorrow, amount1ToBorrow, encodedParams];

            // Encode Function Data
            const encodedFunctionData = flashSwapInterface.encodeFunctionData(contractFunctionName, contractCallArgs);

            // Create Transaction Request Object for gas estimation
            txRequestForGas = {
                to: flashSwapAddress,
                data: encodedFunctionData,
                from: signerAddress, // Include sender address
                value: 0 // Typically 0 for these calls
            };
            logger.debug(`${logPrefix} Transaction request prepared for gas estimation: To=${txRequestForGas.to}, From=${txRequestForGas.from}, Data=${txRequestForGas.data.substring(0,10)}...`);

        } catch (prepError) {
            logger.error(`${logPrefix} Error preparing transaction request for gas estimation: ${prepError.message}`, prepError);
            throw new ArbitrageError(`Failed to prepare TX for gas estimate: ${prepError.message}`, 'INTERNAL_ERROR', prepError);
        }


        // --- 7. Estimate Gas ---
        logger.info(`${logPrefix} Estimating gas for the transaction call '${buildResult.contractFunctionName}'...`);
        gasEstimate = await gasEstimator.estimateGasForTx(txRequestForGas); // Call the new estimator method
        // Check if gas estimate is the fallback value, which might indicate an issue
        if (gasEstimate.eq(gasEstimator.fallbackGasLimit)) { // Compare against the instance's fallback limit
             logger.warn(`${logPrefix} ⚠️ Gas estimation resulted in fallback limit (${gasEstimate.toString()}). Transaction might fail or be unprofitable. Proceeding with caution.`);
        } else {
             logger.info(`${logPrefix} Gas estimate (buffered): ${gasEstimate.toString()}`);
        }


        // --- 8. Net Profit Check ---
        logger.info(`${logPrefix} Performing Net Profit Check using ProfitCalculator...`);
        profitabilityResult = await profitCalculator.calculateNetProfit({
            simulationResult,
            gasEstimate, // Pass the final buffered estimate
            feeData      // Pass the feeData fetched earlier
            // minProfitWei is handled inside the profitCalculator instance
        });

        // Check the result from the calculator
        if (!profitabilityResult || !profitabilityResult.isProfitable) {
             const reason = profitabilityResult?.details
                 ? `Net=${profitabilityResult.details.netProfitFormatted}, BufferedNet=${profitabilityResult.details.bufferedNetProfitFormatted}, Min=${profitabilityResult.details.minProfitFormatted}`
                 : 'Calculation Error or Invalid Result';
            logger.info(`${logPrefix} ❌ Opportunity NOT Profitable after estimated gas (${reason}). Skipping.`);
            // Return non-executed state, include both simulation and profitability results
            return { executed: false, success: false, txHash: null, error: null, reason: 'NOT_PROFITABLE_POST_GAS', simulationResult, profitabilityResult };
        }
        // Log detailed breakdown on success
        logger.info(`${logPrefix} ✅✅ Opportunity IS Profitable after estimated gas!`);
        logger.info(`${logPrefix} Profit Breakdown: Gross=${profitabilityResult.details.grossProfitWeiFormatted} | Gas=${profitabilityResult.details.gasCostFormatted} | Net=${profitabilityResult.details.netProfitFormatted} | BufferedNet=${profitabilityResult.details.bufferedNetProfitFormatted} (MinRequired: ${profitabilityResult.details.minProfitFormatted})`);


        // --- 9. Execute Transaction ---
        logger.info(`${logPrefix} >>> Attempting Execution... <<<`);
        const dryRun = config.DRY_RUN === 'true' || config.DRY_RUN === true; // Handle string 'true'

        // Prepare arguments for the executor
        const executorArgs = {
             contractFunctionName: buildResult.contractFunctionName,
             contractCallArgs: [ // Re-assemble args based on buildResult and derived values
                 opp.pools[0].address, // borrowPoolAddress
                 txRequestForGas.data.startsWith(flashSwapInterface.getSighash(buildResult.contractFunctionName)) ? // Basic check if data matches function
                     ethers.BigNumber.from(ethers.utils.hexlify(ethers.utils.stripZeros(flashSwapInterface.decodeFunctionData(buildResult.contractFunctionName, txRequestForGas.data)[1]))) : ethers.BigNumber.from(0), // amount0ToBorrow (re-decode carefully or pass from step 6)
                 ethers.BigNumber.from(ethers.utils.hexlify(ethers.utils.stripZeros(flashSwapInterface.decodeFunctionData(buildResult.contractFunctionName, txRequestForGas.data)[2]))), // amount1ToBorrow
                 TxUtils.Encoder.encodeParams(buildResult.params, buildResult.typeString) // encodedParams
             ],
             manager,
             gasEstimate,
             feeData,
             logger, // Pass the global logger
             dryRun
        };

        // Call the refactored executeTransaction
        const executionResult = await executeTransaction(
            executorArgs.contractFunctionName,
            executorArgs.contractCallArgs,
            executorArgs.manager,
            executorArgs.gasEstimate,
            executorArgs.feeData,
            executorArgs.logger,
            executorArgs.dryRun
        );

        // --- 10. Handle Execution Result ---
        if (executionResult.success) {
            logger.info(`${logPrefix} 🎉🎉🎉 SUCCESSFULLY ${dryRun ? 'DRY RUN' : 'EXECUTED'} Transaction: ${executionResult.txHash}`);
            // Include profitability details in the successful return
            return { executed: true, success: true, txHash: executionResult.txHash, error: null, simulationResult, profitabilityResult };
        } else {
            logger.error(`${logPrefix} Transaction execution failed. Hash: ${executionResult.txHash || 'N/A'}, Reason: ${executionResult.error?.message || 'Unknown Error'}`, { errorObj: executionR
