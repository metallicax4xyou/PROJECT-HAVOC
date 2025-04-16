// bot.js

const logger = require('./utils/logger');

// --- Other Imports ---
const { ethers } = require('ethers');
const config = require('./config');
const { handleError, ArbitrageError } = require('./utils/errorHandler');

// --- Core Components ---
const FlashSwapManager = require('./core/flashSwapManager');
const ArbitrageEngine = require('./core/arbitrageEngine');
const { PoolScanner } = require('./core/poolScanner');
const quoteSimulator = require('./core/quoteSimulator');
const gasEstimator = require('./utils/gasEstimator');
const profitCalculator = require('./core/profitCalculator');
const txExecutor = require('./core/txExecutor');
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
    // Optional: Call engine shutdown if implemented
    // if (arbitrageEngine && typeof arbitrageEngine.shutdown === 'function') {
    //     arbitrageEngine.shutdown();
    // }
    process.exit(signals[signal]);
  });
});
// --- ---

// --- Main Application Logic ---
async function main() {
    logger.info(">>> PROJECT HAVOC ARBITRAGE BOT STARTING <<<");
    logger.info("==============================================");

    let flashSwapManager;
    let poolScanner;
    let arbitrageEngine; // Declare here for potential access in shutdown

    try {
        const provider = require('./utils/provider').getProvider();

        flashSwapManager = new FlashSwapManager();
        poolScanner = new PoolScanner(config, provider);

        arbitrageEngine = new ArbitrageEngine( // Assign to the outer scope variable
            flashSwapManager,
            poolScanner,
            profitCalculator.checkProfitability,
            provider,
            txExecutor.executeTransaction
        );

        logger.info("[MainLoop] Starting arbitrage cycle...");
        setInterval(async () => {
            try {
                // --- Corrected Method Call ---
                // Call the actual method defined in ArbitrageEngine
                await arbitrageEngine.runCycle();
                // --- ---
            } catch (cycleError) {
                // Handle errors occurring within a single arbitrage cycle
                handleError(cycleError, 'ArbitrageCycle');
            }
        }, config.CYCLE_INTERVAL_MS); // Use interval from config

        // Keep the process alive
        await new Promise(() => {});

    } catch (error) {
        handleError(error, 'BotInitialization');
        process.exit(1); // Exit if initialization fails critically
    }
}

// --- Start the bot ---
main();
