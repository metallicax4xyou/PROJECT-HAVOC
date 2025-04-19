// /workspaces/arbitrum-flash/core/quoteSimulator.js

const { Pool, Route, Trade } = require('@uniswap/v3-sdk');
const { Token, CurrencyAmount, TradeType, Percent } = require('@uniswap/sdk-core');
const { ethers } = require('ethers');
const logger = require('../utils/logger');
const ErrorHandler = require('../utils/errorHandler');
const config = require('../config'); // Load main config if needed (e.g., for constants?)

// Helper to safely stringify for logging
function safeStringify(obj, indent = 2) {
    try {
        return JSON.stringify(obj, (_, value) =>
            typeof value === 'bigint' ? value.toString() : value,
        indent);
    } catch (e) { return "[Unstringifiable Object]"; }
}

// ================================================================
// !!! CRITICAL WARNING: USING STUB TICK PROVIDER !!!
// Simulation results will be inaccurate until this is replaced
// with a real provider that fetches on-chain tick data.
// ================================================================
const simpleTickProvider = {
    getTick: async (tick) => {
        // Returns a default structure assuming no specific liquidity info at the tick.
        return { liquidityNet: 0n, liquidityGross: 0n };
    },
    nextInitializedTickWithinOneWord: async (tick, lte, tickSpacing) => {
        // This stub simply returns the *input* tick and 'false', indicating it didn't find
        // an *initialized* tick different from the input one within the word.
        // This is likely incorrect for almost all real scenarios.
        const nextTick = lte ? tick - tickSpacing : tick + tickSpacing;
        return [nextTick, false]; // Return next potential tick based on spacing, mark as uninitialized
    }
};
// ================================================================

/**
 * Simulates a single swap using Uniswap V3 SDK based on live pool state.
 * @param {object} poolState Live state object for the pool from PoolScanner.
 * @param {Token} tokenIn SDK Token instance for input.
 * @param {Token} tokenOut SDK Token instance for output.
 * @param {bigint} amountIn Raw amount of tokenIn (smallest units).
 * @returns {Promise<object|null>} { amountOut: bigint, sdkTokenIn: Token, sdkTokenOut: Token, trade: Trade|null } or null on failure.
 */
