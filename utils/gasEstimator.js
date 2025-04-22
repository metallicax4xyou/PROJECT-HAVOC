// utils/gasEstimator.js
const { ethers } = require('ethers');
const logger = require('./logger'); // Adjust path if needed
const { ArbitrageError } = require('./errorHandler'); // Adjust path if needed

class GasEstimator {
    /**
     * @param {object} config The main configuration object (needs FALLBACK_GAS_LIMIT, MAX_GAS_GWEI, etc.)
     * @param {ethers.Provider} provider Ethers provider instance
     */
    constructor(config, provider) {
        logger.debug('[GasEstimator] Initializing...');
        if (!config) { throw new ArbitrageError('GasEstimatorInit', 'Config object required.'); }
        if (!provider) { throw new ArbitrageError('GasEstimatorInit', 'Provider instance required.'); }

        this.config = config;
        this.provider = provider;

        // Validate needed config values
        this.fallbackGasLimit = BigInt(config.FALLBACK_GAS_LIMIT || 1500000); // Use config or default
        this.maxGasPriceGwei = ethers.parseUnits(String(config.MAX_GAS_GWEI || 10), 'gwei'); // Use config or default

        logger.info(`[GasEstimator] Initialized. Fallback Gas Limit: ${this.fallbackGasLimit}, Max Gas Price: ${ethers.formatUnits(this.maxGasPriceGwei, 'gwei')} Gwei`);
    }

    /**
     * Fetches current network fee data (EIP-1559 or legacy).
     * @returns {Promise<ethers.FeeData | null>}
     */
    async getFeeData() {
        try {
            const feeData = await this.provider.getFeeData();
            if (!feeData || (!feeData.gasPrice && (!feeData.maxFeePerGas || !feeData.maxPriorityFeePerGas))) {
                logger.warn('[GasEstimator] Received incomplete fee data from provider.');
                return null;
            }
            // Log fetched fees for debugging
            // logger.debug(`[GasEstimator] Fetched Fee Data: GasPrice=${feeData.gasPrice ? ethers.formatUnits(feeData.gasPrice, 'gwei') : 'N/A'} Gwei, MaxFee=${feeData.maxFeePerGas ? ethers.formatUnits(feeData.maxFeePerGas, 'gwei') : 'N/A'} Gwei, MaxPriority=${feeData.maxPriorityFeePerGas ? ethers.formatUnits(feeData.maxPriorityFeePerGas, 'gwei') : 'N/A'} Gwei`);
            return feeData;
        } catch (error) {
            logger.error(`[GasEstimator] Error fetching fee data: ${error.message}`);
            return null;
        }
    }

     /**
     * Determines the effective gas price to use based on fetched fee data and config limits.
     * @param {ethers.FeeData} feeData The fetched fee data.
     * @returns {bigint | null} The effective gas price in Wei, or null if unable to determine.
     */
    getEffectiveGasPrice(feeData) {
        if (!feeData) return null;

        let effectiveGasPrice = null;

        // Prefer EIP-1559 fields if available
        if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
             // Simple strategy: Use maxFeePerGas as the effective price cap for cost calculation
             // More sophisticated strategies could use baseFee + maxPriorityFee etc.
             effectiveGasPrice = feeData.maxFeePerGas;
             logger.debug(`[GasEstimator] Using EIP-1559 maxFeePerGas: ${ethers.formatUnits(effectiveGasPrice, 'gwei')} Gwei`);
        }
        // Fallback to legacy gasPrice
        else if (feeData.gasPrice) {
            effectiveGasPrice = feeData.gasPrice;
            logger.debug(`[GasEstimator] Using legacy gasPrice: ${ethers.formatUnits(effectiveGasPrice, 'gwei')} Gwei`);
        } else {
             logger.warn('[GasEstimator] Could not determine base gas price from fee data.');
             return null;
        }

        // Apply Max Gas Price Cap from config
        if (effectiveGasPrice > this.maxGasPriceGwei) {
            logger.warn(`[GasEstimator] Current gas price (${ethers.formatUnits(effectiveGasPrice, 'gwei')} Gwei) exceeds MAX_GAS_GWEI (${ethers.formatUnits(this.maxGasPriceGwei, 'gwei')} Gwei). Capping.`);
            effectiveGasPrice = this.maxGasPriceGwei;
        }

        return effectiveGasPrice;
    }


    /**
     * Estimates the gas cost for a transaction (currently uses fallback limit).
     * TODO: Implement actual estimation based on transaction details.
     * @param {object} opportunityDetails (Optional) Details about the opportunity for future estimation logic.
     * @returns {Promise<{ gasEstimate: bigint, effectiveGasPrice: bigint, totalCostWei: bigint } | null>} Gas cost details or null on failure.
     */
    async estimateTxGasCost(opportunityDetails = {}) {
        const feeData = await this.getFeeData();
        if (!feeData) {
            logger.error("[GasEstimator] Failed to get fee data, cannot estimate cost.");
            return null;
        }

        const effectiveGasPrice = this.getEffectiveGasPrice(feeData);
        if (!effectiveGasPrice || effectiveGasPrice <= 0n) {
            logger.error("[GasEstimator] Failed to determine a valid effective gas price.");
             return null;
        }

        // --- Placeholder: Use Fallback Gas Limit ---
        // TODO: Replace this with provider.estimateGas(tx) using encoded data
        const gasLimitEstimate = this.fallbackGasLimit;
        logger.debug(`[GasEstimator] Using fallback gas limit: ${gasLimitEstimate}`);
        // --- End Placeholder ---

        if (gasLimitEstimate <= 0n) {
             logger.error("[GasEstimator] Invalid gas limit estimate.");
             return null;
        }

        const totalCostWei = gasLimitEstimate * effectiveGasPrice;
        logger.debug(`[GasEstimator] Estimated Cost: Limit=${gasLimitEstimate}, Price=${ethers.formatUnits(effectiveGasPrice, 'gwei')} Gwei, Total=${ethers.formatEther(totalCostWei)} ETH`);

        return {
            gasEstimate: gasLimitEstimate,
            effectiveGasPrice: effectiveGasPrice, // Price per gas unit in Wei
            totalCostWei: totalCostWei // Total cost in Wei
        };
    }
}

module.exports = GasEstimator;
