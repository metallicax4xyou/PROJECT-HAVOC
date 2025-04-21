// bot.js
require('dotenv').config(); // Load .env first

// --- Minimal Top-Level Requires ---
const logger = require('./utils/logger');
const ErrorHandler = require('./utils/errorHandler'); // Keep your error handler if needed
const { TOKENS } = require('./constants/tokens'); // Import TOKENS for validation
const { validateTokenConfig } = require('./utils/tokenUtils'); // Use your token validator
const { getProvider } = require('./utils/provider');
const { getSigner, getFlashSwapManager } = require('./core/flashSwapManager'); // Assuming FlashSwapManager setup

// --- Corrected Import for ArbitrageEngine ---
const ArbitrageEngine = require('./core/arbitrageEngine'); // Use this style for module.exports

// --- Corrected Import for Config ---
// Since config/index.js appears to load and export the object directly:
const config = require('./config'); // Import the already loaded config object

// --- Graceful Shutdown ---
let isShuttingDown = false;
let arbitrageEngineInstance = null; // Keep a reference to stop it

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
    // process.exit(1); // Optional: Exit on unhandled rejections
});
// --- End Global Error Handlers ---


// --- Main Bot Logic ---
async function main() {
    logger.info('');
    logger.info('==============================================');
    logger.info('>>> PROJECT HAVOC ARBITRAGE BOT STARTING <<<');
    logger.info('==============================================');

    // Config is already loaded via the require('./config') above
    // No need for provider, signer, flashSwapManager vars here, they are setup below

    try {
        // 1. Validate Token Config First
        logger.info('[Main] Validating token configuration...');
        try {
            validateTokenConfig(TOKENS); // Throws on error
            logger.info('[Main] Token configuration validated successfully.');
        } catch (validationError) {
            logger.error(`[Main CRITICAL] Token Config Validation Failed: ${validationError.message}`);
            ErrorHandler.handleError(validationError, 'TokenValidation');
            process.exit(1);
        }

        // 2. Validate Loaded Main Configuration
        logger.info('[Main] Validating essential bot configuration from loaded config object...');
        // Essential config validation using the 'config' object loaded at the top
        if (!config || !config.NETWORK_RPC_URL || !config.PRIVATE_KEY || !config.FLASH_SWAP_CONTRACT_ADDRESS || !config.POOL_CONFIGS || config.POOL_CONFIGS.length === 0) {
            logger.error('[Main CRITICAL] Essential configuration missing in the loaded config object!', {
                 configExists: !!config,
                 hasRpcUrl: !!config?.NETWORK_RPC_URL,
                 hasPrivateKey: !!config?.PRIVATE_KEY,
                 hasFlashSwapAddr: !!config?.FLASH_SWAP_CONTRACT_ADDRESS,
                 hasPoolConfigs: Array.isArray(config?.POOL_CONFIGS),
                 poolConfigLength: config?.POOL_CONFIGS?.length
            });
            throw new Error("Essential configuration (RPC URL, Private Key, FlashSwap Address, Pool Configs) missing or invalid in loaded object.");
        }
        // *** REMOVED line: config = loadConfig(); // This was the error source ***
        logger.info('[Main] Essential bot configuration validated.');


        // 3. Setup Provider
        logger.info('[Main] Getting Provider instance...');
        const provider = getProvider(config.NETWORK_RPC_URL); // Use loaded config
        const network = await provider.getNetwork();
        logger.info(`[Main] Provider connected to network: ${network.name} (Chain ID: ${network.chainId})`);


        // 4. Setup Signer & FlashSwapManager
        logger.info('[Main] Initializing Flash Swap Manager...');
        const signer = getSigner(config.PRIVATE_KEY, provider); // Use loaded config
        const signerAddress = await signer.getAddress();
        logger.info(`[Main] Signer obtained for address: ${signerAddress}`);
        // Use loaded config
        const flashSwapManager = getFlashSwapManager(config.FLASH_SWAP_CONTRACT_ADDRESS, signer);
        logger.info(`[Main] Flash Swap Manager initialized for contract: ${config.FLASH_SWAP_CONTRACT_ADDRESS}`);


        // 5. Initialize Arbitrage Engine
        logger.info('[Main] Initializing Arbitrage Engine...');
        if (typeof ArbitrageEngine !== 'function') {
             logger.error(`[Main CRITICAL] ArbitrageEngine was not loaded correctly! typeof ArbitrageEngine: ${typeof ArbitrageEngine}. Value:`, ArbitrageEngine);
             throw new Error("Failed to load ArbitrageEngine constructor.");
        }
        // Instantiate using the loaded config object
        arbitrageEngineInstance = new ArbitrageEngine(config);
        logger.info('[Main] Arbitrage Engine initialized.');


        // Setup listener for results
        arbitrageEngineInstance.on('profitableOpportunities', (trades) => {
            logger.info(`[Main EVENT] Received ${trades.length} profitable opportunities.`);
            if (flashSwapManager && !config.DRY_RUN && trades.length > 0) {
                logger.info("[Main] DRY_RUN is false. Forwarding trades for potential execution...");
                // flashSwapManager.executeTrades(trades); // Your execution logic
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
        logger.error('!!! BOT FAILED TO START OR CRASHED DURING STARTUP !!!');
        ErrorHandler.handleError(error, 'MainProcessStartup');
        logger.error('Exiting due to critical startup error...');
        process.exit(1);
    }
}

// Execute main function
main().catch(error => {
    logger.error("!!! UNEXPECTED CRITICAL ERROR BUBBLED UP FROM MAIN EXECUTION !!!");
    ErrorHandler.handleError(error, 'MainExecutionCatch');
    process.exit(1);
});
