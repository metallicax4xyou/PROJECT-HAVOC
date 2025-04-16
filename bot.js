// bot.js

const { ethers } = require('ethers');
const config = require('./config'); // Loads combined config object
const { logger } = require('./utils/logger');
const { handleError, ArbitrageError } = require('./utils/errorHandler');

// --- Import Core Components ---
// Use PascalCase for class import
const FlashSwapManager = require('./core/flashSwapManager');
const ArbitrageEngine = require('./core/arbitrageEngine');
const PoolScanner = require('./core/poolScanner'); // Assuming PoolScanner exists
const QuoteSimulator = require('./core/quoteSimulator');
const GasEstimator = require('./utils/gasEstimator');
// --- ---

// --- Main Application Logic ---
async function main() {
    logger.info(">>> PROJECT HAVOC ARBITRAGE BOT STARTING <<<");
    logger.info("==============================================");

    let flashSwapManager; // Declare here for scope

    try {
        // --- Instantiate Core Components ---
        const provider = require('./utils/provider').getProvider(); // Get provider instance

        // Create instances - Initialization happens in constructors
        flashSwapManager = new FlashSwapManager(); // Constructor handles setup
        const quoteSimulator = new QuoteSimulator(config, provider); // Pass needed dependencies
        const gasEstimator = new GasEstimator(provider, config); // Pass needed dependencies
        const poolScanner = new PoolScanner(config, provider); // Pass needed dependencies

        // --- REMOVED THIS LINE - Initialization done in constructor ---
        // await flashSwapManager.initialize(config);
        // --- ---

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
        // Use setInterval for periodic execution
        setInterval(async () => {
            try {
                await arbitrageEngine.findAndExecuteArbitrage();
            } catch (cycleError) {
                // Handle errors occurring within a single arbitrage cycle
                handleError(cycleError, 'ArbitrageCycle');
            }
        }, config.CYCLE_INTERVAL_MS); // Use interval from config

        // Keep the process alive (e.g., for setInterval)
        // This creates an empty promise that never resolves, keeping the script running.
        // Handle graceful shutdown elsewhere if needed (e.g., on SIGINT/SIGTERM).
        await new Promise(() => {});

    } catch (error) {
        // Handle critical initialization errors
        handleError(error, 'BotInitialization');
        // Consider exiting if initialization fails critically
        process.exit(1);
    }
}

// --- Global Error Handling (Optional but Recommended) ---
process.on('unhandledRejection', (reason, promise) => {
    logger.fatal('Unhandled Rejection at:', promise, 'reason:', reason);
    // Decide if you need to crash or attempt recovery
    // process.exit(1); // Crashing on unhandled rejection is often safest
});

process.on('uncaughtException', (error) => {
    logger.fatal('Uncaught Exception:', error);
    // It's generally recommended to exit cleanly after an uncaught exception
    process.exit(1);
});

// --- Graceful Shutdown (Example) ---
const signals = {
  'SIGHUP': 1,
  'SIGINT': 2,
  'SIGTERM': 15
};

Object.keys(signals).forEach((signal) => {
  process.on(signal, () => {
    logger.warn(`[Shutdown] Received ${signal}, shutting down gracefully...`);
    // Add any cleanup logic here (e.g., waiting for pending tx, closing connections)
    // logger.info("[Shutdown] Cleanup finished.");
    process.exit(signals[signal]); // Exit with appropriate code
  });
});


// --- Start the bot ---
main(); // Execute the main function
