// /workspaces/arbitrum-flash/core/quoteSimulator.js - Fix undefined poolState & ReferenceError
const { Pool, Route, Trade } = require('@uniswap/v3-sdk');
const { Token, CurrencyAmount, TradeType } = require('@uniswap/sdk-core');
const { ethers } = require('ethers');
const logger = require('../utils/logger'); // Keep logger for regular messages
const ErrorHandler = require('../utils/errorHandler');

class QuoteSimulator {
    constructor(tickDataProvider) {
        if (!tickDataProvider || typeof tickDataProvider.getPopulatedTicksInRange !== 'function') { console.error("[QuoteSimulator Constructor] FATAL: Invalid TickDataProvider instance provided."); throw new Error("Valid TickDataProvider instance required for QuoteSimulator."); }
        this.tickDataProvider = tickDataProvider;
        console.log("[QuoteSimulator] Instance created with TickDataProvider.");
    }

    // Updated helper to handle undefined/null and potential stringify errors
    stringifyPoolState(state) {
        if (state === undefined || state === null) {
            return "undefined or null";
        }
         try {
             // Basic check for core properties before stringifying fully
             if (typeof state.address !== 'string' || typeof state.tick === 'undefined' || typeof state.sqrtPriceX96 === 'undefined') {
                 return `Incomplete Pool State Object: ${JSON.stringify(state)}`; // Log what we have
             }
             return JSON.stringify(state, (key, value) =>
                 typeof value === 'bigint' ? value.toString() : value, 2);
         } catch(e) {
              // Attempt to log the keys if full stringify fails
              const keys = typeof state === 'object' ? Object.keys(state).join(', ') : 'N/A';
              return `Error stringifying pool state: ${e.message}. Keys found: ${keys}`;
         }
    }


