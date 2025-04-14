// core/quoteSimulator.js
const { ethers, JsonRpcProvider } = require('ethers');
const { CurrencyAmount, TradeType, Percent, Token } = require('@uniswap/sdk-core');
const { Pool, Route, Trade, TickListDataProvider } = require('@uniswap/v3-sdk');
const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler');
const config = require('../config/index.js');

// TickLens Contract Info & simulateSingleTradeSDK (No changes needed here)
const TICK_LENS_ADDRESS = '0xbfd8137f7d1516d3ea5cA83523914859ec47F573';
const TICK_LENS_ABI = [ 'function getPopulatedTicksInWord(address pool, int16 tickBitmapIndex) external view returns (tuple(int24 tick, int128 liquidityNet, int128 liquidityGross)[] populatedTicks)' ];
async function simulateSingleTradeSDK( provider, poolAddress, poolForTrade, tokenIn, tokenOut, amountIn ) { /* ... Same as previous version ... */ if (!provider) { logger.error('[Simulator SDK] Provider instance is required.'); return null; } if (!ethers.isAddress(poolAddress)) { logger.error(`[Simulator SDK] Invalid poolAddress received: ${poolAddress}`); return null; } if (!(poolForTrade instanceof Pool) || typeof poolForTrade.tickSpacing !== 'number') { logger.error('[Simulator SDK] Invalid poolForTrade object (not Uniswap SDK Pool or missing tickSpacing).', { poolForTrade }); return null; } if (!amountIn || amountIn.quotient === 0n) { logger.debug(`[Simulator SDK] Cannot simulate with zero input amount.`); return null; } const tickSpacing = poolForTrade.tickSpacing; try { const tickLensContract = new ethers.Contract(TICK_LENS_ADDRESS, TICK_LENS_ABI, provider); const tickBitmapIndex = 0; logger.debug(`[Simulator SDK] Fetching ticks for ${poolAddress} using word index ${tickBitmapIndex}...`); let populatedTicks = []; try { populatedTicks = await tickLensContract.getPopulatedTicksInWord(poolAddress, tickBitmapIndex); logger.debug(`[Simulator SDK] Fetched ${populatedTicks?.length ?? 0} populated ticks for ${poolAddress}.`); } catch (tickFetchError) { logger.warn(`[Simulator SDK] Error fetching ticks for pool ${poolAddress}: ${tickFetchError.message}. Proceeding with empty ticks.`); handleError(tickFetchError, `TickLens Fetch (${poolAddress})`); populatedTicks = []; } const tickDataProvider = new TickListDataProvider(populatedTicks || [], tickSpacing); const route = new Route([poolForTrade], tokenIn, tokenOut); logger.debug(`[Simulator SDK] Route created for ${poolAddress}. Attempting Trade.fromRoute...`); const trade = await Trade.fromRoute(route, amountIn, TradeType.EXACT_INPUT, { tickDataProvider }); logger.debug(`[Simulator SDK] Trade.fromRoute successful for ${poolAddress}.`); if (!trade || !trade.outputAmount || typeof trade.outputAmount.quotient === 'undefined') { logger.warn(`[Simulator SDK] Trade simulation for ${poolAddress} returned invalid trade object or outputAmount.`); return null; } return trade; } catch (error) { if (error.message.includes('initialize tick') || error.message.includes('NO_VALID_TICKS')) { logger.warn(`[Simulator SDK] Trade simulation failed (Ticks) (${tokenIn.symbol}->${tokenOut.symbol}) pool ${poolAddress}: ${error.message}`); } else if (error.message.includes('liquidity') || error.message.includes('SPL') || error.code === 'RUNTIME_ERROR') { logger.warn(`[Simulator SDK] Trade simulation failed (Liq/Runtime) (${tokenIn.symbol}->${tokenOut.symbol}) pool ${poolAddress}: ${error.message}`); } else { logger.error(`[Simulator SDK] Unexpected error during trade simulation for pool ${poolAddress}:`, error); handleError(error, `simulateSingleTradeSDK (${tokenIn.symbol} -> ${tokenOut.symbol}) Pool: ${poolAddress}`); } return null; } }


