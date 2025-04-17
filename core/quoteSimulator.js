const { Pool, Route, Trade } = require('@uniswap/v3-sdk');
const { Token, CurrencyAmount, TradeType } = require('@uniswap/sdk-core');
const { ethers } = require('ethers');
const { getPoolInfo } = require('./poolDataProvider'); // Make sure this path is correct

// --- ADDED: Helper to safely stringify for logging ---
// This handles BigInts correctly when logging complex objects
function safeStringify(obj, indent = 2) {
    try {
        return JSON.stringify(obj, (_, value) =>
            typeof value === 'bigint' ? value.toString() : value, // Convert BigInt to string
        indent);
    } catch (e) {
        // Fallback in case of circular references or other stringify errors
        console.error("Error during safeStringify:", e);
        return "[Unstringifiable Object]";
    }
}

/**
 * Simulates a single swap using Uniswap V3 SDK based on live pool state.
 * @param {object} poolState - The live state of the pool (sqrtPriceX96, liquidity, tick, fee, address).
 * @param {Token} tokenIn - Uniswap SDK Token instance for the input token.
 * @param {Token} tokenOut - Uniswap SDK Token instance for the output token.
 * @param {bigint} amountIn - The exact amount of tokenIn to swap (as BigInt).
 * @returns {Promise<object|null>} Simulation result { amountOut: bigint, sdkTokenIn, sdkTokenOut } or null on failure.
 */
const simulateSingleSwapExactIn = async (poolState, tokenIn, tokenOut, amountIn) => {
    // --- Robust Input Validation ---
    if (!poolState || typeof poolState.sqrtPriceX96 === 'undefined' || typeof poolState.liquidity === 'undefined' || typeof poolState.tick === 'undefined' || typeof poolState.fee === 'undefined') {
        console.error(`[SimSwap INNER] Invalid or incomplete pool state provided for pool ${poolState?.address}. Required: sqrtPriceX96, liquidity, tick, fee. Received:`, safeStringify(poolState));
        return null; // Indicate failure: Invalid pool state
    }
    if (!tokenIn || !(tokenIn instanceof Token) || !tokenOut || !(tokenOut instanceof Token)) {
        console.error(`[SimSwap INNER] Invalid tokenIn or tokenOut provided (must be SDK Token instances) for pool ${poolState.address}`, { tokenIn, tokenOut });
        return null; // Indicate failure: Invalid tokens
    }
    if (typeof amountIn !== 'bigint' || amountIn <= 0n) {
        // Handle zero or negative input amount - typically results in zero output
        // console.warn(`[SimSwap WARN] Input amount is zero, negative, or not a BigInt for ${tokenIn.symbol} -> ${tokenOut.symbol}. Amount: ${amountIn?.toString()}`);
        return {
            amountOut: 0n,
            sdkTokenIn: tokenIn,
            sdkTokenOut: tokenOut,
        };
    }
    // --- End Validation ---

    try {
        // Uniswap SDK requires tokens sorted by address for Pool constructor
        const [tokenA, tokenB] = tokenIn.sortsBefore(tokenOut) ? [tokenIn, tokenOut] : [tokenOut, tokenIn];

        // Create a Pool instance from the live state
        const pool = new Pool(
            tokenA,                         // Sorted token instance
            tokenB,                         // Sorted token instance
            poolState.fee,                  // Pool fee tier (e.g., 3000 for 0.3%)
            poolState.sqrtPriceX96.toString(), // Current sqrt(price) ratio as string
            poolState.liquidity.toString(), // Current liquidity as string
            poolState.tick                  // Current tick
        );

        // Create the swap route (single hop) - uses unsorted tokens for direction
        const swapRoute = new Route([pool], tokenIn, tokenOut);

        // Check if the SDK found a usable pool in the route
        if (!swapRoute.pools || swapRoute.pools.length === 0) {
            console.warn(`[SimSwap WARN] No valid pool found in route by SDK for ${tokenIn.symbol} -> ${tokenOut.symbol} on pool address ${poolState.address}. This might happen with zero liquidity or extreme tick values.`);
            return null; // Indicate failure: SDK couldn't use the pool data for routing
        }

        // Create the trade object specifying exact input
        const trade = await Trade.fromRoute(
            swapRoute,
            CurrencyAmount.fromRawAmount(tokenIn, amountIn.toString()), // Input amount as CurrencyAmount
            TradeType.EXACT_INPUT
        );

        // Get the output amount as a BigInt
        const amountOutBI = BigInt(trade.outputAmount.quotient.toString());

        // console.log(`[DEBUG SimSwap] Swap result: ${ethers.formatUnits(amountIn, tokenIn.decimals)} ${tokenIn.symbol} -> ${ethers.formatUnits(amountOutBI, tokenOut.decimals)} ${tokenOut.symbol}`);

        return {
            amountOut: amountOutBI,
            sdkTokenIn: tokenIn,  // Return original tokens passed in
            sdkTokenOut: tokenOut,
        };

    } catch (error) {
        // Log specific errors from the SDK simulation
        // Common errors: InsufficientInputAmountError, InsufficientReservesError (from SDK internals)
        console.error(`[SimSwap Error] Failed to simulate swap ${tokenIn.symbol} -> ${tokenOut.symbol} on pool ${poolState.address} with amount ${amountIn.toString()}. Message: ${error.message}`, {
            poolAddress: poolState.address,
            fee: poolState.fee,
            tick: poolState.tick,
            liquidity: poolState.liquidity.toString(),
            sqrtP: poolState.sqrtPriceX96.toString(),
            // error // Uncomment to log the full error object if needed
        });
        return null; // Indicate simulation failure
    }
};


