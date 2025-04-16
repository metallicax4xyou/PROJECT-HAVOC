// core/quoteSimulator.js

if (!BigInt.prototype.toJSON) {
  BigInt.prototype.toJSON = function() { return this.toString(); };
}

const { ethers } = require('ethers');
const JSBI = require('jsbi');
const path = require('path');
const { Pool, TickListDataProvider, TickMath, tickToWord } = require('@uniswap/v3-sdk');

// --- Load ABI ---
const tickLensAbiPath = path.join(process.cwd(), 'abis', 'TickLens.json');
let TickLensABI;
try { TickLensABI = require(tickLensAbiPath); }
catch (err) { console.error(`FATAL: Could not load TickLens ABI: ${err.message}`); process.exit(1); }
// --- ---

// --- Load Logger ---
let logger;
try {
    const loggerPath = path.join(process.cwd(), 'utils', 'logger.js');
    logger = require(loggerPath);
     if (!logger || typeof logger.info !== 'function') { throw new Error("Invalid logger."); }
} catch (err) { logger = { info: console.log, warn: console.warn, error: console.error, debug: console.log, log: console.log }; logger.warn("!!! Logger fallback !!!"); }
// --- ---

const TICKLENS_ADDRESS = '0xbfd8137f7d1516D3ea5cA83523914859ec47F573'; // Arbitrum TickLens

