// bot.js

// --- Ensure Logger is imported FIRST ---
// Correctly import the logger object
const logger = require('./utils/logger');
// --- ---

// --- Other Imports ---
const { ethers } = require('ethers');
const config = require('./config'); // Loads combined config object
const { handleError, ArbitrageError } = require('./utils/errorHandler');
const FlashSwapManager = require('./core/flashSwapManager');
const ArbitrageEngine = require('./core/arbitrageEngine');
const PoolScanner = require('./core/poolScanner');
const QuoteSimulator = require('./core/quoteSimulator');
const GasEstimator = require('./utils/gasEstimator');
// --- ---


// --- Global Error Handling - Registered AFTER logger import ---
process.on('unhandledRejection', (reason, promise) => {
    // Add safety check for logger existence
    if (logger && typeof logger.fatal === 'function') {
        logger.fatal('Unhandled Rejection at:', promise, 'reason:', reason);
    } else {
        console.error('[FATAL] Unhandled Rejection (logger missing):', promise, 'reason:', reason);
    }
    // process.exit(1); // Optional: Exit on unhandled rejection
});

process.on('uncaughtException', (error) => {
    // Add safety check for logger existence
    if (logger && typeof logger.fatal === 'function') {
        logger.fatal('Uncaught Exception:', error); // This line (around 80) should now work
    } else {
        console.error('[FATAL] Uncaught Exception (logger missing):', error);
    }
    process.exit(1); // Recommended to exit on uncaught exceptions
});
// --- ---


// --- Graceful Shutdown Handlers - Registered AFTER logger import ---
const signals = {
  'SIGHUP': 1,
  'SIGINT': 2, // Ctrl+C
  'SIGTERM': 15
};

Object.keys(signals).forEach((signal) => {
  process.on(signal, () => {
    // Add safety check for logger existence
    if (logger && typeof logger.warn === 'function') {
        logger.warn(`[Shutdown] Received ${signal}, shutting down gracefully...`);
    } else {
        console.warn(`[Shutdown] Received ${signal}, shutting down gracefully... (logger missing)`);
    }
    // Add cleanup logic here if needed
    process.exit(signals[signal]);
  });
});
// --- ---


// --- Main Application Logic ---
async function main() {
    logger.info(">>> PROJECT HAVOC ARBITRAGE BOT STARTING <<<");
    logger.info("==============================================");

    let flashSwapManager; // Declare here for scope

    try {
        // --- Instantiate Core Components ---
        const provider = require('./utils/provider').getProvider();

        flashSwapManager = new FlashSwapManager(); // Constructor handles setup
        const quoteSimulator = new QuoteSimulator(config, provider);
        const gasEstimator = new GasEstimator(provider, config);
        const poolScanner = new PoolScanner(config, provider);

        const arbitrageEngine = new ArbitrageEngine(
            config,
            flashSwapManager,
            poolScanner,
            quoteSimulator,
            gasEstimator,
            logger // Pass logger instance
        );

        // --- Start the main arbitrage loop ---
        logger.info("[MainLoop] Starting arbitrage cycle...");
        setInterval(async () => {
            try {
                await arbitrageEngine.findAndExecuteArbitrage();
            } catch (cycleError) {
                handleError(cycleError, 'ArbitrageCycle');
            }
        }, config.CYCLE_INTERVAL_MS);

        // Keep the process alive
        await new Promise(() => {});

    } catch (error) {
        handleError(error, 'BotInitialization');
        process.exit(1); // Exit if initialization fails critically
    }
}


// --- Start the bot ---
main(); // Execute the main function