/**
 * Simulates a two-hop arbitrage opportunity (Token0 -> Token1 -> Token0).
 * @param {object} opportunity - The arbitrage opportunity details.
 * @param {Token} opportunity.token0 - SDK Token instance for the starting/ending token.
 * @param {Token} opportunity.token1 - SDK Token instance for the intermediate token.
 * @param {object} opportunity.poolHop1 - Pool state object for the first hop (Token0 -> Token1).
 * @param {object} opportunity.poolHop2 - Pool state object for the second hop (Token1 -> Token0).
 * @param {string} opportunity.group - Identifier for the token pair group.
 * @param {bigint} initialAmountToken0 - The initial amount of token0 to start the arbitrage (as BigInt).
 * @returns {Promise<object>} Simulation result including profit, amounts, and status.
 */
const simulateArbitrage = async (opportunity, initialAmountToken0) => {

    // --- ADDED: Validate the incoming opportunity object ---
    const logErrorAndReturn = (message, details) => {
        console.error(`[SimArb FATAL] ${message}`, safeStringify(details));
        return {
            profitable: false,
            error: message,
            grossProfit: -1n, // Use -1n to indicate an error state distinctly from 0 profit
            initialAmountToken0,
            finalAmountToken0: 0n,
            amountToken1Received: 0n,
            details: { errorContext: details } // Include details in the return object
        };
    };

    if (!opportunity || typeof opportunity !== 'object') {
        return logErrorAndReturn("Received invalid 'opportunity' argument (null or not an object)", opportunity);
    }

    // console.log(`[SimArb DEBUG] Received Opportunity:`, safeStringify(opportunity)); // Uncomment for deep debug

    const { poolHop1, poolHop2, token0, token1, group } = opportunity; // Destructure group for logging

    // Validate essential components are present and of correct type
    if (!poolHop1 || typeof poolHop1 !== 'object') {
        return logErrorAndReturn("Opportunity missing or invalid poolHop1 object", { opportunity });
    }
    if (!poolHop2 || typeof poolHop2 !== 'object') {
        return logErrorAndReturn("Opportunity missing or invalid poolHop2 object", { opportunity });
    }
    if (!token0 || !(token0 instanceof Token)) {
         return logErrorAndReturn("Opportunity missing or invalid token0 (must be SDK Token instance)", { opportunity });
    }
    if (!token1 || !(token1 instanceof Token)) {
         return logErrorAndReturn("Opportunity missing or invalid token1 (must be SDK Token instance)", { opportunity });
    }

    // Validate necessary properties within the pool state objects
    const validatePoolState = (poolState, hopNum) => {
        if (typeof poolState.fee === 'undefined' || typeof poolState.sqrtPriceX96 === 'undefined' ||
            typeof poolState.liquidity === 'undefined' || typeof poolState.tick === 'undefined') {
            return `Opportunity poolHop${hopNum} missing required state (fee, sqrtPriceX96, liquidity, tick)`;
        }
        return null; // No error
    };

    const pool1Error = validatePoolState(poolHop1, 1);
    if (pool1Error) {
        return logErrorAndReturn(pool1Error, { poolHop1 });
    }
    const pool2Error = validatePoolState(poolHop2, 2);
    if (pool2Error) {
        return logErrorAndReturn(pool2Error, { poolHop2 });
    }
    // --- END VALIDATION ---

    // We should have valid inputs from here on

    const token0Decimals = token0.decimals;
    const token1Decimals = token1.decimals;
    const hop1FeeBps = poolHop1.fee / 100; // Example for logging
    const hop2FeeBps = poolHop2.fee / 100; // Example for logging

    try {
        // --- Simulate Hop 1: Token0 -> Token1 ---
        // console.log(`[SimArb] Simulating Hop 1: ${token0.symbol} -> ${token1.symbol} on Pool ${poolHop1.address} (${hop1FeeBps}bps)`);
        const hop1Result = await simulateSingleSwapExactIn(
            poolHop1,
            token0,
            token1,
            initialAmountToken0
        );

        // Check Hop 1 result (simulateSingleSwapExactIn now returns null on error)
        if (!hop1Result || typeof hop1Result.amountOut === 'undefined') {
             // simulateSingleSwapExactIn should have logged the specific internal error
             console.error(`[SimArb DEBUG] Hop 1 simulation failed for ${token0.symbol} -> ${token1.symbol} on pool ${poolHop1.address}. Initial: ${initialAmountToken0.toString()}`);
             return { profitable: false, initialAmountToken0, finalAmountToken0: 0n, amountToken1Received: 0n, grossProfit: -1n, error: 'Hop 1 simulation failed internally', details: { hop1Result } }; // hop1Result might be null
        }

        const amountToken1Received = hop1Result.amountOut;

        // Check if Hop 1 produced any output
        if (amountToken1Received <= 0n) {
             console.warn(`[SimArb WARN] Hop 1 resulted in 0 output for ${token0.symbol} -> ${token1.symbol} on pool ${poolHop1.address}. Initial: ${initialAmountToken0.toString()}`);
             return { profitable: false, initialAmountToken0, finalAmountToken0: 0n, amountToken1Received: 0n, grossProfit: -1n, error: 'Hop 1 simulation resulted in zero output', details: { hop1Result } };
        }
        // console.log(`[SimArb] Hop 1 Result: Received ${ethers.formatUnits(amountToken1Received, token1Decimals)} ${token1.symbol}`);

        // --- Simulate Hop 2: Token1 -> Token0 ---
        // console.log(`[SimArb] Simulating Hop 2: ${token1.symbol} -> ${token0.symbol} on Pool ${poolHop2.address} (${hop2FeeBps}bps) with ${amountToken1Received.toString()} ${token1.symbol}`);
        const hop2Result = await simulateSingleSwapExactIn(
            poolHop2,
            token1,
            token0,
            amountToken1Received
        );

        // Check Hop 2 result
        if (!hop2Result || typeof hop2Result.amountOut === 'undefined') {
             // simulateSingleSwapExactIn should have logged the specific internal error
             console.error(`[SimArb DEBUG] Hop 2 simulation failed for ${token1.symbol} -> ${token0.symbol} on pool ${poolHop2.address}. Input: ${amountToken1Received.toString()}`);
             return { profitable: false, initialAmountToken0, finalAmountToken0: 0n, amountToken1Received, grossProfit: -1n, error: 'Hop 2 simulation failed internally', details: { hop1Result, hop2Result } }; // hop2Result might be null
        }

        const finalAmountToken0 = hop2Result.amountOut;
        // console.log(`[SimArb] Hop 2 Result: Received ${ethers.formatUnits(finalAmountToken0, token0Decimals)} ${token0.symbol}`);

        // --- Calculate Profit ---
        const grossProfit = finalAmountToken0 - initialAmountToken0;
        const profitable = grossProfit > 0n;

        // console.log(`[SimArb] Simulation Complete for ${group} (${hop1FeeBps}bps -> ${hop2FeeBps}bps): Start: ${ethers.formatUnits(initialAmountToken0, token0Decimals)} ${token0.symbol}, End: ${ethers.formatUnits(finalAmountToken0, token0Decimals)} ${token0.symbol}, Gross Profit: ${ethers.formatUnits(grossProfit, token0Decimals)} ${token0.symbol}`);

        return {
            profitable,
            initialAmountToken0,
            finalAmountToken0,
            amountToken1Received,
            grossProfit,
            error: null, // Explicitly set error to null on success
            details: { // Optional: include details for successful simulations if needed for execution
                hop1Pool: poolHop1.address,
                hop2Pool: poolHop2.address,
                hop1Fee: poolHop1.fee,
                hop2Fee: poolHop2.fee,
                // hop1Result, // Avoid including potentially large objects unless necessary
                // hop2Result
            }
        };

    } catch (error) {
        // This catch block is for truly unexpected errors within simulateArbitrage logic itself
        // (Errors *during* the swap simulation are handled inside simulateSingleSwapExactIn)
        console.error(`[SimArb] UNEXPECTED High-Level Error during simulation for opp ${group} (${poolHop1?.fee/10000}bps -> ${poolHop2?.fee/10000}bps):`, error);
        console.error(`[SimArb DEBUG] Context: InitialAmount: ${initialAmountToken0.toString()}, Token0: ${token0?.symbol}, Token1: ${token1?.symbol}, Pool1: ${poolHop1?.address}, Pool2: ${poolHop2?.address}`);

        return {
            profitable: false,
            initialAmountToken0,
            finalAmountToken0: 0n,
            amountToken1Received: 0n, // Assume 0 if error occurs mid-way or before hop 1 finishes
            grossProfit: -1n,
            error: `Unexpected simulation error: ${error.message}`,
            details: {
                initialAmountToken0Str: initialAmountToken0.toString(),
                token0Symbol: token0?.symbol,
                token1Symbol: token1?.symbol,
                poolHop1Address: poolHop1?.address,
                poolHop2Address: poolHop2?.address,
                rawError: safeStringify(error) // Stringify error safely
            }
        };
    }
};

module.exports = {
    simulateArbitrage,
    // simulateSingleSwapExactIn // Usually not needed externally, keep it local
};
