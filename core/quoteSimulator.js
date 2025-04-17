// core/quoteSimulator.js

// Globally handle BigInts in JSON.stringify
if (!BigInt.prototype.toJSON) {
  BigInt.prototype.toJSON = function() { return this.toString(); };
}

const { ethers } = require('ethers');
const JSBI = require('jsbi');
const path = require('path');
// Import only necessary SDK components
const { Pool, TickMath } = require('@uniswap/v3-sdk');
// Remove TickListDataProvider and TickLens-related imports if no longer needed

// Load Logger
let logger;
try {
    const loggerPath = path.join(process.cwd(), 'utils', 'logger.js');
    logger = require(loggerPath);
     if (!logger || typeof logger.info !== 'function') { throw new Error("Invalid logger."); }
} catch (err) { logger = { info: console.log, warn: console.warn, error: console.error, debug: console.log, log: console.log }; logger.warn("!!! Logger fallback !!!"); }


// --- *** TickLens related code is removed as it's unsupported by RPC *** ---
// const TICKLENS_ADDRESS = '...';
// const TickLensABI = ...;
// async function getTickDataProvider(...) { ... } // Removed


// --- Single Swap Simulation Function ---
// --- *** MODIFIED: Does NOT use TickListDataProvider *** ---
async function simulateSingleSwapExactIn(poolState, tokenIn, tokenOut, amountIn, provider) { // Removed provider dependency if not strictly needed elsewhere in this func
    const currentLogger = logger || console;
    const logPrefix = `[SimSwap Pool: ${poolState?.address?.substring(0, 10) || 'N/A'}]`;

    // Input Validation
    if (!poolState || !tokenIn || !tokenOut || typeof amountIn === 'undefined') { currentLogger.error(`${logPrefix} Missing required arguments.`); return null; }
    let amountInJSBI;
    try { amountInJSBI = JSBI.BigInt(amountIn.toString()); }
    catch (e) { currentLogger.error(`${logPrefix} Invalid amountIn: ${amountIn}`); return null; }
    if (!poolState.sqrtPriceX96 || !poolState.liquidity || typeof poolState.tick !== 'number' || typeof poolState.feeBps !== 'number' || typeof poolState.tickSpacing !== 'number') {
        currentLogger.error(`${logPrefix} Invalid poolState object. Check tick/feeBps/tickSpacing.`);
        currentLogger.debug(`${logPrefix} Pool State: ${JSON.stringify(poolState)}`); return null;
    }
    if (poolState.tickSpacing <= 0) { currentLogger.error(`${logPrefix} Invalid tickSpacing (${poolState.tickSpacing}).`); return null; }
    if (JSBI.equal(amountInJSBI, JSBI.BigInt(0))) { currentLogger.warn(`${logPrefix} Input amount zero.`); return { amountOut: JSBI.BigInt(0), /* ... */ }; }

    currentLogger.info(`${logPrefix} Simulating exact IN: ${ethers.formatUnits(amountInJSBI.toString(), tokenIn.decimals)} ${tokenIn.symbol} -> ${tokenOut.symbol}`);
    currentLogger.warn(`${logPrefix} Performing simulation WITHOUT detailed tick data due to RPC limitations. Accuracy may be reduced.`);

    try {
        // --- *** Create Pool Instance WITHOUT TickListDataProvider *** ---
        // The SDK will simulate based on current tick/liquidity/sqrtPrice
        const pool = new Pool(
            tokenIn, tokenOut, poolState.feeBps,
            JSBI.BigInt(poolState.sqrtPriceX96.toString()),
            JSBI.BigInt(poolState.liquidity.toString()),
            poolState.tick
            // No TickListDataProvider passed here
        );
        // --- *** ---

        // Perform Simulation
        const zeroForOne = tokenIn.address.toLowerCase() < tokenOut.address.toLowerCase();
        currentLogger.debug(`${logPrefix} zeroForOne: ${zeroForOne}`);

        // Use appropriate SDK method (e.g., getOutputAmount or simulateSwap if it works without ticks)
        // Let's try getOutputAmount as a common fallback path, but it lacks post-swap state.
        // We might need to *estimate* the state change based on the output amount, which is inaccurate.
        // For now, prioritize getting *an* amountOut.

        let amountOutJSBI;
        let sqrtPriceNextX96 = poolState.sqrtPriceX96; // Default to initial price if state change unavailable
        let tickNext = poolState.tick; // Default to initial tick

        if (typeof pool.getOutputAmount === 'function') {
             currentLogger.debug(`${logPrefix} Using pool.getOutputAmount for simulation.`);
             // This method usually requires sqrtPriceLimitX96
             const sqrtPriceLimitX96 = zeroForOne
                 ? JSBI.add(TickMath.MIN_SQRT_RATIO, JSBI.BigInt(1))
                 : JSBI.subtract(TickMath.MAX_SQRT_RATIO, JSBI.BigInt(1));
             [amountOutJSBI] = await pool.getOutputAmount(amountInJSBI, sqrtPriceLimitX96);
             // NOTE: We CANNOT easily get the pool state after the swap with this method.
             // We will return the initial tick/sqrtPrice for the next hop, which is inaccurate.
             currentLogger.warn(`${logPrefix} Used getOutputAmount; pool state after swap (tick/sqrtPrice) is an ESTIMATE (using initial state).`);

        } else {
             // Attempt simulateSwap - it *might* work without ticks but less likely/accurate
             currentLogger.debug(`${logPrefix} Trying pool.simulateSwap (may fail/be inaccurate without ticks)...`);
             const swapResult = await pool.simulateSwap(zeroForOne, amountInJSBI, { /* options */ });
             amountOutJSBI = swapResult.amountOut;
             // If simulateSwap worked, try to get post-swap state
             sqrtPriceNextX96 = swapResult.sqrtRatioNextX96 ?? sqrtPriceNextX96;
             tickNext = swapResult.tickNext ?? tickNext;
             currentLogger.debug(`${logPrefix} simulateSwap finished. New tick: ${tickNext}, SqrtPrice: ${sqrtPriceNextX96}`);
        }


        // Process Results
        const amountOutNum = ethers.formatUnits(amountOutJSBI.toString(), tokenOut.decimals);
        currentLogger.info(`${logPrefix} Simulation Result (Approx.): Got ${amountOutNum} ${tokenOut.symbol}. Est. New Tick: ${tickNext}, Est. New SqrtPrice: ${sqrtPriceNextX96}`);

        return {
            amountOut: amountOutJSBI,
            // Return estimated state after swap (may be inaccurate)
            sqrtPriceX96After: sqrtPriceNextX96,
            tickAfter: tickNext
        };

    } catch (error) {
        currentLogger.error(`${logPrefix} Unexpected error during simplified swap simulation:`, error);
        return null;
     }
}


