// /workspaces/arbitrum-flash/core/quoteSimulator.js
// *** Simulates SINGLE swap, creates pool-specific TickProvider ***
const { Pool, Route, Trade, TickMath } = require('@uniswap/v3-sdk');
const { Token, CurrencyAmount, TradeType } = require('@uniswap/sdk-core');
const JSBI = require('jsbi');
const logger = require('../utils/logger');
const ErrorHandler = require('../utils/errorHandler');

// --- Import helpers and constants ---
const {
    MIN_SQRT_RATIO,
    MAX_SQRT_RATIO,
    getFeeAmountEnum,
    stringifyPoolState,
} = require('./simulationHelpers');
// --- Import the Tick Data Provider class ---
const { LensTickDataProvider } = require('../utils/tickDataProvider');
// ---

class QuoteSimulator {
    // Constructor no longer needs tickDataProvider, but needs TickLens address, provider, chainId to pass down
    constructor(tickLensAddress, provider, chainId) {
        if (!tickLensAddress || !provider || !chainId) {
             throw new Error("QuoteSimulator requires tickLensAddress, provider, and chainId for creating TickDataProviders.");
        }
        this.tickLensAddress = tickLensAddress;
        this.provider = provider;
        this.chainId = chainId;
        // Removed this.tickDataProvider
        console.log("[QuoteSimulator] Instance created (will create TickDataProviders per simulation).");
    }

