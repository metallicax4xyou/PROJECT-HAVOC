// core/quoteSimulator.js
const { ethers } = require('ethers');
const { CurrencyAmount, TradeType, Percent, Token } = require('@uniswap/sdk-core');
const { Pool, Route, Trade } = require('@uniswap/v3-sdk');
const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler');
const config = require('../config/index.js'); // Load config for FLASH_LOAN_FEE_BPS etc.

// --- Helper: Simulate a single swap using Uniswap V3 SDK ---
async function simulateSingleTrade(
    poolForTrade, // Uniswap SDK Pool object for the swap
    tokenIn,      // SDK Token object for input token
    tokenOut,     // SDK Token object for output token
    amountIn      // Amount of tokenIn (as CurrencyAmount)
) {
    if (!amountIn || amountIn.quotient === 0n) {
         logger.debug(`[Simulator SDK] Cannot simulate with zero input amount.`);
         return null;
    }
    try {
        const route = new Route([poolForTrade], tokenIn, tokenOut);
        const trade = await Trade.fromRoute(route, amountIn, TradeType.EXACT_INPUT);
        return trade;
    } catch (error) {
        // Log specific SDK errors if helpful
        if (error.message.includes('liquidity') || error.message.includes('SPL')) {
            // logger.debug(`[Simulator SDK] Trade simulation failed (${tokenIn.symbol} -> ${tokenOut.symbol}): ${error.message}`);
        } else {
            handleError(error, `simulateSingleTrade (${tokenIn.symbol} -> ${tokenOut.symbol})`);
            logger.warn(`[Simulator SDK] Unexpected SDK Error simulating trade (${tokenIn.symbol} -> ${tokenOut.symbol}): ${error.message}`);
        }
        return null; // Indicate simulation failure
    }
}

/**
 * Calculates a dynamic simulation amount based on a percentage of the pool's liquidity.
 * Aims for a small percentage to minimize impact on simulation results while being feasible.
 * @param {Pool} poolSDK The Uniswap SDK Pool object (usually the swapPool).
 * @param {Token} tokenIn The SDK Token object for the input token (the one borrowed).
 * @param {number} percentageOfLiquidity The percentage (e.g., 1 for 1%) to use.
 * @returns {CurrencyAmount|null} The calculated amount as CurrencyAmount or null.
 */
function calculateDynamicSimAmount(poolSDK, tokenIn, percentageOfLiquidity = 0.5) {
     // V3 liquidity is complex. A simple proxy is sqrtPrice * liquidity value, but that's not reserves.
     // A safer approach for simulation might be to use a very small fixed amount first,
     // or derive amount based on a small desired output.
     // Let's try a different approach: Simulate based on a *small fraction* of the configured *borrowAmount*.
     // This avoids needing reserves and tests if *even a small part* of the intended trade works.

     const configuredBorrowAmount = config.BORROW_AMOUNTS_WEI[tokenIn.symbol];
     if (!configuredBorrowAmount || configuredBorrowAmount === 0n) {
          logger.warn(`[Simulator] Configured borrow amount for ${tokenIn.symbol} is zero or missing.`);
          return null;
     }

     // Simulate with a small fraction (e.g., 1/100th) of the configured borrow amount
     const fraction = 100n; // Simulate with 1% of the configured amount
     const simAmountRaw = configuredBorrowAmount / fraction;

     if (simAmountRaw === 0n) {
          logger.warn(`[Simulator] Calculated simulation amount is zero for ${tokenIn.symbol}. Using a minimal unit.`);
          // Use the smallest possible unit of the token if calculation resulted in zero
          return CurrencyAmount.fromRawAmount(tokenIn, 1n);
     }

     // logger.debug(`[Simulator] Using dynamic sim amount: ${ethers.formatUnits(simAmountRaw, tokenIn.decimals)} ${tokenIn.symbol} (1/${fraction.toString()} of configured borrow)`);
     return CurrencyAmount.fromRawAmount(tokenIn, simAmountRaw.toString());
}

/**
 * Simulates the arbitrage opportunity using Uniswap SDK Trades to account for slippage.
 * Uses a dynamically calculated small amount for simulation based on configured borrow amount.
 * @param {object} opportunity The opportunity object from PoolScanner.
 * @returns {Promise<object|null>} Returns an object with simulation results { finalAmountReceived, requiredRepayment, grossProfit, trade1, trade2, simulatedAmountIn } or null if simulation fails.
 */
