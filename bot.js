// bot.js

const logger = require('./utils/logger');

// --- Other Imports ---
const { ethers } = require('ethers');
const config = require('./config');
const { handleError, ArbitrageError } = require('./utils/errorHandler');

// --- Core Components ---
const FlashSwapManager = require('./core/flashSwapManager');
const ArbitrageEngine = require('./core/arbitrageEngine');
const { PoolScanner } = require('./core/poolScanner'); // Destructure Class
const quoteSimulator = require('./core/quoteSimulator');   // Import object
const gasEstimator = require('./utils/gasEstimator');     // Import object
// --- Import Profit Calc and Tx Executor ---
const profitCalculator = require('./core/profitCalculator'); // Import object { checkProfitability: ... }
const txExecutor = require('./core/txExecutor');             // Import object { executeTransaction: ... }
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
    let poolScanner;

    try {
        const provider = require('./utils/provider').getProvider();

        flashSwapManager = new FlashSwapManager(); // Instantiate
        poolScanner = new PoolScanner(config, provider); // Instantiate

        // --- Instantiate ArbitrageEngine with correct arguments ---
        const arbitrageEngine = new ArbitrageEngine(
            flashSwapManager,                 // 1st: FlashSwapManager instance
            poolScanner,                      // 2nd: PoolScanner instance
            profitCalculator.checkProfitability, // 3rd: The checkProfitability function
            provider,                         // 4th: The provider instance
            txExecutor.executeTransaction     // 5th: The executeTransaction function
        );
        // --- ---

        logger.info("[MainLoop] Starting arbitrage cycle...");
        setInterval(async () => {
            try {
                // Engine now has all dependencies correctly injected
                await arbitrageEngine.findAndExecuteArbitrage();
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
