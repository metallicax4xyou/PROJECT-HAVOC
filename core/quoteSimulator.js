// core/quoteSimulator.js
const { ethers, JsonRpcProvider } = require('ethers'); // Ensure ethers and JsonRpcProvider are imported
const { CurrencyAmount, TradeType, Percent, Token } = require('@uniswap/sdk-core');
const { Pool, Route, Trade, TickListDataProvider } = require('@uniswap/v3-sdk'); // Add TickListDataProvider
const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler');
const config = require('../config/index.js');
const { ABIS } = require('../constants/abis');

// TickLens Contract Info (Arbitrum - same on most EVM chains)
const TICK_LENS_ADDRESS = '0xbfd8137f7d1516d3ea5cA83523914859ec47F573';
const TICK_LENS_ABI = [ // Minimal ABI for the function we need
    'function getPopulatedTicksInWord(address pool, int16 tickBitmapIndex) external view returns (tuple(int24 tick, int128 liquidityNet, int128 liquidityGross)[] populatedTicks)'
];

// --- REPLACEMENT simulateSingleTradeSDK FUNCTION ---
async function simulateSingleTradeSDK( provider, poolForTrade, tokenIn, tokenOut, amountIn ) {
    if (!provider) { logger.error('[Simulator SDK] Provider instance is required for TickLens.'); return null; }
    if (!poolForTrade || !poolForTrade.address || typeof poolForTrade.tickSpacing !== 'number') { logger.error('[Simulator SDK] Invalid poolForTrade object received.', { poolAddress: poolForTrade?.address, tickSpacing: poolForTrade?.tickSpacing }); return null; }
    if (!amountIn || amountIn.quotient === 0n) { logger.debug(`[Simulator SDK] Cannot simulate with zero input amount.`); return null; }

    const poolAddress = poolForTrade.address;
    const tickSpacing = poolForTrade.tickSpacing;
    // logger.debug(`[Simulator SDK] Preparing trade for ${poolAddress}, tickSpacing: ${tickSpacing}`);

    try {
        // 1. Setup TickLens Contract
        const tickLensContract = new ethers.Contract(TICK_LENS_ADDRESS, TICK_LENS_ABI, provider);

        // 2. Fetch Ticks (Using tickBitmapIndex 0 initially, might need more sophisticated logic for wide swaps)
        // You might need to fetch multiple words depending on how far the swap moves ticks.
        // For simplicity, starting with the word containing the current tick range.
        // A robust solution might involve TickBitmap.position(poolForTrade.tickCurrent) to find the right word index.
        const tickBitmapIndex = 0; // Simplified: Assume relevant ticks are in the first word
        logger.debug(`[Simulator SDK] Fetching ticks for ${poolAddress} using word index ${tickBitmapIndex}...`);
        const populatedTicks = await tickLensContract.getPopulatedTicksInWord(poolAddress, tickBitmapIndex);
        logger.debug(`[Simulator SDK] Fetched ${populatedTicks.length} populated ticks for ${poolAddress}.`);

        // Handle potential empty tick data - create provider even if empty, SDK might handle it
        if (!populatedTicks) {
             logger.warn(`[Simulator SDK] TickLens returned null/undefined for pool ${poolAddress} at index ${tickBitmapIndex}. Creating empty provider.`);
             populatedTicks = []; // Ensure it's an array
        }
        if (populatedTicks.length === 0) {
            logger.warn(`[Simulator SDK] No populated ticks found for pool ${poolAddress} at index ${tickBitmapIndex}. Simulation might be inaccurate or fail if ticks are required.`);
        }

        // 3. Create Tick Data Provider
        const tickDataProvider = new TickListDataProvider(populatedTicks, tickSpacing);

        // 4. Build Route and Trade (passing the tickDataProvider)
        const route = new Route([poolForTrade], tokenIn, tokenOut);
        // logger.debug(`[Simulator SDK] Route created. Attempting Trade.fromRoute...`);

        // *** Pass tickDataProvider in options ***
        const trade = await Trade.fromRoute(route, amountIn, TradeType.EXACT_INPUT, { tickDataProvider });
        // logger.debug(`[Simulator SDK] Trade.fromRoute successful.`);

        if (!trade || !trade.outputAmount || typeof trade.outputAmount.quotient === 'undefined') { logger.warn(`[Simulator SDK] Trade simulation returned invalid trade object or outputAmount.`); return null; }
        // logger.debug(`[Simulator SDK] Trade successful. Output: ${trade.outputAmount.toSignificant(8)} ${tokenOut.symbol}`);
        return trade;

    } catch (error) {
        // Check specifically for tick-related errors if possible, otherwise general handling
         if (error.message.includes('initialize tick') || error.message.includes('NO_VALID_TICKS')) {
             logger.warn(`[Simulator SDK] Trade simulation failed due to tick data issue (${tokenIn.symbol} -> ${tokenOut.symbol}) on pool ${poolAddress}: ${error.message}`);
         } else if (error.message.includes('liquidity') || error.message.includes('SPL') || error.code === 'RUNTIME_ERROR') {
             logger.warn(`[Simulator SDK] Trade simulation failed (${tokenIn.symbol} -> ${tokenOut.symbol}) on pool ${poolAddress}: ${error.message}`);
         } else {
             // Log the original error for unexpected issues
             logger.error(`[Simulator SDK] Unexpected error during trade simulation for pool ${poolAddress}:`, error);
             handleError(error, `simulateSingleTradeSDK (${tokenIn.symbol} -> ${tokenOut.symbol}) Pool: ${poolAddress}`);
             if (!error.code && !(error instanceof Error)) { logger.error("[Simulator SDK] Unexpected non-error object caught:", error); } // Log if it's not a standard Error
         }
        return null;
    }
}