    /**
     * Simulates a single swap (one leg of an arbitrage).
     * @param {object} poolState - Live state of the Uniswap V3 pool. Requires { address, sqrtPriceX96, liquidity, tick, fee, tickSpacing }
     * @param {Token} tokenIn - SDK Token instance for input.
     * @param {Token} tokenOut - SDK Token instance for output.
     * @param {bigint} amountIn - Raw amount of tokenIn to swap.
     * @returns {Promise<object|null>} - Promise resolving to { amountOut: bigint, sdkTokenIn: Token, sdkTokenOut: Token, trade: Trade } or null on error.
     */
    async simulateSingleSwapExactIn(poolState, tokenIn, tokenOut, amountIn) {
        const log = logger || console;
        const context = `[SimSwap ${tokenIn?.symbol}->${tokenOut?.symbol} (${poolState?.fee}bps)]`;

        // --- Basic Input Validation ---
        if (!poolState || !poolState.address) { log.error(`${context} Invalid poolState (null or missing address).`); return null; } // Need address now
        if (!tokenIn || !tokenOut) { log.error(`${context} Invalid tokenIn or tokenOut.`); return null; }
        if (!(tokenIn instanceof Token) || !(tokenOut instanceof Token)) { log.error(`${context} tokenIn or tokenOut is not a valid SDK Token instance.`); return null; }
        if (amountIn <= 0n) { log.error(`${context} Invalid amountIn (${amountIn}). Must be positive.`); return null; }
        const amountInStr = amountIn.toString(); if (!/^\d+$/.test(amountInStr)) { log.error(`${context} Invalid amountIn string representation: ${amountInStr}`); return null; }

        // Check required poolState fields
        if (typeof poolState.sqrtPriceX96 !== 'bigint' || typeof poolState.liquidity !== 'bigint' || typeof poolState.tick !== 'number' || !poolState.fee || typeof poolState.tickSpacing !== 'number') {
            log.error(`${context} Invalid poolState fields (missing/wrong type): address, sqrtPriceX96 (bigint), liquidity (bigint), tick (number), fee, or tickSpacing (number).`);
            console.error("Problematic PoolState:", stringifyPoolState(poolState));
            return null;
        }
        // --- End Basic Input Validation ---

        console.log(`\n--- ${context} ---`);
        console.log(`TokenIn: ${tokenIn.symbol}, TokenOut: ${tokenOut.symbol}, AmountIn: ${amountInStr}`);

        let tickSpacing = 'N/A';
        let sqrtPriceJSBI;
        let tickDataProviderForPool = null; // Define here for catch block access

        try {
            const [tokenA, tokenB] = tokenIn.sortsBefore(tokenOut) ? [tokenIn, tokenOut] : [tokenOut, tokenIn];

            tickSpacing = Number(poolState.tickSpacing);
            if (isNaN(tickSpacing) || tickSpacing <= 0) {
                log.error(`${context} Invalid tickSpacing (${poolState.tickSpacing}).`);
                return null;
            }

            const currentTickFromState = poolState.tick;
            console.log(`${context} Using tick directly from poolState: ${currentTickFromState}`);

            // --- Validate sqrtPriceX96 range ---
            sqrtPriceJSBI = JSBI.BigInt(poolState.sqrtPriceX96.toString());
            if (JSBI.lessThan(sqrtPriceJSBI, MIN_SQRT_RATIO) || JSBI.greaterThan(sqrtPriceJSBI, MAX_SQRT_RATIO)) {
                 log.error(`${context} sqrtPriceX96 (${poolState.sqrtPriceX96}) is outside the valid SDK range.`);
                 console.error(`MIN_SQRT_RATIO: ${MIN_SQRT_RATIO.toString()}, MAX_SQRT_RATIO: ${MAX_SQRT_RATIO.toString()}`);
                 return null;
            }
            // --- End Validation ---

            // --- Fee Mapping ---
            const feeAmountEnum = getFeeAmountEnum(poolState.fee);
            if (feeAmountEnum === undefined) {
                log.error(`${context} Invalid or unsupported fee tier (${poolState.fee}) found in poolState.`);
                return null;
            }
            // --- End Fee Mapping ---

            // --- *** Create Pool-Specific Tick Data Provider *** ---
            try {
                 log.debug(`${context} Creating new LensTickDataProvider instance for pool ${poolState.address}`);
                 tickDataProviderForPool = new LensTickDataProvider(
                     this.tickLensAddress,
                     this.provider,
                     this.chainId,
                     poolState.address // Pass the specific pool address
                 );
                 log.debug(`${context} Successfully created TickDataProvider instance.`);
             } catch (providerError) {
                  log.error(`${context} Failed to instantiate LensTickDataProvider: ${providerError.message}`);
                  throw providerError; // Propagate error
             }
            // --- *** End Tick Data Provider Creation *** ---


            // --- Add Debug Logging ---
            const liquidityJSBI = JSBI.BigInt(poolState.liquidity.toString());
            console.log(`${context} ---> DEBUG: Attempting Pool constructor with:`);
            console.log(`${context}      tokenA: ${tokenA.symbol} (${tokenA.address})`);
            console.log(`${context}      tokenB: ${tokenB.symbol} (${tokenB.address})`);
            console.log(`${context}      Fee (Enum Value): ${feeAmountEnum}, Type: ${typeof feeAmountEnum}`);
            console.log(`${context}      sqrtPriceX96 (JSBI): ${sqrtPriceJSBI.toString()}`);
            console.log(`${context}      liquidity (JSBI): ${liquidityJSBI.toString()}`);
            console.log(`${context}      tickCurrent (from state): ${currentTickFromState}`);
            console.log(`${context}      tickDataProvider present: YES (Pool-specific instance)`); // Updated log
            // --- End Debug Logging ---

            console.log(`${context} ===> PREPARING TO CALL new Pool(...) with tick from state: ${currentTickFromState} and fee enum: ${feeAmountEnum}`);

            // --- Instantiate SDK Pool ---
            // *** Pass the newly created pool-specific tickDataProviderForPool ***
            const pool = new Pool(
                tokenA,
                tokenB,
                feeAmountEnum,
                sqrtPriceJSBI,
                liquidityJSBI,
                currentTickFromState,
                tickDataProviderForPool // Use the instance created above
            );
            // --- End Pool Instantiation ---

            console.log(`${context} ===> SUCCESSFULLY CALLED new Pool(...) - SDK derived tickCurrent: ${pool.tickCurrent}`);
            log.debug(`${context} SDK Pool instance created. Proceeding to Trade.fromRoute...`);

            // --- Simulate Trade ---
            const swapRoute = new Route([pool], tokenIn, tokenOut);
            const currencyAmountIn = CurrencyAmount.fromRawAmount(tokenIn, amountInStr);
            // *** SDK should now call methods on the correct tickDataProviderForPool instance ***
            log.debug(`${context} Calling Trade.fromRoute...`);
            const trade = await Trade.fromRoute( swapRoute, currencyAmountIn, TradeType.EXACT_INPUT );
            log.debug(`${context} Trade.fromRoute finished successfully.`);
            // --- End Trade Simulation ---


            if (!trade || !trade.outputAmount || !trade.outputAmount.quotient) {
                log.error(`${context} Trade simulation failed or returned invalid output AFTER successful Trade.fromRoute call.`);
                console.error("Trade object:", stringifyPoolState(trade));
                return null;
            }

            const amountOutBI = BigInt(trade.outputAmount.quotient.toString());
            log.info(`${context} Simulation successful. Output Amount: ${amountOutBI}`);
            return {
                amountOut: amountOutBI,
                sdkTokenIn: tokenIn,
                sdkTokenOut: tokenOut,
                trade: trade
            };

        } catch (error) {
            console.error(`${context} !!!!!!!!!!!!!! CATCH BLOCK in simulateSingleSwapExactIn !!!!!!!!!!!!!!`);
            log.error(`${context} Error during single swap simulation: ${error.message}`);
            log.error(`${context} Details: SqrtPriceX96=${poolState?.sqrtPriceX96?.toString() || 'N/A'}, TickFromState=${poolState?.tick}, Spacing=${tickSpacing}`);
            // Log stack trace for easier debugging within SDK
            if (error.stack) {
                console.error(error.stack);
            }

            if (error.message?.toLowerCase().includes('insufficient liquidity')) {
                log.warn(`${context} SDK Error: INSUFFICIENT LIQUIDITY for this trade amount.`);
            } else if (error.message?.includes('already') || error.message?.includes('TICK') || error.message?.includes('PRICE_BOUNDS') || error.message?.includes('SQRT_RATIO') || error.message?.includes('FEE')) {
                log.error(`${context} SDK Invariant Error: ${error.message}`);
            } else if (error.message?.includes('nextInitializedTickWithinOneWord') || error.message?.includes('getTick')) {
                 log.error(`${context} SDK Error likely related to TickDataProvider interaction: ${error.message}`);
            }

            ErrorHandler.handleError(error, context, {
                poolAddress: poolState?.address || 'N/A',
                amountIn: amountInStr,
                sqrtPriceX96: poolState?.sqrtPriceX96?.toString(),
                tickFromState: poolState?.tick,
                feeBps: poolState?.fee
            });
            return null; // Return null on any simulation error
        }
    }
}

module.exports = QuoteSimulator;
