// /workspaces/arbitrum-flash/bot.js
// --- VERSION MOVED REQUIRES INSIDE main() TO AVOID POTENTIAL CIRCULAR DEPENDENCY ---

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

// --- Minimal Top-Level Requires ---
const logger = require('./utils/logger'); // Logger is generally safe
const ErrorHandler = require('./utils/errorHandler'); // Error handler likely safe
// --- END Minimal Top-Level Requires ---


// --- Main Application Logic ---
async function main() {
    logger.info('>>> PROJECT HAVOC ARBITRAGE BOT STARTING (inside main) <<<');
    logger.info('==============================================');

    try {
        // --- *** Moved Requires Inside Main *** ---
        const { getProvider } = require('./utils/provider');
        const config = require('./config'); // Require config HERE
        const { ArbitrageEngine } = require('./core/arbitrageEngine');
        const FlashSwapManager = require('./core/flashSwapManager');
        // --- *** End Moved Requires *** ---


        // 1. Config is loaded via require above
        logger.info('[Main] Configuration loaded and validated.');
        // Add a check right after requiring config inside main
        if (!config || !config.PRIVATE_KEY) {
             logger.error('[Main CRITICAL] Config loaded inside main() is still missing or invalid!', config ? Object.keys(config) : 'Config is falsy');
             throw new Error("Failed to load valid config inside main function.");
        }

        // 2. Get Provider
        logger.info('[Main] Getting Provider instance...');
        const provider = getProvider();
        logger.info('[Main] Provider instance obtained.');

        // 3. Initialize FlashSwapManager (Handles Signer, NonceManager, Contract)
        logger.info('[Main] Initializing Flash Swap Manager...');
        logger.debug('[Main Debug] Passing config to FlashSwapManager:', config ? Object.keys(config) : 'Config is falsy!'); // Keep debug log
        logger.debug('[Main Debug] Passing provider to FlashSwapManager:', !!provider);
        const flashSwapManager = new FlashSwapManager(config, provider); // Pass config and provider
        logger.info(`[Main] Flash Swap Manager initialized. Signer Address: ${flashSwapManager.getSigner().address}`);

        // 4. Initialize Engine - Pass the MANAGER instance and config object
        logger.info('[Main] Initializing Arbitrage Engine...');
        const engine = new ArbitrageEngine(flashSwapManager, config); // Pass manager, config
        await engine.initialize();
        logger.info('[Main] Arbitrage Engine initialized.');

        // 5. Start Engine Loop
        await engine.start();

        logger.info('[MainLoop] Main thread waiting indefinitely (engine loop running)...');
        await new Promise(() => {}); // Keep alive

    } catch (error) {
        const message = error.message || 'Unknown error';
        const context = 'MainProcess';
        logger.error(`!!! BOT FAILED TO START !!! Error during main execution in ${context}: ${message}`);
        if (error.stack) logger.error(`Stack: ${error.stack}`);
        if (ErrorHandler && typeof ErrorHandler.handleError === 'function') { ErrorHandler.handleError(error, context); }
        else { console.error(`[Main Emergency Log] ErrorHandler.handleError is not available. Raw Error:`, error); }
        process.exit(1);
    }
}

// --- Global Error Handlers (Keep as is) ---
process.on('unhandledRejection', (reason, promise) => { /* ... */ });
process.on('uncaughtException', (error) => { /* ... */ });
// --- End Global Error Handlers ---

// --- Graceful Shutdown (Keep as is) ---
let isShuttingDown = false;
function gracefulShutdown() { /* ... */ }
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
// --- End Graceful Shutdown ---

// --- Start the application ---
main();
