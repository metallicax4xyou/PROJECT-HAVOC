// /workspaces/arbitrum-flash/core/quoteSimulator.js

const { Pool, Route, Trade } = require('@uniswap/v3-sdk');
const { Token, CurrencyAmount, TradeType, Percent } = require('@uniswap/sdk-core');
const { ethers } = require('ethers');
const logger = require('../utils/logger'); // Assuming logger utility
const ErrorHandler = require('../utils/errorHandler'); // Assuming error handler utility

// Helper to safely stringify for logging
function safeStringify(obj, indent = 2) {
    // Handle BigInt serialization
    try {
        return JSON.stringify(obj, (_, value) =>
            typeof value === 'bigint' ? value.toString() : value,
        indent);
    } catch (e) {
        return "[Unstringifiable Object]";
    }
}

// Minimal Tick Data Provider Stub - THIS IS LIKELY THE BOTTLENECK
// It doesn't provide real tick data, which V3 simulations need.
const simpleTickProvider = {
    getTick: async (tick) => {
        // logger.debug(`[TickProviderStub] getTick called for tick: ${tick}`); // Optional: Log tick calls
        // Returns a default structure assuming no specific liquidity info at the tick.
        // The actual Uniswap SDK might expect more detailed info for accurate simulation,
        // especially concerning initialized ticks and liquidity distribution.
        return {
            liquidityNet: 0n, // Represented as bigint
            liquidityGross: 0n, // Represented as bigint
            // Other potential fields like feeGrowthOutside0X128, initialized, etc., are missing.
        };
    },
    // This is a very basic stub. A real provider would need to search the bitmap.
    nextInitializedTickWithinOneWord: async (tick, lte, tickSpacing) => {
        // logger.debug(`[TickProviderStub] nextInitializedTickWithinOneWord called for tick: ${tick}, lte: ${lte}, spacing: ${tickSpacing}`);
        // This stub simply returns the *input* tick and 'false', indicating it didn't find
        // an *initialized* tick different from the input one within the word.
        // This is likely incorrect for almost all real scenarios.
        // Returning the input tick might cause the SDK to think there's no liquidity boundary
        // or no liquidity available beyond the current tick.
        // A more realistic (but still basic) stub *might* return +/- tickSpacing, but even
        // that lacks knowledge of actual initialized ticks.
        const nextTick = lte ? tick - tickSpacing : tick + tickSpacing;
        // Even returning the next potential tick doesn't say if it's *initialized*.
        // Forcing 'false' as initialized status.
        return [lte ? tick - tickSpacing : tick + tickSpacing, false]; // Return next potential tick based on spacing, but mark as uninitialized
    }
};

/**
 * Simulates a single swap using Uniswap V3 SDK based on live pool state.
 */
