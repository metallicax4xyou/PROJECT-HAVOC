// core/quoteSimulator.js
const { ethers } = require('ethers');
const { CurrencyAmount, TradeType, Percent, Token, Fraction } = require('@uniswap/sdk-core'); // Added Fraction, Percent
const { Pool, Route, Trade, TickListDataProvider, Tick, tickToPrice } = require('@uniswap/v3-sdk'); // Import Tick, tickToPrice
const JSBI = require('jsbi'); // Uniswap SDK uses JSBI
const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler');
const config = require('../config/index.js'); // For slippage, etc.

// --- ABIs ---
// Re-add IUniswapV3PoolABI if needed, keep QuoterV2ABI
// const IUniswapV3PoolABI = require('@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json').abi;
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
 * Fetches populated ticks, filters invalid ones, converts to JSBI, and sorts them.
 * @param {ethers.Provider} provider Ethers provider instance.
 * @param {string} poolAddress The checksummed address of the pool.
 * @param {number} tickSpacing The tick spacing of the pool.
 * @returns {Promise<TickListDataProvider | null>} A TickListDataProvider instance or null if fetching fails.
 */
async function getTickDataProvider(provider, poolAddress, tickSpacing) {
    const functionSig = `[TickProvider Pool: ${poolAddress}]`;
    if (!provider || !ethers.isAddress(poolAddress) || typeof tickSpacing !== 'number' || tickSpacing <= 0) { logger.error(`${functionSig} Invalid arguments for getTickDataProvider (tickSpacing: ${tickSpacing}).`); return null; }
    logger.debug(`${functionSig} Using tickSpacing: ${tickSpacing}`);

    const tickLensContract = new ethers.Contract(TICK_LENS_ADDRESS_CHECKSUM, TICK_LENS_ABI, provider);
    const tickBitmapIndex = 0;
    let populatedTicksRaw = [];
    let formattedTicks = [];

    try {
        // --- Step 1: Fetch from TickLens ---
        logger.debug(`${functionSig} Fetching ticks (Index ${tickBitmapIndex})...`);
        populatedTicksRaw = await tickLensContract.getPopulatedTicksInWord(poolAddress, tickBitmapIndex);
        logger.debug(`${functionSig} Fetched ${populatedTicksRaw?.length ?? 0} raw populated ticks.`);

        if (!populatedTicksRaw || populatedTicksRaw.length === 0) {
             logger.debug(`${functionSig} No ticks received from TickLens. Returning empty provider.`);
             return new TickListDataProvider([], tickSpacing);
        }

        // --- Step 2: Filter, Format, and Convert to JSBI ---
        let invalidTickCount = 0;
        formattedTicks = populatedTicksRaw.map((tickInfo) => {
            // ... (validation logic remains the same) ...
             if (tickInfo?.tick == null || tickInfo.liquidityNet == null || tickInfo.liquidityGross == null) { logger.warn(`${functionSig} Corrupt raw tick data found. Skipping.`); invalidTickCount++; return null; }
             const tickNumber = Number(tickInfo.tick);
             if (typeof tickInfo.liquidityNet !== 'bigint' || typeof tickInfo.liquidityGross !== 'bigint') { logger.warn(`${functionSig} Invalid liquidity data type for tick ${tickNumber}! NetType=${typeof tickInfo.liquidityNet}, GrossType=${typeof tickInfo.liquidityGross}. Filtering.`); invalidTickCount++; return null; }
             if (tickNumber % tickSpacing !== 0) { logger.warn(`${functionSig} Invalid tick! Tick ${tickNumber} is not divisible by spacing ${tickSpacing}. Filtering.`); invalidTickCount++; return null; }
             if (tickNumber < Tick.MIN_TICK || tickNumber > Tick.MAX_TICK) { logger.warn(`${functionSig} Invalid tick! Tick ${tickNumber} out of range [${Tick.MIN_TICK}, ${Tick.MAX_TICK}]. Filtering.`); invalidTickCount++; return null; }
             try {
                 return { tick: tickNumber, liquidityNet: JSBI.BigInt(tickInfo.liquidityNet.toString()), liquidityGross: JSBI.BigInt(tickInfo.liquidityGross.toString()) };
             } catch (jsbiError) { logger.warn(`${functionSig} Failed to convert liquidity to JSBI for tick ${tickNumber}: ${jsbiError.message}. Filtering.`); invalidTickCount++; return null; }
        }).filter(tick => tick !== null); // Filter out nulls

        if (invalidTickCount > 0) { logger.warn(`${functionSig} Filtered out ${invalidTickCount} invalid raw/formatted ticks.`); }

        if (formattedTicks.length === 0) {
             logger.warn(`${functionSig} No valid ticks remaining after filtering. Cannot create provider.`);
             return null;
        }

        // --- Step 3: Sort Ticks by Index ---
        logger.debug(`${functionSig} Sorting ${formattedTicks.length} valid ticks by index...`);
        formattedTicks.sort((a, b) => a.tick - b.tick);
        // Log sorted ticks for verification
        // logger.debug(`${functionSig} Sorted Ticks: ${JSON.stringify(formattedTicks, (k, v) => typeof v === 'object' && v != null && v.constructor === JSBI ? v.toString() : v)}`);


        // --- Step 4: Attempt to Create TickListDataProvider ---
        logger.debug(`${functionSig} Attempting to create TickListDataProvider with ${formattedTicks.length} sorted valid ticks and spacing ${tickSpacing}.`);
        try {
            const tickProvider = new TickListDataProvider(formattedTicks, tickSpacing);
            logger.debug(`${functionSig} TickListDataProvider created successfully.`);
            return tickProvider;
        } catch (constructorError) {
            logger.error(`${functionSig} Error constructing TickListDataProvider: ${constructorError.message}`);
            logger.error(`${functionSig} Data that caused constructor error (sorted): ${JSON.stringify(formattedTicks, (k, v) => typeof v === 'object' && v != null && v.constructor === JSBI ? v.toString() : v)}`);
            handleError(constructorError, `TickListDataProvider Constructor (${poolAddress})`);
            return null;
        }

    } catch (fetchError) {
        logger.warn(`${functionSig} Error during TickLens fetch: ${fetchError.message}.`);
        handleError(fetchError, `TickLens Fetch (${poolAddress})`);
        return null;
    }
}


