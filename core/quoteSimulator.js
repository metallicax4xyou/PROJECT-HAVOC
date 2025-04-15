// core/quoteSimulator.js
const { ethers, JsonRpcProvider } = require('ethers');
const { CurrencyAmount, TradeType, Percent, Token } = require('@uniswap/sdk-core');
const { Pool, Route, Trade, TickListDataProvider } = require('@uniswap/v3-sdk');
const JSBI = require('jsbi'); // Keep JSBI import
const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler');
const config = require('../config/index.js');

// TickLens Contract Info
const TICK_LENS_ADDRESS = '0xbfd8137f7d1516d3ea5cA83523914859ec47F573';
const TICK_LENS_ABI = [ 'function getPopulatedTicksInWord(address pool, int16 tickBitmapIndex) external view returns (tuple(int24 tick, int128 liquidityNet, int128 liquidityGross)[] populatedTicks)' ];

// --- simulateSingleTradeSDK FUNCTION with FORCED LOGGING ---
async function simulateSingleTradeSDK( provider, poolAddress, poolForTrade, tokenIn, tokenOut, amountIn ) {
    // --->>> Force Entry Log <<<---
    logger.info(`[SimSDK ENTRY] Simulating on pool ${poolAddress} (${tokenIn.symbol} -> ${tokenOut.symbol})`);

    // Validation (Keep as is)
    if (!provider) { logger.error('[SimSDK] Provider instance is required.'); return null; }
    if (!ethers.isAddress(poolAddress)) { logger.error(`[SimSDK] Invalid poolAddress received: ${poolAddress}`); return null; }
    if (!(poolForTrade instanceof Pool) || typeof poolForTrade.tickSpacing !== 'number') { logger.error('[SimSDK] Invalid poolForTrade object.', { poolForTrade }); return null; }
    if (!amountIn || !(amountIn.quotient instanceof JSBI) || amountIn.quotient.raw.equalTo(JSBI.BigInt(0))) { logger.warn(`[SimSDK] Invalid or zero input amount.`); return null; } // Use JSBI check

    const tickSpacing = poolForTrade.tickSpacing;
    try {
        // 1. Setup TickLens Contract
        const tickLensContract = new ethers.Contract(TICK_LENS_ADDRESS, TICK_LENS_ABI, provider);
        const tickBitmapIndex = 0;
        // --->>> Force Tick Fetch Log <<<---
        logger.info(`[SimSDK] Fetching ticks for ${poolAddress} (Index ${tickBitmapIndex})...`);
        let populatedTicks = [];
        try {
            populatedTicks = await tickLensContract.getPopulatedTicksInWord(poolAddress, tickBitmapIndex);
             // --->>> Force Tick Result Log <<<---
            logger.info(`[SimSDK] Fetched ${populatedTicks?.length ?? 0} populated ticks for ${poolAddress}.`);
        } catch (tickFetchError) {
             logger.warn(`[SimSDK] Error fetching ticks for pool ${poolAddress}: ${tickFetchError.message}.`);
             handleError(tickFetchError, `TickLens Fetch (${poolAddress})`);
             populatedTicks = []; // Continue with empty ticks maybe? Or return null? Let's return null for now.
             return null; // Explicitly fail if ticks cannot be fetched
        }
        const tickDataProvider = new TickListDataProvider(populatedTicks || [], tickSpacing);

        // 4. Build Route and Trade
         // --->>> Force Route Log <<<---
         logger.info(`[SimSDK] Creating Route for ${poolAddress}...`);
        const route = new Route([poolForTrade], tokenIn, tokenOut);
         // --->>> Force Trade Log <<<---
         logger.info(`[SimSDK] Attempting Trade.fromRoute for ${poolAddress}...`);
        const trade = await Trade.fromRoute(route, amountIn, TradeType.EXACT_INPUT, { tickDataProvider });
         // --->>> Force Trade Success Log <<<---
         logger.info(`[SimSDK] Trade.fromRoute successful for ${poolAddress}.`);

        if (!trade || !trade.outputAmount || !(trade.outputAmount.quotient instanceof JSBI)) {
             logger.warn(`[SimSDK] Trade simulation for ${poolAddress} returned invalid trade object or outputAmount/quotient.`);
             return null; // Return null if trade object is invalid
        }
        // --->>> Force Return Log <<<---
        logger.info(`[SimSDK EXIT] Simulation SUCCESS for pool ${poolAddress}.`);
        return trade; // Return the valid trade object

    } catch (error) {
         // --->>> Force Error Log <<<---
         logger.error(`[SimSDK ERROR] Pool ${poolAddress} (${tokenIn.symbol}->${tokenOut.symbol}): ${error.message}`, /* error */); // Avoid logging full error object initially if too verbose
         handleError(error, `simulateSingleTradeSDK (${tokenIn.symbol} -> ${tokenOut.symbol}) Pool: ${poolAddress}`);
        return null; // Return null on any caught error during simulation
    }
}