const simulateSingleSwapExactIn = async (poolState, tokenIn, tokenOut, amountIn) => {
    const log = logger || console; // Ensure log is defined
    const context = `SimSwap ${tokenIn?.symbol}->${tokenOut?.symbol} (${poolState?.address}, ${poolState?.fee}bps)`;

    // --- Input Validation ---
    if (!poolState || !tokenIn || !tokenOut || !poolState.sqrtPriceX96 || !poolState.liquidity || typeof poolState.tick === 'undefined' || !poolState.fee) {
        log.error(`[${context}] Invalid pool state or tokens for simulation.`);
        log.debug(`[${context}] PoolState: ${safeStringify(poolState)}, TokenIn: ${tokenIn?.symbol}, TokenOut: ${tokenOut?.symbol}, AmountIn: ${amountIn?.toString()}`);
        return null; // Return null to indicate failure
    }
    if (!(tokenIn instanceof Token) || !(tokenOut instanceof Token)) {
        log.error(`[${context}] tokenIn or tokenOut is not an SDK Token instance.`);
        return null;
    }
     if (amountIn <= 0n) { // Use bigint comparison
         log.warn(`[${context}] AmountIn is zero or negative (${amountIn?.toString()}). Cannot simulate.`);
         // Return a structure indicating zero output, but not necessarily an error
         return { amountOut: 0n, sdkTokenIn: tokenIn, sdkTokenOut: tokenOut, trade: null };
     }
     const amountInStr = amountIn.toString(); // Convert bigint to string for SDK
     if (!/^\d+$/.test(amountInStr)) {
         log.error(`[${context}] Invalid amountIn format for CurrencyAmount: ${amountInStr}`);
         return null;
     }
    // --- End Input Validation ---

    try {
        let tokenA, tokenB;
        // Determine token order for the Pool constructor
        if (tokenIn.sortsBefore(tokenOut)) {
            tokenA = tokenIn; tokenB = tokenOut;
            // log.debug(`[${context}] Token Order (sortsBefore): Input ${tokenIn.symbol} is tokenA.`);
        } else {
            tokenA = tokenOut; tokenB = tokenIn; // Pool constructor needs sorted tokens
            // log.debug(`[${context}] Token Order (sortsBefore): Input ${tokenIn.symbol} is tokenB (Pool tokens: ${tokenA.symbol}/${tokenB.symbol}).`);
        }

        // Ensure pool state values are valid strings/numbers for the SDK
        const sqrtPriceX96Str = poolState.sqrtPriceX96.toString();
        const liquidityStr = poolState.liquidity.toString();
        const tickNumber = Number(poolState.tick); // SDK expects number for tick

        if (isNaN(tickNumber)) {
            log.error(`[${context}] Invalid tick number provided: ${poolState.tick}`);
            return null;
        }

        // --- Create Uniswap SDK Pool Instance ---
        // This uses the live state fetched by PoolScanner
        const pool = new Pool(
            tokenA,             // The token that sorts first (Token instance)
            tokenB,             // The token that sorts second (Token instance)
            poolState.fee,      // Fee tier in bips (e.g., 500 for 0.05%)
            sqrtPriceX96Str,    // Current sqrt(price) as string
            liquidityStr,       // Current liquidity as string
            tickNumber,         // Current tick index as number
            simpleTickProvider  // *** Using the problematic STUB Tick Provider ***
        );

        // --- Create Route ---
        // For a single pool swap, the route just contains that one pool
        const swapRoute = new Route([pool], tokenIn, tokenOut);

        // --- Create Trade ---
        // This performs the simulation using the SDK's internal logic
        const trade = await Trade.fromRoute(
            swapRoute,                                          // The route object
            CurrencyAmount.fromRawAmount(tokenIn, amountInStr), // Input amount as CurrencyAmount
            TradeType.EXACT_INPUT                               // Specify we know the exact input amount
        );

        // --- Process Result ---
        if (!trade || !trade.outputAmount || !trade.outputAmount.quotient) {
             log.warn(`[${context}] SDK Trade.fromRoute did not return a valid trade object or output amount.`);
             log.debug(`[${context}] Trade object: ${safeStringify(trade)}`);
             return null;
        }

        // Extract output amount as bigint
        const amountOutBI = BigInt(trade.outputAmount.quotient.toString());

        // Return detailed result
        return {
            amountOut: amountOutBI,
            sdkTokenIn: tokenIn,
            sdkTokenOut: tokenOut,
            trade: trade // Include the trade object for price impact etc.
        };

    } catch (error) {
        // Catch errors during SDK interaction
        log.error(`[${context}] Error during single swap simulation: ${error.message}`);
        log.debug(`[${context}] Error Stack: ${error.stack}`);
        log.debug(`[${context}] Failed with Pool State: ${safeStringify(poolState)}, AmountIn: ${amountInStr}`);
        // Log specific SDK errors if available
        if (error.isInsufficientReservesError) { log.error(`[${context}] SDK Error: Insufficient Reserves.`); }
        if (error.isInsufficientInputAmountError) { log.error(`[${context}] SDK Error: Insufficient Input Amount.`); }
        return null; // Return null on error
    }
};


/**
 * Simulates a two-hop arbitrage opportunity (Token0 -> Token1 -> Token0).
 */