// --- Tick Data Provider Function ---
async function getTickDataProvider(poolAddress, poolState, provider) {
    const currentLogger = logger || console;
    const logPrefix = `[TickData-${poolAddress?.substring(0, 10) || 'N/A'}]`; // Safer prefix

    // --- *** ADDED DETAILED LOGGING AND CHECKS *** ---
    currentLogger.debug(`${logPrefix} Entering getTickDataProvider...`);

    if (!poolAddress || !ethers.isAddress(poolAddress)) {
         currentLogger.error(`${logPrefix} Invalid poolAddress provided.`);
         return null;
    }
    if (!poolState || typeof poolState.tick !== 'number' || typeof poolState.tickSpacing !== 'number') {
        currentLogger.error(`${logPrefix} Invalid poolState (missing tick/tickSpacing):`, poolState);
        return null;
    }
     if (!provider) {
          currentLogger.error(`${logPrefix} Provider not provided.`);
          return null;
     }
    if (!TickLensABI) {
         currentLogger.error(`${logPrefix} TickLens ABI not loaded.`);
         return null;
    }

    let tickLens;
    try {
         tickLens = new ethers.Contract(TICKLENS_ADDRESS, TickLensABI, provider);
         currentLogger.debug(`${logPrefix} TickLens contract instance created.`);
    } catch (contractError) {
         currentLogger.error(`${logPrefix} Failed to create TickLens contract instance: ${contractError.message}`);
         return null;
    }


    try {
        const tickCurrent = poolState.tick;
        const tickSpacing = poolState.tickSpacing;
        if (tickSpacing <= 0) {
             currentLogger.error(`${logPrefix} Invalid tickSpacing (${tickSpacing}).`);
             return null;
        }

        const currentWordPos = tickToWord(tickCurrent, tickSpacing);
        const lowerWordPos = currentWordPos - 1;
        const upperWordPos = currentWordPos + 1;

        currentLogger.info(`${logPrefix} Fetching ticks for words: ${lowerWordPos}, ${currentWordPos}, ${upperWordPos} (Tick: ${tickCurrent}, Spacing: ${tickSpacing})`);

        const populatedTicksPromises = [
             tickLens.getPopulatedTicksInWordRange(poolAddress, lowerWordPos, lowerWordPos).catch(e => { currentLogger.error(`${logPrefix} Error fetching word ${lowerWordPos}: ${e.message}`); return Promise.reject(e); }),
             tickLens.getPopulatedTicksInWordRange(poolAddress, currentWordPos, currentWordPos).catch(e => { currentLogger.error(`${logPrefix} Error fetching word ${currentWordPos}: ${e.message}`); return Promise.reject(e); }),
             tickLens.getPopulatedTicksInWordRange(poolAddress, upperWordPos, upperWordPos).catch(e => { currentLogger.error(`${logPrefix} Error fetching word ${upperWordPos}: ${e.message}`); return Promise.reject(e); }),
         ];

        // Use Promise.allSettled to handle potential errors in one fetch without failing all
        const populatedTicksResults = await Promise.allSettled(populatedTicksPromises);
        currentLogger.debug(`${logPrefix} Tick fetch results settled:`, populatedTicksResults);

        let allFetchedTicks = [];
        let fetchFailed = false; // Flag if any fetch promise was rejected
        populatedTicksResults.forEach((result, index) => {
            const wordPos = index === 0 ? lowerWordPos : index === 1 ? currentWordPos : upperWordPos;
            if (result.status === 'fulfilled' && result.value) {
                currentLogger.debug(`${logPrefix} Fetched ${result.value.length} ticks from word ${wordPos}`);
                allFetchedTicks = allFetchedTicks.concat(result.value);
            } else {
                // Log error but continue; partial data might work in some cases, but often won't
                 const reason = result.reason?.error?.reason || result.reason?.message || result.reason || 'Unknown fetch error';
                 currentLogger.warn(`${logPrefix} Failed to fetch ticks for word ${wordPos}: ${reason}`);
                 if (result.status === 'rejected') fetchFailed = true; // Mark if any fetch failed outright
            }
        });

         // Decide if failure is critical - maybe only if *all* fetches fail?
         if (fetchFailed && allFetchedTicks.length === 0) {
             currentLogger.error(`${logPrefix} Critical failure: One or more TickLens fetches failed AND no ticks were retrieved overall.`);
             return null; // Fail if a fetch error occurred AND we got nothing back
         }


        if (allFetchedTicks.length === 0) {
            // This might be okay if the pool truly has no liquidity near the current tick, but log a warning.
            currentLogger.warn(`${logPrefix} No ticks fetched from TickLens for the required range. Simulation might be inaccurate or fail.`);
            // Return an empty provider instead of null, as simulation might still work (though likely inaccurate)
            return new TickListDataProvider([], tickSpacing);
        }

        // Format ticks for the SDK:
        currentLogger.debug(`${logPrefix} Formatting ${allFetchedTicks.length} fetched ticks...`);
        const formattedTicks = allFetchedTicks
            .map(tick => {
                // ... (formatting logic remains the same) ...
                 try {
                     if (tick === null || typeof tick !== 'object' || typeof tick.tick === 'undefined' || typeof tick.liquidityNet === 'undefined' || typeof tick.liquidityGross === 'undefined') {
                         throw new Error(`Invalid tick structure: ${JSON.stringify(tick)}`);
                     }
                     return {
                         tick: Number(tick.tick),
                         liquidityNet: JSBI.BigInt(tick.liquidityNet.toString()),
                         liquidityGross: JSBI.BigInt(tick.liquidityGross.toString()),
                     };
                 } catch (conversionError) {
                     currentLogger.error(`${logPrefix} Error converting tick data: ${conversionError.message || conversionError} on tick: ${JSON.stringify(tick)}`);
                     return null;
                 }
            })
            .filter(tick => tick !== null)
            .sort((a, b) => a.tick - b.tick);

        if (formattedTicks.length === 0) {
             // This now means formatting failed for all ticks that were fetched
             currentLogger.error(`${logPrefix} All fetched ticks failed formatting/filtering. Cannot create provider.`);
             return null;
        }

        const minTick = formattedTicks[0]?.tick ?? 'N/A';
        const maxTick = formattedTicks[formattedTicks.length - 1]?.tick ?? 'N/A';
        currentLogger.info(`${logPrefix} Created TickListDataProvider with ${formattedTicks.length} ticks. Range: [${minTick} to ${maxTick}]`);

        // Return the TickListDataProvider with the combined and sorted ticks
        return new TickListDataProvider(formattedTicks, tickSpacing);

    } catch (error) {
        // Catch errors during the setup/calculation phase (before contract calls)
        currentLogger.error(`${logPrefix} Unexpected error within getTickDataProvider setup:`, error);
        return null; // Return null if any fundamental setup error occurs
    }
}


