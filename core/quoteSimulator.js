// /workspaces/arbitrum-flash/core/quoteSimulator.js - Validate SqrtPriceX96 Range
const { Pool, Route, Trade, TickMath } = require('@uniswap/v3-sdk');
const { Token, CurrencyAmount, TradeType } = require('@uniswap/sdk-core');
const { ethers } = require('ethers');
const JSBI = require('jsbi');
const logger = require('../utils/logger');
const ErrorHandler = require('../utils/errorHandler');

// --- Define MIN/MAX SqrtRatio constants (copied from SDK for direct comparison) ---
// These might need adjustment if using a different SDK version, but are standard V3 limits
const MIN_SQRT_RATIO = JSBI.BigInt('4295128739');
const MAX_SQRT_RATIO = JSBI.BigInt('1461446703485210103287273052203988822378723970342');
// ---

class QuoteSimulator {
    constructor(tickDataProvider) {
        if (!tickDataProvider || typeof tickDataProvider.getPopulatedTicksInRange !== 'function') { console.error("[QuoteSimulator Constructor] FATAL: Invalid TickDataProvider instance provided."); throw new Error("Valid TickDataProvider instance required for QuoteSimulator."); }
        this.tickDataProvider = tickDataProvider;
        console.log("[QuoteSimulator] Instance created with TickDataProvider.");
    }

    stringifyPoolState(state) { /* ... */ }

