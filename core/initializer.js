// core/initializer.js
// Handles the initialization sequence for bot components
// --- VERSION v1.2 --- Corrected NonceManager initialization to pass only the signer instance.

const { ethers } = require('ethers');
const config = require('../config');
const { getProvider } = require('../utils/provider');
const logger = require('../utils/logger');
const { ArbitrageError } = require('../utils/errorHandler');

// Import component Classes needed for initialization
const ArbitrageEngine = require('./arbitrageEngine');
const SwapSimulator = require('./swapSimulator');
const GasEstimator = require('../utils/gasEstimator'); // Needs FlashSwap ABI from FSM
const FlashSwapManager = require('./flashSwapManager'); // Needs signer
const TradeHandler = require('./tradeHandler'); // AE will create an instance of this CLASS
// Import NonceManager Class
const NonceManager = require('../utils/nonceManager'); // <-- NEW IMPORT


/**
 * Initializes all necessary bot components and returns the ArbitrageEngine instance.
 * @param {object} appConfig - The application configuration object.
 * @returns {Promise<{arbitrageEngine: ArbitrageEngine, flashSwapManager: FlashSwapManager, nonceManager: NonceManager}>} - Returns initialized components.
 * @throws {ArbitrageError} - Throws an error if initialization fails.
 */