// calculateDynamicSimAmount function remains the same (with robustness added previously)
function calculateDynamicSimAmount(poolSDK, tokenIn, percentageOfLiquidity = 0.5) {
     // Add a check for tokenIn itself
     if (!tokenIn || !tokenIn.symbol) {
        logger.warn(`[Simulator] calculateDynamicSimAmount called with invalid tokenIn.`);
        return null;
     }
     // Ensure decimals are present on tokenIn *before* using it
     if (typeof tokenIn.decimals !== 'number') {
         logger.error(`[Simulator] ERROR: Cannot calculate dynamic sim amount for ${tokenIn.symbol} - decimals missing!`);
         return null;
     }
     const configuredBorrowAmount = config.BORROW_AMOUNTS_WEI[tokenIn.symbol];
     if (!configuredBorrowAmount || configuredBorrowAmount === 0n) { logger.warn(`[Simulator] Configured borrow amount for ${tokenIn.symbol} is zero or missing.`); return null; }
     const fraction = 100n; // Simulate with 1%
     const simAmountRaw = configuredBorrowAmount / fraction;
     if (simAmountRaw === 0n) { logger.warn(`[Simulator] Calculated simulation amount is zero for ${tokenIn.symbol}. Using a minimal unit.`); return CurrencyAmount.fromRawAmount(tokenIn, 1n); }
     // Ensure the raw amount is converted to string for CurrencyAmount constructor if needed by older SDK versions
     return CurrencyAmount.fromRawAmount(tokenIn, simAmountRaw.toString()); // Use toString() just in case
}

