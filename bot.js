// /workspaces/arbitrum-flash/bot.js

// --- Force .env loading FIRST ---
console.log('[Bot Start] Attempting to load .env...');
const dotenvResult = require('dotenv').config(); // Default path is project root/.env
if (dotenvResult.error) {
    console.error('[Bot Start] FATAL: Error loading .env file:', dotenvResult.error);
    process.exit(1); // Exit if .env fails to load
}
console.log('[Bot Start] .env loaded check. Verifying key vars from process.env...');
// Verify crucial vars loaded from .env into process.env
console.log(`[Bot Start] NETWORK = ${process.env.NETWORK}`);
console.log(`[Bot Start] PRIVATE_KEY exists = ${!!process.env.PRIVATE_KEY}, length = ${process.env.PRIVATE_KEY?.length}`);
// Check the PLURAL version based on previous grep results for provider.js
console.log(`[Bot Start] ARBITRUM_RPC_URLS exists = ${!!process.env.ARBITRUM_RPC_URLS}`);
console.log(`[Bot Start] FLASH_SWAP_ADDRESS exists = ${!!process.env.FLASH_SWAP_ADDRESS}`);
console.log(`[Bot Start] WETH_USDC_POOLS loaded length = ${process.env.WETH_USDC_POOLS?.length || 0}`);
// --- End .env loading ---

// --- Other Requires (AFTER dotenv) ---
const { ArbitrageEngine } = require('./core/arbitrageEngine'); // Engine uses Config, Provider, Signer
const logger = require('./utils/logger'); // Logger might be used early
const ErrorHandler = require('./utils/errorHandler');
const { initializeProvider, getSigner } = require('./utils/provider'); // Provider uses env vars
const Config = require('./utils/config'); // Config reads env vars


// --- Main Application Logic ---

async function main() {
    // Logger should be safe to use now
    logger.info('>>> PROJECT HAVOC ARBITRAGE BOT STARTING (inside main) <<<');
    logger.info('==============================================');

    try {
        // 1. Load Config (triggers internal validation using populated process.env)
        // Config.getNetworkConfig() will likely be called implicitly or explicitly soon.
        // We can call it here to ensure validation passes before proceeding.
        logger.info('[Main] Loading and validating configuration...');
        const networkConfig = Config.getNetworkConfig(); // This will run validation checks based on process.env
        logger.info('[Main] Configuration validated successfully.');

        // 2. Initialize Provider (uses config/env vars)
        logger.info('[Main] Initializing Provider...');
        await initializeProvider(); // Ensure this uses the correct RPC from process.env.ARBITRUM_RPC_URLS
        logger.info('[Main] Provider initialized.');

        // 3. Initialize Signer (uses provider and env vars)
        logger.info('[Main] Initializing Signer...');
        const signer = getSigner(); // Ensure this uses the correct PRIVATE_KEY from process.env
        logger.info('[Main] Signer initialized.');

        // 4. Initialize Engine (uses config, provider, signer)
        logger.info('[Main] Initializing Arbitrage Engine...');
        const engine = new ArbitrageEngine(); // Constructor should now have access to valid config and provider/signer
        await engine.initialize(); // Any async engine setup
        logger.info('[Main] Arbitrage Engine initialized.');

        // 5. Start Engine Loop
        await engine.start();

        // Keep the main thread alive
        logger.info('[MainLoop] Main thread waiting indefinitely (engine loop running)...');
        await new Promise(() => {}); // Keep alive indefinitely

    } catch (error) {
        // Catch critical startup errors (e.g., invalid config, provider connection fail)
        logger.fatal(`[Main] CRITICAL ERROR DURING BOT INITIALIZATION OR STARTUP: ${error.message}`, { stack: error.stack });
        ErrorHandler.logError(error, 'MainProcess');
        console.error("!!! BOT FAILED TO START !!!"); // Ensure visibility
        process.exit(1); // Exit on critical startup failure
    }
}

// --- Global Error Handlers ---
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    logger.error('Unhandled Rejection', { reason: reason, stack: reason?.stack });
    ErrorHandler.logError(reason, 'UnhandledRejection');
    // Decide if you want to exit on unhandled rejections
    // process.exit(1);
});

process.on('uncaughtException', (error) => {
    console.error(`Uncaught Exception: ${error.message}`);
    logger.fatal('Uncaught Exception', { message: error.message, stack: error.stack });
    ErrorHandler.logError(error, 'UncaughtException');
    process.exit(1); // Mandatory exit after uncaught exception
});

// --- Graceful Shutdown ---
process.on('SIGINT', () => {
    logger.info("SIGINT received. Shutting down gracefully...");
    // Add cleanup logic here if needed (e.g., stop engine monitoring, close connections)
    // Example: if (engine) engine.stop();
    process.exit(0);
});
process.on('SIGTERM', () => {
    logger.info("SIGTERM received. Shutting down gracefully...");
    // Add cleanup logic here if needed
    process.exit(0);
});


// --- Start the application ---
main(); // Execute the main async function
