// bot.js - Main Entry Point
require('dotenv').config();
const logger = require('./utils/logger');
const config = require('./config/index.js');
const { handleError } = require('./utils/errorHandler');

// Core Components / Functions
const FlashSwapManager = require('./core/flashSwapManager');
const { PoolScanner } = require('./core/poolScanner');
const { checkProfitability } = require('./core/profitCalculator');
// --->>> UPDATED IMPORT: Import the function <<<---
const { executeTransaction } = require('./core/txExecutor');
const ArbitrageEngine = require('./core/arbitrageEngine');

// Utilities
const { getSimpleGasParams } = require('./utils/gasEstimator');

async function main() {
    logger.info(`>>> PROJECT HAVOC ARBITRAGE BOT STARTING <<<`);
    logger.info(`==============================================`);

    let engine = null;

    try {
        // 1. Initialize FlashSwapManager
        const flashSwapManager = new FlashSwapManager();
        await flashSwapManager.initialize();

        // Get components from flashSwapManager
        const provider = flashSwapManager.getProvider();
        const signer = flashSwapManager.getSigner();
        const flashSwapContract = flashSwapManager.getFlashSwapContract();
        const nonceManager = flashSwapManager.getNonceManager();

        // 2. Initialize PoolScanner
        const poolScanner = new PoolScanner(config, provider);

        // --->>> REMOVED instantiation of TxExecutor <<<---
        // const txExecutor = new TxExecutor(flashSwapManager, nonceManager, provider, getSimpleGasParams); // THIS WAS WRONG

        // 3. Instantiate ArbitrageEngine
        // --->>> UPDATED: Pass executeTransaction function <<<---
        engine = new ArbitrageEngine(
            flashSwapManager,      // Pass manager instance
            poolScanner,           // Pass scanner instance
            checkProfitability,    // Pass profitability check function
            provider,              // Pass provider instance
            executeTransaction     // Pass the transaction execution function
        );

        // 4. Start the Engine's Monitoring Loop
        await engine.startMonitoring();

        // 5. Graceful Shutdown Handling (remains the same)
        const shutdownHandler = async (signal) => { /* ... */ };
        process.on('SIGINT', shutdownHandler.bind(null, 'SIGINT'));
        process.on('SIGTERM', shutdownHandler.bind(null, 'SIGTERM'));

        // Error Handling (remains the same)
        process.on('uncaughtException', async (error) => {
             logger.error('!!! UNCAUGHT EXCEPTION !!! Shutting down...', error);
             handleError(error, 'UncaughtException');
             try { if (engine && typeof engine.shutdown === 'function') await engine.shutdown(); }
             catch (shutdownError) { logger.error('Error during emergency shutdown:', shutdownError); }
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

// Simplified shutdown handler for copy-paste
const shutdownHandler = async (signal) => {
    logger.info(`${signal} received. Shutting down gracefully...`);
    // Need engine defined outside try block to be accessible here
    const engineInstance = typeof engine !== 'undefined' ? engine : null;
    if (engineInstance && typeof engineInstance.shutdown === 'function') {
        await engineInstance.shutdown();
    } else {
        logger.warn('Engine not available or shutdown method missing during signal handling.');
    }
    process.exit(0);
};
