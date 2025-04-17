// /workspaces/arbitrum-flash/core/gasEstimator.js

const { ethers } = require('ethers');
const logger = require('../utils/logger');

// Basic configuration (can be moved to config file later)
const DEFAULT_GAS_LIMIT = 1_500_000n; // Fallback gas limit (adjust based on typical needs)
const GAS_ESTIMATE_BUFFER_PERCENT = 20n; // Add 20% buffer to estimates

class GasEstimator {
    constructor(provider) {
        if (!provider) {
            throw new Error("[GasEstimator] Provider instance is required.");
        }
        this.provider = provider;
        logger.info("[GasEstimator] Initialized.");
    }

    /**
     * Estimates the gas cost for a transaction.
     * @param {ethers.TransactionRequest} txRequest The transaction request object (to, data, value, etc.)
     * @returns {Promise<bigint>} The estimated gas limit (including buffer).
     */
    async estimateGasLimit(txRequest) {
        try {
            const estimatedGas = await this.provider.estimateGas(txRequest);
            // Add a buffer to the estimate
            const bufferedGas = estimatedGas + (estimatedGas * GAS_ESTIMATE_BUFFER_PERCENT / 100n);
            logger.debug(`[GasEstimator] Estimated gas: ${estimatedGas.toString()}, Buffered: ${bufferedGas.toString()}`);
            return bufferedGas;
        } catch (error) {
            logger.warn(`[GasEstimator] Failed to estimate gas: ${error.message}. Falling back to default limit: ${DEFAULT_GAS_LIMIT.toString()}`);
            // Log details if it's a revert
            if (error.code === 'CALL_EXCEPTION') {
                 logger.warn(`[GasEstimator] Gas estimation failed due to potential revert. Check transaction parameters.`, { txRequest: txRequest, errorData: error.data });
            }
            // Return a default high limit if estimation fails
            return DEFAULT_GAS_LIMIT;
        }
    }

    /**
     * Gets the current recommended gas price (legacy) or fee data (EIP-1559).
     * @returns {Promise<object>} Object containing gas price details (e.g., { gasPrice } or { maxFeePerGas, maxPriorityFeePerGas }).
     */
    async getGasPriceData() {
        try {
            const feeData = await this.provider.getFeeData();
            if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
                logger.debug(`[GasEstimator] Fetched EIP-1559 fee data: Max=${ethers.formatUnits(feeData.maxFeePerGas, 'gwei')} Gwei, Priority=${ethers.formatUnits(feeData.maxPriorityFeePerGas, 'gwei')} Gwei`);
                return {
                    maxFeePerGas: feeData.maxFeePerGas,
                    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
                };
            } else if (feeData.gasPrice) {
                logger.debug(`[GasEstimator] Fetched legacy gas price: ${ethers.formatUnits(feeData.gasPrice, 'gwei')} Gwei`);
                return { gasPrice: feeData.gasPrice };
            } else {
                 throw new Error("Provider returned incomplete fee data.");
            }
        } catch (error) {
            logger.error(`[GasEstimator] Failed to get gas price data: ${error.message}`);
            // Return null or throw, depending on how critical this is upstream
            return null;
        }
    }

     /**
     * Estimates the total transaction cost in ETH (or native currency).
     * @param {ethers.TransactionRequest} txRequest The transaction request object.
     * @returns {Promise<bigint|null>} Estimated cost in wei, or null if estimation fails.
     */
    async estimateExecutionCostWei(txRequest) {
        const gasLimit = await this.estimateGasLimit(txRequest);
        const gasPriceData = await this.getGasPriceData();

        if (!gasPriceData) {
            logger.error("[GasEstimator] Cannot estimate cost without gas price data.");
            return null;
        }

        let costWei;
        if (gasPriceData.maxFeePerGas) {
            // EIP-1559: Cost uses maxFeePerGas as the upper bound
            costWei = gasLimit * gasPriceData.maxFeePerGas;
        } else if (gasPriceData.gasPrice) {
            // Legacy: Cost uses gasPrice
            costWei = gasLimit * gasPriceData.gasPrice;
        } else {
             logger.error("[GasEstimator] Invalid gas price data format.");
             return null;
        }

        logger.info(`[GasEstimator] Estimated TX Cost: ${ethers.formatEther(costWei)} ETH (Limit: ${gasLimit.toString()})`);
        return costWei;
    }

     /**
     * Estimates the transaction cost in USD.
     * Requires a function to get the current ETH price in USD.
     * @param {ethers.TransactionRequest} txRequest The transaction request object.
     * @param {Function} getNativePriceUsdAsync Function that returns Promise<number> (current ETH/native price in USD).
     * @returns {Promise<number|null>} Estimated cost in USD, or null if estimation fails.
     */
    async estimateExecutionCostUsd(txRequest, getNativePriceUsdAsync) {
         if (typeof getNativePriceUsdAsync !== 'function') {
            logger.error("[GasEstimator] getNativePriceUsdAsync function is required to estimate cost in USD.");
            return null;
         }

        const costWei = await this.estimateExecutionCostWei(txRequest);
        if (costWei === null) {
            return null;
        }

        try {
            const nativePriceUsd = await getNativePriceUsdAsync();
            if (typeof nativePriceUsd !== 'number' || nativePriceUsd <= 0) {
                throw new Error("Invalid native price received.");
            }
            const costUsd = parseFloat(ethers.formatEther(costWei)) * nativePriceUsd;
            logger.info(`[GasEstimator] Estimated TX Cost: $${costUsd.toFixed(2)} USD`);
            return costUsd;
        } catch (error) {
             logger.error(`[GasEstimator] Failed to convert cost to USD: ${error.message}`);
             return null;
        }
    }
}

// Export the class
module.exports = GasEstimator;
