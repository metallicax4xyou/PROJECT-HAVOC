// core/quoteSimulator.js

if (!BigInt.prototype.toJSON) {
  BigInt.prototype.toJSON = function() { return this.toString(); };
}

const { ethers } = require('ethers');
const JSBI = require('jsbi');
const path = require('path');
const { Pool, TickMath } = require('@uniswap/v3-sdk'); // No TickListDataProvider needed for simplified sim
const { tickToWord } = require('../utils/tickUtils'); // Use local helper

// Load ABI (TickLens removed as unused)
// Load Logger
let logger;
try {
    const loggerPath = path.join(process.cwd(), 'utils', 'logger.js');
    logger = require(loggerPath);
     if (!logger || typeof logger.info !== 'function') { throw new Error("Invalid logger."); }
} catch (err) { logger = { info: console.log, warn: console.warn, error: console.error, debug: console.log, log: console.log }; logger.warn("!!! Logger fallback !!!"); }


// --- Single Swap Simulation Function ---
async function simulateSingleSwapExactIn(poolState, tokenIn, tokenOut, amountIn, provider) {
    const currentLogger = logger || console;
    const logPrefix = `[SimSwap Pool: ${poolState?.address?.substring(0, 10) || 'N/A'}]`;

    // Input Validation...
    if (!poolState || !tokenIn || !tokenOut || typeof amountIn === 'undefined') { /* ... */ return null; }
    let amountInJSBI;
    try { amountInJSBI = JSBI.BigInt(amountIn.toString()); }
    catch (e) { /* ... */ return null; }
    if (!poolState.sqrtPriceX96 || !poolState.liquidity || typeof poolState.tick !== 'number' || typeof poolState.feeBps !== 'number' || typeof poolState.tickSpacing !== 'number') { /* ... */ return null; }
    if (poolState.tickSpacing <= 0) { /* ... */ return null; }
    if (JSBI.equal(amountInJSBI, JSBI.BigInt(0))) { /* ... */ }

    currentLogger.info(`${logPrefix} Simulating exact IN: ${ethers.formatUnits(amountInJSBI.toString(), tokenIn.decimals)} ${tokenIn.symbol} -> ${tokenOut.symbol}`);
    currentLogger.warn(`${logPrefix} Performing simulation WITHOUT detailed tick data. Accuracy reduced.`);

    // --- *** ADDED DEBUG LOG for Tokens *** ---
    currentLogger.debug(`${logPrefix} Token In Check: Address=${tokenIn?.address}, Symbol=${tokenIn?.symbol}, IsToken=${tokenIn?.isToken}, HasEquals=${typeof tokenIn?.equals === 'function'}`);
    currentLogger.debug(`${logPrefix} Token Out Check: Address=${tokenOut?.address}, Symbol=${tokenOut?.symbol}, IsToken=${tokenOut?.isToken}, HasEquals=${typeof tokenOut?.equals === 'function'}`);
    // --- *** ---

    try {
        // Create Pool Instance (No TickListDataProvider needed for basic sim)
        const pool = new Pool(
            tokenIn, // Should be a Token instance
            tokenOut, // Should be a Token instance
            poolState.feeBps,
            JSBI.BigInt(poolState.sqrtPriceX96.toString()),
            JSBI.BigInt(poolState.liquidity.toString()),
            poolState.tick
        );

        // Perform Simulation
        const zeroForOne = tokenIn.address.toLowerCase() < tokenOut.address.toLowerCase();
        currentLogger.debug(`${logPrefix} zeroForOne: ${zeroForOne}`);

        // Adapt based on SDK version
        let amountOutJSBI;
        let sqrtPriceNextX96 = poolState.sqrtPriceX96;
        let tickNext = poolState.tick;

        if (typeof pool.getOutputAmount === 'function') {
             currentLogger.debug(`${logPrefix} Using pool.getOutputAmount for simulation.`);
             const sqrtPriceLimitX96 = zeroForOne ? JSBI.add(TickMath.MIN_SQRT_RATIO, JSBI.BigInt(1)) : JSBI.subtract(TickMath.MAX_SQRT_RATIO, JSBI.BigInt(1));
             [amountOutJSBI] = await pool.getOutputAmount(amountInJSBI, sqrtPriceLimitX96);
             currentLogger.warn(`${logPrefix} Used getOutputAmount; pool state after swap is ESTIMATE.`);
        } else if (typeof pool.simulateSwap === 'function') { // Check if simulateSwap exists and try it
            currentLogger.debug(`${logPrefix} Trying pool.simulateSwap...`);
            const swapResult = await pool.simulateSwap(zeroForOne, amountInJSBI, { /* options */ });
            amountOutJSBI = swapResult.amountOut;
            sqrtPriceNextX96 = swapResult.sqrtRatioNextX96 ?? sqrtPriceNextX96;
            tickNext = swapResult.tickNext ?? tickNext;
            currentLogger.debug(`${logPrefix} simulateSwap finished. New tick: ${tickNext}, SqrtPrice: ${sqrtPriceNextX96}`);
        } else {
             throw new Error("Suitable simulation method (getOutputAmount or simulateSwap) not found on Pool object.");
        }

        // Process Results
        const amountOutNum = ethers.formatUnits(amountOutJSBI.toString(), tokenOut.decimals);
        currentLogger.info(`${logPrefix} Simulation Result (Approx.): Got ${amountOutNum} ${tokenOut.symbol}. Est. New Tick: ${tickNext}, Est. New SqrtPrice: ${sqrtPriceNextX96}`);

        return {
            amountOut: amountOutJSBI,
            sqrtPriceX96After: sqrtPriceNextX96,
            tickAfter: tickNext
        };

    } catch (error) {
        // Log the error including potentially useful details from the error object
        currentLogger.error(`${logPrefix} Unexpected error during simplified swap simulation: ${error.message}`, error);
        return null;
     }
}


