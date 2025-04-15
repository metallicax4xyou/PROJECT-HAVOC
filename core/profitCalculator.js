// core/profitCalculator.js
const { ethers } = require('ethers');
const config = require('../config/index.js'); // Load merged config
const logger = require('../utils/logger');
const { getSimpleGasParams } = require('../utils/gasEstimator');
// --- Import the new Price Feed utility ---
const { getChainlinkPriceData, convertTokenAmountToWei } = require('../utils/priceFeed');

/**
 * Estimates the gas cost for the arbitrage transaction in Wei.
 * @param {ethers.Provider} provider Ethers provider instance.
 * @param {bigint} gasLimitEstimate The estimated gas units for the transaction.
 * @returns {Promise<bigint>} Estimated gas cost in Wei, or 0n if estimation fails.
 */
async function estimateTotalGasCost(provider, gasLimitEstimate) {
    const gasParams = await getSimpleGasParams(provider);
    if (!gasParams || !gasParams.maxFeePerGas || gasParams.maxFeePerGas <= 0n) {
        logger.warn('[ProfitCalc] Could not get valid gas parameters for cost estimation.');
        return 0n;
    }
    const estimatedCost = gasLimitEstimate * gasParams.maxFeePerGas;
    // Use config.NATIVE_DECIMALS if available, otherwise default to 18 for ETH display
    const nativeDecimals = config.NATIVE_DECIMALS || 18;
    logger.debug(`[ProfitCalc] Gas Estimation: Limit=${gasLimitEstimate}, MaxFeePerGas=${ethers.formatUnits(gasParams.maxFeePerGas, 'gwei')} Gwei => Cost=${ethers.formatUnits(estimatedCost, nativeDecimals)} ${config.NATIVE_SYMBOL}`);
    return estimatedCost;
}

/**
 * Checks if the simulated opportunity is profitable after considering estimated gas costs.
 * Profit comparison is always done in native token (ETH/Wei) terms.
 * @param {object} simulationResult The result from quoteSimulator. Requires { grossProfit, sdkTokenBorrowed }
 * @param {ethers.Provider} provider Ethers provider instance.
 * @param {object} groupConfig The specific pool group configuration. Requires { name, minNetProfit (in Wei), sdkBorrowToken }.
 * @returns {Promise<{isProfitable: boolean, netProfitWei: bigint, estimatedGasCostWei: bigint, grossProfitWei: bigint | null}>} Profitability decision. All values in Wei. grossProfitWei is null if conversion failed.
 */