// --- calculateDynamicSimAmount FUNCTION WITH EXTRA LOGGING ---
function calculateDynamicSimAmount(poolSDK, tokenIn) {
    logger.debug(`[Calc Sim] === Starting calculation for ${tokenIn?.symbol} ===`); // Log start

    // Input Validation
    if (!tokenIn || !tokenIn.symbol) { logger.warn(`[Calc Sim] Invalid tokenIn object.`); return null; }
    if (typeof tokenIn.decimals !== 'number') { logger.error(`[Calc Sim] ERROR: tokenIn ${tokenIn.symbol} decimals is not a number: ${tokenIn.decimals}`); return null; }
    // Log the token object being used
    logger.debug(`[Calc Sim] Using Token: Symbol=${tokenIn.symbol}, Decimals=${tokenIn.decimals}, Address=${tokenIn.address}`);

    // Get Configured Amount
    const configuredBorrowAmount = config.BORROW_AMOUNTS_WEI[tokenIn.symbol];
    if (configuredBorrowAmount == null) { logger.warn(`[Calc Sim] Configured borrow amount for ${tokenIn.symbol} is missing.`); return null; }
    logger.debug(`[Calc Sim] Configured Borrow Amount (from config): ${configuredBorrowAmount} (Type: ${typeof configuredBorrowAmount})`);

    // Ensure BigInt and Calculate Simulation Amount
    let baseAmountBigInt;
    try {
        baseAmountBigInt = BigInt(configuredBorrowAmount.toString());
    } catch (e) { logger.error(`[Calc Sim] Failed to convert configured borrow amount for ${tokenIn.symbol} to BigInt: ${configuredBorrowAmount}`); return null; }
    logger.debug(`[Calc Sim] Base Amount as BigInt: ${baseAmountBigInt}`);

    const fraction = 100n;
    const simAmountRaw = baseAmountBigInt / fraction;
    logger.debug(`[Calc Sim] Raw Simulation Amount (Base / Fraction): ${simAmountRaw}`);

    // Handle Zero Case
    if (simAmountRaw === 0n) {
        logger.warn(`[Calc Sim] Calculated simulation amount is zero. Using minimal unit string '1'.`);
        const simAmountString = '1';
        logger.debug(`[Calc Sim] Attempting CurrencyAmount.fromRawAmount with token and amount string: '${simAmountString}'`);
        try {
             const result = CurrencyAmount.fromRawAmount(tokenIn, simAmountString);
             logger.debug('[Calc Sim] SDK call successful (zero case). Result object:', result);
             logger.debug(`[Calc Sim] Result type: ${Object.prototype.toString.call(result)}, instanceof CurrencyAmount: ${result instanceof CurrencyAmount}, Quotient type: ${typeof result?.quotient}, Quotient value: ${result?.quotient}`);
             return result;
        } catch (sdkError) {
             logger.error(`[Calc Sim] SDK Error (zero case) creating CurrencyAmount for ${tokenIn.symbol} with amount string "${simAmountString}": ${sdkError.message}`);
             handleError(sdkError, `Simulator.CreateCurrencyAmountZero (${tokenIn.symbol})`);
             return null;
        }
    }

    // Non-Zero Case: Pass as String
    const simAmountString = simAmountRaw.toString();
    logger.debug(`[Calc Sim] Calculated sim amount string for ${tokenIn.symbol}: "${simAmountString}"`);
    logger.debug(`[Calc Sim] Attempting CurrencyAmount.fromRawAmount with token and amount string: "${simAmountString}"`);

    try {
        const result = CurrencyAmount.fromRawAmount(tokenIn, simAmountString); // Pass as string
        logger.debug('[Calc Sim] SDK call successful. Result object:', result); // Log the whole object
        // Log detailed type info about the result
        logger.debug(`[Calc Sim] Result type: ${Object.prototype.toString.call(result)}, instanceof CurrencyAmount: ${result instanceof CurrencyAmount}, Quotient type: ${typeof result?.quotient}, Quotient value: ${result?.quotient}`);
        return result;
    } catch (sdkError) {
        logger.error(`[Calc Sim] SDK Error creating CurrencyAmount for ${tokenIn.symbol} with amount string "${simAmountString}": ${sdkError.message}`);
        handleError(sdkError, `Simulator.CreateCurrencyAmount (${tokenIn.symbol})`);
        return null; // Return null if SDK fails
    }
}

