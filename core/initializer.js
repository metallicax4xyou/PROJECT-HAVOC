// core/initializer.js
// Handles the initialization sequence for bot components

const { ethers } = require('ethers'); // Might be needed if Provider is initialized here
const config = require('../config'); // Needs config
const { getProvider } = require('../utils/provider'); // Needs provider utility
const logger = require('../utils/logger'); // Needs logger
const { ArbitrageError } = require('../utils/errorHandler'); // Needs error types

// Import component Classes needed for initialization
const ArbitrageEngine = require('./arbitrageEngine');
const SwapSimulator = require('./swapSimulator');
const GasEstimator = require('../utils/gasEstimator'); // Pass CLASS
const FlashSwapManager = require('./flashSwapManager');
const TradeHandler = require('./tradeHandler'); // Pass CLASS

/**
 * Initializes all necessary bot components and returns the ArbitrageEngine instance.
 * @param {object} appConfig - The application configuration object.
 * @returns {Promise<{arbitrageEngine: ArbitrageEngine, flashSwapManager: FlashSwapManager}>} - Returns the initialized engine and FSM instance.
 * @throws {ArbitrageError} - Throws an error if initialization fails.
 */
async function initializeBot(appConfig) {
    logger.info('[Initializer] Starting bot initialization sequence...');

    let provider;
    let flashSwapManagerInstance; // Need this instance for potential NonceManager cleanup in main bot.js

    try {
        // Step 1: Get Provider instance
        logger.info('[Initializer] Step 1: Getting Provider instance...');
        provider = getProvider(appConfig);
        logger.debug('[Initializer] Step 1a: Provider instance obtained. Fetching network...');

        const network = await provider.getNetwork();
        logger.info(`[Initializer] Step 1b: Provider connected to ${network.name} (ID: ${network.chainId})`);
        const currentBlock = await provider.getBlockNumber();
        logger.info(`[Initializer] Provider Current Block: ${currentBlock}`);

        // Step 2: Initializing Swap Simulator
        logger.info('[Initializer] Step 2: Initializing Swap Simulator...');
        logger.debug('[Initializer] Step 2a: Calling SwapSimulator constructor...');
        const swapSimulator = new SwapSimulator(appConfig, provider);
        logger.debug('[Initializer] Step 2b: SwapSimulator constructor returned.');
         if (!swapSimulator?.simulateSwap) {
              const errorMsg = 'Swap Simulator failed to initialize correctly.';
              logger.error(`[Initializer] CRITICAL: ${errorMsg}`);
              throw new ArbitrageError('InitializationError', errorMsg);
         }
        logger.info('[Initializer] Step 2: Swap Simulator initialized.');


        // Step 3: Initializing Flash Swap Manager
        logger.info('[Initializer] Step 3: Initializing Flash Swap Manager...');
        logger.debug('[Initializer] Step 3a: Calling FlashSwapManager constructor...');
        flashSwapManagerInstance = new FlashSwapManager(appConfig, provider); // Needs config and provider
        logger.debug('[Initializer] Step 3b: FlashSwapManager constructor returned.');
         // Basic checks + need getFlashSwapABI for GasEstimator initialization later in AE
         if (!(flashSwapManagerInstance?.getFlashSwapContract && flashSwapManagerInstance?.getSignerAddress && flashSwapManagerInstance?.getFlashSwapABI)) {
             const errorMsg = 'Flash Swap Manager failed to initialize correctly or is missing necessary methods.';
              logger.error(`[Initializer] CRITICAL: ${errorMsg}`);
              throw new ArbitrageError('InitializationError', errorMsg);
         }
        logger.debug('[Initializer] Step 3c: Instance validity check passed.');
        logger.info(`[Initializer] Step 3: Flash Swap Manager initialized. Signer: ${await flashSwapManagerInstance.getSignerAddress()}`);
         logger.info(`[Initializer] Using FlashSwap contract at: ${flashSwapManagerInstance.getFlashSwapContract()?.address || 'N/A'}`);

        // Step 4: Initializing Arbitrage Engine
        logger.info('[Initializer] Step 4: Initializing Arbitrage Engine...');
        logger.debug('[Initializer] Step 4a: Validating dependencies before passing to AE...');
         const isFsmValidForAE = flashSwapManagerInstance && typeof flashSwapManagerInstance.getSignerAddress === 'function' && typeof flashSwapManagerInstance.getFlashSwapABI === 'function';
         if (!isFsmValidForAE) { // Re-check validity just before AE init
             const errorMsg = 'FlashSwapManager instance is invalid for ArbitrageEngine initialization (pre-check failed).';
             logger.error(`[Initializer] CRITICAL: ${errorMsg}`);
             throw new ArbitrageError('InitializationError', errorMsg);
         }
        logger.debug('[Initializer] Step 4b: Calling ArbitrageEngine constructor...');

        const arbitrageEngine = new ArbitrageEngine(
            appConfig,
            provider,
            swapSimulator,
            GasEstimator, // Pass the GasEstimator CLASS here
            flashSwapManagerInstance, // Pass the FlashSwapManager instance
            TradeHandler // Pass the TradeHandler CLASS here
        );
        logger.debug('[Initializer] Step 4c: ArbitrageEngine constructor returned.');
         if (!(arbitrageEngine?.start && arbitrageEngine?.stop && arbitrageEngine?.runCycle)) { // Basic checks
              const errorMsg = 'Arbitrage Engine failed to initialize correctly.';
              logger.error(`[Initializer] CRITICAL: ${errorMsg}`);
              throw new ArbitrageError('InitializationError', errorMsg);
         }
        logger.info('[Initializer] Step 4: Arbitrage Engine initialized.');

        // Initialization complete. Return the main components.
        logger.info('[Initializer] Bot components initialized successfully.');
        return { arbitrageEngine, flashSwapManager: flashSwapManagerInstance };

    } catch (error) {
        logger.error('[Initializer] Error during initialization sequence:', error);
        // Re-throw the error so bot.js can catch, handle, and exit.
        throw error;
    }
}

module.exports = {
    initializeBot
};