const simulateSingleSwapExactIn = async (poolState, tokenIn, tokenOut, amountIn) => {
    const log = logger || console;
    const context = `SimSwap ${tokenIn?.symbol}->${tokenOut?.symbol} (${poolState?.fee}bps)`;

    // --- Input Validation ---
    if (!poolState || !tokenIn || !tokenOut || !poolState.sqrtPriceX96 || !poolState.liquidity || typeof poolState.tick === 'undefined' || !poolState.fee) {
        log.error(`[${context}] Invalid pool state or tokens for simulation.`);
        log.debug(`[${context}] Args: ${safeStringify({ poolState, tokenIn: tokenIn?.symbol, tokenOut: tokenOut?.symbol, amountIn: amountIn?.toString() })}`);
        return null;
    }
    if (!(tokenIn instanceof Token) || !(tokenOut instanceof Token)) {
        log.error(`[${context}] tokenIn or tokenOut is not an SDK Token instance.`);
        return null;
    }
     if (amountIn <= 0n) {
         log.warn(`[${context}] AmountIn is zero or negative (${amountIn?.toString()}).`);
         return { amountOut: 0n, sdkTokenIn: tokenIn, sdkTokenOut: tokenOut, trade: null };
     }
     // SDK needs amounts as strings
     const amountInStr = amountIn.toString();
     if (!/^\d+$/.test(amountInStr)) {
         log.error(`[${context}] Invalid amountIn format for CurrencyAmount: ${amountInStr}`);
         return null;
     }
    // --- End Input Validation ---

    try {
        // Pool constructor needs tokens sorted
        const [tokenA, tokenB] = tokenIn.sortsBefore(tokenOut) ? [tokenIn, tokenOut] : [tokenOut, tokenIn];

        // SDK Pool constructor needs tick as number
        const tickNumber = Number(poolState.tick); // Convert poolState.tick (BigInt) to Number
        if (isNaN(tickNumber)) {
            log.error(`[${context}] Invalid tick number provided: ${poolState.tick}`);
            return null;
        }

        // --- Create Uniswap SDK Pool Instance ---
        const pool = new Pool(
            tokenA,
            tokenB,
            poolState.fee,
            poolState.sqrtPriceX96.toString(), // Current sqrt(price) as string
            poolState.liquidity.toString(),     // Current liquidity as string
            tickNumber,                         // Current tick index as number
            simpleTickProvider                  // *** USING STUB TICK PROVIDER ***
        );

        // --- Create Route ---
        const swapRoute = new Route([pool], tokenIn, tokenOut);

        // --- Create Trade (Simulation) ---
        const trade = await Trade.fromRoute(
            swapRoute,
            CurrencyAmount.fromRawAmount(tokenIn, amountInStr),
            TradeType.EXACT_INPUT
        );

        // --- Process Result ---
        if (!trade || !trade.outputAmount || !trade.outputAmount.quotient) {
             log.warn(`[${context}] SDK Trade.fromRoute did not return a valid trade or output amount.`);
             log.debug(`[${context}] Trade object: ${safeStringify(trade)}`);
             // Return zero output but not null, to indicate simulation ran but yielded nothing
             return { amountOut: 0n, sdkTokenIn: tokenIn, sdkTokenOut: tokenOut, trade: null };
        }

        const amountOutBI = BigInt(trade.outputAmount.quotient.toString());

        return {
            amountOut: amountOutBI, // bigint
            sdkTokenIn: tokenIn,
            sdkTokenOut: tokenOut,
            trade: trade // Include trade object for potential price impact analysis
        };

    } catch (error) {
        log.error(`[${context}] Error during single swap simulation: ${error.message}`);
        if (error.isInsufficientReservesError) { log.error(`[${context}] SDK Error: Insufficient Reserves.`); }
        if (error.isInsufficientInputAmountError) { log.error(`[${context}] SDK Error: Insufficient Input Amount.`); }
        ErrorHandler.handleError(error, context, { poolState, amountIn: amountInStr });
        return null; // Return null on significant error
    }
};


/**
 * Simulates a multi-hop arbitrage opportunity.
 * Handles 'triangular' type. Can be extended for others.
 * @param {object} opportunity The opportunity object from PoolScanner.
 * @param {bigint} initialAmount The amount of the starting token to simulate borrowing.
 * @returns {Promise<object>} Simulation result object:
 *          { profitable: boolean, error: string|null, grossProfit: bigint,
 *            initialAmount: bigint, finalAmount: bigint, details: object|null }
 */
