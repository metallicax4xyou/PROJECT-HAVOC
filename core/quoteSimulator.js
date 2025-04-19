// /workspaces/arbitrum-flash/core/quoteSimulator.js - Added Tick Adjustment
const { Pool, Route, Trade } = require('@uniswap/v3-sdk');
const { Token, CurrencyAmount, TradeType } = require('@uniswap/sdk-core');
const { ethers } = require('ethers');
const logger = require('../utils/logger'); // Keep logger for regular messages
const ErrorHandler = require('../utils/errorHandler');

class QuoteSimulator {
    constructor(tickDataProvider) {
        if (!tickDataProvider || typeof tickDataProvider.getPopulatedTicksInRange !== 'function') { console.error("[QuoteSimulator Constructor] FATAL: Invalid TickDataProvider instance provided."); throw new Error("Valid TickDataProvider instance required for QuoteSimulator."); }
        this.tickDataProvider = tickDataProvider;
        console.log("[QuoteSimulator] Instance created with TickDataProvider."); // Use console
    }

    stringifyPoolState(state) { /* ... (keep helper) ... */ }

    async simulateSingleSwapExactIn(poolState, tokenIn, tokenOut, amountIn) {
        const log = logger || console;
        const context = `[SimSwap ${tokenIn?.symbol}->${tokenOut?.symbol} (${poolState?.fee}bps)]`;
        if (!this.tickDataProvider) { console.error(`${context} FATAL: TickDataProvider is missing on simulator instance.`); return null; }

        // Input Validation (Same)
        if (!poolState || !tokenIn || !tokenOut || !poolState.sqrtPriceX96 || !poolState.liquidity || typeof poolState.tick === 'undefined' || !poolState.fee || !poolState.tickSpacing) { log.warn(`${context} Invalid poolState/tokens (missing fields).`); return null; } // Added tickSpacing check
        if (!(tokenIn instanceof Token) || !(tokenOut instanceof Token)) { log.warn(`${context} Invalid SDK Token instances.`); return null; }
        if (amountIn <= 0n) { log.warn(`${context} Non-positive amountIn.`); return { amountOut: 0n, sdkTokenIn: tokenIn, sdkTokenOut: tokenOut, trade: null }; }
        const amountInStr = amountIn.toString(); if (!/^\d+$/.test(amountInStr)) { log.warn(`${context} Invalid amountIn format.`); return null; }

        console.log(`\n--- ${context} ---`);
        console.log(`Pool State Received by simulateSingleSwapExactIn:`);
        console.log(this.stringifyPoolState(poolState));
        console.log(`TokenIn: ${tokenIn.symbol}, TokenOut: ${tokenOut.symbol}, AmountIn: ${amountInStr}`);

        try {
            const [tokenA, tokenB] = tokenIn.sortsBefore(tokenOut) ? [tokenIn, tokenOut] : [tokenOut, tokenIn];
            const tickNumberRaw = Number(poolState.tick);
            const tickSpacing = Number(poolState.tickSpacing); // Ensure tickSpacing is a number

            if (isNaN(tickNumberRaw) || isNaN(tickSpacing) || tickSpacing <= 0) {
                log.warn(`${context} Invalid raw tick number (${tickNumberRaw}) or tickSpacing (${tickSpacing}).`);
                return null;
            }

            // --- Adjust tick down to the nearest multiple of tickSpacing ---
            const tickNumberAdjusted = Math.floor(tickNumberRaw / tickSpacing) * tickSpacing;
            // --- End Adjustment ---

            if (tickNumberAdjusted !== tickNumberRaw) {
                console.log(`${context} Adjusted raw tick ${tickNumberRaw} to ${tickNumberAdjusted} for tickSpacing ${tickSpacing}`);
            }

            console.log(`${context} ===> PREPARING TO CALL new Pool(...) with adjusted tick ${tickNumberAdjusted}`);

            // Create Uniswap SDK Pool Instance using ADJUSTED tick
            const pool = new Pool(
                tokenA, tokenB, poolState.fee,
                poolState.sqrtPriceX96.toString(),
                poolState.liquidity.toString(),
                tickNumberAdjusted, // Use the adjusted tick here
                { // Tick Provider Wrapper (Same)
                    getTick: async (tick) => {
                        console.log(`${context} >>> SDK requesting getTick(${tick})`);
                        const result = await this.tickDataProvider.getTick(tick, tickSpacing, poolState.address); // Pass original spacing
                        console.log(`${context} <<< Provider returned for getTick(${tick}): ${result ? `{ liquidityNet: ${result.liquidityNet} }` : 'null'}`);
                        return result;
                    },
                    nextInitializedTickWithinOneWord: async (tick, lte) => {
                        console.log(`${context} >>> SDK requesting nextInitializedTickWithinOneWord(tick=${tick}, lte=${lte})`);
                        const result = await this.tickDataProvider.nextInitializedTickWithinOneWord(tick, lte, tickSpacing, poolState.address); // Pass original spacing
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
             log.debug(`${context} Simulation successful. Output Amount: ${amountOutBI}`);
            return { amountOut: amountOutBI, sdkTokenIn: tokenIn, sdkTokenOut: tokenOut, trade: trade };

        } catch (error) {
            console.error(`${context} !!!!!!!!!!!!!! CATCH BLOCK in simulateSingleSwapExactIn !!!!!!!!!!!!!!`);
            log.error(`${context} Error during single swap simulation: ${error.message}`);
            // Add more context to the error log, including the ticks used
            log.error(`${context} Details: RawTick=${tickNumberRaw}, AdjustedTick=${tickNumberAdjusted}, Spacing=${tickSpacing}`);
            if (error.message?.toLowerCase().includes('insufficient liquidity')) { log.error(`${context} SDK Error: INSUFFICIENT LIQUIDITY...`); }
            else if (error.message?.includes('already') || error.message?.includes('TICK')) { log.error(`${context} SDK Error: TICK SPACING or RANGE issue or Invariant Failed... Error: ${error.message}`); }
            ErrorHandler.handleError(error, context, { poolAddress: poolState.address, amountIn: amountInStr, tickRaw: tickNumberRaw, tickAdjusted: tickNumberAdjusted });
            return null;
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
             const [pool1, pool2, pool3] = opportunity.pools;
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
                 // Log pool states before calling sim (Same as before)
                 console.log(`${logPrefix} POOL 1 STATE before calling simulateSingleSwapExactIn:`); console.log(this.stringifyPoolState(pool1));
                const hop1Result = await this.simulateSingleSwapExactIn(pool1, tokenA, tokenB, initialAmount);
                if (!hop1Result || hop1Result.amountOut == null) { log.warn(`${logPrefix} Hop 1 simulation failed.`); return { profitable: false, error: 'Hop 1 sim failed', initialAmount, finalAmount: 0n, grossProfit: 0n, details: { hop1Result } }; }
                const amountB_Received = hop1Result.amountOut;
                log.info(`[SIM Hop 1 ${tokenA.symbol}->${tokenB.symbol}] Output: ${ethers.formatUnits(amountB_Received, tokenB.decimals)} ${tokenB.symbol}`);
                if (amountB_Received <= 0n) { log.warn(`${logPrefix} Hop 1 output is zero or less.`); return { profitable: false, error: 'Hop 1 zero output', initialAmount, finalAmount: 0n, grossProfit: 0n, details: { hop1Result } }; }

                 console.log(`${logPrefix} POOL 2 STATE before calling simulateSingleSwapExactIn:`); console.log(this.stringifyPoolState(pool2));
                const hop2Result = await this.simulateSingleSwapExactIn(pool2, tokenB, tokenC, amountB_Received);
                 if (!hop2Result || hop2Result.amountOut == null) { log.warn(`${logPrefix} Hop 2 simulation failed.`); return { profitable: false, error: 'Hop 2 sim failed', initialAmount, finalAmount: 0n, grossProfit: 0n, details: { hop1Result, hop2Result } }; }
                const amountC_Received = hop2Result.amountOut;
                log.info(`[SIM Hop 2 ${tokenB.symbol}->${tokenC.symbol}] Output: ${ethers.formatUnits(amountC_Received, tokenC.decimals)} ${tokenC.symbol}`);
                if (amountC_Received <= 0n) { log.warn(`${logPrefix} Hop 2 output is zero or less.`); return { profitable: false, error: 'Hop 2 zero output', initialAmount, finalAmount: 0n, grossProfit: 0n, details: { hop1Result, hop2Result } }; }

                 console.log(`${logPrefix} POOL 3 STATE before calling simulateSingleSwapExactIn:`); console.log(this.stringifyPoolState(pool3));
                const hop3Result = await this.simulateSingleSwapExactIn(pool3, tokenC, tokenA, amountC_Received);
                if (!hop3Result || hop3Result.amountOut == null) { log.warn(`${logPrefix} Hop 3 simulation failed.`); return { profitable: false, error: 'Hop 3 sim failed', initialAmount, finalAmount: 0n, grossProfit: 0n, details: { hop1Result, hop2Result, hop3Result } }; }
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
                return { /* ... */ };
            }
        }
        else if (opportunity.type === 'cyclic') { /* ... */ }
        else { /* ... */ }
    }
}
module.exports = QuoteSimulator;
