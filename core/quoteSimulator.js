// core/quoteSimulator.js
const { ethers } = require('ethers');
const { CurrencyAmount, TradeType, Percent, Token } = require('@uniswap/sdk-core');
const { Pool, Route, Trade, TickListDataProvider, Tick } = require('@uniswap/v3-sdk'); // Import Tick
const JSBI = require('jsbi'); // Uniswap SDK uses JSBI
const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler');
const config = require('../config/index.js'); // For slippage, etc.

// --- ABIs ---
const IUniswapV3PoolABI = require('@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json').abi;
const QuoterV2ABI = require('@uniswap/v3-periphery/artifacts/contracts/lens/QuoterV2.sol/QuoterV2.json').abi;

// --- TickLens Contract Info ---
const TICK_LENS_ADDRESS_CHECKSUM = ethers.getAddress('0xbfd8137f7d1516d3ea5ca83523914859ec47f573');
const TICK_LENS_ABI = [ 'function getPopulatedTicksInWord(address pool, int16 tickBitmapIndex) external view returns (tuple(int24 tick, int128 liquidityNet, int128 liquidityGross)[] populatedTicks)' ];

// Global QuoterV2 Contract instance (initialized later)
let quoterV2Contract = null;

/**
 * Initializes the QuoterV2 contract instance.
 * @param {ethers.Provider} provider Ethers provider instance.
 */
function initializeQuoter(provider) {
    // ... (Function body remains the same) ...
    if (!config.QUOTER_ADDRESS || !ethers.isAddress(config.QUOTER_ADDRESS)) { logger.warn('[Simulator] QUOTER_ADDRESS is missing or invalid in config. QuoterV2 simulations may fail.'); return; }
    if (!provider) { logger.error('[Simulator] Cannot initialize QuoterV2 without a provider.'); return; }
    try {
        quoterV2Contract = new ethers.Contract(config.QUOTER_ADDRESS, QuoterV2ABI, provider);
        logger.info(`[Simulator] QuoterV2 Contract Initialized at ${config.QUOTER_ADDRESS}`);
    } catch (error) {
        logger.error(`[Simulator] Failed to initialize QuoterV2 contract: ${error.message}`); quoterV2Contract = null;
    }
}


/**
 * Fetches populated ticks for a given pool using TickLens and filters invalid ones.
 * @param {ethers.Provider} provider Ethers provider instance.
 * @param {string} poolAddress The checksummed address of the pool.
 * @param {number} tickSpacing The tick spacing of the pool.
 * @returns {Promise<TickListDataProvider | null>} A TickListDataProvider instance or null if fetching fails.
 */
