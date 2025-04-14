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
const ArbitrageEngine = require('./core/arbitrageEngine');

// Utilities
// --->>> UPDATED IMPORT: Import the function, not a class <<<---
const { getSimpleGasParams } = require('./utils/gasEstimator');
// NonceManager is handled internally by FlashSwapManager

async function main() {
    logger.info(`>>> PROJECT HAVOC ARBITRAGE BOT STARTING <<<`);
    logger.info(`==============================================`);

    let engine = null; // Define engine here so it's accessible in catch/finally

    try {
        // 1. Initialize FlashSwapManager (handles provider, signer, core contracts, nonce manager)
        const flashSwapManager = new FlashSwapManager();
        await flashSwapManager.initialize(); // Must await initialization

        // --->>> Instantiate Dependencies <<<---

        // Get components from flashSwapManager AFTER it's initialized
        const provider = flashSwapManager.getProvider();
        const signer = flashSwapManager.getSigner();
        const flashSwapContract = flashSwapManager.getFlashSwapContract();
        const nonceManager = flashSwapManager.getNonceManager();

        // --->>> REMOVED instantiation of GasEstimator <<<---
        // const gasEstimator = new GasEstimator(provider); // THIS WAS WRONG

        // Initialize other components, passing necessary dependencies
        // Pass the provider instead of a GasEstimator instance.
        // They might need adjustments internally if they expected a specific GasEstimator API.
        const poolScanner = new PoolScanner(provider);
        // --->>> UPDATED: Pass provider to ProfitCalculator (assuming it needs it) <<<---
        const profitCalculator = new ProfitCalculator(provider, getSimpleGasParams); // Pass provider and the gas price function
        // --->>> UPDATED: Pass provider to TxExecutor (assuming it needs it) <<<---
        const txExecutor = new TxExecutor(flashSwapManager, nonceManager, provider, getSimpleGasParams); // Pass relevant components + provider + gas price function


        // --->>> Instantiate ArbitrageEngine with ALL dependencies <<<---
        engine = new ArbitrageEngine(
            flashSwapManager,
            poolScanner,
            profitCalculator,
            txExecutor
        );

        // 2. Start the Engine's Monitoring Loop
        await engine.startMonitoring();

        // 3. Graceful Shutdown Handling (remains the same)
        const shutdownHandler = async (signal) => {
            logger.info(`${signal} received. Shutting down gracefully...`);
            if (engine && typeof engine.shutdown === 'function') {
                await engine.shutdown();
            } else {
                logger.warn('Engine not available or shutdown method missing during signal handling.');
            }
            process.exit(0);
        };
        process.on('SIGINT', shutdownHandler.bind(null, 'SIGINT'));
        process.on('SIGTERM', shutdownHandler.bind(null, 'SIGTERM'));

        process.on('uncaughtException', async (error) => {
            logger.error('!!! UNCAUGHT EXCEPTION !!! Shutting down...', error);
            handleError(error, 'UncaughtException');
            try {
                 if (engine && typeof engine.shutdown === 'function') {
                      await engine.shutdown();
                 }
            } catch (shutdownError) {
                 logger.error('Error during emergency shutdown:', shutdownError);
            }
            process.exit(1);
        });

        process.on('unhandledRejection', async (reason, promise) => {
             logger.error('!!! UNHANDLED REJECTION !!!', { reason });
             handleError(reason instanceof Error ? reason : new Error(String(reason)), 'UnhandledRejection');
        });


    } catch (error) {
        logger.error('Error during bot initialization or startup:', error);
        handleError(error, 'BotInitialization');
        process.exit(1);
    }
}

// Execute main function (remains the same)
main().catch((error) => {
    logger.error('Critical error executing main function promise:', error);
    process.exit(1);
});
