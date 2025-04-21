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
const config = require('./config'); // Load the base config object

// --- Graceful Shutdown ---
let isShuttingDown = false;
let arbitrageEngineInstance = null;
async function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.warn(`Received ${signal}. Initiating graceful shutdown...`);
    if (arbitrageEngineInstance) {
        logger.info("Stopping Arbitrage Engine...");
        try { arbitrageEngineInstance.stop(); logger.info("Arbitrage Engine stopped."); }
        catch (error) { logger.error("Error stopping Arbitrage Engine:", error); ErrorHandler.handleError(error, 'GracefulShutdownStop'); }
    } else { logger.warn("Arbitrage Engine instance not found."); }
    logger.info("Shutdown complete. Exiting.");
    process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', (error, origin) => {
    logger.error('--- UNCAUGHT EXCEPTION ---', { error: error?.message, origin, stack: error?.stack });
    ErrorHandler.handleError(error, `UncaughtException (${origin})`);
    process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
    logger.error('--- UNHANDLED REJECTION ---', { reason });
    const error = reason instanceof Error ? reason : new Error(`Unhandled Rejection: ${JSON.stringify(reason)}`);
    ErrorHandler.handleError(error, 'UnhandledRejection');
});

// --- Main Bot Logic ---
async function main() {
    logger.info('\n==============================================');
    logger.info('>>> PROJECT HAVOC ARBITRAGE BOT STARTING <<<');
    logger.info('==============================================');

    let flashSwapManagerInstance = null;
    let provider = null;

    try {
        // Config is already loaded via require('./config') at the top
        // It has been validated by the export logic in config/index.js

        // 1. Validate Token Config
        logger.info('[Main] Validating token configuration...');
        validateTokenConfig(TOKENS);
        logger.info('[Main] Token configuration validated successfully.');

        // 2. Setup Provider
        logger.info('[Main] Getting Provider instance...');
        provider = getProvider(config.RPC_URLS); // Assign provider instance using loaded RPC URLs
        const network = await provider.getNetwork();
        logger.info(`[Main] Provider connected to network: ${network.name} (Chain ID: ${network.chainId})`);

        // --- *** AUGMENT CONFIG WITH PROVIDER *** ---
        // Add the live provider instance to the config object
        // This ensures ProfitCalculator receives it via the config object passed to ArbitrageEngine
        config.provider = provider;
        logger.debug('[Main] Added live provider instance to config object.');
        // --- *** ---

        // 3. Instantiate FlashSwapManager (Passes augmented config and separate provider)
        logger.info('[Main] Initializing Flash Swap Manager instance...');
        if (typeof FlashSwapManager !== 'function') { throw new TypeError(`FlashSwapManager class not loaded.`); }
        // FlashSwapManager constructor specifically expects config AND provider separately based on its code
        flashSwapManagerInstance = new FlashSwapManager(config, provider);
        const signerAddress = await flashSwapManagerInstance.getSignerAddress();
        logger.info(`[Main] Flash Swap Manager initialized. Signer Address: ${signerAddress}`);
        const contractAddr = flashSwapManagerInstance.getFlashSwapContract()?.address;
        logger.info(`[Main] Using FlashSwap contract at: ${contractAddr || 'Not Initialized'}`);


        // 4. Initialize Arbitrage Engine (Passes augmented config and separate provider)
        logger.info('[Main] Initializing Arbitrage Engine...');
        if (typeof ArbitrageEngine !== 'function') { throw new TypeError(`ArbitrageEngine constructor not found!`); }
        // Pass the config object (which includes .provider) AND the provider separately
        arbitrageEngineInstance = new ArbitrageEngine(config, provider);
        logger.info('[Main] Arbitrage Engine initialized.');

        // 5. Setup Listener
        arbitrageEngineInstance.on('profitableOpportunities', (trades) => {
            logger.info(`[Main EVENT] Received ${trades.length} profitable opportunities.`);
            if (flashSwapManagerInstance && !config.DRY_RUN && trades.length > 0) {
                logger.info("[Main] DRY_RUN is false. Forwarding trades...");
                // Example: flashSwapManagerInstance.executeTrades(trades);
            } else if (config.DRY_RUN) {
                 logger.info("[Main] DRY_RUN is true. Logging opportunities.");
            }
        });

        // 6. Start the Engine
        logger.info('[Main] Starting Arbitrage Engine cycle...');
        await arbitrageEngineInstance.start();

        logger.info('\n>>> BOT IS RUNNING <<<');
        logger.info('(Press Ctrl+C to stop)');
        logger.info('======================');

    } catch (error) {
        const errorType = error instanceof Error ? error.constructor.name : 'UnknownError';
        logger.error(`!!! BOT FAILED TO START OR CRASHED DURING STARTUP !!! [Type: ${errorType}]`);
        ErrorHandler.handleError(error, 'MainProcessStartup');
        logger.error('Exiting due to critical startup error...');
        process.exit(1);
    }
}

main().catch(error => {
    const errorType = error instanceof Error ? error.constructor.name : 'UnknownError';
    logger.error(`!!! UNEXPECTED CRITICAL ERROR BUBBLED UP FROM MAIN EXECUTION !!! [Type: ${errorType}]`);
    ErrorHandler.handleError(error, 'MainExecutionCatch');
    process.exit(1);
});
