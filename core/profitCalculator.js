// core/profitCalculator.js
const { ethers } = require('ethers');
const config = require('../config/index.js'); // Load merged config
const logger = require('../utils/logger');
// --- CORRECTED PATH: Import from core, not utils ---
const GasEstimator = require('./gasEstimator'); // Import GasEstimator CLASS
// --- Import the Price Feed utility ---
const { getChainlinkPriceData, convertTokenAmountToWei } = require('../utils/priceFeed');
const { ArbitrageError } = require('../utils/errorHandler'); // Import error type

/**
 * Estimates the total transaction cost in Wei using the GasEstimator class.
 * NOTE: This function might become less necessary if the engine passes the pre-estimated cost.
 * Keeping it for now as a potential standalone check.
 *
 * @param {GasEstimator} gasEstimatorInstance An instance of the GasEstimator class.
 * @param {ethers.TransactionRequest | null} txRequest Optional transaction request for specific gas limit estimation. If null, uses fallback GAS_LIMIT_ESTIMATE.
 * @returns {Promise<bigint>} Estimated gas cost in Wei, or 0n if estimation fails.
 */
async function estimateTotalGasCost(gasEstimatorInstance, txRequest = null) {
    if (!(gasEstimatorInstance instanceof GasEstimator)) {
         logger.error("[ProfitCalc] Invalid GasEstimator instance provided to estimateTotalGasCost.");
         return 0n;
    }

    let gasLimit;
    if (txRequest) {
        // Estimate specific limit if txRequest is provided
        gasLimit = await gasEstimatorInstance.estimateGasLimit(txRequest);
    } else {
        // Use fallback limit from config if no specific request is given
        gasLimit = BigInt(config.GAS_LIMIT_ESTIMATE || 1500000n); // Ensure fallback exists
        logger.warn(`[ProfitCalc] estimateTotalGasCost called without txRequest. Using fallback gas limit: ${gasLimit}`);
    }

    // Get fee data using the estimator instance
    const gasPriceData = await gasEstimatorInstance.getGasPriceData();
    if (!gasPriceData) {
        logger.warn('[ProfitCalc] Could not get gas price data for cost estimation.');
        return 0n;
    }

    let estimatedCostWei;
    if (gasPriceData.maxFeePerGas) {
        // EIP-1559
        estimatedCostWei = gasLimit * gasPriceData.maxFeePerGas;
    } else if (gasPriceData.gasPrice) {
        // Legacy
        estimatedCostWei = gasLimit * gasPriceData.gasPrice;
    } else {
        logger.warn('[ProfitCalc] Invalid gas price data format received.');
        return 0n;
    }

    // Use config.NATIVE_DECIMALS if available, otherwise default to 18 for ETH display
    const nativeDecimals = config.NATIVE_DECIMALS || 18;
    const nativeSymbol = config.NATIVE_SYMBOL || 'ETH';
    logger.debug(`[ProfitCalc] Gas Cost Estimation: Limit=${gasLimit}, Fees=${JSON.stringify(gasPriceData)} => Cost=${ethers.formatUnits(estimatedCostWei, nativeDecimals)} ${nativeSymbol}`);
    return estimatedCostWei;
}


/**
 * Checks if the simulated opportunity is profitable after considering estimated gas costs.
 * Profit comparison is always done in native token (ETH/Wei) terms.
 *
 * @param {object} simulationResult The result from quoteSimulator. Requires { profitable, grossProfit, initialAmount, finalAmount, details:{tokenA} (SDK Token instance of borrowed token) }.
 * @param {GasEstimator} gasEstimatorInstance An instance of the GasEstimator class.
 * @param {object} groupConfig The specific pool group configuration. Requires { name, minNetProfit (in Wei) }.
 * @param {ethers.TransactionRequest | null} txRequest Optional: Prepared tx request for accurate gas estimation. If null, uses fallback gas limit.
 * @returns {Promise<{isProfitable: boolean, netProfitWei: bigint, estimatedGasCostWei: bigint, grossProfitWei: bigint | null}>} Profitability decision. All values in Wei. grossProfitWei is null if conversion failed.
 */
