// core/quoteSimulator.js
// ... other imports ...
const { ethers } = require('ethers'); // Ensure ethers is imported if not already

// ... potentially other code ...

const simulateArbitrage = async (opportunity, initialAmountToken0) => {
    // ... (previous code, including defining poolHop1, poolHop2, token0, token1)

    const { poolHop1, poolHop2, token0, token1 } = opportunity;
    const token0Decimals = opportunity.token0.decimals; // Use decimals from opportunity object
    const token1Decimals = opportunity.token1.decimals; // Use decimals from opportunity object

    // console.log(`[SimArb] Starting simulation for ${token0.symbol} -> ${token1.symbol} -> ${token0.symbol}`);
    // console.log(`[SimArb] Hop 1: Pool ${poolHop1.address}, Fee: ${poolHop1.fee}`);
    // console.log(`[SimArb] Hop 2: Pool ${poolHop2.address}, Fee: ${poolHop2.fee}`);
    // console.log(`[SimArb] Initial Amount ${token0.symbol}: ${ethers.formatUnits(initialAmountToken0, token0Decimals)}`);

    try {
        // --- Simulate Hop 1: Token0 -> Token1 ---
        // console.log(`[SimArb] Simulating Hop 1: ${token0.symbol} -> ${token1.symbol} with amount ${initialAmountToken0}`);
        const hop1Result = await simulateSingleSwapExactIn(
            poolHop1,
            token0,
            token1,
            initialAmountToken0
        );

        // --- DEBUG CHECK FOR HOP 1 ---
        if (!hop1Result || typeof hop1Result.amountOut === 'undefined') {
            console.error(`[SimArb DEBUG] Hop 1 result invalid or missing amountOut for ${token0.symbol} -> ${token1.symbol} on pool ${poolHop1.address}`, { initialAmountToken0: initialAmountToken0.toString(), hop1Result });
            // Return null or a specific error structure if hop 1 fails
            return {
                profitable: false,
                initialAmountToken0,
                finalAmountToken0: 0n, // Indicate failure
                amountToken1Received: 0n,
                grossProfit: -1n, // Indicate failure or loss
                error: 'Hop 1 simulation failed',
                details: { hop1Result } // Include details for debugging
            };
        }
        // console.log(`[SimArb] Hop 1 Result: Received ${ethers.formatUnits(hop1Result.amountOut, token1Decimals)} ${token1.symbol}`);
        const amountToken1Received = hop1Result.amountOut;

        // Add a check to ensure we received *some* amount before proceeding
        if (amountToken1Received <= 0n) {
             console.warn(`[SimArb WARN] Hop 1 resulted in 0 or negative output for ${token0.symbol} -> ${token1.symbol} on pool ${poolHop1.address}. Amount: ${amountToken1Received.toString()}`);
             return {
                profitable: false,
                initialAmountToken0,
                finalAmountToken0: 0n,
                amountToken1Received: 0n,
                grossProfit: -1n,
                error: 'Hop 1 simulation resulted in zero output',
                details: { hop1Result }
            };
        }


        // --- Simulate Hop 2: Token1 -> Token0 ---
        // console.log(`[SimArb] Simulating Hop 2: ${token1.symbol} -> ${token0.symbol} with amount ${amountToken1Received}`);
        const hop2Result = await simulateSingleSwapExactIn(
            poolHop2,
            token1,
            token0,
            amountToken1Received // This is line 103 (or very close to it, depending on where the call is)
        );


        // --- DEBUG CHECK FOR HOP 2 ---
        if (!hop2Result || typeof hop2Result.amountOut === 'undefined') {
             console.error(`[SimArb DEBUG] Hop 2 result invalid or missing amountOut for ${token1.symbol} -> ${token0.symbol} on pool ${poolHop2.address}`, { amountToken1Received: amountToken1Received.toString(), hop2Result });
            // Return null or a specific error structure if hop 2 fails
             return {
                profitable: false,
                initialAmountToken0,
                finalAmountToken0: 0n, // Indicate failure
                amountToken1Received,
                grossProfit: -1n, // Indicate failure or loss
                error: 'Hop 2 simulation failed',
                details: { hop1Result, hop2Result } // Include details
            };
        }
        // console.log(`[SimArb] Hop 2 Result: Received ${ethers.formatUnits(hop2Result.amountOut, token0Decimals)} ${token0.symbol}`);
        const finalAmountToken0 = hop2Result.amountOut;


        // --- Calculate Profit ---
        const grossProfit = finalAmountToken0 - initialAmountToken0;
        const profitable = grossProfit > 0n;

        // console.log(`[SimArb] Simulation Complete: Start: ${ethers.formatUnits(initialAmountToken0, token0Decimals)} ${token0.symbol}, End: ${ethers.formatUnits(finalAmountToken0, token0Decimals)} ${token0.symbol}, Profit: ${ethers.formatUnits(grossProfit, token0Decimals)} ${token0.symbol}`);

        return {
            profitable,
            initialAmountToken0,
            finalAmountToken0,
            amountToken1Received, // Added for potential use later
            grossProfit,
            details: { // Optionally include more details if needed
                hop1Pool: poolHop1.address,
                hop2Pool: poolHop2.address,
                hop1Fee: poolHop1.fee,
                hop2Fee: poolHop2.fee,
                hop1Result, // Include raw results if helpful
                hop2Result
            }
        };

    } catch (error) {
        console.error(`[SimArb] UNEXPECTED Error during simulation for opp ${opportunity.group} (${opportunity.poolHop1.fee/10000}bps -> ${opportunity.poolHop2.fee/10000}bps):`, error);
        // Log relevant details for debugging the unexpected error
        console.error(`[SimArb DEBUG] Context: InitialAmount: ${initialAmountToken0.toString()}, Token0: ${token0.symbol}, Token1: ${token1.symbol}, Pool1: ${poolHop1.address}, Pool2: ${poolHop2.address}`);
        return {
            profitable: false,
            initialAmountToken0,
            finalAmountToken0: 0n,
            amountToken1Received: 0n, // Assume 0 if error occurs mid-way
            grossProfit: -1n, // Indicate error/loss
            error: `Unexpected simulation error: ${error.message}`,
            details: {
                initialAmountToken0: initialAmountToken0.toString(),
                token0Symbol: token0.symbol,
                token1Symbol: token1.symbol,
                poolHop1Address: poolHop1.address,
                poolHop2Address: poolHop2.address,
                rawError: error // Include the raw error object if helpful
            }
        };
    }
};


