// core/quoteSimulator.js

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
    const loggerPath = path.join(process.cwd(), 'utils', 'logger.js'); // Adjust if filename/path is different
    logger = require(loggerPath).logger; // Assuming logger is exported as { logger }
     if (!logger) throw new Error("Logger object not found in export");
} catch (err) {
    console.error(`FATAL: Could not load logger utility from expected path: utils/logger.js`);
    console.error(err);
    // Fallback to console if logger fails
    logger = {
        info: console.log,
        warn: console.warn,
        error: console.error,
        debug: console.log, // Simple fallback
        log: console.log // Ensure .log exists if used directly
    };
    logger.warn("!!! Logger utility failed to load, falling back to console !!!");
}
// --- End Utility Loading ---


// --- Constants ---
// Use the actual TickLens contract address on Arbitrum
const TICKLENS_ADDRESS = '0xbfd8137f7d1516D3ea5cA83523914859ec47F573';
const QUOTERV2_ADDRESS = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e'; // Keep for reference, but not used for simulation here

// --- Tick Data Provider Function ---

/**
 * Fetches tick data around the current tick for a given pool using TickLens.
 * Fetches data for the word containing the current tick, the word below, and the word above.
 * @param {string} poolAddress The address of the Uniswap V3 pool.
 * @param {object} poolState The current state of the pool (needs tickCurrent, tickSpacing).
 * @param {ethers.Provider} provider Ethers provider instance.
 * @returns {Promise<TickListDataProvider|null>} A TickListDataProvider instance or null if fetching fails.
 */
async function getTickDataProvider(poolAddress, poolState, provider) {
    if (!poolState || typeof poolState.tickCurrent !== 'number' || typeof poolState.tickSpacing !== 'number') {
        logger.error(`[TickData-${poolAddress.substring(0,10)}] Invalid poolState provided for tick fetching.`);
        return null;
    }

    // Ensure TickLensABI was loaded correctly
    if (!TickLensABI) {
         logger.error(`[TickData-${poolAddress.substring(0,10)}] TickLens ABI not loaded. Cannot proceed.`);
         return null;
    }

    const tickLens = new ethers.Contract(TICKLENS_ADDRESS, TickLensABI, provider);

    try {
        const tickCurrent = poolState.tickCurrent;
        // tickSpacing is required by tickToWord
        const tickSpacing = poolState.tickSpacing;

        if (typeof tickSpacing !== 'number' || tickSpacing <= 0) {
             logger.error(`[TickData-${poolAddress.substring(0,10)}] Invalid tickSpacing (${tickSpacing}) in poolState.`);
             return null;
        }

        // Calculate the word index for the current tick and adjacent words
        // tickToWord needs tickSpacing to correctly calculate the compressed index before division
        const currentWordPos = tickToWord(tickCurrent, tickSpacing); // Renamed from tickBitmapIndex for clarity
        const lowerWordPos = currentWordPos - 1;
        const upperWordPos = currentWordPos + 1;

        logger.info(`[TickData-${poolAddress.substring(0,10)}] Fetching ticks for words: ${lowerWordPos}, ${currentWordPos}, ${upperWordPos} (Current Tick: ${tickCurrent}, Spacing: ${tickSpacing})`);

        // Fetch ticks for all three words concurrently
        const populatedTicksPromises = [
            tickLens.getPopulatedTicksInWordRange(poolAddress, lowerWordPos, lowerWordPos),
            tickLens.getPopulatedTicksInWordRange(poolAddress, currentWordPos, currentWordPos),
            tickLens.getPopulatedTicksInWordRange(poolAddress, upperWordPos, upperWordPos),
        ];

        // Use Promise.allSettled to handle potential errors in one fetch without failing all
        const populatedTicksResults = await Promise.allSettled(populatedTicksPromises);

        let allFetchedTicks = [];
        populatedTicksResults.forEach((result, index) => {
            const wordPos = index === 0 ? lowerWordPos : index === 1 ? currentWordPos : upperWordPos;
            if (result.status === 'fulfilled') {
                // result.value is an array of PopulatedTick structs
                logger.debug(`[TickData-${poolAddress.substring(0,10)}] Fetched ${result.value.length} ticks from word ${wordPos}`);
                allFetchedTicks = allFetchedTicks.concat(result.value);
            } else {
                // Log error but continue; partial data might work in some cases, but often won't
                logger.warn(`[TickData-${poolAddress.substring(0,10)}] Failed to fetch ticks for word ${wordPos}: ${result.reason?.message || result.reason}`);
            }
        });

        if (allFetchedTicks.length === 0) {
            logger.error(`[TickData-${poolAddress.substring(0,10)}] No ticks fetched from TickLens for the required range. Cannot create provider.`);
            return null; // Cannot simulate without ticks
        }

        // Format ticks for the SDK:
        // 1. Ensure tick is a number.
        // 2. Convert liquidityNet and liquidityGross (ethers.BigNumber) to JSBI.
        // 3. Sort the combined list by tick index (ASCENDING order). This is CRITICAL.
        const formattedTicks = allFetchedTicks
            .map(tick => {
                try {
                    return {
                        tick: Number(tick.tick), // Convert tick index (number)
                        liquidityNet: JSBI.BigInt(tick.liquidityNet.toString()), // Convert BigNumber -> String -> JSBI
                        liquidityGross: JSBI.BigInt(tick.liquidityGross.toString()), // Convert BigNumber -> String -> JSBI
                    };
                } catch (conversionError) {
                    logger.error(`[TickData-${poolAddress.substring(0,10)}] Error converting tick data: ${conversionError} on tick: ${JSON.stringify(tick)}`);
                    return null; // Skip problematic ticks
                }
            })
            .filter(tick => tick !== null) // Remove any ticks that failed conversion
            .sort((a, b) => a.tick - b.tick); // Sort by tick index ASC

        if (formattedTicks.length === 0) {
            logger.error(`[TickData-${poolAddress.substring(0,10)}] No ticks remained after formatting/filtering. Cannot create provider.`);
            return null;
        }

        const minTick = formattedTicks[0]?.tick;
        const maxTick = formattedTicks[formattedTicks.length - 1]?.tick;
        logger.info(`[TickData-${poolAddress.substring(0,10)}] Total unique sorted ticks processed: ${formattedTicks.length}. Range: [${minTick} to ${maxTick}]`);

        // Return the TickListDataProvider with the combined and sorted ticks
        return new TickListDataProvider(formattedTicks, tickSpacing);

    } catch (error) {
        // Catch errors during the process (e.g., contract interaction, calculation)
        logger.error(`[TickData-${poolAddress.substring(0,10)}] Error fetching or processing tick data:`, error);
        return null; // Return null if any fundamental error occurs
    }
}


