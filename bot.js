// /workspaces/arbitrum-flash/bot.js
// --- Corrected ErrorHandler function call ---

// --- Force .env loading FIRST ---
console.log('[Bot Start] Attempting to load .env...');
const dotenvResult = require('dotenv').config();
if (dotenvResult.error) {
    console.error('[Bot Start] FATAL: Error loading .env file:', dotenvResult.error);
    process.exit(1);
}
console.log('[Bot Start] .env loaded check. Verifying key vars from process.env...');
console.log(`[Bot Start] NETWORK = ${process.env.NETWORK}`);
console.log(`[Bot Start] PRIVATE_KEY exists = ${!!process.env.PRIVATE_KEY}, length = ${process.env.PRIVATE_KEY?.length}`);
const networkUpper = (process.env.NETWORK || 'arbitrum').toUpperCase();
console.log(`[Bot Start] ${networkUpper}_RPC_URLS exists = ${!!process.env[`${networkUpper}_RPC_URLS`]}`);
console.log(`[Bot Start] ${networkUpper}_FLASH_SWAP_ADDRESS exists = ${!!process.env[`${networkUpper}_FLASH_SWAP_ADDRESS`]}`);
console.log(`[Bot Start] Example Pool Var (ARBITRUM_WETH_USDC_500_ADDRESS) exists = ${!!process.env.ARBITRUM_WETH_USDC_500_ADDRESS}`);
console.log(`[Bot Start] Example Borrow Var (BORROW_AMOUNT_WETH) exists = ${!!process.env.BORROW_AMOUNT_WETH}`);
// --- End .env loading ---

// --- Minimal Top-Level Requires ---
const logger = require('./utils/logger'); // Logger is needed early for handlers
const ErrorHandler = require('./utils/errorHandler'); // Error handler needed for handlers & main catch
// --- END Minimal Top-Level Requires ---


// --- DETAILED GLOBAL ERROR HANDLERS ---
// Placed here after logger is required, before main logic starts

process.on('uncaughtException', (error, origin) => {
    const logErr = logger?.error || console.error;
    logErr('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    logErr('!!! UNCAUGHT EXCEPTION ENCOUNTERED !!!');
    logErr('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    logErr(`[Uncaught Exception] Origin: ${origin}`);
    logErr(`[Uncaught Exception] Error: ${error?.message || error}`);
    console.error("Full Error Object:", error);
    console.error("Stack Trace:", error?.stack);
    logErr('!!! Forcing exit due to uncaught exception. !!!');
    setTimeout(() => process.exit(1), 2000);
    gracefulShutdown(true);
});

process.on('unhandledRejection', (reason, promise) => {
    const logErr = logger?.error || console.error;
    logErr('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    logErr('!!! UNHANDLED PROMISE REJECTION !!!');
    logErr('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    logErr('[Unhandled Rejection] Reason:', reason);
    if (reason instanceof Error && reason.stack) {
        logErr("Stack Trace:", reason.stack);
        console.error("Full Error Object (Reason):", reason);
    }
    logErr('!!! Unhandled rejection indicates potential instability. Consider exiting. !!!');
    // setTimeout(() => process.exit(1), 2000);
    // gracefulShutdown(true);
});
// --- END DETAILED GLOBAL ERROR HANDLERS ---


// --- Main Application Logic ---
async function main() {
    logger.info('>>> PROJECT HAVOC ARBITRAGE BOT STARTING (inside main) <<<');
    logger.info('==============================================');

    let engine = null;

    try {
        // --- Requires Moved Inside Main ---
        const { getProvider } = require('./utils/provider');
        const config = require('./config');
        const { ArbitrageEngine } = require('./core/arbitrageEngine');
        const FlashSwapManager = require('./core/flashSwapManager');
        // --- End Moved Requires ---

        // 1. Config Validation
        logger.info('[Main] Configuration loaded and validated.');
        if (!config || !config.PRIVATE_KEY || !config.POOL_CONFIGS || config.POOL_CONFIGS.length === 0) {
            logger.error('[Main CRITICAL] Config loaded inside main() is missing essential properties (PRIVATE_KEY, POOL_CONFIGS)!', config ? Object.keys(config) : 'Config is falsy');
            throw new Error("Failed to load valid config with essential properties inside main function.");
        }

        // 2. Get Provider
        logger.info('[Main] Getting Provider instance...');
        const provider = getProvider();
        logger.info('[Main] Provider instance obtained.');

        // 3. Initialize FlashSwapManager
        logger.info('[Main] Initializing Flash Swap Manager...');
        logger.debug('[Main Debug] Passing config keys to FlashSwapManager:', config ? Object.keys(config) : 'Config is falsy!');
        logger.debug('[Main Debug] Passing provider to FlashSwapManager:', !!provider);
        const flashSwapManager = new FlashSwapManager(config, provider);
        logger.info(`[Main] Flash Swap Manager initialized. Signer Address: ${flashSwapManager.getSigner().address}`);

        // 4. Initialize Engine
        logger.info('[Main] Initializing Arbitrage Engine...');
        engine = new ArbitrageEngine(flashSwapManager, config);
        await engine.initialize();
        logger.info('[Main] Arbitrage Engine initialized.');

        // 5. Start Engine Loop
        await engine.start();

        logger.info('[MainLoop] Main thread waiting indefinitely (engine loop running)...');
        await new Promise(() => {});

    } catch (error) {
        const message = error.message || 'Unknown error during startup';
        const context = 'MainProcessStartup';
        logger.error(`!!! BOT FAILED TO START !!! Error during main execution in ${context}: ${message}`);
        if (error.stack) logger.error(`Stack: ${error.stack}`);

        // --- *** CORRECTED FUNCTION NAME HERE *** ---
        if (ErrorHandler && typeof ErrorHandler.handleError === 'function') { // Check for handleError
             ErrorHandler.handleError(error, context); // Call handleError
        } else {
             console.error(`[Main Emergency Log] ErrorHandler.handleError is not available. Raw Error:`, error);
        }
        process.exit(1);
    }
}


// --- Graceful Shutdown ---
let isShuttingDown = false;
async function gracefulShutdown(force = false) {
    if (isShuttingDown) {
        logger.warn('[Shutdown] Already shutting down...');
        return;
    }
    isShuttingDown = true;
    const exitCode = force ? 1 : 0;
    const mode = force ? 'Forced' : 'Graceful';
    logger.warn(`\n!!! ${mode} Shutdown initiated (Exit Code: ${exitCode}) !!!`);

    // Add cleanup tasks here
    logger.warn('[Shutdown] Performing final cleanup...');

    // Exit
    logger.warn(`[Shutdown] Exiting process with code ${exitCode}...`);
    setTimeout(() => process.exit(exitCode), 500);
}

// --- Original Signal Handlers ---
process.on('SIGINT', () => gracefulShutdown(false));
process.on('SIGTERM', () => gracefulShutdown(false));
// --- End Graceful Shutdown ---

// --- Start the application ---
main();
