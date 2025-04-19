// /workspaces/arbitrum-flash/core/quoteSimulator.js

const { Pool, Route, Trade } = require('@uniswap/v3-sdk');
const { Token, CurrencyAmount, TradeType, Percent } = require('@uniswap/sdk-core');
const { ethers } = require('ethers');
const logger = require('../utils/logger');
const ErrorHandler = require('../utils/errorHandler');
const config = require('../config'); // Load main config for TickLens address, chainId
const { getProvider } = require('../utils/provider'); // Need provider for TickDataProvider
// --- Import the NEW Tick Data Provider ---
const { LensTickDataProvider } = require('../utils/tickDataProvider');

// --- Initialize TickDataProvider ---
// Ensure config is loaded before this file is required, or handle potential race condition
let tickDataProvider = null;
try {
    const provider = getProvider(); // Get provider instance
    if (!config.TICK_LENS_ADDRESS || !provider || !config.CHAIN_ID) {
         throw new Error("Missing TICK_LENS_ADDRESS, Provider, or CHAIN_ID in config for TickDataProvider initialization.");
    }
    tickDataProvider = new LensTickDataProvider(
        config.TICK_LENS_ADDRESS,
        provider,
        config.CHAIN_ID
    );
    logger.info("[QuoteSimulator] LensTickDataProvider initialized.");
} catch (error) {
     logger.fatal(`[QuoteSimulator] FAILED to initialize LensTickDataProvider: ${error.message}. Simulations will likely fail.`);
     // Allow bot to continue? Or make this fatal? For now, log fatal and it might crash later.
     // Consider setting tickDataProvider = null and adding checks below.
     tickDataProvider = null; // Set to null to indicate failure
}
// --------------------------------

// Helper to safely stringify for logging
function safeStringify(obj, indent = 2) { /* ... implementation ... */ }

// ================================================================
// !!! CRITICAL WARNING: Tick Provider initialized above. !!!
// If initialization failed, simulations will fail.
// ================================================================


/**
 * Simulates a single swap using Uniswap V3 SDK based on live pool state.
 * Uses the initialized LensTickDataProvider.
 */
const simulateSingleSwapExactIn = async (poolState, tokenIn, tokenOut, amountIn) => {
    const log = logger || console;
    const context = `SimSwap ${tokenIn?.symbol}->${tokenOut?.symbol} (${poolState?.fee}bps)`;

    // --- Check if TickDataProvider initialized ---
    if (!tickDataProvider) {
         log.error(`[${context}] TickDataProvider failed to initialize. Cannot simulate.`);
         return null;
    }
    // --- End Check ---

    // Input Validation (same as before)
    if (!poolState || !tokenIn || !tokenOut || !poolState.sqrtPriceX96 || !poolState.liquidity || typeof poolState.tick === 'undefined' || !poolState.fee) { /*...*/ return null; }
    if (!(tokenIn instanceof Token) || !(tokenOut instanceof Token)) { /*...*/ return null; }
    if (amountIn <= 0n) { /*...*/ return { amountOut: 0n, /*...*/ }; }
    const amountInStr = amountIn.toString(); if (!/^\d+$/.test(amountInStr)) { /*...*/ return null; }

    try {
        const [tokenA, tokenB] = tokenIn.sortsBefore(tokenOut) ? [tokenIn, tokenOut] : [tokenOut, tokenIn];
        const tickNumber = Number(poolState.tick);
        if (isNaN(tickNumber)) { /*...*/ return null; }

        // Create Uniswap SDK Pool Instance - PASSING REAL TICK DATA PROVIDER
        const pool = new Pool(
            tokenA, tokenB, poolState.fee,
            poolState.sqrtPriceX96.toString(),
            poolState.liquidity.toString(),
            tickNumber,
            // --- Use the initialized LensTickDataProvider ---
            // We pass the pool address dynamically to the provider's methods
            {
                 getTick: async (tick) => tickDataProvider.getTick(tick, poolState.tickSpacing, poolState.address),
                 nextInitializedTickWithinOneWord: async (tick, lte) => tickDataProvider.nextInitializedTickWithinOneWord(tick, lte, poolState.tickSpacing, poolState.address)
            }
            // --- ---
        );

        const swapRoute = new Route([pool], tokenIn, tokenOut);
        const trade = await Trade.fromRoute( swapRoute, CurrencyAmount.fromRawAmount(tokenIn, amountInStr), TradeType.EXACT_INPUT );

        if (!trade || !trade.outputAmount || !trade.outputAmount.quotient) { /*...*/ return { amountOut: 0n, /*...*/ }; }
        const amountOutBI = BigInt(trade.outputAmount.quotient.toString());

        return { amountOut: amountOutBI, sdkTokenIn: tokenIn, sdkTokenOut: tokenOut, trade: trade };

    } catch (error) {
        log.error(`[${context}] Error during single swap simulation: ${error.message}`);
        if (error.isInsufficientReservesError || error.message?.includes('liquidity')) { // Catch liquidity errors often caused by bad tick data
            log.error(`[${context}] SDK Error likely related to INSUFFICIENT LIQUIDITY or tick data. Check TickLens/Pool state.`);
        }
        ErrorHandler.handleError(error, context, { poolState, amountIn: amountInStr });
        return null; // Return null on significant error
    }
};


