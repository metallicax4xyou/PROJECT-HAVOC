// core/quoteSimulator.js
const { ethers } = require('ethers');
const { CurrencyAmount, TradeType, Percent, Token } = require('@uniswap/sdk-core');
const { Pool, Route, Trade } = require('@uniswap/v3-sdk');
const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler');
const config = require('../config/index.js');
const { ABIS } = require('../constants/abis');

// --- Helper: Simulate a single swap using Uniswap V3 SDK ---
async function simulateSingleTradeSDK( poolForTrade, tokenIn, tokenOut, amountIn ) {
    // ... (previous simulateSingleTradeSDK code - no changes needed here for now) ...
    if (!amountIn || amountIn.quotient === 0n) { logger.debug(`[Simulator SDK] Cannot simulate with zero input amount.`); return null; }
    // logger.debug(`[Simulator SDK] Simulating ${amountIn.toSignificant(8)} ${tokenIn.symbol} -> ${tokenOut.symbol} on pool ${poolForTrade.token0.address}/${poolForTrade.token1.address} Fee ${poolForTrade.fee}`);
    try {
        const route = new Route([poolForTrade], tokenIn, tokenOut);
        const trade = await Trade.fromRoute(route, amountIn, TradeType.EXACT_INPUT);
        if (!trade || !trade.outputAmount || typeof trade.outputAmount.quotient === 'undefined') { logger.warn(`[Simulator SDK] Trade simulation returned invalid trade object or outputAmount.`); return null; }
        // logger.debug(`[Simulator SDK] Trade successful. Output: ${trade.outputAmount.toSignificant(8)} ${tokenOut.symbol}`);
        return trade;
    } catch (error) {
        if (error.message.includes('liquidity') || error.message.includes('SPL') || error.code === 'RUNTIME_ERROR') { logger.warn(`[Simulator SDK] Trade simulation failed (${tokenIn.symbol} -> ${tokenOut.symbol}): ${error.message}`);
        } else { handleError(error, `simulateSingleTradeSDK (${tokenIn.symbol} -> ${tokenOut.symbol})`); if (!error.code) { logger.error("[Simulator SDK] Unexpected non-ethers error structure:", error); } }
        return null;
    }
}

// calculateDynamicSimAmount function remains the same
function calculateDynamicSimAmount(poolSDK, tokenIn, percentageOfLiquidity = 0.5) {
     const configuredBorrowAmount = config.BORROW_AMOUNTS_WEI[tokenIn.symbol];
     if (!configuredBorrowAmount || configuredBorrowAmount === 0n) { logger.warn(`[Simulator] Configured borrow amount for ${tokenIn.symbol} is zero or missing.`); return null; }
     const fraction = 100n; // Simulate with 1%
     const simAmountRaw = configuredBorrowAmount / fraction;
     if (simAmountRaw === 0n) { logger.warn(`[Simulator] Calculated simulation amount is zero for ${tokenIn.symbol}. Using a minimal unit.`); return CurrencyAmount.fromRawAmount(tokenIn, 1n); }
     // Ensure the raw amount is converted to string for CurrencyAmount constructor if needed by older SDK versions
     return CurrencyAmount.fromRawAmount(tokenIn, simAmountRaw.toString());
}

