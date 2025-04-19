// core/opportunityProcessor.js
const { ethers } = require('ethers');
const logger = require('../utils/logger'); // Assuming logger is accessible via require
const { ArbitrageError, handleError } = require('../utils/errorHandler');
const QuoteSimulator = require('./quoteSimulator'); // Static methods used
const ProfitCalculator = require('./profitCalculator'); // Static methods used
const { executeTransaction } = require('./txExecutor'); // Imported function

// Helper for safe stringify (copied from engine)
function safeStringify(obj, indent = null) {
    try { return JSON.stringify(obj, (_, value) => typeof value === 'bigint' ? value.toString() : value, indent); }
    catch (e) { return "[Unstringifiable Object]"; }
}

/**
 * Processes a single potential arbitrage opportunity.
 * Includes simulation, profitability check, and execution attempt.
 *
 * @param {object} opp The potential opportunity object.
 * @param {object} engineContext Object containing dependencies: { config, manager, gasEstimator, logger }
 * @returns {Promise<{ executed: boolean, success: boolean, txHash: string|null, error: ArbitrageError|Error|null }>} Result of processing.
 *          - executed: true if an attempt was made to send a tx (live or dry run success).
 *          - success: true if the execution (live or dry run) was successful.
 *          - txHash: The transaction hash if successful, or 'DRY_RUN_SUCCESS'.
 *          - error: Any error encountered during processing.
 */
