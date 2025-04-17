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
            simpleTickProvider // Using the stub provider
        );

        const swapRoute = new Route([pool], tokenIn, tokenOut);
        if (!swapRoute.pools || swapRoute.pools.length === 0) {
            log.warn(`[${context}] No valid pool in route by SDK.`); return null;
        }

        // --- START: Added Debug Logging for Single Swap SDK Input ---
        // Moved this specific log here from inside simulateArbitrage to be closer to the SDK call
        log.debug(`[DEBUG] Creating V3 Pool Object for ${context}`);
        log.debug(`    - Pool Params (TokenA): ${tokenA.symbol} (${tokenA.address})`);
        log.debug(`    - Pool Params (TokenB): ${tokenB.symbol} (${tokenB.address})`);
        log.debug(`    - Pool Params (Fee): ${poolState.fee}`);
        log.debug(`    - Pool Params (sqrtPriceX96): ${poolState.sqrtPriceX96.toString()}`);
        log.debug(`    - Pool Params (Liquidity): ${poolState.liquidity.toString()}`);
        log.debug(`    - Pool Params (Tick): ${poolState.tick}`);
        log.debug(`    - Route Input Token: ${tokenIn.symbol}`);
        log.debug(`    - Route Output Token: ${tokenOut.symbol}`);
        log.debug(`    - Trade Input Amount: ${amountIn.toString()} (Raw)`);
        // --- END: Added Debug Logging for Single Swap SDK Input ---

        const trade = await Trade.fromRoute(
            swapRoute,
            CurrencyAmount.fromRawAmount(tokenIn, amountIn.toString()),
            TradeType.EXACT_INPUT
        );
        const amountOutBI = BigInt(trade.outputAmount.quotient.toString());
        return { amountOut: amountOutBI, sdkTokenIn: tokenIn, sdkTokenOut: tokenOut, trade: trade };

    } catch (error) {
        log.error(`[${context}] Sim Error inside simulateSingleSwapExactIn: ${error.message}`);
        // Add more detail if available
        if (error.stack) log.debug(error.stack);
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

        // --- START: Added Debug Logging for Hop 2 ---
        log.debug(`[DEBUG] --- Preparing for Hop 2 Simulation (${logPrefix}) ---`);
        log.debug(`[DEBUG] Pool for Hop 2: ${poolHop2.address}`);
        log.debug(`    - Fee Tier: ${poolHop2.fee}bps`);
        // Log pool's token0/1 as defined in the pool state object for reference
        log.debug(`    - Token0 (from pool state): ${poolHop2.token0?.symbol} (${poolHop2.token0?.address})`);
        log.debug(`    - Token1 (from pool state): ${poolHop2.token1?.symbol} (${poolHop2.token1?.address})`);
        // Log the actual state values received from PoolScanner
        log.debug(`    - Tick Current (from scanner): ${poolHop2.tick}`);
        log.debug(`    - SqrtRatioX96 (from scanner): ${poolHop2.sqrtPriceX96?.toString()}`);
        log.debug(`    - Liquidity (