// --- Single Swap Simulation Function ---
async function simulateSingleSwapExactIn(poolState, tokenIn, tokenOut, amountIn, provider) {
    const currentLogger = logger || console;
    const logPrefix = `[SimSwap Pool: ${poolState?.address?.substring(0, 10) || 'N/A'}]`;

    // --- Input Validation ---
    if (!poolState || !tokenIn || !tokenOut || typeof amountIn === 'undefined' || !provider) { /* ... */ return null; }
    let amountInJSBI;
    try { amountInJSBI = JSBI.BigInt(amountIn.toString()); }
    catch (e) { /* ... */ return null; }
    if (!poolState.sqrtPriceX96 || !poolState.liquidity || typeof poolState.tick !== 'number' || typeof poolState.feeBps !== 'number' || typeof poolState.tickSpacing !== 'number') {
        currentLogger.error(`${logPrefix} Invalid poolState object provided for simulation. Check tick/feeBps/tickSpacing.`);
        currentLogger.debug(`${logPrefix} Pool State: ${JSON.stringify(poolState)}`);
        return null;
    }
    if (poolState.tickSpacing <= 0) { /* ... */ return null; }
    if (JSBI.equal(amountInJSBI, JSBI.BigInt(0))) { /* ... */ }

    currentLogger.info(`${logPrefix} Simulating exact IN: ${ethers.formatUnits(amountInJSBI.toString(), tokenIn.decimals)} ${tokenIn.symbol} -> ${tokenOut.symbol}`);

    // --- Get Tick Data Provider ---
    currentLogger.debug(`${logPrefix} Attempting to get tick data provider...`);
    const tickProviderState = { tick: poolState.tick, tickSpacing: poolState.tickSpacing };
    const tickDataProvider = await getTickDataProvider(poolState.address, tickProviderState, provider);

    // --- *** CHECK IF PROVIDER IS NULL *** ---
    if (!tickDataProvider) {
        // Logging is now done inside getTickDataProvider
        currentLogger.error(`${logPrefix} Failed to get tick data provider (returned null). Cannot simulate swap.`);
        return null; // Cannot proceed without tick data
    }
    currentLogger.debug(`${logPrefix} Successfully obtained tick data provider.`);
    // --- *** ---


    try {
        // Create Pool Instance
        const pool = new Pool(
            tokenIn, tokenOut, poolState.feeBps,
            JSBI.BigInt(poolState.sqrtPriceX96.toString()),
            JSBI.BigInt(poolState.liquidity.toString()),
            poolState.tick,
            tickDataProvider // Pass the obtained provider
        );

        // Perform Simulation
        const zeroForOne = tokenIn.address.toLowerCase() < tokenOut.address.toLowerCase();
        currentLogger.debug(`${logPrefix} zeroForOne: ${zeroForOne}`);

        // --- *** Use simulateSwap if available, otherwise adapt getOutputAmount/exactInputSingle *** ---
        // Check Uniswap SDK version being used. Let's assume simulateSwap for now.
        // This part might need significant adjustment based on the exact SDK version and methods.
        let swapResult;
        if (typeof pool.simulateSwap === 'function') {
             swapResult = await pool.simulateSwap(
                 zeroForOne,
                 amountInJSBI,
                 { /* sqrtPriceLimitX96 if needed */ }
             );
        } else if (typeof pool.getOutputAmount === 'function') {
             // Older SDK might use getOutputAmount which returns amountOut directly,
             // but doesn't give the pool state after easily. Need to re-fetch or estimate.
             currentLogger.warn(`${logPrefix} pool.simulateSwap not found, attempting pool.getOutputAmount (pool state after might be inaccurate).`);
             const [amountOut] = await pool.getOutputAmount(amountInJSBI, /* sqrtPriceLimitX96 */);
             // Cannot easily get poolAfter state here, need estimation or re-fetch.
             // This makes accurate multi-hop simulation difficult.
             // For simplicity, we might have to return null or estimate the state change poorly.
             throw new Error("SDK method 'getOutputAmount' used; accurate pool state after swap is not directly available for multi-hop.");
         } else {
             throw new Error("Suitable simulation method (simulateSwap or getOutputAmount) not found on Pool object.");
         }

         // Assuming simulateSwap was successful and returned structure like { amountOut, sqrtRatioNextX96, tickNext }
         const amountOutJSBI = swapResult.amountOut;
         const poolAfter = pool.clone(); // Need a way to get pool state after swap
         poolAfter.sqrtRatioX96 = swapResult.sqrtRatioNextX96; // Update properties based on SDK method return
         poolAfter.tickCurrent = swapResult.tickNext;
         // --- *** ---

        // Process Results
        const amountOutNum = ethers.formatUnits(amountOutJSBI.toString(), tokenOut.decimals);
        currentLogger.info(`${logPrefix} Simulation Result: Got ${amountOutNum} ${tokenOut.symbol}. New Tick: ${poolAfter.tickCurrent}, New SqrtPrice: ${poolAfter.sqrtRatioX96.toString()}`);

        return {
            amountOut: amountOutJSBI,
            sqrtPriceX96After: poolAfter.sqrtRatioX96, // Check property name from SDK
            tickAfter: poolAfter.tickCurrent // Check property name from SDK
        };

    } catch (error) { /* ... error handling ... */ return null; }
}


