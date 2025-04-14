// bot.js - Main Entry Point
require('dotenv').config(); // Load .env file first
const logger = require('./utils/logger');
const config = require('./config/index.js'); // Ensure config is loaded early
const { handleError } = require('./utils/errorHandler');

// Core Components
const FlashSwapManager = require('./core/flashSwapManager');
// --->>> UPDATED IMPORT: Use destructuring <<<---
const { PoolScanner } = require('./core/poolScanner');
const ProfitCalculator = require('./core/profitCalculator'); // Assuming this exports directly (module.exports = ProfitCalculator)
const TxExecutor = require('./core/txExecutor');         // Assuming this exports directly
const ArbitrageEngine = require('./core/arbitrageEngine'); // Exports directly

// Utilities
const { getSimpleGasParams } = require('./utils/gasEstimator'); // Imports function correctly

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

        // 2. Initialize other components
        // --->>> Instantiate PoolScanner correctly <<<---
        // Need to check PoolScanner constructor arguments - it expects (config, provider)
        const poolScanner = new PoolScanner(config, provider); // Pass config and provider

        // Pass provider and gas function to calculator/executor
        // Need to check their constructors too! Let's assume they are correct for now.
        // If they fail next, we'll check their constructors and exports.
        const profitCalculator = new ProfitCalculator(provider, getSimpleGasParams);
        const txExecutor = new TxExecutor(flashSwapManager, nonceManager, provider, getSimpleGasParams);

        // 3. Instantiate ArbitrageEngine
        engine = new ArbitrageEngine(
            flashSwapManager,
            poolScanner,
            profitCalculator,
            txExecutor
        );

        // 4. Start the Engine's Monitoring Loop
        await engine.startMonitoring();

        // 5. Graceful Shutdown Handling (remains the same)
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