// Helper function to simulate a single swap using Uniswap V3 SDK
// Ensure this function exists and handles potential errors gracefully
const simulateSingleSwapExactIn = async (poolState, tokenIn, tokenOut, amountIn) => {
    // console.log(`[DEBUG SimSwap] Simulating swap: ${amountIn.toString()} ${tokenIn.symbol} -> ${tokenOut.symbol} on pool ${poolState.address}`); // Added DEBUG log
    if (!poolState || !poolState.sqrtPriceX96 || !poolState.liquidity || typeof poolState.tick === 'undefined') {
        console.error(`[SimSwap] Invalid pool state provided for pool ${poolState?.address}:`, poolState);
        return null; // Return null if pool state is invalid
    }
     if (!tokenIn || !tokenOut) {
        console.error(`[SimSwap] Invalid tokenIn or tokenOut provided for pool ${poolState.address}`);
        return null;
    }
    if (amountIn <= 0n) {
        // console.warn(`[SimSwap WARN] Input amount is zero or negative for ${tokenIn.symbol} -> ${tokenOut.symbol} on pool ${poolState.address}. Amount: ${amountIn.toString()}`);
        // Return 0 amount out if input is 0
        return {
            amountOut: 0n,
            sdkTokenIn: tokenIn,
            sdkTokenOut: tokenOut,
        };
    }


    try {
        // Ensure tokens are SDK Tokens
        const sdkTokenIn = tokenIn; // Assuming tokenIn/tokenOut are already SDK Token instances from scanner
        const sdkTokenOut = tokenOut;

        // Create a Pool instance from the live state
        const pool = new Pool(
            sdkTokenIn,
            sdkTokenOut,
            poolState.fee,
            poolState.sqrtPriceX96.toString(), // SDK expects string
            poolState.liquidity.toString(), // SDK expects string
            poolState.tick
        );

        // Create the swap route (single hop)
        const swapRoute = new Route([pool], sdkTokenIn, sdkTokenOut);

        // Create the trade
        const trade = await Trade.fromRoute(
            swapRoute,
            CurrencyAmount.fromRawAmount(sdkTokenIn, amountIn.toString()), // Use fromRawAmount with BigInt string
            TradeType.EXACT_INPUT
        );

        // Get the output amount
        const amountOutBI = BigInt(trade.outputAmount.quotient.toString());

        // console.log(`[DEBUG SimSwap] Swap result: ${ethers.formatUnits(amountIn, tokenIn.decimals)} ${tokenIn.symbol} -> ${ethers.formatUnits(amountOutBI, tokenOut.decimals)} ${tokenOut.symbol}`); // Added DEBUG log

        return {
            amountOut: amountOutBI,
            sdkTokenIn: tokenIn, // Return original tokens passed in
            sdkTokenOut: tokenOut,
        };

    } catch (error) {
        // Log specific errors from the SDK simulation
        // Common errors: INSUFFICIENT_LIQUIDITY, INVALID_TICK
        console.error(`[SimSwap Error] Failed to simulate swap ${tokenIn.symbol} -> ${tokenOut.symbol} on pool ${poolState.address} with amount ${amountIn.toString()}:`, error.message);
        // console.error("[SimSwap Error] Pool State:", { fee: poolState.fee, sqrtPriceX96: poolState.sqrtPriceX96.toString(), liquidity: poolState.liquidity.toString(), tick: poolState.tick });
        // console.error("[SimSwap Error] Tokens:", { tokenIn: tokenIn.symbol, tokenOut: tokenOut.symbol, tokenInAddr: tokenIn.address, tokenOutAddr: tokenOut.address });

        // Decide how to handle the error. Returning null might be appropriate.
        return null; // Indicate simulation failure
        /* Alternative: return specific error structure
        return {
            amountOut: 0n,
            error: error.message,
            sdkTokenIn: tokenIn,
            sdkTokenOut: tokenOut,
        };
        */
    }
};

module.exports = {
    simulateArbitrage,
    // Export simulateSingleSwapExactIn ONLY IF it's used elsewhere, otherwise keep it local
};
