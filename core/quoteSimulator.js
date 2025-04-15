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
// We will use the checksummed version for creating the contract instance
const TICK_LENS_ADDRESS_CHECKSUM = ethers.getAddress('0xbfd8137f7d1516d3ea5ca83523914859ec47f573');
const TICK_LENS_ABI = [ 'function getPopulatedTicksInWord(address pool, int16 tickBitmapIndex) external view returns (tuple(int24 tick, int128 liquidityNet, int128 liquidityGross)[] populatedTicks)' ];

// Global QuoterV2 Contract instance (initialized later)
let quoterV2Contract = null;

/**
 * Initializes the QuoterV2 contract instance.
 * Should be called once during FlashSwapManager initialization or similar setup phase.
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
        quoterV2Contract = null; // Ensure it's null if initialization fails
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
    if (!provider || !ethers.isAddress(poolAddress) || typeof tickSpacing !== 'number') {
        logger.error('[Simulator] Invalid arguments for getTickDataProvider.');
        return null;
    }

    const tickLensContract = new ethers.Contract(TICK_LENS_ADDRESS_CHECKSUM, TICK_LENS_ABI, provider);
    // Calculate the number of words needed (simplified - adjust if needed for wider tick ranges)
    // Uniswap uses int16 for tickBitmapIndex, covering a range. Index 0 is often sufficient for active range.
    const tickBitmapIndex = 0; // Start with the word containing tick 0

    logger.debug(`[Simulator] Fetching ticks for ${poolAddress} (Index ${tickBitmapIndex})...`);
    let populatedTicksRaw = [];
    try {
        // Pass checksummed address to contract call
        populatedTicksRaw = await tickLensContract.getPopulatedTicksInWord(poolAddress, tickBitmapIndex);
        logger.debug(`[Simulator] Fetched ${populatedTicksRaw?.length ?? 0} populated ticks for ${poolAddress}.`);

        // Convert raw ticks to the format expected by TickListDataProvider
        const formattedTicks = populatedTicksRaw.map(tickInfo => ({
            tick: Number(tickInfo.tick), // Convert BigInt tick to number
            liquidityNet: tickInfo.liquidityNet, // Keep as BigInt
            liquidityGross: tickInfo.liquidityGross // Keep as BigInt
        }));

        return new TickListDataProvider(formattedTicks, tickSpacing);

    } catch (tickFetchError) {
        logger.warn(`[Simulator] Error fetching/processing ticks for pool ${poolAddress}: ${tickFetchError.message}. Simulation accuracy may be affected.`);
        handleError(tickFetchError, `TickLens Fetch (${poolAddress})`);
        // Return an empty provider instead of null? Allows simulation to proceed but might be inaccurate.
        // Let's return null for now to signal failure clearly.
        return null;
    }
}


/**
 * Simulates a single swap leg using Uniswap V3 SDK.
 * Requires pre-fetched pool data (slot0, liquidity).
 * Fetches necessary tick data internally using TickLens.
 * @param {ethers.Provider} provider Ethers provider instance.
 * @param {object} poolData Contains { address, fee, tick, liquidity, sdkToken0, sdkToken1 }
 * @param {Token} tokenIn The input token (SDK object).
 * @param {Token} tokenOut The output token (SDK object).
 * @param {CurrencyAmount<Token>} amountIn The amount of tokenIn to swap.
 * @returns {Promise<Trade<Token, Token, TradeType.EXACT_INPUT> | null>} The simulated trade object or null on failure.
 */
