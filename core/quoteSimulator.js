// /workspaces/arbitrum-flash/core/quoteSimulator.js

const { Pool, Route, Trade } = require('@uniswap/v3-sdk');
const { Token, CurrencyAmount, TradeType, Percent } = require('@uniswap/sdk-core');
const { ethers } = require('ethers');
const logger = require('../utils/logger');
const ErrorHandler = require('../utils/errorHandler');

// Helper
function safeStringify(obj, indent = 2) { /* ... */ }

// Tick Provider Stub
const simpleTickProvider = { /* ... */ };

/**
 * Simulates a single swap.
 */
const simulateSingleSwapExactIn = async (poolState, tokenIn, tokenOut, amountIn) => {
    const log = logger || console;
    const context = `SimSwap ${tokenIn?.symbol}->${tokenOut?.symbol} (${poolState?.address}, ${poolState?.fee}bps)`;

    // Input Validation (Keep as before)
    if (!poolState || !tokenIn || !tokenOut /* ... etc ... */) { /* ... */ return null; }
    if (amountIn <= 0n) { return { amountOut: 0n, /* ... */ }; }

    try {
        // --- *** ADDED: Explicit Token Sorting & Verification *** ---
        let tokenA, tokenB;
        if (tokenIn.sortsBefore(tokenOut)) {
            tokenA = tokenIn;
            tokenB = tokenOut;
             log.debug(`[${context}] Token Order Check: Input ${tokenIn.symbol} is tokenA (sorted correctly for Pool constructor).`);
        } else {
            tokenA = tokenOut;
            tokenB = tokenIn;
             log.debug(`[${context}] Token Order Check: Input ${tokenIn.symbol} is tokenB (Tokens reversed for Pool constructor: ${tokenA.symbol}/${tokenB.symbol}).`);
        }
        // --- *** END Verification *** ---

        const pool = new Pool(
            tokenA, // MUST be the token that sorts before
            tokenB, // MUST be the token that sorts after
            poolState.fee,
            poolState.sqrtPriceX96.toString(),
            poolState.liquidity.toString(),
            poolState.tick,
            simpleTickProvider
        );

        // Route uses the *actual* input/output tokens for direction
        const swapRoute = new Route([pool], tokenIn, tokenOut);

        if (!swapRoute.pools || swapRoute.pools.length === 0) {
            log.warn(`[${context}] No valid pool in route by SDK.`); return null;
        }

        const trade = await Trade.fromRoute(
            swapRoute,
            CurrencyAmount.fromRawAmount(tokenIn, amountIn.toString()),
            TradeType.EXACT_INPUT
        );

        const amountOutBI = BigInt(trade.outputAmount.quotient.toString());
        return { amountOut: amountOutBI, sdkTokenIn: tokenIn, sdkTokenOut: tokenOut, trade: trade };

    } catch (error) {
        log.error(`[${context}] Sim Error: ${error.message}`);
        // Optionally add more detail from error object if helpful
        // if (error.code) log.error(`   Ethers Code: ${error.code}`);
        // if (error.reason) log.error(`   Ethers Reason: ${error.reason}`);
        return null;
    }
};

/**
 * Simulates a two-hop arbitrage opportunity.
 */
const simulateArbitrage = async (opportunity, initialAmountToken0) => {
    // ... (Logging and initial part remain the same) ...

    const { poolHop1, poolHop2, token0, token1, group } = opportunity;
    const logPrefix = `SimArb ${group} (${poolHop1.fee}bps->${poolHop2.fee}bps)`;
    const initialAmountFormatted = ethers.formatUnits(initialAmountToken0, token0.decimals);

    log.info(`--- Simulation Start (${logPrefix}) ---`);
    // ... (Rest of the logging and simulation logic remains the same as previous version) ...
     try {
        // Hop 1 Sim
        const hop1Result = await simulateSingleSwapExactIn(poolHop1, token0, token1, initialAmountToken0);
        // ... Hop 1 checks and logging ...
        if (!hop1Result || hop1Result.amountOut <= 0n) { /* ... handle failure ... */ return { /* ... */}; }
        const amountToken1Received = hop1Result.amountOut;
        // ... Hop 1 logging ...

        // Hop 2 Sim
        const hop2Result = await simulateSingleSwapExactIn(poolHop2, token1, token0, amountToken1Received);
         // ... Hop 2 checks and logging ...
         if (!hop2Result || typeof hop2Result.amountOut === 'undefined') { /* ... handle failure ... */ return { /* ... */}; }
         const finalAmountToken0 = hop2Result.amountOut;
         // ... Hop 2 logging ...

        // Profit Calc & Logging
        const grossProfit = finalAmountToken0 - initialAmountToken0;
        // ... Profit logging ...

        return { /* ... success result ... */ };

    } catch (error) {
        // ... High-level error handling ...
         return { /* ... error result ... */ };
    }
};

module.exports = { simulateArbitrage };
