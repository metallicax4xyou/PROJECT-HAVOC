// core/quoteSimulator.js
const { ethers, JsonRpcProvider } = require('ethers');
const { CurrencyAmount, TradeType, Percent, Token } = require('@uniswap/sdk-core');
const { Pool, Route, Trade, TickListDataProvider } = require('@uniswap/v3-sdk');
const JSBI = require('jsbi');
const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler');
const config = require('../config/index.js');

// TickLens Contract Info
const TICK_LENS_ADDRESS_RAW = '0xbfd8137f7d1516d3ea5cA83523914859ec47F573';
// --->>> FIX: Normalize the address <<<---
const TICK_LENS_ADDRESS = ethers.getAddress(TICK_LENS_ADDRESS_RAW);
// --->>> End Fix <<<---

const TICK_LENS_ABI = [ 'function getPopulatedTicksInWord(address pool, int16 tickBitmapIndex) external view returns (tuple(int24 tick, int128 liquidityNet, int128 liquidityGross)[] populatedTicks)' ];

// --- simulateSingleTradeSDK FUNCTION ---
async function simulateSingleTradeSDK( provider, poolAddress, poolForTrade, tokenIn, tokenOut, amountIn ) {
    logger.info(`[SimSDK ENTRY] Simulating on pool ${poolAddress} (${tokenIn.symbol} -> ${tokenOut.symbol})`);

    // Validation
    if (!provider) { logger.error('[SimSDK] Provider instance is required.'); return null; }
    if (!ethers.isAddress(poolAddress)) { logger.error(`[SimSDK] Invalid poolAddress received: ${poolAddress}`); return null; }
    if (!(poolForTrade instanceof Pool) || typeof poolForTrade.tickSpacing !== 'number') { logger.error('[SimSDK] Invalid poolForTrade object.', { poolForTrade }); return null; }
    if (!amountIn || !(amountIn.quotient instanceof JSBI) || JSBI.equal(amountIn.quotient, JSBI.BigInt(0))) { logger.warn(`[SimSDK] Invalid or zero input amount detected.`); return null; }

    const tickSpacing = poolForTrade.tickSpacing;
    try {
        // --->>> Use the checksummed TICK_LENS_ADDRESS <<<---
        const tickLensContract = new ethers.Contract(TICK_LENS_ADDRESS, TICK_LENS_ABI, provider);
        const tickBitmapIndex = 0;
        logger.info(`[SimSDK] Fetching ticks for ${poolAddress} (Index ${tickBitmapIndex})...`);
        let populatedTicks = [];
        try {
            populatedTicks = await tickLensContract.getPopulatedTicksInWord(poolAddress, tickBitmapIndex);
            logger.info(`[SimSDK] Fetched ${populatedTicks?.length ?? 0} populated ticks for ${poolAddress}.`);
        } catch (tickFetchError) {
             // Check if it's the checksum error again specifically
             if (tickFetchError.code === 'INVALID_ARGUMENT' && tickFetchError.message.includes('checksum')) {
                 logger.error(`[SimSDK FATAL] TickLens checksum error persisted! Address used: ${TICK_LENS_ADDRESS}`);
             } else {
                 logger.warn(`[SimSDK] Error fetching ticks for pool ${poolAddress}: ${tickFetchError.message}.`);
             }
             handleError(tickFetchError, `TickLens Fetch (${poolAddress})`);
             return null; // Fail simulation if ticks can't be fetched reliably
        }
        const tickDataProvider = new TickListDataProvider(populatedTicks || [], tickSpacing);
        logger.info(`[SimSDK] Creating Route for ${poolAddress}...`);
        const route = new Route([poolForTrade], tokenIn, tokenOut);
        logger.info(`[SimSDK] Attempting Trade.fromRoute for ${poolAddress}...`);
        const trade = await Trade.fromRoute(route, amountIn, TradeType.EXACT_INPUT, { tickDataProvider });
        logger.info(`[SimSDK] Trade.fromRoute successful for ${poolAddress}.`);
        if (!trade || !trade.outputAmount || !(trade.outputAmount.quotient instanceof JSBI)) { logger.warn(`[SimSDK] Trade simulation for ${poolAddress} returned invalid trade object or outputAmount/quotient.`); return null; }
        logger.info(`[SimSDK EXIT] Simulation SUCCESS for pool ${poolAddress}.`);
        return trade; // Return valid trade

    } catch (error) {
         logger.error(`[SimSDK ERROR] Pool ${poolAddress} (${tokenIn.symbol}->${tokenOut.symbol}): ${error.message}`);
         handleError(error, `simulateSingleTradeSDK (${tokenIn.symbol} -> ${tokenOut.symbol}) Pool: ${poolAddress}`);
        return null; // Return null on simulation error
    }
} // End simulateSingleTradeSDK


