// /workspaces/arbitrum-flash/core/gasEstimator.js
// --- VERSION UPDATED FOR ETHERS V6 UTILS (toBigInt) & PHASE 1 REFACTOR ---

const { ethers } = require('ethers'); // Ethers v6+
const logger = require('../utils/logger'); // Assuming logger is universally available

class GasEstimator {
    /**
     * @param {ethers.Provider} provider The Ethers provider instance.
     * @param {object} config Configuration object passed from ArbitrageEngine.
     * @param {number} config.GAS_ESTIMATE_BUFFER_PERCENT Percentage buffer to add to gas estimates.
     * @param {string} config.FALLBACK_GAS_LIMIT Default gas limit (as string) if estimation fails.
     */
    constructor(provider, config) {
        if (!provider) {
            throw new Error("[GasEstimator] Provider instance is required.");
        }
        // Check the config object PASSED IN, not the global one
        if (!config || typeof config.GAS_ESTIMATE_BUFFER_PERCENT === 'undefined' || !config.FALLBACK_GAS_LIMIT) {
            throw new Error("[GasEstimator] Configuration object with GAS_ESTIMATE_BUFFER_PERCENT and FALLBACK_GAS_LIMIT is required.");
        }
        this.provider = provider;

        try {
             // --- Use ethers.toBigInt() for v6 compatibility ---
             // Convert buffer percentage to BigInt
             this.gasEstimateBufferPercent = ethers.toBigInt(config.GAS_ESTIMATE_BUFFER_PERCENT);
             // Convert fallback limit string to BigInt
             this.fallbackGasLimit = ethers.toBigInt(config.FALLBACK_GAS_LIMIT);
             // --- ---

             // --- Use BigInt comparison syntax (e.g., < 0n) ---
             if (this.gasEstimateBufferPercent < 0n) {
                 throw new Error("GAS_ESTIMATE_BUFFER_PERCENT cannot be negative.");
             }
             if (this.fallbackGasLimit <= 0n) {
                 throw new Error("FALLBACK_GAS_LIMIT must be positive.");
             }
             // --- ---

        } catch (error) {
             // Log the specific error during conversion/validation
             logger.error(`[GasEstimator] Invalid configuration value during BigInt conversion: ${error.message}`, {
                bufferInput: config.GAS_ESTIMATE_BUFFER_PERCENT,
                fallbackInput: config.FALLBACK_GAS_LIMIT,
                originalError: error
             });
             // Re-throw a more specific error
             throw new Error(`[GasEstimator] Invalid configuration: ${error.message}`);
        }


        logger.info(`[GasEstimator] Initialized with Buffer: ${this.gasEstimateBufferPercent.toString()}%, Fallback Limit: ${this.fallbackGasLimit.toString()}`);
    }

    /**
     * Estimates the gas limit for a specific transaction request, adding a buffer.
     * @param {ethers.TransactionRequest} txRequest The transaction request object (to, data, value, from etc.)
     * @returns {Promise<bigint>} The estimated gas limit (including buffer, as BigInt), or fallback limit on error.
     */
    async estimateGasForTx(txRequest) {
        try {
            // Basic validation of the request object
            if (!txRequest || typeof txRequest !== 'object') { throw new Error("txRequest object is required."); }
            // --- Use ethers.isAddress (v6) ---
            if (!txRequest.to || !ethers.isAddress(txRequest.to)) { throw new Error("txRequest must include a valid 'to' address."); }
            if (txRequest.data === undefined || txRequest.data === null) { throw new Error("txRequest must include a 'data' field (can be '0x')."); }
            if (!txRequest.from || !ethers.isAddress(txRequest.from)) {
                   logger.debug("[GasEstimator] 'from' address missing in txRequest for estimateGas. Estimation might be less accurate.");
            }
            // --- ---

            logger.debug(`[GasEstimator] Estimating gas for tx: To=${txRequest.to}, From=${txRequest.from || 'N/A'}, Data=${txRequest.data?.substring(0, 10)}...`);

            // Perform the actual estimation using the provider
            const estimatedGas = await this.provider.estimateGas(txRequest); // Returns BigInt in v6

            // Add the configured buffer using BigInt arithmetic
            // bufferedGas = estimate * (100 + buffer) / 100
            const bufferMultiplier = 100n + this.gasEstimateBufferPercent; // Use BigInt literal 100n
            const bufferedGas = (estimatedGas * bufferMultiplier) / 100n; // Use BigInt division

            logger.debug(`[GasEstimator] Raw estimate: ${estimatedGas.toString()}, Buffered (${this.gasEstimateBufferPercent}%): ${bufferedGas.toString()}`);
            return bufferedGas; // Return BigInt

        } catch (error) {
            logger.warn(`[GasEstimator] Failed to estimate gas for tx: ${error.message}. Falling back to limit: ${this.fallbackGasLimit.toString()}`);

            // Log more details for common failure modes
            const errorCode = error.code || 'UNKNOWN'; // ethers v6 uses error codes more consistently
            const errorReason = error.reason || error.message || 'No reason provided';
            const errorData = error.data || error.error?.data;

            logger.warn(`[GasEstimator] Error Details: Code=${errorCode}, Reason=${errorReason}`, {
                 txTo: txRequest?.to,
                 txFrom: txRequest?.from,
                 errorData: errorData
            });

            // Use standard ethers v6 error codes if possible
            if (errorCode === 'CALL_EXCEPTION' || errorCode === ethers.ErrorCode.CALL_EXCEPTION) {
                 logger.warn(`[GasEstimator] Gas estimation CALL_EXCEPTION. Potential revert or insufficient balance/allowance.`);
            } else if (errorCode === 'UNPREDICTABLE_GAS_LIMIT' || errorCode === ethers.ErrorCode.UNPREDICTABLE_GAS_LIMIT) {
                 logger.warn(`[GasEstimator] Gas estimation UNPREDICTABLE_GAS_LIMIT. Transaction is likely to fail.`);
            }

            // Return the configured fallback limit (already BigInt)
            return this.fallbackGasLimit;
        }
    }

    /**
     * Gets the current recommended EIP-1559 fee data or legacy gas price.
     * @returns {Promise<ethers.FeeData | null>} Object containing fee data (BigInt values), or null on error.
     */
    async getFeeData() {
        try {
            logger.debug("[GasEstimator] Fetching fee data from provider...");
            const feeData = await this.provider.getFeeData(); // Returns FeeData object with BigInts in v6

            if (!feeData || (!feeData.maxFeePerGas && !feeData.gasPrice)) {
                logger.warn("[GasEstimator] Provider returned incomplete or unusable fee data.", feeData);
                return null;
            }

            // Log fetched data clearly using ethers.formatUnits (v6)
            if (feeData.maxFeePerGas) {
                logger.debug(`[GasEstimator] Fetched EIP-1559 fee data (Gwei): MaxFee=${ethers.formatUnits(feeData.maxFeePerGas, 'gwei')}, MaxPriority=${feeData.maxPriorityFeePerGas ? ethers.formatUnits(feeData.maxPriorityFeePerGas, 'gwei') : 'N/A'}`);
            } else {
                logger.debug(`[GasEstimator] Fetched Legacy fee data (Gwei): GasPrice=${ethers.formatUnits(feeData.gasPrice, 'gwei')}`);
            }

            return feeData; // Return FeeData object with BigInts
        } catch (error) {
            logger.error(`[GasEstimator] Failed to get fee data: ${error.message}`, error);
            return null; // Indicate failure
        }
    }
}

// Export the class
module.exports = GasEstimator;
