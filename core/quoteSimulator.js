// core/quoteSimulator.js
const { ethers } = require('ethers');
const { CurrencyAmount, TradeType, Percent } = require('@uniswap/sdk-core');
const { Route, Trade } = require('@uniswap/v3-sdk');
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
    try {
        // Create a route using the single pool
        const route = new Route([poolForTrade], tokenIn, tokenOut);
        // Create a trade object for an exact input trade
        // This automatically calculates output amount considering slippage based on pool state
        const trade = await Trade.fromRoute(route, amountIn, TradeType.EXACT_INPUT);
        return trade; // Returns the SDK Trade object which includes input/output amounts, paths etc.
    } catch (error) {
        // Catch SDK errors (e.g., insufficient liquidity)
        // logger.debug(`[Simulator] SDK Error simulating trade (${tokenIn.symbol} -> ${tokenOut.symbol}): ${error.message}`);
        return null; // Indicate simulation failure
    }
}

/**
 * Simulates the arbitrage opportunity using Uniswap SDK Trades to account for slippage.
 * Calculates gross profit based on the simulated amounts.
 * @param {object} opportunity The opportunity object from PoolScanner.
 *                   Requires: { startPoolInfo, swapPoolInfo, sdkTokenBorrowed, sdkTokenIntermediate, borrowAmount }
 * @returns {Promise<object|null>} Returns an object with simulation results { finalAmountReceived, requiredRepayment, grossProfit, trade1, trade2 } or null if simulation fails.
 */
async function simulateArbitrage(opportunity) {
    if (!opportunity || !opportunity.swapPoolInfo?.sdkPool || !opportunity.sdkTokenBorrowed || !opportunity.sdkTokenIntermediate || !opportunity.borrowAmount) {
        logger.warn('[Simulator] Invalid opportunity object received for simulation.', opportunity);
        return null;
    }

    const {
        startPoolInfo,          // Pool where loan originates
        swapPoolInfo,           // Pool where swaps happen (contains the live sdkPool object for simulation)
        sdkTokenBorrowed,
        sdkTokenIntermediate,
        borrowAmount            // As BigInt
    } = opportunity;

    const swapPoolSDK = swapPoolInfo.sdkPool; // The live SDK Pool object for the swap pool

    logger.log(`[Simulator] Simulating: ${opportunity.groupName} | Start ${startPoolInfo.feeBps}bps -> Swap ${swapPoolInfo.feeBps}bps | Borrow ${ethers.formatUnits(borrowAmount, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`);

    try {
        // 1. Calculate Required Repayment (including flash loan fee)
        // Flash loan fee is typically charged by the START pool, not the swap pool fee
        const flashFeePercent = BigInt(config.FLASH_LOAN_FEE_BPS); // e.g., 9 for 0.09%
        const flashFee = (borrowAmount * flashFeePercent) / 10000n;
        const requiredRepaymentAmount = borrowAmount + flashFee;
        logger.debug(`[Simulator] Required Repayment (incl. flash fee): ${ethers.formatUnits(requiredRepaymentAmount, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`);


        // 2. Simulate Swap 1: Borrowed Token -> Intermediate Token on Swap Pool
        const amountInSwap1 = CurrencyAmount.fromRawAmount(sdkTokenBorrowed, borrowAmount.toString());
        const trade1 = await simulateSingleTrade(swapPoolSDK, sdkTokenBorrowed, sdkTokenIntermediate, amountInSwap1);

        if (!trade1) {
            logger.log(`[Simulator] Simulation FAIL Swap 1 (${sdkTokenBorrowed.symbol}->${sdkTokenIntermediate.symbol} on ${swapPoolInfo.feeBps}bps pool). Likely insufficient liquidity.`);
            return null;
        }
        const amountOutSwap1 = trade1.outputAmount; // Amount of intermediateToken received (CurrencyAmount)
        logger.debug(`[Simulator] Sim Swap 1 OK: Input ${amountInSwap1.toSignificant(6)} ${sdkTokenBorrowed.symbol} -> Output ${amountOutSwap1.toSignificant(6)} ${sdkTokenIntermediate.symbol}`);


        // 3. Simulate Swap 2: Intermediate Token -> Borrowed Token on Swap Pool
        // Input for Swap 2 is the exact output amount from Swap 1
        const amountInSwap2 = amountOutSwap1;
        const trade2 = await simulateSingleTrade(swapPoolSDK, sdkTokenIntermediate, sdkTokenBorrowed, amountInSwap2);

        if (!trade2) {
            logger.log(`[Simulator] Simulation FAIL Swap 2 (${sdkTokenIntermediate.symbol}->${sdkTokenBorrowed.symbol} on ${swapPoolInfo.feeBps}bps pool). Likely insufficient liquidity.`);
            return null;
        }
        const amountOutSwap2 = trade2.outputAmount; // Final amount of borrowToken received (CurrencyAmount)
        const finalAmountReceived = BigInt(amountOutSwap2.quotient.toString()); // Convert back to BigInt for comparison
        logger.debug(`[Simulator] Sim Swap 2 OK: Input ${amountInSwap2.toSignificant(6)} ${sdkTokenIntermediate.symbol} -> Output ${amountOutSwap2.toSignificant(6)} ${sdkTokenBorrowed.symbol}`);


        // 4. Calculate Gross Profit
        logger.log(`[Simulator] Final Amount Received: ${ethers.formatUnits(finalAmountReceived, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`);
        if (finalAmountReceived <= requiredRepaymentAmount) {
            logger.log(`[Simulator] Gross Profit Check FAIL. Final Amount <= Required Repayment.`);
            return null; // Not profitable even before gas
        }
        const grossProfit = finalAmountReceived - requiredRepaymentAmount;
        logger.log(`[Simulator] Gross Profit Found: ${ethers.formatUnits(grossProfit, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`);

        // Return detailed simulation results
        return {
            finalAmountReceived: finalAmountReceived, // BigInt
            requiredRepayment: requiredRepaymentAmount, // BigInt
            grossProfit: grossProfit, // BigInt
            trade1: trade1, // Keep SDK Trade object for potential later use (min amounts)
            trade2: trade2, // Keep SDK Trade object
        };

    } catch (error) {
        handleError(error, `QuoteSimulator.simulateArbitrage (${opportunity.groupName})`);
        logger.error(`[Simulator] Unexpected error during simulation for group ${opportunity.groupName}: ${error.message}`);
        return null; // Indicate failure
    }
}


/**
 * Calculates the minimum output amounts for slippage protection based on SDK trades.
 * @param {Trade} trade The Uniswap SDK Trade object.
 * @param {number} slippageToleranceBps Slippage tolerance in basis points (e.g., 10 for 0.1%).
 * @returns {bigint} The minimum output amount as a BigInt.
 */
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
