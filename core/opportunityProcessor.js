// core/opportunityProcessor.js
const { ethers } = require('ethers');
const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler');
// Removed direct import of QuoteSimulator static methods
const ProfitCalculator = require('./profitCalculator'); // Still static
const { executeTransaction } = require('./txExecutor');

function safeStringify(obj, indent = null) { /* ... */ }

/**
 * Processes a single potential arbitrage opportunity.
 * Includes simulation, profitability check, and execution attempt.
 *
 * @param {object} opp The potential opportunity object.
 * @param {object} engineContext Object containing dependencies: { config, manager, gasEstimator, quoteSimulator, logger } // Added quoteSimulator
 * @returns {Promise<{ executed: boolean, success: boolean, txHash: string|null, error: ArbitrageError|Error|null }>} Result of processing.
 */
async function processOpportunity(opp, engineContext) {
    // Destructure context - now includes quoteSimulator
    const { config, manager, gasEstimator, quoteSimulator, logger: contextLogger } = engineContext;
    const logPrefix = `[OppProcessor Type: ${opp.type}, Group: ${opp.groupName}]`;
    contextLogger.info(`${logPrefix} Processing potential opportunity...`);
    // contextLogger.debug(`${logPrefix} Details: ${safeStringify(opp)}`); // Keep debug log if needed

    // Basic validation of context - check for quoteSimulator
    if (!config || !manager || !gasEstimator || !quoteSimulator || !contextLogger) {
         const errMsg = `${logPrefix} Missing dependencies in engineContext (config, manager, gasEstimator, quoteSimulator, logger needed). Aborting.`;
         contextLogger.error(errMsg);
         return { executed: false, success: false, txHash: null, error: new ArbitrageError(errMsg, 'INTERNAL_ERROR', { contextKeys: Object.keys(engineContext) }) };
    }
    if (opp.type !== 'triangular') { /* ... skip ... */ }

    try {
        // a. Find Group Config (Same)
        const groupConfig = config.POOL_GROUPS.find(g => g.name === opp.groupName);
        if (!groupConfig) { /* ... error ... */ }
        if (!groupConfig.sdkBorrowToken || groupConfig.borrowAmount == null || typeof groupConfig.minNetProfit === 'undefined') { /* ... error ... */ }

        // b. Verify Borrow Token (Same)
        const borrowTokenSymbol = groupConfig.borrowTokenSymbol;
        if (opp.pathSymbols[0] !== borrowTokenSymbol) { /* ... error ... */ }
        const initialAmount = groupConfig.borrowAmount;

        // c. Simulate using the quoteSimulator instance from context
        contextLogger.info(`${logPrefix} Simulating path: ${opp.pathSymbols.join(' -> ')} with ${ethers.formatUnits(initialAmount, groupConfig.sdkBorrowToken.decimals)} ${borrowTokenSymbol}`);
        // Call instance method simulateArbitrage
        const simulationResult = await quoteSimulator.simulateArbitrage(opp, initialAmount);

        // Simulation result checking (remains mostly the same)
        if (!simulationResult) {
            // Should ideally not happen if simulator handles errors, but good safeguard
            throw new ArbitrageError(`${logPrefix} Simulation returned null unexpectedly.`, 'SIMULATION_ERROR');
        }
        if (simulationResult.error) {
             // Wrap simulation error for clarity - simulator might have already logged details
            throw new ArbitrageError(`${logPrefix} Simulation failed: ${simulationResult.error}`, 'SIMULATION_ERROR', { originalError: simulationResult.error, details: simulationResult.details });
        }
        if (!simulationResult.profitable) { // Checks gross profit > 0
            contextLogger.info(`${logPrefix} Simulation shows NO gross profit (${ethers.formatUnits(simulationResult.grossProfit || 0n, groupConfig.sdkBorrowToken.decimals)} ${borrowTokenSymbol}). Skipping.`);
            return { executed: false, success: false, txHash: null, error: null };
        }
        contextLogger.info(`${logPrefix} ✅ Simulation shows POSITIVE gross profit: ${ethers.formatUnits(simulationResult.grossProfit, groupConfig.sdkBorrowToken.decimals)} ${borrowTokenSymbol}`);

        // --- d. Net Profit Check & Gas Estimation (Same logic, uses ProfitCalculator static method) ---
        contextLogger.info(`${logPrefix} Performing Net Profit Check...`);
        const profitabilityResult = await ProfitCalculator.checkProfitability(
            simulationResult,
            gasEstimator,
            groupConfig,
            null // txRequest - still using fallback for now
        );

        if (!profitabilityResult || !profitabilityResult.isProfitable) { /* ... skip ... */ }
        contextLogger.info(`${logPrefix} ✅✅ Opportunity IS Profitable after estimated gas! (Net Profit: ${ethers.formatUnits(profitabilityResult.netProfitWei, 18)} ${config.NATIVE_SYMBOL})`);

        // e. Execute if profitable (Same logic, uses imported executeTransaction)
        contextLogger.info(`${logPrefix} >>> Attempting Execution... <<<`);
        const executionResult = await executeTransaction(
            opp,
            simulationResult,
            manager,
            gasEstimator
        );

        // Check execution result (Same)
        if (executionResult.success) { /* ... return success ... */ }
        else { /* ... return failure ... */ }

    } catch (oppError) {
        // Catch errors (Same)
        contextLogger.error(`${logPrefix} Error processing opportunity: ${oppError.message}`);
        handleError(oppError, `Opportunity Processor (${opp.groupName})`);
        return { executed: false, success: false, txHash: null, error: oppError };
    }
}

module.exports = { processOpportunity };
