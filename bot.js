// bot.js - Main Entry Point
require('dotenv').config();
const logger = require('./utils/logger');
const config = require('./config/index.js');
const { handleError } = require('./utils/errorHandler');

// Core Components
const FlashSwapManager = require('./core/flashSwapManager');
const { PoolScanner } = require('./core/poolScanner');
// --->>> UPDATED IMPORT: Import the function <<<---
const { checkProfitability } = require('./core/profitCalculator');
const TxExecutor = require('./core/txExecutor'); // Assuming this exports directly
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

        // 2. Initialize other components
        const poolScanner = new PoolScanner(config, provider);
        // --->>> REMOVED instantiation of ProfitCalculator <<<---
        // const profitCalculator = new ProfitCalculator(provider, getSimpleGasParams); // THIS WAS WRONG

        // Initialize TxExecutor - Check constructor args later if it fails
        const txExecutor = new TxExecutor(flashSwapManager, nonceManager, provider, getSimpleGasParams);

        // 3. Instantiate ArbitrageEngine
        // --->>> UPDATED: Pass checkProfitability function and provider <<<---
        // ArbitrageEngine will need modification to accept these instead of an instance
        engine = new ArbitrageEngine(
            flashSwapManager,
            poolScanner,
            // Pass the profitability check function and provider directly
            checkProfitability,
            provider,
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

        // Error Handling (remains the same)
        process.on('uncaughtException', async (error) => { /* ... */ });
        process.on('unhandledRejection', async (reason, promise) => { /* ... */ });

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
