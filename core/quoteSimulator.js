// /workspaces/arbitrum-flash/core/quoteSimulator.js

const { Pool, Route, Trade } = require('@uniswap/v3-sdk');
const { Token, CurrencyAmount, TradeType, Percent } = require('@uniswap/sdk-core'); // Added Percent
const { ethers } = require('ethers');
const logger = require('../utils/logger');
const ErrorHandler = require('../utils/errorHandler');

// Helper to safely stringify for logging
function safeStringify(obj, indent = 2) {
    try { return JSON.stringify(obj, (_, value) => typeof value === 'bigint' ? value.toString() : value, indent); }
    catch (e) { return "[Unstringifiable Object]"; }
}

// --- Minimal Tick Data Provider Stub ---
const simpleTickProvider = {
    getTick: async (tick) => {
        return Promise.resolve({ liquidityNet: 0n, liquidityGross: 0n });
    },
    nextInitializedTickWithinOneWord: async (tick, lte, tickSpacing) => {
        return Promise.resolve([tick, false]);
    }
};
// --- END Tick Provider Stub ---

/**
 * Simulates a single swap using Uniswap V3 SDK based on live pool state.
 */
const simulateSingleSwapExactIn = async (poolState, tokenIn, tokenOut, amountIn) => {
    const log = logger || console;
    const context = `SimSwap ${tokenIn?.symbol}->${tokenOut?.symbol} (${poolState?.address}, ${poolState?.fee}bps)`;

    // Input Validation
    if (!poolState || typeof poolState.sqrtPriceX96 === 'undefined' /* ... etc ... */ ) {
        log.error(`[${context}] Invalid or incomplete pool state provided.`); return null;
    }
    if (!tokenIn || !(tokenIn instanceof Token) || !tokenOut || !(tokenOut instanceof Token)) {
        log.error(`[${context}] Invalid tokenIn or tokenOut provided.`); return null;
    }
    if (typeof amountIn !== 'bigint' || amountIn <= 0n) {
        return { amountOut: 0n, sdkTokenIn: tokenIn, sdkTokenOut: tokenOut };
    }

    try {
        // Sort tokens for Pool constructor
        const [tokenA, tokenB] = tokenIn.sortsBefore(tokenOut) ? [tokenIn, tokenOut] : [tokenOut, tokenIn];

        const pool = new Pool(
            tokenA, tokenB, poolState.fee,
            poolState.sqrtPriceX96.toString(),
            poolState.liquidity.toString(),
            poolState.tick,
            simpleTickProvider // Pass stub provider
        );

        const swapRoute = new Route([pool], tokenIn, tokenOut);
        if (!swapRoute.pools || swapRoute.pools.length === 0) {
            log.warn(`[${context}] No valid pool found in route by SDK.`); return null;
        }

        const trade = await Trade.fromRoute(
            swapRoute,
            CurrencyAmount.fromRawAmount(tokenIn, amountIn.toString()),
            TradeType.EXACT_INPUT
        );

        const amountOutBI = BigInt(trade.outputAmount.quotient.toString());

        return {
             amountOut: amountOutBI,
             sdkTokenIn: tokenIn,
             sdkTokenOut: tokenOut,
             // Optionally return trade object for more details later
             trade: trade
         };

    } catch (error) {
        // Only log specific simulation errors here, let simulateArbitrage handle broader context
        // Avoid calling ErrorHandler here if it's called upstream in simulateArbitrage
        log.error(`[${context}] Sim Error: ${error.message}`);
        // log.error(`[${context}] Pool State:`, { fee: poolState.fee, tick: poolState.tick, liq: poolState.liquidity.toString(), sqrtP: poolState.sqrtPriceX96.toString() });
        return null; // Indicate simulation failure
    }
};


/**
 * Simulates a two-hop arbitrage opportunity (Token0 -> Token1 -> Token0).
 */
