// /workspaces/arbitrum-flash/core/quoteSimulator.js - Refactored to Class + Added Logging
const { Pool, Route, Trade } = require('@uniswap/v3-sdk');
const { Token, CurrencyAmount, TradeType } = require('@uniswap/sdk-core');
const { ethers } = require('ethers');
const logger = require('../utils/logger');
const ErrorHandler = require('../utils/errorHandler');

class QuoteSimulator {
    constructor(tickDataProvider) {
        if (!tickDataProvider || typeof tickDataProvider.getPopulatedTicksInRange !== 'function') { logger.fatal("[QuoteSimulator Constructor] Invalid TickDataProvider instance provided."); throw new Error("Valid TickDataProvider instance required for QuoteSimulator."); }
        this.tickDataProvider = tickDataProvider;
        logger.info("[QuoteSimulator] Instance created with TickDataProvider.");
    }

    async simulateSingleSwapExactIn(poolState, tokenIn, tokenOut, amountIn) {
        const log = logger || console;
        const context = `[SimSwap ${tokenIn?.symbol}->${tokenOut?.symbol} (${poolState?.fee}bps)]`;
        if (!this.tickDataProvider) { log.error(`${context} TickDataProvider is missing on simulator instance.`); return null; }

        // Input Validation
        if (!poolState || !tokenIn || !tokenOut || !poolState.sqrtPriceX96 || !poolState.liquidity || typeof poolState.tick === 'undefined' || !poolState.fee) { log.warn(`${context} Invalid poolState/tokens.`); return null; }
        if (!(tokenIn instanceof Token) || !(tokenOut instanceof Token)) { log.warn(`${context} Invalid SDK Token instances.`); return null; }
        if (amountIn <= 0n) { log.warn(`${context} Non-positive amountIn.`); return { amountOut: 0n, sdkTokenIn: tokenIn, sdkTokenOut: tokenOut, trade: null }; }
        const amountInStr = amountIn.toString(); if (!/^\d+$/.test(amountInStr)) { log.warn(`${context} Invalid amountIn format.`); return null; }

        try {
            const [tokenA, tokenB] = tokenIn.sortsBefore(tokenOut) ? [tokenIn, tokenOut] : [tokenOut, tokenIn];
            const tickNumber = Number(poolState.tick);
            if (isNaN(tickNumber)) { log.warn(`${context} Invalid tick number ${poolState.tick}.`); return null; }

            // --- Log Pool Parameters before creating SDK Pool ---
            log.debug(`${context} Creating SDK Pool instance with:`);
            log.debug(`  Token A: ${tokenA.symbol} (${tokenA.address})`);
            log.debug(`  Token B: ${tokenB.symbol} (${tokenB.address})`);
            log.debug(`  Fee: ${poolState.fee}`);
            log.debug(`  SqrtPriceX96: ${poolState.sqrtPriceX96.toString()}`);
            log.debug(`  Liquidity: ${poolState.liquidity.toString()}`);
            log.debug(`  Tick: ${tickNumber}`);
            log.debug(`  TickSpacing: ${poolState.tickSpacing}`);
            log.debug(`  Pool Address (for TickProvider): ${poolState.address}`);
            // --- End Logging ---

            // Create Uniswap SDK Pool Instance
            const pool = new Pool(
                tokenA, tokenB, poolState.fee,
                poolState.sqrtPriceX96.toString(),
                poolState.liquidity.toString(),
                tickNumber,
                { // --- Tick Provider Wrapper with Logging ---
                    getTick: async (tick) => {
                        log.debug(`${context} SDK requesting getTick(${tick})`);
                        const result = await this.tickDataProvider.getTick(tick, poolState.tickSpacing, poolState.address);
                        // Log result before returning to SDK
                        log.debug(`${context} Provider returned for getTick(${tick}): ${result ? `{ liquidityNet: ${result.liquidityNet} }` : 'null'}`);
                        return result;
                    },
                    nextInitializedTickWithinOneWord: async (tick, lte) => {
                        log.debug(`${context} SDK requesting nextInitializedTickWithinOneWord(tick=${tick}, lte=${lte})`);
                        const result = await this.tickDataProvider.nextInitializedTickWithinOneWord(tick, lte, poolState.tickSpacing, poolState.address);
                         // Log result before returning to SDK
                        log.debug(`${context} Provider returned for nextInitializedTickWithinOneWord(tick=${tick}, lte=${lte}): ${result}`);
                        return result;
                    }
                } // --- End Wrapper ---
            );

             log.debug(`${context} SDK Pool instance created. Proceeding to Trade.fromRoute...`);

            const swapRoute = new Route([pool], tokenIn, tokenOut);
            const trade = await Trade.fromRoute( swapRoute, CurrencyAmount.fromRawAmount(tokenIn, amountInStr), TradeType.EXACT_INPUT );

             log.debug(`${context} Trade.fromRoute finished.`); // Log after the potentially failing call

            if (!trade || !trade.outputAmount || !trade.outputAmount.quotient) {
                 log.warn(`${context} SDK Trade creation failed or returned no output.`);
                 if (trade) log.debug(`${context} Trade details: ${JSON.stringify(trade)}`);
                 return { amountOut: 0n, sdkTokenIn: tokenIn, sdkTokenOut: tokenOut, trade: trade };
            }
            const amountOutBI = BigInt(trade.outputAmount.quotient.toString());
             log.debug(`${context} Simulation successful. Output Amount: ${amountOutBI}`);

            return { amountOut: amountOutBI, sdkTokenIn: tokenIn, sdkTokenOut: tokenOut, trade: trade };

        } catch (error) {
             // Keep existing error handling, the logs above should help pinpoint the state before the crash
            log.error(`${context} Error during single swap simulation: ${error.message}`);
            if (error.message?.toLowerCase().includes('insufficient liquidity')) { log.error(`${context} SDK Error: INSUFFICIENT LIQUIDITY...`); }
            else if (error.message?.includes('already') || error.message?.includes('TICK')) { log.error(`${context} SDK Error: TICK SPACING or RANGE issue or Invariant Failed... Error: ${error.message}`); }
            ErrorHandler.handleError(error, context, { poolAddress: poolState.address, amountIn: amountInStr });
            return null;
        }
    }


