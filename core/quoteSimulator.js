// core/quoteSimulator.js
// --- (Keep existing require statements at the top) ---
const { ethers } = require('ethers'); // Ensure ethers is required
const { CurrencyAmount, TradeType, Percent, Token } = require('@uniswap/sdk-core');
const { Pool, Route, Trade } = require('@uniswap/v3-sdk');
const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler');
const config = require('../config/index.js');
const { ABIS } = require('../constants/abis');

// --- (Keep existing simulateSingleTradeSDK function) ---
async function simulateSingleTradeSDK( poolForTrade, tokenIn, tokenOut, amountIn ) {
    if (!amountIn || amountIn.quotient === 0n) { logger.debug(`[Simulator SDK] Cannot simulate with zero input amount.`); return null; }
    try {
        const route = new Route([poolForTrade], tokenIn, tokenOut);
        const trade = await Trade.fromRoute(route, amountIn, TradeType.EXACT_INPUT);
        if (!trade || !trade.outputAmount || typeof trade.outputAmount.quotient === 'undefined') { logger.warn(`[Simulator SDK] Trade simulation returned invalid trade object or outputAmount.`); return null; }
        return trade;
    } catch (error) {
        if (error.message.includes('liquidity') || error.message.includes('SPL') || error.code === 'RUNTIME_ERROR') { logger.warn(`[Simulator SDK] Trade simulation failed (${tokenIn.symbol} -> ${tokenOut.symbol}): ${error.message}`);
        } else { handleError(error, `simulateSingleTradeSDK (${tokenIn.symbol} -> ${tokenOut.symbol})`); if (!error.code) { logger.error("[Simulator SDK] Unexpected non-ethers error structure:", error); } }
        return null;
    }
}

// --- (Keep existing calculateDynamicSimAmount function) ---
function calculateDynamicSimAmount(poolSDK, tokenIn, percentageOfLiquidity = 0.5) {
     // Add a check for tokenIn itself
     if (!tokenIn || !tokenIn.symbol) {
        logger.warn(`[Simulator] calculateDynamicSimAmount called with invalid tokenIn.`);
        return null;
     }
     const configuredBorrowAmount = config.BORROW_AMOUNTS_WEI[tokenIn.symbol];
     if (!configuredBorrowAmount || configuredBorrowAmount === 0n) { logger.warn(`[Simulator] Configured borrow amount for ${tokenIn.symbol} is zero or missing.`); return null; }
     const fraction = 100n; // Simulate with 1%
     const simAmountRaw = configuredBorrowAmount / fraction;
     if (simAmountRaw === 0n) { logger.warn(`[Simulator] Calculated simulation amount is zero for ${tokenIn.symbol}. Using a minimal unit.`); return CurrencyAmount.fromRawAmount(tokenIn, 1n); }
     // Ensure the raw amount is converted to string for CurrencyAmount constructor if needed by older SDK versions
     // Also ensure tokenIn has decimals defined before calling fromRawAmount
     if (typeof tokenIn.decimals !== 'number') {
         logger.error(`[Simulator] ERROR: Cannot create CurrencyAmount for ${tokenIn.symbol} - decimals missing!`);
         return null; // Prevent creating amount with undefined decimals
     }
     return CurrencyAmount.fromRawAmount(tokenIn, simAmountRaw.toString()); // Use toString() just in case
}

