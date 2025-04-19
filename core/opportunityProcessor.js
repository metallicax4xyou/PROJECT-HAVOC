// core/opportunityProcessor.js
const { ethers } = require('ethers');
const { Token } = require('@uniswap/sdk-core'); // Needed for instanceof checks
const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler');
const ProfitCalculator = require('./profitCalculator');
const { executeTransaction } = require('./txExecutor');

// Import the stringify helper
const { stringifyPoolState } = require('./simulationHelpers'); // Import from the new file

/**
 * Processes a single potential arbitrage opportunity.
 * Includes simulation, profitability check, and execution attempt.
 *
 * @param {object} opp The potential opportunity object.
 * @param {object} engineContext Object containing dependencies: { config, manager, gasEstimator, quoteSimulator, logger } // quoteSimulator is now used for single swaps
 * @returns {Promise<{ executed: boolean, success: boolean, txHash: string|null, error: ArbitrageError|Error|null, simulationResult?: object }>} Result of processing, includes simulationResult on success/non-execution.
 */
async function processOpportunity(opp, engineContext) {
    // Destructure context
    const { config, manager, gasEstimator, quoteSimulator, logger: contextLogger } = engineContext;
    const logPrefix = `[OppProcessor Type: ${opp.type}, Group: ${opp.groupName}]`;
    contextLogger.info(`${logPrefix} Processing potential opportunity...`);

    // Basic validation
    if (!config || !manager || !gasEstimator || !quoteSimulator || !contextLogger) {
         const errMsg = `${logPrefix} Missing dependencies in engineContext. Aborting.`;
         contextLogger.error(errMsg);
         return { executed: false, success: false, txHash: null, error: new ArbitrageError(errMsg, 'INTERNAL_ERROR') };
    }
    if (!opp || typeof opp !== 'object') {
        contextLogger.error(`${logPrefix} Invalid opportunity object received.`);
        return { executed: false, success: false, txHash: null, error: new ArbitrageError('Invalid opportunity object', 'INTERNAL_ERROR') };
    }

    // Currently only handle triangular
    if (opp.type !== 'triangular') {
        contextLogger.warn(`${logPrefix} Skipping opportunity type '${opp.type}' - only 'triangular' is implemented.`);
        return { executed: false, success: false, txHash: null, error: null }; // Not an error, just skipping
    }

    let simulationResult = null; // Define outside try block

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
        const initialAmount = groupConfig.borrowAmount; // This should be a bigint

        // --- c. Simulate Arbitrage Hop-by-Hop ---
        contextLogger.info(`${logPrefix} Simulating path: ${opp.pathSymbols.join(' -> ')} with ${ethers.formatUnits(initialAmount, groupConfig.sdkBorrowToken.decimals)} ${borrowTokenSymbol}`);

        // Validate triangular structure
        if (!opp.pools || opp.pools.length !== 3 || opp.pathSymbols.length !== 4) {
            throw new ArbitrageError(`${logPrefix} Invalid triangular opportunity structure (pools=${opp.pools?.length}, pathSymbols=${opp.pathSymbols?.length}).`, 'INTERNAL_ERROR', { opp });
        }

        const [pool1, pool2, pool3] = opp.pools;
        const [symA, symB, symC, symA_final] = opp.pathSymbols;

        if (symA !== symA_final) { throw new ArbitrageError(`${logPrefix} Path symbols do not start and end with the same token (${symA} != ${symA_final}).`, 'INTERNAL_ERROR'); }

        // Basic pool checks (moved from old simulateArbitrage)
        if (!pool1 || !pool2 || !pool3) { throw new ArbitrageError(`${logPrefix} One or more pools in the opportunity are undefined.`, 'INTERNAL_ERROR'); }

        // Resolve SDK Token instances and validate pairs (moved from old simulateArbitrage)
        if (!(pool1.token0 instanceof Token) || !(pool1.token1 instanceof Token) || !(pool2.token0 instanceof Token) || !(pool2.token1 instanceof Token) || !(pool3.token0 instanceof Token) || !(pool3.token1 instanceof Token)) {
            contextLogger.error(`${logPrefix} One or more pools have invalid SDK token objects.`);
            console.error("Pool 1 State:", stringifyPoolState(pool1));
            console.error("Pool 2 State:", stringifyPoolState(pool2));
            console.error("Pool 3 State:", stringifyPoolState(pool3));
            throw new ArbitrageError(`${logPrefix} Invalid token objects in pools`, 'INTERNAL_ERROR');
        }

        const tokenA = pool1.token0?.symbol === symA ? pool1.token0 : (pool1.token1?.symbol === symA ? pool1.token1 : null);
        const tokenB = pool1.token0?.symbol === symB ? pool1.token0 : (pool1.token1?.symbol === symB ? pool1.token1 : null);
        if (!tokenB) { throw new ArbitrageError(`${logPrefix} Could not find token ${symB} in pool 1 (${pool1.address}).`, 'INTERNAL_ERROR'); }
        const tokenC = pool2.token0?.symbol === symC ? pool2.token0 : (pool2.token1?.symbol === symC ? pool2.token1 : null);
        if (!tokenC) { throw new ArbitrageError(`${logPrefix} Could not find token ${symC} in pool 2 (${pool2.address}).`, 'INTERNAL_ERROR'); }
        const tokenA_check = pool3.token0?.symbol === symA ? pool3.token0 : (pool3.token1?.symbol === symA ? pool3.token1 : null);
        if (!tokenA_check) { throw new ArbitrageError(`${logPrefix} Could not find return token ${symA} in pool 3 (${pool3.address}).`, 'INTERNAL_ERROR'); }

        if (!(tokenA instanceof Token) || !(tokenB instanceof Token) || !(tokenC instanceof Token)) {
            throw new ArbitrageError(`${logPrefix} Failed to resolve one or more SDK Token instances. A=${tokenA?.symbol}, B=${tokenB?.symbol}, C=${tokenC?.symbol}`, 'INTERNAL_ERROR');
        }

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

        // --- Hop 1 ---
        contextLogger.debug(`${logPrefix} Simulating Hop 1: ${tokenA.symbol} -> ${tokenB.symbol} in Pool ${pool1.address}`);
        console.log(`${logPrefix} POOL 1 STATE before simulation:`); console.log(stringifyPoolState(pool1));
        const hop1Result = await quoteSimulator.simulateSingleSwapExactIn(pool1, tokenA, tokenB, initialAmount);
        if (!hop1Result || hop1Result.amountOut == null || hop1Result.amountOut <= 0n) {
            const reason = !hop1Result ? 'returned null' : (hop1Result.amountOut == null ? 'null amountOut' : 'zero/negative output');
            throw new ArbitrageError(`${logPrefix} Hop 1 simulation failed (${reason}).`, 'SIMULATION_ERROR', { hop: 1, result: hop1Result });
        }
        const amountB_Received = hop1Result.amountOut;
        contextLogger.info(`[SIM Hop 1 ${tokenA.symbol}->${tokenB.symbol}] Output: ${ethers.formatUnits(amountB_Received, tokenB.decimals)} ${tokenB.symbol}`);

        // --- Hop 2 ---
        contextLogger.debug(`${logPrefix} Simulating Hop 2: ${tokenB.symbol} -> ${tokenC.symbol} in Pool ${pool2.address}`);
        console.log(`${logPrefix} POOL 2 STATE before simulation:`); console.log(stringifyPoolState(pool2));
        const hop2Result = await quoteSimulator.simulateSingleSwapExactIn(pool2, tokenB, tokenC, amountB_Received);
        if (!hop2Result || hop2Result.amountOut == null || hop2Result.amountOut <= 0n) {
             const reason = !hop2Result ? 'returned null' : (hop2Result.amountOut == null ? 'null amountOut' : 'zero/negative output');
            throw new ArbitrageError(`${logPrefix} Hop 2 simulation failed (${reason}).`, 'SIMULATION_ERROR', { hop: 2, result: hop2Result });
        }
        const amountC_Received = hop2Result.amountOut;
        contextLogger.info(`[SIM Hop 2 ${tokenB.symbol}->${tokenC.symbol}] Output: ${ethers.formatUnits(amountC_Received, tokenC.decimals)} ${tokenC.symbol}`);

        // --- Hop 3 ---
        contextLogger.debug(`${logPrefix} Simulating Hop 3: ${tokenC.symbol} -> ${tokenA.symbol} in Pool ${pool3.address}`);
        console.log(`${logPrefix} POOL 3 STATE before simulation:`); console.log(stringifyPoolState(pool3));
        const hop3Result = await quoteSimulator.simulateSingleSwapExactIn(pool3, tokenC, tokenA, amountC_Received);
        if (!hop3Result || hop3Result.amountOut == null || hop3Result.amountOut <= 0n) {
            const reason = !hop3Result ? 'returned null' : (hop3Result.amountOut == null ? 'null amountOut' : 'zero/negative output');
            throw new ArbitrageError(`${logPrefix} Hop 3 simulation failed (${reason}).`, 'SIMULATION_ERROR', { hop: 3, result: hop3Result });
        }
        const finalAmount = hop3Result.amountOut;
        contextLogger.info(`[SIM Hop 3 ${tokenC.symbol}->${tokenA.symbol}] Output: ${ethers.formatUnits(finalAmount, tokenA.decimals)} ${tokenA.symbol}`);

        // --- Calculate Gross Profit and Construct Result ---
        const grossProfit = finalAmount - initialAmount;
        const profitable = grossProfit > 0n;

        // Construct the simulationResult object to match the old format
        simulationResult = {
            profitable, // Gross profitability
            error: null, // No error if we reached here
            initialAmount,
            finalAmount,
            grossProfit,
            details: { hop1Result, hop2Result, hop3Result } // Include details from each hop
        };

        // --- End Simulation ---

        // Check Gross Profit
        if (!simulationResult.profitable) {
            contextLogger.info(`${logPrefix} Simulation shows NO gross profit (${ethers.formatUnits(simulationResult.grossProfit, groupConfig.sdkBorrowToken.decimals)} ${borrowTokenSymbol}). Skipping.`);
            return { executed: false, success: false, txHash: null, error: null, simulationResult }; // Return simulation result even if not profitable
        }
        contextLogger.info(`${logPrefix} ✅ Simulation shows POSITIVE gross profit: ${ethers.formatUnits(simulationResult.grossProfit, groupConfig.sdkBorrowToken.decimals)} ${borrowTokenSymbol}`);

        // --- d. Net Profit Check & Gas Estimation ---
        contextLogger.info(`${logPrefix} Performing Net Profit Check...`);
        const profitabilityResult = await ProfitCalculator.checkProfitability(
            simulationResult,
            gasEstimator,
            groupConfig,
            null // txRequest - still using fallback for now
        );

        if (!profitabilityResult || !profitabilityResult.isProfitable) {
            const netProfitStr = profitabilityResult ? `${ethers.formatUnits(profitabilityResult.netProfitWei, 18)} ${config.NATIVE_SYMBOL}` : 'N/A';
            const gasCostStr = profitabilityResult ? `${ethers.formatUnits(profitabilityResult.estimatedGasCostWei, 18)} ${config.NATIVE_SYMBOL}` : 'N/A';
            contextLogger.info(`${logPrefix} Opportunity NOT Profitable after estimated gas (Net Profit: ${netProfitStr}, Est Gas Cost: ${gasCostStr}). Skipping.`);
            return { executed: false, success: false, txHash: null, error: null, simulationResult }; // Return sim result
        }
        contextLogger.info(`${logPrefix} ✅✅ Opportunity IS Profitable after estimated gas! (Net Profit: ${ethers.formatUnits(profitabilityResult.netProfitWei, 18)} ${config.NATIVE_SYMBOL})`);

        // e. Execute if profitable
        contextLogger.info(`${logPrefix} >>> Attempting Execution... <<<`);
        if (config.DRY_RUN) {
             contextLogger.warn(`${logPrefix} --- DRY RUN ENABLED --- Skipping actual transaction execution.`);
             // In dry run, return as if executed but without txHash
             return { executed: true, success: true, txHash: "0xDRYRUN_NO_EXECUTION", error: null, simulationResult };
        }

        const executionResult = await executeTransaction(
            opp, // Pass the original opportunity object
            simulationResult, // Pass the constructed simulation result
            profitabilityResult, // Pass profitability details (contains gas limits etc)
            manager, // Pass the FlashSwapManager instance
            gasEstimator, // Pass GasEstimator (might be used internally by txExecutor)
            contextLogger // Pass logger
        );

        // Check execution result
        if (executionResult.success) {
            contextLogger.info(`${logPrefix} 🎉🎉🎉 SUCCESSFULLY EXECUTED Transaction: ${executionResult.txHash}`);
            return { executed: true, success: true, txHash: executionResult.txHash, error: null, simulationResult };
        } else {
            // Execution failed, txExecutor should have logged details
            contextLogger.error(`${logPrefix} Transaction execution failed. Hash: ${executionResult.txHash || 'N/A'}, Reason: ${executionResult.error?.message || 'Unknown'}`);
            // Wrap the execution error if available
            const finalError = executionResult.error instanceof Error ? executionResult.error : new ArbitrageError(executionResult.error?.message || 'Execution failed', 'EXECUTION_ERROR');
            return { executed: true, success: false, txHash: executionResult.txHash, error: finalError, simulationResult };
        }

    } catch (oppError) {
        // Catch errors from simulation or profitability check
        contextLogger.error(`${logPrefix} Error processing opportunity: ${oppError.message}`);
        // Log stack trace for ArbitrageErrors if available, otherwise log the error object
        if (oppError instanceof ArbitrageError && oppError.stack) {
             console.error(oppError.stack);
        } else {
            console.error(oppError);
        }
        // Use global handler for consistent logging/reporting
        handleError(oppError, `Opportunity Processor (${opp.groupName || opp.type})`);
        return { executed: false, success: false, txHash: null, error: oppError, simulationResult }; // Include simulation result if available
    }
}

module.exports = { processOpportunity };