    // simulateArbitrage remains the same - it calls the modified simulateSingleSwapExactIn
    async simulateArbitrage(opportunity, initialAmount) {
        const log = logger || console;
        const logPrefix = `[SimArb OppType: ${opportunity?.type}, Group: ${opportunity?.groupName}]`;
        if (!opportunity || !opportunity.type || typeof initialAmount === 'undefined' || initialAmount <= 0n) { log.warn(`${logPrefix} Invalid input...`); return { /*...*/ }; }
        log.info(`--- Simulation START ${logPrefix} ---`);
        log.info(`Initial Amount: ${ethers.formatUnits(initialAmount, opportunity.pools?.[0]?.token0?.decimals || 18)} ${opportunity.pathSymbols?.[0]}`);

        if (opportunity.type === 'triangular') {
             // Structure Validation (Same)
             if (!opportunity.pools || opportunity.pools.length !== 3 || !opportunity.pathSymbols || opportunity.pathSymbols.length !== 4) { log.error(`${logPrefix} Invalid triangular structure.`); return { /*...*/ }; }
             const [pool1, pool2, pool3] = opportunity.pools;
             const [symA, symB, symC, symA_final] = opportunity.pathSymbols;
             if (symA !== symA_final) { log.error(`${logPrefix} Path symbols mismatch.`); return { /*...*/ }; }

             // Resolve Tokens (Same)
             const tokenA = pool1.token0?.symbol === symA ? pool1.token0 : (pool1.token1?.symbol === symA ? pool1.token1 : null);
             const tokenB = pool1.token0?.symbol === symB ? pool1.token0 : (pool1.token1?.symbol === symB ? pool1.token1 : null);
             const tokenC = pool2.token0?.symbol === symC ? pool2.token0 : (pool2.token1?.symbol === symC ? pool2.token1 : null);
             if (!(tokenA instanceof Token) || !(tokenB instanceof Token) || !(tokenC instanceof Token)) { log.error(`${logPrefix} SDK Token resolution failed.`); return { /*...*/ }; }

             // Pool token validation (Same)
             const pool1Matches = (pool1.token0 === tokenA && pool1.token1 === tokenB) || (pool1.token0 === tokenB && pool1.token1 === tokenA);
             const pool2Matches = (pool2.token0 === tokenB && pool2.token1 === tokenC) || (pool2.token0 === tokenC && pool2.token1 === tokenB);
             const pool3Matches = (pool3.token0 === tokenC && pool3.token1 === tokenA) || (pool3.token0 === tokenA && pool3.token1 === tokenC);
             if (!pool1Matches || !pool2Matches || !pool3Matches) { log.error(`${logPrefix} Pool tokens mismatch path.`); return { /*...*/ }; }

            try {
                // Hop 1 (A -> B)
                const hop1Result = await this.simulateSingleSwapExactIn(pool1, tokenA, tokenB, initialAmount);
                if (!hop1Result || hop1Result.amountOut == null) { log.warn(`${logPrefix} Hop 1 simulation failed.`); return { profitable: false, error: 'Hop 1 sim failed', initialAmount, finalAmount: 0n, grossProfit: 0n, details: { hop1Result } }; }
                const amountB_Received = hop1Result.amountOut;
                log.info(`[SIM Hop 1 ${tokenA.symbol}->${tokenB.symbol}] Output: ${ethers.formatUnits(amountB_Received, tokenB.decimals)} ${tokenB.symbol}`);
                if (amountB_Received <= 0n) { log.warn(`${logPrefix} Hop 1 output is zero or less.`); return { profitable: false, error: 'Hop 1 zero output', initialAmount, finalAmount: 0n, grossProfit: 0n, details: { hop1Result } }; }

                // Hop 2 (B -> C)
                const hop2Result = await this.simulateSingleSwapExactIn(pool2, tokenB, tokenC, amountB_Received);
                if (!hop2Result || hop2Result.amountOut == null) { log.warn(`${logPrefix} Hop 2 simulation failed.`); return { profitable: false, error: 'Hop 2 sim failed', initialAmount, finalAmount: 0n, grossProfit: 0n, details: { hop1Result, hop2Result } }; }
                const amountC_Received = hop2Result.amountOut;
                log.info(`[SIM Hop 2 ${tokenB.symbol}->${tokenC.symbol}] Output: ${ethers.formatUnits(amountC_Received, tokenC.decimals)} ${tokenC.symbol}`);
                if (amountC_Received <= 0n) { log.warn(`${logPrefix} Hop 2 output is zero or less.`); return { profitable: false, error: 'Hop 2 zero output', initialAmount, finalAmount: 0n, grossProfit: 0n, details: { hop1Result, hop2Result } }; }

                // Hop 3 (C -> A)
                const hop3Result = await this.simulateSingleSwapExactIn(pool3, tokenC, tokenA, amountC_Received);
                if (!hop3Result || hop3Result.amountOut == null) { log.warn(`${logPrefix} Hop 3 simulation failed.`); return { profitable: false, error: 'Hop 3 sim failed', initialAmount, finalAmount: 0n, grossProfit: 0n, details: { hop1Result, hop2Result, hop3Result } }; }
                const finalAmount = hop3Result.amountOut;
                log.info(`[SIM Hop 3 ${tokenC.symbol}->${tokenA.symbol}] Output: ${ethers.formatUnits(finalAmount, tokenA.decimals)} ${tokenA.symbol}`);

                // Profit Calculation
                const grossProfit = finalAmount - initialAmount;
                const profitable = grossProfit > 0n;
                log.info(`${logPrefix} Gross Profit: ${ethers.formatUnits(grossProfit, tokenA.decimals)} ${tokenA.symbol}`);
                log.info(`${logPrefix} Trade Profitable (Gross): ${profitable ? 'YES' : 'NO'}`);
                log.info(`--- Simulation END ${logPrefix} ---`);
                return { profitable, error: null, initialAmount, finalAmount, grossProfit, details: { hop1Result, hop2Result, hop3Result } };

            } catch (error) {
                log.error(`${logPrefix} UNEXPECTED High-Level Error during hop simulation: ${error.message}`);
                ErrorHandler.handleError(error, logPrefix);
                return { profitable: false, error: `High-level sim error: ${error.message}`, initialAmount, finalAmount: 0n, grossProfit: 0n, details: null };
            }
        }
        else if (opportunity.type === 'cyclic') { /* ... placeholder ... */ }
        else { /* ... unknown type error ... */ }
    }
}
module.exports = QuoteSimulator;
