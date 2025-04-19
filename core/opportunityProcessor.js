// core/opportunityProcessor.js
// *** TEMPORARILY FORCES checkProfitability call for debugging ***
// *** Corrected Syntax Errors AGAIN ***
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

    // --- Validations ---
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

        // --- Resolve Tokens ---
        const tokenA = pool1.token0?.symbol === symA ? pool1.token0 : (pool1.token1?.symbol === symA ? pool1.token1 : null);
        const tokenB = pool1.token0?.symbol === symB ? pool1.token0 : (pool1.token1?.symbol === symB ? pool1.token1 : null);
        if (!tokenB) { throw new ArbitrageError(`${logPrefix} Could not find token ${symB} in pool 1 (${pool1.address}).`, 'INTERNAL_ERROR'); }
        const tokenC = pool2.token0?.symbol === symC ? pool2.token0 : (pool2.token1?.symbol === symC ? pool2.token1 : null);
        if (!tokenC) { throw new ArbitrageError(`${logPrefix} Could not find token ${symC} in pool 2 (${pool2.address}).`, 'INTERNAL_ERROR'); }
        const tokenA_check = pool3.token0?.symbol === symA ? pool3.token0 : (pool3.token1?.symbol === symA ? pool3.token1 : null);
        if (!tokenA_check) { throw new ArbitrageError(`${logPrefix} Could not find return token ${symA} in pool 3 (${pool3.address}).`, 'INTERNAL_ERROR'); }
        if (!(tokenA instanceof Token) || !(tokenB instanceof Token) || !(tokenC instanceof Token)) { throw new ArbitrageError(`${logPrefix} Failed to resolve one or more SDK Token instances. A=${tokenA?.symbol}, B=${tokenB?.symbol}, C=${tokenC?.symbol}`, 'INTERNAL_ERROR'); }
        // --- End Token Resolution ---

        // *** RESTORED POOL MATCH VALIDATION ***
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

        // --- Hops 1, 2, 3 (Simulation calls - same as before) ---
        contextLogger.debug(`${logPrefix} Simulating Hop 1...`);
        console.log(`${logPrefix} POOL 1 STATE before simulation:`); console.log(stringifyPoolState(pool1));
        const hop1Result = await quoteSimulator.simulateSingleSwapExactIn(pool1, tokenA, tokenB, initialAmount);
        if (!hop1Result || hop1Result.amountOut == null || hop1Result.amountOut <= 0n) { /* ... error ... */ }
        const amountB_Received = hop1Result.amountOut;
        contextLogger.info(`[SIM Hop 1 ${tokenA.symbol}->${tokenB.symbol}] Output: ${ethers.formatUnits(amountB_Received, tokenB.decimals)} ${tokenB.symbol}`);

        contextLogger.debug(`${logPrefix} Simulating Hop 2...`);
        console.log(`${logPrefix} POOL 2 STATE before simulation:`); console.log(stringifyPoolState(pool2));
        const hop2Result = await quoteSimulator.simulateSingleSwapExactIn(pool2, tokenB, tokenC, amountB_Received);
        if (!hop2Result || hop2Result.amountOut == null || hop2Result.amountOut <= 0n) { /* ... error ... */ }
        const amountC_Received = hop2Result.amountOut;
        contextLogger.info(`[SIM Hop 2 ${tokenB.symbol}->${tokenC.symbol}] Output: ${ethers.formatUnits(amountC_Received, tokenC.decimals)} ${tokenC.symbol}`);

        contextLogger.debug(`${logPrefix} Simulating Hop 3...`);
        console.log(`${logPrefix} POOL 3 STATE before simulation:`); console.log(stringifyPoolState(pool3));
        const hop3Result = await quoteSimulator.simulateSingleSwapExactIn(pool3, tokenC, tokenA, amountC_Received);
        if (!hop3Result || hop3Result.amountOut == null || hop3Result.amountOut <= 0n) { /* ... error ... */ }
        const finalAmount = hop3Result.amountOut;
        contextLogger.info(`[SIM Hop 3 ${tokenC.symbol}->${tokenA.symbol}] Output: ${ethers.formatUnits(finalAmount, tokenA.decimals)} ${tokenA.symbol}`);
        // --- End Hops ---

        // --- Calculate Gross Profit and Construct Result (same as before) ---
        const grossProfit = finalAmount - initialAmount;
        const profitable = grossProfit > 0n;
        simulationResult = {
            profitable, error: null, initialAmount, finalAmount, grossProfit,
            details: { tokenA: tokenA, hop1Result, hop2Result, hop3Result }
        };
        // --- End Simulation Result Construction ---

        // --- TEMPORARY CHANGE: Log gross profit, then ALWAYS proceed to Net Profit Check ---
        if (profitable) {
            contextLogger.info(`${logPrefix} ✅ Simulation shows POSITIVE gross profit: ${ethers.formatUnits(simulationResult.grossProfit, groupConfig.sdkBorrowToken.decimals)} ${borrowTokenSymbol}`);
        } else {
            contextLogger.info(`${logPrefix} Simulation shows NO gross profit (${ethers.formatUnits(simulationResult.grossProfit, groupConfig.sdkBorrowToken.decimals)} ${borrowTokenSymbol}).`);
        }
        contextLogger.info(`${logPrefix} TEMPORARY DEBUG: Proceeding to Net Profit Check regardless of gross profit...`);
        // --- END TEMPORARY CHANGE ---

        // --- d. Net Profit Check & Gas Estimation ---
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
        contextLogger.info(`${logPrefix} ✅✅ Opportunity IS Profitable after estimated gas! (Net Profit: ${ethers.formatUnits(profitabilityResult.netProfitWei, 18)} ${config.NATIVE_SYMBOL})`);

        // e. Execute if profitable (same as before)
        contextLogger.info(`${logPrefix} >>> Attempting Execution... <<<`);
        if (config.DRY_RUN) {
             contextLogger.warn(`${logPrefix} --- DRY RUN ENABLED --- Skipping actual transaction execution.`);
             return { executed: true, success: true, txHash: "0xDRYRUN_NO_EXECUTION", error: null, simulationResult };
        }
        const executionResult = await executeTransaction( /* ... */ ); // Assuming same args
        if (executionResult.success) { /* ... */ return { /*...*/ }; }
        else { /* ... */ return { /*...*/ }; }

    } catch (oppError) { /* ... error handling ... */ }
}

module.exports = { processOpportunity };