    async simulateSingleSwapExactIn(poolState, tokenIn, tokenOut, amountIn) {
        const log = logger || console;
        const context = `[SimSwap ${tokenIn?.symbol}->${tokenOut?.symbol} (${poolState?.fee}bps)]`;
        if (!this.tickDataProvider) { /* ... */ }
        if (!poolState) { /* ... */ }
        // Check required fields including sqrtPriceX96 type
        if (!tokenIn || !tokenOut || typeof poolState.sqrtPriceX96 !== 'bigint' || !poolState.liquidity || typeof poolState.tick === 'undefined' || !poolState.fee || typeof poolState.tickSpacing !== 'number' ) { log.error(`${context} Invalid poolState fields or missing tokens/tickSpacing/sqrtPrice.`); console.error("Problematic PoolState:", this.stringifyPoolState(poolState)); return null; }
        if (!(tokenIn instanceof Token) || !(tokenOut instanceof Token)) { /* ... */ }
        if (amountIn <= 0n) { /* ... */ }
        const amountInStr = amountIn.toString(); if (!/^\d+$/.test(amountInStr)) { /* ... */ }

        console.log(`\n--- ${context} ---`);
        console.log(`TokenIn: ${tokenIn.symbol}, TokenOut: ${tokenOut.symbol}, AmountIn: ${amountInStr}`);

        let tickFromSqrtPrice = 'N/A';
        let tickAdjusted = 'N/A';
        let tickSpacing = 'N/A';
        let sqrtPriceJSBI; // Define here for catch block

        try {
            const [tokenA, tokenB] = tokenIn.sortsBefore(tokenOut) ? [tokenIn, tokenOut] : [tokenOut, tokenIn];
            tickSpacing = Number(poolState.tickSpacing);

            if (isNaN(tickSpacing) || tickSpacing <= 0) { log.error(`${context} Invalid tickSpacing (${poolState.tickSpacing}).`); return null; }

            // --- Validate sqrtPriceX96 range BEFORE using it ---
            sqrtPriceJSBI = JSBI.BigInt(poolState.sqrtPriceX96.toString());
            if (JSBI.lessThan(sqrtPriceJSBI, MIN_SQRT_RATIO) || JSBI.greaterThan(sqrtPriceJSBI, MAX_SQRT_RATIO)) {
                 log.error(`${context} sqrtPriceX96 (${poolState.sqrtPriceX96}) is outside the valid SDK range.`);
                 console.error(`MIN_SQRT_RATIO: ${MIN_SQRT_RATIO.toString()}, MAX_SQRT_RATIO: ${MAX_SQRT_RATIO.toString()}`);
                 // Treat as invalid data, cannot simulate
                 return null;
            }
            // --- End Validation ---


            // --- Calculate tick from sqrtPrice (should now succeed if validation passes) ---
            try {
                 tickFromSqrtPrice = TickMath.getTickAtSqrtRatio(sqrtPriceJSBI); // Pass validated JSBI
                 console.log(`${context} Calculated tick from sqrtPriceX96 (${poolState.sqrtPriceX96}): ${tickFromSqrtPrice}`);
            } catch (tickMathError) {
                 // This catch should ideally not be hit now, but keep for safety
                 log.error(`${context} Unexpected error calculating tick from VALIDATED sqrtPriceX96 (${poolState.sqrtPriceX96}): ${tickMathError.message}`);
                 throw tickMathError;
            }

            tickAdjusted = Math.round(tickFromSqrtPrice / tickSpacing) * tickSpacing;
            if (tickAdjusted !== tickFromSqrtPrice) { console.log(`${context} Adjusted tick calculated from price (${tickFromSqrtPrice}) to NEAREST ${tickAdjusted} for tickSpacing ${tickSpacing}`); }
            else { console.log(`${context} Tick calculated from price (${tickFromSqrtPrice}) is already multiple of tickSpacing ${tickSpacing}`); }
            // --- End Tick Calculation/Adjustment ---

            console.log(`${context} ===> PREPARING TO CALL new Pool(...) with tick derived from sqrtPrice and adjusted: ${tickAdjusted}`);

            const pool = new Pool( /* ... same as before ... */ );
            console.log(`${context} ===> SUCCESSFULLY CALLED new Pool(...) - SDK derived tick: ${pool.tickCurrent}`);
            log.debug(`${context} SDK Pool instance created. Proceeding to Trade.fromRoute...`);

            const swapRoute = new Route([pool], tokenIn, tokenOut);
            const trade = await Trade.fromRoute( swapRoute, CurrencyAmount.fromRawAmount(tokenIn, amountInStr), TradeType.EXACT_INPUT );

            log.debug(`${context} Trade.fromRoute finished.`);

            if (!trade || !trade.outputAmount || !trade.outputAmount.quotient) { /* ... */ }
            const amountOutBI = BigInt(trade.outputAmount.quotient.toString());
             log.info(`${context} Simulation successful. Output Amount: ${amountOutBI}`);
            return { amountOut: amountOutBI, sdkTokenIn: tokenIn, sdkTokenOut: tokenOut, trade: trade };

        } catch (error) {
            console.error(`${context} !!!!!!!!!!!!!! CATCH BLOCK in simulateSingleSwapExactIn !!!!!!!!!!!!!!`);
            log.error(`${context} Error during single swap simulation: ${error.message}`);
            // Log validated SqrtPrice if available
            log.error(`${context} Details: SqrtPriceX96=${poolState?.sqrtPriceX96?.toString() || 'N/A'}, TickFromSqrtPrice=${tickFromSqrtPrice}, AdjustedTick=${tickAdjusted}, Spacing=${tickSpacing}`);
            if (error.message?.toLowerCase().includes('insufficient liquidity')) { log.error(`${context} SDK Error: INSUFFICIENT LIQUIDITY...`); }
            else if (error.message?.includes('already') || error.message?.includes('TICK') || error.message?.includes('PRICE_BOUNDS') || error.message?.includes('SQRT_RATIO')) { log.error(`${context} SDK Error: TICK/PRICE/SQRT_RATIO invariant issue... Error: ${error.message}`); }
            ErrorHandler.handleError(error, context, { poolAddress: poolState?.address || 'N/A', amountIn: amountInStr, sqrtPriceX96: poolState?.sqrtPriceX96?.toString(), tickFromSqrtPrice, tickAdjusted });
            return null; // Return null on error
        }
    }