// --- Arbitrage Simulation Function ---
// Should now work using the simplified simulateSingleSwapExactIn
async function simulateArbitrage(opportunity) {
    const currentLogger = logger || console;
    const { poolBorrow, poolSwap, token0, token1, flashLoanAmount, provider, groupName } = opportunity;
    const logPrefix = `[SimArb Group: ${groupName || `${token0?.symbol || '?'}_${token1?.symbol || '?'}`}]`;

    // Validation...
    if (!poolBorrow || !poolSwap || !token0 || !token1 || typeof flashLoanAmount === 'undefined' || !provider) { /* ... */ return null; }
    if (!poolBorrow.address || !poolSwap.address || !token0.address || !token1.address || typeof poolBorrow.tick !== 'number' || typeof poolSwap.tick !== 'number') { /* ... */ return null; }

    currentLogger.info(`${logPrefix} Starting simulation (using simplified method)...`); // Note simplified method
    currentLogger.info(`${logPrefix} Path: ${token0.symbol} -> ${token1.symbol} (on ${poolSwap.address} / ${poolSwap.feeBps}bps) -> ${token0.symbol} (on ${poolBorrow.address} / ${poolBorrow.feeBps}bps)`);

    let initialBorrowAmountJSBI;
    try { initialBorrowAmountJSBI = JSBI.BigInt(flashLoanAmount.toString()); }
    catch (e) { /* ... */ return null; }

    // Hop 1
    currentLogger.info(`${logPrefix} Simulating Hop 1: ${ethers.formatUnits(initialBorrowAmountJSBI.toString(), token0.decimals)} ${token0.symbol} -> ${token1.symbol} on pool ${poolSwap.address}`);
    const hop1Result = await simulateSingleSwapExactIn(poolSwap, token0, token1, initialBorrowAmountJSBI, provider);
    if (!hop1Result || typeof hop1Result.amountOut === 'undefined') { currentLogger.warn(`${logPrefix} Hop 1 simulation failed.`); return null; }
    // Need to update the state of poolBorrow based on hop1Result for the next hop accurately
    // THIS IS HARD WITHOUT TickListDataProvider. We'll use the potentially inaccurate state returned.
    const intermediatePoolState = { ...poolBorrow, sqrtPriceX96: hop1Result.sqrtPriceX96After, tick: hop1Result.tickAfter };
    currentLogger.debug(`${logPrefix} State for Hop 2 (Pool ${poolBorrow.address}): Est. Tick=${intermediatePoolState.tick}, Est. SqrtPrice=${intermediatePoolState.sqrtPriceX96}`);

    if (JSBI.equal(hop1Result.amountOut, JSBI.BigInt(0))) { currentLogger.warn(`${logPrefix} Hop 1 yielded zero output.`); return { /* zero/loss result */ }; }
    const amountToken1Received = hop1Result.amountOut;
    currentLogger.info(`${logPrefix} Hop 1 Result: Received ${ethers.formatUnits(amountToken1Received.toString(), token1.decimals)} ${token1.symbol}`);

    // Hop 2
    currentLogger.info(`${logPrefix} Simulating Hop 2: ${ethers.formatUnits(amountToken1Received.toString(), token1.decimals)} ${token1.symbol} -> ${token0.symbol} on pool ${poolBorrow.address}`);
    // Pass the *original* state of poolBorrow, as the SDK should handle state internally for the single swap
    const hop2Result = await simulateSingleSwapExactIn(poolBorrow, token1, token0, amountToken1Received, provider);
    if (!hop2Result || typeof hop2Result.amountOut === 'undefined') { currentLogger.warn(`${logPrefix} Hop 2 simulation failed.`); return null; }
    if (JSBI.equal(hop2Result.amountOut, JSBI.BigInt(0))) { currentLogger.warn(`${logPrefix} Hop 2 yielded zero output.`); return { /* zero/loss result */ }; }
    const finalAmountToken0 = hop2Result.amountOut;
    currentLogger.info(`${logPrefix} Hop 2 Result: Received ${ethers.formatUnits(finalAmountToken0.toString(), token0.decimals)} ${token0.symbol}`);

    // Profit Calc
    const grossProfitJSBI = JSBI.subtract(finalAmountToken0, initialBorrowAmountJSBI);
    currentLogger.info(`${logPrefix} Simulation Complete. Gross Profit: ${ethers.formatUnits(grossProfitJSBI.toString(), token0.decimals)} ${token0.symbol}`);

    return { /* ... result object ... */
        initialAmount: initialBorrowAmountJSBI,
        finalAmount: finalAmountToken0,
        profit: grossProfitJSBI,
        grossProfit: grossProfitJSBI,
        sdkTokenBorrowed: token0,
        opportunityDetails: { groupName: groupName, /* ... */ }
     };
}

module.exports = {
    simulateArbitrage,
};