// simulateArbitrage & getMinimumAmountOut (No changes needed from previous version)
async function simulateArbitrage(provider, opportunity) { /* ... Same as previous version ... */ if (!provider) { return null; } if (!opportunity || !opportunity.swapPoolInfo?.sdkPool || !opportunity.sdkTokenBorrowed || !opportunity.sdkTokenIntermediate || !opportunity.borrowAmount) { return null; } if (typeof opportunity.sdkTokenBorrowed.decimals !== 'number' || typeof opportunity.sdkTokenIntermediate.decimals !== 'number') { return null; } const { startPoolInfo, swapPoolInfo, sdkTokenBorrowed, sdkTokenIntermediate, borrowAmount } = opportunity; const swapPoolSDK = swapPoolInfo.sdkPool; const swapPoolAddress = swapPoolInfo.address; if (!ethers.isAddress(swapPoolAddress)) { logger.error(`[Simulator] Invalid swapPoolInfo.address found: ${swapPoolAddress}`); return null; } let amountInForSimulation; let simAmountBigInt; let decimalsToUse; let symbolToUse; try { amountInForSimulation = calculateDynamicSimAmount(swapPoolSDK, sdkTokenBorrowed); if (!(amountInForSimulation instanceof CurrencyAmount) || typeof amountInForSimulation.quotient !== 'bigint') { logger.error(`[Simulator] calculateDynamicSimAmount did not return valid CurrencyAmount with BigInt quotient for ${sdkTokenBorrowed?.symbol}.`, { amountInForSimulation }); return null; } simAmountBigInt = amountInForSimulation.quotient; decimalsToUse = sdkTokenBorrowed.decimals; symbolToUse = sdkTokenBorrowed.symbol ?? 'UnknownToken'; const formattedAmount = ethers.formatUnits(simAmountBigInt, decimalsToUse); logger.log(`[Simulator] Simulating: ${opportunity.groupName} | Start ${startPoolInfo.feeBps}bps -> Swap ${swapPoolInfo.feeBps}bps | Sim Input ${formattedAmount} ${symbolToUse}`); } catch (debugError) { handleError(debugError, `QuoteSimulator.PreSimulation (${opportunity?.groupName})`); return null; } try { const flashFeePercent = BigInt(config.FLASH_LOAN_FEE_BPS); const flashFee = (borrowAmount * flashFeePercent) / 10000n; const requiredRepaymentAmount = borrowAmount + flashFee; logger.debug("[Simulator] ---> Simulating Swap 1..."); const trade1 = await simulateSingleTradeSDK(provider, swapPoolAddress, swapPoolSDK, sdkTokenBorrowed, sdkTokenIntermediate, amountInForSimulation); if (!trade1) { logger.log(`[Simulator] Simulation FAIL Swap 1 (${sdkTokenBorrowed.symbol}->${sdkTokenIntermediate.symbol} on ${swapPoolInfo.feeBps}bps pool ${swapPoolAddress}).`); return null; } const amountOutSwap1 = trade1.outputAmount; if (!(amountOutSwap1 instanceof CurrencyAmount)) { throw new ArbitrageError('Internal simulation error: Invalid type for amountOutSwap1.', 'SIMULATION_ERROR'); } logger.debug(`[Simulator] Sim Swap 1 OK: Input ${amountInForSimulation.toSignificant(6)} ${sdkTokenBorrowed.symbol} -> Output ${amountOutSwap1.toSignificant(6)} ${sdkTokenIntermediate.symbol}`); logger.debug("[Simulator] ---> Simulating Swap 2..."); const amountInSwap2 = amountOutSwap1; const trade2 = await simulateSingleTradeSDK(provider, swapPoolAddress, swapPoolSDK, sdkTokenIntermediate, sdkTokenBorrowed, amountInSwap2); if (!trade2) { logger.log(`[Simulator] Simulation FAIL Swap 2 (${sdkTokenIntermediate.symbol}->${sdkTokenBorrowed.symbol} on ${swapPoolInfo.feeBps}bps pool ${swapPoolAddress}).`); return null; } const amountOutSwap2_Sim = trade2.outputAmount; if (!(amountOutSwap2_Sim instanceof CurrencyAmount)) { throw new ArbitrageError('Internal simulation error: Invalid type for amountOutSwap2_Sim.', 'SIMULATION_ERROR'); } const finalAmountReceived_Sim_Raw = amountOutSwap2_Sim.quotient; logger.debug(`[Simulator] Sim Swap 2 OK: Input ${amountInSwap2.toSignificant(6)} ${sdkTokenIntermediate.symbol} -> Output ${amountOutSwap2_Sim.toSignificant(6)} ${sdkTokenBorrowed.symbol}`); logger.debug("[Simulator] ---> Calculating Estimated Profit..."); let finalAmountReceived_Actual_Estimated = 0n; if (simAmountBigInt > 0n && typeof finalAmountReceived_Sim_Raw === 'bigint') { finalAmountReceived_Actual_Estimated = (finalAmountReceived_Sim_Raw * borrowAmount) / simAmountBigInt; } else { throw new ArbitrageError('Internal simulation error: Invalid inputs for profit extrapolation.', 'SIMULATION_ERROR'); } logger.log(`[Simulator] Est. Final Amount Received (for actual borrow): ${ethers.formatUnits(finalAmountReceived_Actual_Estimated, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`); logger.log(`[Simulator] Required Repayment (for actual borrow): ${ethers.formatUnits(requiredRepaymentAmount, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`); if (finalAmountReceived_Actual_Estimated <= requiredRepaymentAmount) { logger.log(`[Simulator] Gross Profit Check FAIL.`); return null; } const grossProfit = finalAmountReceived_Actual_Estimated - requiredRepaymentAmount; logger.log(`[Simulator] Est. Gross Profit Found: ${ethers.formatUnits(grossProfit, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`); return { finalAmountReceived: finalAmountReceived_Actual_Estimated, requiredRepayment: requiredRepaymentAmount, grossProfit: grossProfit, simulatedAmountIn: simAmountBigInt, trade1: trade1, trade2: trade2 }; } catch (error) { if (error instanceof ArbitrageError && error.type === 'SIMULATION_ERROR') { handleError(error, `QuoteSimulator.Calculation (${opportunity.groupName})`); } else if (error.code !== 'INVALID_ARGUMENT' && !error.message?.includes('tick data')) { handleError(error, `QuoteSimulator.simulateArbitrage (${opportunity.groupName})`); } logger.error(`[Simulator] Error during simulation calculation/extrapolation for group ${opportunity.groupName}: ${error.message}`); return null; } }
function getMinimumAmountOut(trade, slippageToleranceBps) { /* ... Same as previous version ... */ if (!trade) return 0n; const slippageTolerance = new Percent(slippageToleranceBps, 10000); const amountOut = trade.minimumAmountOut(slippageTolerance); return amountOut.quotient; }
module.exports = { simulateArbitrage, getMinimumAmountOut };
