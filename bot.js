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
// Add checks relevant to config/index.js expectations
console.log(`[Bot Start] PRIVATE_KEY exists = ${!!process.env.PRIVATE_KEY}, length = ${process.env.PRIVATE_KEY?.length}`);
const networkUpper = (process.env.NETWORK || 'arbitrum').toUpperCase();
console.log(`[Bot Start] ${networkUpper}_RPC_URLS exists = ${!!process.env[`${networkUpper}_RPC_URLS`]}`);
console.log(`[Bot Start] ${networkUpper}_FLASH_SWAP_ADDRESS exists = ${!!process.env[`${networkUpper}_FLASH_SWAP_ADDRESS`]}`);
// Check a sample pool env var expected by config/arbitrum.js + config/index.js
console.log(`[Bot Start] Example Pool Var (ARBITRUM_WETH_USDC_500_ADDRESS) exists = ${!!process.env.ARBITRUM_WETH_USDC_500_ADDRESS}`);
console.log(`[Bot Start] Example Borrow Var (BORROW_AMOUNT_WETH) exists = ${!!process.env.BORROW_AMOUNT_WETH}`);
// --- End .env loading ---

// --- Other Requires (AFTER dotenv) ---
const { ethers } = require('ethers');
const logger = require('./utils/logger');
const ErrorHandler = require('./utils/errorHandler');
const { getProvider } = require('./utils/provider'); // Only need getProvider
// --- CHANGE HERE: Require the consolidated config ---
const config = require('./config'); // Loads from config/index.js
// --- END CHANGE ---
const { ArbitrageEngine } = require('./core/arbitrageEngine'); // Keep engine import


// --- Main Application Logic ---

async function main() {
    logger.info('>>> PROJECT HAVOC ARBITRAGE BOT STARTING (inside main) <<<');
    logger.info('==============================================');

    let signer; // Define signer scope

    try {
        // 1. Config is loaded directly via require('./config') above
        //    The config object is already validated by config/index.js
        logger.info('[Main] Configuration loaded and validated.');

        // 2. Get Provider
        logger.info('[Main] Getting Provider instance...');
        // Ensure provider uses the potentially multiple URLs from the config
        const provider = getProvider(); // provider.js reads env directly, uses config.RPC_URLS
        logger.info('[Main] Provider instance obtained.');

        // 3. Initialize Signer
        logger.info('[Main] Initializing Signer...');
        // Use the validated private key from the config object
        const privateKeyWithPrefix = "0x" + config.PRIVATE_KEY; // Add 0x prefix for Wallet constructor
        signer = new ethers.Wallet(privateKeyWithPrefix, provider); // Create signer
        logger.info(`[Main] Signer ready for address: ${signer.address}`);

        // 4. Initialize Engine - Pass signer and the main config object
        logger.info('[Main] Initializing Arbitrage Engine...');
        // Pass the signer (Wallet instance) and the loaded config object
        const engine = new ArbitrageEngine(signer, config); // Pass config object
        await engine.initialize(); // Initialize should handle internal setup using config
        logger.info('[Main] Arbitrage Engine initialized.');

        // 5. Start Engine Loop
        await engine.start(); // Start should use internal config

        logger.info('[MainLoop] Main thread waiting indefinitely (engine loop running)...');
        await new Promise(() => {}); // Keep alive

    } catch (error) {
        // Use the specific ErrorHandler if possible
        const message = error.message || 'Unknown error';
        const context = 'MainProcess';
        logger.error(`!!! BOT FAILED TO START !!! Error during main execution in ${context}: ${message}`);
        if (error.stack) logger.error(`Stack: ${error.stack}`);

        if (ErrorHandler && typeof ErrorHandler.handleError === 'function') {
            // Pass the original error object
            ErrorHandler.handleError(error, context);
        } else {
            console.error(`[Main Emergency Log] ErrorHandler.handleError is not available. Raw Error:`, error);
        }
        process.exit(1);
    }
}

// --- Global Error Handlers ---
process.on('unhandledRejection', (reason, promise) => {
    const error = new Error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
    logger.error('!!! UNHANDLED REJECTION !!!');
    if (ErrorHandler && typeof ErrorHandler.handleError === 'function') {
        ErrorHandler.handleError(error, 'UnhandledRejection');
    } else {
        console.error(error);
    }
    // Decide if this should be fatal
    // process.exit(1);
});

process.on('uncaughtException', (error) => {
    logger.error('!!! UNCAUGHT EXCEPTION !!!');
    if (ErrorHandler && typeof ErrorHandler.handleError === 'function') {
        ErrorHandler.handleError(error, 'UncaughtException');
    } else {
        console.error(error);
    }
    // Uncaught exceptions are generally fatal
    process.exit(1);
});
// --- End Global Error Handlers ---

// --- Graceful Shutdown ---
let isShuttingDown = false;
function gracefulShutdown() {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info('>>> INITIATING GRACEFUL SHUTDOWN <<<');
    // Add cleanup logic here if needed (e.g., stop engine, close connections)
    // await engine?.stop(); // Example: Tell engine to stop
    logger.info('Shutdown tasks complete. Exiting.');
    process.exit(0);
}
process.on('SIGINT', gracefulShutdown); // Ctrl+C
process.on('SIGTERM', gracefulShutdown); // kill command
// --- End Graceful Shutdown ---

// --- Start the application ---
main();