const simulateArbitrage = async (opportunity, initialAmountToken0) => {
    const log = logger || console; // Ensure log is defined

    // --- Input Validation ---
     if (!opportunity || !opportunity.token0 || !opportunity.token1 || !opportunity.poolHop1 || !opportunity.poolHop2 || !opportunity.group || !initialAmountToken0) {
         log.error("[SimArb FATAL] Invalid opportunity structure or initial amount.", safeStringify({ opportunity, initialAmountToken0 }));
         return { profitable: false, error: "Invalid opportunity structure or initial amount", grossProfit: -1n, initialAmountToken0: initialAmountToken0 || 0n, finalAmountToken0: 0n, amountToken1Received: 0n };
     }

    const { poolHop1, poolHop2, token0, token1, group } = opportunity;
    const logPrefix = `SimArb ${group} (${poolHop1.fee}bps->${poolHop2.fee}bps)`;

    // Defensive check: Ensure tokens are SDK Token instances
    if (!(token0 instanceof Token) || !(token1 instanceof Token)) {
        log.error(`[${logPrefix}] FATAL: token0 or token1 is not an SDK Token instance.`);
        return { profitable: false, error: "Invalid token type in opportunity", grossProfit: -1n, initialAmountToken0, finalAmountToken0: 0n, amountToken1Received: 0n };
    }

    const initialAmountFormatted = ethers.formatUnits(initialAmountToken0, token0.decimals);

    // --- Logging Start ---
    log.info(`--- Simulation Start (${logPrefix}) ---`);
    log.info(`[SIM] Borrow Amount: ${initialAmountFormatted} ${token0.symbol}`);
    log.info(`[SIM] Path: Pool1 (${poolHop1.address} / ${poolHop1.fee}bps) -> Pool2 (${poolHop2.address} / ${poolHop2.fee}bps)`);

    try {
        // --- Simulate Hop 1 (Token0 -> Token1) ---
        const hop1Result = await simulateSingleSwapExactIn(poolHop1, token0, token1, initialAmountToken0);

        if (!hop1Result || typeof hop1Result.amountOut !== 'bigint') { // Check for null or invalid amountOut
             log.warn(`[${logPrefix}] Hop 1 simulation failed or returned invalid structure.`);
             log.debug(`[${logPrefix}] Hop 1 Result: ${safeStringify(hop1Result)}`);
             log.info(`--- Simulation END (${logPrefix}) - FAILED (Hop 1 Sim) ---`);
             return { profitable: false, error: 'Hop 1 simulation failed internally', initialAmountToken0, finalAmountToken0: 0n, amountToken1Received: 0n, grossProfit: -1n };
        }

        const amountToken1Received = hop1Result.amountOut; // This is a bigint
        const amountHop1Formatted = ethers.formatUnits(amountToken1Received, token1.decimals);
        const hop1FeePercent = new Percent(poolHop1.fee, 1_000_000);
        // Defensive check for trade object before accessing properties
        const priceImpactHop1 = hop1Result.trade?.priceImpact?.toSignificant(3) || 'N/A';

        log.info(`[SIM] Hop 1 (${token0.symbol} -> ${token1.symbol} @ ${poolHop1.fee}bps):`);
        log.info(`    - Input:  ${initialAmountFormatted} ${token0.symbol}`);
        log.info(`    - Output: ${amountHop1Formatted} ${token1.symbol}`);
        log.info(`    - Fee Tier: ${hop1FeePercent.toFixed(3)}%`);
        log.info(`    - Price Impact: ~${priceImpactHop1}%`);

        if (amountToken1Received <= 0n) { // Use bigint comparison
             log.warn(`[${logPrefix}] Hop 1 resulted in 0 output. Cannot proceed to Hop 2.`);
             log.info(`--- Simulation END (${logPrefix}) - FAILED (Zero Output Hop 1) ---`);
             return { profitable: false, error: 'Hop 1 simulation resulted in zero output', initialAmountToken0, finalAmountToken0: 0n, amountToken1Received: 0n, grossProfit: -1n };
        }

        // --- START: Added Debug Logging for Hop 2 ---
        // Check poolHop2 state *before* attempting the simulation
        log.debug(`[DEBUG] --- Preparing for Hop 2 Simulation (${logPrefix}) ---`);
        log.debug(`[DEBUG] Pool for Hop 2: ${poolHop2.address}`);
        log.debug(`    - Fee Tier: ${poolHop2.fee}bps`);
        // Log pool's token0/1 as defined in the pool state object for reference
        // Make sure poolHop2 actually has these properties populated from the scanner
        log.debug(`    - Token0 (from pool state): ${poolHop2.token0?.symbol} (${poolHop2.token0?.address})`);
        log.debug(`    - Token1 (from pool state): ${poolHop2.token1?.symbol} (${poolHop2.token1?.address})`);
        // Log the actual state values received from PoolScanner
        log.debug(`    - Tick Current (from scanner): ${poolHop2.tick}`);
        log.debug(`    - SqrtRatioX96 (from scanner): ${poolHop2.sqrtPriceX96?.toString()}`);
        log.debug(`    - Liquidity (from scanner): ${poolHop2.liquidity?.toString()}`);
        // Log the arguments being passed to simulateSingleSwapExactIn for Hop 2
        log.debug(`    - Input Token for Hop 2 (Sim Arg): ${token1.symbol} (${token1.address})`); // token1 is the input now
        log.debug(`    - Output Token for Hop 2 (Sim Arg): ${token0.symbol} (${token0.address})`); // token0 is the output now
        log.debug(`    - Input Amount for Hop 2 (Sim Arg): ${amountToken1Received.toString()} (Raw) / ${ethers.formatUnits(amountToken1Received, token1.decimals)} ${token1.symbol}`);
        // --- END: Added Debug Logging for Hop 2 ---

        // --- Simulate Hop 2 (Token1 -> Token0) ---
        const hop2Result = await simulateSingleSwapExactIn(poolHop2, token1, token0, amountToken1Received); // Use token1 as input, token0 as output

        // More robust check for Hop 2 result
        if (!hop2Result || typeof hop2Result.amountOut !== 'bigint') { // Check if amountOut is specifically a bigint
             log.warn(`[${logPrefix}] Hop 2 simulation failed or returned invalid structure.`);
             log.debug(`[${logPrefix}] Hop 2 Result: ${safeStringify(hop2Result)}`);
             log.info(`--- Simulation END (${logPrefix}) - FAILED (Hop 2 Sim) ---`);
             // Ensure amountToken1Received is carried over even on failure for logging/debugging
             return { profitable: false, error: 'Hop 2 simulation failed internally', initialAmountToken0, finalAmountToken0: 0n, amountToken1Received, grossProfit: -1n };
        }

        const finalAmountToken0 = hop2Result.amountOut; // This is a bigint
        const finalAmountFormatted = ethers.formatUnits(finalAmountToken0, token0.decimals);
        const hop2FeePercent = new Percent(poolHop2.fee, 1_000_000);
        // Defensive check for trade object before accessing properties
        const priceImpactHop2 = hop2Result.trade?.priceImpact?.toSignificant(3) || 'N/A';

        log.info(`[SIM] Hop 2 (${token1.symbol} -> ${token0.symbol} @ ${poolHop2.fee}bps):`);
        log.info(`    - Input:  ${amountHop1Formatted} ${token1.symbol}`);
        log.info(`    - Output: ${finalAmountFormatted} ${token0.symbol}`);
        log.info(`    - Fee Tier: ${hop2FeePercent.toFixed(3)}%`);
        log.info(`    - Price Impact: ~${priceImpactHop2}%`);

        // --- Calculate & Log Profit ---
        // Ensure both are bigints before subtraction
        const grossProfit = finalAmountToken0 - initialAmountToken0; // Both should be bigint
        const profitable = grossProfit > 0n; // Bigint comparison
        const grossProfitFormatted = ethers.formatUnits(grossProfit, token0.decimals);

        log.info(`[SIM] Gross Profit: ${grossProfitFormatted} ${token0.symbol}`);
        log.info(`[SIM] Trade Profitable (Gross): ${profitable ? 'YES' : 'NO'}`);
        log.info(`--- Simulation END (${logPrefix}) ---`);

        return {
            profitable,
            initialAmountToken0, // bigint
            finalAmountToken0,   // bigint
            amountToken1Received,// bigint
            grossProfit,         // bigint
            error: null,
            details: {
                group,
                token0Symbol: token0.symbol,
                token1Symbol: token1.symbol,
                hop1Pool: poolHop1.address,
                hop2Pool: poolHop2.address,
                hop1Fee: poolHop1.fee,
                hop2Fee: poolHop2.fee
            }
        };

    } catch (error) {
        // Catch high-level errors in simulateArbitrage logic
        log.error(`[${logPrefix}] UNEXPECTED High-Level Error in simulateArbitrage: ${error.message}`);
        if (error.stack) { log.error(`Stack Trace: ${error.stack}`); }
        if (ErrorHandler && typeof ErrorHandler.handleError === 'function') { ErrorHandler.handleError(error, logPrefix); }
        log.info(`--- Simulation END (${logPrefix}) - FAILED (Unexpected) ---`);
        // Ensure amountToken1Received is included in the return object even on error, if available before the crash
        const hop1Output = typeof amountToken1Received !== 'undefined' ? amountToken1Received : 0n; // bigint
        return {
            profitable: false,
            error: `Unexpected simulation error: ${error.message}`,
            initialAmountToken0: initialAmountToken0, // bigint
            finalAmountToken0: 0n, // bigint
            amountToken1Received: hop1Output, // bigint
            grossProfit: -1n // bigint
        };
    }
};

module.exports = { simulateArbitrage, simulateSingleSwapExactIn }; // Export both
