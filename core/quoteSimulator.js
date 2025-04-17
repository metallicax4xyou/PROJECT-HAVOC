// core/quoteSimulator.js

if (!BigInt.prototype.toJSON) {
  BigInt.prototype.toJSON = function() { return this.toString(); };
}

const { ethers } = require('ethers');
const JSBI = require('jsbi');
const path = require('path');
const { Pool, TickMath } = require('@uniswap/v3-sdk');
const { Token } = require('@uniswap/sdk-core');
const { TOKENS } = require('../constants/abis'); // Import central TOKENS

// Load Logger
let logger;
try {
    const loggerPath = path.join(process.cwd(), 'utils', 'logger.js');
    logger = require(loggerPath);
     if (!logger || typeof logger.info !== 'function') { throw new Error("Invalid logger."); }
} catch (err) { logger = { info: console.log, warn: console.warn, error: console.error, debug: console.log, log: console.log }; logger.warn("!!! Logger fallback !!!"); }


// --- Single Swap Simulation Function ---
async function simulateSingleSwapExactIn(poolState, tokenInSymbol, tokenOutSymbol, amountIn, provider) {
    const currentLogger = logger || console;
    const logPrefix = `[SimSwap Pool: ${poolState?.address?.substring(0, 10) || 'N/A'}]`;

    // Resolve Tokens from Symbols
    const tokenIn = TOKENS[tokenInSymbol];
    const tokenOut = TOKENS[tokenOutSymbol];

    // Input Validation (includes token check)
    if (!poolState || !tokenIn || !tokenOut || typeof amountIn === 'undefined') { currentLogger.error(`${logPrefix} Missing args or invalid symbols (${tokenInSymbol}/${tokenOutSymbol}).`); return null; }
    if (!(tokenIn instanceof Token) || !(tokenOut instanceof Token)) { currentLogger.error(`${logPrefix} Resolved tokenIn/Out not valid Token instance.`); return null; }
    if (!tokenIn.address || !tokenOut.address) { currentLogger.error(`${logPrefix} Resolved tokenIn/Out missing address.`); return null; }

    let amountInJSBI;
    try { amountInJSBI = JSBI.BigInt(amountIn.toString()); } catch (e) { currentLogger.error(`${logPrefix} Invalid amountIn: ${amountIn}`); return null; }
    if (!poolState.sqrtPriceX96 || !poolState.liquidity || typeof poolState.tick !== 'number' || typeof poolState.feeBps !== 'number' || typeof poolState.tickSpacing !== 'number') { currentLogger.error(`${logPrefix} Invalid poolState.`); return null; }
    if (poolState.tickSpacing <= 0) { currentLogger.error(`${logPrefix} Invalid tickSpacing.`); return null; }
    if (JSBI.equal(amountInJSBI, JSBI.BigInt(0))) { currentLogger.warn(`${logPrefix} Input amount zero.`); return { amountOut: JSBI.BigInt(0), /* ... */ }; }

    currentLogger.info(`${logPrefix} Simulating exact IN: ${ethers.formatUnits(amountInJSBI.toString(), tokenIn.decimals)} ${tokenIn.symbol} -> ${tokenOut.symbol}`);
    currentLogger.warn(`${logPrefix} Performing simulation WITHOUT detailed tick data. Accuracy reduced.`);

    try {
        // --- *** SORT TOKENS FOR POOL CONSTRUCTOR *** ---
        const [tokenA, tokenB] = tokenIn.sortsBefore(tokenOut) ? [tokenIn, tokenOut] : [tokenOut, tokenIn];
        currentLogger.debug(`${logPrefix} Sorted tokens for Pool constructor: A=${tokenA.symbol}, B=${tokenB.symbol}`);
        // --- *** ---

        // Create Pool Instance using SORTED tokens
        const pool = new Pool(
            tokenA, // Sorted token 0
            tokenB, // Sorted token 1
            poolState.feeBps,
            poolState.sqrtPriceX96.toString(),
            poolState.liquidity.toString(),
            poolState.tick
        );
        currentLogger.debug(`${logPrefix} Pool object created successfully.`);

        // Perform Simulation using ORIGINAL tokenIn/tokenOut for direction
        const zeroForOne = tokenIn.equals(tokenA); // If tokenIn is the first sorted token, direction is 0->1
        currentLogger.debug(`${logPrefix} zeroForOne calculation: ${zeroForOne} (tokenIn == sorted tokenA)`);

        // Adapt based on SDK version
        let amountOutJSBI;
        let sqrtPriceNextX96 = poolState.sqrtPriceX96;
        let tickNext = poolState.tick;

        if (typeof pool.getOutputAmount === 'function') {
            currentLogger.debug(`${logPrefix} Using pool.getOutputAmount for simulation.`);
            const sqrtPriceLimitX96 = zeroForOne ? JSBI.add(TickMath.MIN_SQRT_RATIO, JSBI.BigInt(1)) : JSBI.subtract(TickMath.MAX_SQRT_RATIO, JSBI.BigInt(1));
            // Pass ORIGINAL tokenIn to getOutputAmount
            [amountOutJSBI] = await pool.getOutputAmount(tokenIn, amountInJSBI, sqrtPriceLimitX96);
            currentLogger.warn(`${logPrefix} Used getOutputAmount; pool state after swap is ESTIMATE.`);
        } else {
             throw new Error("Suitable simulation method (getOutputAmount) not found on Pool object.");
        }

        // Process Results
        const amountOutNum = ethers.formatUnits(amountOutJSBI.toString(), tokenOut.decimals); // Use ORIGINAL tokenOut decimals
        currentLogger.info(`${logPrefix} Simulation Result (Approx.): Got ${amountOutNum} ${tokenOut.symbol}. Est. New Tick: ${tickNext}, Est. New SqrtPrice: ${sqrtPriceNextX96}`);

        return { amountOut: amountOutJSBI, sqrtPriceX96After: sqrtPriceNextX96, tickAfter: tickNext };

    } catch (error) {
        // Log the error, including potentially useful details from the error object
        currentLogger.error(`${logPrefix} Unexpected error during simplified swap simulation: ${error.message}`, error);
        return null;
     }
}


