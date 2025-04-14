// core/quoteSimulator.js
const { ethers, JsonRpcProvider } = require('ethers');
const { CurrencyAmount, TradeType, Percent, Token } = require('@uniswap/sdk-core');
const { Pool, Route, Trade, TickListDataProvider } = require('@uniswap/v3-sdk');
const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler');
const config = require('../config/index.js');
// Removed ABIS require as TickLens ABI is defined here now
// const { ABIS } = require('../constants/abis');

// TickLens Contract Info
const TICK_LENS_ADDRESS = '0xbfd8137f7d1516d3ea5cA83523914859ec47F573';
const TICK_LENS_ABI = [
    'function getPopulatedTicksInWord(address pool, int16 tickBitmapIndex) external view returns (tuple(int24 tick, int128 liquidityNet, int128 liquidityGross)[] populatedTicks)'
];

// --- UPDATED simulateSingleTradeSDK FUNCTION ---
async function simulateSingleTradeSDK( provider, poolAddress, poolForTrade, tokenIn, tokenOut, amountIn ) { // Added poolAddress arg
    // --- Updated Validation ---
    if (!provider) { logger.error('[Simulator SDK] Provider instance is required.'); return null; }
    if (!ethers.isAddress(poolAddress)) { logger.error(`[Simulator SDK] Invalid poolAddress received: ${poolAddress}`); return null; }
    // Check if poolForTrade is a valid Uniswap SDK Pool object
    if (!(poolForTrade instanceof Pool) || typeof poolForTrade.tickSpacing !== 'number') {
        logger.error('[Simulator SDK] Invalid poolForTrade object (not Uniswap SDK Pool or missing tickSpacing).', { poolForTrade });
        return null;
    }
    if (!amountIn || amountIn.quotient === 0n) { logger.debug(`[Simulator SDK] Cannot simulate with zero input amount.`); return null; }
    // --- End Updated Validation ---

    // Use the provided arguments directly
    const tickSpacing = poolForTrade.tickSpacing;
    // logger.debug(`[Simulator SDK] Preparing trade for ${poolAddress}, tickSpacing: ${tickSpacing}`);

    try {
        // 1. Setup TickLens Contract
        const tickLensContract = new ethers.Contract(TICK_LENS_ADDRESS, TICK_LENS_ABI, provider);

        // 2. Fetch Ticks (Using the passed poolAddress)
        const tickBitmapIndex = 0; // Still simplified
        logger.debug(`[Simulator SDK] Fetching ticks for ${poolAddress} using word index ${tickBitmapIndex}...`);
        let populatedTicks = []; // Default to empty array
        try {
            populatedTicks = await tickLensContract.getPopulatedTicksInWord(poolAddress, tickBitmapIndex);
            logger.debug(`[Simulator SDK] Fetched ${populatedTicks?.length ?? 0} populated ticks for ${poolAddress}.`);
        } catch (tickFetchError) {
             // Log error but potentially continue with empty ticks if allowed by SDK
             logger.warn(`[Simulator SDK] Error fetching ticks for pool ${poolAddress}: ${tickFetchError.message}. Proceeding with empty ticks.`);
             handleError(tickFetchError, `TickLens Fetch (${poolAddress})`);
             populatedTicks = []; // Ensure it's an empty array on error
        }

        // 3. Create Tick Data Provider
        // Handle potentially null/empty ticks gracefully
        const tickDataProvider = new TickListDataProvider(populatedTicks || [], tickSpacing);

        // 4. Build Route and Trade (using poolForTrade SDK object)
        const route = new Route([poolForTrade], tokenIn, tokenOut); // Use the SDK Pool object here
        logger.debug(`[Simulator SDK] Route created for ${poolAddress}. Attempting Trade.fromRoute...`);

        const trade = await Trade.fromRoute(route, amountIn, TradeType.EXACT_INPUT, { tickDataProvider });
        logger.debug(`[Simulator SDK] Trade.fromRoute successful for ${poolAddress}.`);

        if (!trade || !trade.outputAmount || typeof trade.outputAmount.quotient === 'undefined') {
             logger.warn(`[Simulator SDK] Trade simulation for ${poolAddress} returned invalid trade object or outputAmount.`); return null;
        }
        return trade;

    } catch (error) {
         if (error.message.includes('initialize tick') || error.message.includes('NO_VALID_TICKS')) {
             logger.warn(`[Simulator SDK] Trade simulation failed (Ticks) (${tokenIn.symbol}->${tokenOut.symbol}) pool ${poolAddress}: ${error.message}`);
         } else if (error.message.includes('liquidity') || error.message.includes('SPL') || error.code === 'RUNTIME_ERROR') {
             logger.warn(`[Simulator SDK] Trade simulation failed (Liq/Runtime) (${tokenIn.symbol}->${tokenOut.symbol}) pool ${poolAddress}: ${error.message}`);
         } else {
             logger.error(`[Simulator SDK] Unexpected error during trade simulation for pool ${poolAddress}:`, error);
             handleError(error, `simulateSingleTradeSDK (${tokenIn.symbol} -> ${tokenOut.symbol}) Pool: ${poolAddress}`);
         }
        return null;
    }
}