async function checkProfitability(simulationResult, gasEstimatorInstance, groupConfig, txRequest = null) {
    const functionSig = `[ProfitCalc Group: ${groupConfig?.name || 'Unknown'}]`; // For logging context

    // --- Input Validation ---
    if (!simulationResult || typeof simulationResult.grossProfit === 'undefined' || !simulationResult.details?.tokenA) {
        logger.warn(`${functionSig} Invalid simulation result provided (missing grossProfit or details.tokenA).`, simulationResult);
        return { isProfitable: false, netProfitWei: -1n, estimatedGasCostWei: 0n, grossProfitWei: null };
    }
     // Check if GasEstimator instance is valid
     if (!(gasEstimatorInstance instanceof GasEstimator)) {
          logger.error(`${functionSig} Invalid GasEstimator instance provided.`);
          // Cannot proceed without estimator
          return { isProfitable: false, netProfitWei: -1n, estimatedGasCostWei: 0n, grossProfitWei: null };
     }
    if (!groupConfig || typeof groupConfig.minNetProfit === 'undefined') {
        logger.warn(`${functionSig} Invalid or incomplete groupConfig provided (missing minNetProfit?).`);
        groupConfig = { ...groupConfig, minNetProfit: 0n }; // Default to 0 for safety, but log warning
        logger.warn(`${functionSig} Assuming minNetProfit = 0 Wei.`);
    }
    // --- End Validation ---

    const { grossProfit } = simulationResult; // This is in the smallest unit of the borrowed token (tokenA)
    const sdkTokenBorrowed = simulationResult.details.tokenA; // Get borrowed token from simulation details
    const minNetProfitWei = BigInt(groupConfig.minNetProfit); // Ensure it's BigInt, expected in Wei

    const nativeDecimals = config.NATIVE_DECIMALS || 18;
    const nativeSymbol = config.NATIVE_SYMBOL || 'ETH';

    // If gross profit is not positive, it cannot be profitable after gas
    if (grossProfit <= 0n) {
         logger.debug(`${functionSig} Gross profit (${ethers.formatUnits(grossProfit, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}) is not positive. Not profitable.`);
         // Calculate grossProfitWei as 0 if possible, otherwise null
         let grossProfitWeiCalc = null;
         if (sdkTokenBorrowed.symbol === nativeSymbol) {
             grossProfitWeiCalc = grossProfit; // Already in wei (non-positive)
         } else {
            // Attempt conversion even if non-positive for logging consistency, might return null
             const priceData = await getChainlinkPriceData(sdkTokenBorrowed.symbol, gasEstimatorInstance.provider, config); // Use provider from estimator
             if (priceData) { grossProfitWeiCalc = convertTokenAmountToWei(grossProfit, sdkTokenBorrowed.decimals, priceData); }
         }
         return { isProfitable: false, netProfitWei: grossProfitWeiCalc ?? -1n, estimatedGasCostWei: 0n, grossProfitWei: grossProfitWeiCalc };
    }

    // 1. Estimate Gas Cost (in Wei) using the GasEstimator instance and optional txRequest
    const estimatedGasCostWei = await estimateTotalGasCost(gasEstimatorInstance, txRequest);
    if (estimatedGasCostWei <= 0n) {
         logger.warn(`${functionSig} Failed to estimate gas cost or cost is zero. Assuming not profitable.`);
         return { isProfitable: false, netProfitWei: -1n, estimatedGasCostWei: 0n, grossProfitWei: null };
    }

    // 2. Calculate Net Profit (in Wei)
    let netProfitWei = -1n; // Default to indicate error/uncalculated
    let grossProfitWei = null; // Will hold gross profit in Wei
    let isProfitable = false;

    // Convert Gross Profit to Wei if necessary
    if (sdkTokenBorrowed.symbol === nativeSymbol) {
        grossProfitWei = grossProfit; // Gross profit is already in Wei
        logger.debug(`${functionSig} Gross profit is already in native token (${nativeSymbol}).`);
    } else {
        logger.debug(`${functionSig} Gross profit in ${sdkTokenBorrowed.symbol}. Fetching price vs ${nativeSymbol}...`);
        // Use provider from gas estimator instance
        const priceData = await getChainlinkPriceData(sdkTokenBorrowed.symbol, gasEstimatorInstance.provider, config);
        if (priceData) {
            grossProfitWei = convertTokenAmountToWei(grossProfit, sdkTokenBorrowed.decimals, priceData);
            if (grossProfitWei === null) {
                 logger.warn(`${functionSig} Failed to convert ${sdkTokenBorrowed.symbol} gross profit to ${nativeSymbol}. Assuming not profitable.`);
            } else {
                 logger.debug(`${functionSig} Converted gross profit: ${ethers.formatUnits(grossProfit, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol} -> ${ethers.formatUnits(grossProfitWei, nativeDecimals)} ${nativeSymbol}`);
            }
        } else {
            logger.warn(`${functionSig} Could not fetch price data for ${sdkTokenBorrowed.symbol}/${nativeSymbol}. Cannot accurately calculate profit. Assuming not profitable.`);
        }
    }

    // Proceed only if we have gross profit in Wei
    if (grossProfitWei !== null && grossProfitWei >= 0n) { // Check non-null and non-negative
        netProfitWei = grossProfitWei - estimatedGasCostWei;

        const grossProfitTokenFormatted = ethers.formatUnits(grossProfit, sdkTokenBorrowed.decimals);
        const grossProfitWeiFormatted = ethers.formatUnits(grossProfitWei, nativeDecimals);
        const gasCostFormatted = ethers.formatUnits(estimatedGasCostWei, nativeDecimals);
        const netProfitWeiFormatted = ethers.formatUnits(netProfitWei, nativeDecimals);
        const minProfitWeiFormatted = ethers.formatUnits(minNetProfitWei, nativeDecimals);

        logger.log(`${functionSig} Profit Check:`);
        logger.log(`  Gross Profit: ${grossProfitTokenFormatted} ${sdkTokenBorrowed.symbol} (~${grossProfitWeiFormatted} ${nativeSymbol})`);
        logger.log(`  Est. Gas Cost: - ${gasCostFormatted} ${nativeSymbol}`);
        logger.log(`  Net Profit (Wei): = ${netProfitWeiFormatted} ${nativeSymbol}`);
        logger.log(`  Min Required (Wei): ${minProfitWeiFormatted} ${nativeSymbol}`);

        // Compare net profit in Wei against minimum required Wei
        if (netProfitWei >= minNetProfitWei) {
            logger.log(`${functionSig} ✅ Profitable: Net profit >= Min profit.`);
            isProfitable = true;
        } else {
            logger.log(`${functionSig} ❌ Not Profitable: Net profit < Min profit.`);
        }
    } else {
         // Handle cases where grossProfitWei is null (conversion failed) or unexpectedly negative
         logger.warn(`${functionSig} Gross profit in Wei is null or negative (${grossProfitWei}). Assuming not profitable.`);
         netProfitWei = -1n; // Ensure net profit reflects failure state
         isProfitable = false;
    }

    return {
        isProfitable: isProfitable,
        netProfitWei: netProfitWei,         // Always in Wei, or -1n if calculation failed
        estimatedGasCostWei: estimatedGasCostWei, // Always in Wei
        grossProfitWei: grossProfitWei,     // Gross profit in Wei (null if conversion failed)
    };
}

module.exports = {
    checkProfitability,
    // estimateTotalGasCost, // Expose if needed? Usually called internally by checkProfitability
};