    // simulateArbitrage remains the same
    async simulateArbitrage(opportunity, initialAmount) {
        const log = logger || console;
        const logPrefix = `[SimArb OppType: ${opportunity?.type}, Group: ${opportunity?.groupName}]`;
        if (!opportunity || !opportunity.type || typeof initialAmount === 'undefined' || initialAmount <= 0n) { /* ... */ }
        log.info(`--- Simulation START ${logPrefix} ---`);
        log.info(`Initial Amount: ${ethers.formatUnits(initialAmount, opportunity.pools?.[0]?.token0?.decimals || 18)} ${opportunity.pathSymbols?.[0]}`);

        if (opportunity.type === 'triangular') {
             if (!opportunity.pools || opportunity.pools.length !== 3 || !opportunity.pathSymbols || opportunity.pathSymbols.length !== 4) { /* ... */ }
             console.log(`${logPrefix} Raw opportunity.pools check: pool[0]?.address=${opportunity.pools[0]?.address}, pool[1]?.address=${opportunity.pools[1]?.address}, pool[2]?.address=${opportunity.pools[2]?.address}`);
             const [pool1, pool2, pool3] = opportunity.pools;
             console.log(`${logPrefix} Pool 1 Check After Destructure: Is defined? ${!!pool1}, Address: ${pool1?.address}`);
             console.log(`${logPrefix} Pool 2 Check After Destructure: Is defined? ${!!pool2}, Address: ${pool2?.address}`);
             console.log(`${logPrefix} Pool 3 Check After Destructure: Is defined? ${!!pool3}, Address: ${pool3?.address}`);
              if (!pool1 || !pool2 || !pool3) { /* ... */ }
             const [symA, symB, symC, symA_final] = opportunity.pathSymbols;
             if (symA !== symA_final) { /* ... */ }
             const tokenA = pool1.token0?.symbol === symA ? pool1.token0 : (pool1.token1?.symbol === symA ? pool1.token1 : null);
             const tokenB = pool1.token0?.symbol === symB ? pool1.token0 : (pool1.token1?.symbol === symB ? pool1.token1 : null);
             const tokenC = pool2.token0?.symbol === symC ? pool2.token0 : (pool2.token1?.symbol === symC ? pool2.token1 : null);
             if (!(tokenA instanceof Token) || !(tokenB instanceof Token) || !(tokenC instanceof Token)) { /* ... */ }
             const pool1Matches = (pool1.token0 === tokenA && pool1.token1 === tokenB) || (pool1.token0 === tokenB && pool1.token1 === tokenA);
             const pool2Matches = (pool2.token0 === tokenB && pool2.token1 === tokenC) || (pool2.token0 === tokenC && pool2.token1 === tokenB);
             const pool3Matches = (pool3.token0 === tokenC && pool3.token1 === tokenA) || (pool3.token0 === tokenA && pool3.token1 === tokenC);
             if (!pool1Matches || !pool2Matches || !pool3Matches) { /* ... */ }

            try {
                console.log(`${logPrefix} POOL 1 STATE before calling simulateSingleSwapExactIn (from var pool1):`); console.log(this.stringifyPoolState(pool1));
                const hop1Result = await this.simulateSingleSwapExactIn(pool1, tokenA, tokenB, initialAmount);
                 if (!hop1Result) { log.error(`${logPrefix} Hop 1 simulation returned null. Aborting arbitrage simulation.`); return { profitable: false, error: 'Hop 1 sim failed (returned null)', initialAmount, finalAmount: 0n, grossProfit: 0n, details: { hop1Result: null } }; }
                 if (hop1Result.amountOut == null) { log.warn(`${logPrefix} Hop 1 simulation failed (null amountOut).`); return { profitable: false, error: 'Hop 1 sim failed (null amountOut)', initialAmount, finalAmount: 0n, grossProfit: 0n, details: { hop1Result } }; }
                const amountB_Received = hop1Result.amountOut;
                log.info(`[SIM Hop 1 ${tokenA.symbol}->${tokenB.symbol}] Output: ${ethers.formatUnits(amountB_Received, tokenB.decimals)} ${tokenB.symbol}`);
                if (amountB_Received <= 0n) { log.warn(`${logPrefix} Hop 1 output is zero or less.`); return { profitable: false, error: 'Hop 1 zero output', initialAmount, finalAmount: 0n, grossProfit: 0n, details: { hop1Result } }; }

                console.log(`${logPrefix} POOL 2 STATE before calling simulateSingleSwapExactIn (from var pool2):`); console.log(this.stringifyPoolState(pool2));
                const hop2Result = await this.simulateSingleSwapExactIn(pool2, tokenB, tokenC, amountB_Received);
                 if (!hop2Result) { log.error(`${logPrefix} Hop 2 simulation returned null. Aborting arbitrage simulation.`); return { profitable: false, error: 'Hop 2 sim failed (returned null)', initialAmount, finalAmount: 0n, grossProfit: 0n, details: { hop1Result, hop2Result: null } }; }
                 if (hop2Result.amountOut == null) { log.warn(`${logPrefix} Hop 2 simulation failed (null amountOut).`); return { profitable: false, error: 'Hop 2 sim failed (null amountOut)', initialAmount, finalAmount: 0n, grossProfit: 0n, details: { hop1Result, hop2Result } }; }
                const amountC_Received = hop2Result.amountOut;
                log.info(`[SIM Hop 2 ${tokenB.symbol}->${tokenC.symbol}] Output: ${ethers.formatUnits(amountC_Received, tokenC.decimals)} ${tokenC.symbol}`);
                if (amountC_Received <= 0n) { log.warn(`${logPrefix} Hop 2 output is zero or less.`); return { profitable: false, error: 'Hop 2 zero output', initialAmount, finalAmount: 0n, grossProfit: 0n, details: { hop1Result, hop2Result } }; }

                console.log(`${logPrefix} POOL 3 STATE before calling simulateSingleSwapExactIn (from var pool3):`); console.log(this.stringifyPoolState(pool3));
                const hop3Result = await this.simulateSingleSwapExactIn(pool3, tokenC, tokenA, amountC_Received);
                 if (!hop3Result) { log.error(`${logPrefix} Hop 3 simulation returned null. Aborting arbitrage simulation.`); return { profitable: false, error: 'Hop 3 sim failed (returned null)', initialAmount, finalAmount: 0n, grossProfit: 0n, details: { hop1Result, hop2Result, hop3Result: null } }; }
                 if (hop3Result.amountOut == null) { log.warn(`${logPrefix} Hop 3 simulation failed (null amountOut).`); return { profitable: false, error: 'Hop 3 sim failed (null amountOut)', initialAmount, finalAmount: 0n, grossProfit: 0n, details: { hop1Result, hop2Result, hop3Result } }; }
                const finalAmount = hop3Result.amountOut;
                log.info(`[SIM Hop 3 ${tokenC.symbol}->${tokenA.symbol}] Output: ${ethers.formatUnits(finalAmount, tokenA.decimals)} ${tokenA.symbol}`);

                const grossProfit = finalAmount - initialAmount;
                const profitable = grossProfit > 0n;
                log.info(`${logPrefix} Gross Profit: ${ethers.formatUnits(grossProfit, tokenA.decimals)} ${tokenA.symbol}`);
                log.info(`${logPrefix} Trade Profitable (Gross): ${profitable ? 'YES' : 'NO'}`);
                log.info(`--- Simulation END ${logPrefix} ---`);
                return { profitable, error: null, initialAmount, finalAmount, grossProfit, details: { hop1Result, hop2Result, hop3Result } };
            } catch (error) {
                 console.error(`${logPrefix} !!!!!!!!!!!!!! CATCH BLOCK in simulateArbitrage !!!!!!!!!!!!!!`);
                 log.error(`${logPrefix} UNEXPECTED High-Level Error during hop simulation: ${error.message}`);
                ErrorHandler.handleError(error, logPrefix);
                return { profitable: false, error: `High-level sim error: ${error.message}`, initialAmount, finalAmount: 0n, grossProfit: 0n, details: null };
            }
        }
        else if (opportunity.type === 'cyclic') { /* ... */ }
        else { /* ... */ }
    }
}
module.exports = QuoteSimulator;
