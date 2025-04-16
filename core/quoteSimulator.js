// core/quoteSimulator.js
const { ethers } = require('ethers');
const { CurrencyAmount, TradeType, Percent, Token } = require('@uniswap/sdk-core');
const { Pool, Route, Trade, TickListDataProvider } = require('@uniswap/v3-sdk');
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
    if (!config.QUOTER_ADDRESS || !ethers.isAddress(config.QUOTER_ADDRESS)) {
        logger.warn('[Simulator] QUOTER_ADDRESS is missing or invalid in config. QuoterV2 simulations may fail.');
        return;
    }
    if (!provider) {
        logger.error('[Simulator] Cannot initialize QuoterV2 without a provider.');
        return;
    }
    try {
        quoterV2Contract = new ethers.Contract(config.QUOTER_ADDRESS, QuoterV2ABI, provider);
        logger.info(`[Simulator] QuoterV2 Contract Initialized at ${config.QUOTER_ADDRESS}`);
    } catch (error) {
        logger.error(`[Simulator] Failed to initialize QuoterV2 contract: ${error.message}`);
        quoterV2Contract = null;
    }
}


/**
 * Fetches populated ticks for a given pool using TickLens.
 * @param {ethers.Provider} provider Ethers provider instance.
 * @param {string} poolAddress The checksummed address of the pool.
 * @param {number} tickSpacing The tick spacing of the pool.
 * @returns {Promise<TickListDataProvider | null>} A TickListDataProvider instance or null if fetching fails.
 */
