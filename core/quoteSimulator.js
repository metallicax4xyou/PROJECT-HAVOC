// core/quoteSimulator.js
const { ethers } = require('ethers');
// Added Fraction, Percent to imports
const { CurrencyAmount, TradeType, Percent, Token, Fraction } = require('@uniswap/sdk-core');
const { Pool, Route, Trade, TickListDataProvider, Tick, tickToPrice } = require('@uniswap/v3-sdk');
const JSBI = require('jsbi'); // Uniswap SDK uses JSBI
const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler');
const config = require('../config/index.js'); // For slippage, etc.
// REMOVED incorrect require: const { ONE } = require('../internalConstants');

// --- ABIs ---
// No longer need TickLens ABI if not fetching ticks
// const IUniswapV3PoolABI = require('@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json').abi;

// Global QuoterV2 Contract instance (initialized later)
let quoterV2Contract = null;

/**
 * Initializes the QuoterV2 contract instance.
 * @param {ethers.Provider} provider Ethers provider instance.
 */
function initializeQuoter(provider) {
    if (!config.QUOTER_ADDRESS || !ethers.isAddress(config.QUOTER_ADDRESS)) { logger.warn('[Simulator] QUOTER_ADDRESS is missing or invalid in config. QuoterV2 simulations may fail.'); return; }
    if (!provider) { logger.error('[Simulator] Cannot initialize QuoterV2 without a provider.'); return; }
    try {
        // Need QuoterV2 ABI even if not used immediately
        const QuoterV2ABI = require('@uniswap/v3-periphery/artifacts/contracts/lens/QuoterV2.sol/QuoterV2.json').abi;
        quoterV2Contract = new ethers.Contract(config.QUOTER_ADDRESS, QuoterV2ABI, provider);
        logger.info(`[Simulator] QuoterV2 Contract Initialized at ${config.QUOTER_ADDRESS}`);
    } catch (error) {
        logger.error(`[Simulator] Failed to initialize QuoterV2 contract: ${error.message}`); quoterV2Contract = null;
    }
}

// Removed getTickDataProvider function

/**
 * Simulates a single swap leg using the Pool object's internal state.
 * Does NOT use external tick data - less accurate but avoids tick provider errors.
 * Returns the estimated output amount.
 * @param {ethers.Provider} provider Ethers provider instance. (Kept for consistency, though not used here)
 * @param {object} poolData Contains { address, feeBps, tick, liquidity, sqrtPriceX96, sdkToken0, sdkToken1 }
 * @param {Token} tokenIn The input token (SDK object).
 * @param {Token} tokenOut The output token (SDK object).
 * @param {CurrencyAmount<Token>} amountIn The amount of tokenIn to swap.
 * @returns {Promise<CurrencyAmount<Token> | null>} The estimated output amount or null on failure.
 */
async function simulateSingleSwapExactIn(provider, poolData, tokenIn, tokenOut, amountIn) {
    const functionSig = `[SimSwap-Internal Pool: ${poolData.address}]`; // Indicate internal simulation
    logger.debug(`${functionSig} Simulating ${ethers.formatUnits(amountIn.quotient.toString(), tokenIn.decimals)} ${tokenIn.symbol} -> ${tokenOut.symbol}`);

    if (!poolData || !tokenIn || !tokenOut || !amountIn || !(amountIn instanceof CurrencyAmount)) { logger.error(`${functionSig} Invalid arguments for simulateSingleSwapExactIn.`); return null; }
    if (amountIn.quotient <= 0n) { logger.warn(`${functionSig} Input amount is zero or negative.`); return null; }

    try {
        if (poolData.sqrtPriceX96 == null || poolData.liquidity == null || poolData.tick == null || poolData.feeBps == null) { logger.error(`${functionSig} Missing required pool state data.`); return null; }
        if (!poolData.sdkToken0 || !poolData.sdkToken1) { logger.error(`${functionSig} Missing sdkToken0 or sdkToken1 in poolData.`); return null; }

        logger.debug(`${functionSig} Creating Pool object for internal simulation...`);
        const pool = new Pool(
            poolData.sdkToken0, poolData.sdkToken1, poolData.feeBps,
            poolData.sqrtPriceX96.toString(), poolData.liquidity.toString(), Number(poolData.tick)
        );
        logger.debug(`${functionSig} Pool object created. Fee: ${poolData.feeBps}bps, TickSpacing: ${pool.tickSpacing}`);

        logger.debug(`${functionSig} Calling pool.getOutputAmount (internal simulation)...`);
        const [outputAmount, _poolAfter] = await pool.getOutputAmount(amountIn);
        logger.debug(`${functionSig} pool.getOutputAmount returned: ${outputAmount?.toSignificant(6)} ${outputAmount?.currency.symbol}`);

        if (!outputAmount || !(outputAmount instanceof CurrencyAmount) || outputAmount.quotient <= 0n) {
             logger.warn(`${functionSig} Simulation yielded invalid or zero output amount.`);
             return null;
        }
        return outputAmount;

    } catch (error) {
        logger.error(`${functionSig} Error during internal swap simulation: ${error.message}`);
        handleError(error, `simulateSingleSwapExactIn-Internal (${tokenIn.symbol}->${tokenOut.symbol})`);
        return null;
    }
}


/**
 * Simulates the full arbitrage path using direct internal pool simulation.
 * Calculates gross profit before fees/gas. Less accurate but more robust against tick data issues.
 * @param {ethers.Provider} provider Ethers provider instance.
 * @param {object} opportunity The opportunity object from PoolScanner.
 * @returns {Promise<object | null>} Simulation result: { grossProfit, sdkTokenBorrowed, borrowAmountUsed, intermediateAmount, finalAmount } or null if simulation fails.
 */
async function simulateArbitrage(provider, opportunity) {
    const functionSig = `[SimArb Group: ${opportunity?.groupName}]`;
    logger.info(`${functionSig} Starting simulation (using INTERNAL pool simulation)...`);
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
    if (!finalAmount || !(finalAmount instanceof CurrencyAmount)) { logger.warn('[Simulator] Cannot get minimum amount out from invalid finalAmount object.'); return 0n; }
    if (typeof slippageToleranceBps !== 'number' || slippageToleranceBps < 0) { logger.warn(`[Simulator] Invalid slippage tolerance BPS: ${slippageToleranceBps}. Defaulting to 0.`); slippageToleranceBps = 0; }

    const slippageTolerance = new Percent(slippageToleranceBps, 10000);
    const ONE_HUNDRED_PERCENT = new Percent(10000, 10000); // Create 100% Percent
    const denominator = ONE_HUNDRED_PERCENT.add(slippageTolerance); // 1 + slippage

    // Ensure quotient is JSBI before passing to Fraction constructor
    const finalAmountQuotientJSBI = JSBI.BigInt(finalAmount.quotient.toString());

    const slippageAdjustedAmountOut = new Fraction(finalAmountQuotientJSBI) // Use JSBI
        .divide(denominator.asFraction)
        .quotient;

    const minAmountBigInt = BigInt(slippageAdjustedAmountOut.toString()); // Convert final result back to BigInt
    logger.debug(`[Simulator] Min Amount Out: Slippage=${slippageToleranceBps}bps, Amount=${ethers.formatUnits(minAmountBigInt, finalAmount.currency.decimals)} ${finalAmount.currency.symbol}`);
    return minAmountBigInt;
}


module.exports = {
    initializeQuoter,
    simulateArbitrage,
    getMinimumAmountOut,
};
