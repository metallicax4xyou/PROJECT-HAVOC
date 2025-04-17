// core/quoteSimulator.js

if (!BigInt.prototype.toJSON) {
  BigInt.prototype.toJSON = function() { return this.toString(); };
}

const { ethers } = require('ethers');
const JSBI = require('jsbi');
const path = require('path');
const { Pool, TickListDataProvider, TickMath } = require('@uniswap/v3-sdk');
const { tickToWord } = require('../utils/tickUtils'); // Use local helper

// Load ABI
const tickLensAbiPath = path.join(process.cwd(), 'abis', 'TickLens.json');
let TickLensABI;
try { TickLensABI = require(tickLensAbiPath); }
catch (err) { console.error(`FATAL: Could not load TickLens ABI: ${err.message}`); process.exit(1); }

// Load Logger
let logger;
try {
    const loggerPath = path.join(process.cwd(), 'utils', 'logger.js');
    logger = require(loggerPath);
     if (!logger || typeof logger.info !== 'function') { throw new Error("Invalid logger."); }
} catch (err) { logger = { info: console.log, warn: console.warn, error: console.error, debug: console.log, log: console.log }; logger.warn("!!! Logger fallback !!!"); }

const TICKLENS_ADDRESS = '0xbfd8137f7d1516D3ea5cA83523914859ec47F573'; // Arbitrum TickLens

// --- Tick Data Provider Function ---
async function getTickDataProvider(poolAddress, poolState, provider) {
    const currentLogger = logger || console;
    const logPrefix = `[TickData-${poolAddress?.substring(0, 10) || 'N/A'}]`;
    currentLogger.debug(`${logPrefix} Entering getTickDataProvider...`);

    // Input validation...
    if (!poolAddress || !ethers.isAddress(poolAddress)) { /* ... */ return null; }
    if (!poolState || typeof poolState.tick !== 'number' || typeof poolState.tickSpacing !== 'number') { /* ... */ return null; }
    if (!provider) { /* ... */ return null; }
    if (!TickLensABI) { /* ... */ return null; }

    let tickLens;
    try { tickLens = new ethers.Contract(TICKLENS_ADDRESS, TickLensABI, provider); }
    catch (contractError) { /* ... */ return null; }

    try {
        const tickCurrent = poolState.tick;
        const tickSpacing = poolState.tickSpacing;
        if (tickSpacing <= 0) { currentLogger.error(`${logPrefix} Invalid tickSpacing (${tickSpacing}).`); return null; }

        const currentWordPos = tickToWord(tickCurrent, tickSpacing);
        if (currentWordPos === null) { currentLogger.error(`${logPrefix} Failed to calculate word position.`); return null; }
        const lowerWordPos = currentWordPos - 1;
        const upperWordPos = currentWordPos + 1;

        currentLogger.info(`${logPrefix} Fetching ticks for words: ${lowerWordPos}, ${currentWordPos}, ${upperWordPos}`);

        // --- *** ADDED LOGGING AROUND CONTRACT CALLS *** ---
        currentLogger.debug(`${logPrefix} Preparing TickLens contract calls...`);
        const populatedTicksPromises = [
             tickLens.getPopulatedTicksInWordRange(poolAddress, lowerWordPos, lowerWordPos),
             tickLens.getPopulatedTicksInWordRange(poolAddress, currentWordPos, currentWordPos),
             tickLens.getPopulatedTicksInWordRange(poolAddress, upperWordPos, upperWordPos),
         ];
        currentLogger.debug(`${logPrefix} Awaiting Promise.allSettled for TickLens calls...`);
        const populatedTicksResults = await Promise.allSettled(populatedTicksPromises);
        currentLogger.debug(`${logPrefix} TickLens call results received:`, JSON.stringify(populatedTicksResults)); // Log the results (BigInts handled by patch)
        // --- *** ---

        let allFetchedTicks = [];
        let fetchFailed = false;
        populatedTicksResults.forEach((result, index) => {
            const wordPos = index === 0 ? lowerWordPos : index === 1 ? currentWordPos : upperWordPos;
            if (result.status === 'fulfilled' && result.value) {
                currentLogger.debug(`${logPrefix} Fetched ${result.value.length} ticks from word ${wordPos}`);
                allFetchedTicks = allFetchedTicks.concat(result.value);
            } else {
                 const reason = result.reason?.error?.reason || result.reason?.message || result.reason || 'Unknown fetch error';
                 // Log RPC errors more prominently
                 if (result.reason?.code) { // Ethers RPC errors often have a code
                    currentLogger.error(`${logPrefix} RPC Error fetching word ${wordPos}: ${reason} (Code: ${result.reason.code})`);
                 } else {
                    currentLogger.warn(`${logPrefix} Failed to fetch/process ticks for word ${wordPos}: ${reason}`);
                 }
                 if (result.status === 'rejected') fetchFailed = true;
            }
        });

        if (fetchFailed && allFetchedTicks.length === 0) {
             currentLogger.error(`${logPrefix} Critical failure: One or more TickLens fetches failed AND no ticks were retrieved.`);
             return null;
        }
        if (allFetchedTicks.length === 0) {
            currentLogger.warn(`${logPrefix} No initialized ticks found in range via TickLens. Simulation may be inaccurate.`);
            return new TickListDataProvider([], tickSpacing); // Return empty provider
        }

        // Formatting ticks...
        currentLogger.debug(`${logPrefix} Formatting ${allFetchedTicks.length} fetched ticks...`);
        const formattedTicks = allFetchedTicks
            .map(tick => {
                 try {
                     // Add more robust check for BigInt conversion source
                     const rawTick = tick?.tick;
                     const rawLiqNet = tick?.liquidityNet;
                     const rawLiqGross = tick?.liquidityGross;
                     if (rawTick === undefined || rawLiqNet === undefined || rawLiqGross === undefined) {
                         throw new Error(`Missing required properties (tick/liquidityNet/liquidityGross)`);
                     }
                     return {
                         tick: Number(rawTick),
                         // Ensure the source values are indeed BigNumberish before calling toString()
                         liquidityNet: JSBI.BigInt(rawLiqNet.toString()),
                         liquidityGross: JSBI.BigInt(rawLiqGross.toString()),
                     };
                 } catch (conversionError) {
                     currentLogger.error(`${logPrefix} Error converting tick data: ${conversionError.message || conversionError} on raw tick data: ${JSON.stringify(tick)}`);
                     return null;
                 }
            })
            .filter(tick => tick !== null)
            .sort((a, b) => a.tick - b.tick);

        if (formattedTicks.length === 0) {
             currentLogger.error(`${logPrefix} All fetched ticks failed formatting/filtering. Cannot create provider.`);
             return null;
        }

        const minTick = formattedTicks[0]?.tick ?? 'N/A';
        const maxTick = formattedTicks[formattedTicks.length - 1]?.tick ?? 'N/A';
        currentLogger.info(`${logPrefix} Created TickListDataProvider with ${formattedTicks.length} ticks. Range: [${minTick} to ${maxTick}]`);

        return new TickListDataProvider(formattedTicks, tickSpacing);

    } catch (error) {
        currentLogger.error(`${logPrefix} Unexpected error within getTickDataProvider setup/execution:`, error);
        return null;
    }
}


