// utils/gasEstimator.js
const { ethers } = require('ethers');
const logger = require('./logger');
const { ArbitrageError } = require('./errorHandler');

class GasEstimator {
    /**
     * @param {object} config The main configuration object (needs GAS_COST_ESTIMATES, MAX_GAS_GWEI, etc.)
     * @param {ethers.Provider} provider Ethers provider instance
     */
    constructor(config, provider) {
        logger.debug('[GasEstimator] Initializing...');
        if (!config) throw new ArbitrageError('GasEstimatorInit', 'Config object required.');
        if (!provider) throw new ArbitrageError('GasEstimatorInit', 'Provider instance required.');
        if (!config.GAS_COST_ESTIMATES || !config.GAS_COST_ESTIMATES.FLASH_SWAP_BASE) {
            throw new ArbitrageError('GasEstimatorInit', 'Valid GAS_COST_ESTIMATES missing in config.');
        }

        this.config = config;
        this.provider = provider;
        this.gasEstimates = config.GAS_COST_ESTIMATES; // Store the estimates object
        this.maxGasPriceGwei = ethers.parseUnits(String(config.MAX_GAS_GWEI || 10), 'gwei');

        logger.info(`[GasEstimator] Initialized. Base Cost: ${this.gasEstimates.FLASH_SWAP_BASE}, Max Gas Price: ${ethers.formatUnits(this.maxGasPriceGwei, 'gwei')} Gwei`);
    }

    async getFeeData() { /* ... unchanged ... */
        try {
            const feeData = await this.provider.getFeeData();
            if (!feeData || (!feeData.gasPrice && (!feeData.maxFeePerGas || !feeData.maxPriorityFeePerGas))) { logger.warn('[GasEstimator] Incomplete fee data.'); return null; }
            return feeData;
        } catch (error) { logger.error(`[GasEstimator] Error fetching fee data: ${error.message}`); return null; }
    }

    getEffectiveGasPrice(feeData) { /* ... unchanged ... */
        if (!feeData) return null; let effectiveGasPrice = null;
        if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) { effectiveGasPrice = feeData.maxFeePerGas; logger.debug(`[GasEstimator] Using EIP-1559 maxFeePerGas: ${ethers.formatUnits(effectiveGasPrice, 'gwei')} Gwei`); }
        else if (feeData.gasPrice) { effectiveGasPrice = feeData.gasPrice; logger.debug(`[GasEstimator] Using legacy gasPrice: ${ethers.formatUnits(effectiveGasPrice, 'gwei')} Gwei`); }
        else { logger.warn('[GasEstimator] Cannot determine base gas price.'); return null; }
        if (effectiveGasPrice > this.maxGasPriceGwei) { logger.warn(`[GasEstimator] Gas price capped to MAX_GAS_GWEI.`); effectiveGasPrice = this.maxGasPriceGwei; }
        return effectiveGasPrice;
    }

    /**
     * Estimates the gas cost for a transaction using per-hop estimates from config.
     * @param {object} opportunity The opportunity object (needs path with dex types).
     * @returns {Promise<{ gasEstimate: bigint, effectiveGasPrice: bigint, totalCostWei: bigint } | null>} Gas cost details or null on failure.
     */
    async estimateTxGasCost(opportunity) { // Renamed from estimateTxGasCost for clarity maybe? Let's keep estimateTxGasCost.
        const logPrefix = `[GasEstimator Opp ${opportunity?.pairKey}]`;
        const feeData = await this.getFeeData();
        if (!feeData) { logger.error(`${logPrefix} Failed to get fee data.`); return null; }

        const effectiveGasPrice = this.getEffectiveGasPrice(feeData);
        if (!effectiveGasPrice || effectiveGasPrice <= 0n) { logger.error(`${logPrefix} Failed to get valid gas price.`); return null; }

        // --- Calculate Gas Limit based on Path ---
        let totalGasLimit = this.gasEstimates.FLASH_SWAP_BASE; // Start with base cost
        if (!opportunity?.path || !Array.isArray(opportunity.path)) {
             logger.warn(`${logPrefix} Opportunity path missing or invalid, using only base gas cost.`);
        } else {
             logger.debug(`${logPrefix} Calculating gas for path: ${opportunity.path.map(p=>p.dex).join('->')}`);
             for (const step of opportunity.path) {
                 let hopCost = 0n;
                 switch (step.dex?.toLowerCase()) { // Use lowercase for safety
                     case 'uniswapv3': hopCost = this.gasEstimates.UNISWAP_V3_SWAP; break;
                     case 'sushiswap': hopCost = this.gasEstimates.SUSHISWAP_V2_SWAP; break;
                     case 'dodo':      hopCost = this.gasEstimates.DODO_SWAP; break;
                     // Add cases for other DEXs
                     default: logger.warn(`${logPrefix} Unknown DEX type '${step.dex}' in path for gas estimation. Using 0.`);
                 }
                 if (!hopCost) { // Handle if estimate is missing in config
                     logger.warn(`${logPrefix} Gas estimate missing for DEX type '${step.dex}'. Using 0.`);
                     hopCost = 0n;
                 }
                 totalGasLimit += hopCost;
             }
        }
        // --- End Gas Limit Calculation ---

        // Add buffer percentage from config
         const bufferPercent = BigInt(this.config.GAS_ESTIMATE_BUFFER_PERCENT || 0); // Default 0 if missing
         if (bufferPercent > 0n) {
             const bufferAmount = (totalGasLimit * bufferPercent) / 100n;
             totalGasLimit += bufferAmount;
             logger.debug(`${logPrefix} Applied ${bufferPercent}% gas buffer. New Limit: ${totalGasLimit}`);
         }


        if (totalGasLimit <= 0n) { logger.error(`${logPrefix} Calculated gas limit is zero or negative.`); return null; }

        const totalCostWei = totalGasLimit * effectiveGasPrice;
        logger.debug(`${logPrefix} Estimated Gas: Limit=${totalGasLimit}, Price=${ethers.formatUnits(effectiveGasPrice, 'gwei')} Gwei, Total Cost=${ethers.formatEther(totalCostWei)} ETH`);

        return {
            gasEstimate: totalGasLimit,
            effectiveGasPrice: effectiveGasPrice,
            totalCostWei: totalCostWei
        };
    }
}

module.exports = GasEstimator;