async function simulateArbitrage(opportunity) {
    // ... (previous null checks for opportunity data) ...
     if (!opportunity || !opportunity.swapPoolInfo?.sdkPool || !opportunity.sdkTokenBorrowed || !opportunity.sdkTokenIntermediate || !opportunity.borrowAmount) {
         logger.warn('[Simulator] Invalid opportunity object received for simulation.', opportunity);
         return null;
     }

    const {
        startPoolInfo,
        swapPoolInfo,
        sdkTokenBorrowed,
        sdkTokenIntermediate,
        borrowAmount // The *actual* amount we intend to borrow/flash loan
    } = opportunity;

    const swapPoolSDK = swapPoolInfo.sdkPool;

    // +++ Calculate Dynamic Simulation Amount +++
    // Simulate with a small fraction of the intended borrow amount
    const amountInForSimulation = calculateDynamicSimAmount(swapPoolSDK, sdkTokenBorrowed);
    if (!amountInForSimulation) {
         logger.warn(`[Simulator] Failed to calculate simulation amount for ${sdkTokenBorrowed.symbol}. Aborting simulation.`);
         return null;
    }
    const simAmountRaw = amountInForSimulation.quotient; // Get the raw BigInt amount used for simulation
    logger.log(`[Simulator] Simulating: ${opportunity.groupName} | Start ${startPoolInfo.feeBps}bps -> Swap ${swapPoolInfo.feeBps}bps | Sim Input ${ethers.formatUnits(simAmountRaw, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`);
    // +++ End Calculation +++

    try {
        // 1. Calculate Required Repayment (for the *actual* borrowAmount)
        const flashFeePercent = BigInt(config.FLASH_LOAN_FEE_BPS);
        const flashFee = (borrowAmount * flashFeePercent) / 10000n;
        const requiredRepaymentAmount = borrowAmount + flashFee;
        logger.debug(`[Simulator] Actual Intended Borrow: ${ethers.formatUnits(borrowAmount, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`);
        logger.debug(`[Simulator] Required Repayment (for actual borrow): ${ethers.formatUnits(requiredRepaymentAmount, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`);

        // 2. Simulate Swap 1 (using the small dynamic amount)
        const trade1 = await simulateSingleTrade(swapPoolSDK, sdkTokenBorrowed, sdkTokenIntermediate, amountInForSimulation);
        if (!trade1) {
            logger.log(`[Simulator] Simulation FAIL Swap 1 (${sdkTokenBorrowed.symbol}->${sdkTokenIntermediate.symbol} on ${swapPoolInfo.feeBps}bps pool).`);
            return null;
        }
        const amountOutSwap1 = trade1.outputAmount;
        logger.debug(`[Simulator] Sim Swap 1 OK: Input ${amountInForSimulation.toSignificant(6)} ${sdkTokenBorrowed.symbol} -> Output ${amountOutSwap1.toSignificant(6)} ${sdkTokenIntermediate.symbol}`);

        // 3. Simulate Swap 2 (using output of Swap 1)
        const amountInSwap2 = amountOutSwap1;
        const trade2 = await simulateSingleTrade(swapPoolSDK, sdkTokenIntermediate, sdkTokenBorrowed, amountInSwap2);
        if (!trade2) {
            logger.log(`[Simulator] Simulation FAIL Swap 2 (${sdkTokenIntermediate.symbol}->${sdkTokenBorrowed.symbol} on ${swapPoolInfo.feeBps}bps pool).`);
            return null;
        }
        const amountOutSwap2_Sim = trade2.outputAmount; // Final amount of borrowToken from SIMULATION (CurrencyAmount)
        const finalAmountReceived_Sim_Raw = amountOutSwap2_Sim.quotient; // Final amount from SIMULATION (BigInt)
        logger.debug(`[Simulator] Sim Swap 2 OK: Input ${amountInSwap2.toSignificant(6)} ${sdkTokenIntermediate.symbol} -> Output ${amountOutSwap2_Sim.toSignificant(6)} ${sdkTokenBorrowed.symbol}`);

        // 4. Estimate Final Amount for Actual Borrow Amount (Extrapolation - Less Accurate but Necessary)
        // We simulate small, but need profit estimate for the large amount.
        // Simple linear scaling: (SimOutput / SimInput) * ActualInput
        // WARNING: This ignores slippage differences between small and large amounts!
        let finalAmountReceived_Actual_Estimated = 0n;
        if (simAmountRaw > 0n) {
             finalAmountReceived_Actual_Estimated = (finalAmountReceived_Sim_Raw * borrowAmount) / simAmountRaw;
        }
        logger.log(`[Simulator] Est. Final Amount Received (for actual borrow): ${ethers.formatUnits(finalAmountReceived_Actual_Estimated, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`);


        // 5. Calculate Estimated Gross Profit (for the ACTUAL borrow amount)
        if (finalAmountReceived_Actual_Estimated <= requiredRepaymentAmount) {
            logger.log(`[Simulator] Gross Profit Check FAIL. Est. Final Amount <= Required Repayment.`);
            return null; // Not profitable even before gas
        }
        const grossProfit = finalAmountReceived_Actual_Estimated - requiredRepaymentAmount;
        logger.log(`[Simulator] Est. Gross Profit Found: ${ethers.formatUnits(grossProfit, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`);

        // Return detailed simulation results
        return {
            // Amounts related to the actual intended trade size
            finalAmountReceived: finalAmountReceived_Actual_Estimated, // BigInt (Estimated for actual borrow amount)
            requiredRepayment: requiredRepaymentAmount,           // BigInt (For actual borrow amount)
            grossProfit: grossProfit,                             // BigInt (For actual borrow amount)
             // Include the amount used for the simulation itself for reference
            simulatedAmountIn: simAmountRaw,                      // BigInt
            // SDK Trade objects from the small simulation (needed for min amounts calculation)
            trade1: trade1,
            trade2: trade2,
        };

    } catch (error) {
        handleError(error, `QuoteSimulator.simulateArbitrage (${opportunity.groupName})`);
        logger.error(`[Simulator] Unexpected error during simulation for group ${opportunity.groupName}: ${error.message}`);
        return null; // Indicate failure
    }
}

// getMinimumAmountOut function remains the same
function getMinimumAmountOut(trade, slippageToleranceBps) {
    if (!trade) return 0n;
    const slippageTolerance = new Percent(slippageToleranceBps, 10000); // Create Percent object
    const amountOut = trade.minimumAmountOut(slippageTolerance);
    return amountOut.quotient; // Return as BigInt
}

module.exports = {
    simulateArbitrage,
    getMinimumAmountOut,
};