async function checkProfitability(simulationResult, provider, groupConfig) {
    const functionSig = `[ProfitCalc Group: ${groupConfig?.name || 'Unknown'}]`; // For logging context

    if (!simulationResult || typeof simulationResult.grossProfit === 'undefined' || !simulationResult.sdkTokenBorrowed) {
        logger.warn(`${functionSig} Invalid simulation result provided.`);
        return { isProfitable: false, netProfitWei: -1n, estimatedGasCostWei: 0n, grossProfitWei: null };
    }
    if (!groupConfig || typeof groupConfig.minNetProfit === 'undefined') {
        logger.warn(`${functionSig} Invalid or incomplete groupConfig provided (missing minNetProfit?).`);
        // Default minNetProfit to 0 for safety, but log warning. Consider throwing error if mandatory.
        groupConfig = { ...groupConfig, minNetProfit: 0n };
        logger.warn(`${functionSig} Assuming minNetProfit = 0 Wei.`);
    }

    const { grossProfit } = simulationResult; // This is in the smallest unit of the borrowed token
    const sdkTokenBorrowed = simulationResult.sdkTokenBorrowed;
    const minNetProfitWei = BigInt(groupConfig.minNetProfit); // Ensure it's BigInt, expected in Wei

    // Use native decimals for formatting, default 18
    const nativeDecimals = config.NATIVE_DECIMALS || 18;
    const nativeSymbol = config.NATIVE_SYMBOL || 'ETH';

    if (grossProfit <= 0n) {
         logger.debug(`${functionSig} Gross profit (${ethers.formatUnits(grossProfit, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}) is zero or negative. Not profitable.`);
         return { isProfitable: false, netProfitWei: grossProfit, estimatedGasCostWei: 0n, grossProfitWei: 0n }; // Return grossProfit as netProfitWei here (it's <= 0)
    }

    // 1. Estimate Gas Cost (in Wei)
    // TODO: Refine gasLimitEstimate - potentially pass it in from TxExecutor's estimateGas later?
    const gasLimitEstimate = config.GAS_LIMIT_ESTIMATE || 2000000n; // Use global config or a default
    const estimatedGasCostWei = await estimateTotalGasCost(provider, BigInt(gasLimitEstimate));
    if (estimatedGasCostWei <= 0n) {
         logger.warn(`${functionSig} Failed to estimate gas cost. Assuming not profitable.`);
         return { isProfitable: false, netProfitWei: -1n, estimatedGasCostWei: 0n, grossProfitWei: null };
    }

    // 2. Calculate Net Profit (in Wei)
    let netProfitWei = -1n; // Default to indicate error/uncalculated
    let grossProfitWei = null; // Will hold gross profit in Wei
    let isProfitable = false;

    // --- Check if borrowed token is the native token ---
    if (sdkTokenBorrowed.symbol === nativeSymbol) {
        grossProfitWei = grossProfit; // Gross profit is already in Wei (or native token's smallest unit)
        netProfitWei = grossProfitWei - estimatedGasCostWei;

        logger.log(`${functionSig} Net Profit (Native): Gross=${ethers.formatUnits(grossProfitWei, nativeDecimals)} ${nativeSymbol} - Gas=${ethers.formatUnits(estimatedGasCostWei, nativeDecimals)} ${nativeSymbol} = ${ethers.formatUnits(netProfitWei, nativeDecimals)} ${nativeSymbol}`);

        if (netProfitWei >= minNetProfitWei) {
            logger.log(`${functionSig} ✅ Profitable (Native): Net profit >= Min profit (${ethers.formatUnits(minNetProfitWei, nativeDecimals)} ${nativeSymbol})`);
            isProfitable = true;
        } else {
             logger.log(`${functionSig} ❌ Not Profitable (Native): Net profit < Min profit.`);
        }
    }
    // --- Borrowed token is NOT native, need price conversion ---
    else {
        logger.debug(`${functionSig} Non-native borrow token (${sdkTokenBorrowed.symbol}). Fetching price vs ${nativeSymbol}...`);
        const priceData = await getChainlinkPriceData(sdkTokenBorrowed.symbol, provider, config);

        if (priceData) {
            grossProfitWei = convertTokenAmountToWei(grossProfit, sdkTokenBorrowed.decimals, priceData);

            if (grossProfitWei !== null && grossProfitWei >= 0n) {
                 netProfitWei = grossProfitWei - estimatedGasCostWei;
                 const grossProfitTokenFormatted = ethers.formatUnits(grossProfit, sdkTokenBorrowed.decimals);
                 const grossProfitWeiFormatted = ethers.formatUnits(grossProfitWei, nativeDecimals);
                 const gasCostFormatted = ethers.formatUnits(estimatedGasCostWei, nativeDecimals);
                 const netProfitWeiFormatted = ethers.formatUnits(netProfitWei, nativeDecimals);

                 logger.log(`${functionSig} Profit Check (Non-Native: ${sdkTokenBorrowed.symbol}):`);
                 logger.log(`  Gross Profit: ${grossProfitTokenFormatted} ${sdkTokenBorrowed.symbol} (~${grossProfitWeiFormatted} ${nativeSymbol})`);
                 logger.log(`  Est. Gas Cost: ${gasCostFormatted} ${nativeSymbol}`);
                 logger.log(`  Net Profit (Wei): ${netProfitWeiFormatted} ${nativeSymbol}`);

                 if (netProfitWei >= minNetProfitWei) {
                     logger.log(`${functionSig} ✅ Profitable (Non-Native): Net profit >= Min profit (${ethers.formatUnits(minNetProfitWei, nativeDecimals)} ${nativeSymbol})`);
                     isProfitable = true;
                 } else {
                     logger.log(`${functionSig} ❌ Not Profitable (Non-Native): Net profit < Min profit.`);
                 }
            } else {
                 logger.warn(`${functionSig} Failed to convert ${sdkTokenBorrowed.symbol} gross profit to ${nativeSymbol}. Assuming not profitable.`);
                 // Keep netProfitWei = -1n, isProfitable = false
            }
        } else {
            logger.warn(`${functionSig} Could not fetch price data for ${sdkTokenBorrowed.symbol}/${nativeSymbol}. Cannot accurately calculate profit. Assuming not profitable.`);
            // Keep netProfitWei = -1n, isProfitable = false
        }
    }

    return {
        isProfitable: isProfitable,
        netProfitWei: netProfitWei,         // Always in Wei, or -1n if calculation failed
        estimatedGasCostWei: estimatedGasCostWei, // Always in Wei
        grossProfitWei: grossProfitWei,     // Gross profit in Wei (null if conversion failed)
        // Pass through original gross profit for context if needed elsewhere?
        // originalGrossProfit: grossProfit,
        // originalTokenSymbol: sdkTokenBorrowed.symbol
    };
}

module.exports = {
    checkProfitability,
    // estimateTotalGasCost, // Might expose later if needed by TxExecutor for pre-check
};