// --- REPLACEMENT FUNCTION ---
async function simulateArbitrage(opportunity) {
     // --- Initial Validation ---
     if (!opportunity || !opportunity.swapPoolInfo?.sdkPool || !opportunity.sdkTokenBorrowed || !opportunity.sdkTokenIntermediate || !opportunity.borrowAmount) {
         logger.warn('[Simulator] Invalid opportunity object structure received for simulation.', { groupName: opportunity?.groupName });
         return null;
     }
     // Specifically check if sdkTokenBorrowed has decimals
     if (typeof opportunity.sdkTokenBorrowed.decimals !== 'number') {
        logger.error(`[Simulator] CRITICAL: sdkTokenBorrowed for group ${opportunity.groupName} is missing 'decimals' property!`, opportunity.sdkTokenBorrowed);
        // It's better to halt simulation than guess decimals. The issue is likely in PoolScanner data creation.
        // If you MUST proceed, you could add a default like: opportunity.sdkTokenBorrowed.decimals = 18; // Or 6 for stables? Risky!
        return null;
     }

    const { startPoolInfo, swapPoolInfo, sdkTokenBorrowed, sdkTokenIntermediate, borrowAmount } = opportunity;
    const swapPoolSDK = swapPoolInfo.sdkPool;

    // --- Simulation Amount Calculation & Validation ---
    let amountInForSimulation;
    let simAmountRawFromQuotient; // Renamed to be clear about source
    let simAmountBigInt;         // The final BigInt value we need
    let decimalsToUse;
    let symbolToUse;

    try {
        logger.debug(`[DEBUG] Attempting to calculate dynamic sim amount for token: ${sdkTokenBorrowed?.symbol}`);
        amountInForSimulation = calculateDynamicSimAmount(swapPoolSDK, sdkTokenBorrowed);

        logger.debug(`[DEBUG] Result of calculateDynamicSimAmount:`, amountInForSimulation); // Log the object

        // More robust check: Ensure it's a CurrencyAmount and has quotient
        if (!(amountInForSimulation instanceof CurrencyAmount) || typeof amountInForSimulation.quotient === 'undefined') {
             // If calculateDynamicSimAmount returned null or invalid, it would have logged an error there.
             logger.warn(`[Simulator] calculateDynamicSimAmount did not return a valid CurrencyAmount object for ${sdkTokenBorrowed?.symbol}. Aborting simulation.`);
             return null;
        }
        logger.debug(`[DEBUG] Type of amountInForSimulation: ${Object.prototype.toString.call(amountInForSimulation)}`);
        logger.debug(`[DEBUG] amountInForSimulation instanceof CurrencyAmount: ${amountInForSimulation instanceof CurrencyAmount}`);

        // --- >>> THE CORE FIX AREA <<< ---
        simAmountRawFromQuotient = amountInForSimulation.quotient;
        logger.debug(`[DEBUG] Extracted simAmountRawFromQuotient: ${simAmountRawFromQuotient} (Raw Type: ${typeof simAmountRawFromQuotient})`);

        // **Explicit Conversion:** Handle if quotient is BigInt OR an object like ethers.BigNumber
        if (typeof simAmountRawFromQuotient === 'bigint') {
            simAmountBigInt = simAmountRawFromQuotient; // Already a BigInt, use directly
             logger.debug(`[DEBUG] simAmountRawFromQuotient is native BigInt.`);
        } else if (simAmountRawFromQuotient && typeof simAmountRawFromQuotient.toString === 'function') {
            try {
                simAmountBigInt = BigInt(simAmountRawFromQuotient.toString()); // Convert ethers.BigNumber/Object via string
                logger.debug(`[DEBUG] Converted simAmountRawFromQuotient object to BigInt.`);
            } catch (conversionError) {
                 logger.error(`[DEBUG] FAILED to convert simAmountRawFromQuotient to BigInt: ${conversionError.message}`);
                 throw new Error(`Could not convert amountInForSimulation.quotient to BigInt. Value: ${simAmountRawFromQuotient}`);
            }
        } else {
             // Throw error if it's neither BigInt nor an object with toString()
             throw new Error(`simAmountRawFromQuotient is not a BigInt and cannot be converted. Type: ${typeof simAmountRawFromQuotient}`);
        }
         logger.debug(`[DEBUG] Final simAmountBigInt: ${simAmountBigInt} (Type: ${typeof simAmountBigInt})`);
        // --- >>> END CORE FIX AREA <<< ---


        // --- Decimal and Symbol Extraction (with check again) ---
        decimalsToUse = sdkTokenBorrowed.decimals;
        logger.debug(`[DEBUG] Extracted decimalsToUse: ${decimalsToUse} (Type: ${typeof decimalsToUse})`);
        if (typeof decimalsToUse !== 'number') {
             // This check is technically redundant due to the check at the function start, but good for safety.
             throw new Error(`sdkTokenBorrowed.decimals is not a number! Got type: ${typeof decimalsToUse}. This should not happen.`);
        }

        symbolToUse = sdkTokenBorrowed.symbol ?? 'UnknownToken'; // Add fallback just in case
        logger.debug(`[DEBUG] Extracted symbolToUse: ${symbolToUse}`);

        // --- Formatting (Now should work) ---
        // Use the confirmed simAmountBigInt and decimalsToUse
        const formattedAmount = ethers.formatUnits(simAmountBigInt, decimalsToUse);
        logger.debug(`[DEBUG] Successfully formatted amount: ${formattedAmount}`);

        // Now proceed with the original log message
         logger.log(`[Simulator] Simulating: ${opportunity.groupName} | Start ${startPoolInfo.feeBps}bps -> Swap ${swapPoolInfo.feeBps}bps | Sim Input ${formattedAmount} ${symbolToUse}`);

    } catch (debugError) {
         logger.error(`[DEBUG] ERROR during pre-simulation checks or formatting: ${debugError.message}`);
         // Log the inputs to the failing function if possible
         logger.error(`[DEBUG] Inputs context: simAmountRawFromQuotient=${simAmountRawFromQuotient}, decimalsToUse=${decimalsToUse}`);
         handleError(debugError, `QuoteSimulator.PreSimulation (${opportunity?.groupName})`);
         return null; // Abort simulation
    }

    // --- Actual Simulation Logic (using simAmountBigInt) ---
    try {
        const flashFeePercent = BigInt(config.FLASH_LOAN_FEE_BPS);
        const flashFee = (borrowAmount * flashFeePercent) / 10000n;
        const requiredRepaymentAmount = borrowAmount + flashFee;

        // --- Swap 1 ---
        const trade1 = await simulateSingleTradeSDK(swapPoolSDK, sdkTokenBorrowed, sdkTokenIntermediate, amountInForSimulation); // amountInForSimulation is the CurrencyAmount object
        if (!trade1) { logger.log(`[Simulator] Simulation FAIL Swap 1 (${sdkTokenBorrowed.symbol}->${sdkTokenIntermediate.symbol} on ${swapPoolInfo.feeBps}bps pool).`); return null; }
        const amountOutSwap1 = trade1.outputAmount;
        if (!(amountOutSwap1 instanceof CurrencyAmount)) { logger.error('[Simulator] ERROR: amountOutSwap1 is not a CurrencyAmount!', amountOutSwap1); throw new ArbitrageError('Internal simulation error: Invalid type for amountOutSwap1.', 'SIMULATION_ERROR'); }

        // --- Swap 2 ---
        const amountInSwap2 = amountOutSwap1; // This is a CurrencyAmount
        const trade2 = await simulateSingleTradeSDK(swapPoolSDK, sdkTokenIntermediate, sdkTokenBorrowed, amountInSwap2);
        if (!trade2) { logger.log(`[Simulator] Simulation FAIL Swap 2 (${sdkTokenIntermediate.symbol}->${sdkTokenBorrowed.symbol} on ${swapPoolInfo.feeBps}bps pool).`); return null; }
        const amountOutSwap2_Sim = trade2.outputAmount;
         if (!(amountOutSwap2_Sim instanceof CurrencyAmount)) { logger.error('[Simulator] ERROR: amountOutSwap2_Sim is not a CurrencyAmount!', amountOutSwap2_Sim); throw new ArbitrageError('Internal simulation error: Invalid type for amountOutSwap2_Sim.', 'SIMULATION_ERROR'); }
        const finalAmountReceived_Sim_Raw = amountOutSwap2_Sim.quotient; // This should be BigInt

        // --- Extrapolation & Profit ---
         logger.debug("[Simulator] ---> Calculating Estimated Profit...");
         let finalAmountReceived_Actual_Estimated = 0n;

         // ** CRITICAL: Use simAmountBigInt for extrapolation calculation **
         if (simAmountBigInt > 0n && typeof finalAmountReceived_Sim_Raw === 'bigint') {
             finalAmountReceived_Actual_Estimated = (finalAmountReceived_Sim_Raw * borrowAmount) / simAmountBigInt; // Use the confirmed BigInt
         } else {
             logger.error(`[Simulator] ERROR: Cannot calculate estimated profit. simAmountBigInt=${simAmountBigInt} (Type: ${typeof simAmountBigInt}), finalAmountReceived_Sim_Raw=${finalAmountReceived_Sim_Raw} (Type: ${typeof finalAmountReceived_Sim_Raw})`);
             throw new ArbitrageError('Internal simulation error: Invalid inputs for profit extrapolation.', 'SIMULATION_ERROR');
         }

         logger.log(`[Simulator] Est. Final Amount Received (for actual borrow): ${ethers.formatUnits(finalAmountReceived_Actual_Estimated, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`);
         logger.log(`[Simulator] Required Repayment (for actual borrow): ${ethers.formatUnits(requiredRepaymentAmount, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`); // Log repayment for comparison

        if (finalAmountReceived_Actual_Estimated <= requiredRepaymentAmount) { logger.log(`[Simulator] Gross Profit Check FAIL. Est. Final Amount <= Required Repayment.`); return null; }
        const grossProfit = finalAmountReceived_Actual_Estimated - requiredRepaymentAmount;
        logger.log(`[Simulator] Est. Gross Profit Found: ${ethers.formatUnits(grossProfit, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`);

        // Return results
        return { finalAmountReceived: finalAmountReceived_Actual_Estimated, requiredRepayment: requiredRepaymentAmount, grossProfit: grossProfit, simulatedAmountIn: simAmountBigInt, trade1: trade1, trade2: trade2 }; // Return the BigInt sim amount

    } catch (error) {
         if (error instanceof ArbitrageError && error.type === 'SIMULATION_ERROR') { handleError(error, `QuoteSimulator.Calculation (${opportunity.groupName})`);
         } else if (error.code !== 'INVALID_ARGUMENT') { handleError(error, `QuoteSimulator.simulateArbitrage (${opportunity.groupName})`); }
        logger.error(`[Simulator] Error during simulation calculation for group ${opportunity.groupName}: ${error.message}`);
        return null;
    }
}
// --- End REPLACEMENT FUNCTION ---


// --- (Keep existing getMinimumAmountOut function) ---
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
