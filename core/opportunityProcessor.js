// core/opportunityProcessor.js
// *** TEMPORARILY FORCES checkProfitability call for debugging ***
const { ethers } = require('ethers');
const { Token } = require('@uniswap/sdk-core');
const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler');
const ProfitCalculator = require('./profitCalculator');
const { executeTransaction } = require('./txExecutor');
const { stringifyPoolState } = require('./simulationHelpers');

async function processOpportunity(opp, engineContext) {
    const { config, manager, gasEstimator, quoteSimulator, logger: contextLogger } = engineContext;
    const logPrefix = `[OppProcessor Type: ${opp.type}, Group: ${opp.groupName}]`;
    contextLogger.info(`${logPrefix} Processing potential opportunity...`);

    // --- Validations (same as before) ---
    if (!config || !manager || !gasEstimator || !quoteSimulator || !contextLogger) { /*...*/ return { /*...*/ }; }
    if (!opp || typeof opp !== 'object') { /*...*/ return { /*...*/ }; }
    if (opp.type !== 'triangular') { /*...*/ return { /*...*/ }; }

    let simulationResult = null;

    try {
        // a. Find Group Config (same as before)
        const groupConfig = config.POOL_GROUPS.find(g => g.name === opp.groupName);
        if (!groupConfig) { throw new ArbitrageError(/*...*/); }
        if (!groupConfig.sdkBorrowToken || groupConfig.borrowAmount == null || typeof groupConfig.minNetProfit === 'undefined') { throw new ArbitrageError(/*...*/); }

        // b. Verify Borrow Token and Set Initial Amount (same as before)
        const borrowTokenSymbol = groupConfig.borrowTokenSymbol;
        if (!opp.pathSymbols || opp.pathSymbols.length < 1 || opp.pathSymbols[0] !== borrowTokenSymbol) { throw new ArbitrageError(/*...*/); }
        const initialAmount = groupConfig.borrowAmount;

        // --- c. Simulate Arbitrage Hop-by-Hop (same as before) ---
        contextLogger.info(`${logPrefix} Simulating path: ${opp.pathSymbols.join(' -> ')} with ${ethers.formatUnits(initialAmount, groupConfig.sdkBorrowToken.decimals)} ${borrowTokenSymbol}`);
        if (!opp.pools || opp.pools.length !== 3 || !opp.pathSymbols || opp.pathSymbols.length !== 4) { throw new ArbitrageError(/*...*/); }
        const [pool1, pool2, pool3] = opp.pools;
        const [symA, symB, symC, symA_final] = opp.pathSymbols;
        if (symA !== symA_final) { throw new ArbitrageError(/*...*/); }
        if (!pool1 || !pool2 || !pool3) { throw new ArbitrageError(/*...*/); }
        if (!(pool1.token0 instanceof Token) || !(pool1.token1 instanceof Token) || !(pool2.token0 instanceof Token) || !(pool2.token1 instanceof Token) || !(pool3.token0 instanceof Token) || !(pool3.token1 instanceof Token)) { throw new ArbitrageError(/*...*/); }
        const tokenA = pool1.token0?.symbol === symA ? pool1.token0 : (pool1.token1?.symbol === symA ? pool1.token1 : null);
        const tokenB = pool1.token0?.symbol === symB ? pool1.token0 : (pool1.token1?.symbol === symB ? pool1.token1 : null);
        if (!tokenB) { throw new ArbitrageError(/*...*/); }
        const tokenC = pool2.token0?.symbol === symC ? pool2.token0 : (pool2.token1?.symbol === symC ? pool2.token1 : null);
        if (!tokenC) { throw new ArbitrageError(/*...*/); }
        const tokenA_check = pool3.token0?.symbol === symA ? pool3.token0 : (pool3.token1?.symbol === symA ? pool3.token1 : null);
        if (!tokenA_check) { throw new ArbitrageError(/*...*/); }
        if (!(tokenA instanceof Token) || !(tokenB instanceof Token) || !(tokenC instanceof Token)) { throw new ArbitrageError(/*...*/); }
        const pool1Matches = /*...*/; const pool2Matches = /*...*/; const pool3Matches = /*...*/;
        if (!pool1Matches || !pool2Matches || !pool3Matches) { throw new ArbitrageError(/*...*/); }

        // --- Hop 1 (same as before) ---
        contextLogger.debug(`${logPrefix} Simulating Hop 1...`);
        console.log(`${logPrefix} POOL 1 STATE before simulation:`); console.log(stringifyPoolState(pool1));
        const hop1Result = await quoteSimulator.simulateSingleSwapExactIn(pool1, tokenA, tokenB, initialAmount);
        if (!hop1Result || hop1Result.amountOut == null || hop1Result.amountOut <= 0n) { throw new ArbitrageError(/*...*/); }
        const amountB_Received = hop1Result.amountOut;
        contextLogger.info(`[SIM Hop 1 ${tokenA.symbol}->${tokenB.symbol}] Output: ${ethers.formatUnits(amountB_Received, tokenB.decimals)} ${tokenB.symbol}`);

        // --- Hop 2 (same as before) ---
        contextLogger.debug(`${logPrefix} Simulating Hop 2...`);
        console.log(`${logPrefix} POOL 2 STATE before simulation:`); console.log(stringifyPoolState(pool2));
        const hop2Result = await quoteSimulator.simulateSingleSwapExactIn(pool2, tokenB, tokenC, amountB_Received);
        if (!hop2Result || hop2Result.amountOut == null || hop2Result.amountOut <= 0n) { throw new ArbitrageError(/*...*/); }
        const amountC_Received = hop2Result.amountOut;
        contextLogger.info(`[SIM Hop 2 ${tokenB.symbol}->${tokenC.symbol}] Output: ${ethers.formatUnits(amountC_Received, tokenC.decimals)} ${tokenC.symbol}`);

        // --- Hop 3 (same as before) ---
        contextLogger.debug(`${logPrefix} Simulating Hop 3...`);
        console.log(`${logPrefix} POOL 3 STATE before simulation:`); console.log(stringifyPoolState(pool3));
        const hop3Result = await quoteSimulator.simulateSingleSwapExactIn(pool3, tokenC, tokenA, amountC_Received);
        if (!hop3Result || hop3Result.amountOut == null || hop3Result.amountOut <= 0n) { throw new ArbitrageError(/*...*/); }
        const finalAmount = hop3Result.amountOut;
        contextLogger.info(`[SIM Hop 3 ${tokenC.symbol}->${tokenA.symbol}] Output: ${ethers.formatUnits(finalAmount, tokenA.decimals)} ${tokenA.symbol}`);

        // --- Calculate Gross Profit and Construct Result (same as before) ---
        const grossProfit = finalAmount - initialAmount;
        const profitable = grossProfit > 0n;
        simulationResult = {
            profitable, error: null, initialAmount, finalAmount, grossProfit,
            details: { tokenA: tokenA, hop1Result, hop2Result, hop3Result }
        };
        // --- End Simulation Result Construction ---

        // *** TEMPORARY CHANGE: Log gross profit, then ALWAYS proceed to Net Profit Check ***
        if (profitable) {
            contextLogger.info(`${logPrefix} ✅ Simulation shows POSITIVE gross profit: ${ethers.formatUnits(simulationResult.grossProfit, groupConfig.sdkBorrowToken.decimals)} ${borrowTokenSymbol}`);
        } else {
            contextLogger.info(`${logPrefix} Simulation shows NO gross profit (${ethers.formatUnits(simulationResult.grossProfit, groupConfig.sdkBorrowToken.decimals)} ${borrowTokenSymbol}).`);
        }
        contextLogger.info(`${logPrefix} TEMPORARY DEBUG: Proceeding to Net Profit Check regardless of gross profit...`);
        // *** END TEMPORARY CHANGE ***

        // --- d. Net Profit Check & Gas Estimation ---
        // This will now always be called if simulation succeeds
        const profitabilityResult = await ProfitCalculator.checkProfitability(
            simulationResult, gasEstimator, groupConfig, null
        );

        // Check the *actual* profitability result
        if (!profitabilityResult || !profitabilityResult.isProfitable) {
            const netProfitStr = profitabilityResult ? `${ethers.formatUnits(profitabilityResult.netProfitWei, 18)} ${config.NATIVE_SYMBOL}` : 'N/A';
            const gasCostStr = profitabilityResult ? `${ethers.formatUnits(profitabilityResult.estimatedGasCostWei, 18)} ${config.NATIVE_SYMBOL}` : 'N/A';
            contextLogger.info(`${logPrefix} Opportunity NOT Profitable after estimated gas (Net Profit: ${netProfitStr}, Est Gas Cost: ${gasCostStr}). Skipping.`);
            return { executed: false, success: false, txHash: null, error: null, simulationResult };
        }
        // If we reach here, it *IS* actually profitable net of gas
        contextLogger.info(`${logPrefix} ✅✅ Opportunity IS Profitable after estimated gas! (Net Profit: ${ethers.formatUnits(profitabilityResult.netProfitWei, 18)} ${config.NATIVE_SYMBOL})`);

        // e. Execute if profitable (same as before)
        contextLogger.info(`${logPrefix} >>> Attempting Execution... <<<`);
        if (config.DRY_RUN) { /*...*/ return { /*...*/ }; }
        const executionResult = await executeTransaction(/* ... */);
        if (executionResult.success) { /*...*/ return { /*...*/ }; }
        else { /*...*/ return { /*...*/ }; }

    } catch (oppError) { /* ... error handling ... */ }
}

module.exports = { processOpportunity };