// calculateDynamicSimAmount Function (No changes needed)
function calculateDynamicSimAmount(tokenIn) { /* ... Same as previous version ... */ logger.debug(`[Calc Sim] === Starting calculation for ${tokenIn?.symbol} ===`); if (!tokenIn || !tokenIn.symbol) { logger.warn(`[Calc Sim] Invalid tokenIn object.`); return null; } if (typeof tokenIn.decimals !== 'number') { logger.error(`[Calc Sim] ERROR: tokenIn ${tokenIn.symbol} decimals is not a number: ${tokenIn.decimals}`); return null; } logger.debug(`[Calc Sim] Using Token: Symbol=${tokenIn.symbol}, Decimals=${tokenIn.decimals}, Address=${tokenIn.address}`); const configuredBorrowAmount = config.BORROW_AMOUNTS_WEI[tokenIn.symbol]; if (configuredBorrowAmount == null) { logger.warn(`[Calc Sim] Configured borrow amount for ${tokenIn.symbol} is missing.`); return null; } logger.debug(`[Calc Sim] Configured Borrow Amount (from config): ${configuredBorrowAmount} (Type: ${typeof configuredBorrowAmount})`); let baseAmountBigInt; try { baseAmountBigInt = BigInt(configuredBorrowAmount.toString()); } catch (e) { logger.error(`[Calc Sim] Failed to convert configured borrow amount for ${tokenIn.symbol} to BigInt: ${configuredBorrowAmount}`); return null; } logger.debug(`[Calc Sim] Base Amount as BigInt: ${baseAmountBigInt}`); const fraction = 100n; const simAmountRaw = baseAmountBigInt / fraction; logger.debug(`[Calc Sim] Raw Simulation Amount (Base / Fraction): ${simAmountRaw}`); let simAmountString; if (simAmountRaw === 0n) { logger.warn(`[Calc Sim] Calculated simulation amount is zero. Using minimal unit string '1'.`); simAmountString = '1'; } else { simAmountString = simAmountRaw.toString(); } logger.debug(`[Calc Sim] Final sim amount string for ${tokenIn.symbol}: "${simAmountString}"`); try { logger.debug(`[Calc Sim] Attempting CurrencyAmount.fromRawAmount with string: "${simAmountString}"`); const calculatedAmount = CurrencyAmount.fromRawAmount(tokenIn, simAmountString); logger.debug(`[Calc Sim] CurrencyAmount.fromRawAmount SUCCESS. Result quotient type: ${typeof calculatedAmount?.quotient}`); return calculatedAmount; } catch (sdkError) { logger.error(`[Calc Sim] SDK Error creating CurrencyAmount for ${tokenIn.symbol} with amount string "${simAmountString}": ${sdkError.message}`); handleError(sdkError, `Simulator.CreateCurrencyAmount (${tokenIn.symbol})`); return null; } }