/**
 * Simulates a single swap leg using the Pool object with a TickListDataProvider.
 * Returns the estimated output amount.
 * @param {ethers.Provider} provider Ethers provider instance.
 * @param {object} poolData Contains { address, feeBps, tick, liquidity, sqrtPriceX96, sdkToken0, sdkToken1 }
 * @param {Token} tokenIn The input token (SDK object).
 * @param {Token} tokenOut The output token (SDK object).
 * @param {CurrencyAmount<Token>} amountIn The amount of tokenIn to swap.
 * @returns {Promise<CurrencyAmount<Token> | null>} The simulated output amount or null on failure.
 */
async function simulateSingleSwapExactIn(provider, poolData, tokenIn, tokenOut, amountIn) {
    const functionSig = `[SimSwap Pool: ${poolData.address}]`; // Indicate simulation with external ticks
    logger.debug(`${functionSig} Simulating ${ethers.formatUnits(amountIn.quotient.toString(), tokenIn.decimals)} ${tokenIn.symbol} -> ${tokenOut.symbol}`);

    if (!provider || !poolData || !tokenIn || !tokenOut || !amountIn || !(amountIn instanceof CurrencyAmount)) { logger.error(`${functionSig} Invalid arguments for simulateSingleSwapExactIn.`); return null; }
    if (amountIn.quotient <= 0n) { logger.warn(`${functionSig} Input amount is zero or negative.`); return null; }

    try {
        // --- Basic Pool Data Validation ---
        if (poolData.sqrtPriceX96 == null || poolData.liquidity == null || poolData.tick == null || poolData.feeBps == null) { logger.error(`${functionSig} Missing required pool state data.`); return null; }
        if (!poolData.sdkToken0 || !poolData.sdkToken1) { logger.error(`${functionSig} Missing sdkToken0 or sdkToken1 in poolData.`); return null; }

        // --- Step 1: Determine Tick Spacing ---
        let tempPoolForSpacing;
        try {
            tempPoolForSpacing = new Pool( poolData.sdkToken0, poolData.sdkToken1, poolData.feeBps, poolData.sqrtPriceX96.toString(), poolData.liquidity.toString(), Number(poolData.tick) );
        } catch (tempPoolError) { logger.error(`${functionSig} Error creating temporary Pool object for spacing: ${tempPoolError.message}`); return null; }
        const tickSpacing = tempPoolForSpacing.tickSpacing;
        logger.debug(`${functionSig} Fee: ${poolData.feeBps}bps => Derived Tick Spacing: ${tickSpacing}`);

        // --- Step 2: Fetch Tick Data ---
        const tickDataProvider = await getTickDataProvider(provider, poolData.address, tickSpacing);
        if (!tickDataProvider) { logger.warn(`${functionSig} Failed to get valid tick data provider. Cannot simulate accurately.`); return null; }

        // --- Step 3: Create the *actual* Pool object *with* the Tick Data Provider ---
        logger.debug(`${functionSig} Creating final Pool object with fetched tick data provider...`);
        const pool = new Pool(
            poolData.sdkToken0, poolData.sdkToken1, poolData.feeBps,
            poolData.sqrtPriceX96.toString(), poolData.liquidity.toString(), Number(poolData.tick),
            tickDataProvider // Pass the fetched provider here!
        );
        logger.debug(`${functionSig} Final Pool object created.`);

        // --- Step 4: Simulate using pool.getOutputAmount ---
        logger.debug(`${functionSig} Calling pool.getOutputAmount...`);
        const [outputAmount, _poolAfter] = await pool.getOutputAmount(amountIn);
        logger.debug(`${functionSig} pool.getOutputAmount returned: ${outputAmount?.toSignificant(6)} ${outputAmount?.currency.symbol}`);

        // --- Step 5: Validate Output ---
        if (!outputAmount || !(outputAmount instanceof CurrencyAmount) || outputAmount.quotient <= 0n) {
             logger.warn(`${functionSig} Simulation yielded invalid or zero output amount.`); return null;
        }
        return outputAmount;

    } catch (error) {
        logger.error(`${functionSig} Error during single swap simulation: ${error.message}`);
        handleError(error, `simulateSingleSwapExactIn (${tokenIn.symbol}->${tokenOut.symbol})`);
        return null;
    }
}