async function processOpportunity(opp, engineContext) {
    const { config, manager, gasEstimator, logger: contextLogger } = engineContext; // Destructure context for easier access
    const logPrefix = `[OppProcessor Type: ${opp.type}, Group: ${opp.groupName}]`; // Use a distinct prefix
    contextLogger.info(`${logPrefix} Processing potential opportunity...`);
    contextLogger.debug(`${logPrefix} Details: ${safeStringify(opp)}`);

    // Basic validation of context
    if (!config || !manager || !gasEstimator || !contextLogger) {
         const errMsg = `${logPrefix} Missing dependencies in engineContext. Aborting.`;
         contextLogger.error(errMsg);
         return { executed: false, success: false, txHash: null, error: new ArbitrageError(errMsg, 'INTERNAL_ERROR', { contextKeys: Object.keys(engineContext) }) };
    }
    // Check opportunity type early
    if (opp.type !== 'triangular') {
        contextLogger.warn(`${logPrefix} Skipping opportunity type '${opp.type}' (only 'triangular' supported).`);
        return { executed: false, success: false, txHash: null, error: null }; // Not an error, just skipped
    }

    try {
        // a. Find Group Config
        const groupConfig = config.POOL_GROUPS.find(g => g.name === opp.groupName);
        if (!groupConfig) {
            throw new ArbitrageError(`${logPrefix} Could not find group config.`, 'CONFIG_ERROR');
        }
        if (!groupConfig.sdkBorrowToken || groupConfig.borrowAmount == null || typeof groupConfig.minNetProfit === 'undefined') {
            throw new ArbitrageError(`${logPrefix} Incomplete group config (missing borrow token/amount/minProfit).`, 'CONFIG_ERROR', { groupConfig });
        }

        // b. Verify Borrow Token Matches Path Start
        const borrowTokenSymbol = groupConfig.borrowTokenSymbol;
        if (opp.pathSymbols[0] !== borrowTokenSymbol) {
            throw new ArbitrageError(`${logPrefix} Path start token (${opp.pathSymbols[0]}) != group borrow token (${borrowTokenSymbol}).`, 'CONFIG_ERROR');
        }
        const initialAmount = groupConfig.borrowAmount;

        // c. Simulate
        contextLogger.info(`${logPrefix} Simulating path: ${opp.pathSymbols.join(' -> ')} with ${ethers.formatUnits(initialAmount, groupConfig.sdkBorrowToken.decimals)} ${borrowTokenSymbol}`);
        const simulationResult = await QuoteSimulator.simulateArbitrage(opp, initialAmount);

        if (!simulationResult) {
            contextLogger.warn(`${logPrefix} Simulation returned null.`);
            return { executed: false, success: false, txHash: null, error: null }; // Treat as non-fatal skip
        }
        if (simulationResult.error) {
             // Wrap simulation error for clarity
            throw new ArbitrageError(`${logPrefix} Simulation failed: ${simulationResult.error}`, 'SIMULATION_ERROR', { originalError: simulationResult.error });
        }
        if (!simulationResult.profitable) { // Checks gross profit > 0
            contextLogger.info(`${logPrefix} Simulation shows NO gross profit (${ethers.formatUnits(simulationResult.grossProfit || 0n, groupConfig.sdkBorrowToken.decimals)} ${borrowTokenSymbol}). Skipping.`);
            return { executed: false, success: false, txHash: null, error: null }; // Not profitable, not an error
        }
        contextLogger.info(`${logPrefix} ✅ Simulation shows POSITIVE gross profit: ${ethers.formatUnits(simulationResult.grossProfit, groupConfig.sdkBorrowToken.decimals)} ${borrowTokenSymbol}`);

        // --- d. Net Profit Check & Gas Estimation ---
        contextLogger.info(`${logPrefix} Performing Net Profit Check...`);
        const profitabilityResult = await ProfitCalculator.checkProfitability(
            simulationResult,
            gasEstimator, // Pass the estimator instance from context
            groupConfig,
            null // txRequest - using fallback gas limit estimate for now
        );

        // Check the result from the Profit Calculator
        if (!profitabilityResult || !profitabilityResult.isProfitable) {
            contextLogger.info(`${logPrefix} ❌ Not profitable after estimated gas cost. Skipping execution.`);
            if (profitabilityResult) {
                 contextLogger.debug(`${logPrefix} Profit Check Details: NetProfitWei=${profitabilityResult.netProfitWei}, EstGasCostWei=${profitabilityResult.estimatedGasCostWei}, GrossProfitWei=${profitabilityResult.grossProfitWei}`);
            }
            return { executed: false, success: false, txHash: null, error: null }; // Not profitable, not an error
        }
        contextLogger.info(`${logPrefix} ✅✅ Opportunity IS Profitable after estimated gas! (Net Profit: ${ethers.formatUnits(profitabilityResult.netProfitWei, 18)} ${config.NATIVE_SYMBOL})`);


        // e. Execute if profitable
        contextLogger.info(`${logPrefix} >>> Attempting Execution... <<<`);
        const executionResult = await executeTransaction(
            opp,
            simulationResult,
            manager,      // Pass the manager instance from context
            gasEstimator  // Pass the estimator instance from context
        );

        if (executionResult.success) {
            contextLogger.info(`${logPrefix} ✅✅✅ EXECUTION SUCCEEDED! TxHash: ${executionResult.txHash}`);
            // Return success state
             return { executed: true, success: true, txHash: executionResult.txHash, error: null };
        } else {
            // Execution failed, wrap error if needed and return failure state
             const executionError = executionResult.error || new ArbitrageError('Unknown execution error', 'EXECUTION_ERROR');
             contextLogger.error(`${logPrefix} ❌ Execution FAILED: ${executionError.message}`);
             if (executionError instanceof ArbitrageError && executionError.details) {
                 contextLogger.error(`${logPrefix} Execution Details: ${safeStringify(executionError.details)}`);
             }
             // Return failure state but indicate execution was attempted
             return { executed: true, success: false, txHash: null, error: executionError };
        }

    } catch (oppError) {
        // Catch errors from steps a-d or wrapped errors from simulation/profit check
        contextLogger.error(`${logPrefix} Error processing opportunity: ${oppError.message}`);
        handleError(oppError, `Opportunity Processor (${opp.groupName})`); // Use error handler
        // Return error state, execution was not attempted (or failed before tx send)
        return { executed: false, success: false, txHash: null, error: oppError };
    }
}

module.exports = { processOpportunity };
