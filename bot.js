// bot.js
require('dotenv').config(); // Load .env first

// --- Minimal Top-Level Requires ---
const logger = require('./utils/logger');
const ErrorHandler = require('./utils/errorHandler');
const { TOKENS } = require('./constants/tokens');
const { validateTokenConfig } = require('./utils/tokenUtils');
const { getProvider } = require('./utils/provider');

// --- Import the FlashSwapManager CLASS ---
const FlashSwapManager = require('./core/flashSwapManager'); // Import the class

// --- Import ArbitrageEngine CLASS ---
const ArbitrageEngine = require('./core/arbitrageEngine');

// --- Import Config OBJECT ---
const config = require('./config');

// --- Graceful Shutdown ---
let isShuttingDown = false;
let arbitrageEngineInstance = null;

async function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.warn(`Received ${signal}. Initiating graceful shutdown...`);

    if (arbitrageEngineInstance) {
        logger.info("Stopping Arbitrage Engine...");
        try {
            arbitrageEngineInstance.stop();
            logger.info("Arbitrage Engine stopped.");
        } catch (error) {
            logger.error("Error stopping Arbitrage Engine:", error);
            ErrorHandler.handleError(error, 'GracefulShutdownStop');
        }
    } else {
        logger.warn("Arbitrage Engine instance not found, cannot stop it explicitly.");
    }

    logger.info("Shutdown complete. Exiting.");
    process.exit(0);
}

// --- Global Error Handlers ---
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
    // process.exit(1); // Optional
});
// --- End Global Error Handlers ---

// --- Main Bot Logic ---
async function main() {
    logger.info('');
    logger.info('==============================================');
    logger.info('>>> PROJECT HAVOC ARBITRAGE BOT STARTING <<<');
    logger.info('==============================================');

    let flashSwapManagerInstance = null; // To hold the instance

    try {
        // 1. Validate Token Config
        logger.info('[Main] Validating token configuration...');
        validateTokenConfig(TOKENS); // Throws on error
        logger.info('[Main] Token configuration validated successfully.');

        // 2. Validate Loaded Main Configuration
        logger.info('[Main] Validating essential bot configuration...');
        const hasRpcUrls = config && Array.isArray(config.RPC_URLS) && config.RPC_URLS.length > 0;
        const hasPrivateKey = config && !!config.PRIVATE_KEY;
        const hasFlashSwapAddr = config && !!config.FLASH_SWAP_CONTRACT_ADDRESS && config.FLASH_SWAP_CONTRACT_ADDRESS !== ethers.ZeroAddress;
        const hasPoolConfigs = config && Array.isArray(config.POOL_CONFIGS) && config.POOL_CONFIGS.length > 0;

        if (!config || !hasRpcUrls || !hasPrivateKey || !hasFlashSwapAddr || !hasPoolConfigs) {
             logger.error('[Main CRITICAL] Essential configuration missing!', { configExists: !!config, hasRpcUrls, hasPrivateKey, hasFlashSwapAddr, hasPoolConfigs, poolConfigLength: config?.POOL_CONFIGS?.length ?? 0 });
             throw new Error("Essential configuration missing or invalid.");
        }
        logger.info('[Main] Essential bot configuration validated.');

        // 3. Setup Provider
        logger.info('[Main] Getting Provider instance...');
        const provider = getProvider(config.RPC_URLS);
        const network = await provider.getNetwork();
        logger.info(`[Main] Provider connected to network: ${network.name} (Chain ID: ${network.chainId})`);

        // 4. Instantiate FlashSwapManager (Corrected)
        logger.info('[Main] Initializing Flash Swap Manager instance...');
        // Check if the CLASS was imported correctly
        if (typeof FlashSwapManager !== 'function' || !FlashSwapManager.prototype) {
             throw new TypeError(`FlashSwapManager was not loaded correctly as a class. Check export in core/flashSwapManager.js. Typeof: ${typeof FlashSwapManager}`);
        }
        // Create an INSTANCE of the class, passing config and provider
        flashSwapManagerInstance = new FlashSwapManager(config, provider);
        // Get signer details from the instance
        const signer = flashSwapManagerInstance.getSigner(); // Call method on instance
        const signerAddress = await flashSwapManagerInstance.getSignerAddress(); // Call method on instance
        logger.info(`[Main] Flash Swap Manager initialized. Signer Address: ${signerAddress}`);
        logger.info(`[Main] Using FlashSwap contract at: ${flashSwapManagerInstance.getFlashSwapContract().address}`);


        // 5. Initialize Arbitrage Engine
        logger.info('[Main] Initializing Arbitrage Engine...');
        if (typeof ArbitrageEngine !== 'function') {
             throw new TypeError(`ArbitrageEngine constructor not found!`);
        }
        arbitrageEngineInstance = new ArbitrageEngine(config); // Pass config
        logger.info('[Main] Arbitrage Engine initialized.');

        // Setup listener for results
        arbitrageEngineInstance.on('profitableOpportunities', (trades) => {
            logger.info(`[Main EVENT] Received ${trades.length} profitable opportunities.`);
            // Use the flashSwapManagerInstance for execution
            if (flashSwapManagerInstance && !config.DRY_RUN && trades.length > 0) {
                logger.info("[Main] DRY_RUN is false. Forwarding trades for potential execution...");
                // Example: flashSwapManagerInstance.executeTrades(trades);
            } else if (config.DRY_RUN) {
                 logger.info("[Main] DRY_RUN is true. Logging opportunities, skipping execution.");
            }
        });

        // 6. Start the Engine
        logger.info('[Main] Starting Arbitrage Engine cycle...');
        await arbitrageEngineInstance.start();

        logger.info('');
        logger.info('>>> BOT IS RUNNING <<<');
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

// Execute main function
main().catch(error => {
    const errorType = error instanceof Error ? error.constructor.name : 'UnknownError';
    logger.error(`!!! UNEXPECTED CRITICAL ERROR BUBBLED UP FROM MAIN EXECUTION !!! [Type: ${errorType}]`);
    ErrorHandler.handleError(error, 'MainExecutionCatch');
    process.exit(1);
});