async function simulateSingleTradeSDK(provider, poolData, tokenIn, tokenOut, amountIn) {
    const functionSig = `[SimSDK Pool: ${poolData.address}]`;
    logger.debug(`${functionSig} Simulating ${ethers.formatUnits(amountIn.quotient.toString(), tokenIn.decimals)} ${tokenIn.symbol} -> ${tokenOut.symbol}`);

    // Basic Validations
    if (!provider || !poolData || !tokenIn || !tokenOut || !amountIn || !(amountIn instanceof CurrencyAmount)) {
        logger.error(`${functionSig} Invalid arguments for simulateSingleTradeSDK.`); return null;
    }
    if (amountIn.quotient <= 0n) { // Use BigInt comparison
         logger.warn(`${functionSig} Input amount is zero or negative.`); return null;
    }

    try {
        // 1. Create Uniswap SDK Pool object
        const pool = new Pool(
            tokenIn.sortsBefore(tokenOut) ? tokenIn : tokenOut, // token0 must be sorted before token1
            tokenIn.sortsBefore(tokenOut) ? tokenOut : tokenIn, // token1
            poolData.fee,
            poolData.sqrtPriceX96.toString(), // SDK expects string
            poolData.liquidity.toString(),    // SDK expects string
            Number(poolData.tick)             // SDK expects number
            // Tick data provider will be fetched next
        );

        // 2. Fetch Tick Data
        const tickDataProvider = await getTickDataProvider(provider, poolData.address, pool.tickSpacing);
        if (!tickDataProvider) {
            logger.warn(`${functionSig} Failed to get tick data. Cannot simulate accurately.`);
            return null; // Cannot proceed without tick data
        }

        // 3. Create Route
        const route = new Route([pool], tokenIn, tokenOut);
        logger.debug(`${functionSig} Route created.`);

        // 4. Create Trade object
        // Use TickListDataProvider for accurate simulation
        const trade = await Trade.fromRoute(route, amountIn, TradeType.EXACT_INPUT, { tickDataProvider });
        logger.debug(`${functionSig} Trade simulation successful.`);

        if (!trade || !trade.outputAmount || trade.outputAmount.quotient <= 0n) {
            logger.warn(`${functionSig} Trade simulation returned invalid trade or zero output.`);
            return null;
        }

        return trade; // Return the successful trade simulation

    } catch (error) {
        // Handle specific SDK errors if possible (e.g., InsufficientLiquidityError)
        if (error.message.includes('NO_ROUTE_FOUND')) {
             logger.warn(`${functionSig} No route found for swap (${tokenIn.symbol} -> ${tokenOut.symbol}).`);
        } else if (error.message.includes('InsufficientInputAmountError')) {
             logger.warn(`${functionSig} Insufficient input amount for swap.`);
        } else {
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
 *   { groupName, borrowToken, poolBorrow, poolSwap, borrowAmount }
 *   poolBorrow/poolSwap contain { address, fee, tick, liquidity, sdkToken0, sdkToken1 }
 * @returns {Promise<object | null>} Simulation result: { grossProfit, sdkTokenBorrowed, borrowAmountUsed, intermediateAmount, finalAmount, trade1, trade2 } or null if simulation fails.
 */
async function simulateArbitrage(provider, opportunity) {
    const functionSig = `[SimArb Group: ${opportunity?.groupName}]`;
    logger.info(`${functionSig} Starting simulation...`);

    // Validate Opportunity data
    if (!provider || !opportunity || !opportunity.borrowToken || !opportunity.poolBorrow || !opportunity.poolSwap || !opportunity.borrowAmount) {
        logger.error(`${functionSig} Invalid opportunity object provided.`);
        handleError(new Error('Invalid opportunity object'), `${functionSig} Input Validation`);
        return null;
    }
    if (opportunity.borrowAmount <= 0n) {
        logger.warn(`${functionSig} Borrow amount is zero or negative. Skipping simulation.`);
        return null;
    }

    const { borrowToken, poolBorrow, poolSwap, borrowAmount } = opportunity;
    const sdkBorrowToken = borrowToken.sdkToken; // Assuming PoolScanner adds sdkToken to borrowToken object

    if (!sdkBorrowToken || !(sdkBorrowToken instanceof Token)) {
         logger.error(`${functionSig} Missing or invalid sdkBorrowToken in opportunity.borrowToken`);
         return null;
    }

    // Determine the intermediate token (the token we swap the borrowed token into)
    // It's the *other* token in the pool we're swapping on first (poolSwap)
    let sdkIntermediateToken;
    if (poolSwap.sdkToken0.address === sdkBorrowToken.address) {
        sdkIntermediateToken = poolSwap.sdkToken1;
    } else if (poolSwap.sdkToken1.address === sdkBorrowToken.address) {
        sdkIntermediateToken = poolSwap.sdkToken0;
    } else {
        logger.error(`${functionSig} Borrow token (${sdkBorrowToken.symbol}) not found in poolSwap (${poolSwap.address}). Inconsistent data.`);
        return null;
    }

    logger.info(`${functionSig} Path: ${sdkBorrowToken.symbol} -> ${sdkIntermediateToken.symbol} (on ${poolSwap.address}) -> ${sdkBorrowToken.symbol} (on ${poolBorrow.address})`);

    try {
        // --- Simulation Hop 1: Borrow Token -> Intermediate Token on Pool Swap ---
        const amountInHop1 = CurrencyAmount.fromRawAmount(sdkBorrowToken, borrowAmount.toString()); // Use the configured borrow amount
        logger.info(`${functionSig} Simulating Hop 1: ${ethers.formatUnits(borrowAmount, sdkBorrowToken.decimals)} ${sdkBorrowToken.symbol} -> ${sdkIntermediateToken.symbol} on pool ${poolSwap.address} (Fee: ${poolSwap.fee})`);

        const trade1 = await simulateSingleTradeSDK(provider, poolSwap, sdkBorrowToken, sdkIntermediateToken, amountInHop1);

        if (!trade1 || !trade1.outputAmount || trade1.outputAmount.quotient <= 0n) {
            logger.warn(`${functionSig} Hop 1 simulation failed or yielded zero output.`);
            return null; // Cannot proceed if first swap fails
        }
        const intermediateAmount = trade1.outputAmount; // This is CurrencyAmount<Token>
        logger.info(`${functionSig} Hop 1 Output: ${intermediateAmount.toSignificant(6)} ${sdkIntermediateToken.symbol}`);


        // --- Simulation Hop 2: Intermediate Token -> Borrow Token on Pool Borrow ---
        logger.info(`${functionSig} Simulating Hop 2: ${intermediateAmount.toSignificant(6)} ${sdkIntermediateToken.symbol} -> ${sdkBorrowToken.symbol} on pool ${poolBorrow.address} (Fee: ${poolBorrow.fee})`);

        const trade2 = await simulateSingleTradeSDK(provider, poolBorrow, sdkIntermediateToken, sdkBorrowToken, intermediateAmount);

        if (!trade2 || !trade2.outputAmount || trade2.outputAmount.quotient <= 0n) {
            logger.warn(`${functionSig} Hop 2 simulation failed or yielded zero output.`);
            return null; // Cannot proceed if second swap fails
        }
        const finalAmount = trade2.outputAmount; // This is CurrencyAmount<Token>
        logger.info(`${functionSig} Hop 2 Output (Final Amount): ${finalAmount.toSignificant(6)} ${sdkBorrowToken.symbol}`);

        // --- Calculate Gross Profit ---
        // Gross Profit = Final Amount Received - Initial Borrow Amount
        const grossProfitRaw = JSBI.subtract(finalAmount.quotient, amountInHop1.quotient); // JSBI subtraction
        const grossProfitBigInt = BigInt(grossProfitRaw.toString()); // Convert JSBI result to native BigInt

        logger.info(`${functionSig} Initial Borrow: ${ethers.formatUnits(borrowAmount, sdkBorrowToken.decimals)} ${sdkBorrowToken.symbol}`);
        logger.info(`${functionSig} Final Amount Recv: ${ethers.formatUnits(finalAmount.quotient.toString(), sdkBorrowToken.decimals)} ${sdkBorrowToken.symbol}`);
        logger.info(`${functionSig} Gross Profit: ${ethers.formatUnits(grossProfitBigInt, sdkBorrowToken.decimals)} ${sdkBorrowToken.symbol}`);


        // --- Construct Result ---
        const simulationResult = {
            grossProfit: grossProfitBigInt,       // Native BigInt for profitCalculator
            sdkTokenBorrowed: sdkBorrowToken,     // Pass the SDK Token object
            borrowAmountUsed: borrowAmount,       // The initial borrow amount (BigInt)
            intermediateAmount: intermediateAmount, // SDK CurrencyAmount object
            finalAmount: finalAmount,             // SDK CurrencyAmount object
            trade1: trade1,                       // Uniswap SDK Trade object for hop 1
            trade2: trade2,                       // Uniswap SDK Trade object for hop 2
            opportunity: opportunity,             // Pass through original opportunity data
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
    if (!trade || !trade.outputAmount) {
        logger.warn('[Simulator] Cannot get minimum amount out from invalid trade object.');
        return 0n; // Return 0 if trade is invalid
    }
    if (typeof slippageToleranceBps !== 'number' || slippageToleranceBps < 0) {
        logger.warn(`[Simulator] Invalid slippage tolerance BPS: ${slippageToleranceBps}. Defaulting to 0.`);
        slippageToleranceBps = 0;
    }

    const slippageTolerance = new Percent(slippageToleranceBps, 10000); // e.g., 10 BPS = 10/10000 = 0.1%
    const amountOut = trade.minimumAmountOut(slippageTolerance); // Uses SDK's internal calculation

    logger.debug(`[Simulator] Min Amount Out: Slippage=${slippageToleranceBps}bps, Amount=${ethers.formatUnits(amountOut.quotient.toString(), amountOut.currency.decimals)} ${amountOut.currency.symbol}`);

    return BigInt(amountOut.quotient.toString()); // Return as native BigInt
}


module.exports = {
    initializeQuoter, // Expose initializer
    simulateArbitrage,
    getMinimumAmountOut,
    // Expose simulateSingleTradeSDK if needed for direct testing? Maybe not for main operation.
};