// --- Single Swap Simulation Function ---

/**
 * Simulates a single swap within a pool using fetched tick data.
 * @param {object} poolState Full pool state including address, sqrtPriceX96, liquidity, tickCurrent, fee, tickSpacing.
 * @param {Token} tokenIn The input token instance (from @uniswap/sdk-core).
 * @param {Token} tokenOut The output token instance.
 * @param {JSBI} amountIn The exact amount of tokenIn to swap (as JSBI).
 * @param {ethers.Provider} provider Ethers provider instance.
 * @returns {Promise<object|null>} Object with amountOut (JSBI), sqrtPriceX96After (JSBI), tickAfter (number), or null on failure.
 */
async function simulateSingleSwapExactIn(poolState, tokenIn, tokenOut, amountIn, provider) {
    const logPrefix = `[SimSwap Pool: ${poolState.address.substring(0, 10)}]`;
    logger.info(`${logPrefix} Simulating exact IN: ${ethers.formatUnits(amountIn.toString(), tokenIn.decimals)} ${tokenIn.symbol} -> ${tokenOut.symbol}`);

    // --- Input Validation ---
    if (!poolState || !tokenIn || !tokenOut || !amountIn || !provider) {
        logger.error(`${logPrefix} Missing required arguments for simulation.`);
        return null;
    }
    if (!poolState.sqrtPriceX96 || !poolState.liquidity || typeof poolState.tickCurrent !== 'number' || !poolState.fee || typeof poolState.tickSpacing !== 'number') {
        logger.error(`${logPrefix} Invalid poolState object provided.`);
        return null;
    }
     // Add check for tickSpacing validity here as well before using it
     if (poolState.tickSpacing <= 0) {
         logger.error(`${logPrefix} Invalid tickSpacing (${poolState.tickSpacing}) in poolState for simulation.`);
         return null;
     }
    if (JSBI.equal(amountIn, JSBI.BigInt(0))) {
         logger.warn(`${logPrefix} Input amount is zero, skipping simulation.`);
         // Return state representing no swap occurred
         return { amountOut: JSBI.BigInt(0), sqrtPriceX96After: poolState.sqrtPriceX96, tickAfter: poolState.tickCurrent };
    }

    // --- Get Tick Data Provider ---
    // It's crucial to get fresh tick data for the specific pool state we are simulating against
    const tickDataProvider = await getTickDataProvider(poolState.address, poolState, provider);
    if (!tickDataProvider) {
        logger.error(`${logPrefix} Failed to get tick data provider. Cannot simulate swap.`);
        return null; // Cannot proceed without tick data
    }

    try {
        // --- Create Pool Instance ---
        // The Pool instance requires the tick data provider for accurate simulation across ticks
        const pool = new Pool(
            tokenIn,
            tokenOut,
            poolState.fee,
            poolState.sqrtPriceX96, // From poolState
            poolState.liquidity,   // From poolState
            poolState.tickCurrent, // From poolState
            tickDataProvider       // The fetched & formatted ticks
        );

        // --- Perform Simulation ---
        // Determine zeroForOne based on token order
        // zeroForOne is true if tokenIn's address is lexicographically smaller than tokenOut's address
        const zeroForOne = tokenIn.address.toLowerCase() < tokenOut.address.toLowerCase();
        logger.debug(`${logPrefix} zeroForOne: ${zeroForOne} (tokenIn: ${tokenIn.address}, tokenOut: ${tokenOut.address})`);


        // Simulate the swap using swapExactInput method from the SDK Pool instance
        // Pass the correct zeroForOne flag
        // Note: The SDK might have changed method names or arguments. This call matches common examples.
        // Ensure this call signature is correct for the version of @uniswap/v3-sdk you are using.
        const [amountOut, poolAfter] = await pool.simulateSwap( // Check if 'simulateSwap' is correct; might be 'getOutputAmount' or similar depending on SDK version/intent
            zeroForOne,
            amountIn,
            {
                sqrtPriceLimitX96: null // Provide price limit if needed, null for none
            }
        );

        // --- Process Results ---
        const amountOutNum = ethers.formatUnits(amountOut.toString(), tokenOut.decimals); // For logging
        logger.info(`${logPrefix} Simulation Result: Got ${amountOutNum} ${tokenOut.symbol}. New Tick: ${poolAfter.tickCurrent}, New SqrtPrice: ${poolAfter.sqrtPriceX96.toString()}`);

        // Return the relevant results
        return {
            amountOut: amountOut, // Keep as JSBI for precision in subsequent steps
            sqrtPriceX96After: poolAfter.sqrtPriceX96, // JSBI
            tickAfter: poolAfter.tickCurrent // number
        };

    } catch (error) {
        // --- Handle Simulation Errors ---
        // Catch specific errors like 'Invariant failed: LOK', 'Invariant failed: LENGTH', etc.
        if (error.message?.includes('Invariant failed')) {
             logger.error(`${logPrefix} Uniswap V3 SDK Invariant Error during simulation: ${error.message}`);
        } else {
            logger.error(`${logPrefix} Unexpected error during single swap simulation:`, error);
        }
        // Log relevant details that might help debugging
        logger.debug(`${logPrefix} Simulation Inputs: AmountIn=${amountIn.toString()}, TickCurrent=${poolState.tickCurrent}, SqrtPrice=${poolState.sqrtPriceX96.toString()}, Liquidity=${poolState.liquidity.toString()}`);

        return null; // Indicate simulation failure
    }
}