// calculateDynamicSimAmount Function (No changes needed from previous fixed version)
function calculateDynamicSimAmount(tokenIn) { logger.debug(`[Calc Sim] === Starting calculation for ${tokenIn?.symbol} ===`); if (!tokenIn || !tokenIn.symbol) { logger.warn(`[Calc Sim] Invalid tokenIn object.`); return null; } if (typeof tokenIn.decimals !== 'number') { logger.error(`[Calc Sim] ERROR: tokenIn ${tokenIn.symbol} decimals is not a number: ${tokenIn.decimals}`); return null; } logger.debug(`[Calc Sim] Using Token: Symbol=${tokenIn.symbol}, Decimals=${tokenIn.decimals}, Address=${tokenIn.address}`); const configuredBorrowAmount = config.BORROW_AMOUNTS_WEI[tokenIn.symbol]; if (configuredBorrowAmount == null) { logger.warn(`[Calc Sim] Configured borrow amount for ${tokenIn.symbol} is missing.`); return null; } logger.debug(`[Calc Sim] Configured Borrow Amount (from config): ${configuredBorrowAmount} (Type: ${typeof configuredBorrowAmount})`); let baseAmountBigInt; try { baseAmountBigInt = BigInt(configuredBorrowAmount.toString()); } catch (e) { logger.error(`[Calc Sim] Failed to convert configured borrow amount for ${tokenIn.symbol} to BigInt: ${configuredBorrowAmount}`); return null; } logger.debug(`[Calc Sim] Base Amount as BigInt: ${baseAmountBigInt}`); const fraction = 100n; const simAmountRaw = baseAmountBigInt / fraction; logger.debug(`[Calc Sim] Raw Simulation Amount (Base / Fraction): ${simAmountRaw}`); let simAmountString; if (simAmountRaw === 0n) { logger.warn(`[Calc Sim] Calculated simulation amount is zero. Using minimal unit string '1'.`); simAmountString = '1'; } else { simAmountString = simAmountRaw.toString(); } logger.debug(`[Calc Sim] Final sim amount string for ${tokenIn.symbol}: "${simAmountString}"`); try { logger.debug(`[Calc Sim] Attempting CurrencyAmount.fromRawAmount with string: "${simAmountString}"`); const calculatedAmount = CurrencyAmount.fromRawAmount(tokenIn, simAmountString); logger.debug(`[Calc Sim] CurrencyAmount.fromRawAmount SUCCESS. Result quotient type: ${typeof calculatedAmount?.quotient}`); return calculatedAmount; } catch (sdkError) { logger.error(`[Calc Sim] SDK Error creating CurrencyAmount for ${tokenIn.symbol} with amount string "${simAmountString}": ${sdkError.message}`); handleError(sdkError, `Simulator.CreateCurrencyAmount (${tokenIn.symbol})`); return null; } }


