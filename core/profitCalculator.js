// core/profitCalculator.js
const { ethers } = require('ethers');
const config = require('../config/index.js'); // Load config for NATIVE_SYMBOL etc.
const logger = require('../utils/logger');
const { getSimpleGasParams } = require('../utils/gasEstimator'); // Use our simple gas estimator for now
// TODO: Import a Price Feed utility eventually for non-native profit checks

/**
 * Estimates the gas cost for the arbitrage transaction.
 * @param {ethers.Provider} provider Ethers provider instance.
 * @param {bigint} gasLimitEstimate The estimated gas units for the transaction (from config or specific estimation).
 * @returns {Promise<bigint>} Estimated gas cost in Wei, or 0n if estimation fails.
 */
async function estimateTotalGasCost(provider, gasLimitEstimate) {
    const gasParams = await getSimpleGasParams(provider); // Fetch current recommended fees

    if (!gasParams || !gasParams.maxFeePerGas) {
        logger.warn('[ProfitCalc] Could not get valid gas parameters for cost estimation.');
        return 0n; // Return 0 cost if we can't estimate
    }

    // Calculate cost using maxFeePerGas (worst case for EIP-1559)
    // A more refined estimate might use (baseFee + maxPriorityFee), but maxFee is safer for profit calc
    const estimatedCost = gasLimitEstimate * gasParams.maxFeePerGas;
    logger.debug(`[ProfitCalc] Gas Estimation: Limit=${gasLimitEstimate}, MaxFeePerGas=${ethers.formatUnits(gasParams.maxFeePerGas, 'gwei')} Gwei => Cost=${ethers.formatUnits(estimatedCost, config.NATIVE_SYMBOL)} ${config.NATIVE_SYMBOL}`);
    return estimatedCost;
}

/**
 * Checks if the simulated opportunity is profitable after considering estimated gas costs.
 * @param {object} simulationResult The result from quoteSimulator.simulateArbitrage. Requires { grossProfit, sdkTokenBorrowed }
 * @param {ethers.Provider} provider Ethers provider instance.
 * @param {object} groupConfig The specific pool group configuration. Requires { minNetProfit, quoteTokenSymbol }
 * @returns {Promise<{isProfitable: boolean, netProfit: bigint, estimatedGasCost: bigint}>} Profitability decision.
 */
async function checkProfitability(simulationResult, provider, groupConfig) {
    if (!simulationResult || typeof simulationResult.grossProfit === 'undefined') {
        logger.warn('[ProfitCalc] Invalid simulation result provided.');
        return { isProfitable: false, netProfit: -1n, estimatedGasCost: 0n };
    }

    const { grossProfit } = simulationResult;
    const sdkTokenBorrowed = simulationResult.sdkTokenBorrowed || groupConfig.sdkBorrowToken; // Ensure we have the token object

    if (grossProfit <= 0n) {
         logger.debug('[ProfitCalc] Gross profit is zero or negative. Not profitable.');
         return { isProfitable: false, netProfit: grossProfit, estimatedGasCost: 0n }; // No need to check gas
    }

    // 1. Estimate Gas Cost
    // Use the GAS_LIMIT_ESTIMATE from the global config for now
    // TODO: A more accurate gas estimate could come from flashSwapManager.simulateFlashSwap's estimateGas result later
    const estimatedGasCost = await estimateTotalGasCost(provider, config.GAS_LIMIT_ESTIMATE);
    if (estimatedGasCost <= 0n) {
         logger.warn('[ProfitCalc] Failed to estimate gas cost. Assuming not profitable.');
         return { isProfitable: false, netProfit: grossProfit, estimatedGasCost: 0n };
    }

    // 2. Calculate Net Profit
    let netProfit = -1n; // Default to indicate unknown/uncalculated
    let isProfitable = false;
    const minNetProfit = groupConfig.minNetProfit || 0n; // Minimum profit from group config

    // Compare Gross Profit (in borrow token) vs Gas Cost (in native token)
    if (sdkTokenBorrowed.symbol === config.NATIVE_SYMBOL) {
        // If borrowing native token (e.g., WETH on ETH L1/L2s), direct comparison
        netProfit = grossProfit - estimatedGasCost;
        logger.log(`[ProfitCalc] Net Profit (Native): Gross=${ethers.formatUnits(grossProfit, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol} - Gas=${ethers.formatUnits(estimatedGasCost, config.NATIVE_SYMBOL)} ${config.NATIVE_SYMBOL} = ${ethers.formatUnits(netProfit, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}`);

        if (netProfit >= minNetProfit) {
            logger.log(`[ProfitCalc] ✅ Profitable (Native): Net profit >= Min profit (${ethers.formatUnits(minNetProfit, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol})`);
            isProfitable = true;
        } else {
             logger.log(`[ProfitCalc] ❌ Not Profitable (Native): Net profit < Min profit.`);
        }
    } else {
        // If borrowing non-native token (e.g., USDC), need price conversion for accurate check
        // TODO: Implement Price Feed Integration
        // For now, use a simple heuristic: check if gross profit is significantly larger than estimated gas cost
        // This is NOT reliable long-term.
        logger.warn(`[ProfitCalc] Profit Check (Non-Native): Requires price feed for accurate comparison of ${sdkTokenBorrowed.symbol} profit vs ${config.NATIVE_SYMBOL} gas cost.`);
        // Heuristic: Is gross profit (in USD terms, roughly) > gas cost (in USD terms, roughly)?
        // We don't have prices, so maybe check if gross profit > (minNetProfit + small buffer)? This is still flawed.
        // SAFER TEMPORARY APPROACH: Only proceed if gross profit is positive and rely on minNetProfit being set reasonably high in non-native terms.
        netProfit = grossProfit; // For now, report gross as net placeholder
        if (grossProfit > minNetProfit) {
             logger.log(`[ProfitCalc] ✅ Potentially Profitable (Non-Native - HEURISTIC): Gross profit (${ethers.formatUnits(grossProfit, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}) > Min profit (${ethers.formatUnits(minNetProfit, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}). GAS COST NOT ACCURATELY ACCOUNTED.`);
             isProfitable = true; // Proceed based on heuristic for now
        } else {
             logger.log(`[ProfitCalc] ❌ Not Profitable (Non-Native - HEURISTIC): Gross profit <= Min profit.`);
        }
    }

    return {
        isProfitable: isProfitable,
        netProfit: netProfit, // Note: May be inaccurate for non-native until price feed
        estimatedGasCost: estimatedGasCost,
        grossProfit: grossProfit, // Pass through for logging/context
    };
}

module.exports = {
    checkProfitability,
    // Expose estimateTotalGasCost if needed elsewhere? Maybe not.
};
