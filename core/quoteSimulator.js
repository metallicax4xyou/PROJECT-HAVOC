// core/quoteSimulator.js
const { ethers, JsonRpcProvider } = require('ethers');
const { CurrencyAmount, TradeType, Percent, Token } = require('@uniswap/sdk-core');
const { Pool, Route, Trade, TickListDataProvider } = require('@uniswap/v3-sdk');
const JSBI = require('jsbi');
const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler');
const config = require('../config/index.js');

// TickLens Contract Info
// --->>> Use LOWERCASE address string <<<---
const TICK_LENS_ADDRESS_LOWER = '0xbfd8137f7d1516d3ea5ca83523914859ec47f573';
// We will still use the checksummed version for creating the contract instance initially
const TICK_LENS_ADDRESS_CHECKSUM = ethers.getAddress(TICK_LENS_ADDRESS_LOWER);
const TICK_LENS_ABI = [ 'function getPopulatedTicksInWord(address pool, int16 tickBitmapIndex) external view returns (tuple(int24 tick, int128 liquidityNet, int128 liquidityGross)[] populatedTicks)' ];


// --- simulateSingleTradeSDK FUNCTION ---
async function simulateSingleTradeSDK( provider, poolAddress, poolForTrade, tokenIn, tokenOut, amountIn ) {
    logger.info(`[SimSDK ENTRY] Simulating on pool ${poolAddress} (${tokenIn.symbol} -> ${tokenOut.symbol})`);

    // Validation (remains the same)
    if (!provider) { logger.error('[SimSDK] Provider instance is required.'); return null; }
    if (!ethers.isAddress(poolAddress)) { logger.error(`[SimSDK] Invalid poolAddress received: ${poolAddress}`); return null; }
    if (!(poolForTrade instanceof Pool) || typeof poolForTrade.tickSpacing !== 'number') { logger.error('[SimSDK] Invalid poolForTrade object.', { poolForTrade }); return null; }
    if (!amountIn || !(amountIn.quotient instanceof JSBI) || JSBI.equal(amountIn.quotient, JSBI.BigInt(0))) { logger.warn(`[SimSDK] Invalid or zero input amount detected.`); return null; }

    const tickSpacing = poolForTrade.tickSpacing;
    try {
        // --->>> Use the CHECKSUMMED address for Contract creation <<<---
        const tickLensContract = new ethers.Contract(TICK_LENS_ADDRESS_CHECKSUM, TICK_LENS_ABI, provider);
        const tickBitmapIndex = 0;
        logger.info(`[SimSDK] Fetching ticks for ${poolAddress} (Index ${tickBitmapIndex})...`);
        let populatedTicks = [];
        try {
            // --->>> Pass LOWERCASE poolAddress to the contract call <<<---
            // This is a long shot, but maybe avoids internal re-validation issues
            const poolAddressLower = poolAddress.toLowerCase();
            logger.debug(`[SimSDK] Calling getPopulatedTicksInWord with lowercase pool addr: ${poolAddressLower}`);
            populatedTicks = await tickLensContract.getPopulatedTicksInWord(poolAddressLower, tickBitmapIndex);
            logger.info(`[SimSDK] Fetched ${populatedTicks?.length ?? 0} populated ticks for ${poolAddress}.`);
        } catch (tickFetchError) {
             // Log the error regardless of type
             logger.warn(`[SimSDK] Error fetching ticks for pool ${poolAddress}: ${tickFetchError.message}.`);
             handleError(tickFetchError, `TickLens Fetch (${poolAddress})`);
             return null; // Fail simulation if ticks can't be fetched reliably
        }
        // --- Rest of the function remains the same ---
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
function calculateDynamicSimAmount(tokenIn) { /* ... Same as previous version ... */ }

// simulateArbitrage Function (No changes needed)
async function simulateArbitrage(provider, opportunity) { /* ... Same as previous version ... */ }

// getMinimumAmountOut Function (No changes needed)
function getMinimumAmountOut(trade, slippageToleranceBps) { /* ... Same as previous version ... */ }

module.exports = { simulateArbitrage, getMinimumAmountOut };

// *** Make sure the boilerplate functions are copied correctly from previous versions ***
// The following are placeholders, ensure the actual logic is present in your file

// calculateDynamicSimAmount Function (Placeholder - ensure correct logic is present)
// function calculateDynamicSimAmount(tokenIn) { logger.debug(`Placeholder for calculateDynamicSimAmount`); return null; }

// simulateArbitrage Function (Placeholder - ensure correct logic is present)
// async function simulateArbitrage(provider, opportunity) { logger.debug(`Placeholder for simulateArbitrage`); return null; }

// getMinimumAmountOut Function (Placeholder - ensure correct logic is present)
// function getMinimumAmountOut(trade, slippageToleranceBps) { logger.debug(`Placeholder for getMinimumAmountOut`); return 0n; }
