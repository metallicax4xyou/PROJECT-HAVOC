// /workspaces/arbitrum-flash/bot.js
// --- Corrected ErrorHandler function call ---
// --- Added Token Config Validation ---

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
const { TOKENS } = require('./constants/tokens'); // Import TOKENS early for validation
const { validateTokenConfig } = require('./utils/tokenUtils'); // Import the validator
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
    // Consider if gracefulShutdown should be called here, might mask the real error cause
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
    // Decide if you want to exit on unhandled rejections
    // setTimeout(() => process.exit(1), 2000);
});
// --- END DETAILED GLOBAL ERROR HANDLERS ---


// --- Main Application Logic ---
async function main() {
    logger.info('>>> PROJECT HAVOC ARBITRAGE BOT STARTING (inside main) <<<');
    logger.info('==============================================');

    let engine = null;

    try {
        // --- *** ADDED TOKEN CONFIG VALIDATION HERE *** ---
        try {
            validateTokenConfig(TOKENS); // Validate the loaded TOKENS object
        } catch (validationError) {
            logger.error(`Token Config Validation Failed: ${validationError.message}`);
            // No need to call ErrorHandler.handleError here, the validator throws a descriptive error.
            process.exit(1); // Exit immediately if tokens are invalid
        }
        // --- *** END TOKEN CONFIG VALIDATION *** ---


        // --- Requires Moved Inside Main ---
        const { getProvider } = require('./utils/provider');
        const config = require('./config'); // Load config *after* initial validation if needed
        const { ArbitrageEngine } = require('./core/arbitrageEngine');
        const FlashSwapManager = require('./core/flashSwapManager');
        // --- End Moved Requires ---


        // 1. Config Validation (Specific Bot Logic)
        // Note: Token validation already happened above. This checks bot-specific config.
        logger.info('[Main] Configuration loaded. Validating essential bot config...');
        if (!config || !config.PRIVATE_KEY || !config.POOL_CONFIGS || config.POOL_CONFIGS.length === 0) {
            // Log details about the loaded config object for debugging
            logger.error('[Main CRITICAL] Config loaded inside main() is missing essential properties (PRIVATE_KEY, POOL_CONFIGS)!', {
                 hasConfig: !!config,
                 hasPrivateKey: !!config?.PRIVATE_KEY,
                 hasPoolConfigs: Array.isArray(config?.POOL_CONFIGS),
                 poolConfigLength: config?.POOL_CONFIGS?.length
            });
            throw new Error("Failed to load valid bot config with essential properties (PRIVATE_KEY, POOL_CONFIGS) inside main function.");
        }
        logger.info('[Main] Essential bot configuration validated.');


        // 2. Get Provider
        logger.info('[Main] Getting Provider instance...');
        const provider = getProvider();
        logger.info('[Main] Provider instance obtained.');

        // 3. Initialize FlashSwapManager
        logger.info('[Main] Initializing Flash Swap Manager...');
        // These debug logs might be excessive now, consider removing later
        // logger.debug('[Main Debug] Passing config keys to FlashSwapManager:', config ? Object.keys(config) : 'Config is falsy!');
        // logger.debug('[Main Debug] Passing provider to FlashSwapManager:', !!provider);
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
        // Keep the bot running until shutdown signal
        await new Promise(() => {});

    } catch (error) {
        // Catch errors specifically from the main execution block
        const message = error.message || 'Unknown error during startup';
        const context = 'MainProcessStartup';
        logger.error(`!!! BOT FAILED TO START !!! Error during main execution in ${context}: ${message}`);
        if (error.stack) logger.error(`Stack: ${error.stack}`);

        // Use global error handler if available
        if (ErrorHandler && typeof ErrorHandler.handleError === 'function') {
             ErrorHandler.handleError(error, context);
        } else {
             console.error(`[Main Emergency Log] ErrorHandler.handleError is not available. Raw Error:`, error);
        }
        // Ensure exit on critical startup failure
        setTimeout(() => process.exit(1), 500); // Allow time for logging
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

    // Add cleanup tasks here (e.g., stop engine loop if possible)
    // if (engine) {
    //    logger.info('[Shutdown] Attempting to stop engine...');
    //    await engine.stop(); // Assuming engine has a stop method
    // }

    logger.warn('[Shutdown] Performing final cleanup...');

    // Exit
    logger.warn(`[Shutdown] Exiting process with code ${exitCode}...`);
    setTimeout(() => process.exit(exitCode), 500); // Allow time for final logs
}

// --- Original Signal Handlers ---
process.on('SIGINT', () => gracefulShutdown(false)); // Ctrl+C
process.on('SIGTERM', () => gracefulShutdown(false)); // Kill command
// --- End Graceful Shutdown ---

// --- Start the application ---
main(); // Call the main async function