async function getTickDataProvider(provider, poolAddress, tickSpacing) {
    const functionSig = `[TickProvider Pool: ${poolAddress}]`;
    if (!provider || !ethers.isAddress(poolAddress) || typeof tickSpacing !== 'number' || tickSpacing <= 0) {
        logger.error(`${functionSig} Invalid arguments for getTickDataProvider (tickSpacing: ${tickSpacing}).`); return null;
    }
    logger.debug(`${functionSig} Using tickSpacing: ${tickSpacing}`);

    const tickLensContract = new ethers.Contract(TICK_LENS_ADDRESS_CHECKSUM, TICK_LENS_ABI, provider);
    const tickBitmapIndex = 0;
    logger.debug(`${functionSig} Fetching ticks (Index ${tickBitmapIndex})...`);
    let populatedTicksRaw = [];
    let formattedTicks = []; // Define upfront

    try {
        populatedTicksRaw = await tickLensContract.getPopulatedTicksInWord(poolAddress, tickBitmapIndex);
        logger.debug(`${functionSig} Fetched ${populatedTicksRaw?.length ?? 0} raw populated ticks.`);

        if (!populatedTicksRaw || populatedTicksRaw.length === 0) {
             logger.debug(`${functionSig} No ticks received from TickLens.`);
             return new TickListDataProvider([], tickSpacing); // Return empty provider if no ticks
        }

        const rawTicksLog = populatedTicksRaw.map(t => Number(t.tick));
        logger.debug(`${functionSig} Raw Ticks Received: [${rawTicksLog.join(', ')}]`);

        let invalidTickCount = 0;
        formattedTicks = populatedTicksRaw.map((tickInfo, index) => {
            const tickNumber = Number(tickInfo.tick);
            // --- Log inside map ---
            // logger.debug(`${functionSig} Processing Raw Tick #${index}: tick=${tickNumber}, liqNet=${tickInfo.liquidityNet?.toString()}, liqGross=${tickInfo.liquidityGross?.toString()}`);
            // --- Check Types ---
            if (typeof tickInfo.liquidityNet !== 'bigint' || typeof tickInfo.liquidityGross !== 'bigint') {
                logger.warn(`${functionSig} Invalid liquidity data type for tick ${tickNumber}! NetType=${typeof tickInfo.liquidityNet}, GrossType=${typeof tickInfo.liquidityGross}. Filtering.`);
                invalidTickCount++; return null;
            }
            // --- Check divisibility ---
            if (tickNumber % tickSpacing !== 0) {
                logger.warn(`${functionSig} Invalid tick! Tick ${tickNumber} is not divisible by spacing ${tickSpacing}. Filtering.`);
                invalidTickCount++; return null;
            }
            // --- Check bounds ---
            if (tickNumber < Tick.MIN_TICK || tickNumber > Tick.MAX_TICK) {
                 logger.warn(`${functionSig} Invalid tick! Tick ${tickNumber} out of range [${Tick.MIN_TICK}, ${Tick.MAX_TICK}]. Filtering.`);
                 invalidTickCount++; return null;
            }
            // If all checks pass, return the object for the provider
            return {
                tick: tickNumber,
                liquidityNet: tickInfo.liquidityNet,
                liquidityGross: tickInfo.liquidityGross
            };
        }).filter(tick => tick !== null); // Filter out nulls from failed checks

        if (invalidTickCount > 0) { logger.warn(`${functionSig} Filtered out ${invalidTickCount} invalid ticks.`); }

        if (formattedTicks.length === 0) {
             logger.warn(`${functionSig} No valid ticks remaining after filtering. Cannot create provider.`);
             return null; // Return null if all ticks were invalid
        }

        logger.debug(`${functionSig} Creating TickListDataProvider with ${formattedTicks.length} valid ticks. Final Tick Spacing Check: ${tickSpacing}`);
        logger.debug(`${functionSig} Final Data passed to TickListDataProvider: ${JSON.stringify(formattedTicks, (k, v) => typeof v === 'bigint' ? v.toString() : v)}`);

        // Try constructing the provider - this is where the error occurs
        return new TickListDataProvider(formattedTicks, tickSpacing);

    } catch (error) {
        // Catch errors during TickLens call OR TickListDataProvider constructor
        logger.warn(`${functionSig} Error during tick processing/provider creation: ${error.message}.`);
        // Log the formatted ticks array *just before* the potential failure
        logger.debug(`${functionSig} Data that potentially caused error: ${JSON.stringify(formattedTicks, (k, v) => typeof v === 'bigint' ? v.toString() : v)}`);
        handleError(error, `TickProvider (${poolAddress})`);
        return null; // Return null on any error here
    }
}


/**
 * Simulates a single swap leg using Uniswap V3 SDK.
 * @param {ethers.Provider} provider Ethers provider instance.
 * @param {object} poolData Contains { address, feeBps, sdkPool, tick, liquidity, sqrtPriceX96, sdkToken0, sdkToken1 }
 * @param {Token} tokenIn The input token (SDK object).
 * @param {Token} tokenOut The output token (SDK object).
 * @param {CurrencyAmount<Token>} amountIn The amount of tokenIn to swap.
 * @returns {Promise<Trade<Token, Token, TradeType.EXACT_INPUT> | null>} The simulated trade object or null on failure.
 */
