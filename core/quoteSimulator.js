// /workspaces/arbitrum-flash/core/quoteSimulator.js - Refactored to Class
const { Pool, Route, Trade } = require('@uniswap/v3-sdk');
const { Token, CurrencyAmount, TradeType } = require('@uniswap/sdk-core');
const { ethers } = require('ethers');
const logger = require('../utils/logger');
const ErrorHandler = require('../utils/errorHandler');
// --- Removed imports for config, getProvider, LensTickDataProvider ---

class QuoteSimulator {
    // Constructor accepts the tick data provider instance
    constructor(tickDataProvider) {
        if (!tickDataProvider || typeof tickDataProvider.getPopulatedTicksInRange !== 'function') {
            logger.fatal("[QuoteSimulator Constructor] Invalid TickDataProvider instance provided.");
            throw new Error("Valid TickDataProvider instance required for QuoteSimulator.");
        }
        this.tickDataProvider = tickDataProvider;
        logger.info("[QuoteSimulator] Instance created with TickDataProvider.");
    }

    /**
     * Simulates a single swap using Uniswap V3 SDK based on live pool state.
     * Uses the instance's LensTickDataProvider.
     * Now an instance method.
     */
    async simulateSingleSwapExactIn(poolState, tokenIn, tokenOut, amountIn) {
        const log = logger || console;
        const context = `[SimSwap ${tokenIn?.symbol}->${tokenOut?.symbol} (${poolState?.fee}bps)]`; // Added brackets for consistency

        // --- Check if TickDataProvider is available on the instance ---
        if (!this.tickDataProvider) {
            log.error(`${context} TickDataProvider is missing on simulator instance. Cannot simulate.`);
            // This should ideally not happen if constructor validation passed
            return null;
        }
        // --- End Check ---

        // Input Validation (simplified logging)
        if (!poolState || !tokenIn || !tokenOut || !poolState.sqrtPriceX96 || !poolState.liquidity || typeof poolState.tick === 'undefined' || !poolState.fee) { log.warn(`${context} Invalid poolState/tokens.`); return null; }
        if (!(tokenIn instanceof Token) || !(tokenOut instanceof Token)) { log.warn(`${context} Invalid SDK Token instances.`); return null; }
        if (amountIn <= 0n) { log.warn(`${context} Non-positive amountIn.`); return { amountOut: 0n, sdkTokenIn: tokenIn, sdkTokenOut: tokenOut, trade: null }; } // Return structure consistent with success but 0 out
        const amountInStr = amountIn.toString(); if (!/^\d+$/.test(amountInStr)) { log.warn(`${context} Invalid amountIn format.`); return null; }

        try {
            const [tokenA, tokenB] = tokenIn.sortsBefore(tokenOut) ? [tokenIn, tokenOut] : [tokenOut, tokenIn];
            const tickNumber = Number(poolState.tick);
            if (isNaN(tickNumber)) { log.warn(`${context} Invalid tick number ${poolState.tick}.`); return null; }

            // Create Uniswap SDK Pool Instance - PASSING REAL TICK DATA PROVIDER FROM INSTANCE
            const pool = new Pool(
                tokenA, tokenB, poolState.fee,
                poolState.sqrtPriceX96.toString(),
                poolState.liquidity.toString(),
                tickNumber,
                // --- Use the instance's TickDataProvider ---
                // Pass pool address dynamically as before
                // Use arrow functions to retain 'this' context if needed, though likely not strictly required here
                {
                    getTick: async (tick) => this.tickDataProvider.getTick(tick, poolState.tickSpacing, poolState.address),
                    nextInitializedTickWithinOneWord: async (tick, lte) => this.tickDataProvider.nextInitializedTickWithinOneWord(tick, lte, poolState.tickSpacing, poolState.address)
                }
                // --- ---
            );

            const swapRoute = new Route([pool], tokenIn, tokenOut);
            const trade = await Trade.fromRoute( swapRoute, CurrencyAmount.fromRawAmount(tokenIn, amountInStr), TradeType.EXACT_INPUT );

            if (!trade || !trade.outputAmount || !trade.outputAmount.quotient) {
                 log.warn(`${context} SDK Trade creation failed or returned no output.`);
                 // Attempt to provide more detail if trade object exists
                 if (trade) log.debug(`${context} Trade details: ${JSON.stringify(trade)}`);
                 return { amountOut: 0n, sdkTokenIn: tokenIn, sdkTokenOut: tokenOut, trade: trade }; // Return 0 but include trade if exists
            }
            const amountOutBI = BigInt(trade.outputAmount.quotient.toString());
             log.debug(`${context} Simulation successful. Output Amount: ${amountOutBI}`);

            return { amountOut: amountOutBI, sdkTokenIn: tokenIn, sdkTokenOut: tokenOut, trade: trade };

        } catch (error) {
            log.error(`${context} Error during single swap simulation: ${error.message}`);
            if (error.message?.toLowerCase().includes('insufficient liquidity')) {
                 log.error(`${context} SDK Error: INSUFFICIENT LIQUIDITY. Check TickLens/Pool state/Amount.`);
                 // Provide more context for liquidity errors
                 log.debug(`${context} Pool State: sqrtPrice=${poolState.sqrtPriceX96}, liquidity=${poolState.liquidity}, tick=${poolState.tick}`);
                 log.debug(`${context} Amount In: ${ethers.formatUnits(amountIn, tokenIn.decimals)} ${tokenIn.symbol}`);
            } else if (error.message?.includes('already')) { // Catch tick spacing errors e.g. "already lighter than lower tick"
                 log.error(`${context} SDK Error: TICK SPACING or RANGE issue. Error: ${error.message}`);
                 log.debug(`${context} Pool Tick: ${poolState.tick}, Tick Spacing: ${poolState.tickSpacing}`);
            }
            // Use the standard error handler
            ErrorHandler.handleError(error, context, { poolAddress: poolState.address, amountIn: amountInStr });
            return null; // Return null on significant error
        }
    }