async function getTickDataProvider(provider, poolAddress, tickSpacing) {
    // ... (Function body remains the same as previous version) ...
    if (!provider || !ethers.isAddress(poolAddress) || typeof tickSpacing !== 'number') {
        logger.error('[Simulator] Invalid arguments for getTickDataProvider.');
        return null;
    }

    const tickLensContract = new ethers.Contract(TICK_LENS_ADDRESS_CHECKSUM, TICK_LENS_ABI, provider);
    const tickBitmapIndex = 0; // Start with the word containing tick 0

    logger.debug(`[Simulator] Fetching ticks for ${poolAddress} (Index ${tickBitmapIndex})...`);
    let populatedTicksRaw = [];
    try {
        populatedTicksRaw = await tickLensContract.getPopulatedTicksInWord(poolAddress, tickBitmapIndex);
        logger.debug(`[Simulator] Fetched ${populatedTicksRaw?.length ?? 0} populated ticks for ${poolAddress}.`);

        const formattedTicks = populatedTicksRaw.map(tickInfo => ({
            tick: Number(tickInfo.tick),
            liquidityNet: tickInfo.liquidityNet,
            liquidityGross: tickInfo.liquidityGross
        }));

        return new TickListDataProvider(formattedTicks, tickSpacing);

    } catch (tickFetchError) {
        logger.warn(`[Simulator] Error fetching/processing ticks for pool ${poolAddress}: ${tickFetchError.message}. Simulation accuracy may be affected.`);
        handleError(tickFetchError, `TickLens Fetch (${poolAddress})`);
        return null;
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
    // ... (Function body remains the same as previous version) ...
    const functionSig = `[SimSDK Pool: ${poolData.address}]`;
    logger.debug(`${functionSig} Simulating ${ethers.formatUnits(amountIn.quotient.toString(), tokenIn.decimals)} ${tokenIn.symbol} -> ${tokenOut.symbol}`);

    // Basic Validations
    if (!provider || !poolData || !tokenIn || !tokenOut || !amountIn || !(amountIn instanceof CurrencyAmount)) {
        logger.error(`${functionSig} Invalid arguments for simulateSingleTradeSDK.`); return null;
    }
    if (amountIn.quotient <= 0n) {
         logger.warn(`${functionSig} Input amount is zero or negative.`); return null;
    }

    try {
        // PoolScanner already provides the sdkPool object, but let's recreate it here
        // using the live sqrtPriceX96 and liquidity for maximum accuracy at simulation time.
        // This assumes poolData includes sqrtPriceX96 and liquidity from fetchPoolStates
        if (poolData.sqrtPriceX96 == null || poolData.liquidity == null || poolData.tick == null) {
             logger.error(`${functionSig} Missing required pool state data (sqrtPriceX96, liquidity, tick).`);
             return null;
        }

        const pool = new Pool(
            poolData.sdkToken0, // Use SDK Token from poolData (derived from group config)
            poolData.sdkToken1, // Use SDK Token from poolData
            poolData.feeBps,    // Use feeBps from poolData
            poolData.sqrtPriceX96.toString(), // Use live sqrtPriceX96
            poolData.liquidity.toString(),    // Use live liquidity
            Number(poolData.tick)             // Use live tick
        );

        // Fetch Tick Data for this specific pool
        const tickDataProvider = await getTickDataProvider(provider, poolData.address, pool.tickSpacing);
        if (!tickDataProvider) {
            logger.warn(`${functionSig} Failed to get tick data. Cannot simulate accurately.`);
            return null;
        }

        // Create Route
        const route = new Route([pool], tokenIn, tokenOut);
        logger.debug(`${functionSig} Route created.`);

        // Create Trade object
        const trade = await Trade.fromRoute(route, amountIn, TradeType.EXACT_INPUT, { tickDataProvider });
        logger.debug(`${functionSig} Trade simulation successful.`);

        if (!trade || !trade.outputAmount || trade.outputAmount.quotient <= 0n) {
            logger.warn(`${functionSig} Trade simulation returned invalid trade or zero output.`);
            return null;
        }

        return trade;

    } catch (error) {
        if (error.message.includes('NO_ROUTE_FOUND')) {
             logger.warn(`${functionSig} No route found for swap (${tokenIn.symbol} -> ${tokenOut.symbol}).`);
        } else if (error.message.includes('InsufficientInputAmountError')) {
             logger.warn(`${functionSig} Insufficient input amount for swap.`);
        } else if (error.message.includes('Invalid Ticks')) { // Catch specific tick errors
             logger.warn(`${functionSig} Invalid ticks encountered during simulation.`);
        }
        else {
             logger.error(`${functionSig} Error during single trade simulation: ${error.message}`);
             handleError(error, `simulateSingleTradeSDK (${tokenIn.symbol}->${tokenOut.symbol})`);
        }
        return null;
    }
}


/**
 * Simulates the full arbitrage path: FlashLoan -> Swap -> Swap -> Repay.
 * Calculates gross profit before fees/gas.
 * @param {ethers.Provider} provider Ethers provider instance.
 * @param {object} opportunity The opportunity object from PoolScanner. Requires:
 *   { groupName, startPoolInfo, swapPoolInfo, sdkTokenBorrowed, sdkTokenIntermediate, borrowAmount }
 * @returns {Promise<object | null>} Simulation result: { grossProfit, sdkTokenBorrowed, borrowAmountUsed, intermediateAmount, finalAmount, trade1, trade2 } or null if simulation fails.
 */
async function simulateArbitrage(provider, opportunity) {
    const functionSig = `[SimArb Group: ${opportunity?.groupName}]`;
    logger.info(`${functionSig} Starting simulation...`);

    // --- UPDATED Input Validation ---
    // Checks for the structure provided by PoolScanner
    if (!provider || !opportunity ||
        !opportunity.startPoolInfo ||    // Expect startPoolInfo (pool to borrow from)
        !opportunity.swapPoolInfo ||     // Expect swapPoolInfo (pool to swap on first)
        !opportunity.sdkTokenBorrowed || // Expect the SDK Token object directly
        !opportunity.sdkTokenIntermediate || // Expect the SDK Token object directly
        !opportunity.borrowAmount) {     // Expect the BigInt borrow amount

        // Log exactly what's missing if opportunity object exists
        if (opportunity) {
             logger.error(`${functionSig} Invalid opportunity object provided. Missing fields: ${
                 [!opportunity.startPoolInfo && 'startPoolInfo', !opportunity.swapPoolInfo && 'swapPoolInfo', !opportunity.sdkTokenBorrowed && 'sdkTokenBorrowed', !opportunity.sdkTokenIntermediate && 'sdkTokenIntermediate', !opportunity.borrowAmount && 'borrowAmount'].filter(Boolean).join(', ')
             }`);
        } else {
             logger.error(`${functionSig} Invalid or null opportunity object provided.`);
        }
        handleError(new Error('Invalid opportunity object structure received from PoolScanner'), `${functionSig} Input Validation`);
        return null;
    }
    // --- END UPDATED Input Validation ---

    if (opportunity.borrowAmount <= 0n) {
        logger.warn(`${functionSig} Borrow amount is zero or negative. Skipping simulation.`);
        return null;
    }

    // --- Use destructured properties with correct names ---
    const { startPoolInfo, swapPoolInfo, sdkTokenBorrowed, sdkTokenIntermediate, borrowAmount } = opportunity;
    // --- End ---

    // Redundant check, already validated above, but safe
    if (!sdkTokenBorrowed || !(sdkTokenBorrowed instanceof Token)) {
         logger.error(`${functionSig} Missing or invalid sdkTokenBorrowed in opportunity.`);
         return null;
    }
     if (!sdkTokenIntermediate || !(sdkTokenIntermediate instanceof Token)) {
         logger.error(`${functionSig} Missing or invalid sdkTokenIntermediate in opportunity.`);
         return null;
     }

    logger.info(`${functionSig} Path: ${sdkTokenBorrowed.symbol} -> ${sdkTokenIntermediate.symbol} (on ${swapPoolInfo.address}) -> ${sdkTokenBorrowed.symbol} (on ${startPoolInfo.address})`);

    try {
        // --- Simulation Hop 1: Borrow Token -> Intermediate Token on Pool Swap (swapPoolInfo) ---
        const amountInHop1 = CurrencyAmount.fromRawAmount(sdkTokenBorrowed, borrowAmount.toString());
        logger.info(`${functionSig} Simulating Hop 1: ${ethers.formatUnits(borrowAmount, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol} -> ${sdkTokenIntermediate.symbol} on pool ${swapPoolInfo.address} (Fee: ${swapPoolInfo.feeBps})`);

        // Pass swapPoolInfo to simulateSingleTradeSDK
        const trade1 = await simulateSingleTradeSDK(provider, swapPoolInfo, sdkTokenBorrowed, sdkTokenIntermediate, amountInHop1);

        if (!trade1 || !trade1.outputAmount || trade1.outputAmount.quotient <= 0n) {
            logger.warn(`${functionSig} Hop 1 simulation failed or yielded zero output.`);
            return null;
        }
        const intermediateAmount = trade1.outputAmount;
        logger.info(`${functionSig} Hop 1 Output: ${intermediateAmount.toSignificant(6)} ${sdkTokenIntermediate.symbol}`);


        // --- Simulation Hop 2: Intermediate Token -> Borrow Token on Pool Borrow (startPoolInfo) ---
        logger.info(`${functionSig} Simulating Hop 2: ${intermediateAmount.toSignificant(6)} ${sdkTokenIntermediate.symbol} -> ${sdkTokenBorrowed.symbol} on pool ${startPoolInfo.address} (Fee: ${startPoolInfo.feeBps})`);

        // Pass startPoolInfo to simulateSingleTradeSDK
        const trade2 = await simulateSingleTradeSDK(provider, startPoolInfo, sdkTokenIntermediate, sdkTokenBorrowed, intermediateAmount);

        if (!trade2 || !trade2.outputAmount || trade2.outputAmount.quotient <= 0n) {
            logger.warn(`${functionSig} Hop 2 simulation failed or yielded zero output.`);
            return null;
        }
        const finalAmount = trade2.outputAmount;
        logger.info(`${functionSig} Hop 2 Output (Final Amount): ${finalAmount.toSignificant(6)} ${sdkTokenBorrowed.symbol}`);

        // --- Calculate Gross Profit ---
        const grossProfitRaw = JSBI.subtract(finalAmount.quotient, amountInHop1.quotient);
        const grossProfitBigInt = BigInt(grossProfitRaw.toString());

        logger.info(`${functionSig} Initial Borrow: ${ethers.formatUnits(borrowAmount, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`);
        logger.info(`${functionSig} Final Amount Recv: ${ethers.formatUnits(finalAmount.quotient.toString(), sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`);
        logger.info(`${functionSig} Gross Profit: ${ethers.formatUnits(grossProfitBigInt, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`);


        // --- Construct Result ---
        const simulationResult = {
            grossProfit: grossProfitBigInt,
            sdkTokenBorrowed: sdkTokenBorrowed, // Pass the SDK Token object for ProfitCalculator
            borrowAmountUsed: borrowAmount,
            intermediateAmount: intermediateAmount,
            finalAmount: finalAmount,
            trade1: trade1,
            trade2: trade2,
            opportunity: opportunity, // Pass through original opportunity data
        };

        logger.info(`${functionSig} Simulation successful.`);
        return simulationResult;

    } catch (error) {
        logger.error(`${functionSig} Unexpected error during arbitrage simulation: ${error.message}`);
        handleError(error, `${functionSig} Main Try/Catch`);
        return null;
    }
}


/**
 * Calculates the minimum amount out for a trade considering slippage.
 * @param {Trade<Token, Token, TradeType.EXACT_INPUT>} trade The Uniswap SDK trade object.
 * @param {number} slippageToleranceBps Slippage tolerance in basis points (e.g., 10 for 0.1%).
 * @returns {bigint} The minimum output amount in the token's smallest unit (wei/atomic).
 */
function getMinimumAmountOut(trade, slippageToleranceBps) {
    // ... (Function body remains the same as previous version) ...
    if (!trade || !trade.outputAmount) {
        logger.warn('[Simulator] Cannot get minimum amount out from invalid trade object.');
        return 0n;
    }
    if (typeof slippageToleranceBps !== 'number' || slippageToleranceBps < 0) {
        logger.warn(`[Simulator] Invalid slippage tolerance BPS: ${slippageToleranceBps}. Defaulting to 0.`);
        slippageToleranceBps = 0;
    }

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
