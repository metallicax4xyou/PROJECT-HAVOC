// /workspaces/arbitrum-flash/core/quoteSimulator.js
// *** Now ONLY simulates a SINGLE swap ***
const { Pool, Route, Trade, TickMath } = require('@uniswap/v3-sdk'); // Removed FeeAmount as it's only used via helper now
const { Token, CurrencyAmount, TradeType } = require('@uniswap/sdk-core');
const JSBI = require('jsbi');
const logger = require('../utils/logger');
const ErrorHandler = require('../utils/errorHandler');

// --- Import helpers and constants ---
const {
    MIN_SQRT_RATIO,
    MAX_SQRT_RATIO,
    getFeeAmountEnum, // Still need this helper
    stringifyPoolState,
} = require('./simulationHelpers'); // Import from the helper file
// ---

class QuoteSimulator {
    constructor(tickDataProvider) {
        if (!tickDataProvider || typeof tickDataProvider.getPopulatedTicksInRange !== 'function') {
            console.error("[QuoteSimulator Constructor] FATAL: Invalid TickDataProvider instance provided.");
            throw new Error("Valid TickDataProvider instance required for QuoteSimulator.");
        }
        this.tickDataProvider = tickDataProvider;
        console.log("[QuoteSimulator] Instance created with TickDataProvider.");
    }