    /**
     * Simulates a multi-hop arbitrage opportunity.
     * Handles 'triangular' type. Can be extended for others.
     * Now an instance method.
     */
    async simulateArbitrage(opportunity, initialAmount) {
        const log = logger || console;
        const logPrefix = `[SimArb OppType: ${opportunity?.type}, Group: ${opportunity?.groupName}]`; // Keep prefix

        // Input Validation
        if (!opportunity || !opportunity.type || typeof initialAmount === 'undefined' || initialAmount <= 0n) {
             log.warn(`${logPrefix} Invalid input: opportunity or initialAmount missing/invalid.`);
             return { profitable: false, error: 'Invalid input', initialAmount: initialAmount || 0n, finalAmount: 0n, grossProfit: 0n, details: null };
        }

        log.info(`--- Simulation START ${logPrefix} ---`);
        log.info(`Initial Amount: ${ethers.formatUnits(initialAmount, opportunity.pools?.[0]?.token0?.decimals || 18)} ${opportunity.pathSymbols?.[0]}`); // Attempt to log initial amount nicely

        if (opportunity.type === 'triangular') {
            // Structure Validation
            if (!opportunity.pools || opportunity.pools.length !== 3 || !opportunity.pathSymbols || opportunity.pathSymbols.length !== 4) {
                log.error(`${logPrefix} Invalid triangular opportunity structure.`);
                return { profitable: false, error: 'Invalid triangular structure', initialAmount, finalAmount: 0n, grossProfit: 0n, details: null };
            }
            const [pool1, pool2, pool3] = opportunity.pools;
            const [symA, symB, symC, symA_final] = opportunity.pathSymbols;
            if (symA !== symA_final) {
                 log.error(`${logPrefix} Path symbols do not form a cycle (${symA} != ${symA_final}).`);
                 return { profitable: false, error: 'Path symbols mismatch', initialAmount, finalAmount: 0n, grossProfit: 0n, details: null };
            }

            // Resolve Tokens (ensure they are SDK Token instances from pool state)
            const tokenA = pool1.token0?.symbol === symA ? pool1.token0 : (pool1.token1?.symbol === symA ? pool1.token1 : null);
            const tokenB = pool1.token0?.symbol === symB ? pool1.token0 : (pool1.token1?.symbol === symB ? pool1.token1 : null); // Check pool1 for B
            const tokenC = pool2.token0?.symbol === symC ? pool2.token0 : (pool2.token1?.symbol === symC ? pool2.token1 : null); // Check pool2 for C

            if (!(tokenA instanceof Token) || !(tokenB instanceof Token) || !(tokenC instanceof Token)) {
                log.error(`${logPrefix} Failed to resolve SDK Token instances from pool states for symbols: ${symA}, ${symB}, ${symC}`);
                return { profitable: false, error: 'SDK Token resolution failed', initialAmount, finalAmount: 0n, grossProfit: 0n, details: null };
            }

            // Ensure pool token pairs match expected path tokens
             const pool1Matches = (pool1.token0 === tokenA && pool1.token1 === tokenB) || (pool1.token0 === tokenB && pool1.token1 === tokenA);
             const pool2Matches = (pool2.token0 === tokenB && pool2.token1 === tokenC) || (pool2.token0 === tokenC && pool2.token1 === tokenB);
             const pool3Matches = (pool3.token0 === tokenC && pool3.token1 === tokenA) || (pool3.token0 === tokenA && pool3.token1 === tokenC);
             if (!pool1Matches || !pool2Matches || !pool3Matches) {
                  log.error(`${logPrefix} Pool token pairs do not match the expected path tokens.`);
                   log.debug(`Pool1: ${pool1.token0?.symbol}/${pool1.token1?.symbol}, Expected: ${tokenA.symbol}/${tokenB.symbol}`);
                   log.debug(`Pool2: ${pool2.token0?.symbol}/${pool2.token1?.symbol}, Expected: ${tokenB.symbol}/${tokenC.symbol}`);
                   log.debug(`Pool3: ${pool3.token0?.symbol}/${pool3.token1?.symbol}, Expected: ${tokenC.symbol}/${tokenA.symbol}`);
                  return { profitable: false, error: 'Pool tokens mismatch path', initialAmount, finalAmount: 0n, grossProfit: 0n, details: null };
             }


            try {
                // --- Simulate Hops using INSTANCE method ---
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
                return {
                    profitable,
                    error: null,
                    initialAmount,
                    finalAmount,
                    grossProfit,
                    details: { hop1Result, hop2Result, hop3Result } // Include individual hop results
                };

            } catch (error) {
                log.error(`${logPrefix} UNEXPECTED High-Level Error during hop simulation: ${error.message}`);
                ErrorHandler.handleError(error, logPrefix);
                return { profitable: false, error: `High-level sim error: ${error.message}`, initialAmount, finalAmount: 0n, grossProfit: 0n, details: null };
            }
        }
        // Cyclic/Other type handling (placeholder)
        else if (opportunity.type === 'cyclic') {
            log.warn(`${logPrefix} Cyclic opportunity simulation not yet implemented.`);
            return { profitable: false, error: 'Cyclic sim not implemented', initialAmount, finalAmount: 0n, grossProfit: 0n, details: null };
        }
        else {
            log.error(`${logPrefix} Unknown opportunity type: ${opportunity.type}`);
            return { profitable: false, error: `Unknown opportunity type: ${opportunity.type}`, initialAmount, finalAmount: 0n, grossProfit: 0n, details: null };
        }
    }
} // End class QuoteSimulator

// Export the class
module.exports = QuoteSimulator;
