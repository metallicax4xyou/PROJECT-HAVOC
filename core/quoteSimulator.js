// core/quoteSimulator.js

// --- ADD THIS LINE AT THE TOP ---
// Globally handle BigInts in JSON.stringify (useful for logging)
if (!BigInt.prototype.toJSON) { // Add check to avoid redefining if already done elsewhere
  BigInt.prototype.toJSON = function() { return this.toString(); };
}
// --- ---

const { ethers } = require('ethers');
const JSBI = require('jsbi');
const path = require('path'); // Import the path module
// Import specific V3 SDK components
const { Pool, TickListDataProvider, TickMath, tickToWord } = require('@uniswap/v3-sdk');

// --- Load ABI using path relative to project root ---
const tickLensAbiPath = path.join(process.cwd(), 'abis', 'TickLens.json');
let TickLensABI;
try {
    TickLensABI = require(tickLensAbiPath);
} catch (err) {
    console.error(`FATAL: Could not load TickLens ABI from expected path: ${tickLensAbiPath}`);
    console.error("Please ensure 'TickLens.json' exists in the 'abis' directory at the project root.");
    process.exit(1); // Exit if ABI can't be loaded
}
// --- End ABI Loading ---

// --- Load Required Utilities ---
// Assuming logger exists in utils/logger.js relative to project root
let logger;
try {
    const loggerPath = path.join(process.cwd(), 'utils', 'logger.js');
    logger = require(loggerPath); // Assuming logger is exported directly
     if (!logger || typeof logger.info !== 'function') {
          throw new Error("Logger object not found or is not a valid logger instance.");
     }
} catch (err) {
    console.error(`FATAL: Could not load logger utility from expected path: utils/logger.js`);
    console.error(err.message);
    logger = { info: console.log, warn: console.warn, error: console.error, debug: console.log, log: console.log };
    logger.warn("!!! Logger utility failed to load, falling back to console !!!");
}
// --- End Utility Loading ---


// --- Constants ---
const TICKLENS_ADDRESS = '0xbfd8137f7d1516D3ea5cA83523914859ec47F573';
const QUOTERV2_ADDRESS = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';

// --- Tick Data Provider Function ---
async function getTickDataProvider(poolAddress, poolState, provider) {
    const currentLogger = logger || console;
    if (!poolState || typeof poolState.tickCurrent !== 'number' || typeof poolState.tickSpacing !== 'number') {
        currentLogger.error(`[TickData-${poolAddress.substring(0,10)}] Invalid poolState provided for tick fetching.`);
        return null;
    }
    if (!TickLensABI) {
         currentLogger.error(`[TickData-${poolAddress.substring(0,10)}] TickLens ABI not loaded.`);
         return null;
    }

    const tickLens = new ethers.Contract(TICKLENS_ADDRESS, TickLensABI, provider);
    try {
        const tickCurrent = poolState.tickCurrent;
        const tickSpacing = poolState.tickSpacing;
        if (typeof tickSpacing !== 'number' || tickSpacing <= 0) {
             currentLogger.error(`[TickData-${poolAddress.substring(0,10)}] Invalid tickSpacing (${tickSpacing}).`);
             return null;
        }

        const currentWordPos = tickToWord(tickCurrent, tickSpacing);
        const lowerWordPos = currentWordPos - 1;
        const upperWordPos = currentWordPos + 1;

        currentLogger.info(`[TickData-${poolAddress.substring(0,10)}] Fetching ticks for words: ${lowerWordPos}, ${currentWordPos}, ${upperWordPos} (Current Tick: ${tickCurrent}, Spacing: ${tickSpacing})`);
        const populatedTicksPromises = [
            tickLens.getPopulatedTicksInWordRange(poolAddress, lowerWordPos, lowerWordPos),
            tickLens.getPopulatedTicksInWordRange(poolAddress, currentWordPos, currentWordPos),
            tickLens.getPopulatedTicksInWordRange(poolAddress, upperWordPos, upperWordPos),
        ];
        const populatedTicksResults = await Promise.allSettled(populatedTicksPromises);

        let allFetchedTicks = [];
        populatedTicksResults.forEach((result, index) => {
            const wordPos = index === 0 ? lowerWordPos : index === 1 ? currentWordPos : upperWordPos;
            if (result.status === 'fulfilled' && result.value) { // Check value exists
                 currentLogger.debug(`[TickData-${poolAddress.substring(0,10)}] Fetched ${result.value.length} ticks from word ${wordPos}`);
                 allFetchedTicks = allFetchedTicks.concat(result.value);
            } else {
                 currentLogger.warn(`[TickData-${poolAddress.substring(0,10)}] Failed to fetch ticks for word ${wordPos}: ${result.reason?.message || result.reason}`);
            }
        });

        if (allFetchedTicks.length === 0) {
             currentLogger.warn(`[TickData-${poolAddress.substring(0,10)}] No ticks fetched from TickLens for the required range. May impact simulation accuracy.`);
             // Proceed with empty tick data? Or return null? For simulation, maybe proceed but log clearly.
             return new TickListDataProvider([], tickSpacing); // Return empty provider
             // return null; // Alternative: Fail simulation if no ticks found
        }

        const formattedTicks = allFetchedTicks
            .map(tick => {
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
                     currentLogger.error(`[TickData-${poolAddress.substring(0,10)}] Error converting tick data: ${conversionError.message || conversionError} on tick: ${JSON.stringify(tick)}`);
                     return null;
                 }
             })
             .filter(tick => tick !== null)
             .sort((a, b) => a.tick - b.tick);

        if (formattedTicks.length === 0 && allFetchedTicks.length > 0) {
             // This case means all ticks failed conversion, which is bad
             currentLogger.error(`[TickData-${poolAddress.substring(0,10)}] All fetched ticks failed formatting. Cannot create provider.`);
             return null;
         }

        const minTick = formattedTicks[0]?.tick ?? 'N/A';
        const maxTick = formattedTicks[formattedTicks.length - 1]?.tick ?? 'N/A';
        currentLogger.info(`[TickData-${poolAddress.substring(0,10)}] Total unique sorted ticks processed: ${formattedTicks.length}. Range: [${minTick} to ${maxTick}]`);

        return new TickListDataProvider(formattedTicks, tickSpacing);

    } catch (error) {
        currentLogger.error(`[TickData-${poolAddress.substring(0,10)}] Error fetching/processing tick data:`, error);
        return null;
    }
}

