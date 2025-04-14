// core/quoteSimulator.js
const { ethers } = require('ethers');
const { CurrencyAmount, TradeType, Percent, Token } = require('@uniswap/sdk-core');
const { Pool, Route, Trade } = require('@uniswap/v3-sdk');
const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler');
const config = require('../config/index.js');
const { ABIS } = require('../constants/abis'); // Need ABI for Quoter call structure

// --- Helper: Simulate a single swap using Uniswap V3 SDK OR Quoter Contract ---
// We were using the SDK's Trade.fromRoute, let's stick with that for now as it handles
// multi-hop eventually and provides more data. The INVALID_ARGUMENT error likely
// happened *after* this, when processing the results. Let's re-verify the results processing.
// If SDK continues to cause issues, we can switch to direct Quoter calls.

async function simulateSingleTradeSDK(
    poolForTrade, // Uniswap SDK Pool object for the swap
    tokenIn,      // SDK Token object for input token
    tokenOut,     // SDK Token object for output token
    amountIn      // Amount of tokenIn (as CurrencyAmount)
) {
    if (!amountIn || amountIn.quotient === 0n) {
         logger.debug(`[Simulator SDK] Cannot simulate with zero input amount.`);
         return null;
    }
    logger.debug(`[Simulator SDK] Simulating ${amountIn.toSignificant(8)} ${tokenIn.symbol} -> ${tokenOut.symbol} on pool ${poolForTrade.token0.address}/${poolForTrade.token1.address} Fee ${poolForTrade.fee}`);
    try {
        const route = new Route([poolForTrade], tokenIn, tokenOut);
        const trade = await Trade.fromRoute(route, amountIn, TradeType.EXACT_INPUT);
        // ** Check the trade object **
        if (!trade || !trade.outputAmount || typeof trade.outputAmount.quotient === 'undefined') {
             logger.warn(`[Simulator SDK] Trade simulation returned invalid trade object or outputAmount.`);
             return null;
        }
        logger.debug(`[Simulator SDK] Trade successful. Output: ${trade.outputAmount.toSignificant(8)} ${tokenOut.symbol}`);
        return trade;
    } catch (error) {
        if (error.message.includes('liquidity') || error.message.includes('SPL') || error.code === 'RUNTIME_ERROR') {
             logger.warn(`[Simulator SDK] Trade simulation failed (${tokenIn.symbol} -> ${tokenOut.symbol}): ${error.message}`);
        } else {
             // *** Potential Source of Error: Is the error object itself being passed incorrectly? ***
             // Let's ensure we handle the error object itself correctly.
             handleError(error, `simulateSingleTradeSDK (${tokenIn.symbol} -> ${tokenOut.symbol})`);
             // Log the error structure if it's not a typical EthersError code
             if (!error.code) {
                  logger.error("[Simulator SDK] Unexpected non-ethers error structure:", error);
             }
        }
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
     return CurrencyAmount.fromRawAmount(tokenIn, simAmountRaw.toString());
}

async function simulateArbitrage(opportunity) {
     if (!opportunity || !opportunity.swapPoolInfo?.sdkPool || !opportunity.sdkTokenBorrowed || !opportunity.sdkTokenIntermediate || !opportunity.borrowAmount) {
         logger.warn('[Simulator] Invalid opportunity object received for simulation.', opportunity);
         return null;
     }

    const { startPoolInfo, swapPoolInfo, sdkTokenBorrowed, sdkTokenIntermediate, borrowAmount } = opportunity;
    const swapPoolSDK = swapPoolInfo.sdkPool;

    const amountInForSimulation = calculateDynamicSimAmount(swapPoolSDK, sdkTokenBorrowed);
    if (!amountInForSimulation) { logger.warn(`[Simulator] Failed to calculate simulation amount for ${sdkTokenBorrowed.symbol}. Aborting simulation.`); return null; }
    const simAmountRaw = amountInForSimulation.quotient;
    logger.log(`[Simulator] Simulating: ${opportunity.groupName} | Start ${startPoolInfo.feeBps}bps -> Swap ${swapPoolInfo.feeBps}bps | Sim Input ${ethers.formatUnits(simAmountRaw, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`);

    try {
        const flashFeePercent = BigInt(config.FLASH_LOAN_FEE_BPS);
        const flashFee = (borrowAmount * flashFeePercent) / 10000n;
        const requiredRepaymentAmount = borrowAmount + flashFee;
        logger.debug(`[Simulator] Actual Intended Borrow: ${ethers.formatUnits(borrowAmount, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`);
        logger.debug(`[Simulator] Required Repayment (for actual borrow): ${ethers.formatUnits(requiredRepaymentAmount, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`);

        // --- Swap 1 ---
        logger.debug("[Simulator] ---> Simulating Swap 1...");
        const trade1 = await simulateSingleTradeSDK(swapPoolSDK, sdkTokenBorrowed, sdkTokenIntermediate, amountInForSimulation); // Using SDK helper
        if (!trade1) { logger.log(`[Simulator] Simulation FAIL Swap 1 (${sdkTokenBorrowed.symbol}->${sdkTokenIntermediate.symbol} on ${swapPoolInfo.feeBps}bps pool).`); return null; }
        const amountOutSwap1 = trade1.outputAmount; // Should be CurrencyAmount
        // +++ Check amountOutSwap1 type +++
        if (!(amountOutSwap1 instanceof CurrencyAmount)) {
            logger.error('[Simulator] ERROR: amountOutSwap1 is not a CurrencyAmount!', amountOutSwap1);
            throw new ArbitrageError('Internal simulation error: Invalid type for amountOutSwap1.', 'SIMULATION_ERROR');
        }
        logger.debug(`[Simulator] Sim Swap 1 OK: Input ${amountInForSimulation.toSignificant(6)} ${sdkTokenBorrowed.symbol} -> Output ${amountOutSwap1.toSignificant(6)} ${sdkTokenIntermediate.symbol}`);

        // --- Swap 2 ---
        logger.debug("[Simulator] ---> Simulating Swap 2...");
        const amountInSwap2 = amountOutSwap1; // Pass CurrencyAmount
        const trade2 = await simulateSingleTradeSDK(swapPoolSDK, sdkTokenIntermediate, sdkTokenBorrowed, amountInSwap2); // Using SDK helper
        if (!trade2) { logger.log(`[Simulator] Simulation FAIL Swap 2 (${sdkTokenIntermediate.symbol}->${sdkTokenBorrowed.symbol} on ${swapPoolInfo.feeBps}bps pool).`); return null; }
        const amountOutSwap2_Sim = trade2.outputAmount; // Should be CurrencyAmount
        // +++ Check amountOutSwap2_Sim type +++
         if (!(amountOutSwap2_Sim instanceof CurrencyAmount)) {
             logger.error('[Simulator] ERROR: amountOutSwap2_Sim is not a CurrencyAmount!', amountOutSwap2_Sim);
             throw new ArbitrageError('Internal simulation error: Invalid type for amountOutSwap2_Sim.', 'SIMULATION_ERROR');
         }
        const finalAmountReceived_Sim_Raw = amountOutSwap2_Sim.quotient; // *** Extract BigInt correctly ***
        logger.debug(`[Simulator] Sim Swap 2 OK: Input ${amountInSwap2.toSignificant(6)} ${sdkTokenIntermediate.symbol} -> Output ${amountOutSwap2_Sim.toSignificant(6)} ${sdkTokenBorrowed.symbol}`);


        // --- Extrapolation & Profit ---
        logger.debug("[Simulator] ---> Calculating Estimated Profit...");
        let finalAmountReceived_Actual_Estimated = 0n;
        if (simAmountRaw > 0n && typeof finalAmountReceived_Sim_Raw === 'bigint') { // ++ Add type check ++
            finalAmountReceived_Actual_Estimated = (finalAmountReceived_Sim_Raw * borrowAmount) / simAmountRaw;
        } else {
            logger.error(`[Simulator] ERROR: Cannot calculate estimated profit. simAmountRaw=${simAmountRaw}, finalAmountReceived_Sim_Raw=${finalAmountReceived_Sim_Raw} (Type: ${typeof finalAmountReceived_Sim_Raw})`);
            throw new ArbitrageError('Internal simulation error: Invalid inputs for profit extrapolation.', 'SIMULATION_ERROR');
        }
        logger.log(`[Simulator] Est. Final Amount Received (for actual borrow): ${ethers.formatUnits(finalAmountReceived_Actual_Estimated, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`);
        if (finalAmountReceived_Actual_Estimated <= requiredRepaymentAmount) { logger.log(`[Simulator] Gross Profit Check FAIL. Est. Final Amount <= Required Repayment.`); return null; }
        const grossProfit = finalAmountReceived_Actual_Estimated - requiredRepaymentAmount;
        logger.log(`[Simulator] Est. Gross Profit Found: ${ethers.formatUnits(grossProfit, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`);

        // Return results
        return { finalAmountReceived: finalAmountReceived_Actual_Estimated, requiredRepayment: requiredRepaymentAmount, grossProfit: grossProfit, simulatedAmountIn: simAmountRaw, trade1: trade1, trade2: trade2 };

    } catch (error) {
        // Catch potential errors converting amounts or during calculations
        // Ensure the error isn't the INVALID_ARGUMENT from downstream usage
         if (error instanceof ArbitrageError && error.type === 'SIMULATION_ERROR') {
              handleError(error, `QuoteSimulator.Calculation (${opportunity.groupName})`); // Handle specific internal errors
         } else if (error.code !== 'INVALID_ARGUMENT') { // Avoid double logging if caught by engine
             handleError(error, `QuoteSimulator.simulateArbitrage (${opportunity.groupName})`);
         }
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
