// utils/gasEstimator.js
// Simple gas price estimation

const { ethers } = require('ethers');

/**
 * Fetches current fee data and suggests basic gas parameters.
 * @param {ethers.Provider} provider Ethers provider instance.
 * @param {number} priorityFeeMultiplier Optional multiplier for maxPriorityFeePerGas (e.g., 1.1 for 110%).
 * @param {number} maxFeeMultiplier Optional multiplier for maxFeePerGas (e.g., 1.2 for 120%).
 * @returns {Promise<object|null>} Object with gas parameters or null on error.
 */
async function getSimpleGasParams(provider, priorityFeeMultiplier = 1.1, maxFeeMultiplier = 1.2) {
    if (!provider) {
        console.error("[GasEstimator] Provider required.");
        return null;
    }
    try {
        const feeData = await provider.getFeeData();

        // Basic validation of fee data
        if (!feeData || (!feeData.maxFeePerGas && !feeData.gasPrice) || !feeData.maxPriorityFeePerGas) {
             console.warn("[GasEstimator] Incomplete fee data received from provider:", feeData);
             // Fallback or throw? For now, return null or basic defaults if possible
             return {
                 maxPriorityFeePerGas: ethers.parseUnits('1', 'gwei'), // Default fallback
                 maxFeePerGas: ethers.parseUnits('20', 'gwei'), // Default fallback
             };
        }

        // Use BigInt for safe multiplication, ensuring multipliers are handled correctly
        // Convert multipliers to BigInts scaled by 100 for integer math
        const priorityMultiplierScaled = BigInt(Math.round(priorityFeeMultiplier * 100));
        const maxFeeMultiplierScaled = BigInt(Math.round(maxFeeMultiplier * 100));

        // Calculate suggested fees with multipliers
        const suggestedMaxPriorityFee = (feeData.maxPriorityFeePerGas * priorityMultiplierScaled) / 100n;
        const suggestedMaxFee = feeData.maxFeePerGas // Use maxFeePerGas if available (EIP-1559)
            ? (feeData.maxFeePerGas * maxFeeMultiplierScaled) / 100n
            : (feeData.gasPrice * maxFeeMultiplierScaled) / 100n; // Fallback to gasPrice if maxFeePerGas is null

        return {
            maxPriorityFeePerGas: suggestedMaxPriorityFee,
            maxFeePerGas: suggestedMaxFee,
            // gasLimit is transaction-specific, should be estimated separately
        };
    } catch (error) {
        console.error("[GasEstimator] Error fetching fee data:", error.message);
        return null; // Return null or default values on error
    }
}

module.exports = {
    getSimpleGasParams,
};