async function simulateSingleTradeSDK(provider, poolData, tokenIn, tokenOut, amountIn) {
    const functionSig = `[SimSDK Pool: ${poolData.address}]`;
    logger.debug(`${functionSig} Simulating ${ethers.formatUnits(amountIn.quotient.toString(), tokenIn.decimals)} ${tokenIn.symbol} -> ${tokenOut.symbol}`);

    // ... (Input validation remains the same) ...
    if (!provider || !poolData || !tokenIn || !tokenOut || !amountIn || !(amountIn instanceof CurrencyAmount)) { logger.error(`${functionSig} Invalid arguments for simulateSingleTradeSDK.`); return null; }
    if (amountIn.quotient <= 0n) { logger.warn(`${functionSig} Input amount is zero or negative.`); return null; }

    try {
        if (poolData.sqrtPriceX96 == null || poolData.liquidity == null || poolData.tick == null || poolData.feeBps == null) { logger.error(`${functionSig} Missing required pool state data.`); return null; }
        if (!poolData.sdkToken0 || !poolData.sdkToken1) { logger.error(`${functionSig} Missing sdkToken0 or sdkToken1 in poolData.`); return null; }

        const pool = new Pool(
            poolData.sdkToken0, poolData.sdkToken1, poolData.feeBps,
            poolData.sqrtPriceX96.toString(), poolData.liquidity.toString(), Number(poolData.tick)
        );

        const derivedTickSpacing = pool.tickSpacing;
        logger.debug(`${functionSig} Fee: ${poolData.feeBps}bps => Derived Tick Spacing: ${derivedTickSpacing}`);

        // Fetch Tick Data (now with filtering and type checks) - PASS DERIVED SPACING
        const tickDataProvider = await getTickDataProvider(provider, poolData.address, derivedTickSpacing);
        if (!tickDataProvider) {
            logger.warn(`${functionSig} Failed to get valid tick data provider. Cannot simulate accurately.`); return null;
        }

        const route = new Route([pool], tokenIn, tokenOut);
        logger.debug(`${functionSig} Route created.`);

        const trade = await Trade.fromRoute(route, amountIn, TradeType.EXACT_INPUT, { tickDataProvider });
        logger.debug(`${functionSig} Trade simulation successful.`);

        if (!trade || !trade.outputAmount || trade.outputAmount.quotient <= 0n) {
            logger.warn(`${functionSig} Trade simulation returned invalid trade or zero output.`); return null;
        }
        return trade;

    } catch (error) {
        // ... (Error handling remains the same) ...
        if (error.message.includes('NO_ROUTE_FOUND')) { logger.warn(`${functionSig} No route found for swap (${tokenIn.symbol} -> ${tokenOut.symbol}).`); }
        else if (error.message.includes('InsufficientInputAmountError')) { logger.warn(`${functionSig} Insufficient input amount for swap.`); }
        else if (error.message.includes('Invalid Ticks') || error.message.includes('TickListDataProvider')) { logger.warn(`${functionSig} Invalid ticks or tick data provider error during simulation: ${error.message}`); }
        else { logger.error(`${functionSig} Error during single trade simulation: ${error.message}`); handleError(error, `simulateSingleTradeSDK (${tokenIn.symbol}->${tokenOut.symbol})`); }
        return null;
    }
}


/**
 * Simulates the full arbitrage path: FlashLoan -> Swap -> Swap -> Repay.
 * @param {ethers.Provider} provider Ethers provider instance.
 * @param {object} opportunity The opportunity object from PoolScanner.
 * @returns {Promise<object | null>} Simulation result or null if simulation fails.
 */
