// utils/gasEstimator.js
// --- VERSION v1.7 --- Adds missing ErrorHandler import.

const { ethers } = require('ethers');
const logger = require('./logger');
const { ArbitrageError } = require('./errorHandler'); // Existing import is fine
const ErrorHandler = require('./errorHandler'); // <<< ADD THIS IMPORT
// const TxParamBuilder = require('../core/tx/paramBuilder'); // Keep commented if using lazy require
const { ABIS } = require('../constants/abis'); // Need FlashSwap ABI for interface

// Ensure FlashSwap ABI is loaded for encoding function calls
let flashSwapInterface;
if (!ABIS.FlashSwap) {
    logger.error('[GasEstimator Init] CRITICAL: FlashSwap ABI not found in ABIS constant.');
    flashSwapInterface = null; // Mark as unavailable
} else {
    try {
        flashSwapInterface = new ethers.Interface(ABIS.FlashSwap);
    } catch (abiError) {
        logger.error('[GasEstimator Init] CRITICAL: Failed to create Interface from FlashSwap ABI.', abiError);
        flashSwapInterface = null;
    }
}


class GasEstimator {
    constructor(config, provider) {
        logger.debug('[GasEstimator v1.7] Initializing...'); // Update version log
        if (!config || !provider) throw new ArbitrageError('GasEstimatorInit', 'Config/Provider required.');
        if (!config.GAS_COST_ESTIMATES?.FLASH_SWAP_BASE) logger.warn('[GasEstInit] GAS_COST_ESTIMATES incomplete.');
        if (!flashSwapInterface) logger.error('[GasEstInit] FlashSwap Interface could not be initialized. estimateGas check will fail.');

        this.config = config;
        this.provider = provider;
        this.gasEstimates = config.GAS_COST_ESTIMATES || {};
        this.maxGasPriceGwei = ethers.parseUnits(String(config.MAX_GAS_GWEI || 1), 'gwei');
