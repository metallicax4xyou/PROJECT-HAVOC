// utils/gasEstimator.js
// --- VERSION v1.3 ---
// Added retry logic for getFeeData and fallback gas price.

const { ethers } = require('ethers');
const logger = require('./logger');
const { ArbitrageError } = require('./errorHandler');
const { encodeInitiateFlashSwapData } = require('../core/tx/encoder');
const { delay } = require('./networkUtils'); // Assuming delay function exists

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
        // *** ADD Fallback Gas Price Config ***
        this.fallbackGasPriceGwei = String(config.FALLBACK_GAS_PRICE_GWEI || 0.1); // Default 0.1 Gwei
        this.feeDataRetryDelayMs = 500; // Delay between retries for fee data
        this.feeDataRetries = 2; // Number of retries for fee data fetch

        logger.info(`[GasEstimator v1.3] Initialized. Max Gas Price: ${ethers.formatUnits(this.maxGasPriceGwei, 'gwei')} Gwei, Fallback Limit: ${this.fallbackGasLimit}, Fallback Price: ${this.fallbackGasPriceGwei} Gwei`);
    }

    /**
     * Fetches current network fee data with retries.
     * @returns {Promise<ethers.FeeData | null>}
     */
    async getFeeData() {
        for (let attempt = 1; attempt <= this.feeDataRetries + 1; attempt++) {
            try {
                logger.debug(`[GasEstimator] Fetching fee data (Attempt ${attempt})...`);
                const feeData = await this.provider.getFeeData();
                // Add stricter check for EIP-1559 fields if needed
                if (feeData && (feeData.gasPrice || (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas))) {
                    logger.debug(`[GasEstimator] Fee data fetched successfully on attempt ${attempt}.`);
                    return feeData;
                }
                logger.warn(`[GasEstimator] Incomplete fee data received on attempt ${attempt}.`);
                // Don't retry immediately if data is just incomplete, but log it. Fall through to retry logic if needed.

            } catch (error) {
                logger.warn(`[GasEstimator] Error fetching fee data (Attempt ${attempt}): ${error.message}`);
                if (attempt > this.feeDataRetries) {
                    logger.error(`[GasEstimator] Max retries reached for fetching fee data.`);
                    return null; // Failed after retries
                }
                await delay(this.feeDataRetryDelayMs); // Wait before retrying
            }
        }
        return null; // Should not be reached if retries > 0, but acts as failsafe
    }

    getEffectiveGasPrice(feeData) {
        let effectiveGasPrice = null;
        let priceSource = 'N/A';

        // Use fetched data if valid
        if (feeData) {
            if (feeData.maxFeePerGas) { // Prefer EIP-1559
                 effectiveGasPrice = feeData.maxFeePerGas;
                 priceSource = 'maxFeePerGas';
            } else if (feeData.gasPrice) { // Fallback to legacy
                 effectiveGasPrice = feeData.gasPrice;
                 priceSource = 'gasPrice';
            }
        }

        // If no valid price fetched after retries, use fallback from config
        if (!effectiveGasPrice || effectiveGasPrice <= 0n) {
             logger.warn(`[GasEstimator] Using fallback gas price: ${this.fallbackGasPriceGwei} Gwei`);
             effectiveGasPrice = ethers.parseUnits(this.fallbackGasPriceGwei, 'gwei');
             priceSource = 'fallback';
        }

        // Apply Max Gas Price Cap
        if (effectiveGasPrice > this.maxGasPriceGwei) {
            logger.warn(`[GasEstimator] Gas price ${ethers.formatUnits(effectiveGasPrice, 'gwei')} (${priceSource}) capped to MAX ${ethers.formatUnits(this.maxGasPriceGwei, 'gwei')}`);
            effectiveGasPrice = this.maxGasPriceGwei;
            priceSource += ' (capped)';
        }

         logger.debug(`[GasEstimator] Effective Gas Price: ${ethers.formatUnits(effectiveGasPrice, 'gwei')} Gwei (Source: ${priceSource})`);
         if (effectiveGasPrice <= 0n) return null; // Final check for validity
        return effectiveGasPrice;
    }

    /**
     * Estimates gas cost, using provider.estimateGas and robust fee data fetching.
     */
    async estimateTxGasCost(opportunity, signerAddress) {
        const logPrefix = `[GasEstimator Opp ${opportunity?.pairKey}]`;
        logger.debug(`${logPrefix} Starting gas estimation for sender ${signerAddress}...`);
        if (!signerAddress || !ethers.isAddress(signerAddress)) { logger.error(`${logPrefix} Invalid signerAddress.`); return null; }

        // --- 1. Get Effective Gas Price (with retries/fallback) ---
        const feeData = await this.getFeeData(); // Now includes retry logic
        const effectiveGasPrice = this.getEffectiveGasPrice(feeData); // Now includes fallback logic
        if (!effectiveGasPrice) { logger.error(`${logPrefix} Failed effective gas price after retries/fallback.`); return null; }

        // --- 2. Encode TX Data ---
        logger.debug(`${logPrefix} Encoding initiateFlashSwap data...`); let encodedData = null;
        try { if (typeof encodeInitiateFlashSwapData !== 'function') throw new Error("Encoder missing."); encodedData = encodeInitiateFlashSwapData(opportunity, this.config); }
        catch (encodingError) { logger.error(`${logPrefix} Encoding failed: ${encodingError.message}. Cannot estimate gas.`, encodingError); return null; } // Fail if encoding fails
        if (!encodedData) { logger.warn(`${logPrefix} Encoding returned null.`); return null; }

        // --- 3. Estimate Gas Limit ---
        let gasLimitEstimate = null;
        try {
            logger.debug(`${logPrefix} Estimating gas via provider.estimateGas (From: ${signerAddress}, To: ${this.config.FLASH_SWAP_CONTRACT_ADDRESS})...`);
            const txParams = { to: this.config.FLASH_SWAP_CONTRACT_ADDRESS, data: encodedData, from: signerAddress };
            const estimatedGas = await this.provider.estimateGas(txParams);
            gasLimitEstimate = BigInt(estimatedGas.toString()); logger.debug(`${logPrefix} Raw Estimate: ${gasLimitEstimate}`);
            const bufferPercent = BigInt(this.config.GAS_ESTIMATE_BUFFER_PERCENT || 0);
            if (bufferPercent > 0n && gasLimitEstimate > 0n) { const bufferAmount = (gasLimitEstimate * bufferPercent) / 100n; gasLimitEstimate += bufferAmount; logger.debug(`${logPrefix} Final Estimate (+${bufferPercent}%): ${gasLimitEstimate}`); }
            else if (gasLimitEstimate <= 0n) { logger.warn(`${logPrefix} Raw estimate zero/negative. Using fallback.`); gasLimitEstimate = this.fallbackGasLimit; }
        } catch (error) {
             if (error.code === 'UNPREDICTABLE_GAS_LIMIT' || (error.message && (error.message.includes("reverted") || error.message.includes("execution failed")) )) { let reason = error.reason; if (!reason && error.data && error.data !== '0x') { try { reason = ethers.utils.toUtf8String(error.data); } catch {}} logger.warn(`${logPrefix} Gas estimate failed (TX reverts): ${reason || error.code || error.message}. Opp invalid.`); return null; }
             else { logger.error(`${logPrefix} Unexpected gas estimate error: ${error.message}. Using fallback.`, error); gasLimitEstimate = this.fallbackGasLimit; }
        }

        // --- 4. Calculate Total Cost ---
        if (!gasLimitEstimate || gasLimitEstimate <= 0n) { logger.error(`${logPrefix} Final gas limit invalid.`); return null; }
        const totalCostWei = gasLimitEstimate * effectiveGasPrice;
        logger.info(`${logPrefix} Final Gas: Limit=${gasLimitEstimate}, Price=${ethers.formatUnits(effectiveGasPrice, 'gwei')} Gwei, Total Cost=${ethers.formatEther(totalCostWei)} ETH`);
        return { gasEstimate: gasLimitEstimate, effectiveGasPrice: effectiveGasPrice, totalCostWei: totalCostWei };
    }
}

module.exports = GasEstimator;