async function simulateArbitrage(provider, opportunity) {
    // ... (Function body remains the same) ...
    const functionSig = `[SimArb Group: ${opportunity?.groupName}]`;
    logger.info(`${functionSig} Starting simulation...`);

    if (!provider || !opportunity || !opportunity.startPoolInfo || !opportunity.swapPoolInfo || !opportunity.sdkTokenBorrowed || !opportunity.sdkTokenIntermediate || !opportunity.borrowAmount) {
        if (opportunity) { logger.error(`${functionSig} Invalid opportunity object provided. Missing fields: ${[!opportunity.startPoolInfo && 'startPoolInfo', !opportunity.swapPoolInfo && 'swapPoolInfo', !opportunity.sdkTokenBorrowed && 'sdkTokenBorrowed', !opportunity.sdkTokenIntermediate && 'sdkTokenIntermediate', !opportunity.borrowAmount && 'borrowAmount'].filter(Boolean).join(', ')}`); } else { logger.error(`${functionSig} Invalid or null opportunity object provided.`); }
        handleError(new Error('Invalid opportunity object structure received from PoolScanner'), `${functionSig} Input Validation`); return null;
    }
    if (opportunity.borrowAmount <= 0n) { logger.warn(`${functionSig} Borrow amount is zero or negative. Skipping simulation.`); return null; }

    const { startPoolInfo, swapPoolInfo, sdkTokenBorrowed, sdkTokenIntermediate, borrowAmount } = opportunity;
    if (!sdkTokenBorrowed || !(sdkTokenBorrowed instanceof Token)) { logger.error(`${functionSig} Missing or invalid sdkTokenBorrowed in opportunity.`); return null; }
    if (!sdkTokenIntermediate || !(sdkTokenIntermediate instanceof Token)) { logger.error(`${functionSig} Missing or invalid sdkTokenIntermediate in opportunity.`); return null; }

    logger.info(`${functionSig} Path: ${sdkTokenBorrowed.symbol} -> ${sdkTokenIntermediate.symbol} (on ${swapPoolInfo.address}) -> ${sdkTokenBorrowed.symbol} (on ${startPoolInfo.address})`);

    try {
        // Hop 1
        const amountInHop1 = CurrencyAmount.fromRawAmount(sdkTokenBorrowed, borrowAmount.toString());
        logger.info(`${functionSig} Simulating Hop 1: ${ethers.formatUnits(borrowAmount, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol} -> ${sdkTokenIntermediate.symbol} on pool ${swapPoolInfo.address} (Fee: ${swapPoolInfo.feeBps})`);
        const trade1 = await simulateSingleTradeSDK(provider, swapPoolInfo, sdkTokenBorrowed, sdkTokenIntermediate, amountInHop1);
        if (!trade1 || !trade1.outputAmount || trade1.outputAmount.quotient <= 0n) { logger.warn(`${functionSig} Hop 1 simulation failed or yielded zero output.`); return null; }
        const intermediateAmount = trade1.outputAmount;
        logger.info(`${functionSig} Hop 1 Output: ${intermediateAmount.toSignificant(6)} ${sdkTokenIntermediate.symbol}`);

        // Hop 2
        logger.info(`${functionSig} Simulating Hop 2: ${intermediateAmount.toSignificant(6)} ${sdkTokenIntermediate.symbol} -> ${sdkTokenBorrowed.symbol} on pool ${startPoolInfo.address} (Fee: ${startPoolInfo.feeBps})`);
        const trade2 = await simulateSingleTradeSDK(provider, startPoolInfo, sdkTokenIntermediate, sdkTokenBorrowed, intermediateAmount);
        if (!trade2 || !trade2.outputAmount || trade2.outputAmount.quotient <= 0n) { logger.warn(`${functionSig} Hop 2 simulation failed or yielded zero output.`); return null; }
        const finalAmount = trade2.outputAmount;
        logger.info(`${functionSig} Hop 2 Output (Final Amount): ${finalAmount.toSignificant(6)} ${sdkTokenBorrowed.symbol}`);

        // Profit Calc
        const grossProfitRaw = JSBI.subtract(finalAmount.quotient, amountInHop1.quotient);
        const grossProfitBigInt = BigInt(grossProfitRaw.toString());
        logger.info(`${functionSig} Initial Borrow: ${ethers.formatUnits(borrowAmount, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`);
        logger.info(`${functionSig} Final Amount Recv: ${ethers.formatUnits(finalAmount.quotient.toString(), sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`);
        logger.info(`${functionSig} Gross Profit: ${ethers.formatUnits(grossProfitBigInt, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`);

        // Result
        const simulationResult = { grossProfit: grossProfitBigInt, sdkTokenBorrowed: sdkTokenBorrowed, borrowAmountUsed: borrowAmount, intermediateAmount: intermediateAmount, finalAmount: finalAmount, trade1: trade1, trade2: trade2, opportunity: opportunity, };
        logger.info(`${functionSig} Simulation successful.`);
        return simulationResult;
    } catch (error) {
        logger.error(`${functionSig} Unexpected error during arbitrage simulation: ${error.message}`);
        handleError(error, `${functionSig} Main Try/Catch`); return null;
    }
}


/**
 * Calculates the minimum amount out for a trade considering slippage.
 * @param {Trade<Token, Token, TradeType.EXACT_INPUT>} trade The Uniswap SDK trade object.
 * @param {number} slippageToleranceBps Slippage tolerance in basis points (e.g., 10 for 0.1%).
 * @returns {bigint} The minimum output amount in the token's smallest unit (wei/atomic).
 */
function getMinimumAmountOut(trade, slippageToleranceBps) {
    // ... (Function body remains the same) ...
    if (!trade || !trade.outputAmount) { logger.warn('[Simulator] Cannot get minimum amount out from invalid trade object.'); return 0n; }
    if (typeof slippageToleranceBps !== 'number' || slippageToleranceBps < 0) { logger.warn(`[Simulator] Invalid slippage tolerance BPS: ${slippageToleranceBps}. Defaulting to 0.`); slippageToleranceBps = 0; }
    const slippageTolerance = new Percent(slippageToleranceBps, 10000);
    const amountOut = trade.minimumAmountOut(slippageTolerance);
    logger.debug(`[Simulator] Min Amount Out: Slippage=${slippageToleranceBps}bps, Amount=${ethers.formatUnits(amountOut.quotient.toString(), amountOut.currency.decimals)} ${amountOut.currency.symbol}`);
    return BigInt(amountOut.quotient.toString());
}


module.exports = {
    initializeQuoter,
    simulateArbitrage,
    getMinimumAmountOut,
};
