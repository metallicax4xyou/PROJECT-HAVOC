// /workspaces/arbitrum-flash/bot.js

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
console.log(`[Bot Start] ARBITRUM_RPC_URLS exists = ${!!process.env.ARBITRUM_RPC_URLS}`);
console.log(`[Bot Start] FLASH_SWAP_ADDRESS exists = ${!!process.env.FLASH_SWAP_ADDRESS}`);
console.log(`[Bot Start] WETH_USDC_POOLS loaded length = ${process.env.WETH_USDC_POOLS?.length || 0}`);
// --- End .env loading ---

// --- Other Requires (AFTER dotenv) ---
const { ethers } = require('ethers'); // Need ethers for Wallet
const logger = require('./utils/logger');
// ErrorHandler exports { ArbitrageError, handleError }
const ErrorHandler = require('./utils/errorHandler');
// Provider exports { provider, getProvider }
const { getProvider } = require('./utils/provider'); // Only need getProvider here
const Config = require('./utils/config');
const { ArbitrageEngine } = require('./core/arbitrageEngine');


// --- Main Application Logic ---

async function main() {
    logger.info('>>> PROJECT HAVOC ARBITRAGE BOT STARTING (inside main) <<<');
    logger.info('==============================================');

    let signer; // Define signer here to be accessible in catch block if needed

    try {
        // 1. Load Config (triggers internal validation)
        logger.info('[Main] Loading and validating configuration...');
        const networkConfig = Config.getNetworkConfig(); // Validates required ENV vars
        logger.info('[Main] Configuration validated successfully.');

        // 2. Get Provider (Initialization happens inside provider.js)
        logger.info('[Main] Getting Provider instance...');
        const provider = getProvider(); // Call the exported function
        // Optional: Add a small delay or check if provider connection test passed if needed
        logger.info('[Main] Provider instance obtained.');

        // 3. Initialize Signer (using PRIVATE_KEY and the obtained provider)
        logger.info('[Main] Initializing Signer...');
        const privateKey = process.env.PRIVATE_KEY;
        if (!privateKey || !/^[a-fA-F0-9]{64}$/.test(privateKey)) {
             // This validation is technically done in config.js, but good safeguard
             throw new Error("CRITICAL: Invalid or missing PRIVATE_KEY environment variable for signer creation.");
        }
        signer = new ethers.Wallet(privateKey, provider);
        logger.info(`[Main] Signer ready for address: ${signer.address}`);

        // 4. Initialize Engine (Pass dependencies if constructor requires them)
        logger.info('[Main] Initializing Arbitrage Engine...');
        // Modify constructor call if Engine needs provider/signer explicitly
        // const engine = new ArbitrageEngine(provider, signer, networkConfig); // Example
        const engine = new ArbitrageEngine(); // Assuming engine gets provider/signer via utils
        await engine.initialize();
        logger.info('[Main] Arbitrage Engine initialized.');

        // 5. Start Engine Loop
        await engine.start();

        logger.info('[MainLoop] Main thread waiting indefinitely (engine loop running)...');
        await new Promise(() => {}); // Keep alive

    } catch (error) {
        console.error("!!! BOT FAILED TO START !!! Error during main execution:", error);
        // --- FIXED: Use handleError instead of logError ---
        if (ErrorHandler && typeof ErrorHandler.handleError === 'function') {
            ErrorHandler.handleError(error, 'MainProcess');
        } else {
            console.error("[Main Emergency Log] ErrorHandler.handleError is not available. Raw Error:", error);
        }
        process.exit(1);
    }
}

// --- Global Error Handlers ---
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // --- FIXED: Use handleError instead of logError ---
    if (ErrorHandler && typeof ErrorHandler.handleError === 'function') {
        ErrorHandler.handleError(reason instanceof Error ? reason : new Error(`Unhandled Rejection: ${reason}`), 'UnhandledRejection');
    } else {
        console.error("[Emergency Log] Unhandled Rejection: ErrorHandler not available.");
    }
});

process.on('uncaughtException', (error) => {
    console.error(`Uncaught Exception: ${error.message}`);
     // --- FIXED: Use handleError instead of logError ---
    if (ErrorHandler && typeof ErrorHandler.handleError === 'function') {
        ErrorHandler.handleError(error, 'UncaughtException');
    } else {
         console.error("[Emergency Log] Uncaught Exception: ErrorHandler not available.");
    }
    process.exit(1);
});

// --- Graceful Shutdown ---
function gracefulShutdown() {
    logger.info("Shutdown signal received. Cleaning up...");
    // Add cleanup logic here
    // if (engine) engine.stop(); // Need access to engine instance
    setTimeout(() => {
        logger.info("Exiting.");
        process.exit(0);
    }, 500);
}
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// --- Start the application ---
main();
