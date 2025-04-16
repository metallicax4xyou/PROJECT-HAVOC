// core/quoteSimulator.js
// ... other imports ...
const { TickMath, tickToWord } = require('@uniswap/v3-sdk'); // Import necessary helpers
const { TickLens } = require('../utils/tickLens'); // Assuming TickLens helper/ABI is here
const TickLensABI = require('../abis/TickLens.json'); // Make sure ABI path is correct

// ... existing code ...

async function getTickDataProvider(poolAddress, poolState, provider) {
    // Use the actual TickLens contract address on Arbitrum
    const tickLensAddress = '0xbfd8137f7d1516D3ea5cA83523914859ec47F573';
    const tickLens = new ethers.Contract(tickLensAddress, TickLensABI, provider);

    try {
        const tickCurrent = poolState.tickCurrent;
        const tickSpacing = poolState.tickSpacing; // Get tick spacing from pool state

        // Calculate the word index for the current tick and adjacent words
        // tickToWord is a reliable way to get the word index (pos)
        const currentWordPos = tickToWord(tickCurrent, tickSpacing); // Uniswap SDK helper function
        const lowerWordPos = currentWordPos - 1;
        const upperWordPos = currentWordPos + 1;

        console.log(`[TickData-${poolAddress.substring(0,10)}] Fetching ticks for words: ${lowerWordPos}, ${currentWordPos}, ${upperWordPos} (Current Tick: ${tickCurrent}, Spacing: ${tickSpacing})`);

        // Fetch ticks for all three words
        const populatedTicksPromises = [
            tickLens.getPopulatedTicksInWordRange(poolAddress, lowerWordPos, lowerWordPos),
            tickLens.getPopulatedTicksInWordRange(poolAddress, currentWordPos, currentWordPos),
            tickLens.getPopulatedTicksInWordRange(poolAddress, upperWordPos, upperWordPos),
        ];

        // Use Promise.allSettled to handle potential errors in one fetch without failing all
        const populatedTicksResults = await Promise.allSettled(populatedTicksPromises);

        let allFetchedTicks = [];
        populatedTicksResults.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                console.log(`[TickData-${poolAddress.substring(0,10)}] Fetched ${result.value.length} ticks from word ${index === 0 ? lowerWordPos : index === 1 ? currentWordPos : upperWordPos}`);
                allFetchedTicks = allFetchedTicks.concat(result.value);
            } else {
                // Log error but continue, maybe partial data is enough sometimes? Or throw?
                console.warn(`[TickData-${poolAddress.substring(0,10)}] Failed to fetch ticks for word ${index === 0 ? lowerWordPos : index === 1 ? currentWordPos : upperWordPos}: ${result.reason}`);
            }
        });

        if (allFetchedTicks.length === 0) {
            console.error(`[TickData-${poolAddress.substring(0,10)}] No ticks fetched at all. Cannot create provider.`);
            return null; // Or handle appropriately
        }

        // Format ticks (ensure liquidity is JSBI) and SORT them
        const formattedTicks = allFetchedTicks.map(tick => ({
            tick: Number(tick.tick), // Ensure tick is number
            liquidityNet: JSBI.BigInt(tick.liquidityNet.toString()), // Convert BigNumber to JSBI
            liquidityGross: JSBI.BigInt(tick.liquidityGross.toString()), // Convert BigNumber to JSBI
        })).sort((a, b) => a.tick - b.tick); // Sort by tick index ASC

        console.log(`[TickData-${poolAddress.substring(0,10)}] Total unique sorted ticks processed: ${formattedTicks.length}. MinTick: ${formattedTicks[0]?.tick}, MaxTick: ${formattedTicks[formattedTicks.length - 1]?.tick}`);

        // Return the TickListDataProvider with the combined and sorted ticks
        return new TickListDataProvider(formattedTicks, tickSpacing);

    } catch (error) {
        console.error(`[TickData-${poolAddress.substring(0,10)}] Error fetching or processing tick data:`, error);
        return null; // Return null if any error occurs
    }
}

// ... rest of the file (simulateSingleSwapExactIn, simulateArbitrage, etc.) ...

// Ensure simulateSingleSwapExactIn correctly uses the provider from getTickDataProvider
async function simulateSingleSwapExactIn(poolState, tokenIn, tokenOut, amountIn, provider) {
    // ... (check inputs)

    // ---> Get the TickListDataProvider
    const tickDataProvider = await getTickDataProvider(poolState.address, poolState, provider);
    if (!tickDataProvider) {
        console.error(`[SimSwap Pool: ${poolState.address}] Failed to get tick data provider.`);
        return { amountOut: JSBI.BigInt(0), sqrtPriceX96After: poolState.sqrtPriceX96, tickAfter: poolState.tickCurrent }; // Return zero/error state
    }

    // Create the pool instance using the fetched state AND the tick data provider
    const pool = new Pool(
        tokenIn,
        tokenOut,
        poolState.fee,
        poolState.sqrtPriceX96,
        poolState.liquidity,
        poolState.tickCurrent,
        tickDataProvider // <-- Pass the provider here!
    );

    // ... (rest of the simulation logic using pool.simulateSwap)
    // ... (error handling for Invariant failed: LENGTH)
}


// Make sure simulateArbitrage calls simulateSingleSwapExactIn correctly
// and passes the main Ethers provider down.

module.exports = { simulateArbitrage, getTickDataProvider, simulateSingleSwapExactIn }; // Export if needed elsewhere