    async simulateSingleSwapExactIn(poolState, tokenIn, tokenOut, amountIn) {
        const log = logger || console;
        const context = `[SimSwap ${tokenIn?.symbol}->${tokenOut?.symbol} (${poolState?.fee}bps)]`;
        if (!this.tickDataProvider) { console.error(`${context} FATAL: TickDataProvider is missing on simulator instance.`); return null; }

        // --- Input Validation - CRITICAL check for poolState ---
        if (!poolState) {
             log.error(`${context} FATAL ERROR: Received null or undefined poolState in simulateSingleSwapExactIn.`);
             return null; // Cannot proceed
        }
        // Check other required fields
        if (!tokenIn || !tokenOut || !poolState.sqrtPriceX96 || !poolState.liquidity || typeof poolState.tick === 'undefined' || !poolState.fee || typeof poolState.tickSpacing !== 'number' ) { // check type of tickSpacing
            log.error(`${context} Invalid poolState fields or missing tokens/tickSpacing.`); // Changed to error
            console.error("Problematic PoolState in simulateSingleSwapExactIn:", this.stringifyPoolState(poolState)); // Log the bad state
            return null;
        }
        if (!(tokenIn instanceof Token) || !(tokenOut instanceof Token)) { log.warn(`${context} Invalid SDK Token instances.`); return null; }
        if (amountIn <= 0n) { log.warn(`${context} Non-positive amountIn.`); return { amountOut: 0n, sdkTokenIn: tokenIn, sdkTokenOut: tokenOut, trade: null }; }
        const amountInStr = amountIn.toString(); if (!/^\d+$/.test(amountInStr)) { log.warn(`${context} Invalid amountIn format.`); return null; }

        console.log(`\n--- ${context} ---`);
        console.log(`TokenIn: ${tokenIn.symbol}, TokenOut: ${tokenOut.symbol}, AmountIn: ${amountInStr}`);

        // Define variables in the outer scope
        let tickNumberRaw;
        let tickNumberAdjusted;
        let tickSpacing;

        try {
            const [tokenA, tokenB] = tokenIn.sortsBefore(tokenOut) ? [tokenIn, tokenOut] : [tokenOut, tokenIn];
            tickNumberRaw = Number(poolState.tick);
            tickSpacing = Number(poolState.tickSpacing);

            if (isNaN(tickNumberRaw) || isNaN(tickSpacing) || tickSpacing <= 0) {
                log.error(`${context} Invalid raw tick number (${tickNumberRaw}) or tickSpacing (${tickSpacing}).`); // Changed to error
                return null;
            }

            tickNumberAdjusted = Math.floor(tickNumberRaw / tickSpacing) * tickSpacing;

            if (tickNumberAdjusted !== tickNumberRaw) {
                console.log(`${context} Adjusted raw tick ${tickNumberRaw} to ${tickNumberAdjusted} for tickSpacing ${tickSpacing}`);
            }

            console.log(`${context} ===> PREPARING TO CALL new Pool(...) with adjusted tick ${tickNumberAdjusted}`);

            const pool = new Pool(
                tokenA, tokenB, poolState.fee,
                poolState.sqrtPriceX96.toString(),
                poolState.liquidity.toString(),
                tickNumberAdjusted, // Use adjusted tick
                { // Tick Provider Wrapper (same)
                    getTick: async (tick) => {
                        console.log(`${context} >>> SDK requesting getTick(${tick})`);
                        const result = await this.tickDataProvider.getTick(tick, tickSpacing, poolState.address);
                        console.log(`${context} <<< Provider returned for getTick(${tick}): ${result ? `{ liquidityNet: ${result.liquidityNet} }` : 'null'}`);
                        return result;
                    },
                    nextInitializedTickWithinOneWord: async (tick, lte) => {
                        console.log(`${context} >>> SDK requesting nextInitializedTickWithinOneWord(tick=${tick}, lte=${lte})`);
                        const result = await this.tickDataProvider.nextInitializedTickWithinOneWord(tick, lte, tickSpacing, poolState.address);
                        console.log(`${context} <<< Provider returned for nextInitializedTickWithinOneWord(tick=${tick}, lte=${lte}): ${result}`);
                        return result;
                    }
                }
            );

            console.log(`${context} ===> SUCCESSFULLY CALLED new Pool(...)`);
            log.debug(`${context} SDK Pool instance created. Proceeding to Trade.fromRoute...`);

            const swapRoute = new Route([pool], tokenIn, tokenOut);
            const trade = await Trade.fromRoute( swapRoute, CurrencyAmount.fromRawAmount(tokenIn, amountInStr), TradeType.EXACT_INPUT );

            log.debug(`${context} Trade.fromRoute finished.`);

            if (!trade || !trade.outputAmount || !trade.outputAmount.quotient) {
                 log.warn(`${context} SDK Trade creation failed or returned no output.`);
                 if (trade) log.debug(`${context} Trade details: ${JSON.stringify(trade)}`);
                 return { amountOut: 0n, sdkTokenIn: tokenIn, sdkTokenOut: tokenOut, trade: trade };
            }
            const amountOutBI = BigInt(trade.outputAmount.quotient.toString());
             log.info(`${context} Simulation successful. Output Amount: ${amountOutBI}`); // Changed to info
            return { amountOut: amountOutBI, sdkTokenIn: tokenIn, sdkTokenOut: tokenOut, trade: trade };

        } catch (error) {
            console.error(`${context} !!!!!!!!!!!!!! CATCH BLOCK in simulateSingleSwapExactIn !!!!!!!!!!!!!!`);
            log.error(`${context} Error during single swap simulation: ${error.message}`);
             // Log ticks safely, checking if they were defined
             log.error(`${context} Details: RawTick=${typeof tickNumberRaw !== 'undefined' ? tickNumberRaw : 'N/A'}, AdjustedTick=${typeof tickNumberAdjusted !== 'undefined' ? tickNumberAdjusted : 'N/A'}, Spacing=${typeof tickSpacing !== 'undefined' ? tickSpacing : 'N/A'}`);
            if (error.message?.toLowerCase().includes('insufficient liquidity')) { log.error(`${context} SDK Error: INSUFFICIENT LIQUIDITY...`); }
            else if (error.message?.includes('already') || error.message?.includes('TICK') || error.message?.includes('PRICE_BOUNDS')) { // Added PRICE_BOUNDS
                log.error(`${context} SDK Error: TICK/PRICE invariant issue... Error: ${error.message}`);
            }
            ErrorHandler.handleError(error, context, { poolAddress: poolState?.address || 'N/A', amountIn: amountInStr, tickRaw: tickNumberRaw, tickAdjusted: tickNumberAdjusted });
            return null; // Return null on error
        }
    }