// --- Arbitrage Simulation Function ---
// No changes needed here
async function simulateArbitrage(opportunity) {
    const currentLogger = logger || console;
    const { poolBorrow, poolSwap, token0, token1, flashLoanAmount, provider, groupName } = opportunity;
    const logPrefix = `[SimArb Group: ${groupName || `${token0?.symbol || '?'}_${token1?.symbol || '?'}`}]`;

    // Validation...
    if (!poolBorrow || !poolSwap || !token0 || !token1 || typeof flashLoanAmount === 'undefined' || !provider) { /* ... */ return null; }
    if (!poolBorrow.address || !poolSwap.address || !token0.address || !token1.address || typeof poolBorrow.tick !== 'number' || typeof poolSwap.tick !== 'number') { /* ... */ return null; }

    currentLogger.info(`${logPrefix} Starting simulation (using simplified method)...`);
    currentLogger.info(`${logPrefix} Path: ${token0.symbol} -> ${token1.symbol} (on ${poolSwap.address} / ${poolSwap.feeBps}bps) -> ${token0.symbol} (on ${poolBorrow.address} / ${poolBorrow.feeBps}bps)`);

    let initialBorrowAmountJSBI;
    try { initialBorrowAmountJSBI = JSBI.BigInt(flashLoanAmount.toString()); }
    catch (e) { /* ... */ return null; }

    // Hop 1
    currentLogger.info(`${logPrefix} Simulating Hop 1: ${ethers.formatUnits(initialBorrowAmountJSBI.toString(), token0.decimals)} ${token0.symbol} -> ${token1.symbol} on pool ${poolSwap.address}`);
    const hop1Result = await simulateSingleSwapExactIn(poolSwap, token0, token1, initialBorrowAmountJSBI, provider);
    if (!hop1Result || typeof hop1Result.amountOut === 'undefined') { currentLogger.warn(`${logPrefix} Hop 1 simulation failed.`); return null; }
    const amountToken1Received = hop1Result.amountOut; // Ensure this is assigned even if zero
    if (JSBI.equal(amountToken1Received, JSBI.BigInt(0))) { currentLogger.warn(`${logPrefix} Hop 1 yielded zero output.`); return { /* zero/loss result */ }; }
    currentLogger.info(`${logPrefix} Hop 1 Result: Received ${ethers.formatUnits(amountToken1Received.toString(), token1.decimals)} ${token1.symbol}`);

    // Hop 2
    currentLogger.info(`${logPrefix} Simulating Hop 2: ${ethers.formatUnits(amountToken1Received.toString(), token1.decimals)} ${token1.symbol} -> ${token0.symbol} on pool ${poolBorrow.address}`);
    const hop2Result = await simulateSingleSwapExactIn(poolBorrow, token1, token0, amountToken1Received, provider);
    if (!hop2Result || typeof hop2Result.amountOut === 'undefined') { currentLogger.warn(`${logPrefix} Hop 2 simulation failed.`); return null; }
    const finalAmountToken0 = hop2Result.amountOut; // Ensure this is assigned even if zero
    if (JSBI.equal(finalAmountToken0, JSBI.BigInt(0))) { currentLogger.warn(`${logPrefix} Hop 2 yielded zero output.`); return { /* zero/loss result */ }; }
    currentLogger.info(`${logPrefix} Hop 2 Result: Received ${ethers.formatUnits(finalAmountToken0.toString(), token0.decimals)} ${token0.symbol}`);

    // Profit Calc
    const grossProfitJSBI = JSBI.subtract(finalAmountToken0, initialBorrowAmountJSBI);
    currentLogger.info(`${logPrefix} Simulation Complete. Gross Profit: ${ethers.formatUnits(grossProfitJSBI.toString(), token0.decimals)} ${token0.symbol}`);

    return {
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