/**
 * Simulates the full arbitrage path using direct pool simulation with fetched ticks.
 * Calculates gross profit before fees/gas.
 * @param {ethers.Provider} provider Ethers provider instance.
 * @param {object} opportunity The opportunity object from PoolScanner.
 * @returns {Promise<object | null>} Simulation result or null if simulation fails.
 */
async function simulateArbitrage(provider, opportunity) {
    // ... (Function body remains the same - calls the updated simulateSingleSwapExactIn) ...
    const functionSig = `[SimArb Group: ${opportunity?.groupName}]`;
    logger.info(`${functionSig} Starting simulation (using direct pool simulation with fetched ticks)...`); // Updated log
    if (!provider || !opportunity || !opportunity.startPoolInfo || !opportunity.swapPoolInfo || !opportunity.sdkTokenBorrowed || !opportunity.sdkTokenIntermediate || !opportunity.borrowAmount) { if (opportunity) { logger.error(`${functionSig} Invalid opportunity object provided. Missing fields: ${[!opportunity.startPoolInfo && 'startPoolInfo', !opportunity.swapPoolInfo && 'swapPoolInfo', !opportunity.sdkTokenBorrowed && 'sdkTokenBorrowed', !opportunity.sdkTokenIntermediate && 'sdkTokenIntermediate', !opportunity.borrowAmount && 'borrowAmount'].filter(Boolean).join(', ')}`); } else { logger.error(`${functionSig} Invalid or null opportunity object provided.`); } handleError(new Error('Invalid opportunity object structure received from PoolScanner'), `${functionSig} Input Validation`); return null; }
    if (opportunity.borrowAmount <= 0n) { logger.warn(`${functionSig} Borrow amount is zero or negative. Skipping simulation.`); return null; }
    const { startPoolInfo, swapPoolInfo, sdkTokenBorrowed, sdkTokenIntermediate, borrowAmount } = opportunity;
    if (!sdkTokenBorrowed || !(sdkTokenBorrowed instanceof Token)) { logger.error(`${functionSig} Missing or invalid sdkTokenBorrowed in opportunity.`); return null; }
    if (!sdkTokenIntermediate || !(sdkTokenIntermediate instanceof Token)) { logger.error(`${functionSig} Missing or invalid sdkTokenIntermediate in opportunity.`); return null; }
    logger.info(`${functionSig} Path: ${sdkTokenBorrowed.symbol} -> ${sdkTokenIntermediate.symbol} (on ${swapPoolInfo.address}) -> ${sdkTokenBorrowed.symbol} (on ${startPoolInfo.address})`);
    try {
        // Hop 1
        const amountInHop1 = CurrencyAmount.fromRawAmount(sdkTokenBorrowed, borrowAmount.toString());
        logger.info(`${functionSig} Simulating Hop 1: ${ethers.formatUnits(borrowAmount, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol} -> ${sdkTokenIntermediate.symbol} on pool ${swapPoolInfo.address} (Fee: ${swapPoolInfo.feeBps})`);
        const intermediateAmount = await simulateSingleSwapExactIn(provider, swapPoolInfo, sdkTokenBorrowed, sdkTokenIntermediate, amountInHop1);
        if (!intermediateAmount) { logger.warn(`${functionSig} Hop 1 simulation failed or yielded zero/invalid output.`); return null; }
        logger.info(`${functionSig} Hop 1 Output: ${intermediateAmount.toSignificant(6)} ${sdkTokenIntermediate.symbol}`);
        // Hop 2
        logger.info(`${functionSig} Simulating Hop 2: ${intermediateAmount.toSignificant(6)} ${sdkTokenIntermediate.symbol} -> ${sdkTokenBorrowed.symbol} on pool ${startPoolInfo.address} (Fee: ${startPoolInfo.feeBps})`);
        const finalAmount = await simulateSingleSwapExactIn(provider, startPoolInfo, sdkTokenIntermediate, sdkTokenBorrowed, intermediateAmount);
        if (!finalAmount) { logger.warn(`${functionSig} Hop 2 simulation failed or yielded zero/invalid output.`); return null; }
        logger.info(`${functionSig} Hop 2 Output (Final Amount): ${finalAmount.toSignificant(6)} ${sdkTokenBorrowed.symbol}`);
        // Profit Calc
        const grossProfitRaw = JSBI.subtract(finalAmount.quotient, JSBI.BigInt(borrowAmount.toString()));
        const grossProfitBigInt = BigInt(grossProfitRaw.toString());
        logger.info(`${functionSig} Initial Borrow: ${ethers.formatUnits(borrowAmount, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`);
        logger.info(`${functionSig} Final Amount Recv: ${ethers.formatUnits(finalAmount.quotient.toString(), sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`);
        logger.info(`${functionSig} Gross Profit: ${ethers.formatUnits(grossProfitBigInt, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`);
        // Result
        const simulationResult = { grossProfit: grossProfitBigInt, sdkTokenBorrowed: sdkTokenBorrowed, borrowAmountUsed: borrowAmount, intermediateAmount: intermediateAmount, finalAmount: finalAmount, opportunity: opportunity, };
        logger.info(`${functionSig} Simulation successful.`);
        return simulationResult;
    } catch (error) {
        logger.error(`${functionSig} Unexpected error during arbitrage simulation: ${error.message}`);
        handleError(error, `${functionSig} Main Try/Catch`); return null;
    }
}


