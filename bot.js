// bot.js

const logger = require('./utils/logger');

// --- Load Config FIRST at top level ---
const config = require('./config'); // Load merged config object once
// Basic check right after loading
if (!config || !config.NAME) {
    console.error("!!! FATAL: Config loaded improperly or missing NAME at top level !!!", config);
    process.exit(1);
}
logger.info(`[Bot] Initial config loaded. Network: ${config.NAME}`);
// --- ---

// --- Other Imports ---
const { ethers } = require('ethers');
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
// ... (handlers remain the same) ...
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
// ... (handlers remain the same) ...
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
    logger.info(">>> PROJECT HAVOC ARBITRAGE BOT STARTING (inside main) <<<");
    logger.info("==============================================");

    let flashSwapManager;
    let poolScanner;
    let arbitrageEngine;

    try {
        const provider = require('./utils/provider').getProvider();

        flashSwapManager = new FlashSwapManager();
        poolScanner = new PoolScanner(config, provider); // Pass top-level config

        // --- ADDED DEBUG LOG BEFORE ENGINE INSTANTIATION ---
        logger.debug("[Bot main] Checking config object right before passing to ArbitrageEngine...");
        console.log("[Bot main DEBUG] Config object value:", config); // Direct console log
        if (!config || !config.NAME) {
            logger.error("[Bot main] !!! Config object invalid or missing NAME right before passing !!!");
        }
        // --- ---

        // Instantiate ArbitrageEngine
        arbitrageEngine = new ArbitrageEngine(
            flashSwapManager,
            poolScanner,
            profitCalculator.checkProfitability,
            provider,
            txExecutor.executeTransaction,
            config, // Pass the config object loaded at the top
            logger
        );

        // ... (rest of main function remains the same) ...
        logger.info("[MainLoop] Running initial arbitrage cycle...");
        await arbitrageEngine.runCycle();
        logger.info("[MainLoop] Initial cycle finished.");

        logger.info(`[MainLoop] Starting scheduled arbitrage cycles every ${config.CYCLE_INTERVAL_MS / 1000} seconds...`);
        setInterval(async () => {
            logger.debug(`[MainLoop] Interval triggered - calling runCycle...`);
            try {
                await arbitrageEngine.runCycle();
            } catch (cycleError) {
                handleError(cycleError, 'ArbitrageCycle');
            }
        }, config.CYCLE_INTERVAL_MS);

        await new Promise(() => {});


    } catch (error) {
        handleError(error, 'BotInitialization');
        process.exit(1);
    }
}

// --- Start the bot ---
main();