async function initializeBot(appConfig) {
    logger.info('[Initializer v1.2] Starting bot initialization sequence...'); // Version bump

    let provider;
    let flashSwapManagerInstance;
    let nonceManagerInstance;
    let swapSimulatorInstance;
    let gasEstimatorInstance;


    try {
        // Step 1: Get Provider instance
        logger.info('[Initializer v1.2] Step 1: Getting Provider instance...'); // Version bump
        provider = getProvider(appConfig);
        logger.debug('[Initializer v1.2] Step 1a: Provider instance obtained. Fetching network...'); // Version bump

        const network = await provider.getNetwork();
        logger.info(`[Initializer v1.2] Step 1b: Provider connected to ${network.name} (ID: ${network.chainId})`); // Version bump
        const currentBlock = await provider.getBlockNumber();
        logger.info(`[Initializer v1.2] Provider Current Block: ${currentBlock}`); // Version bump


        // Step 2: Initializing Swap Simulator
        logger.info('[Initializer v1.2] Step 2: Initializing Swap Simulator...'); // Version bump
        swapSimulatorInstance = new SwapSimulator(appConfig, provider);
         if (typeof swapSimulatorInstance.simulateSwap !== 'function') { // Basic check
              const errorMsg = 'Swap Simulator failed to initialize correctly or is missing simulateSwap method.';
              logger.error(`[Initializer v1.2] CRITICAL: ${errorMsg}`); // Version bump
              throw new ArbitrageError('InitializationError', errorMsg);
         }
        logger.info('[Initializer v1.2] Step 2: Swap Simulator initialized.'); // Version bump


        // Step 3: Initializing Flash Swap Manager (Needs config, provider)
        // FSM should internally handle signer creation (using provider and PK from config)
        logger.info('[Initializer v1.2] Step 3: Initializing Flash Swap Manager...'); // Version bump
        flashSwapManagerInstance = new FlashSwapManager(appConfig, provider);
         // Basic checks + need getFlashSwapABI for GasEstimator and signer for NonceManager
         if (typeof flashSwapManagerInstance.getFlashSwapContract !== 'function' || typeof flashSwapManagerInstance.getSignerAddress !== 'function' || typeof flashSwapManagerInstance.getFlashSwapABI !== 'function' || !flashSwapManagerInstance.signer) {
             const errorMsg = 'Flash Swap Manager failed to initialize correctly or is missing necessary properties/methods.';
              logger.error(`[Initializer v1.2] CRITICAL: ${errorMsg}`); // Version bump
              throw new ArbitrageError('InitializationError', errorMsg);
         }
        logger.info(`[Initializer v1.2] Step 3: Flash Swap Manager initialized. Signer: ${await flashSwapManagerInstance.getSignerAddress()}`); // Version bump
         logger.info(`[Initializer v1.2] Using FlashSwap contract at: ${flashSwapManagerInstance.getFlashSwapContract()?.target || 'N/A'}`); // Version bump


        // Step 4: Initializing Nonce Manager (Needs the signer from FSM)
        logger.info('[Initializer v1.2] Step 4: Initializing Nonce Manager...'); // Version bump
        const signer = flashSwapManagerInstance.signer; // Get signer instance from FSM
        // --- CORRECTED NonceManager Initialization ---
        // NonceManager only expects the signer instance, not config or provider separately.
        // It gets the provider from the signer itself (super(signer.provider)).
        nonceManagerInstance = new NonceManager(signer); // <-- Pass ONLY the signer
        // --- END CORRECTION ---

         // Basic check
         if (typeof nonceManagerInstance.sendTransaction !== 'function' || typeof nonceManagerInstance.getAddress !== 'function') {
             const errorMsg = 'Nonce Manager failed to initialize correctly or is missing necessary methods.';
              logger.error(`[Initializer v1.2] CRITICAL: ${errorMsg}`); // Version bump
              throw new ArbitrageError('InitializationError', errorMsg);
         }
        // No need to call .init() here, NonceManager does lazy initialization or resync on first getNextNonce
        // await nonceManagerInstance.init(); // Removed - NonceManager handles its own initialization/resync
        logger.info('[Initializer v1.2] Step 4: Nonce Manager initialized.'); // Version bump


         // Step 5: Initializing Gas Estimator (Needs config, provider, and FlashSwap ABI from FSM)
         logger.info('[Initializer v1.2] Step 5: Initializing Gas Estimator...'); // Version bump
         const flashSwapABI = flashSwapManagerInstance.getFlashSwapABI(); // Get ABI from FSM
         if (!flashSwapABI) {
             const errorMsg = "Failed to get FlashSwap ABI from FlashSwapManager for GasEstimator.";
             logger.error(`[Initializer v1.2] CRITICAL: ${errorMsg}`); // Version bump
             throw new ArbitrageError('InitializationError', errorMsg);
         }
         gasEstimatorInstance = new GasEstimator(appConfig, provider, flashSwapABI); // <-- Initialize here
         // Basic check
          if (typeof gasEstimatorInstance.estimateTxGasCost !== 'function' || typeof gasEstimatorInstance.getFeeData !== 'function') {
              const errorMsg = 'Gas Estimator failed to initialize correctly or is missing necessary methods.';
               logger.error(`[Initializer v1.2] CRITICAL: ${errorMsg}`); // Version bump
               throw new ArbitrageError('InitializationError', errorMsg);
          }
         logger.info('[Initializer v1.2] Step 5: Gas Estimator initialized.'); // Version bump


        // Step 6: Initializing Arbitrage Engine with all necessary INSTANCES
        // AE needs INSTANCES of SwapSimulator, GasEstimator, FlashSwapManager, NONCEManager
        // It takes TradeHandler CLASS because AE creates the TradeHandler instance inside its constructor.
        logger.info('[Initializer v1.2] Step 6: Initializing Arbitrage Engine...'); // Version bump

        const arbitrageEngine = new ArbitrageEngine(
            appConfig,
            provider,
            swapSimulatorInstance, // Pass Instance
            gasEstimatorInstance, // Pass Instance
            flashSwapManagerInstance, // Pass Instance
            nonceManagerInstance, // <-- Pass NonceManager Instance
            TradeHandler // Pass TradeHandler CLASS
        );
         // Basic check
         if (typeof arbitrageEngine.start !== 'function' || typeof arbitrageEngine.stop !== 'function' || typeof arbitrageEngine.runCycle !== 'function') {
             const errorMsg = 'Arbitrage Engine failed to initialize correctly or is missing necessary methods.';
              logger.error(`[Initializer v1.2] CRITICAL: ${errorMsg}`); // Version bump
              throw new ArbitrageError('InitializationError', errorMsg);
         }
        logger.info('[Initializer v1.2] Step 6: Arbitrage Engine initialized.'); // Version bump

        // Initialization complete. Return the main components.
        logger.info('[Initializer v1.2] Bot components initialized successfully.'); // Version bump
        return { arbitrageEngine: arbitrageEngine, flashSwapManager: flashSwapManagerInstance, nonceManager: nonceManagerInstance };

    } catch (error) {
        logger.error('[Initializer v1.2] Error during initialization sequence:', error); // Version bump
        // Re-throw the error so bot.js can catch, handle, and exit.
        throw error;
    }
}

module.exports = {
    initializeBot
};
