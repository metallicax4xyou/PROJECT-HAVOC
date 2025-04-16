// core/quoteSimulator.js

const { ethers } = require('ethers');
const JSBI = require('jsbi');
// Import specific V3 SDK components
const { Pool, TickListDataProvider, TickMath, tickToWord } = require('@uniswap/v3-sdk');
// Import the ABI for TickLens
const TickLensABI = require('../abis/TickLens.json');
// Assuming these utility functions exist and paths are correct
const { calculateSqrtPriceX96, calculateTick } = require('../utils/priceTickConversions');
const { getPoolState } = require('../utils/poolState');
const { logger } = require('../utils/logger'); // Assuming logger exists

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
    if (!poolState.sqrtPriceX96 || !poolState.liquidity || typeof poolState.tickCurrent !== 'number' || !poolState.fee || !poolState.tickSpacing) {
        logger.error(`${logPrefix} Invalid poolState object provided.`);
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
        // Simulate the swap using swapExactInput method from the SDK Pool instance
        // The third parameter is the amountIn (JSBI)
        // The fourth parameter (optional) is sqrtPriceLimitX96 - setting to null for no limit
        const [amountOut, poolAfter] = await pool.simulateSwap(
            false, // zeroForOne: true if tokenIn is token0, false otherwise. Let pool figure it out.
            amountIn,
            null // sqrtPriceLimitX96: Optional price limit, null for no limit
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
    const logPrefix = `[SimArb Group: ${token0.symbol}_${token1.symbol}]`; // Assuming token0/1 are Token instances

    logger.info(`${logPrefix} Starting simulation (using direct pool simulation with fetched ticks)...`);
    logger.info(`${logPrefix} Path: ${token0.symbol} -> ${token1.symbol} (on ${poolSwap.address}) -> ${token0.symbol} (on ${poolBorrow.address})`); // Corrected swap order for standard arb notation

    // --- Define Tokens and Amount ---
    // We borrow token0, swap it for token1, then swap token1 back to token0
    const initialBorrowAmountJSBI = JSBI.BigInt(flashLoanAmount.toString()); // Ensure flashLoanAmount is BigInt/String from config

    // --- Simulate Hop 1: Borrow token0, Swap for token1 on `poolSwap` ---
    logger.info(`${logPrefix} Simulating Hop 1: ${ethers.formatUnits(initialBorrowAmountJSBI.toString(), token0.decimals)} ${token0.symbol} -> ${token1.symbol} on pool ${poolSwap.address} (Fee: ${poolSwap.fee})`);
    const hop1Result = await simulateSingleSwapExactIn(
        poolSwap, // The state of the pool we are swapping ON
        token0,   // Input token for this hop
        token1,   // Output token for this hop
        initialBorrowAmountJSBI, // Amount of token0 we are swapping
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
        token1,     // Input token for this hop
        token0,     // Output token for this hop
        amountToken1Received, // Amount received from Hop 1
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
    // Potentially export others if needed by external modules, but maybe not needed if only used internally
    // getTickDataProvider,
    // simulateSingleSwapExactIn
};
