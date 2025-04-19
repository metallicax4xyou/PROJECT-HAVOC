// core/opportunityProcessor.js
// *** Adds tokenA to simulationResult.details ***
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
    if (!config || !manager || !gasEstimator || !quoteSimulator || !contextLogger) { /* ... error ... */ }
    if (!opp || typeof opp !== 'object') { /* ... error ... */ }
    if (opp.type !== 'triangular') { /* ... skip ... */ }

    let simulationResult = null; // Define outside try block

    try {
        // a. Find Group Config
        const groupConfig = config.POOL_GROUPS.find(g => g.name === opp.groupName);
        if (!groupConfig) { /* ... error ... */ }
        if (!groupConfig.sdkBorrowToken || /* ... */ ) { /* ... error ... */ }

        // b. Verify Borrow Token and Set Initial Amount
        const borrowTokenSymbol = groupConfig.borrowTokenSymbol;
        if (!opp.pathSymbols || /* ... */ ) { /* ... error ... */ }
        const initialAmount = groupConfig.borrowAmount; // This should be a bigint

        // --- c. Simulate Arbitrage Hop-by-Hop ---
        contextLogger.info(`${logPrefix} Simulating path: ${opp.pathSymbols.join(' -> ')} with ${ethers.formatUnits(initialAmount, groupConfig.sdkBorrowToken.decimals)} ${borrowTokenSymbol}`);

        // Validate triangular structure
        if (!opp.pools || opp.pools.length !== 3 || /* ... */ ) { /* ... error ... */ }

        const [pool1, pool2, pool3] = opp.pools;
        const [symA, symB, symC, symA_final] = opp.pathSymbols;

        if (symA !== symA_final) { /* ... error ... */ }
        if (!pool1 || !pool2 || !pool3) { /* ... error ... */ }
        if (!(pool1.token0 instanceof Token) || /* ... */ ) { /* ... error ... */ }

        // --- Resolve Tokens (tokenA is the borrowed token) ---
        const tokenA = pool1.token0?.symbol === symA ? pool1.token0 : (pool1.token1?.symbol === symA ? pool1.token1 : null);
        const tokenB = pool1.token0?.symbol === symB ? pool1.token0 : (pool1.token1?.symbol === symB ? pool1.token1 : null);
        if (!tokenB) { /* ... error ... */ }
        const tokenC = pool2.token0?.symbol === symC ? pool2.token0 : (pool2.token1?.symbol === symC ? pool2.token1 : null);
        if (!tokenC) { /* ... error ... */ }
        const tokenA_check = pool3.token0?.symbol === symA ? pool3.token0 : (pool3.token1?.symbol === symA ? pool3.token1 : null);
        if (!tokenA_check) { /* ... error ... */ }
        if (!(tokenA instanceof Token) || !(tokenB instanceof Token) || !(tokenC instanceof Token)) { /* ... error ... */ }
        // --- End Token Resolution ---

        // Validate pool token pairs (omitted for brevity, same as before)
        const pool1Matches = /* ... */; const pool2Matches = /* ... */; const pool3Matches = /* ... */;
        if (!pool1Matches || !pool2Matches || !pool3Matches) { /* ... error ... */ }

        // --- Hop 1 ---
        contextLogger.debug(`${logPrefix} Simulating Hop 1: ${tokenA.symbol} -> ${tokenB.symbol} in Pool ${pool1.address}`);
        console.log(`${logPrefix} POOL 1 STATE before simulation:`); console.log(stringifyPoolState(pool1));
        const hop1Result = await quoteSimulator.simulateSingleSwapExactIn(pool1, tokenA, tokenB, initialAmount);
        if (!hop1Result || hop1Result.amountOut == null || hop1Result.amountOut <= 0n) { /* ... error ... */ }
        const amountB_Received = hop1Result.amountOut;
        contextLogger.info(`[SIM Hop 1 ${tokenA.symbol}->${tokenB.symbol}] Output: ${ethers.formatUnits(amountB_Received, tokenB.decimals)} ${tokenB.symbol}`);

        // --- Hop 2 ---
        contextLogger.debug(`${logPrefix} Simulating Hop 2: ${tokenB.symbol} -> ${tokenC.symbol} in Pool ${pool2.address}`);
        console.log(`${logPrefix} POOL 2 STATE before simulation:`); console.log(stringifyPoolState(pool2));
        const hop2Result = await quoteSimulator.simulateSingleSwapExactIn(pool2, tokenB, tokenC, amountB_Received);
        if (!hop2Result || hop2Result.amountOut == null || hop2Result.amountOut <= 0n) { /* ... error ... */ }
        const amountC_Received = hop2Result.amountOut;
        contextLogger.info(`[SIM Hop 2 ${tokenB.symbol}->${tokenC.symbol}] Output: ${ethers.formatUnits(amountC_Received, tokenC.decimals)} ${tokenC.symbol}`);

        // --- Hop 3 ---
        contextLogger.debug(`${logPrefix} Simulating Hop 3: ${tokenC.symbol} -> ${tokenA.symbol} in Pool ${pool3.address}`);
        console.log(`${logPrefix} POOL 3 STATE before simulation:`); console.log(stringifyPoolState(pool3));
        const hop3Result = await quoteSimulator.simulateSingleSwapExactIn(pool3, tokenC, tokenA, amountC_Received);
        if (!hop3Result || hop3Result.amountOut == null || hop3Result.amountOut <= 0n) { /* ... error ... */ }
        const finalAmount = hop3Result.amountOut;
        contextLogger.info(`[SIM Hop 3 ${tokenC.symbol}->${tokenA.symbol}] Output: ${ethers.formatUnits(finalAmount, tokenA.decimals)} ${tokenA.symbol}`);

        // --- Calculate Gross Profit and Construct Result ---
        const grossProfit = finalAmount - initialAmount;
        const profitable = grossProfit > 0n;

        // *** Construct the simulationResult object with tokenA in details ***
        simulationResult = {
            profitable,
            error: null,
            initialAmount,
            finalAmount,
            grossProfit,
            details: {
                tokenA: tokenA, // <<< ADDED BORROW TOKEN HERE
                hop1Result,
                hop2Result,
                hop3Result
            }
        };
        // --- End Simulation Result Construction ---

        // Check Gross Profit
        if (!simulationResult.profitable) { /* ... skip ... */ }
        contextLogger.info(`${logPrefix} ✅ Simulation shows POSITIVE gross profit: ${ethers.formatUnits(simulationResult.grossProfit, groupConfig.sdkBorrowToken.decimals)} ${borrowTokenSymbol}`);

        // --- d. Net Profit Check & Gas Estimation ---
        contextLogger.info(`${logPrefix} Performing Net Profit Check...`);
        // *** Call checkProfitability - it should now receive tokenA correctly ***
        const profitabilityResult = await ProfitCalculator.checkProfitability(
            simulationResult,
            gasEstimator, // Pass instance directly
            groupConfig,
            null
        );

        if (!profitabilityResult || !profitabilityResult.isProfitable) { /* ... skip ... */ }
        contextLogger.info(`${logPrefix} ✅✅ Opportunity IS Profitable after estimated gas! (Net Profit: ${ethers.formatUnits(profitabilityResult.netProfitWei, 18)} ${config.NATIVE_SYMBOL})`);

        // e. Execute if profitable
        contextLogger.info(`${logPrefix} >>> Attempting Execution... <<<`);
        if (config.DRY_RUN) { /* ... dry run log ... */ }

        const executionResult = await executeTransaction( /* ... */ ); // Call executeTransaction (same args as before)

        // Check execution result (same logic as before)
        if (executionResult.success) { /* ... */ }
        else { /* ... */ }

    } catch (oppError) { /* ... error handling ... */ }
}

module.exports = { processOpportunity };
