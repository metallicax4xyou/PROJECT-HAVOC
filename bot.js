// bot.js

const logger = require('./utils/logger');

// --- Load Config FIRST at top level ---
const config = require('./config');
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
process.on('unhandledRejection', (reason, promise) => {
    // Safety check for logger added
    if (logger && typeof logger.fatal === 'function') {
        logger.fatal('Unhandled Rejection at:', promise, 'reason:', reason);
    } else {
        console.error('[FATAL] Unhandled Rejection (logger missing):', promise, 'reason:', reason);
    }
    // process.exit(1); // Consider if you want to exit on unhandled rejections
});

process.on('uncaughtException', (error) => {
    if (logger && typeof logger.fatal === 'function') {
        logger.fatal('Uncaught Exception:', error);
    } else {
        console.error('[FATAL] Uncaught Exception (logger missing):', error);
    }
    process.exit(1); // Exit on uncaught exceptions is generally recommended
});
// --- ---

// Declare arbitrageEngine in a scope accessible by shutdown handler
let arbitrageEngine;

// --- Graceful Shutdown Handlers ---
const signals = { 'SIGHUP': 1, 'SIGINT': 2, 'SIGTERM': 15 };
Object.keys(signals).forEach((signal) => {
  process.on(signal, async () => { // Make handler async if shutdown is async
    if (logger && typeof logger.warn === 'function') {
        logger.warn(`[Shutdown] Received ${signal}, attempting graceful shutdown...`);
    } else {
        console.warn(`[Shutdown] Received ${signal}, attempting graceful shutdown... (logger missing)`);
    }
    // Call engine shutdown if it exists and is implemented
    if (arbitrageEngine && typeof arbitrageEngine.stopMonitoring === 'function') {
        try {
            await arbitrageEngine.stopMonitoring(); // Assuming stopMonitoring might be async later
             logger.info("[Shutdown] Arbitrage engine monitoring stopped.");
        } catch (shutdownError) {
             logger.error("[Shutdown] Error during engine stop:", shutdownError);
        }
    }
    process.exit(signals[signal]); // Exit after attempting shutdown
  });
});
// --- ---

// --- Main Application Logic ---
async function main() {
    logger.info(">>> PROJECT HAVOC ARBITRAGE BOT STARTING (inside main) <<<");
    logger.info("==============================================");

    let flashSwapManager;
    let poolScanner;
    // arbitrageEngine is declared outside main for shutdown handler access

    try {
        const provider = require('./utils/provider').getProvider();

        flashSwapManager = new FlashSwapManager();
        poolScanner = new PoolScanner(config, provider);

        // Instantiate ArbitrageEngine
        arbitrageEngine = new ArbitrageEngine(
            flashSwapManager,
            poolScanner,
            profitCalculator.checkProfitability,
            provider,
            txExecutor.executeTransaction,
            config,
            logger
        );

        // --- Start the engine's monitoring loop ---
        // This will set isMonitoring = true, run an initial cycle, and manage the interval
        await arbitrageEngine.startMonitoring();
        // --- ---

        // --- Remove manual initial run and setInterval ---
        // logger.info("[MainLoop] Running initial arbitrage cycle...");
        // await arbitrageEngine.runCycle(); // Handled by startMonitoring
        // logger.info("[MainLoop] Initial cycle finished.");
        // logger.info(`[MainLoop] Starting scheduled arbitrage cycles every ${config.CYCLE_INTERVAL_MS / 1000} seconds...`);
        // setInterval(async () => { ... }); // Handled by startMonitoring
        // --- ---

        // Keep the process alive (startMonitoring likely handles the loop now)
        logger.info("[MainLoop] Main thread waiting indefinitely (engine loop running)...");
        await new Promise(() => {}); // Keep script running

    } catch (error) {
        handleError(error, 'BotInitialization');
        process.exit(1);
    }
}

// --- Start the bot ---
main();
