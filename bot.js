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
const { ethers } = require('ethers');
const logger = require('./utils/logger');
const ErrorHandler = require('./utils/errorHandler');
const { getProvider } = require('./utils/provider'); // Only need getProvider
const Config = require('./utils/config');
const { ArbitrageEngine } = require('./core/arbitrageEngine');


// --- Main Application Logic ---

async function main() {
    logger.info('>>> PROJECT HAVOC ARBITRAGE BOT STARTING (inside main) <<<');
    logger.info('==============================================');

    let signer; // Define signer scope

    try {
        // 1. Load Config
        logger.info('[Main] Loading and validating configuration...');
        const networkConfig = Config.getNetworkConfig();
        logger.info('[Main] Configuration validated successfully.');

        // 2. Get Provider
        logger.info('[Main] Getting Provider instance...');
        const provider = getProvider();
        logger.info('[Main] Provider instance obtained.');

        // 3. Initialize Signer
        logger.info('[Main] Initializing Signer...');
        const privateKey = process.env.PRIVATE_KEY;
        if (!privateKey || !/^[a-fA-F0-9]{64}$/.test(privateKey)) {
             throw new Error("CRITICAL: Invalid or missing PRIVATE_KEY environment variable for signer creation.");
        }
        signer = new ethers.Wallet(privateKey, provider); // Create signer
        logger.info(`[Main] Signer ready for address: ${signer.address}`);

        // 4. Initialize Engine - *** PASS SIGNER TO CONSTRUCTOR ***
        logger.info('[Main] Initializing Arbitrage Engine...');
        const engine = new ArbitrageEngine(signer); // Pass the created signer instance
        await engine.initialize();
        logger.info('[Main] Arbitrage Engine initialized.');

        // 5. Start Engine Loop
        await engine.start();

        logger.info('[MainLoop] Main thread waiting indefinitely (engine loop running)...');
        await new Promise(() => {}); // Keep alive

    } catch (error) {
        console.error("!!! BOT FAILED TO START !!! Error during main execution:", error);
        if (ErrorHandler && typeof ErrorHandler.handleError === 'function') {
            ErrorHandler.handleError(error, 'MainProcess');
        } else {
            console.error("[Main Emergency Log] ErrorHandler.handleError is not available. Raw Error:", error);
        }
        process.exit(1);
    }
}

// --- Global Error Handlers (remain the same) ---
process.on('unhandledRejection', (reason, promise) => { /* ... */ });
process.on('uncaughtException', (error) => { /* ... */ });

// --- Graceful Shutdown (remain the same) ---
function gracefulShutdown() { /* ... */ }
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// --- Start the application ---
main();