/**
 * Simulates a multi-hop arbitrage opportunity. (Logic mostly same as before)
 * Handles 'triangular' type. Can be extended for others.
 */
const simulateArbitrage = async (opportunity, initialAmount) => {
    // ... (Input Validation and logging remains the same) ...
    const log = logger || console;
    const logPrefix = `[SimArb OppType: ${opportunity?.type}, Group: ${opportunity?.groupName}]`;
    if (!opportunity || !opportunity.type || typeof initialAmount === 'undefined' || initialAmount <= 0n) { /*...*/ return { /*...*/ }; }
    // ...

    if (opportunity.type === 'triangular') {
        // ... (Validation and Token Resolution remains the same) ...
         if (!opportunity.pools || opportunity.pools.length !== 3 || !opportunity.pathSymbols || opportunity.pathSymbols.length !== 4) { /*...*/ return { /*...*/ }; }
         const [pool1, pool2, pool3] = opportunity.pools;
         const [symA, symB, symC, symA_final] = opportunity.pathSymbols;
         if (symA !== symA_final) { /*...*/ return { /*...*/ }; }
         const tokenA = pool1.token0Symbol === symA ? pool1.token0 : pool1.token1;
         const tokenB = pool1.token0Symbol === symB ? pool1.token0 : pool1.token1;
         const tokenC = pool2.token0Symbol === symC ? pool2.token0 : pool2.token1;
         if (!(tokenA instanceof Token) || !(tokenB instanceof Token) || !(tokenC instanceof Token)) { /*...*/ return { /*...*/ }; }
         // ...

        try {
            // --- Simulate Hops using simulateSingleSwapExactIn (which now uses real tick data) ---
            // Hop 1 (A -> B)
            const hop1Result = await simulateSingleSwapExactIn(pool1, tokenA, tokenB, initialAmount);
            if (!hop1Result || typeof hop1Result.amountOut !== 'bigint') { /*...*/ return { /*...*/ }; }
            const amountB_Received = hop1Result.amountOut;
            log.info(`[SIM Hop 1] Output: ${ethers.formatUnits(amountB_Received, tokenB.decimals)} ${tokenB.symbol}`);
            if (amountB_Received <= 0n) { /*...*/ return { /*...*/ }; }

            // Hop 2 (B -> C)
            const hop2Result = await simulateSingleSwapExactIn(pool2, tokenB, tokenC, amountB_Received);
            if (!hop2Result || typeof hop2Result.amountOut !== 'bigint') { /*...*/ return { /*...*/ }; }
            const amountC_Received = hop2Result.amountOut;
            log.info(`[SIM Hop 2] Output: ${ethers.formatUnits(amountC_Received, tokenC.decimals)} ${tokenC.symbol}`);
             if (amountC_Received <= 0n) { /*...*/ return { /*...*/ }; }

            // Hop 3 (C -> A)
            const hop3Result = await simulateSingleSwapExactIn(pool3, tokenC, tokenA, amountC_Received);
             if (!hop3Result || typeof hop3Result.amountOut !== 'bigint') { /*...*/ return { /*...*/ }; }
            const finalAmount = hop3Result.amountOut;
            log.info(`[SIM Hop 3] Output: ${ethers.formatUnits(finalAmount, tokenA.decimals)} ${tokenA.symbol}`);

            // ... (Profit Calculation and Return logic remains the same) ...
            const grossProfit = finalAmount - initialAmount;
            const profitable = grossProfit > 0n;
            log.info(`[SIM] Gross Profit: ${ethers.formatUnits(grossProfit, tokenA.decimals)} ${tokenA.symbol}`);
            log.info(`[SIM] Trade Profitable (Gross): ${profitable ? 'YES' : 'NO'}`);
            log.info(`--- Simulation END ${logPrefix} ---`);
            return { profitable, error: null, initialAmount, finalAmount, grossProfit, details: { /*...*/ } }; // Return full details

        } catch (error) {
             // ... (High-level error handling remains the same) ...
             log.error(`${logPrefix} UNEXPECTED High-Level Error: ${error.message}`);
             ErrorHandler.handleError(error, logPrefix);
             return { profitable: false, /*...*/ };
        }
    }
    // ... (Cyclic and Unknown type handling remains the same) ...
    else if (opportunity.type === 'cyclic') { /* ... placeholder ... */ }
    else { /* ... unknown type error ... */ }
};

module.exports = { simulateArbitrage, simulateSingleSwapExactIn };
