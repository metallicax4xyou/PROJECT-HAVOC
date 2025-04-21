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
async function gracefulShutdown(signal) { /* ... no change ... */
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
process.on('uncaughtException', (error, origin) => { /* ... no change ... */
    logger.error('--- UNCAUGHT EXCEPTION ---', { error: error?.message, origin, stack: error?.stack });
    ErrorHandler.handleError(error, `UncaughtException (${origin})`);
    process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => { /* ... no change ... */
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
        // 1. Validate Token Config
        logger.info('[Main] Validating token configuration...');
        validateTokenConfig(TOKENS);
        logger.info('[Main] Token configuration validated successfully.');

        // 2. Validate Base Loaded Main Configuration
        logger.info('[Main] Validating essential base configuration...');
        const hasRpcUrls = config && Array.isArray(config.RPC_URLS) && config.RPC_URLS.length > 0;
        const hasPrivateKey = config && !!config.PRIVATE_KEY;
        const hasFlashSwapAddr = config && !!config.FLASH_SWAP_CONTRACT_ADDRESS && config.FLASH_SWAP_CONTRACT_ADDRESS !== ethers.ZeroAddress;
        const hasPoolConfigs = config && Array.isArray(config.POOL_CONFIGS) && config.POOL_CONFIGS.length > 0;
        const dexFlagsOk = config.UNISWAP_V3_ENABLED || config.SUSHISWAP_ENABLED || config.DODO_ENABLED;
        if (!dexFlagsOk) { logger.warn('[Main] WARNING: No DEX fetchers enabled in config.'); }
        // Check presence of Chainlink feeds required by ProfitCalculator
        const hasChainlinkFeeds = config && typeof config.CHAINLINK_FEEDS === 'object' && Object.keys(config.CHAINLINK_FEEDS).length > 0;
         if (!hasChainlinkFeeds) {
             logger.warn('[Main] WARNING: CHAINLINK_FEEDS configuration missing or empty in config/index.js or network file. ProfitCalculator might fail or price conversions will be unavailable.');
             // Decide if this is critical - maybe throw error if needed?
             // throw new Error("CHAINLINK_FEEDS configuration is required for ProfitCalculator.");
         }

        if (!config || !hasRpcUrls || !hasPrivateKey || !hasFlashSwapAddr || !hasPoolConfigs /* || !hasChainlinkFeeds */) { // Optionally make feeds essential
             logger.error('[Main CRITICAL] Essential configuration missing!', { configExists: !!config, hasRpcUrls, hasPrivateKey, hasFlashSwapAddr, hasPoolConfigs, hasChainlinkFeeds, poolConfigLength: config?.POOL_CONFIGS?.length ?? 0 });
             throw new Error("Essential configuration missing or invalid.");
        }
        logger.info('[Main] Essential base configuration validated.');

        // 3. Setup Provider
        logger.info('[Main] Getting Provider instance...');
        provider = getProvider(config.RPC_URLS); // Assign provider instance
        const network = await provider.getNetwork();
        logger.info(`[Main] Provider connected to network: ${network.name} (Chain ID: ${network.chainId})`);

        // --- *** AUGMENT CONFIG WITH PROVIDER *** ---
        // Add the live provider instance to the config object before passing it down
        config.provider = provider;
        logger.debug('[Main] Added live provider instance to config object.');
        // --- *** ---

        // 4. Instantiate FlashSwapManager (Passes augmented config)
        logger.info('[Main] Initializing Flash Swap Manager instance...');
        if (typeof FlashSwapManager !== 'function') { throw new TypeError(`FlashSwapManager class not loaded.`); }
        flashSwapManagerInstance = new FlashSwapManager(config, provider); // Constructor expects provider separately here based on its code
        const signerAddress = await flashSwapManagerInstance.getSignerAddress();
        logger.info(`[Main] Flash Swap Manager initialized. Signer Address: ${signerAddress}`);
        const contractAddr = flashSwapManagerInstance.getFlashSwapContract()?.address;
        logger.info(`[Main] Using FlashSwap contract at: ${contractAddr || 'Not Initialized'}`);


        // 5. Initialize Arbitrage Engine (Passes augmented config)
        logger.info('[Main] Initializing Arbitrage Engine...');
        if (typeof ArbitrageEngine !== 'function') { throw new TypeError(`ArbitrageEngine constructor not found!`); }
        // Pass the config object (which NOW includes .provider)
        // ArbitrageEngine constructor still accepts provider separately for its own potential use
        arbitrageEngineInstance = new ArbitrageEngine(config, provider);
        logger.info('[Main] Arbitrage Engine initialized.');

        // Setup listener
        arbitrageEngineInstance.on('profitableOpportunities', (trades) => { /* ... no change ... */
            logger.info(`[Main EVENT] Received ${trades.length} profitable opportunities.`);
            if (flashSwapManagerInstance && !config.DRY_RUN && trades.length > 0) {
                logger.info("[Main] DRY_RUN is false. Forwarding trades...");
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

    } catch (error) { /* ... no change ... */
        const errorType = error instanceof Error ? error.constructor.name : 'UnknownError';
        logger.error(`!!! BOT FAILED TO START OR CRASHED DURING STARTUP !!! [Type: ${errorType}]`);
        ErrorHandler.handleError(error, 'MainProcessStartup');
        logger.error('Exiting due to critical startup error...');
        process.exit(1);
    }
}

main().catch(error => { /* ... no change ... */
    const errorType = error instanceof Error ? error.constructor.name : 'UnknownError';
    logger.error(`!!! UNEXPECTED CRITICAL ERROR BUBBLED UP FROM MAIN EXECUTION !!! [Type: ${errorType}]`);
    ErrorHandler.handleError(error, 'MainExecutionCatch');
    process.exit(1);
});
