// /workspaces/arbitrum-flash/core/quoteSimulator.js
// *** Simulates SINGLE swap using pool.getOutputAmount directly ***
// *** Enforces JSBI for amountIn ***
const { Pool, TickMath } = require('@uniswap/v3-sdk'); // Removed Route, Trade
const { Token, CurrencyAmount, Price } = require('@uniswap/sdk-core'); // Removed TradeType
const JSBI = require('jsbi'); // Ensure JSBI is imported
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
     * @param {bigint} amountIn - Raw amount of tokenIn to swap (as native bigint).
     * @returns {Promise<object|null>} - Promise resolving to { amountOut: bigint, sdkTokenIn: Token, sdkTokenOut: Token, pool: Pool } or null on error. (Note: no 'trade' object)
     */
    async simulateSingleSwapExactIn(poolState, tokenIn, tokenOut, amountIn) {
        const log = logger || console;
        // Use native bigint amountIn for logging clarity
        const context = `[SimSwap ${tokenIn?.symbol}->${tokenOut?.symbol} (${poolState?.fee}bps)]`;

        // --- Basic Input Validation ---
        if (!poolState || !poolState.address) { /* ... */ return null; }
        if (!tokenIn || !tokenOut) { /* ... */ return null; }
        if (!(tokenIn instanceof Token) || !(tokenOut instanceof Token)) { /* ... */ return null; }
        if (amountIn <= 0n) { log.error(`${context} Invalid amountIn (${amountIn}). Must be positive.`); return null; }
        // Convert native bigint amountIn to string for internal use if needed, but primarily use the bigint/JSBI
        const amountInStr = amountIn.toString();
        if (typeof poolState.sqrtPriceX96 !== 'bigint' || /* ... */ ) { /* ... */ return null; }
        // --- End Basic Input Validation ---

        console.log(`\n--- ${context} ---`);
        // Log the native bigint amount
        console.log(`TokenIn: ${tokenIn.symbol}, TokenOut: ${tokenOut.symbol}, AmountIn (Native): ${amountInStr}`);

        let tickSpacing = 'N/A';
        let sqrtPriceJSBI;
        let tickDataProviderForPool = null;
        let pool = null;

        try {
            const [tokenA, tokenB] = tokenIn.sortsBefore(tokenOut) ? [tokenIn, tokenOut] : [tokenOut, tokenIn];

            tickSpacing = Number(poolState.tickSpacing);
            if (isNaN(tickSpacing) || tickSpacing <= 0) { /* ... */ return null; }

            const currentTickFromState = poolState.tick;
            console.log(`${context} Using tick directly from poolState: ${currentTickFromState}`);

            sqrtPriceJSBI = JSBI.BigInt(poolState.sqrtPriceX96.toString());
            if (JSBI.lessThan(sqrtPriceJSBI, MIN_SQRT_RATIO) || JSBI.greaterThan(sqrtPriceJSBI, MAX_SQRT_RATIO)) { /* ... */ return null; }

            const feeAmountEnum = getFeeAmountEnum(poolState.fee);
            if (feeAmountEnum === undefined) { /* ... */ return null; }

            // --- Create Pool-Specific Tick Data Provider ---
            try {
                 log.debug(`${context} Creating new LensTickDataProvider instance for pool ${poolState.address}`);
                 tickDataProviderForPool = new LensTickDataProvider( this.tickLensAddress, this.provider, this.chainId, poolState.address );
                 log.debug(`${context} Successfully created TickDataProvider instance.`);
             } catch (providerError) { /* ... */ throw providerError; }
            // --- End Tick Data Provider Creation ---

            const liquidityJSBI = JSBI.BigInt(poolState.liquidity.toString());
            console.log(`${context} ---> DEBUG: Attempting Pool constructor with (TickProvider YES)...`);

            // --- Instantiate SDK Pool ---
            pool = new Pool(
                tokenA, tokenB, feeAmountEnum, sqrtPriceJSBI, liquidityJSBI, currentTickFromState, tickDataProviderForPool
            );
            // --- End Pool Instantiation ---

            console.log(`${context} ===> SUCCESSFULLY CALLED new Pool(...) - SDK derived tickCurrent: ${pool.tickCurrent}`);

            // --- *** Simulate Trade using pool.getOutputAmount *** ---
            // *** Explicitly convert native bigint amountIn to JSBI ***
            const amountInJSBI = JSBI.BigInt(amountIn.toString());
            log.debug(`${context} Converted input amount to JSBI: ${amountInJSBI.toString()}`);
            // *** Create the input amount using the JSBI instance ***
            const currencyAmountIn = CurrencyAmount.fromRawAmount(tokenIn, amountInJSBI);

            log.debug(`${context} Calling pool.getOutputAmount directly with JSBI amount...`);
            const [amountOutResult, resultingPool] = await pool.getOutputAmount(currencyAmountIn);
            log.debug(`${context} pool.getOutputAmount finished successfully.`);
            // --- *** End Direct Simulation *** ---

            if (!amountOutResult || !amountOutResult.quotient) { /* ... error ... */ return null; }

            // amountOutResult.quotient should be JSBI, convert back to native bigint for consistency
            const amountOutBI = BigInt(amountOutResult.quotient.toString());
             if (amountOutBI <= 0n) { /* ... warning ... */ return null; }

            log.info(`${context} Simulation successful. Output Amount: ${amountOutBI}`);
            return {
                amountOut: amountOutBI,
                sdkTokenIn: tokenIn,
                sdkTokenOut: tokenOut,
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

            ErrorHandler.handleError(error, context, { /* ... */ });
            return null;
        }
    }
}

module.exports = QuoteSimulator;