/**
 * Calculates the minimum amount out for a trade considering slippage.
 * @param {CurrencyAmount<Token>} finalAmount The final simulated output amount from simulateArbitrage.
 * @param {number} slippageToleranceBps Slippage tolerance in basis points (e.g., 10 for 0.1%).
 * @returns {bigint} The minimum output amount in the token's smallest unit (wei/atomic).
 */
function getMinimumAmountOut(finalAmount, slippageToleranceBps) {
    // ... (Function body remains the same) ...
    if (!finalAmount || !(finalAmount instanceof CurrencyAmount)) { logger.warn('[Simulator] Cannot get minimum amount out from invalid finalAmount object.'); return 0n; }
    if (typeof slippageToleranceBps !== 'number' || slippageToleranceBps < 0) { logger.warn(`[Simulator] Invalid slippage tolerance BPS: ${slippageToleranceBps}. Defaulting to 0.`); slippageToleranceBps = 0; }
    const slippageTolerance = new Percent(slippageToleranceBps, 10000);
    const ONE_HUNDRED_PERCENT = new Percent(10000, 10000);
    const denominator = ONE_HUNDRED_PERCENT.add(slippageTolerance);
    const finalAmountQuotientJSBI = JSBI.BigInt(finalAmount.quotient.toString());
    const slippageAdjustedAmountOut = new Fraction(finalAmountQuotientJSBI).divide(denominator.asFraction).quotient;
    const minAmountBigInt = BigInt(slippageAdjustedAmountOut.toString());
    logger.debug(`[Simulator] Min Amount Out: Slippage=${slippageToleranceBps}bps, Amount=${ethers.formatUnits(minAmountBigInt, finalAmount.currency.decimals)} ${finalAmount.currency.symbol}`);
    return minAmountBigInt;
}


module.exports = {
    initializeQuoter,
    simulateArbitrage,
    getMinimumAmountOut,
};