const simulateArbitrage = async (opportunity, initialAmountToken0) => {
    const log = logger || console;

    // Input Validation
     if (!opportunity || !opportunity.token0 || !opportunity.token1 || !opportunity.poolHop1 || !opportunity.poolHop2 || !opportunity.group) {
         log.error("[SimArb FATAL] Invalid opportunity structure.", safeStringify(opportunity));
         return { profitable: false, error: "Invalid opportunity structure", grossProfit: -1n, initialAmountToken0, finalAmountToken0: 0n, amountToken1Received: 0n };
     }

    const { poolHop1, poolHop2, token0, token1, group } = opportunity;
    const logPrefix = `SimArb ${group} (${poolHop1.fee}bps->${poolHop2.fee}bps)`;
    const initialAmountFormatted = ethers.formatUnits(initialAmountToken0, token0.decimals); // Format for logging

    log.debug(`[${logPrefix}] Starting Simulation. Initial Amount: ${initialAmountFormatted} ${token0.symbol}`);

    try {
        // --- Simulate Hop 1 ---
        const hop1Result = await simulateSingleSwapExactIn(poolHop1, token0, token1, initialAmountToken0);
        if (!hop1Result || typeof hop1Result.amountOut === 'undefined') {
             log.warn(`[${logPrefix}] Hop 1 simulation failed.`);
             return { profitable: false, initialAmountToken0, finalAmountToken0: 0n, amountToken1Received: 0n, grossProfit: -1n, error: 'Hop 1 simulation failed internally', details: { hop1Result } };
        }
        const amountToken1Received = hop1Result.amountOut;
        if (amountToken1Received <= 0n) {
             log.warn(`[${logPrefix}] Hop 1 resulted in 0 output.`);
             return { profitable: false, initialAmountToken0, finalAmountToken0: 0n, amountToken1Received: 0n, grossProfit: -1n, error: 'Hop 1 simulation resulted in zero output', details: { hop1Result } };
        }
         const amountHop1Formatted = ethers.formatUnits(amountToken1Received, token1.decimals);
         log.debug(`[${logPrefix}] Hop 1 OK: Received ${amountHop1Formatted} ${token1.symbol}`);


        // --- Simulate Hop 2 ---
        const hop2Result = await simulateSingleSwapExactIn(poolHop2, token1, token0, amountToken1Received);
        if (!hop2Result || typeof hop2Result.amountOut === 'undefined') {
             log.warn(`[${logPrefix}] Hop 2 simulation failed.`);
             return { profitable: false, initialAmountToken0, finalAmountToken0: 0n, amountToken1Received, grossProfit: -1n, error: 'Hop 2 simulation failed internally', details: { hop1Result, hop2Result } };
        }
        const finalAmountToken0 = hop2Result.amountOut;
        const finalAmountFormatted = ethers.formatUnits(finalAmountToken0, token0.decimals);
         log.debug(`[${logPrefix}] Hop 2 OK: Received ${finalAmountFormatted} ${token0.symbol}`);

        // --- Calculate Profit ---
        const grossProfit = finalAmountToken0 - initialAmountToken0;
        const profitable = grossProfit > 0n;
        const grossProfitFormatted = ethers.formatUnits(grossProfit, token0.decimals);

        // --- ADDED DETAILED LOGGING ---
        log.info(
            `[${logPrefix}] Simulation Result: ` +
            `Start=${initialAmountFormatted} ${token0.symbol}, ` +
            `Hop1Out=${amountHop1Formatted} ${token1.symbol}, ` +
            `End=${finalAmountFormatted} ${token0.symbol}. ` +
            `Gross Profit=${grossProfitFormatted} ${token0.symbol} (${profitable ? 'PROFITABLE' : 'NOT PROFITABLE'})`
        );
        // --- END LOGGING ---

        return {
            profitable, initialAmountToken0, finalAmountToken0, amountToken1Received, grossProfit, error: null,
            details: { group, token0Symbol: token0.symbol, token1Symbol: token1.symbol, hop1Pool: poolHop1.address, hop2Pool: poolHop2.address, hop1Fee: poolHop1.fee, hop2Fee: poolHop2.fee }
        };

    } catch (error) {
        log.error(`[${logPrefix}] UNEXPECTED High-Level Error: ${error.message}`);
        if (ErrorHandler && typeof ErrorHandler.handleError === 'function') { ErrorHandler.handleError(error, logPrefix, { initialAmount: initialAmountToken0.toString() }); }
        return { profitable: false, initialAmountToken0, finalAmountToken0: 0n, amountToken1Received: 0n, grossProfit: -1n, error: `Unexpected simulation error: ${error.message}` };
    }
};

module.exports = { simulateArbitrage };