// --- Arbitrage Simulation Function ---
// No changes needed here as it passes symbols to simulateSingleSwapExactIn
async function simulateArbitrage(opportunity) {
    // ... (function remains the same) ...
    const currentLogger = logger || console;
    const { poolBorrow, poolSwap, token0Symbol, token1Symbol, flashLoanAmount, provider, groupName } = opportunity; // Expect symbols
    const logPrefix = `[SimArb Group: ${groupName || `${token0Symbol || '?'}_${token1Symbol || '?'}`}]`;
    const token0 = TOKENS[token0Symbol]; // Resolve for logging only
    const token1 = TOKENS[token1Symbol];
    if (!poolBorrow || !poolSwap || !token0 || !token1 || typeof flashLoanAmount === 'undefined' || !provider) { /* ... */ return null; }
    if (!poolBorrow.address || !poolSwap.address || !token0.address || !token1.address || typeof poolBorrow.tick !== 'number' || typeof poolSwap.tick !== 'number') { /* ... */ return null; }
    currentLogger.info(`${logPrefix} Starting simulation (using simplified method)...`);
    currentLogger.info(`${logPrefix} Path: ${token0.symbol} -> ${token1.symbol} (on ${poolSwap.address} / ${poolSwap.feeBps}bps) -> ${token0.symbol} (on ${poolBorrow.address} / ${poolBorrow.feeBps}bps)`);
    let initialBorrowAmountJSBI;
    try { initialBorrowAmountJSBI = JSBI.BigInt(flashLoanAmount.toString()); } catch (e) { /* ... */ return null; }

    // Hop 1 - Pass SYMBOLS
    currentLogger.info(`${logPrefix} Simulating Hop 1: ${ethers.formatUnits(initialBorrowAmountJSBI.toString(), token0.decimals)} ${token0.symbol} -> ${token1.symbol} on pool ${poolSwap.address}`);
    const hop1Result = await simulateSingleSwapExactIn(poolSwap, token0Symbol, token1Symbol, initialBorrowAmountJSBI, provider);
    if (!hop1Result || typeof hop1Result.amountOut === 'undefined') { currentLogger.warn(`${logPrefix} Hop 1 simulation failed.`); return null; }
    const amountToken1Received = hop1Result.amountOut;
    if (JSBI.equal(amountToken1Received, JSBI.BigInt(0))) { currentLogger.warn(`${logPrefix} Hop 1 yielded zero output.`); return { /* zero/loss result */ }; }
    currentLogger.info(`${logPrefix} Hop 1 Result: Received ${ethers.formatUnits(amountToken1Received.toString(), token1.decimals)} ${token1.symbol}`);

    // Hop 2 - Pass SYMBOLS
    currentLogger.info(`${logPrefix} Simulating Hop 2: ${ethers.formatUnits(amountToken1Received.toString(), token1.decimals)} ${token1.symbol} -> ${token0.symbol} on pool ${poolBorrow.address}`);
    const hop2Result = await simulateSingleSwapExactIn(poolBorrow, token1Symbol, token0Symbol, amountToken1Received, provider);
    if (!hop2Result || typeof hop2Result.amountOut === 'undefined') { currentLogger.warn(`${logPrefix} Hop 2 simulation failed.`); return null; }
    const finalAmountToken0 = hop2Result.amountOut;
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
        sdkTokenBorrowed: token0, // Return the resolved Token object for profit checker
        opportunityDetails: { groupName: groupName, /* ... */ }
     };
}

module.exports = {
    simulateArbitrage,
};
