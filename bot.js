// bot.js
require('dotenv').config();

const logger = require('./utils/logger');
const ErrorHandler = require('./utils/errorHandler');
const { TOKENS } = require('./constants/tokens');
const { validateTokenConfig } = require('./utils/tokenUtils');
const { getProvider } = require('./utils/provider');
const { ethers } = require('ethers');
const FlashSwapManager = require('./core/flashSwapManager');
const ArbitrageEngine = require('./core/arbitrageEngine');
const SwapSimulator = require('./core/swapSimulator'); // *** IMPORT SwapSimulator ***
const config = require('./config');

// --- Graceful Shutdown (Keep as is) ---
let isShuttingDown = false;
let arbitrageEngineInstance = null;
async function gracefulShutdown(signal) { /* ... unchanged ... */
    if (isShuttingDown) return; isShuttingDown = true; logger.warn(`Received ${signal}. Shutdown...`);
    if (arbitrageEngineInstance) { try { arbitrageEngineInstance.stop(); logger.info("Engine stopped."); } catch (error) { logger.error("Error stopping Engine:", error); ErrorHandler?.handleError(error, 'GracefulShutdownStop'); }} else { logger.warn("Engine instance not found."); }
    logger.info("Shutdown complete. Exiting."); process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT')); process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', (error, origin) => { logger.error('--- UNCAUGHT EXCEPTION ---', { error: error?.message, origin }); ErrorHandler?.handleError(error, `UncaughtException (${origin})`); process.exit(1); });
process.on('unhandledRejection', (reason, promise) => { logger.error('--- UNHANDLED REJECTION ---', { reason }); const error = reason instanceof Error ? reason : new Error(`Unhandled Rejection: ${JSON.stringify(reason)}`); ErrorHandler?.handleError(error, 'UnhandledRejection'); });

// --- Main Bot Logic ---
async function main() {
    logger.info('\n==============================================');
    logger.info('>>> PROJECT HAVOC ARBITRAGE BOT STARTING <<<');
    logger.info('==============================================');
    let flashSwapManagerInstance = null; let provider = null; let swapSimulatorInstance = null; // Add simulator instance var
    try {
        logger.info('[Main] Validating token configuration...');
        validateTokenConfig(TOKENS); logger.info('[Main] Token configuration validated.');

        logger.info('[Main] Getting Provider instance...');
        provider = getProvider(config.RPC_URLS);
        const network = await provider.getNetwork(); logger.info(`[Main] Provider connected to ${network.name} (ID: ${network.chainId})`);
        config.provider = provider; logger.debug('[Main] Added provider to config object.');

        // *** Instantiate SwapSimulator ***
        logger.info('[Main] Initializing Swap Simulator...');
        if (typeof SwapSimulator !== 'function') { throw new TypeError(`SwapSimulator class not loaded.`); }
        swapSimulatorInstance = new SwapSimulator(config, provider); // Pass config and provider
        logger.info('[Main] Swap Simulator initialized.');
        // *** --- ***

        logger.info('[Main] Initializing Flash Swap Manager instance...');
        if (typeof FlashSwapManager !== 'function') { throw new TypeError(`FlashSwapManager class not loaded.`); }
        flashSwapManagerInstance = new FlashSwapManager(config, provider);
        const signerAddress = await flashSwapManagerInstance.getSignerAddress(); logger.info(`[Main] Flash Swap Manager initialized. Signer: ${signerAddress}`);
        const contractTarget = flashSwapManagerInstance.getFlashSwapContract()?.target; logger.info(`[Main] Using FlashSwap contract at: ${contractTarget || 'Not Initialized'}`);

        logger.info('[Main] Initializing Arbitrage Engine...');
        if (typeof ArbitrageEngine !== 'function') { throw new TypeError(`ArbitrageEngine constructor not found!`); }
        // *** Pass swapSimulatorInstance to ArbitrageEngine ***
        arbitrageEngineInstance = new ArbitrageEngine(config, provider, swapSimulatorInstance);
        logger.info('[Main] Arbitrage Engine initialized.');

        arbitrageEngineInstance.on('profitableOpportunities', (trades) => { /* ... unchanged ... */
             logger.info(`[Main EVENT] Received ${trades.length} profitable opportunities.`);
             if (flashSwapManagerInstance && !config.DRY_RUN && trades.length > 0) { logger.info("[Main] DRY_RUN=false. Forwarding trades..."); /* flashSwapManagerInstance.executeTrades(trades); */ }
             else if (config.DRY_RUN) { logger.info("[Main] DRY_RUN=true. Logging opportunities."); }
        });

        logger.info('[Main] Starting Arbitrage Engine cycle...'); await arbitrageEngineInstance.start();
        logger.info('\n>>> BOT IS RUNNING <<<'); logger.info('(Press Ctrl+C to stop)'); logger.info('======================');
    } catch (error) { /* ... unchanged error handling ... */
        const errorType = error instanceof Error ? error.constructor.name : 'UnknownError'; logger.error(`!!! BOT FAILED STARTUP !!! [Type: ${errorType}]`, error); ErrorHandler?.handleError(error, 'MainProcessStartup');
        logger.error('Exiting due to critical startup error...'); process.exit(1);
    }
}
main().catch(error => { /* ... unchanged error handling ... */
     const errorType = error instanceof Error ? error.constructor.name : 'UnknownError'; logger.error(`!!! UNEXPECTED CRITICAL ERROR IN MAIN !!! [Type: ${errorType}]`, error); ErrorHandler?.handleError(error, 'MainExecutionCatch'); process.exit(1);
});