// calculateDynamicSimAmount function remains the same
function calculateDynamicSimAmount(poolSDK, tokenIn) {
     if (!tokenIn || !tokenIn.symbol) { logger.warn(`[Simulator] calculateDynamicSimAmount called with invalid tokenIn.`); return null; }
     if (typeof tokenIn.decimals !== 'number') { logger.error(`[Simulator] ERROR: Cannot calculate dynamic sim amount for ${tokenIn.symbol} - decimals missing!`); return null; }
     const configuredBorrowAmount = config.BORROW_AMOUNTS_WEI[tokenIn.symbol];
     if (!configuredBorrowAmount || configuredBorrowAmount === 0n) { logger.warn(`[Simulator] Configured borrow amount for ${tokenIn.symbol} is zero or missing.`); return null; }
     const fraction = 100n;
     const simAmountRaw = configuredBorrowAmount / fraction;
     if (simAmountRaw === 0n) { return CurrencyAmount.fromRawAmount(tokenIn, 1n); }
     // --- FIX for amountInForSimulation.quotient type issue ---
     // Ensure we create CurrencyAmount with a BigInt by converting potential BigNumber object from config via string
     return CurrencyAmount.fromRawAmount(tokenIn, BigInt(simAmountRaw.toString()));
}

// --- UPDATED simulateArbitrage FUNCTION ---
async function simulateArbitrage(provider, opportunity) {
    // ... (Initial validation remains the same) ...
     if (!provider) { /* ... */ return null; }
     if (!opportunity || !opportunity.swapPoolInfo?.sdkPool || !opportunity.sdkTokenBorrowed || !opportunity.sdkTokenIntermediate || !opportunity.borrowAmount) { /* ... */ return null; }
     if (typeof opportunity.sdkTokenBorrowed.decimals !== 'number' || typeof opportunity.sdkTokenIntermediate.decimals !== 'number') { /* ... */ return null; }

    const { startPoolInfo, swapPoolInfo, sdkTokenBorrowed, sdkTokenIntermediate, borrowAmount } = opportunity;
    const swapPoolSDK = swapPoolInfo.sdkPool; // This is the Uniswap SDK Pool object
    const swapPoolAddress = swapPoolInfo.address; // <<< Get the address explicitly

    // Ensure swapPoolAddress is valid
     if (!ethers.isAddress(swapPoolAddress)) {
         logger.error(`[Simulator] Invalid swapPoolInfo.address found in opportunity for group ${opportunity.groupName}: ${swapPoolAddress}`);
         return null;
     }


    let amountInForSimulation;
    let simAmountBigInt;
    let decimalsToUse;
    let symbolToUse;

    try {
        amountInForSimulation = calculateDynamicSimAmount(swapPoolSDK, sdkTokenBorrowed);

        if (!(amountInForSimulation instanceof CurrencyAmount) || typeof amountInForSimulation.quotient !== 'bigint') {
            // The check for 'bigint' should pass now due to fix in calculateDynamicSimAmount
             logger.error(`[Simulator] calculateDynamicSimAmount did not return valid CurrencyAmount with BigInt quotient for ${sdkTokenBorrowed?.symbol}.`, { amountInForSimulation });
             return null;
        }
        simAmountBigInt = amountInForSimulation.quotient; // Should be BigInt now

        decimalsToUse = sdkTokenBorrowed.decimals;
        symbolToUse = sdkTokenBorrowed.symbol ?? 'UnknownToken';

        const formattedAmount = ethers.formatUnits(simAmountBigInt, decimalsToUse);
        logger.log(`[Simulator] Simulating: ${opportunity.groupName} | Start ${startPoolInfo.feeBps}bps -> Swap ${swapPoolInfo.feeBps}bps | Sim Input ${formattedAmount} ${symbolToUse}`);

    } catch (debugError) {
         logger.error(`[DEBUG] ERROR during pre-simulation checks or formatting: ${debugError.message}`);
         handleError(debugError, `QuoteSimulator.PreSimulation (${opportunity?.groupName})`);
         return null;
    }

    // --- Actual Simulation Logic ---
    try {
        const flashFeePercent = BigInt(config.FLASH_LOAN_FEE_BPS);
        const flashFee = (borrowAmount * flashFeePercent) / 10000n;
        const requiredRepaymentAmount = borrowAmount + flashFee;

        // --- Swap 1 ---
        logger.debug("[Simulator] ---> Simulating Swap 1...");
        // --->>> UPDATED CALL: Pass swapPoolAddress <<<---
        const trade1 = await simulateSingleTradeSDK(provider, swapPoolAddress, swapPoolSDK, sdkTokenBorrowed, sdkTokenIntermediate, amountInForSimulation);
        if (!trade1) { logger.log(`[Simulator] Simulation FAIL Swap 1 (${sdkTokenBorrowed.symbol}->${sdkTokenIntermediate.symbol} on ${swapPoolInfo.feeBps}bps pool ${swapPoolAddress}).`); return null; }
        const amountOutSwap1 = trade1.outputAmount;
        if (!(amountOutSwap1 instanceof CurrencyAmount)) { /* Error handling */ throw new ArbitrageError('Internal simulation error: Invalid type for amountOutSwap1.', 'SIMULATION_ERROR'); }
        logger.debug(`[Simulator] Sim Swap 1 OK: Input ${amountInForSimulation.toSignificant(6)} ${sdkTokenBorrowed.symbol} -> Output ${amountOutSwap1.toSignificant(6)} ${sdkTokenIntermediate.symbol}`);

        // --- Swap 2 ---
        logger.debug("[Simulator] ---> Simulating Swap 2...");
        const amountInSwap2 = amountOutSwap1;
        // --->>> UPDATED CALL: Pass swapPoolAddress <<<---
        const trade2 = await simulateSingleTradeSDK(provider, swapPoolAddress, swapPoolSDK, sdkTokenIntermediate, sdkTokenBorrowed, amountInSwap2);
        if (!trade2) { logger.log(`[Simulator] Simulation FAIL Swap 2 (${sdkTokenIntermediate.symbol}->${sdkTokenBorrowed.symbol} on ${swapPoolInfo.feeBps}bps pool ${swapPoolAddress}).`); return null; }
        const amountOutSwap2_Sim = trade2.outputAmount;
         if (!(amountOutSwap2_Sim instanceof CurrencyAmount)) { /* Error handling */ throw new ArbitrageError('Internal simulation error: Invalid type for amountOutSwap2_Sim.', 'SIMULATION_ERROR'); }
        const finalAmountReceived_Sim_Raw = amountOutSwap2_Sim.quotient; // Should be BigInt
        logger.debug(`[Simulator] Sim Swap 2 OK: Input ${amountInSwap2.toSignificant(6)} ${sdkTokenIntermediate.symbol} -> Output ${amountOutSwap2_Sim.toSignificant(6)} ${sdkTokenBorrowed.symbol}`);

        // --- Extrapolation & Profit ---
        logger.debug("[Simulator] ---> Calculating Estimated Profit...");
        let finalAmountReceived_Actual_Estimated = 0n;
         if (simAmountBigInt > 0n && typeof finalAmountReceived_Sim_Raw === 'bigint') {
             finalAmountReceived_Actual_Estimated = (finalAmountReceived_Sim_Raw * borrowAmount) / simAmountBigInt;
         } else { /* Error handling */ throw new ArbitrageError('Internal simulation error: Invalid inputs for profit extrapolation.', 'SIMULATION_ERROR'); }

         logger.log(`[Simulator] Est. Final Amount Received (for actual borrow): ${ethers.formatUnits(finalAmountReceived_Actual_Estimated, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`);
         logger.log(`[Simulator] Required Repayment (for actual borrow): ${ethers.formatUnits(requiredRepaymentAmount, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`);

        if (finalAmountReceived_Actual_Estimated <= requiredRepaymentAmount) { logger.log(`[Simulator] Gross Profit Check FAIL.`); return null; }
        const grossProfit = finalAmountReceived_Actual_Estimated - requiredRepaymentAmount;
        logger.log(`[Simulator] Est. Gross Profit Found: ${ethers.formatUnits(grossProfit, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`);

        // Return results
        return { finalAmountReceived: finalAmountReceived_Actual_Estimated, requiredRepayment: requiredRepaymentAmount, grossProfit: grossProfit, simulatedAmountIn: simAmountBigInt, trade1: trade1, trade2: trade2 };

    } catch (error) {
         // ... (Error handling remains mostly the same) ...
         if (error instanceof ArbitrageError && error.type === 'SIMULATION_ERROR') { handleError(error, `QuoteSimulator.Calculation (${opportunity.groupName})`);
         } else if (error.code !== 'INVALID_ARGUMENT' && !error.message?.includes('tick data')) {
            handleError(error, `QuoteSimulator.simulateArbitrage (${opportunity.groupName})`);
         }
        logger.error(`[Simulator] Error during simulation calculation/extrapolation for group ${opportunity.groupName}: ${error.message}`);
        return null;
    }
}


// getMinimumAmountOut function remains the same
function getMinimumAmountOut(trade, slippageToleranceBps) {
    // ... (No changes needed here) ...
    if (!trade) return 0n; const slippageTolerance = new Percent(slippageToleranceBps, 10000); const amountOut = trade.minimumAmountOut(slippageTolerance); return amountOut.quotient;
}

module.exports = {
    simulateArbitrage,
    getMinimumAmountOut,
};