// --- Single Swap Simulation Function ---
async function simulateSingleSwapExactIn(poolState, tokenIn, tokenOut, amountIn, provider) {
    const currentLogger = logger || console;
    const logPrefix = `[SimSwap Pool: ${poolState?.address?.substring(0, 10) || 'N/A'}]`;

    // --- Input Validation ---
    if (!poolState || !tokenIn || !tokenOut || typeof amountIn === 'undefined' || !provider) { // Check amountIn existence too
        currentLogger.error(`${logPrefix} Missing required arguments for simulation.`);
        return null;
    }
     // Ensure amountIn is JSBI
     let amountInJSBI;
     try {
         amountInJSBI = JSBI.BigInt(amountIn.toString());
     } catch (e) {
         currentLogger.error(`${logPrefix} Invalid amountIn format: ${amountIn}`);
         return null;
     }
     if (!poolState.sqrtPriceX96 || !poolState.liquidity || typeof poolState.tick !== 'number' || !poolState.feeBps || typeof poolState.tickSpacing !== 'number') { // Use correct names from poolState
         currentLogger.error(`${logPrefix} Invalid poolState object provided for simulation. Check tick/feeBps/tickSpacing.`);
         currentLogger.debug(`${logPrefix} Pool State: ${JSON.stringify(poolState)}`); // Stringify works now
         return null;
     }
     if (poolState.tickSpacing <= 0) {
         currentLogger.error(`${logPrefix} Invalid tickSpacing (${poolState.tickSpacing}).`);
         return null;
     }
     if (JSBI.equal(amountInJSBI, JSBI.BigInt(0))) {
          currentLogger.warn(`${logPrefix} Input amount is zero, skipping simulation.`);
          return { amountOut: JSBI.BigInt(0), sqrtPriceX96After: poolState.sqrtPriceX96, tickAfter: poolState.tick }; // Use tick not tickCurrent
     }

    currentLogger.info(`${logPrefix} Simulating exact IN: ${ethers.formatUnits(amountInJSBI.toString(), tokenIn.decimals)} ${tokenIn.symbol} -> ${tokenOut.symbol}`);


    // --- Get Tick Data Provider ---
    // Pass tickCurrent and tickSpacing from poolState correctly
    const tickProviderState = { tickCurrent: poolState.tick, tickSpacing: poolState.tickSpacing };
    const tickDataProvider = await getTickDataProvider(poolState.address, tickProviderState, provider);
    if (!tickDataProvider) {
        currentLogger.error(`${logPrefix} Failed to get tick data provider. Cannot simulate swap.`);
        return null;
    }

    try {
        // --- Create Pool Instance ---
        // Ensure correct property names and types from poolState
        const pool = new Pool(
            tokenIn,
            tokenOut,
            poolState.feeBps, // Use feeBps from poolState
            JSBI.BigInt(poolState.sqrtPriceX96.toString()),
            JSBI.BigInt(poolState.liquidity.toString()),
            poolState.tick, // Use tick from poolState
            tickDataProvider
        );

        // --- Perform Simulation ---
        const zeroForOne = tokenIn.address.toLowerCase() < tokenOut.address.toLowerCase();
        currentLogger.debug(`${logPrefix} zeroForOne: ${zeroForOne} (tokenIn: ${tokenIn.address}, tokenOut: ${tokenOut.address})`);

        // Use exactInputSingle for simulation (common method)
        const swapResult = await pool.exactInputSingle({
             amountIn: amountInJSBI,
             zeroForOne: zeroForOne,
             sqrtPriceLimitX96: zeroForOne // Use appropriate limits based on direction
                 ? JSBI.add(TickMath.MIN_SQRT_RATIO, JSBI.BigInt(1))
                 : JSBI.subtract(TickMath.MAX_SQRT_RATIO, JSBI.BigInt(1)),
         });

         const amountOutJSBI = swapResult.amountOut; // The amount received
         const poolAfter = await pool.advancePosition({ // Get pool state after the swap
              liquidityDelta: JSBI.BigInt(0), // No liquidity change
              sqrtPriceX96: swapResult.sqrtPriceNextX96,
              tick: swapResult.tickNext,
          });


        // --- Process Results ---
        const amountOutNum = ethers.formatUnits(amountOutJSBI.toString(), tokenOut.decimals);
        currentLogger.info(`${logPrefix} Simulation Result: Got ${amountOutNum} ${tokenOut.symbol}. New Tick: ${poolAfter.tickCurrent}, New SqrtPrice: ${poolAfter.sqrtPriceX96.toString()}`);

        return {
            amountOut: amountOutJSBI, // JSBI
            sqrtPriceX96After: poolAfter.sqrtPriceX96, // JSBI
            tickAfter: poolAfter.tickCurrent // number
        };

    } catch (error) {
        if (error.message?.includes('Invariant failed')) {
             currentLogger.error(`${logPrefix} Uniswap V3 SDK Invariant Error: ${error.message}`);
        } else {
            currentLogger.error(`${logPrefix} Unexpected error during single swap simulation:`, error);
        }
        currentLogger.debug(`${logPrefix} Sim Inputs: AmountIn=${amountInJSBI.toString()}, Tick=${poolState.tick}, SqrtPrice=${poolState.sqrtPriceX96.toString()}, Liq=${poolState.liquidity.toString()}`);
        return null;
    }
}

