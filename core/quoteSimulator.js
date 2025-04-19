// /workspaces/arbitrum-flash/core/quoteSimulator.js
// *** Simulates SINGLE swap using pool.getOutputAmount directly ***
const { Pool, TickMath } = require('@uniswap/v3-sdk'); // Removed Route, Trade
const { Token, CurrencyAmount, Price } = require('@uniswap/sdk-core'); // Removed TradeType
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
    constructor(tickLensAddress, provider, chainId) {
        if (!tickLensAddress || !provider || !chainId) {
             throw new Error("QuoteSimulator requires tickLensAddress, provider, and chainId for creating TickDataProviders.");
        }
        this.tickLensAddress = tickLensAddress;
        this.provider = provider;
        this.chainId = chainId;
        console.log("[QuoteSimulator] Instance created (will create TickDataProviders per simulation).");
    }

    /**
     * Simulates a single swap using pool.getOutputAmount.
     * @param {object} poolState - Live state of the Uniswap V3 pool. Requires { address, sqrtPriceX96, liquidity, tick, fee, tickSpacing }
     * @param {Token} tokenIn - SDK Token instance for input.
     * @param {Token} tokenOut - SDK Token instance for output.
     * @param {bigint} amountIn - Raw amount of tokenIn to swap.
     * @returns {Promise<object|null>} - Promise resolving to { amountOut: bigint, sdkTokenIn: Token, sdkTokenOut: Token, pool: Pool } or null on error. (Note: no 'trade' object)
     */
    async simulateSingleSwapExactIn(poolState, tokenIn, tokenOut, amountIn) {
        const log = logger || console;
        const context = `[SimSwap ${tokenIn?.symbol}->${tokenOut?.symbol} (${poolState?.fee}bps)]`;

        // --- Basic Input Validation (Same as before) ---
        if (!poolState || !poolState.address) { log.error(`${context} Invalid poolState (null or missing address).`); return null; }
        if (!tokenIn || !tokenOut) { log.error(`${context} Invalid tokenIn or tokenOut.`); return null; }
        if (!(tokenIn instanceof Token) || !(tokenOut instanceof Token)) { log.error(`${context} tokenIn or tokenOut is not a valid SDK Token instance.`); return null; }
        if (amountIn <= 0n) { log.error(`${context} Invalid amountIn (${amountIn}). Must be positive.`); return null; }
        const amountInStr = amountIn.toString(); if (!/^\d+$/.test(amountInStr)) { log.error(`${context} Invalid amountIn string representation: ${amountInStr}`); return null; }
        if (typeof poolState.sqrtPriceX96 !== 'bigint' || typeof poolState.liquidity !== 'bigint' || typeof poolState.tick !== 'number' || !poolState.fee || typeof poolState.tickSpacing !== 'number') {
            log.error(`${context} Invalid poolState fields (missing/wrong type).`);
            console.error("Problematic PoolState:", stringifyPoolState(poolState));
            return null;
        }
        // --- End Basic Input Validation ---

        console.log(`\n--- ${context} ---`);
        console.log(`TokenIn: ${tokenIn.symbol}, TokenOut: ${tokenOut.symbol}, AmountIn: ${amountInStr}`);

        let tickSpacing = 'N/A';
        let sqrtPriceJSBI;
        let tickDataProviderForPool = null;
        let pool = null; // Define pool here for catch block access

        try {
            const [tokenA, tokenB] = tokenIn.sortsBefore(tokenOut) ? [tokenIn, tokenOut] : [tokenOut, tokenIn];

            tickSpacing = Number(poolState.tickSpacing);
            if (isNaN(tickSpacing) || tickSpacing <= 0) { /* ... error ... */ return null; }

            const currentTickFromState = poolState.tick;
            console.log(`${context} Using tick directly from poolState: ${currentTickFromState}`);

            sqrtPriceJSBI = JSBI.BigInt(poolState.sqrtPriceX96.toString());
            if (JSBI.lessThan(sqrtPriceJSBI, MIN_SQRT_RATIO) || JSBI.greaterThan(sqrtPriceJSBI, MAX_SQRT_RATIO)) { /* ... error ... */ return null; }

            const feeAmountEnum = getFeeAmountEnum(poolState.fee);
            if (feeAmountEnum === undefined) { /* ... error ... */ return null; }

            // --- Create Pool-Specific Tick Data Provider ---
            try {
                 log.debug(`${context} Creating new LensTickDataProvider instance for pool ${poolState.address}`);
                 tickDataProviderForPool = new LensTickDataProvider( this.tickLensAddress, this.provider, this.chainId, poolState.address );
                 log.debug(`${context} Successfully created TickDataProvider instance.`);
             } catch (providerError) { /* ... error ... */ throw providerError; }
            // --- End Tick Data Provider Creation ---

            const liquidityJSBI = JSBI.BigInt(poolState.liquidity.toString());
            console.log(`${context} ---> DEBUG: Attempting Pool constructor with (TickProvider YES)...`); // Simplified log

            // --- Instantiate SDK Pool (Same as before) ---
            pool = new Pool(
                tokenA, tokenB, feeAmountEnum, sqrtPriceJSBI, liquidityJSBI, currentTickFromState, tickDataProviderForPool
            );
            // --- End Pool Instantiation ---

            console.log(`${context} ===> SUCCESSFULLY CALLED new Pool(...) - SDK derived tickCurrent: ${pool.tickCurrent}`);

            // --- *** Simulate Trade using pool.getOutputAmount *** ---
            // Create the input amount as a CurrencyAmount object
            const currencyAmountIn = CurrencyAmount.fromRawAmount(tokenIn, amountInStr);

            log.debug(`${context} Calling pool.getOutputAmount directly...`);
            // This method performs the simulation internally
            // It might require tick data, hence the provider is needed by the Pool
            const [amountOutResult, resultingPool] = await pool.getOutputAmount(currencyAmountIn); // sqrtPriceLimitX96 is optional

            log.debug(`${context} pool.getOutputAmount finished successfully.`);
            // --- *** End Direct Simulation *** ---

            if (!amountOutResult || !amountOutResult.quotient) {
                log.error(`${context} pool.getOutputAmount simulation returned invalid output.`);
                console.error("amountOutResult:", stringifyPoolState(amountOutResult)); // Log the result safely
                return null;
            }

            const amountOutBI = BigInt(amountOutResult.quotient.toString()); // Convert JSBI quotient to native bigint
             if (amountOutBI <= 0n) {
                 log.warn(`${context} Simulation resulted in zero or negative output amount (${amountOutBI}).`);
                 // Optionally return null or the zero amount depending on how you want to handle this
                 return null;
             }

            log.info(`${context} Simulation successful. Output Amount: ${amountOutBI}`);
            // Return a similar structure, but without the 'trade' object
            return {
                amountOut: amountOutBI,
                sdkTokenIn: tokenIn,
                sdkTokenOut: tokenOut,
                // Optionally return the pool state after the simulated swap if needed
                // pool: resultingPool // Be careful, this might be large or complex
            };

        } catch (error) {
            console.error(`${context} !!!!!!!!!!!!!! CATCH BLOCK in simulateSingleSwapExactIn !!!!!!!!!!!!!!`);
            log.error(`${context} Error during single swap simulation: ${error.message}`);
            log.error(`${context} Details: SqrtPriceX96=${poolState?.sqrtPriceX96?.toString() || 'N/A'}, TickFromState=${poolState?.tick}, Spacing=${tickSpacing}`);
            if (error.stack) { console.error(error.stack); }

            if (error.message?.toLowerCase().includes('insufficient liquidity')) { /* ... */ }
            else if (error.message?.includes('already') || /* ... invariants ... */ error.message?.includes('FEE')) { /* ... */ }
            else if (error.message?.includes('nextInitializedTickWithinOneWord') || error.message?.includes('getTick') || error.message?.includes('Convert JSBI')) { // Added JSBI check
                 log.error(`${context} SDK Error likely related to TickDataProvider or JSBI interaction: ${error.message}`);
            }

            ErrorHandler.handleError(error, context, { /* ... error details ... */ });
            return null;
        }
    }
}

module.exports = QuoteSimulator;