// --- Single Swap Simulation Function ---
// No changes needed here
async function simulateSingleSwapExactIn(poolState, tokenIn, tokenOut, amountIn, provider) {
    const currentLogger = logger || console;
    const logPrefix = `[SimSwap Pool: ${poolState?.address?.substring(0, 10) || 'N/A'}]`;

    // Input Validation...
    if (!poolState || !tokenIn || !tokenOut || typeof amountIn === 'undefined' || !provider) { /* ... */ return null; }
    let amountInJSBI;
    try { amountInJSBI = JSBI.BigInt(amountIn.toString()); }
    catch (e) { /* ... */ return null; }
    if (!poolState.sqrtPriceX96 || !poolState.liquidity || typeof poolState.tick !== 'number' || typeof poolState.feeBps !== 'number' || typeof poolState.tickSpacing !== 'number') { /* ... */ return null; }
    if (poolState.tickSpacing <= 0) { /* ... */ return null; }
    if (JSBI.equal(amountInJSBI, JSBI.BigInt(0))) { /* ... */ }

    currentLogger.info(`${logPrefix} Simulating exact IN: ${ethers.formatUnits(amountInJSBI.toString(), tokenIn.decimals)} ${tokenIn.symbol} -> ${tokenOut.symbol}`);

    // Get Tick Data Provider
    currentLogger.debug(`${logPrefix} Attempting to get tick data provider...`);
    const tickProviderState = { tick: poolState.tick, tickSpacing: poolState.tickSpacing };
    const tickDataProvider = await getTickDataProvider(poolState.address, tickProviderState, provider);
    if (!tickDataProvider) { currentLogger.error(`${logPrefix} Failed to get tick data provider (returned null/empty). Cannot simulate swap.`); return null; }
    currentLogger.debug(`${logPrefix} Successfully obtained tick data provider.`);

    try {
        // Create Pool Instance
        const pool = new Pool(
            tokenIn, tokenOut, poolState.feeBps,
            JSBI.BigInt(poolState.sqrtPriceX96.toString()),
            JSBI.BigInt(poolState.liquidity.toString()),
            poolState.tick,
            tickDataProvider
        );

        // Perform Simulation
        const zeroForOne = tokenIn.address.toLowerCase() < tokenOut.address.toLowerCase();
        currentLogger.debug(`${logPrefix} zeroForOne: ${zeroForOne}`);

        let swapResult;
        if (typeof pool.simulateSwap === 'function') {
             swapResult = await pool.simulateSwap(zeroForOne, amountInJSBI, { /* options */ });
         } else {
              throw new Error("Suitable simulation method (e.g., simulateSwap) not found on Pool object.");
         }
        const amountOutJSBI = swapResult.amountOut;
        const poolAfter = pool.clone();
        poolAfter.sqrtRatioX96 = swapResult.sqrtRatioNextX96;
        poolAfter.tickCurrent = swapResult.tickNext;

        // Process Results
        const amountOutNum = ethers.formatUnits(amountOutJSBI.toString(), tokenOut.decimals);
        currentLogger.info(`${logPrefix} Simulation Result: Got ${amountOutNum} ${tokenOut.symbol}. New Tick: ${poolAfter.tickCurrent}, New SqrtPrice: ${poolAfter.sqrtRatioX96.toString()}`);

        return {
            amountOut: amountOutJSBI,
            sqrtPriceX96After: poolAfter.sqrtRatioX96,
            tickAfter: poolAfter.tickCurrent
        };

    } catch (error) { /* ... error handling ... */ return null; }
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

    currentLogger.info(`${logPrefix} Starting simulation...`);
    currentLogger.info(`${logPrefix} Path: ${token0.symbol} -> ${token1.symbol} (on ${poolSwap.address} / ${poolSwap.feeBps}bps) -> ${token0.symbol} (on ${poolBorrow.address} / ${poolBorrow.feeBps}bps)`);

    let initialBorrowAmountJSBI;
    try { initialBorrowAmountJSBI = JSBI.BigInt(flashLoanAmount.toString()); }
    catch (e) { /* ... */ return null; }

    // Hop 1
    currentLogger.info(`${logPrefix} Simulating Hop 1: ${ethers.formatUnits(initialBorrowAmountJSBI.toString(), token0.decimals)} ${token0.symbol} -> ${token1.symbol} on pool ${poolSwap.address}`);
    const hop1Result = await simulateSingleSwapExactIn(poolSwap, token0, token1, initialBorrowAmountJSBI, provider);
    if (!hop1Result || typeof hop1Result.amountOut === 'undefined') { currentLogger.warn(`${logPrefix} Hop 1 simulation failed.`); return null; }
    if (JSBI.equal(hop1Result.amountOut, JSBI.BigInt(0))) { /* ... handle zero output ... */ return { /* zero/loss result */ }; }
    const amountToken1Received = hop1Result.amountOut;
    currentLogger.info(`${logPrefix} Hop 1 Result: Received ${ethers.formatUnits(amountToken1Received.toString(), token1.decimals)} ${token1.symbol}`);

    // Hop 2
    currentLogger.info(`${logPrefix} Simulating Hop 2: ${ethers.formatUnits(amountToken1Received.toString(), token1.decimals)} ${token1.symbol} -> ${token0.symbol} on pool ${poolBorrow.address}`);
    const hop2Result = await simulateSingleSwapExactIn(poolBorrow, token1, token0, amountToken1Received, provider);
    if (!hop2Result || typeof hop2Result.amountOut === 'undefined') { currentLogger.warn(`${logPrefix} Hop 2 simulation failed.`); return null; }
    if (JSBI.equal(hop2Result.amountOut, JSBI.BigInt(0))) { /* ... */ return { /* zero/loss result */ }; }
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
