// utils/gasEstimator.js
// --- VERSION v1.2.2 ---
// Corrected estimateTxGasCost signature to accept signerAddress.

const { ethers } = require('ethers');
const logger = require('./logger');
const { ArbitrageError } = require('./errorHandler');
const { encodeInitiateFlashSwapData } = require('../core/tx/encoder');

class GasEstimator {
    constructor(config, provider) {
        logger.debug('[GasEstimator] Initializing...');
        if (!config) throw new ArbitrageError('GasEstimatorInit', 'Config required.');
        if (!provider) throw new ArbitrageError('GasEstimatorInit', 'Provider required.');
        if (!config.GAS_COST_ESTIMATES?.FLASH_SWAP_BASE) logger.warn('[GasEstimatorInit] GAS_COST_ESTIMATES missing/incomplete.');

        this.config = config;
        this.provider = provider;
        this.gasEstimates = config.GAS_COST_ESTIMATES || {};
        this.maxGasPriceGwei = ethers.parseUnits(String(config.MAX_GAS_GWEI || 1), 'gwei');
        this.fallbackGasLimit = BigInt(config.FALLBACK_GAS_LIMIT || 3000000);

        logger.info(`[GasEstimator v1.2.2] Initialized. Max Gas Price: ${ethers.formatUnits(this.maxGasPriceGwei, 'gwei')} Gwei, Fallback Limit: ${this.fallbackGasLimit}`);
    }

    async getFeeData() { /* ... unchanged ... */ }
    getEffectiveGasPrice(feeData) { /* ... unchanged ... */ }

    /**
     * Estimates the gas cost for a flash swap transaction using provider.estimateGas.
     * @param {object} opportunity The opportunity object.
     * @param {string} signerAddress The address of the bot's signer wallet. <<-- ADDED PARAMETER
     * @returns {Promise<{ gasEstimate: bigint, effectiveGasPrice: bigint, totalCostWei: bigint } | null>}
     */
    async estimateTxGasCost(opportunity, signerAddress) { // *** FIXED: Added signerAddress parameter ***
        const logPrefix = `[GasEstimator Opp ${opportunity?.pairKey}]`;
        // Now signerAddress comes from the function argument
        logger.debug(`${logPrefix} Starting gas estimation for sender ${signerAddress}...`);

        // Validate signerAddress received as parameter
        if (!signerAddress || !ethers.isAddress(signerAddress)) {
            logger.error(`${logPrefix} Invalid signerAddress received: ${signerAddress}`);
            return null;
        }

        const feeData = await this.getFeeData();
        if (!feeData) { logger.error(`${logPrefix} Failed fee data fetch.`); return null; }
        const effectiveGasPrice = this.getEffectiveGasPrice(feeData);
        if (!effectiveGasPrice || effectiveGasPrice <= 0n) { logger.error(`${logPrefix} Failed effective gas price.`); return null; }
        logger.debug(`${logPrefix} Effective Gas Price: ${ethers.formatUnits(effectiveGasPrice, 'gwei')} Gwei`);

        logger.debug(`${logPrefix} Encoding initiateFlashSwap data...`);
        let encodedData = null;
        try {
            if (typeof encodeInitiateFlashSwapData !== 'function') throw new Error("Encoder fn missing.");
            encodedData = encodeInitiateFlashSwapData(opportunity, this.config);
        } catch (encodingError) {
            logger.error(`${logPrefix} Encoding failed: ${encodingError.message}. Using fallback.`, encodingError);
            const totalCostWeiFallback = this.fallbackGasLimit * effectiveGasPrice;
             return { gasEstimate: this.fallbackGasLimit, effectiveGasPrice, totalCostWei: totalCostWeiFallback };
        }
        if (!encodedData) { logger.warn(`${logPrefix} Encoding returned null.`); return null; }

        let gasLimitEstimate = null;
        try {
            logger.debug(`${logPrefix} Estimating gas via provider.estimateGas (From: ${signerAddress}, To: ${this.config.FLASH_SWAP_CONTRACT_ADDRESS})...`);
            const txParams = { to: this.config.FLASH_SWAP_CONTRACT_ADDRESS, data: encodedData, from: signerAddress }; // Use parameter
            // logger.debug(`${logPrefix} estimateGas params:`, { to: txParams.to, from: txParams.from, data: txParams.data.substring(0, 42) + '...' });
            const estimatedGas = await this.provider.estimateGas(txParams);
            gasLimitEstimate = BigInt(estimatedGas.toString());
            logger.debug(`${logPrefix} Raw Gas Estimate from Provider: ${gasLimitEstimate}`);

            const bufferPercent = BigInt(this.config.GAS_ESTIMATE_BUFFER_PERCENT || 0);
            if (bufferPercent > 0n && gasLimitEstimate > 0n) { const bufferAmount = (gasLimitEstimate * bufferPercent) / 100n; gasLimitEstimate += bufferAmount; logger.debug(`${logPrefix} Applied ${bufferPercent}% buffer. Final Estimate: ${gasLimitEstimate}`); }
            else if (gasLimitEstimate <= 0n) { logger.warn(`${logPrefix} Raw estimate zero/negative. Using fallback.`); gasLimitEstimate = this.fallbackGasLimit; }

        } catch (error) {
             if (error.code === 'UNPREDICTABLE_GAS_LIMIT' || (error.message && (error.message.includes("reverted") || error.message.includes("execution failed")) )) { let reason = error.reason; if (!reason && error.data && error.data !== '0x') { try { reason = ethers.utils.toUtf8String(error.data); } catch {} } logger.warn(`${logPrefix} Gas estimate failed (TX reverts): ${reason || error.code || error.message}. Opp invalid.`); return null; }
             else { logger.error(`${logPrefix} Unexpected gas estimation error: ${error.message}. Using fallback.`, error); gasLimitEstimate = this.fallbackGasLimit; }
        }

        if (!gasLimitEstimate || gasLimitEstimate <= 0n) { logger.error(`${logPrefix} Final gas limit estimate invalid.`); return null; }
        const totalCostWei = gasLimitEstimate * effectiveGasPrice;
        logger.info(`${logPrefix} Final Estimated Gas: Limit=${gasLimitEstimate}, Price=${ethers.formatUnits(effectiveGasPrice, 'gwei')} Gwei, Total Cost=${ethers.formatEther(totalCostWei)} ETH`);

        return { gasEstimate: gasLimitEstimate, effectiveGasPrice: effectiveGasPrice, totalCostWei: totalCostWei };
    }
}

module.exports = GasEstimator;