// --- Arbitrage Simulation Function ---
async function simulateArbitrage(opportunity) {
    const currentLogger = logger || console;
    // --- UPDATED: Destructure expected fields ---
    const { poolBorrow, poolSwap, token0, token1, flashLoanAmount, provider, groupName } = opportunity;
    const logPrefix = `[SimArb Group: ${groupName || `${token0?.symbol || '?'}_${token1?.symbol || '?'}`}]`;

    // --- UPDATED: Validation check for correct fields ---
    if (!poolBorrow || !poolSwap || !token0 || !token1 || typeof flashLoanAmount === 'undefined' || !provider) {
        currentLogger.error(`${logPrefix} Invalid opportunity object received. Missing fields (poolBorrow, poolSwap, token0, token1, flashLoanAmount, provider).`);
        // Log safely - BigInts are now strings
        currentLogger.debug(`${logPrefix} Received opportunity: ${JSON.stringify(opportunity, null, 2)}`);
        return null; // Return null if validation fails
    }
    // Further validation if needed (e.g., check pool addresses)
     if (!poolBorrow.address || !poolSwap.address || !token0.address || !token1.address) {
         currentLogger.error(`${logPrefix} Invalid objects within opportunity (missing addresses).`);
         return null;
     }

    currentLogger.info(`${logPrefix} Starting simulation...`);
    currentLogger.info(`${logPrefix} Path: ${token0.symbol} -> ${token1.symbol} (on ${poolSwap.address} / ${poolSwap.feeBps}bps) -> ${token0.symbol} (on ${poolBorrow.address} / ${poolBorrow.feeBps}bps)`);

    let initialBorrowAmountJSBI;
    try {
        initialBorrowAmountJSBI = JSBI.BigInt(flashLoanAmount.toString());
    } catch (e) {
        currentLogger.error(`${logPrefix} Invalid flashLoanAmount format: ${flashLoanAmount}`);
        return null;
    }

    // --- Simulate Hop 1 ---
    currentLogger.info(`${logPrefix} Simulating Hop 1: ${ethers.formatUnits(initialBorrowAmountJSBI.toString(), token0.decimals)} ${token0.symbol} -> ${token1.symbol} on pool ${poolSwap.address}`);
    const hop1Result = await simulateSingleSwapExactIn(poolSwap, token0, token1, initialBorrowAmountJSBI, provider);

    if (!hop1Result || typeof hop1Result.amountOut === 'undefined') { // Check amountOut existence
        currentLogger.warn(`${logPrefix} Hop 1 simulation failed or yielded invalid output.`);
        return null;
    }
    // Check for zero amount only if simulation succeeded
     if (JSBI.equal(hop1Result.amountOut, JSBI.BigInt(0))) {
         currentLogger.warn(`${logPrefix} Hop 1 simulation yielded zero output.`);
         // Consider if this should return null or a zero-profit result
         return { initialAmount: initialBorrowAmountJSBI, finalAmount: JSBI.BigInt(0), profit: JSBI.unaryMinus(initialBorrowAmountJSBI), sdkTokenBorrowed: token0 }; // Represent loss
     }

    const amountToken1Received = hop1Result.amountOut;
    currentLogger.info(`${logPrefix} Hop 1 Result: Received ${ethers.formatUnits(amountToken1Received.toString(), token1.decimals)} ${token1.symbol}`);

    // --- Simulate Hop 2 ---
    currentLogger.info(`${logPrefix} Simulating Hop 2: ${ethers.formatUnits(amountToken1Received.toString(), token1.decimals)} ${token1.symbol} -> ${token0.symbol} on pool ${poolBorrow.address}`);
    const hop2Result = await simulateSingleSwapExactIn(poolBorrow, token1, token0, amountToken1Received, provider);

    if (!hop2Result || typeof hop2Result.amountOut === 'undefined') { // Check amountOut existence
        currentLogger.warn(`${logPrefix} Hop 2 simulation failed or yielded invalid output.`);
        return null;
    }
    // Check for zero amount only if simulation succeeded
     if (JSBI.equal(hop2Result.amountOut, JSBI.BigInt(0))) {
         currentLogger.warn(`${logPrefix} Hop 2 simulation yielded zero output.`);
          return { initialAmount: initialBorrowAmountJSBI, finalAmount: JSBI.BigInt(0), profit: JSBI.unaryMinus(initialBorrowAmountJSBI), sdkTokenBorrowed: token0 }; // Represent loss
     }


    const finalAmountToken0 = hop2Result.amountOut;
    currentLogger.info(`${logPrefix} Hop 2 Result: Received ${ethers.formatUnits(finalAmountToken0.toString(), token0.decimals)} ${token0.symbol}`);

    // --- Calculate Gross Profit ---
    const grossProfitJSBI = JSBI.subtract(finalAmountToken0, initialBorrowAmountJSBI);

    currentLogger.info(`${logPrefix} Simulation Complete. Gross Profit: ${ethers.formatUnits(grossProfitJSBI.toString(), token0.decimals)} ${token0.symbol}`);

    // Return detailed results for profit calculation stage
    return {
        initialAmount: initialBorrowAmountJSBI, // JSBI
        finalAmount: finalAmountToken0,         // JSBI
        profit: grossProfitJSBI,                // JSBI - RENAME to grossProfit for clarity?
        grossProfit: grossProfitJSBI,           // Add explicit grossProfit field
        sdkTokenBorrowed: token0, // The token whose profit we calculated (needed for ProfitChecker)
        // Add other details if needed by ProfitChecker
        opportunityDetails: { // Optional nesting
             groupName: groupName,
             poolBorrowAddress: poolBorrow.address,
             poolSwapAddress: poolSwap.address,
             borrowFee: poolBorrow.feeBps,
             swapFee: poolSwap.feeBps,
        }
    };
}

module.exports = {
    simulateArbitrage,
};