    async simulateArbitrage(opportunity, initialAmount) {
        const log = logger || console;
        const logPrefix = `[SimArb OppType: ${opportunity?.type}, Group: ${opportunity?.groupName}]`;
        if (!opportunity || !opportunity.type || typeof initialAmount === 'undefined' || initialAmount <= 0n) { log.warn(`${logPrefix} Invalid input.`); return { profitable: false, error: 'Invalid input', initialAmount: initialAmount || 0n, finalAmount: 0n, grossProfit: 0n, details: null }; }
        log.info(`--- Simulation START ${logPrefix} ---`);
        log.info(`Initial Amount: ${ethers.formatUnits(initialAmount, opportunity.pools?.[0]?.token0?.decimals || 18)} ${opportunity.pathSymbols?.[0]}`);

        if (opportunity.type === 'triangular') {
             if (!opportunity.pools || opportunity.pools.length !== 3 || !opportunity.pathSymbols || opportunity.pathSymbols.length !== 4) { log.error(`${logPrefix} Invalid triangular opportunity structure.`); return { profitable: false, error: 'Invalid triangular structure', initialAmount, finalAmount: 0n, grossProfit: 0n, details: null }; }

             console.log(`${logPrefix} Raw opportunity.pools check: pool[0]?.address=${opportunity.pools[0]?.address}, pool[1]?.address=${opportunity.pools[1]?.address}, pool[2]?.address=${opportunity.pools[2]?.address}`); // Simple check

             const [pool1, pool2, pool3] = opportunity.pools;

             // --- Log pools immediately after destructuring - CRITICAL CHECK ---
             console.log(`${logPrefix} Pool 1 Check After Destructure: Is defined? ${!!pool1}, Address: ${pool1?.address}`);
             console.log(`${logPrefix} Pool 2 Check After Destructure: Is defined? ${!!pool2}, Address: ${pool2?.address}`);
             console.log(`${logPrefix} Pool 3 Check After Destructure: Is defined? ${!!pool3}, Address: ${pool3?.address}`);
             // ---

             // Add explicit check if pools are undefined after destructuring
              if (!pool1 || !pool2 || !pool3) {
                  log.error(`${logPrefix} FATAL: One or more pools are undefined after destructuring from opportunity.pools.`);
                   console.error("Original opportunity.pools:", opportunity.pools); // Log the source array
                  return { profitable: false, error: 'Pool definition missing after destructure', initialAmount, finalAmount: 0n, grossProfit: 0n, details: null };
              }


             const [symA, symB, symC, symA_final] = opportunity.pathSymbols;
             if (symA !== symA_final) { log.error(`${logPrefix} Path symbols mismatch.`); return { profitable: false, error: 'Path symbols mismatch', initialAmount, finalAmount: 0n, grossProfit: 0n, details: null }; }

             // Resolve Tokens (Safe access already added)
             const tokenA = pool1.token0?.symbol === symA ? pool1.token0 : (pool1.token1?.symbol === symA ? pool1.token1 : null);
             const tokenB = pool1.token0?.symbol === symB ? pool1.token0 : (pool1.token1?.symbol === symB ? pool1.token1 : null);
             const tokenC = pool2.token0?.symbol === symC ? pool2.token0 : (pool2.token1?.symbol === symC ? pool2.token1 : null);
             if (!(tokenA instanceof Token) || !(tokenB instanceof Token) || !(tokenC instanceof Token)) { log.error(`${logPrefix} SDK Token resolution failed.`); return { profitable: false, error: 'SDK Token resolution failed', initialAmount, finalAmount: 0n, grossProfit: 0n, details: null }; }

             // Pool token validation (Safe access already added)
             const pool1Matches = (pool1.token0 === tokenA && pool1.token1 === tokenB) || (pool1.token0 === tokenB && pool1.token1 === tokenA);
             const pool2Matches = (pool2.token0 === tokenB && pool2.token1 === tokenC) || (pool2.token0 === tokenC && pool2.token1 === tokenB);
             const pool3Matches = (pool3.token0 === tokenC && pool3.token1 === tokenA) || (pool3.token0 === tokenA && pool3.token1 === tokenC);
             if (!pool1Matches || !pool2Matches || !pool3Matches) { log.error(`${logPrefix} Pool tokens mismatch path.`); return { profitable: false, error: 'Pool tokens mismatch path', initialAmount, finalAmount: 0n, grossProfit: 0n, details: null }; }

            try {
                // Log states before calling sim (using variable names now)
                console.log(`${logPrefix} POOL 1 STATE before calling simulateSingleSwapExactIn (from var pool1):`); console.log(this.stringifyPoolState(pool1));
                const hop1Result = await this.simulateSingleSwapExactIn(pool1, tokenA, tokenB, initialAmount);
                // Critical Check: If hop1Result is null, cannot proceed
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

                // Profit Calculation (Same)
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
