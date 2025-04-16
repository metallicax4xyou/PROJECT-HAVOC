// bot.js

const logger = require('./utils/logger');

// --- Other Imports ---
const { ethers } = require('ethers');
const config = require('./config'); // Import config here to pass to engine
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
    //     arbitrageEngine.shutdown(); // Ensure arbitrageEngine is accessible here if needed
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
    let arbitrageEngine; // Declare here for scope

    try {
        const provider = require('./utils/provider').getProvider();

        flashSwapManager = new FlashSwapManager(); // Pass dependencies if constructor needs them (it uses require internally now)
        poolScanner = new PoolScanner(config, provider); // Pass dependencies

        // Pass config and logger explicitly to Engine constructor
        arbitrageEngine = new ArbitrageEngine(
            flashSwapManager,
            poolScanner,
            profitCalculator.checkProfitability,
            provider,
            txExecutor.executeTransaction,
            config, // Pass config object
            logger  // Pass logger object
        );

        // --- Run initial cycle immediately ---
        logger.info("[MainLoop] Running initial arbitrage cycle...");
        await arbitrageEngine.runCycle();
        logger.info("[MainLoop] Initial cycle finished.");
        // --- ---

        logger.info(`[MainLoop] Starting scheduled arbitrage cycles every ${config.CYCLE_INTERVAL_MS / 1000} seconds...`);
        setInterval(async () => {
            // --- Added log inside interval ---
            logger.debug(`[MainLoop] Interval triggered - calling runCycle...`);
            // --- ---
            try {
                await arbitrageEngine.runCycle();
            } catch (cycleError) {
                handleError(cycleError, 'ArbitrageCycle');
            }
        }, config.CYCLE_INTERVAL_MS);

        // Keep the process alive
        await new Promise(() => {});

    } catch (error) {
        handleError(error, 'BotInitialization');
        process.exit(1);
    }
}

// --- Start the bot ---
main();