// simulateArbitrage FUNCTION with more detailed failure logging
async function simulateArbitrage(provider, opportunity) {
    // ... (Initial checks remain the same) ...
    if (!provider) { logger.error("Provider missing"); return null; } if (!opportunity || !opportunity.swapPoolInfo?.sdkPool || !opportunity.sdkTokenBorrowed || !opportunity.sdkTokenIntermediate || !opportunity.borrowAmount) { logger.warn("Invalid opportunity structure"); return null; } if (typeof opportunity.sdkTokenBorrowed.decimals !== 'number' || typeof opportunity.sdkTokenIntermediate.decimals !== 'number') { logger.error("Invalid token decimals"); return null; }

    const { startPoolInfo, swapPoolInfo, sdkTokenBorrowed, sdkTokenIntermediate, borrowAmount } = opportunity;
    const swapPoolSDK = swapPoolInfo.sdkPool;
    const swapPoolAddress = swapPoolInfo.address;

    if (!ethers.isAddress(swapPoolAddress)) { logger.error(`[Simulator] Invalid swapPoolInfo.address found: ${swapPoolAddress}`); return null; }

    let amountInForSimulation; let simAmountBigInt; let decimalsToUse; let symbolToUse;
    try {
        // ... (Pre-simulation checks and BigInt conversion remain the same) ...
        logger.debug(`[Sim Arb] Calling calculateDynamicSimAmount for ${sdkTokenBorrowed?.symbol}`); amountInForSimulation = calculateDynamicSimAmount(sdkTokenBorrowed); logger.debug(`[Sim Arb] Returned from calculateDynamicSimAmount. Checking result...`); if (!(amountInForSimulation instanceof CurrencyAmount)) { logger.error(`[Sim Arb] Validation FAIL: calculateDynamicSimAmount did not return a CurrencyAmount object. Got:`, amountInForSimulation); return null; } const quotientJSBI = amountInForSimulation.quotient; if (!(quotientJSBI instanceof JSBI)) { logger.error(`[Sim Arb] Validation FAIL: Returned CurrencyAmount's quotient is not a JSBI object. Type: ${typeof quotientJSBI}. Value:`, quotientJSBI); return null; } logger.debug(`[Sim Arb] Validation PASS: Result is CurrencyAmount with JSBI quotient.`); simAmountBigInt = BigInt(quotientJSBI.toString()); logger.debug(`[Sim Arb] Converted JSBI quotient to native BigInt: ${simAmountBigInt}`); decimalsToUse = sdkTokenBorrowed.decimals; symbolToUse = sdkTokenBorrowed.symbol ?? 'UnknownToken'; const formattedAmount = ethers.formatUnits(simAmountBigInt, decimalsToUse); logger.log(`[Simulator] Simulating: ${opportunity.groupName} | Start ${startPoolInfo.feeBps}bps -> Swap ${swapPoolInfo.feeBps}bps | Sim Input ${formattedAmount} ${symbolToUse}`);
    } catch (debugError) { /* ... Error handling ... */ }

    // --- Actual Simulation Logic ---
    try {
        const flashFeePercent = BigInt(config.FLASH_LOAN_FEE_BPS); const flashFee = (borrowAmount * flashFeePercent) / 10000n; const requiredRepaymentAmount = borrowAmount + flashFee;
        logger.info("[Sim Arb] ---> Simulating Swap 1..."); // Use info log
        const trade1 = await simulateSingleTradeSDK(provider, swapPoolAddress, swapPoolSDK, sdkTokenBorrowed, sdkTokenIntermediate, amountInForSimulation);

        // --->>> Add explicit check and log for null trade1 <<<---
        if (!trade1) {
            logger.warn(`[Sim Arb] Simulation FAIL Swap 1 returned null (${sdkTokenBorrowed.symbol}->${sdkTokenIntermediate.symbol} on pool ${swapPoolAddress}).`);
            return null;
        }
        const amountOutSwap1 = trade1.outputAmount; if (!(amountOutSwap1 instanceof CurrencyAmount)) { throw new ArbitrageError('Internal simulation error: Invalid type for amountOutSwap1.', 'SIMULATION_ERROR'); }
        logger.info(`[Sim Arb] Sim Swap 1 OK.`); // Use info log

        logger.info("[Sim Arb] ---> Simulating Swap 2..."); // Use info log
        const amountInSwap2 = amountOutSwap1;
        const trade2 = await simulateSingleTradeSDK(provider, swapPoolAddress, swapPoolSDK, sdkTokenIntermediate, sdkTokenBorrowed, amountInSwap2);

         // --->>> Add explicit check and log for null trade2 <<<---
        if (!trade2) {
             logger.warn(`[Sim Arb] Simulation FAIL Swap 2 returned null (${sdkTokenIntermediate.symbol}->${sdkTokenBorrowed.symbol} on pool ${swapPoolAddress}).`);
            return null;
        }
        const amountOutSwap2_Sim = trade2.outputAmount; if (!(amountOutSwap2_Sim instanceof CurrencyAmount)) { throw new ArbitrageError('Internal simulation error: Invalid type for amountOutSwap2_Sim.', 'SIMULATION_ERROR'); }
        logger.info(`[Sim Arb] Sim Swap 2 OK.`); // Use info log

        // --->>> Profit Calculation (remains the same, using native BigInts) <<<---
        const finalAmountReceived_Sim_JSBI = amountOutSwap2_Sim.quotient; if (!(finalAmountReceived_Sim_JSBI instanceof JSBI)) { /* error */ throw new ArbitrageError('Internal simulation error: Invalid type for finalAmountReceived_Sim_JSBI.', 'SIMULATION_ERROR'); } const finalAmountReceived_Sim_Raw = BigInt(finalAmountReceived_Sim_JSBI.toString()); logger.debug(`[Sim Arb] Final Amount Raw (native): ${finalAmountReceived_Sim_Raw}`);
        logger.info("[Sim Arb] ---> Calculating Estimated Profit..."); let finalAmountReceived_Actual_Estimated = 0n; if (simAmountBigInt > 0n && typeof finalAmountReceived_Sim_Raw === 'bigint') { finalAmountReceived_Actual_Estimated = (finalAmountReceived_Sim_Raw * borrowAmount) / simAmountBigInt; } else { /* error */ throw new ArbitrageError('Internal simulation error: Invalid inputs for profit extrapolation.', 'SIMULATION_ERROR'); } logger.log(`[Simulator] Est. Final Amount Received: ${ethers.formatUnits(finalAmountReceived_Actual_Estimated, sdkTokenBorrowed.decimals)} ${symbolToUse}`); logger.log(`[Simulator] Required Repayment: ${ethers.formatUnits(requiredRepaymentAmount, sdkTokenBorrowed.decimals)} ${symbolToUse}`); if (finalAmountReceived_Actual_Estimated <= requiredRepaymentAmount) { logger.log(`[Simulator] Gross Profit Check FAIL.`); return null; } const grossProfit = finalAmountReceived_Actual_Estimated - requiredRepaymentAmount; logger.log(`[Simulator] Est. Gross Profit Found: ${ethers.formatUnits(grossProfit, sdkTokenBorrowed.decimals)} ${symbolToUse}`);
        logger.info("[Sim Arb] Simulation and Profit Calc SUCCESS.");
        return { finalAmountReceived: finalAmountReceived_Actual_Estimated, requiredRepayment: requiredRepaymentAmount, grossProfit: grossProfit, simulatedAmountIn: simAmountBigInt, trade1: trade1, trade2: trade2 };

    } catch (error) { /* Error Handling */ /* ... */ }
}


// --- getMinimumAmountOut FUNCTION (No changes needed from previous version) ---
function getMinimumAmountOut(trade, slippageToleranceBps) { /* ... */ }
module.exports = { simulateArbitrage, getMinimumAmountOut };
// Simplified error handler
const genericErrorHandler = (error, context) => { if (error instanceof ArbitrageError) { handleError(error, context); } else { handleError(error, `${context} (Unexpected)`); } logger.error(`[Simulator ERROR] Context: ${context} | Message: ${error.message}`); return null; }