const simulateArbitrage = async (opportunity, initialAmount) => {
    const log = logger || console;
    const logPrefix = `[SimArb OppType: ${opportunity?.type}, Group: ${opportunity?.groupName}]`;

    // --- Basic Input Validation ---
    if (!opportunity || !opportunity.type || typeof initialAmount === 'undefined' || initialAmount <= 0n) {
         log.error(`${logPrefix} FATAL: Invalid opportunity structure or initial amount.`, safeStringify({ opportunity, initialAmount }));
         return { profitable: false, error: "Invalid opportunity or initial amount", grossProfit: -1n, initialAmount: initialAmount || 0n, finalAmount: 0n, details: null };
    }
    const initialAmountFormatted = ethers.formatUnits(initialAmount, opportunity.pools?.[0]?.token0?.decimals ?? 18); // Format for logging
    log.info(`--- Simulation Start ${logPrefix} ---`);
    log.info(`[SIM] Initial Amount: ${initialAmountFormatted}`); // Symbol added per type below

    // --- TRIANGULAR PATH LOGIC ---
    if (opportunity.type === 'triangular') {
        // Validate structure needed for triangular
        if (!opportunity.pools || opportunity.pools.length !== 3 || !opportunity.pathSymbols || opportunity.pathSymbols.length !== 4) {
            log.error(`${logPrefix} Invalid triangular opportunity structure.`);
            return { profitable: false, error: "Invalid triangular opportunity structure", grossProfit: -1n, initialAmount, finalAmount: 0n, details: null };
        }

        const [pool1, pool2, pool3] = opportunity.pools;
        const [symA, symB, symC, symA_final] = opportunity.pathSymbols;

        // Verify start/end symbols match
        if (symA !== symA_final) {
             log.error(`${logPrefix} Path symbols do not form a cycle (${symA} -> ${symA_final}).`);
             return { profitable: false, error: "Invalid path symbols (not a cycle)", grossProfit: -1n, initialAmount, finalAmount: 0n, details: null };
        }

        // Get SDK Token instances (assuming they are attached to pool states by scanner)
        const tokenA = pool1.token0Symbol === symA ? pool1.token0 : pool1.token1;
        const tokenB = pool1.token0Symbol === symB ? pool1.token0 : pool1.token1; // Or could use pool2.token0/1 if symB matches
        const tokenC = pool2.token0Symbol === symC ? pool2.token0 : pool2.token1; // Or could use pool3.token0/1 if symC matches

        if (!(tokenA instanceof Token) || !(tokenB instanceof Token) || !(tokenC instanceof Token)) {
            log.error(`${logPrefix} Could not resolve valid SDK Token instances from pool states.`);
            log.debug(`TokenA: ${tokenA?.symbol}, TokenB: ${tokenB?.symbol}, TokenC: ${tokenC?.symbol}`);
            return { profitable: false, error: "Failed to resolve SDK Tokens", grossProfit: -1n, initialAmount, finalAmount: 0n, details: null };
        }
        log.info(`[SIM] Path: ${symA} -> ${symB} -> ${symC} -> ${symA}`);
        log.info(`[SIM] Initial Token: ${tokenA.symbol}`);

        try {
            // --- Simulate Hop 1 (A -> B) ---
            log.debug(`[SIM Hop 1] ${symA} -> ${symB} using Pool ${pool1.address} (${pool1.fee}bps)`);
            const hop1Result = await simulateSingleSwapExactIn(pool1, tokenA, tokenB, initialAmount);
            if (!hop1Result || typeof hop1Result.amountOut !== 'bigint') { // Check amountOut validity
                 log.warn(`${logPrefix} Hop 1 simulation failed or returned invalid structure.`);
                 log.debug(`Hop 1 Result: ${safeStringify(hop1Result)}`);
                 return { profitable: false, error: 'Hop 1 simulation failed', grossProfit: -1n, initialAmount, finalAmount: 0n, details: { hop: 1, result: hop1Result } };
            }
            const amountB_Received = hop1Result.amountOut;
            log.info(`[SIM Hop 1] Output: ${ethers.formatUnits(amountB_Received, tokenB.decimals)} ${tokenB.symbol}`);
            if (amountB_Received <= 0n) {
                 log.warn(`${logPrefix} Hop 1 resulted in zero output.`);
                 return { profitable: false, error: 'Hop 1 simulation zero output', grossProfit: -1n, initialAmount, finalAmount: 0n, details: { hop: 1, result: hop1Result } };
            }

            // --- Simulate Hop 2 (B -> C) ---
            log.debug(`[SIM Hop 2] ${symB} -> ${symC} using Pool ${pool2.address} (${pool2.fee}bps)`);
            const hop2Result = await simulateSingleSwapExactIn(pool2, tokenB, tokenC, amountB_Received);
            if (!hop2Result || typeof hop2Result.amountOut !== 'bigint') {
                 log.warn(`${logPrefix} Hop 2 simulation failed or returned invalid structure.`);
                 log.debug(`Hop 2 Result: ${safeStringify(hop2Result)}`);
                 return { profitable: false, error: 'Hop 2 simulation failed', grossProfit: -1n, initialAmount, finalAmount: 0n, details: { hop: 2, result: hop2Result } };
            }
            const amountC_Received = hop2Result.amountOut;
            log.info(`[SIM Hop 2] Output: ${ethers.formatUnits(amountC_Received, tokenC.decimals)} ${tokenC.symbol}`);
             if (amountC_Received <= 0n) {
                 log.warn(`${logPrefix} Hop 2 resulted in zero output.`);
                 return { profitable: false, error: 'Hop 2 simulation zero output', grossProfit: -1n, initialAmount, finalAmount: 0n, details: { hop: 2, result: hop2Result } };
            }

            // --- Simulate Hop 3 (C -> A) ---
            log.debug(`[SIM Hop 3] ${symC} -> ${symA} using Pool ${pool3.address} (${pool3.fee}bps)`);
            const hop3Result = await simulateSingleSwapExactIn(pool3, tokenC, tokenA, amountC_Received);
             if (!hop3Result || typeof hop3Result.amountOut !== 'bigint') {
                 log.warn(`${logPrefix} Hop 3 simulation failed or returned invalid structure.`);
                 log.debug(`Hop 3 Result: ${safeStringify(hop3Result)}`);
                 return { profitable: false, error: 'Hop 3 simulation failed', grossProfit: -1n, initialAmount, finalAmount: 0n, details: { hop: 3, result: hop3Result } };
            }
            const finalAmount = hop3Result.amountOut; // Final amount of tokenA
            log.info(`[SIM Hop 3] Output: ${ethers.formatUnits(finalAmount, tokenA.decimals)} ${tokenA.symbol}`);

            // --- Calculate & Log Profit ---
            const grossProfit = finalAmount - initialAmount;
            const profitable = grossProfit > 0n;
            const grossProfitFormatted = ethers.formatUnits(grossProfit, tokenA.decimals);

            log.info(`[SIM] Final Result: Initial=${initialAmountFormatted} ${tokenA.symbol}, Final=${ethers.formatUnits(finalAmount, tokenA.decimals)} ${tokenA.symbol}`);
            log.info(`[SIM] Gross Profit: ${grossProfitFormatted} ${tokenA.symbol}`);
            log.info(`[SIM] Trade Profitable (Gross): ${profitable ? 'YES' : 'NO'}`);
            log.info(`--- Simulation END ${logPrefix} ---`);

            return {
                profitable,
                error: null,
                initialAmount,      // bigint
                finalAmount,        // bigint
                grossProfit,        // bigint
                details: { // Include details useful for executor/logging
                    type: 'triangular',
                    group: opportunity.groupName || 'N/A',
                    pathSymbols: opportunity.pathSymbols,
                    tokenA, // SDK Token instance
                    tokenB,
                    tokenC,
                    pools: [pool1.address, pool2.address, pool3.address],
                    fees: [pool1.fee, pool2.fee, pool3.fee],
                    amountB_Received, // Intermediate amounts can be useful
                    amountC_Received,
                    // Optionally include SDK trade objects if needed for price impact etc.
                    // trade1: hop1Result.trade,
                    // trade2: hop2Result.trade,
                    // trade3: hop3Result.trade,
                }
            };

        } catch (error) {
            log.error(`${logPrefix} UNEXPECTED High-Level Error in triangular simulation: ${error.message}`);
            ErrorHandler.handleError(error, logPrefix);
            log.info(`--- Simulation END (${logPrefix}) - FAILED (Unexpected) ---`);
            return { profitable: false, error: `Unexpected simulation error: ${error.message}`, grossProfit: -1n, initialAmount, finalAmount: 0n, details: null };
        }

    }
    // --- ADD OTHER OPPORTUNITY TYPE LOGIC HERE (e.g., 'cyclic') ---
    else if (opportunity.type === 'cyclic') {
        // --- Placeholder for 2-Hop Logic (from previous version) ---
        // This requires the opportunity structure to be { poolHop1, poolHop2, token0, token1, group }
        // and initialAmount should be for token0.
        log.warn(`${logPrefix} Cyclic (2-hop) simulation logic needs verification/update based on scanner output structure.`);

        const { poolHop1, poolHop2, token0, token1, group } = opportunity; // Assumed structure
        if (!poolHop1 || !poolHop2 || !token0 || !token1) {
             log.error(`${logPrefix} Invalid cyclic opportunity structure.`);
             return { profitable: false, error: "Invalid cyclic opportunity structure", grossProfit: -1n, initialAmount, finalAmount: 0n, details: null };
        }
        if (!(token0 instanceof Token) || !(token1 instanceof Token)) {
             log.error(`${logPrefix} Invalid token types in cyclic opportunity.`);
             return { profitable: false, error: "Invalid token types (cyclic)", grossProfit: -1n, initialAmount, finalAmount: 0n, details: null };
        }

         log.info(`[SIM] Path: ${token0.symbol} -> ${token1.symbol} -> ${token0.symbol}`);
         log.info(`[SIM] Initial Token: ${token0.symbol}`);

        try {
            // Simulate Hop 1 (Token0 -> Token1)
             log.debug(`[SIM Hop 1] ${token0.symbol} -> ${token1.symbol} using Pool ${poolHop1.address} (${poolHop1.fee}bps)`);
             const hop1Result = await simulateSingleSwapExactIn(poolHop1, token0, token1, initialAmount);
             if (!hop1Result || typeof hop1Result.amountOut !== 'bigint') { /* ... error handling ... */ return { /*...*/ }; }
             const amountToken1Received = hop1Result.amountOut;
             log.info(`[SIM Hop 1] Output: ${ethers.formatUnits(amountToken1Received, token1.decimals)} ${token1.symbol}`);
             if (amountToken1Received <= 0n) { /* ... error handling ... */ return { /*...*/ }; }

            // Simulate Hop 2 (Token1 -> Token0)
             log.debug(`[SIM Hop 2] ${token1.symbol} -> ${token0.symbol} using Pool ${poolHop2.address} (${poolHop2.fee}bps)`);
             const hop2Result = await simulateSingleSwapExactIn(poolHop2, token1, token0, amountToken1Received);
             if (!hop2Result || typeof hop2Result.amountOut !== 'bigint') { /* ... error handling ... */ return { /*...*/ }; }
             const finalAmount = hop2Result.amountOut;
             log.info(`[SIM Hop 2] Output: ${ethers.formatUnits(finalAmount, token0.decimals)} ${token0.symbol}`);

            // Calculate & Log Profit
             const grossProfit = finalAmount - initialAmount;
             const profitable = grossProfit > 0n;
             const grossProfitFormatted = ethers.formatUnits(grossProfit, token0.decimals);
             log.info(`[SIM] Final Result: Initial=${initialAmountFormatted} ${token0.symbol}, Final=${ethers.formatUnits(finalAmount, token0.decimals)} ${token0.symbol}`);
             log.info(`[SIM] Gross Profit: ${grossProfitFormatted} ${token0.symbol}`);
             log.info(`[SIM] Trade Profitable (Gross): ${profitable ? 'YES' : 'NO'}`);
             log.info(`--- Simulation END ${logPrefix} ---`);

            return {
                profitable, error: null, initialAmount, finalAmount, grossProfit,
                details: {
                    type: 'cyclic', group: group || 'N/A', token0, token1,
                    pools: [poolHop1.address, poolHop2.address], fees: [poolHop1.fee, poolHop2.fee],
                    amountToken1Received,
                    // Optionally include trades
                    // trade1: hop1Result.trade, trade2: hop2Result.trade,
                }
             };
        } catch (error) {
             log.error(`${logPrefix} UNEXPECTED High-Level Error in cyclic simulation: ${error.message}`);
             ErrorHandler.handleError(error, logPrefix);
             log.info(`--- Simulation END (${logPrefix}) - FAILED (Unexpected) ---`);
             return { profitable: false, error: `Unexpected simulation error: ${error.message}`, grossProfit: -1n, initialAmount, finalAmount: 0n, details: null };
        }
        // --- End Placeholder 2-Hop ---
    }
    // --- Unknown Opportunity Type ---
    else {
        log.error(`${logPrefix} Unknown opportunity type received: ${opportunity.type}`);
        return { profitable: false, error: `Unknown opportunity type: ${opportunity.type}`, grossProfit: -1n, initialAmount, finalAmount: 0n, details: null };
    }
};

module.exports = { simulateArbitrage, simulateSingleSwapExactIn }; // Export both
