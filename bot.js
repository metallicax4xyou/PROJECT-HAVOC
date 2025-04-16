// bot.js

const logger = require('./utils/logger');

// --- Other Imports ---
const { ethers } = require('ethers');
const config = require('./config');
const { handleError, ArbitrageError } = require('./utils/errorHandler');
const FlashSwapManager = require('./core/flashSwapManager');
const ArbitrageEngine = require('./core/arbitrageEngine');
const PoolScanner = require('./core/poolScanner');
const quoteSimulator = require('./core/quoteSimulator'); // Correct based on previous fix
// --- Correctly import the exported object from gasEstimator ---
const gasEstimator = require('./utils/gasEstimator'); // Gets the object { getSimpleGasParams: [Function] }
// --- ---

// --- Global Error Handling ---
process.on('unhandledRejection', (reason, promise) => {
    if (logger && typeof logger.fatal === 'function') {
        logger.fatal('Unhandled Rejection at:', promise, 'reason:', reason);
    } else {
        console.error('[FATAL] Unhandled Rejection (logger missing):', promise, 'reason:', reason);
    }
});

process.on('uncaughtException', (error) => {
    if (logger && typeof logger.fatal === 'function') {
        logger.fatal('Uncaught Exception:', error);
    } else {
        console.error('[FATAL] Uncaught Exception (logger missing):', error);
    }
    process.exit(1);
});
// --- ---

// --- Graceful Shutdown Handlers ---
const signals = { 'SIGHUP': 1, 'SIGINT': 2, 'SIGTERM': 15 };
Object.keys(signals).forEach((signal) => {
  process.on(signal, () => {
    if (logger && typeof logger.warn === 'function') {
        logger.warn(`[Shutdown] Received ${signal}, shutting down gracefully...`);
    } else {
        console.warn(`[Shutdown] Received ${signal}, shutting down gracefully... (logger missing)`);
    }
    process.exit(signals[signal]);
  });
});
// --- ---

// --- Main Application Logic ---
async function main() {
    logger.info(">>> PROJECT HAVOC ARBITRAGE BOT STARTING <<<");
    logger.info("==============================================");

    let flashSwapManager;

    try {
        const provider = require('./utils/provider').getProvider();

        flashSwapManager = new FlashSwapManager();
        const poolScanner = new PoolScanner(config, provider);

        // --- Remove the 'new GasEstimator(...)' line ---
        // The 'gasEstimator' variable now holds the object { getSimpleGasParams: ... }
        // --- ---

        const arbitrageEngine = new ArbitrageEngine(
            config,
            flashSwapManager,
            poolScanner,
            quoteSimulator,
            gasEstimator, // Pass the imported object directly
            logger
        );

        logger.info("[MainLoop] Starting arbitrage cycle...");
        setInterval(async () => {
            try {
                // ArbitrageEngine will need to call gasEstimator.getSimpleGasParams(...) internally
                await arbitrageEngine.findAndExecuteArbitrage();
            } catch (cycleError) {
                handleError(cycleError, 'ArbitrageCycle');
            }
        }, config.CYCLE_INTERVAL_MS);

        await new Promise(() => {});

    } catch (error) {
        // Ensure handleError is correctly imported and used
        handleError(error, 'BotInitialization');
        process.exit(1);
    }
}

// --- Start the bot ---
main();
