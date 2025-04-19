// core/opportunityProcessor.js
// *** VERSION WITH ACCURATE GAS ESTIMATION FOR NET PROFIT CHECK ***

const { ethers } = require('ethers'); // Make sure ethers is imported
const { Token } = require('@uniswap/sdk-core');
const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler');
const ProfitCalculator = require('./profitCalculator');
const { executeTransaction } = require('./txExecutor'); // Assuming this exists and is correctly imported
const { stringifyPoolState } = require('./simulationHelpers');
const TxUtils = require('./tx'); // Import paramBuilder, encoder etc. (adjust path if needed)
// const { ABIS } = require('../constants/abis'); // Might be needed if fetching pool tokens

async function processOpportunity(opp, engineContext) {
    const { config, manager, gasEstimator, quoteSimulator, logger: contextLogger } = engineContext;
    const logPrefix = `[OppProcessor Type: ${opp.type}, Group: ${opp.groupName}]`;
    contextLogger.info(`${logPrefix} Processing potential opportunity...`);

    // Validations
    if (!config || !manager || !gasEstimator || !quoteSimulator || !contextLogger) {
        const errMsg = `${logPrefix} Missing dependencies in engineContext. Aborting.`;
        contextLogger.error(errMsg);
        return { executed: false, success: false, txHash: null, error: new ArbitrageError(errMsg, 'INTERNAL_ERROR') };
    }
    if (!opp || typeof opp !== 'object') {
        contextLogger.error(`${logPrefix} Invalid opportunity object received.`);
        return { executed: false, success: false, txHash: null, error: new ArbitrageError('Invalid opportunity object', 'INTERNAL_ERROR') };
    }
    if (opp.type !== 'triangular') {
        contextLogger.warn(`${logPrefix} Skipping opportunity type '${opp.type}' - only 'triangular' is implemented.`);
        return { executed: false, success: false, txHash: null, error: null };
    }

    let simulationResult = null;

    try {
        // a. Find Group Config
        const groupConfig = config.POOL_GROUPS.find(g => g.name === opp.groupName);
        if (!groupConfig) { throw new ArbitrageError(`${logPrefix} Configuration for group '${opp.groupName}' not found.`, 'CONFIG_ERROR'); }
        if (!groupConfig.sdkBorrowToken || groupConfig.borrowAmount == null || typeof groupConfig.minNetProfit === 'undefined') {
            throw new ArbitrageError(`${logPrefix} Incomplete configuration for group '${opp.groupName}' (missing sdkBorrowToken, borrowAmount, or minNetProfit).`, 'CONFIG_ERROR');
        }

        // b. Verify Borrow Token and Set Initial Amount
        const borrowTokenSymbol = groupConfig.borrowTokenSymbol;
        if (!opp.pathSymbols || opp.pathSymbols.length < 1 || opp.pathSymbols[0] !== borrowTokenSymbol) {
            throw new ArbitrageError(`${logPrefix} Opportunity path does not start with the configured borrow token '${borrowTokenSymbol}'. Path: ${opp.pathSymbols?.join('->')}`, 'CONFIG_ERROR');
        }
        const initialAmount = groupConfig.borrowAmount;

        // --- c. Simulate Arbitrage Hop-by-Hop ---
        contextLogger.info(`${logPrefix} Simulating path: ${opp.pathSymbols.join(' -> ')} with ${ethers.formatUnits(initialAmount, groupConfig.sdkBorrowToken.decimals)} ${borrowTokenSymbol}`);
        if (!opp.pools || opp.pools.length !== 3 || !opp.pathSymbols || opp.pathSymbols.length !== 4) {
            throw new ArbitrageError(`${logPrefix} Invalid triangular opportunity structure (pools=${opp.pools?.length}, pathSymbols=${opp.pathSymbols?.length}).`, 'INTERNAL_ERROR', { opp });
        }
        const [pool1, pool2, pool3] = opp.pools;
        const [symA, symB, symC, symA_final] = opp.pathSymbols;
        if (symA !== symA_final) { throw new ArbitrageError(`${logPrefix} Path symbols do not start and end with the same token (${symA} != ${symA_final}).`, 'INTERNAL_ERROR'); }
        if (!pool1 || !pool2 || !pool3) { throw new ArbitrageError(`${logPrefix} One or more pools in the opportunity are undefined.`, 'INTERNAL_ERROR'); }
        if (!(pool1.token0 instanceof Token) || !(pool1.token1 instanceof Token) || !(pool2.token0 instanceof Token) || !(pool2.token1 instanceof Token) || !(pool3.token0 instanceof Token) || !(pool3.token1 instanceof Token)) {
             contextLogger.error(`${logPrefix} One or more pools have invalid SDK token objects.`);
             console.error("Pool 1 State:", stringifyPoolState(pool1)); console.error("Pool 2 State:", stringifyPoolState(pool2)); console.error("Pool 3 State:", stringifyPoolState(pool3));
             throw new ArbitrageError(`${logPrefix} Invalid token objects in pools`, 'INTERNAL_ERROR');
        }

        // Resolve Tokens (Ensuring they are SDK Token instances)
        const tokenA = pool1.token0?.symbol === symA ? pool1.token0 : (pool1.token1?.symbol === symA ? pool1.token1 : null);
        const tokenB = pool1.token0?.symbol === symB ? pool1.token0 : (pool1.token1?.symbol === symB ? pool1.token1 : null);
        if (!tokenB) { throw new ArbitrageError(`${logPrefix} Could not find token ${symB} in pool 1 (${pool1.address}).`, 'INTERNAL_ERROR'); }
        const tokenC = pool2.token0?.symbol === symC ? pool2.token0 : (pool2.token1?.symbol === symC ? pool2.token1 : null);
        if (!tokenC) { throw new ArbitrageError(`${logPrefix} Could not find token ${symC} in pool 2 (${pool2.address}).`, 'INTERNAL_ERROR'); }
        const tokenA_check = pool3.token0?.symbol === symA ? pool3.token0 : (pool3.token1?.symbol === symA ? pool3.token1 : null);
        if (!tokenA_check) { throw new ArbitrageError(`${logPrefix} Could not find return token ${symA} in pool 3 (${pool3.address}).`, 'INTERNAL_ERROR'); }
        if (!(tokenA instanceof Token) || !(tokenB instanceof Token) || !(tokenC instanceof Token)) { throw new ArbitrageError(`${logPrefix} Failed to resolve one or more SDK Token instances. A=${tokenA?.symbol}, B=${tokenB?.symbol}, C=${tokenC?.symbol}`, 'INTERNAL_ERROR'); }

        // Validate pool token pairs
        const pool1Matches = (pool1.token0.address === tokenA.address && pool1.token1.address === tokenB.address) || (pool1.token0.address === tokenB.address && pool1.token1.address === tokenA.address);
        const pool2Matches = (pool2.token0.address === tokenB.address && pool2.token1.address === tokenC.address) || (pool2.token0.address === tokenC.address && pool2.token1.address === tokenB.address);
        const pool3Matches = (pool3.token0.address === tokenC.address && pool3.token1.address === tokenA.address) || (pool3.token0.address === tokenA.address && pool3.token1.address === tokenC.address);
        if (!pool1Matches || !pool2Matches || !pool3Matches) {
             contextLogger.error(`${logPrefix} Pool token pairs do not match the expected path.`);
             console.error(`Pool 1 (${pool1.address}) Pair: ${pool1.token0.symbol}/${pool1.token1.symbol} vs Expected: ${tokenA.symbol}/${tokenB.symbol}`);
             console.error(`Pool 2 (${pool2.address}) Pair: ${pool2.token0.symbol}/${pool2.token1.symbol} vs Expected: ${tokenB.symbol}/${tokenC.symbol}`);
             console.error(`Pool 3 (${pool3.address}) Pair: ${pool3.token0.symbol}/${pool3.token1.symbol} vs Expected: ${tokenC.symbol}/${tokenA.symbol}`);
            throw new ArbitrageError(`${logPrefix} Pool token pair mismatch`, 'INTERNAL_ERROR');
        }

        // Hops 1, 2, 3
        contextLogger.debug(`${logPrefix} Simulating Hop 1...`);
        console.log(`${logPrefix} POOL 1 STATE before simulation:`); console.log(stringifyPoolState(pool1));
        const hop1Result = await quoteSimulator.simulateSingleSwapExactIn(pool1, tokenA, tokenB, initialAmount);
        if (!hop1Result || hop1Result.amountOut == null || hop1Result.amountOut <= 0n) { throw new ArbitrageError(`${logPrefix} Hop 1 simulation failed.`, 'SIMULATION_ERROR', { hop: 1, result: hop1Result }); }
        const amountB_Received = hop1Result.amountOut;
        contextLogger.info(`[SIM Hop 1 ${tokenA.symbol}->${tokenB.symbol}] Output: ${ethers.formatUnits(amountB_Received, tokenB.decimals)} ${tokenB.symbol}`);

        contextLogger.debug(`${logPrefix} Simulating Hop 2...`);
        console.log(`${logPrefix} POOL 2 STATE before simulation:`); console.log(stringifyPoolState(pool2));
        const hop2Result = await quoteSimulator.simulateSingleSwapExactIn(pool2, tokenB, tokenC, amountB_Received);
        if (!hop2Result || hop2Result.amountOut == null || hop2Result.amountOut <= 0n) { throw new ArbitrageError(`${logPrefix} Hop 2 simulation failed.`, 'SIMULATION_ERROR', { hop: 2, result: hop2Result }); }
        const amountC_Received = hop2Result.amountOut;
        contextLogger.info(`[SIM Hop 2 ${tokenB.symbol}->${tokenC.symbol}] Output: ${ethers.formatUnits(amountC_Received, tokenC.decimals)} ${tokenC.symbol}`);

        contextLogger.debug(`${logPrefix} Simulating Hop 3...`);
        console.log(`${logPrefix} POOL 3 STATE before simulation:`); console.log(stringifyPoolState(pool3));
        const hop3Result = await quoteSimulator.simulateSingleSwapExactIn(pool3, tokenC, tokenA, amountC_Received);
        if (!hop3Result || hop3Result.amountOut == null || hop3Result.amountOut <= 0n) { throw new ArbitrageError(`${logPrefix} Hop 3 simulation failed.`, 'SIMULATION_ERROR', { hop: 3, result: hop3Result }); }
        const finalAmount = hop3Result.amountOut;
        contextLogger.info(`[SIM Hop 3 ${tokenC.symbol}->${tokenA.symbol}] Output: ${ethers.formatUnits(finalAmount, tokenA.decimals)} ${tokenA.symbol}`);

        // --- Calculate Gross Profit and Construct Result ---
        const grossProfit = finalAmount - initialAmount;
        const profitable = grossProfit > 0n;
        simulationResult = {
            profitable, error: null, initialAmount, finalAmount, grossProfit,
            // Pass tokenA as SDK Token instance for ProfitCalculator
            details: { tokenA: tokenA, hop1Result, hop2Result, hop3Result }
        };
        // --- End Simulation Result Construction ---

        // Check Gross Profit First
        if (!simulationResult.profitable) {
            contextLogger.info(`${logPrefix} Simulation shows NO gross profit (${ethers.formatUnits(simulationResult.grossProfit, groupConfig.sdkBorrowToken.decimals)} ${borrowTokenSymbol}). Skipping.`);
            return { executed: false, success: false, txHash: null, error: null, simulationResult };
        }
        contextLogger.info(`${logPrefix} ✅ Simulation shows POSITIVE gross profit: ${ethers.formatUnits(simulationResult.grossProfit, groupConfig.sdkBorrowToken.decimals)} ${borrowTokenSymbol}`);

        // --- START: Prepare Transaction Request for Accurate Gas Estimation ---
        let txRequestForGas = null;
        try {
            contextLogger.debug(`${logPrefix} Preparing transaction request for gas estimation...`);

            // 1. Build Params using ParamBuilder
            // Assuming ParamBuilder uses simulationResult.initialAmount for borrowAmount if needed
            const buildResult = TxUtils.ParamBuilder.buildTriangularParams(opp, simulationResult, config);

            // 2. Encode Params using Encoder
            const encodedParams = TxUtils.Encoder.encodeParams(buildResult.params, buildResult.typeString);

            // 3. Determine Borrow Pool and Amounts
            const borrowPoolAddress = opp.pools[0].address; // Pool 1 is the borrow pool
            const borrowTokenAddress = buildResult.borrowTokenAddress; // Token A address
            const borrowAmount = buildResult.borrowAmount; // Amount of Token A to borrow

            // Get borrow pool token addresses (assuming they are on the pool object from scanner)
            const pool1Token0Addr = opp.pools[0].token0?.address;
            const pool1Token1Addr = opp.pools[0].token1?.address;

            if (!pool1Token0Addr || !pool1Token1Addr) {
                 // Fallback: Log warning if addresses aren't readily available.
                 // checkProfitability will use fallback gas limit if txRequestForGas remains null.
                 contextLogger.warn(`${logPrefix} Pool 1 token addresses not found on opp object, cannot determine amount0/1 accurately for gas estimate. Falling back to default limit estimate.`);
                 txRequestForGas = null;
            } else {
                 let amount0ToBorrow = 0n;
                 let amount1ToBorrow = 0n;

                 // Compare addresses correctly (case-insensitive)
                 if (ethers.getAddress(borrowTokenAddress) === ethers.getAddress(pool1Token0Addr)) {
                     amount0ToBorrow = borrowAmount;
                 } else if (ethers.getAddress(borrowTokenAddress) === ethers.getAddress(pool1Token1Addr)) {
                     amount1ToBorrow = borrowAmount;
                 } else {
                     // This should ideally not happen if data is consistent, but good to check
                     throw new ArbitrageError(`Borrowed token address ${borrowTokenAddress} mismatch for borrow pool ${borrowPoolAddress}. Expected ${pool1Token0Addr} or ${pool1Token1Addr}. Cannot estimate gas accurately.`, 'INTERNAL_ERROR');
                 }

                 // 4. Get Contract Details from Manager
                 const flashSwapContract = manager.getFlashSwapContract(); // Get contract instance
                 const flashSwapAddress = flashSwapContract.target;        // Get contract address
                 const flashSwapInterface = flashSwapContract.interface;   // Get contract interface

                 // 5. Assemble Arguments and Encode Function Data
                 const contractFunctionName = buildResult.contractFunctionName; // e.g., 'initiateTriangularFlashSwap'
                 const contractCallArgs = [
                     borrowPoolAddress,
                     amount0ToBorrow,
                     amount1ToBorrow,
                     encodedParams
                 ];
                 const encodedFunctionData = flashSwapInterface.encodeFunctionData(contractFunctionName, contractCallArgs);

                 // 6. Create the Transaction Request Object
                 txRequestForGas = {
                     to: flashSwapAddress,
                     data: encodedFunctionData,
                     // from: manager.getSigner().address // Usually not needed for estimateGas
                     // value: 0 // Explicitly zero value if needed
                 };
                 contextLogger.debug(`${logPrefix} Transaction request prepared for gas estimation.`);
            }

        } catch (prepError) {
            contextLogger.error(`${logPrefix} Error preparing transaction request for gas estimation: ${prepError.message}`, prepError);
            txRequestForGas = null; // Ensure it's null on error, forcing fallback gas estimate
            handleError(prepError, `${logPrefix} Gas Prep`);
        }
        // --- END: Prepare Transaction Request ---


        // --- d. Net Profit Check & Gas Estimation ---
        contextLogger.info(`${logPrefix} Performing Net Profit Check...`);
        const profitabilityResult = await ProfitCalculator.checkProfitability(
            simulationResult,
            gasEstimator,     // Pass the GasEstimator instance
            groupConfig,
            txRequestForGas   // Pass the prepared request (or null if prep failed)
        );

        if (!profitabilityResult || !profitabilityResult.isProfitable) {
            const netProfitStr = profitabilityResult ? `${ethers.formatUnits(profitabilityResult.netProfitWei, config.NATIVE_DECIMALS || 18)} ${config.NATIVE_SYMBOL || 'ETH'}` : 'N/A';
            const gasCostStr = profitabilityResult ? `${ethers.formatUnits(profitabilityResult.estimatedGasCostWei, config.NATIVE_DECIMALS || 18)} ${config.NATIVE_SYMBOL || 'ETH'}` : 'N/A';
            contextLogger.info(`${logPrefix} Opportunity NOT Profitable after estimated gas (Net Profit: ${netProfitStr}, Est Gas Cost: ${gasCostStr}). Skipping.`);
            return { executed: false, success: false, txHash: null, error: null, simulationResult, profitabilityResult }; // Return profitabilityResult for potential logging higher up
        }
        contextLogger.info(`${logPrefix} ✅✅ Opportunity IS Profitable after estimated gas! (Net Profit: ${ethers.formatUnits(profitabilityResult.netProfitWei, config.NATIVE_DECIMALS || 18)} ${config.NATIVE_SYMBOL || 'ETH'})`);


        // e. Execute if profitable
        contextLogger.info(`${logPrefix} >>> Attempting Execution... <<<`);
        // Check DRY_RUN using config directly
        if (config.DRY_RUN) {
             contextLogger.warn(`${logPrefix} --- DRY RUN ENABLED --- Skipping actual transaction execution.`);
             // In dry run, we still return success=true to indicate the *potential* execution path was valid
             return { executed: true, success: true, txHash: "0xDRYRUN_PROFITABLE_SKIPPED_SEND", error: null, simulationResult, profitabilityResult };
        }

        // Execute Transaction (Pass contextLogger if needed by txExecutor)
        const executionResult = await executeTransaction(
            opp,
            simulationResult,
            // NOTE: profitabilityResult is REMOVED from the arguments here
            manager,
            gasEstimator // Pass gasEstimator as txExecutor needs it for final fees/nonce
            // Pass contextLogger if executeTransaction needs it, e.g.: , contextLogger
        );

        // Check execution result
        if (executionResult.success) {
            contextLogger.info(`${logPrefix} 🎉🎉🎉 SUCCESSFULLY EXECUTED Transaction: ${executionResult.txHash}`);
            return { executed: true, success: true, txHash: executionResult.txHash, error: null, simulationResult, profitabilityResult };
        } else {
            contextLogger.error(`${logPrefix} Transaction execution failed. Hash: ${executionResult.txHash || 'N/A'}, Reason: ${executionResult.error?.message || 'Unknown'}`);
            const finalError = executionResult.error instanceof Error ? executionResult.error : new ArbitrageError(executionResult.error?.message || 'Execution failed', 'EXECUTION_ERROR');
            // Include simulation/profitability details in the failure return
            return { executed: true, success: false, txHash: executionResult.txHash, error: finalError, simulationResult, profitabilityResult };
        }

    } catch (oppError) {
        // Catch errors from simulation, prep, or checks before execution attempt
        contextLogger.error(`${logPrefix} Error processing opportunity: ${oppError.message}`);
        if (oppError instanceof ArbitrageError && oppError.stack) { console.error(oppError.stack); }
        else { console.error(oppError); }
        handleError(oppError, `Opportunity Processor (${opp.groupName || opp.type})`);
        // Include simulation details if available, even on error
        return { executed: false, success: false, txHash: null, error: oppError, simulationResult };
    }
}

module.exports = { processOpportunity };
