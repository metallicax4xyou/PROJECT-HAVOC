// /workspaces/arbitrum-flash/core/quoteSimulator.js

const { Pool, Route, Trade } = require('@uniswap/v3-sdk');
const { Token, CurrencyAmount, TradeType, Percent } = require('@uniswap/sdk-core');
const { ethers } = require('ethers');
const logger = require('../utils/logger'); // Assuming logger utility
const ErrorHandler = require('../utils/errorHandler'); // Assuming error handler utility

// Helper to safely stringify for logging
function safeStringify(obj, indent = 2) {
    try { return JSON.stringify(obj, (_, value) => typeof value === 'bigint' ? value.toString() : value, indent); }
    catch (e) { return "[Unstringifiable Object]"; }
}

// Minimal Tick Data Provider Stub
const simpleTickProvider = {
    getTick: async (tick) => Promise.resolve({ liquidityNet: 0n, liquidityGross: 0n }),
    nextInitializedTickWithinOneWord: async (tick, lte, tickSpacing) => Promise.resolve([tick, false])
};

/**
 * Simulates a single swap using Uniswap V3 SDK based on live pool state.
 */
const simulateSingleSwapExactIn = async (poolState, tokenIn, tokenOut, amountIn) => {
    const log = logger || console; // Define log for this scope
    const context = `SimSwap ${tokenIn?.symbol}->${tokenOut?.symbol} (${poolState?.address}, ${poolState?.fee}bps)`;

    // Input Validation
    if (!poolState || !tokenIn || !tokenOut /* ... etc ... */) { /* ... */ return null; }
    if (amountIn <= 0n) { return { amountOut: 0n, /* ... */ }; }

    try {
        let tokenA, tokenB;
        if (tokenIn.sortsBefore(tokenOut)) {
            tokenA = tokenIn; tokenB = tokenOut;
            // log.debug(`[${context}] Token Order Check: Input ${tokenIn.symbol} is tokenA.`);
        } else {
            tokenA = tokenOut; tokenB = tokenIn;
            // log.debug(`[${context}] Token Order Check: Input ${tokenIn.symbol} is tokenB (Reversed: ${tokenA.symbol}/${tokenB.symbol}).`);
        }

        const pool = new Pool(
            tokenA, tokenB, poolState.fee,
            poolState.sqrtPriceX96.toString(),
            poolState.liquidity.toString(),
            poolState.tick,
            simpleTickProvider
        );

        const swapRoute = new Route([pool], tokenIn, tokenOut);
        if (!swapRoute.pools || swapRoute.pools.length === 0) {
            log.warn(`[${context}] No valid pool in route by SDK.`); return null;
        }

        const trade = await Trade.fromRoute(
            swapRoute,
            CurrencyAmount.fromRawAmount(tokenIn, amountIn.toString()),
            TradeType.EXACT_INPUT
        );
        const amountOutBI = BigInt(trade.outputAmount.quotient.toString());
        return { amountOut: amountOutBI, sdkTokenIn: tokenIn, sdkTokenOut: tokenOut, trade: trade };

    } catch (error) {
        log.error(`[${context}] Sim Error: ${error.message}`);
        return null;
    }
};


/**
 * Simulates a two-hop arbitrage opportunity (Token0 -> Token1 -> Token0).
 */