// simulateArbitrage Function (No changes needed)
async function simulateArbitrage(provider, opportunity) { /* ... Same as previous version ... */ logger.debug(`[Sim Arb ENTRY] Group: ${opportunity?.groupName}`); if (!provider) { logger.error("[Sim Arb EXIT] Provider missing"); return null; } if (!opportunity || !opportunity.swapPoolInfo?.sdkPool || !opportunity.sdkTokenBorrowed || !opportunity.sdkTokenIntermediate || !opportunity.borrowAmount) { logger.warn("[Sim Arb EXIT] Invalid opportunity structure"); return null; } if (typeof opportunity.sdkTokenBorrowed.decimals !== 'number' || typeof opportunity.sdkTokenIntermediate.decimals !== 'number') { logger.error("[Sim Arb EXIT] Invalid token decimals"); return null; } const { startPoolInfo, swapPoolInfo, sdkTokenBorrowed, sdkTokenIntermediate, borrowAmount } = opportunity; const swapPoolSDK = swapPoolInfo.sdkPool; const swapPoolAddress = swapPoolInfo.address; if (!ethers.isAddress(swapPoolAddress)) { logger.error(`[Sim Arb EXIT] Invalid swapPoolInfo.address found: ${swapPoolAddress}`); return null; } let amountInForSimulation; let simAmountBigInt; let decimalsToUse; let symbolToUse; try { logger.debug(`[Sim Arb] Calling calculateDynamicSimAmount for ${sdkTokenBorrowed?.symbol}`); amountInForSimulation = calculateDynamicSimAmount(sdkTokenBorrowed); logger.debug(`[Sim Arb] Returned from calculateDynamicSimAmount. Checking result...`); if (!(amountInForSimulation instanceof CurrencyAmount)) { logger.error(`[Sim Arb EXIT] Validation FAIL: calculateDynamicSimAmount did not return a CurrencyAmount object. Got:`, amountInForSimulation); return null; } const quotientJSBI = amountInForSimulation.quotient; if (!(quotientJSBI instanceof JSBI)) { logger.error(`[Sim Arb EXIT] Validation FAIL: Returned CurrencyAmount's quotient is not a JSBI object. Type: ${typeof quotientJSBI}. Value:`, quotientJSBI); return null; } logger.debug(`[Sim Arb] Validation PASS: Result is CurrencyAmount with JSBI quotient.`); simAmountBigInt = BigInt(quotientJSBI.toString()); logger.debug(`[Sim Arb] Converted JSBI quotient to native BigInt: ${simAmountBigInt}`); decimalsToUse = sdkTokenBorrowed.decimals; symbolToUse = sdkTokenBorrowed.symbol ?? 'UnknownToken'; const formattedAmount = ethers.formatUnits(simAmountBigInt, decimalsToUse); logger.log(`[Simulator] Simulating: ${opportunity.groupName} | Start ${startPoolInfo.feeBps}bps -> Swap ${swapPoolInfo.feeBps}bps | Sim Input ${formattedAmount} ${symbolToUse}`); } catch (debugError) { logger.error(`[Sim Arb EXIT] Error during pre-simulation checks: ${debugError.message}`, debugError); handleError(debugError, `QuoteSimulator.PreSimulation (${opportunity?.groupName})`); logger.info("[Sim Arb RETURN] Returning null due to pre-simulation error."); return null; } try { const flashFeePercent = BigInt(config.FLASH_LOAN_FEE_BPS); const flashFee = (borrowAmount * flashFeePercent) / 10000n; const requiredRepaymentAmount = borrowAmount + flashFee; logger.info("[Sim Arb] ---> Simulating Swap 1..."); const trade1 = await simulateSingleTradeSDK(provider, swapPoolAddress, swapPoolSDK, sdkTokenBorrowed, sdkTokenIntermediate, amountInForSimulation); if (!trade1) { logger.warn(`[Sim Arb] Simulation FAIL Swap 1 returned null.`); logger.info("[Sim Arb RETURN] Returning null because trade1 was null."); return null; } const amountOutSwap1 = trade1.outputAmount; if (!(amountOutSwap1 instanceof CurrencyAmount)) { throw new ArbitrageError('Internal simulation error: Invalid type for amountOutSwap1.', 'SIMULATION_ERROR'); } logger.info(`[Sim Arb] Sim Swap 1 OK.`); logger.info("[Sim Arb] ---> Simulating Swap 2..."); const amountInSwap2 = amountOutSwap1; const trade2 = await simulateSingleTradeSDK(provider, swapPoolAddress, swapPoolSDK, sdkTokenIntermediate, sdkTokenBorrowed, amountInSwap2); if (!trade2) { logger.warn(`[Sim Arb] Simulation FAIL Swap 2 returned null.`); logger.info("[Sim Arb RETURN] Returning null because trade2 was null."); return null; } const amountOutSwap2_Sim = trade2.outputAmount; if (!(amountOutSwap2_Sim instanceof CurrencyAmount)) { throw new ArbitrageError('Internal simulation error: Invalid type for amountOutSwap2_Sim.', 'SIMULATION_ERROR'); } logger.info(`[Sim Arb] Sim Swap 2 OK.`); const finalAmountReceived_Sim_JSBI = amountOutSwap2_Sim.quotient; if (!(finalAmountReceived_Sim_JSBI instanceof JSBI)) { throw new ArbitrageError('Internal simulation error: Invalid type for finalAmountReceived_Sim_JSBI.', 'SIMULATION_ERROR'); } const finalAmountReceived_Sim_Raw = BigInt(finalAmountReceived_Sim_JSBI.toString()); logger.debug(`[Sim Arb] Final Amount Raw (native): ${finalAmountReceived_Sim_Raw}`); logger.info("[Sim Arb] ---> Calculating Estimated Profit..."); let finalAmountReceived_Actual_Estimated = 0n; if (simAmountBigInt > 0n && typeof finalAmountReceived_Sim_Raw === 'bigint') { finalAmountReceived_Actual_Estimated = (finalAmountReceived_Sim_Raw * borrowAmount) / simAmountBigInt; } else { throw new ArbitrageError('Internal simulation error: Invalid inputs for profit extrapolation.', 'SIMULATION_ERROR'); } logger.log(`[Simulator] Est. Final Amount Received: ${ethers.formatUnits(finalAmountReceived_Actual_Estimated, sdkTokenBorrowed.decimals)} ${symbolToUse}`); logger.log(`[Simulator] Required Repayment: ${ethers.formatUnits(requiredRepaymentAmount, sdkTokenBorrowed.decimals)} ${symbolToUse}`); if (finalAmountReceived_Actual_Estimated <= requiredRepaymentAmount) { logger.log(`[Simulator] Gross Profit Check FAIL.`); logger.info("[Sim Arb RETURN] Returning null because gross profit check failed."); return null; } const grossProfit = finalAmountReceived_Actual_Estimated - requiredRepaymentAmount; logger.log(`[Simulator] Est. Gross Profit Found: ${ethers.formatUnits(grossProfit, sdkTokenBorrowed.decimals)} ${symbolToUse}`); logger.info("[Sim Arb] Simulation and Profit Calc SUCCESS."); const successResult = { finalAmountReceived: finalAmountReceived_Actual_Estimated, requiredRepayment: requiredRepaymentAmount, grossProfit: grossProfit, simulatedAmountIn: simAmountBigInt, trade1: trade1, trade2: trade2 }; logger.info("[Sim Arb RETURN] Returning SUCCESS result object:", successResult); return successResult; } catch (error) { const context = `QuoteSimulator.simulateArbitrage (${opportunity?.groupName})`; if (error instanceof ArbitrageError) { handleError(error, context); } else { handleError(error, `${context} (Unexpected)`); } logger.error(`[Sim Arb ERROR] Error during simulation/calculation: ${error.message}`); logger.info("[Sim Arb RETURN] Returning null due to caught error during simulation/calculation."); return null; } } // End simulateArbitrage

// getMinimumAmountOut Function (No changes needed)
function getMinimumAmountOut(trade, slippageToleranceBps) { /* ... */ if (!trade) return 0n; const slippageTolerance = new Percent(slippageToleranceBps, 10000); const amountOut = trade.minimumAmountOut(slippageTolerance); if (amountOut && amountOut.quotient instanceof JSBI) { return BigInt(amountOut.quotient.toString()); } else { logger.warn("[Simulator] getMinimumAmountOut received invalid trade or amountOut object.", { trade, amountOut }); return 0n; } }
module.exports = { simulateArbitrage, getMinimumAmountOut };
