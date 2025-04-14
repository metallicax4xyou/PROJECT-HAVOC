// bot.js - Main Entry Point
require('dotenv').config(); // Load .env file first
const logger = require('./utils/logger');
const config = require('./config/index.js'); // Ensure config is loaded early
const { handleError } = require('./utils/errorHandler');

// Core Components
const FlashSwapManager = require('./core/flashSwapManager');
const PoolScanner = require('./core/poolScanner');
const ProfitCalculator = require('./core/profitCalculator');
const TxExecutor = require('./core/txExecutor');
const ArbitrageEngine = require('./core/arbitrageEngine'); // Correct import for direct export

// Utilities (GasEstimator might be used by ProfitCalculator or TxExecutor)
const GasEstimator = require('./utils/gasEstimator');
const NonceManager = require('./utils/nonceManager'); // Likely managed within FlashSwapManager or TxExecutor now

async function main() {
    logger.info(`>>> PROJECT HAVOC ARBITRAGE BOT STARTING <<<`);
    logger.info(`==============================================`);

    try {
        // 1. Initialize FlashSwapManager (handles provider, signer, core contracts, nonce manager)
        const flashSwapManager = new FlashSwapManager();
        await flashSwapManager.initialize(); // Must await initialization

        // --->>> Instantiate Dependencies <<<---
        // These might need the initialized flashSwapManager components (provider, signer, etc.)

        // Get components from flashSwapManager AFTER it's initialized
        const provider = flashSwapManager.getProvider();
        const signer = flashSwapManager.getSigner();
        const flashSwapContract = flashSwapManager.getFlashSwapContract();
        const nonceManager = flashSwapManager.getNonceManager(); // Get the initialized nonce manager

        // Initialize other components, passing necessary dependencies
        const gasEstimator = new GasEstimator(provider); // Pass provider
        const poolScanner = new PoolScanner(provider); // Pass provider
        const profitCalculator = new ProfitCalculator(gasEstimator); // Pass gas estimator
        const txExecutor = new TxExecutor(flashSwapManager, nonceManager, gasEstimator); // Pass manager, nonceManager, gasEstimator

        // --->>> Instantiate ArbitrageEngine with ALL dependencies <<<---
        const engine = new ArbitrageEngine(
            flashSwapManager, // Pass the initialized manager instance
            poolScanner,      // Pass the initialized scanner instance
            profitCalculator, // Pass the initialized calculator instance
            txExecutor        // Pass the initialized executor instance
        );

        // 2. Start the Engine's Monitoring Loop
        await engine.startMonitoring();

        // 3. Graceful Shutdown Handling
        process.on('SIGINT', async () => {
            logger.info('SIGINT received. Shutting down gracefully...');
            await engine.shutdown(); // Call engine's shutdown method
            process.exit(0);
        });

        process.on('SIGTERM', async () => {
            logger.info('SIGTERM received. Shutting down gracefully...');
            await engine.shutdown(); // Call engine's shutdown method
            process.exit(0);
        });

        process.on('uncaughtException', async (error) => {
            logger.fatal('!!! UNCAUGHT EXCEPTION !!! Shutting down...', error);
            handleError(error, 'UncaughtException');
            // Attempt graceful shutdown if possible, otherwise force exit
            try {
                 if (engine && engine.isMonitoring) {
                      await engine.shutdown();
                 }
            } catch (shutdownError) {
                 logger.error('Error during emergency shutdown:', shutdownError);
            }
            process.exit(1); // Exit with error code
        });

        process.on('unhandledRejection', async (reason, promise) => {
             logger.error('!!! UNHANDLED REJECTION !!!', { reason });
             handleError(reason instanceof Error ? reason : new Error(String(reason)), 'UnhandledRejection');
             // Optional: Add shutdown logic here too? Might depend on the rejection reason.
             // process.exit(1); // Consider if this should be fatal
        });


    } catch (error) {
        logger.fatal('Error during bot initialization or startup:', error);
        handleError(error, 'BotInitialization');
        process.exit(1); // Exit if initialization fails
    }
}

// Execute main function
main().catch((error) => {
    // This catch is for errors thrown directly from main() before async error handlers are set up
    logger.fatal('Critical error executing main function:', error);
    process.exit(1);
});