const simulateArbitrage = async (opportunity, initialAmountToken0) => {
    // --- FIX: Define log variable for this function's scope ---
    const log = logger || console;
    // --- END FIX ---

    // Input Validation
     if (!opportunity || !opportunity.token0 || !opportunity.token1 || !opportunity.poolHop1 || !opportunity.poolHop2 || !opportunity.group) {
         log.error("[SimArb FATAL] Invalid opportunity structure.", safeStringify(opportunity));
         return { profitable: false, error: "Invalid opportunity structure", grossProfit: -1n, initialAmountToken0, finalAmountToken0: 0n, amountToken1Received: 0n };
     }

    const { poolHop1, poolHop2, token0, token1, group } = opportunity;
    const logPrefix = `SimArb ${group} (${poolHop1.fee}bps->${poolHop2.fee}bps)`;
    const initialAmountFormatted = ethers.formatUnits(initialAmountToken0, token0.decimals);

    // Logging Start
    log.info(`--- Simulation Start (${logPrefix}) ---`);
    log.info(`[SIM] Borrow Amount: ${initialAmountFormatted} ${token0.symbol}`);
    log.info(`[SIM] Path: Pool1 (${poolHop1.address} / ${poolHop1.fee}bps) -> Pool2 (${poolHop2.address} / ${poolHop2.fee}bps)`);

    try {
        // --- Simulate Hop 1 ---
        const hop1Result = await simulateSingleSwapExactIn(poolHop1, token0, token1, initialAmountToken0);
        if (!hop1Result || typeof hop1Result.amountOut === 'undefined') {
             log.warn(`[${logPrefix}] Hop 1 simulation failed.`);
             log.info(`--- Simulation END (${logPrefix}) - FAILED (Hop 1 Sim) ---`);
             return { profitable: false, error: 'Hop 1 simulation failed internally', initialAmountToken0, finalAmountToken0: 0n, amountToken1Received: 0n, grossProfit: -1n };
        }
        const amountToken1Received = hop1Result.amountOut;
        const amountHop1Formatted = ethers.formatUnits(amountToken1Received, token1.decimals);
        const hop1FeePercent = new Percent(poolHop1.fee, 1_000_000);
        const priceImpactHop1 = hop1Result.trade?.priceImpact?.toSignificant(3) || 'N/A';

        log.info(`[SIM] Hop 1 (${token0.symbol} -> ${token1.symbol} @ ${poolHop1.fee}bps):`);
        log.info(`    - Input:  ${initialAmountFormatted} ${token0.symbol}`);
        log.info(`    - Output: ${amountHop1Formatted} ${token1.symbol}`);
        log.info(`    - Fee Tier: ${hop1FeePercent.toFixed(3)}%`);
        log.info(`    - Price Impact: ~${priceImpactHop1}%`);

        if (amountToken1Received <= 0n) {
             log.warn(`[${logPrefix}] Hop 1 resulted in 0 output.`);
             log.info(`--- Simulation END (${logPrefix}) - FAILED (Zero Output Hop 1) ---`);
             return { profitable: false, error: 'Hop 1 simulation resulted in zero output', initialAmountToken0, finalAmountToken0: 0n, amountToken1Received: 0n, grossProfit: -1n };
        }

        // --- Simulate Hop 2 ---
        const hop2Result = await simulateSingleSwapExactIn(poolHop2, token1, token0, amountToken1Received);
        if (!hop2Result || typeof hop2Result.amountOut === 'undefined') {
             log.warn(`[${logPrefix}] Hop 2 simulation failed.`);
             log.info(`--- Simulation END (${logPrefix}) - FAILED (Hop 2 Sim) ---`);
             return { profitable: false, error: 'Hop 2 simulation failed internally', initialAmountToken0, finalAmountToken0: 0n, amountToken1Received, grossProfit: -1n };
        }
        const finalAmountToken0 = hop2Result.amountOut;
        const finalAmountFormatted = ethers.formatUnits(finalAmountToken0, token0.decimals);
        const hop2FeePercent = new Percent(poolHop2.fee, 1_000_000);
        const priceImpactHop2 = hop2Result.trade?.priceImpact?.toSignificant(3) || 'N/A';

        log.info(`[SIM] Hop 2 (${token1.symbol} -> ${token0.symbol} @ ${poolHop2.fee}bps):`);
        log.info(`    - Input:  ${amountHop1Formatted} ${token1.symbol}`);
        log.info(`    - Output: ${finalAmountFormatted} ${token0.symbol}`);
        log.info(`    - Fee Tier: ${hop2FeePercent.toFixed(3)}%`);
        log.info(`    - Price Impact: ~${priceImpactHop2}%`);

        // --- Calculate & Log Profit ---
        const grossProfit = finalAmountToken0 - initialAmountToken0;
        const profitable = grossProfit > 0n;
        const grossProfitFormatted = ethers.formatUnits(grossProfit, token0.decimals);

        log.info(`[SIM] Gross Profit: ${grossProfitFormatted} ${token0.symbol}`);
        log.info(`[SIM] Trade Profitable (Gross): ${profitable ? 'YES' : 'NO'}`);
        log.info(`--- Simulation END (${logPrefix}) ---`);

        return {
            profitable, initialAmountToken0, finalAmountToken0, amountToken1Received, grossProfit, error: null,
            details: { group, token0Symbol: token0.symbol, token1Symbol: token1.symbol, hop1Pool: poolHop1.address, hop2Pool: poolHop2.address, hop1Fee: poolHop1.fee, hop2Fee: poolHop2.fee }
        };

    } catch (error) {
        // Use the defined log variable
        log.error(`[${logPrefix}] UNEXPECTED High-Level Error: ${error.message}`);
        if (ErrorHandler && typeof ErrorHandler.handleError === 'function') { ErrorHandler.handleError(error, logPrefix); }
        log.info(`--- Simulation END (${logPrefix}) - FAILED (Unexpected) ---`);
        return { profitable: false, error: `Unexpected simulation error: ${error.message}`, initialAmountToken0, finalAmountToken0: 0n, amountToken1Received: 0n, grossProfit: -1n };
    }
};

module.exports = { simulateArbitrage };