// --- Arbitrage Simulation Function ---
// Validation updated in previous step
async function simulateArbitrage(opportunity) {
    const currentLogger = logger || console;
    const { poolBorrow, poolSwap, token0, token1, flashLoanAmount, provider, groupName } = opportunity;
    const logPrefix = `[SimArb Group: ${groupName || `${token0?.symbol || '?'}_${token1?.symbol || '?'}`}]`;

    if (!poolBorrow || !poolSwap || !token0 || !token1 || typeof flashLoanAmount === 'undefined' || !provider) {
        currentLogger.error(`${logPrefix} Invalid opportunity object received. Missing fields.`);
        currentLogger.debug(`${logPrefix} Received opportunity: ${JSON.stringify(opportunity, null, 2)}`);
        return null;
    }
     if (!poolBorrow.address || !poolSwap.address || !token0.address || !token1.address || typeof poolBorrow.tick !== 'number' || typeof poolSwap.tick !== 'number') {
         currentLogger.error(`${logPrefix} Invalid objects within opportunity (missing address/tick).`);
         return null;
     }

    currentLogger.info(`${logPrefix} Starting simulation...`);
    currentLogger.info(`${logPrefix} Path: ${token0.symbol} -> ${token1.symbol} (on ${poolSwap.address} / ${poolSwap.feeBps}bps) -> ${token0.symbol} (on ${poolBorrow.address} / ${poolBorrow.feeBps}bps)`);

    let initialBorrowAmountJSBI;
    try { initialBorrowAmountJSBI = JSBI.BigInt(flashLoanAmount.toString()); }
    catch (e) { currentLogger.error(`${logPrefix} Invalid flashLoanAmount format.`); return null; }

    // Simulate Hop 1
    currentLogger.info(`${logPrefix} Simulating Hop 1: ${ethers.formatUnits(initialBorrowAmountJSBI.toString(), token0.decimals)} ${token0.symbol} -> ${token1.symbol} on pool ${poolSwap.address}`);
    const hop1Result = await simulateSingleSwapExactIn(poolSwap, token0, token1, initialBorrowAmountJSBI, provider);
    if (!hop1Result || typeof hop1Result.amountOut === 'undefined') { currentLogger.warn(`${logPrefix} Hop 1 simulation failed.`); return null; }
    if (JSBI.equal(hop1Result.amountOut, JSBI.BigInt(0))) { /* ... handle zero output ... */ return { /* zero/loss result */ }; }
    const amountToken1Received = hop1Result.amountOut;
    currentLogger.info(`${logPrefix} Hop 1 Result: Received ${ethers.formatUnits(amountToken1Received.toString(), token1.decimals)} ${token1.symbol}`);

    // Simulate Hop 2
    currentLogger.info(`${logPrefix} Simulating Hop 2: ${ethers.formatUnits(amountToken1Received.toString(), token1.decimals)} ${token1.symbol} -> ${token0.symbol} on pool ${poolBorrow.address}`);
    const hop2Result = await simulateSingleSwapExactIn(poolBorrow, token1, token0, amountToken1Received, provider);
    if (!hop2Result || typeof hop2Result.amountOut === 'undefined') { currentLogger.warn(`${logPrefix} Hop 2 simulation failed.`); return null; }
    if (JSBI.equal(hop2Result.amountOut, JSBI.BigInt(0))) { /* ... handle zero output ... */ return { /* zero/loss result */ }; }
    const finalAmountToken0 = hop2Result.amountOut;
    currentLogger.info(`${logPrefix} Hop 2 Result: Received ${ethers.formatUnits(finalAmountToken0.toString(), token0.decimals)} ${token0.symbol}`);

    // Calculate Gross Profit
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
