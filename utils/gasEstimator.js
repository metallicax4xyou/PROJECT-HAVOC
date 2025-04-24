// utils/gasEstimator.js
// --- VERSION v1.4 ---
// Uses path-based estimation primarily.
// Uses provider.estimateGas only as a dry-run validity check.

const { ethers } = require('ethers');
const logger = require('./logger');
const { ArbitrageError } = require('./errorHandler');
const { encodeInitiateFlashSwapData } = require('../core/tx/encoder');

class GasEstimator {
    constructor(config, provider) {
        logger.debug('[GasEstimator] Initializing...');
        if (!config || !provider) throw new ArbitrageError('GasEstimatorInit', 'Config/Provider required.');
        if (!config.GAS_COST_ESTIMATES?.FLASH_SWAP_BASE) logger.warn('[GasEstInit] GAS_COST_ESTIMATES incomplete.');

        this.config = config;
        this.provider = provider;
        this.gasEstimates = config.GAS_COST_ESTIMATES || {};
        this.maxGasPriceGwei = ethers.parseUnits(String(config.MAX_GAS_GWEI || 1), 'gwei');
        // Fallback limit isn't the primary estimate anymore, but used if base cost is missing
        this.fallbackGasLimit = BigInt(config.FALLBACK_GAS_LIMIT || 3000000);

        logger.info(`[GasEstimator v1.4] Initialized. Path-based est + estimateGas check. Max Gas Price: ${ethers.formatUnits(this.maxGasPriceGwei, 'gwei')} Gwei`);
    }

    async getFeeData() { /* ... unchanged ... */ }
    getEffectiveGasPrice(feeData) { /* ... unchanged ... */ }

    /**
     * Estimates gas cost using path-based heuristics & performs an estimateGas check.
     * @param {object} opportunity The opportunity object.
     * @param {string} signerAddress The address of the bot's signer wallet.
     * @returns {Promise<{ pathGasLimit: bigint, effectiveGasPrice: bigint, totalCostWei: bigint, estimateGasSuccess: boolean } | null>}
     *          Returns null if basic checks fail or gas price fetch fails.
     *          estimateGasSuccess indicates if provider.estimateGas succeeded (meaning TX likely doesn't revert immediately).
     */
    async estimateTxGasCost(opportunity, signerAddress) {
        const logPrefix = `[GasEstimator Opp ${opportunity?.pairKey}]`;
        logger.debug(`${logPrefix} Starting path-based gas estimation & validity check...`);
        if (!signerAddress || !ethers.isAddress(signerAddress)) { logger.error(`${logPrefix} Invalid signerAddress.`); return null; }

        // --- 1. Get Gas Price ---
        const feeData = await this.getFeeData();
        const effectiveGasPrice = this.getEffectiveGasPrice(feeData);
        if (!effectiveGasPrice) { logger.error(`${logPrefix} Failed effective gas price.`); return null; }
        logger.debug(`${logPrefix} Effective Gas Price: ${ethers.formatUnits(effectiveGasPrice, 'gwei')} Gwei`);

        // --- 2. Calculate Path-Based Gas Limit ---
        let pathGasLimit = this.gasEstimates.FLASH_SWAP_BASE || this.fallbackGasLimit; // Start with base cost or fallback
        if (!opportunity?.path) {
            logger.warn(`${logPrefix} Opp path missing, using only base cost: ${pathGasLimit}`);
        } else {
            logger.debug(`${logPrefix} Calculating path gas: ${opportunity.path.map(p=>p.dex).join('->')}`);
            for (const step of opportunity.path) {
                 let hopCost = 0n;
                 switch (step.dex?.toLowerCase()) {
                     case 'uniswapv3': hopCost = this.gasEstimates.UNISWAP_V3_SWAP; break;
                     case 'sushiswap': hopCost = this.gasEstimates.SUSHISWAP_V2_SWAP; break;
                     case 'dodo':      hopCost = this.gasEstimates.DODO_SWAP; break;
                     default: logger.warn(`${logPrefix} Unknown DEX '${step.dex}' in path.`);
                 }
                 if (!hopCost) { logger.warn(`${logPrefix} Gas estimate missing for DEX '${step.dex}'. Using 0.`); hopCost = 0n; }
                 pathGasLimit += hopCost;
             }
             // Apply Buffer
             const bufferPercent = BigInt(this.config.GAS_ESTIMATE_BUFFER_PERCENT || 0);
             if (bufferPercent > 0n) { pathGasLimit += (pathGasLimit * bufferPercent) / 100n; }
             logger.debug(`${logPrefix} Path-based limit (+buffer): ${pathGasLimit}`);
        }
        if (pathGasLimit <= 0n) { logger.error(`${logPrefix} Invalid path-based limit: ${pathGasLimit}`); return null; }

        // --- 3. Encode TX Data (using minimal amount for validity check) ---
        logger.debug(`${logPrefix} Encoding data for estimateGas check...`);
        let encodedData = null;
        try {
             if (typeof encodeInitiateFlashSwapData !== 'function') throw new Error("Encoder missing.");
             encodedData = encodeInitiateFlashSwapData(opportunity, this.config); // Uses minimal amount inside
        } catch (e) { logger.error(`${logPrefix} Encoding failed: ${e.message}`); /* Handled below */ }

        if (!encodedData) {
             logger.warn(`${logPrefix} Encoding failed. Cannot perform estimateGas check. Assuming path invalid.`);
             return { pathGasLimit, effectiveGasPrice, totalCostWei: pathGasLimit * effectiveGasPrice, estimateGasSuccess: false }; // Return path cost but flag failure
        }

        // --- 4. Perform estimateGas as a Validity Check ---
        let estimateGasSuccess = false;
        try {
            logger.debug(`${logPrefix} Performing estimateGas validity check...`);
            await this.provider.estimateGas({ // We don't need the value, just whether it reverts
                to: this.config.FLASH_SWAP_CONTRACT_ADDRESS,
                data: encodedData,
                from: signerAddress
            });
            estimateGasSuccess = true; // If it doesn't throw, the path is likely valid
            logger.debug(`${logPrefix} estimateGas check PASSED.`);
        } catch (error) {
             let reason = error.reason || error.code || error.message;
             logger.warn(`${logPrefix} estimateGas check FAILED (TX likely reverts): ${reason}. Marking opportunity invalid.`);
             estimateGasSuccess = false; // Explicitly false on failure
        }

        // --- 5. Calculate Final Cost using Path-Based Estimate ---
        const totalCostWei = pathGasLimit * effectiveGasPrice;
        logger.info(`${logPrefix} Final Estimated Gas: PathLimit=${pathGasLimit}, Price=${ethers.formatUnits(effectiveGasPrice, 'gwei')} Gwei, Cost=${ethers.formatEther(totalCostWei)} ETH. estimateGas check: ${estimateGasSuccess ? 'OK' : 'FAIL'}`);

        return {
            pathGasLimit: pathGasLimit, // The limit we'll actually use if profitable
            effectiveGasPrice: effectiveGasPrice,
            totalCostWei: totalCostWei,
            estimateGasSuccess: estimateGasSuccess // Flag indicating if the basic check passed
        };
    }
}

module.exports = GasEstimator;