    /**
     * Simulates a single swap (one leg of an arbitrage).
     * @param {object} poolState - Live state of the Uniswap V3 pool. Requires { sqrtPriceX96, liquidity, tick, fee, tickSpacing, address? }
     * @param {Token} tokenIn - SDK Token instance for input.
     * @param {Token} tokenOut - SDK Token instance for output.
     * @param {bigint} amountIn - Raw amount of tokenIn to swap.
     * @returns {Promise<object|null>} - Promise resolving to { amountOut: bigint, sdkTokenIn: Token, sdkTokenOut: Token, trade: Trade } or null on error.
     */
    async simulateSingleSwapExactIn(poolState, tokenIn, tokenOut, amountIn) {
        const log = logger || console;
        const context = `[SimSwap ${tokenIn?.symbol}->${tokenOut?.symbol} (${poolState?.fee}bps)]`;

        // --- Basic Input Validation ---
        if (!this.tickDataProvider) { log.error(`${context} Fatal: TickDataProvider not initialized.`); return null; }
        if (!poolState) { log.error(`${context} Invalid poolState (null or undefined).`); return null; }
        if (!tokenIn || !tokenOut) { log.error(`${context} Invalid tokenIn or tokenOut.`); return null; }
        if (!(tokenIn instanceof Token) || !(tokenOut instanceof Token)) { log.error(`${context} tokenIn or tokenOut is not a valid SDK Token instance.`); return null; }
        if (amountIn <= 0n) { log.error(`${context} Invalid amountIn (${amountIn}). Must be positive.`); return null; }
        const amountInStr = amountIn.toString(); if (!/^\d+$/.test(amountInStr)) { log.error(`${context} Invalid amountIn string representation: ${amountInStr}`); return null; }

        // Check required poolState fields - Adjusted types based on previous findings
        if (typeof poolState.sqrtPriceX96 !== 'bigint' || typeof poolState.liquidity !== 'bigint' || typeof poolState.tick !== 'number' || !poolState.fee || typeof poolState.tickSpacing !== 'number') {
            log.error(`${context} Invalid poolState fields (missing/wrong type): sqrtPriceX96 (bigint), liquidity (bigint), tick (number), fee, or tickSpacing (number).`);
            console.error("Problematic PoolState:", stringifyPoolState(poolState));
            return null;
        }
        // --- End Basic Input Validation ---

        console.log(`\n--- ${context} ---`);
        console.log(`TokenIn: ${tokenIn.symbol}, TokenOut: ${tokenOut.symbol}, AmountIn: ${amountInStr}`);

        let tickFromSqrtPrice = 'N/A';
        let adjustedTick = 'N/A';
        let tickSpacing = 'N/A';
        let sqrtPriceJSBI;

        try {
            const [tokenA, tokenB] = tokenIn.sortsBefore(tokenOut) ? [tokenIn, tokenOut] : [tokenOut, tokenIn];

            tickSpacing = Number(poolState.tickSpacing);
            if (isNaN(tickSpacing) || tickSpacing <= 0) {
                log.error(`${context} Invalid tickSpacing (${poolState.tickSpacing}).`);
                return null;
            }

            // --- Validate sqrtPriceX96 range ---
            sqrtPriceJSBI = JSBI.BigInt(poolState.sqrtPriceX96.toString());
            if (JSBI.lessThan(sqrtPriceJSBI, MIN_SQRT_RATIO) || JSBI.greaterThan(sqrtPriceJSBI, MAX_SQRT_RATIO)) {
                 log.error(`${context} sqrtPriceX96 (${poolState.sqrtPriceX96}) is outside the valid SDK range.`);
                 console.error(`MIN_SQRT_RATIO: ${MIN_SQRT_RATIO.toString()}, MAX_SQRT_RATIO: ${MAX_SQRT_RATIO.toString()}`);
                 return null;
            }
            // --- End Validation ---

            // --- Calculate tick from sqrtPrice ---
            try {
                 tickFromSqrtPrice = TickMath.getTickAtSqrtRatio(sqrtPriceJSBI);
                 console.log(`${context} Calculated tick from sqrtPriceX96 (${poolState.sqrtPriceX96}): ${tickFromSqrtPrice}`);
            } catch (tickMathError) {
                 log.error(`${context} Unexpected error calculating tick from VALIDATED sqrtPriceX96 (${poolState.sqrtPriceX96}): ${tickMathError.message}`);
                 throw tickMathError;
            }
            // --- End Tick Calculation ---

            // --- Adjust Tick to Tick Spacing ---
            adjustedTick = Math.round(tickFromSqrtPrice / tickSpacing) * tickSpacing;
            if (adjustedTick !== tickFromSqrtPrice) {
                console.log(`${context} Adjusted tick calculated from price (${tickFromSqrtPrice}) to NEAREST ${adjustedTick} for tickSpacing ${tickSpacing}`);
            } else {
                console.log(`${context} Tick calculated from price (${tickFromSqrtPrice}) is already multiple of tickSpacing ${tickSpacing}`);
            }
            // --- End Tick Adjustment ---

            // --- Fee Mapping (Use imported helper) ---
            const feeAmountEnum = getFeeAmountEnum(poolState.fee);
            if (feeAmountEnum === undefined) {
                log.error(`${context} Invalid or unsupported fee tier (${poolState.fee}) found in poolState.`);
                return null;
            }
            // --- End Fee Mapping ---

            // --- Add Debug Logging ---
            console.log(`${context} ---> DEBUG: Attempting Pool constructor with:`);
            console.log(`${context}      tokenA: ${tokenA.symbol} (${tokenA.address})`);
            console.log(`${context}      tokenB: ${tokenB.symbol} (${tokenB.address})`);
            console.log(`${context}      Fee (Enum Value): ${feeAmountEnum}, Type: ${typeof feeAmountEnum}`);
            console.log(`${context}      sqrtPriceX96 (JSBI): ${sqrtPriceJSBI.toString()}`);
            const liquidityJSBI = JSBI.BigInt(poolState.liquidity.toString());
            console.log(`${context}      liquidity (JSBI): ${liquidityJSBI.toString()}`);
            console.log(`${context}      tickCurrent (Adjusted): ${adjustedTick}`);
            console.log(`${context}      tickDataProvider present: ${!!this.tickDataProvider}`);
            // --- End Debug Logging ---

            console.log(`${context} ===> PREPARING TO CALL new Pool(...) with adjusted tick: ${adjustedTick} and fee enum: ${feeAmountEnum}`);

            // --- Instantiate SDK Pool ---
            const pool = new Pool(
                tokenA, tokenB, feeAmountEnum, sqrtPriceJSBI, liquidityJSBI, adjustedTick, this.tickDataProvider
            );
            // --- End Pool Instantiation ---

            console.log(`${context} ===> SUCCESSFULLY CALLED new Pool(...) - SDK derived tickCurrent: ${pool.tickCurrent}`);
            log.debug(`${context} SDK Pool instance created. Proceeding to Trade.fromRoute...`);

            // --- Simulate Trade ---
            const swapRoute = new Route([pool], tokenIn, tokenOut);
            const currencyAmountIn = CurrencyAmount.fromRawAmount(tokenIn, amountInStr);
            const trade = await Trade.fromRoute( swapRoute, currencyAmountIn, TradeType.EXACT_INPUT );
            // --- End Trade Simulation ---

            log.debug(`${context} Trade.fromRoute finished.`);

            if (!trade || !trade.outputAmount || !trade.outputAmount.quotient) {
                log.error(`${context} Trade simulation failed or returned invalid output.`);
                console.error("Trade object:", stringifyPoolState(trade)); // Use helper to log trade object safely
                return null;
            }

            const amountOutBI = BigInt(trade.outputAmount.quotient.toString());
            log.info(`${context} Simulation successful. Output Amount: ${amountOutBI}`);
            return {
                amountOut: amountOutBI,
                sdkTokenIn: tokenIn,
                sdkTokenOut: tokenOut,
                trade: trade // Return the trade object itself
            };

        } catch (error) {
            console.error(`${context} !!!!!!!!!!!!!! CATCH BLOCK in simulateSingleSwapExactIn !!!!!!!!!!!!!!`);
            log.error(`${context} Error during single swap simulation: ${error.message}`);
            log.error(`${context} Details: SqrtPriceX96=${poolState?.sqrtPriceX96?.toString() || 'N/A'}, TickFromSqrtPrice=${tickFromSqrtPrice}, AdjustedTick=${adjustedTick}, Spacing=${tickSpacing}`);

            if (error.message?.toLowerCase().includes('insufficient liquidity')) {
                log.warn(`${context} SDK Error: INSUFFICIENT LIQUIDITY for this trade amount.`);
            } else if (error.message?.includes('already') || error.message?.includes('TICK') || error.message?.includes('PRICE_BOUNDS') || error.message?.includes('SQRT_RATIO') || error.message?.includes('FEE')) {
                log.error(`${context} SDK Invariant Error: ${error.message}`);
            }
            ErrorHandler.handleError(error, context, {
                poolAddress: poolState?.address || 'N/A',
                amountIn: amountInStr,
                sqrtPriceX96: poolState?.sqrtPriceX96?.toString(),
                tickFromSqrtPrice,
                adjustedTick,
                feeBps: poolState?.fee
            });
            return null; // Return null on any simulation error
        }
    }

    // simulateArbitrage method removed
}

module.exports = QuoteSimulator;
