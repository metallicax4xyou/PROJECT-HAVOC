// /workspaces/arbitrum-flash/core/quoteSimulator.js - Refactored + More Console Logging
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

    // Helper to stringify BigInts for console.log
    stringifyPoolState(state) {
         try {
             return JSON.stringify(state, (key, value) =>
                 typeof value === 'bigint' ? value.toString() : value, 2);
         } catch(e) { return "Error stringifying pool state"; }
    }


    async simulateSingleSwapExactIn(poolState, tokenIn, tokenOut, amountIn) {
        const log = logger || console; // Use logger for general, console for specific debug
        const context = `[SimSwap ${tokenIn?.symbol}->${tokenOut?.symbol} (${poolState?.fee}bps)]`;
        if (!this.tickDataProvider) { console.error(`${context} FATAL: TickDataProvider is missing on simulator instance.`); return null; }

        // Input Validation
        if (!poolState || !tokenIn || !tokenOut || !poolState.sqrtPriceX96 || !poolState.liquidity || typeof poolState.tick === 'undefined' || !poolState.fee) { log.warn(`${context} Invalid poolState/tokens.`); return null; }
        if (!(tokenIn instanceof Token) || !(tokenOut instanceof Token)) { log.warn(`${context} Invalid SDK Token instances.`); return null; }
        if (amountIn <= 0n) { log.warn(`${context} Non-positive amountIn.`); return { amountOut: 0n, sdkTokenIn: tokenIn, sdkTokenOut: tokenOut, trade: null }; }
        const amountInStr = amountIn.toString(); if (!/^\d+$/.test(amountInStr)) { log.warn(`${context} Invalid amountIn format.`); return null; }

        // --- Direct Console Log of Pool State ---
        console.log(`\n--- ${context} ---`);
        console.log(`Pool State Received by simulateSingleSwapExactIn:`);
        console.log(this.stringifyPoolState(poolState)); // Log the whole state object
        console.log(`TokenIn: ${tokenIn.symbol}, TokenOut: ${tokenOut.symbol}, AmountIn: ${amountInStr}`);
        // ---

        try {
            const [tokenA, tokenB] = tokenIn.sortsBefore(tokenOut) ? [tokenIn, tokenOut] : [tokenOut, tokenIn];
            const tickNumber = Number(poolState.tick);
            if (isNaN(tickNumber)) { log.warn(`${context} Invalid tick number ${poolState.tick}.`); return null; }


             // --- Log immediately before Pool constructor ---
             console.log(`${context} ===> PREPARING TO CALL new Pool(...)`);
             // ---

            // Create Uniswap SDK Pool Instance
            const pool = new Pool(
                tokenA, tokenB, poolState.fee,
                poolState.sqrtPriceX96.toString(),
                poolState.liquidity.toString(),
                tickNumber,
                { // --- Tick Provider Wrapper with CONSOLE Logging ---
                    getTick: async (tick) => {
                        // Use console.log for this critical path
                        console.log(`${context} >>> SDK requesting getTick(${tick})`);
                        const result = await this.tickDataProvider.getTick(tick, poolState.tickSpacing, poolState.address);
                        console.log(`${context} <<< Provider returned for getTick(${tick}): ${result ? `{ liquidityNet: ${result.liquidityNet} }` : 'null'}`);
                        return result;
                    },
                    nextInitializedTickWithinOneWord: async (tick, lte) => {
                         // Use console.log for this critical path
                        console.log(`${context} >>> SDK requesting nextInitializedTickWithinOneWord(tick=${tick}, lte=${lte})`);
                        const result = await this.tickDataProvider.nextInitializedTickWithinOneWord(tick, lte, poolState.tickSpacing, poolState.address);
                        console.log(`${context} <<< Provider returned for nextInitializedTickWithinOneWord(tick=${tick}, lte=${lte}): ${result}`);
                        return result;
                    }
                } // --- End Wrapper ---
            );

            // --- Log immediately after Pool constructor ---
            console.log(`${context} ===> SUCCESSFULLY CALLED new Pool(...)`);
            // ---

            log.debug(`${context} SDK Pool instance created. Proceeding to Trade.fromRoute...`); // Regular logger ok here

            const swapRoute = new Route([pool], tokenIn, tokenOut);
            const trade = await Trade.fromRoute( swapRoute, CurrencyAmount.fromRawAmount(tokenIn, amountInStr), TradeType.EXACT_INPUT );

            log.debug(`${context} Trade.fromRoute finished.`);

            if (!trade || !trade.outputAmount || !trade.outputAmount.quotient) { /* ... */ }
            const amountOutBI = BigInt(trade.outputAmount.quotient.toString());
            log.debug(`${context} Simulation successful. Output Amount: ${amountOutBI}`);
            return { amountOut: amountOutBI, sdkTokenIn: tokenIn, sdkTokenOut: tokenOut, trade: trade };

        } catch (error) {
            // --- Log Error Location ---
            console.error(`${context} !!!!!!!!!!!!!! CATCH BLOCK in simulateSingleSwapExactIn !!!!!!!!!!!!!!`);
            // ---
            log.error(`${context} Error during single swap simulation: ${error.message}`);
            if (error.message?.toLowerCase().includes('insufficient liquidity')) { log.error(`${context} SDK Error: INSUFFICIENT LIQUIDITY...`); }
            else if (error.message?.includes('already') || error.message?.includes('TICK')) { log.error(`${context} SDK Error: TICK SPACING or RANGE issue or Invariant Failed... Error: ${error.message}`); }
            ErrorHandler.handleError(error, context, { poolAddress: poolState.address, amountIn: amountInStr }); // Log full error object too
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
                // --- Log Pool 1 State before calling sim ---
                 console.log(`${logPrefix} POOL 1 STATE before calling simulateSingleSwapExactIn:`);
                 console.log(this.stringifyPoolState(pool1));
                 // ---
                const hop1Result = await this.simulateSingleSwapExactIn(pool1, tokenA, tokenB, initialAmount);
                if (!hop1Result || hop1Result.amountOut == null) { /* ... */ }
                const amountB_Received = hop1Result.amountOut;
                log.info(`[SIM Hop 1 ${tokenA.symbol}->${tokenB.symbol}] Output: ${ethers.formatUnits(amountB_Received, tokenB.decimals)} ${tokenB.symbol}`);
                if (amountB_Received <= 0n) { /* ... */ }

                // Log Pool 2 State before calling sim
                 console.log(`${logPrefix} POOL 2 STATE before calling simulateSingleSwapExactIn:`);
                 console.log(this.stringifyPoolState(pool2));
                const hop2Result = await this.simulateSingleSwapExactIn(pool2, tokenB, tokenC, amountB_Received);
                 if (!hop2Result || hop2Result.amountOut == null) { /* ... */ }
                const amountC_Received = hop2Result.amountOut;
                log.info(`[SIM Hop 2 ${tokenB.symbol}->${tokenC.symbol}] Output: ${ethers.formatUnits(amountC_Received, tokenC.decimals)} ${tokenC.symbol}`);
                if (amountC_Received <= 0n) { /* ... */ }

                // Log Pool 3 State before calling sim
                console.log(`${logPrefix} POOL 3 STATE before calling simulateSingleSwapExactIn:`);
                console.log(this.stringifyPoolState(pool3));
                const hop3Result = await this.simulateSingleSwapExactIn(pool3, tokenC, tokenA, amountC_Received);
                if (!hop3Result || hop3Result.amountOut == null) { /* ... */ }
                const finalAmount = hop3Result.amountOut;
                log.info(`[SIM Hop 3 ${tokenC.symbol}->${tokenA.symbol}] Output: ${ethers.formatUnits(finalAmount, tokenA.decimals)} ${tokenA.symbol}`);

                const grossProfit = finalAmount - initialAmount;
                const profitable = grossProfit > 0n;
                log.info(`${logPrefix} Gross Profit: ${ethers.formatUnits(grossProfit, tokenA.decimals)} ${tokenA.symbol}`);
                log.info(`${logPrefix} Trade Profitable (Gross): ${profitable ? 'YES' : 'NO'}`);
                log.info(`--- Simulation END ${logPrefix} ---`);
                return { profitable, error: null, initialAmount, finalAmount, grossProfit, details: { hop1Result, hop2Result, hop3Result } };
            } catch (error) {
                 console.error(`${logPrefix} !!!!!!!!!!!!!! CATCH BLOCK in simulateArbitrage !!!!!!!!!!!!!!`); // Added console log
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