async function simulateArbitrage(opportunity) {
     if (!opportunity || !opportunity.swapPoolInfo?.sdkPool || !opportunity.sdkTokenBorrowed || !opportunity.sdkTokenIntermediate || !opportunity.borrowAmount) {
         logger.warn('[Simulator] Invalid opportunity object received for simulation.', opportunity);
         return null;
     }

    const { startPoolInfo, swapPoolInfo, sdkTokenBorrowed, sdkTokenIntermediate, borrowAmount } = opportunity;
    const swapPoolSDK = swapPoolInfo.sdkPool;

    // +++ FOCUSED DEBUGGING AREA +++
    let amountInForSimulation;
    let simAmountRaw;
    let decimalsToUse;
    let symbolToUse;
    try {
        logger.debug(`[DEBUG] Attempting to calculate dynamic sim amount for token: ${sdkTokenBorrowed?.symbol}`);
        amountInForSimulation = calculateDynamicSimAmount(swapPoolSDK, sdkTokenBorrowed);

        logger.debug(`[DEBUG] Result of calculateDynamicSimAmount:`, amountInForSimulation); // Log the object
        if (!amountInForSimulation || typeof amountInForSimulation.quotient === 'undefined') {
             throw new Error('calculateDynamicSimAmount returned invalid object or quotient is missing.');
        }
        logger.debug(`[DEBUG] Type of amountInForSimulation: ${Object.prototype.toString.call(amountInForSimulation)}`);
        logger.debug(`[DEBUG] amountInForSimulation instanceof CurrencyAmount: ${amountInForSimulation instanceof CurrencyAmount}`);

        simAmountRaw = amountInForSimulation.quotient;
        logger.debug(`[DEBUG] Extracted simAmountRaw: ${simAmountRaw} (Type: ${typeof simAmountRaw})`);

        if (typeof simAmountRaw !== 'bigint') {
             throw new Error(`simAmountRaw is not a BigInt! Got type: ${typeof simAmountRaw}`);
        }

        decimalsToUse = sdkTokenBorrowed.decimals;
        logger.debug(`[DEBUG] Extracted decimalsToUse: ${decimalsToUse} (Type: ${typeof decimalsToUse})`);
        if (typeof decimalsToUse !== 'number') {
             throw new Error(`sdkTokenBorrowed.decimals is not a number! Got type: ${typeof decimalsToUse}`);
        }

        symbolToUse = sdkTokenBorrowed.symbol;
        logger.debug(`[DEBUG] Extracted symbolToUse: ${symbolToUse}`);

        // This is the line that was failing
        const formattedAmount = ethers.formatUnits(simAmountRaw, decimalsToUse);
        logger.debug(`[DEBUG] Successfully formatted amount: ${formattedAmount}`);

        // Now proceed with the original log message
         logger.log(`[Simulator] Simulating: ${opportunity.groupName} | Start ${startPoolInfo.feeBps}bps -> Swap ${swapPoolInfo.feeBps}bps | Sim Input ${formattedAmount} ${symbolToUse}`);

    } catch (debugError) {
         logger.error(`[DEBUG] ERROR during pre-simulation checks or formatting: ${debugError.message}`);
         // Log the inputs to the failing function if possible
         logger.error(`[DEBUG] Inputs were: simAmountRaw=${simAmountRaw}, decimalsToUse=${decimalsToUse}`);
         handleError(debugError, `QuoteSimulator.PreSimulation (${opportunity?.groupName})`);
         return null; // Abort simulation
    }
    // +++ END FOCUSED DEBUGGING AREA +++


    try {
        // ... (Rest of the simulation logic: calculating repayment, calling simulateSingleTradeSDK, extrapolation, etc.) ...
        // ... (No changes needed below this point for THIS specific error) ...

        const flashFeePercent = BigInt(config.FLASH_LOAN_FEE_BPS);
        const flashFee = (borrowAmount * flashFeePercent) / 10000n;
        const requiredRepaymentAmount = borrowAmount + flashFee;
        // logger.debug(`[Simulator] Actual Intended Borrow: ${ethers.formatUnits(borrowAmount, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`);
        // logger.debug(`[Simulator] Required Repayment (for actual borrow): ${ethers.formatUnits(requiredRepaymentAmount, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`);

        // --- Swap 1 ---
        // logger.debug("[Simulator] ---> Simulating Swap 1...");
        const trade1 = await simulateSingleTradeSDK(swapPoolSDK, sdkTokenBorrowed, sdkTokenIntermediate, amountInForSimulation);
        if (!trade1) { logger.log(`[Simulator] Simulation FAIL Swap 1 (${sdkTokenBorrowed.symbol}->${sdkTokenIntermediate.symbol} on ${swapPoolInfo.feeBps}bps pool).`); return null; }
        const amountOutSwap1 = trade1.outputAmount;
        if (!(amountOutSwap1 instanceof CurrencyAmount)) { logger.error('[Simulator] ERROR: amountOutSwap1 is not a CurrencyAmount!', amountOutSwap1); throw new ArbitrageError('Internal simulation error: Invalid type for amountOutSwap1.', 'SIMULATION_ERROR'); }
        // logger.debug(`[Simulator] Sim Swap 1 OK: Input ${amountInForSimulation.toSignificant(6)} ${sdkTokenBorrowed.symbol} -> Output ${amountOutSwap1.toSignificant(6)} ${sdkTokenIntermediate.symbol}`);

        // --- Swap 2 ---
        // logger.debug("[Simulator] ---> Simulating Swap 2...");
        const amountInSwap2 = amountOutSwap1;
        const trade2 = await simulateSingleTradeSDK(swapPoolSDK, sdkTokenIntermediate, sdkTokenBorrowed, amountInSwap2);
        if (!trade2) { logger.log(`[Simulator] Simulation FAIL Swap 2 (${sdkTokenIntermediate.symbol}->${sdkTokenBorrowed.symbol} on ${swapPoolInfo.feeBps}bps pool).`); return null; }
        const amountOutSwap2_Sim = trade2.outputAmount;
         if (!(amountOutSwap2_Sim instanceof CurrencyAmount)) { logger.error('[Simulator] ERROR: amountOutSwap2_Sim is not a CurrencyAmount!', amountOutSwap2_Sim); throw new ArbitrageError('Internal simulation error: Invalid type for amountOutSwap2_Sim.', 'SIMULATION_ERROR'); }
        const finalAmountReceived_Sim_Raw = amountOutSwap2_Sim.quotient;
        // logger.debug(`[Simulator] Sim Swap 2 OK: Input ${amountInSwap2.toSignificant(6)} ${sdkTokenIntermediate.symbol} -> Output ${amountOutSwap2_Sim.toSignificant(6)} ${sdkTokenBorrowed.symbol}`);


        // --- Extrapolation & Profit ---
        // logger.debug("[Simulator] ---> Calculating Estimated Profit...");
        let finalAmountReceived_Actual_Estimated = 0n;
        if (simAmountRaw > 0n && typeof finalAmountReceived_Sim_Raw === 'bigint') { finalAmountReceived_Actual_Estimated = (finalAmountReceived_Sim_Raw * borrowAmount) / simAmountRaw;
        } else { logger.error(`[Simulator] ERROR: Cannot calculate estimated profit. simAmountRaw=${simAmountRaw}, finalAmountReceived_Sim_Raw=${finalAmountReceived_Sim_Raw} (Type: ${typeof finalAmountReceived_Sim_Raw})`); throw new ArbitrageError('Internal simulation error: Invalid inputs for profit extrapolation.', 'SIMULATION_ERROR'); }
        logger.log(`[Simulator] Est. Final Amount Received (for actual borrow): ${ethers.formatUnits(finalAmountReceived_Actual_Estimated, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`);
        if (finalAmountReceived_Actual_Estimated <= requiredRepaymentAmount) { logger.log(`[Simulator] Gross Profit Check FAIL. Est. Final Amount <= Required Repayment.`); return null; }
        const grossProfit = finalAmountReceived_Actual_Estimated - requiredRepaymentAmount;
        logger.log(`[Simulator] Est. Gross Profit Found: ${ethers.formatUnits(grossProfit, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`);

        // Return results
        return { finalAmountReceived: finalAmountReceived_Actual_Estimated, requiredRepayment: requiredRepaymentAmount, grossProfit: grossProfit, simulatedAmountIn: simAmountRaw, trade1: trade1, trade2: trade2 };

    } catch (error) {
         if (error instanceof ArbitrageError && error.type === 'SIMULATION_ERROR') { handleError(error, `QuoteSimulator.Calculation (${opportunity.groupName})`);
         } else if (error.code !== 'INVALID_ARGUMENT') { handleError(error, `QuoteSimulator.simulateArbitrage (${opportunity.groupName})`); }
        logger.error(`[Simulator] Error during simulation calculation for group ${opportunity.groupName}: ${error.message}`);
        return null;
    }
}

// getMinimumAmountOut function remains the same
function getMinimumAmountOut(trade, slippageToleranceBps) {
    if (!trade) return 0n;
    const slippageTolerance = new Percent(slippageToleranceBps, 10000);
    const amountOut = trade.minimumAmountOut(slippageTolerance);
    return amountOut.quotient;
}

module.exports = {
    simulateArbitrage,
    getMinimumAmountOut,
};
