// /workspaces/arbitrum-flash/core/gasEstimator.js
// --- VERSION UPDATED FOR PHASE 1 REFACTOR ---

const { ethers } = require('ethers');
const logger = require('../utils/logger'); // Assuming logger is universally available

class GasEstimator {
    /**
     * @param {ethers.providers.Provider} provider The Ethers provider instance.
     * @param {object} config Configuration object.
     * @param {number} config.GAS_ESTIMATE_BUFFER_PERCENT Percentage buffer to add to gas estimates.
     * @param {string} config.FALLBACK_GAS_LIMIT Default gas limit (as string) if estimation fails.
     */
    constructor(provider, config) {
        if (!provider) {
            throw new Error("[GasEstimator] Provider instance is required.");
        }
        if (!config || typeof config.GAS_ESTIMATE_BUFFER_PERCENT === 'undefined' || !config.FALLBACK_GAS_LIMIT) {
            throw new Error("[GasEstimator] Configuration object with GAS_ESTIMATE_BUFFER_PERCENT and FALLBACK_GAS_LIMIT is required.");
        }
        this.provider = provider;

        try {
             // Store buffer as a BigNumber percentage (e.g., 20)
             this.gasEstimateBufferPercent = ethers.BigNumber.from(config.GAS_ESTIMATE_BUFFER_PERCENT);
             // Store fallback limit as BigNumber
             this.fallbackGasLimit = ethers.BigNumber.from(config.FALLBACK_GAS_LIMIT);

             if (this.gasEstimateBufferPercent.lt(0)) {
                 throw new Error("GAS_ESTIMATE_BUFFER_PERCENT cannot be negative.");
             }
             if (this.fallbackGasLimit.lte(0)) {
                 throw new Error("FALLBACK_GAS_LIMIT must be positive.");
             }

        } catch (error) {
             logger.error(`[GasEstimator] Invalid configuration value: ${error.message}`);
             throw new Error(`[GasEstimator] Invalid configuration: ${error.message}`);
        }


        logger.info(`[GasEstimator] Initialized with Buffer: ${this.gasEstimateBufferPercent.toString()}%, Fallback Limit: ${this.fallbackGasLimit.toString()}`);
    }

    /**
     * Estimates the gas limit for a specific transaction request, adding a buffer.
     * @param {ethers.providers.TransactionRequest} txRequest The transaction request object (to, data, value, from etc.)
     * @returns {Promise<ethers.BigNumber>} The estimated gas limit (including buffer), or fallback limit on error.
     */
    async estimateGasForTx(txRequest) {
        try {
            // Basic validation of the request object
            if (!txRequest || typeof txRequest !== 'object') {
                throw new Error("txRequest object is required.");
            }
            if (!txRequest.to || !ethers.utils.isAddress(txRequest.to)) {
                 throw new Error("txRequest must include a valid 'to' address.");
            }
            if (!txRequest.data) {
                 // Allow data to be empty ('0x') but not undefined/null
                 if (txRequest.data === undefined || txRequest.data === null) {
                      throw new Error("txRequest must include a 'data' field.");
                 }
            }
             // 'from' is often important for accurate estimation due to contract logic/permissions
             if (!txRequest.from || !ethers.utils.isAddress(txRequest.from)) {
                   logger.debug("[GasEstimator] 'from' address missing in txRequest for estimateGas. Estimation might be less accurate.");
                   // Proceed without it, but log debug message
             }

            logger.debug(`[GasEstimator] Estimating gas for tx: To=${txRequest.to}, From=${txRequest.from || 'N/A'}, Data=${txRequest.data?.substring(0, 10)}...`);

            // Perform the actual estimation using the provider
            const estimatedGas = await this.provider.estimateGas(txRequest);

            // Add the configured buffer: bufferedGas = estimate * (100 + buffer) / 100
            const bufferMultiplier = ethers.BigNumber.from(100).add(this.gasEstimateBufferPercent);
            const bufferedGas = estimatedGas.mul(bufferMultiplier).div(100);

            logger.debug(`[GasEstimator] Raw estimate: ${estimatedGas.toString()}, Buffered (${this.gasEstimateBufferPercent}%): ${bufferedGas.toString()}`);
            return bufferedGas;

        } catch (error) {
            logger.warn(`[GasEstimator] Failed to estimate gas for tx: ${error.message}. Falling back to limit: ${this.fallbackGasLimit.toString()}`);

            // Log more details for common failure modes
            const errorCode = error.code || 'UNKNOWN';
            const errorReason = error.reason || 'No reason provided';
            const errorData = error.data || error.error?.data; // Sometimes nested

            logger.warn(`[GasEstimator] Error Details: Code=${errorCode}, Reason=${errorReason}`, {
                 txTo: txRequest?.to,
                 txFrom: txRequest?.from,
                 errorData: errorData // Often contains revert reason data
            });

            if (errorCode === ethers.errors.CALL_EXCEPTION || errorCode === 'CALL_EXCEPTION') {
                 logger.warn(`[GasEstimator] Gas estimation CALL_EXCEPTION. Potential revert or insufficient balance/allowance. Check contract logic & parameters.`);
            } else if (errorCode === ethers.errors.UNPREDICTABLE_GAS_LIMIT) {
                 logger.warn(`[GasEstimator] Gas estimation UNPREDICTABLE_GAS_LIMIT. Transaction is likely to fail. Check parameters.`);
            }

            // Return the configured fallback limit
            return this.fallbackGasLimit;
        }
    }

    /**
     * Gets the current recommended EIP-1559 fee data or legacy gas price.
     * @returns {Promise<ethers.providers.FeeData | null>} Object containing fee data, or null on error.
     */
    async getFeeData() {
        try {
            logger.debug("[GasEstimator] Fetching fee data from provider...");
            const feeData = await this.provider.getFeeData();

            // Basic validation: Ensure we get *something* usable
            if (!feeData || (!feeData.maxFeePerGas && !feeData.gasPrice)) {
                logger.warn("[GasEstimator] Provider returned incomplete or unusable fee data.", feeData);
                return null; // Indicate failure to retrieve valid data
            }

            // Log fetched data clearly (prefer EIP-1559 if available)
            if (feeData.maxFeePerGas) {
                logger.debug(`[GasEstimator] Fetched EIP-1559 fee data (Gwei): MaxFee=${ethers.utils.formatUnits(feeData.maxFeePerGas, 'gwei')}, MaxPriority=${feeData.maxPriorityFeePerGas ? ethers.utils.formatUnits(feeData.maxPriorityFeePerGas, 'gwei') : 'N/A'}`);
            } else {
                logger.debug(`[GasEstimator] Fetched Legacy fee data (Gwei): GasPrice=${ethers.utils.formatUnits(feeData.gasPrice, 'gwei')}`);
            }

            return feeData;
        } catch (error) {
            logger.error(`[GasEstimator] Failed to get fee data: ${error.message}`, error);
            return null; // Indicate failure
        }
    }
}

// Export the class
module.exports = GasEstimator;