// --- UPDATED simulateArbitrage FUNCTION ---
async function simulateArbitrage(provider, opportunity) { // <<< Added provider argument
     // --- Initial Validation ---
     if (!provider) {
         logger.error('[Simulator] CRITICAL: Provider instance not passed to simulateArbitrage!');
         return null;
     }
     if (!opportunity || !opportunity.swapPoolInfo?.sdkPool || !opportunity.sdkTokenBorrowed || !opportunity.sdkTokenIntermediate || !opportunity.borrowAmount) {
         logger.warn('[Simulator] Invalid opportunity object structure received for simulation.', { groupName: opportunity?.groupName });
         return null;
     }
     // Specifically check if sdkTokenBorrowed has decimals
     if (typeof opportunity.sdkTokenBorrowed.decimals !== 'number') {
        logger.error(`[Simulator] CRITICAL: sdkTokenBorrowed for group ${opportunity.groupName} is missing 'decimals' property! Cannot simulate.`, opportunity.sdkTokenBorrowed);
        return null;
     }
     // Also check intermediate token decimals
      if (typeof opportunity.sdkTokenIntermediate.decimals !== 'number') {
        logger.error(`[Simulator] CRITICAL: sdkTokenIntermediate for group ${opportunity.groupName} is missing 'decimals' property! Cannot simulate.`, opportunity.sdkTokenIntermediate);
        return null;
     }

    const { startPoolInfo, swapPoolInfo, sdkTokenBorrowed, sdkTokenIntermediate, borrowAmount } = opportunity;
    const swapPoolSDK = swapPoolInfo.sdkPool; // This is the Uniswap SDK Pool object

    // --- Simulation Amount Calculation & Validation ---
    let amountInForSimulation; // CurrencyAmount object
    let simAmountBigInt;         // The final BigInt value we need for formatting/extrapolation
    let decimalsToUse;
    let symbolToUse;

    try {
        // logger.debug(`[DEBUG] Attempting to calculate dynamic sim amount for token: ${sdkTokenBorrowed?.symbol}`);
        amountInForSimulation = calculateDynamicSimAmount(swapPoolSDK, sdkTokenBorrowed);
        // logger.debug(`[DEBUG] Result of calculateDynamicSimAmount:`, amountInForSimulation); // Log the object

        // More robust check: Ensure it's a CurrencyAmount and has quotient
        if (!(amountInForSimulation instanceof CurrencyAmount) || typeof amountInForSimulation.quotient === 'undefined') {
             logger.warn(`[Simulator] calculateDynamicSimAmount did not return a valid CurrencyAmount object for ${sdkTokenBorrowed?.symbol}. Aborting simulation.`);
             return null;
        }
        // logger.debug(`[DEBUG] Type of amountInForSimulation: ${Object.prototype.toString.call(amountInForSimulation)}`);
        // logger.debug(`[DEBUG] amountInForSimulation instanceof CurrencyAmount: ${amountInForSimulation instanceof CurrencyAmount}`);

        // --- Get BigInt from CurrencyAmount ---
        // CurrencyAmount.quotient should already be a BigInt per SDK spec
        simAmountBigInt = amountInForSimulation.quotient;
        // logger.debug(`[DEBUG] Extracted simAmountBigInt from quotient: ${simAmountBigInt} (Raw Type: ${typeof simAmountBigInt})`);

        if (typeof simAmountBigInt !== 'bigint') {
            // This case should ideally not happen if calculateDynamicSimAmount works correctly
            logger.error(`[DEBUG] CRITICAL INTERNAL ERROR: amountInForSimulation.quotient was not a BigInt! Type: ${typeof simAmountBigInt}. Value: ${simAmountBigInt}`);
            // Attempt conversion as a fallback (less safe)
            try {
                simAmountBigInt = BigInt(simAmountBigInt.toString());
                logger.warn(`[DEBUG] Fallback conversion to BigInt successful.`);
            } catch (conversionError) {
                 logger.error(`[DEBUG] FAILED fallback conversion to BigInt: ${conversionError.message}`);
                 throw new Error(`Could not convert amountInForSimulation.quotient to BigInt. Value: ${simAmountBigInt}`);
            }
        }
        // logger.debug(`[DEBUG] Final simAmountBigInt: ${simAmountBigInt} (Type: ${typeof simAmountBigInt})`);

        // --- Decimal and Symbol Extraction ---
        decimalsToUse = sdkTokenBorrowed.decimals;
        // logger.debug(`[DEBUG] Extracted decimalsToUse: ${decimalsToUse} (Type: ${typeof decimalsToUse})`);
        if (typeof decimalsToUse !== 'number') {
             throw new Error(`Internal Error: sdkTokenBorrowed.decimals was not a number despite earlier check.`);
        }

        symbolToUse = sdkTokenBorrowed.symbol ?? 'UnknownToken';
        // logger.debug(`[DEBUG] Extracted symbolToUse: ${symbolToUse}`);

        // --- Formatting (Now should work) ---
        const formattedAmount = ethers.formatUnits(simAmountBigInt, decimalsToUse);
        // logger.debug(`[DEBUG] Successfully formatted amount: ${formattedAmount}`);

        logger.log(`[Simulator] Simulating: ${opportunity.groupName} | Start ${startPoolInfo.feeBps}bps -> Swap ${swapPoolInfo.feeBps}bps | Sim Input ${formattedAmount} ${symbolToUse}`);

    } catch (debugError) {
         logger.error(`[DEBUG] ERROR during pre-simulation checks or formatting: ${debugError.message}`);
         logger.error(`[DEBUG] Inputs context: amountInForSimulation=${amountInForSimulation}, decimalsToUse=${decimalsToUse}`); // Log relevant context
         handleError(debugError, `QuoteSimulator.PreSimulation (${opportunity?.groupName})`);
         return null; // Abort simulation
    }

    // --- Actual Simulation Logic (using simAmountBigInt) ---
    try {
        const flashFeePercent = BigInt(config.FLASH_LOAN_FEE_BPS);
        const flashFee = (borrowAmount * flashFeePercent) / 10000n;
        const requiredRepaymentAmount = borrowAmount + flashFee;

        // --- Swap 1 ---
        // logger.debug("[Simulator] ---> Simulating Swap 1...");
        // Pass the provider instance here
        const trade1 = await simulateSingleTradeSDK(provider, swapPoolSDK, sdkTokenBorrowed, sdkTokenIntermediate, amountInForSimulation);
        if (!trade1) { logger.log(`[Simulator] Simulation FAIL Swap 1 (${sdkTokenBorrowed.symbol}->${sdkTokenIntermediate.symbol} on ${swapPoolInfo.feeBps}bps pool).`); return null; }
        const amountOutSwap1 = trade1.outputAmount; // Should be CurrencyAmount
        if (!(amountOutSwap1 instanceof CurrencyAmount)) { logger.error('[Simulator] ERROR: amountOutSwap1 is not a CurrencyAmount!', amountOutSwap1); throw new ArbitrageError('Internal simulation error: Invalid type for amountOutSwap1.', 'SIMULATION_ERROR'); }
        // logger.debug(`[Simulator] Sim Swap 1 OK: Input ${amountInForSimulation.toSignificant(6)} ${sdkTokenBorrowed.symbol} -> Output ${amountOutSwap1.toSignificant(6)} ${sdkTokenIntermediate.symbol}`);

        // --- Swap 2 ---
        // logger.debug("[Simulator] ---> Simulating Swap 2...");
        const amountInSwap2 = amountOutSwap1; // This is a CurrencyAmount
        // Pass the provider instance here
        const trade2 = await simulateSingleTradeSDK(provider, swapPoolSDK, sdkTokenIntermediate, sdkTokenBorrowed, amountInSwap2);
        if (!trade2) { logger.log(`[Simulator] Simulation FAIL Swap 2 (${sdkTokenIntermediate.symbol}->${sdkTokenBorrowed.symbol} on ${swapPoolInfo.feeBps}bps pool).`); return null; }
        const amountOutSwap2_Sim = trade2.outputAmount; // Should be CurrencyAmount
         if (!(amountOutSwap2_Sim instanceof CurrencyAmount)) { logger.error('[Simulator] ERROR: amountOutSwap2_Sim is not a CurrencyAmount!', amountOutSwap2_Sim); throw new ArbitrageError('Internal simulation error: Invalid type for amountOutSwap2_Sim.', 'SIMULATION_ERROR'); }
        const finalAmountReceived_Sim_Raw = amountOutSwap2_Sim.quotient; // This should be BigInt
        // logger.debug(`[Simulator] Sim Swap 2 OK: Input ${amountInSwap2.toSignificant(6)} ${sdkTokenIntermediate.symbol} -> Output ${amountOutSwap2_Sim.toSignificant(6)} ${sdkTokenBorrowed.symbol}`);

        // --- Extrapolation & Profit ---
         logger.debug("[Simulator] ---> Calculating Estimated Profit...");
         let finalAmountReceived_Actual_Estimated = 0n;

         // ** CRITICAL: Use simAmountBigInt for extrapolation calculation **
         if (simAmountBigInt > 0n && typeof finalAmountReceived_Sim_Raw === 'bigint') {
             finalAmountReceived_Actual_Estimated = (finalAmountReceived_Sim_Raw * borrowAmount) / simAmountBigInt; // Use the confirmed BigInt
         } else {
             logger.error(`[Simulator] ERROR: Cannot calculate estimated profit. simAmountBigInt=${simAmountBigInt} (Type: ${typeof simAmountBigInt}), finalAmountReceived_Sim_Raw=${finalAmountReceived_Sim_Raw} (Type: ${typeof finalAmountReceived_Sim_Raw})`);
             throw new ArbitrageError('Internal simulation error: Invalid inputs for profit extrapolation.', 'SIMULATION_ERROR');
         }

         logger.log(`[Simulator] Est. Final Amount Received (for actual borrow): ${ethers.formatUnits(finalAmountReceived_Actual_Estimated, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`);
         logger.log(`[Simulator] Required Repayment (for actual borrow): ${ethers.formatUnits(requiredRepaymentAmount, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`); // Log repayment for comparison

        if (finalAmountReceived_Actual_Estimated <= requiredRepaymentAmount) { logger.log(`[Simulator] Gross Profit Check FAIL. Est. Final Amount (${ethers.formatUnits(finalAmountReceived_Actual_Estimated, sdkTokenBorrowed.decimals)}) <= Required Repayment (${ethers.formatUnits(requiredRepaymentAmount, sdkTokenBorrowed.decimals)}).`); return null; }
        const grossProfit = finalAmountReceived_Actual_Estimated - requiredRepaymentAmount;
        logger.log(`[Simulator] Est. Gross Profit Found: ${ethers.formatUnits(grossProfit, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`);

        // Return results
        return { finalAmountReceived: finalAmountReceived_Actual_Estimated, requiredRepayment: requiredRepaymentAmount, grossProfit: grossProfit, simulatedAmountIn: simAmountBigInt, trade1: trade1, trade2: trade2 }; // Return the BigInt sim amount

    } catch (error) {
         if (error instanceof ArbitrageError && error.type === 'SIMULATION_ERROR') { handleError(error, `QuoteSimulator.Calculation (${opportunity.groupName})`);
         } else if (error.code !== 'INVALID_ARGUMENT' && !error.message?.includes('tick data')) { // Avoid double logging tick errors handled in simulateSingleTradeSDK
            handleError(error, `QuoteSimulator.simulateArbitrage (${opportunity.groupName})`);
         }
        logger.error(`[Simulator] Error during simulation calculation/extrapolation for group ${opportunity.groupName}: ${error.message}`);
        return null;
    }
}


// getMinimumAmountOut function remains the same
function getMinimumAmountOut(trade, slippageToleranceBps) {
    if (!trade) return 0n;
    const slippageTolerance = new Percent(slippageToleranceBps, 10000);
    const amountOut = trade.minimumAmountOut(slippageTolerance);
    return amountOut.quotient;
}

module.exports = {
    simulateArbitrage,
    getMinimumAmountOut,
    // Note: simulateSingleTradeSDK is internal, not exported
};