// --- Arbitrage Simulation Function ---

/**
 * Simulates a two-hop arbitrage opportunity.
 * @param {object} opportunity Details of the potential arbitrage { poolBorrow, poolSwap, token0, token1, flashLoanAmount, provider }
 * @returns {Promise<object|null>} Simulation result including amounts, or null if failed/not profitable.
 */
async function simulateArbitrage(opportunity) {
    const { poolBorrow, poolSwap, token0, token1, flashLoanAmount, provider } = opportunity;
    const logPrefix = `[SimArb Group: ${token0?.symbol || '?'}_${token1?.symbol || '?'}]`; // Safer logging

    // Basic validation
     if (!poolBorrow || !poolSwap || !token0 || !token1 || !flashLoanAmount || !provider) {
         logger.error(`${logPrefix} Invalid opportunity object received. Missing required fields.`);
         logger.debug(`${logPrefix} Received opportunity: ${JSON.stringify(opportunity)}`); // Log the object
         return null;
     }

    logger.info(`${logPrefix} Starting simulation (using direct pool simulation with fetched ticks)...`);
    // Path: Borrow token0 (flash loan), Swap token0 -> token1 (on poolSwap), Swap token1 -> token0 (on poolBorrow to repay loan)
    logger.info(`${logPrefix} Path: ${token0.symbol} -> ${token1.symbol} (on ${poolSwap.address}) -> ${token0.symbol} (on ${poolBorrow.address})`);

    // --- Define Tokens and Amount ---
    // We borrow token0, swap it for token1, then swap token1 back to token0
    let initialBorrowAmountJSBI;
    try {
        initialBorrowAmountJSBI = JSBI.BigInt(flashLoanAmount.toString()); // Ensure flashLoanAmount is BigInt/String convertible
    } catch (e) {
        logger.error(`${logPrefix} Invalid flashLoanAmount format: ${flashLoanAmount}`);
        return null;
    }


    // --- Simulate Hop 1: Borrow token0, Swap for token1 on `poolSwap` ---
    logger.info(`${logPrefix} Simulating Hop 1: ${ethers.formatUnits(initialBorrowAmountJSBI.toString(), token0.decimals)} ${token0.symbol} -> ${token1.symbol} on pool ${poolSwap.address} (Fee: ${poolSwap.fee})`);
    const hop1Result = await simulateSingleSwapExactIn(
        poolSwap, // The state of the pool we are swapping ON
        token0,   // Input token for this hop (Token object)
        token1,   // Output token for this hop (Token object)
        initialBorrowAmountJSBI, // Amount of token0 we are swapping (JSBI)
        provider
    );

    if (!hop1Result || JSBI.equal(hop1Result.amountOut, JSBI.BigInt(0))) {
        logger.warn(`${logPrefix} Hop 1 simulation failed or yielded zero/invalid output.`);
        return null; // Abort if first hop fails or yields nothing
    }

    const amountToken1Received = hop1Result.amountOut; // JSBI output from hop 1
    logger.info(`${logPrefix} Hop 1 Result: Received ${ethers.formatUnits(amountToken1Received.toString(), token1.decimals)} ${token1.symbol}`);

    // --- Simulate Hop 2: Swap token1 back to token0 on `poolBorrow` ---
    // Note: We use the state of poolBorrow for this simulation.
    // The input amount is the amount of token1 we received from Hop 1.
    logger.info(`${logPrefix} Simulating Hop 2: ${ethers.formatUnits(amountToken1Received.toString(), token1.decimals)} ${token1.symbol} -> ${token0.symbol} on pool ${poolBorrow.address} (Fee: ${poolBorrow.fee})`);
    const hop2Result = await simulateSingleSwapExactIn(
        poolBorrow, // The state of the pool we are swapping ON (the borrow pool)
        token1,     // Input token for this hop (Token object)
        token0,     // Output token for this hop (Token object)
        amountToken1Received, // Amount received from Hop 1 (JSBI)
        provider
    );

    if (!hop2Result || JSBI.equal(hop2Result.amountOut, JSBI.BigInt(0))) {
        logger.warn(`${logPrefix} Hop 2 simulation failed or yielded zero/invalid output.`);
        return null; // Abort if second hop fails or yields nothing
    }

    const finalAmountToken0 = hop2Result.amountOut; // JSBI output from hop 2
    logger.info(`${logPrefix} Hop 2 Result: Received ${ethers.formatUnits(finalAmountToken0.toString(), token0.decimals)} ${token0.symbol}`);

    // --- Calculate Net Result ---
    // Compare finalAmountToken0 (JSBI) with initialBorrowAmountJSBI (JSBI)
    const profitJSBI = JSBI.subtract(finalAmountToken0, initialBorrowAmountJSBI);

    logger.info(`${logPrefix} Simulation Complete. Initial Borrow: ${ethers.formatUnits(initialBorrowAmountJSBI.toString(), token0.decimals)} ${token0.symbol}, Final Amount: ${ethers.formatUnits(finalAmountToken0.toString(), token0.decimals)} ${token0.symbol}`);

    // Return detailed results for profit calculation stage
    return {
        initialAmount: initialBorrowAmountJSBI, // JSBI
        finalAmount: finalAmountToken0,         // JSBI
        profit: profitJSBI,                     // JSBI
        token0: token0,
        token1: token1,
        poolBorrowAddress: poolBorrow.address,
        poolSwapAddress: poolSwap.address,
        borrowFee: poolBorrow.fee, // Useful context
        swapFee: poolSwap.fee,     // Useful context
    };
}


module.exports = {
    simulateArbitrage,
};
