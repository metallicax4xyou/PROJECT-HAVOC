// bot.js
require('dotenv').config();

const logger = require('./utils/logger');
const ErrorHandler = require('./utils/errorHandler'); // Keep require if used
const { TOKENS } = require('./constants/tokens');
const { validateTokenConfig } = require('./utils/tokenUtils');
const { getProvider } = require('./utils/provider');
const { ethers } = require('ethers');
const FlashSwapManager = require('./core/flashSwapManager');
const ArbitrageEngine = require('./core/arbitrageEngine');
const SwapSimulator = require('./core/swapSimulator');
const GasEstimator = require('./utils/gasEstimator');
const config = require('./config');

// --- Graceful Shutdown (Keep as is) ---
let isShuttingDown = false; let arbitrageEngineInstance = null; async function gracefulShutdown(signal) { /* ... */ }
process.on('SIGINT', () => gracefulShutdown('SIGINT')); process.on('SIGTERM', () => gracefulShutdown('SIGTERM')); process.on('uncaughtException', (error, origin) => { /* ... */ }); process.on('unhandledRejection', (reason, promise) => { /* ... */ });

// --- Main Bot Logic ---
async function main() {
    logger.info('\n==============================================');
    logger.info('>>> PROJECT HAVOC ARBITRAGE BOT STARTING <<<');
    logger.info('==============================================');
    let flashSwapManagerInstance = null; let provider = null; let swapSimulatorInstance = null; let gasEstimatorInstance = null;
    try {
        // --- STEP 1 ---
        logger.info('[Main] Step 1: Validating token configuration...');
        validateTokenConfig(TOKENS);
        logger.info('[Main] Step 1: Token configuration validated.');

        // --- STEP 2 ---
        logger.info('[Main] Step 2: Getting Provider instance...');
        provider = getProvider(config.RPC_URLS);
        if (!provider) { throw new Error("Failed to get provider instance."); }
        logger.debug('[Main] Step 2a: Provider instance obtained. Fetching network...');
        const network = await provider.getNetwork();
        logger.info(`[Main] Step 2b: Provider connected to ${network.name} (ID: ${network.chainId})`); // LAST SEEN LOG

        // --- STEP 3 ---
        logger.debug('[Main] Step 3: Augmenting config with provider...');
        config.provider = provider;
        logger.debug('[Main] Step 3: Added provider to config object.');

        // --- STEP 4 ---
        logger.info('[Main] Step 4: Initializing Swap Simulator...');
        if (!SwapSimulator || typeof SwapSimulator !== 'function') { throw new TypeError(`SwapSimulator class not loaded or invalid.`); }
        logger.debug('[Main] Step 4a: Calling SwapSimulator constructor...');
        try {
            swapSimulatorInstance = new SwapSimulator(config, provider);
        } catch (simError) { logger.error("!!! CRASH DURING SwapSimulator INSTANTIATION !!!", simError); throw simError; }
        logger.debug('[Main] Step 4b: SwapSimulator constructor returned.');
        logger.info('[Main] Step 4: Swap Simulator initialized.');

        // --- STEP 5 ---
        logger.info('[Main] Step 5: Initializing Gas Estimator...');
        if (!GasEstimator || typeof GasEstimator !== 'function') { throw new TypeError(`GasEstimator class not loaded or invalid.`); }
        logger.debug('[Main] Step 5a: Calling GasEstimator constructor...');
         try {
            gasEstimatorInstance = new GasEstimator(config, provider);
         } catch (gasError) { logger.error("!!! CRASH DURING GasEstimator INSTANTIATION !!!", gasError); throw gasError; }
        logger.debug('[Main] Step 5b: GasEstimator constructor returned.');
        logger.info('[Main] Step 5: Gas Estimator initialized.');

        // --- STEP 6 ---
        logger.info('[Main] Step 6: Initializing Flash Swap Manager...');
        if (!FlashSwapManager || typeof FlashSwapManager !== 'function') { throw new TypeError(`FlashSwapManager class not loaded or invalid.`); }
        logger.debug('[Main] Step 6a: Calling FlashSwapManager constructor...');
         try {
             flashSwapManagerInstance = new FlashSwapManager(config, provider);
         } catch (fsmError) { logger.error("!!! CRASH DURING FlashSwapManager INSTANTIATION !!!", fsmError); throw fsmError; }
        logger.debug('[Main] Step 6b: FlashSwapManager constructor returned.');
        const signerAddress = await flashSwapManagerInstance.getSignerAddress(); logger.info(`[Main] Step 6: Flash Swap Manager initialized. Signer: ${signerAddress}`);
        const contractTarget = flashSwapManagerInstance.getFlashSwapContract()?.target; logger.info(`[Main] Using FlashSwap contract at: ${contractTarget || 'Not Initialized'}`);

        // --- STEP 7 ---
        logger.info('[Main] Step 7: Initializing Arbitrage Engine...');
        if (!ArbitrageEngine || typeof ArbitrageEngine !== 'function') { throw new TypeError(`ArbitrageEngine constructor not found!`); }
         logger.debug('[Main] Step 7a: Calling ArbitrageEngine constructor...');
         try {
            arbitrageEngineInstance = new ArbitrageEngine(config, provider, swapSimulatorInstance, gasEstimatorInstance);
         } catch (aeError) { logger.error("!!! CRASH DURING ArbitrageEngine INSTANTIATION !!!", aeError); throw aeError; }
        logger.debug('[Main] Step 7b: ArbitrageEngine constructor returned.');
        logger.info('[Main] Step 7: Arbitrage Engine initialized.');

        // --- STEP 8 ---
        logger.info('[Main] Step 8: Setting up event listeners...');
        arbitrageEngineInstance.on('profitableOpportunities', (trades) => { /* ... */ });
        logger.info('[Main] Step 8: Event listeners set up.');

        // --- STEP 9 ---
        logger.info('[Main] Step 9: Starting Arbitrage Engine cycle...');
        await arbitrageEngineInstance.start(); // This includes the first runCycle

        logger.info('\n>>> BOT IS RUNNING <<<'); logger.info('(Press Ctrl+C to stop)'); logger.info('======================');

    } catch (error) {
        const errorType = error instanceof Error ? error.constructor.name : 'UnknownError';
        // Log the step where the error occurred if possible (though main catch might obscure it)
        logger.error(`!!! BOT FAILED STARTUP !!! [Type: ${errorType}]`, error);
        // Use ErrorHandler if available and configured
        if (ErrorHandler && ErrorHandler.handleError) { ErrorHandler.handleError(error, 'MainProcessStartup'); }
        logger.error('Exiting due to critical startup error...');
        process.exit(1);
    }
}

// --- Global Handlers remain the same ---
// process.on('SIGINT', ...); process.on('SIGTERM', ...); process.on('uncaughtException', ...); process.on('unhandledRejection', ...);

// --- Start Main Execution ---
main().catch(error => {
    const errorType = error instanceof Error ? error.constructor.name : 'UnknownError';
    logger.error(`!!! UNEXPECTED CRITICAL ERROR IN MAIN EXECUTION !!! [Type: ${errorType}]`, error);
    if (ErrorHandler && ErrorHandler.handleError) { ErrorHandler.handleError(error, 'MainExecutionCatch'); }
    process.exit(1);
});
