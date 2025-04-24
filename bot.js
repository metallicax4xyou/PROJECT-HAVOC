// bot.js
// --- VERSION with explicit checks before AE instantiation ---
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

// --- Graceful Shutdown ---
let isShuttingDown = false; let arbitrageEngineInstance = null;
async function gracefulShutdown(signal) {
    if (isShuttingDown) return; isShuttingDown = true; logger.warn(`Received ${signal}. Shutdown...`);
    if (arbitrageEngineInstance) { try { arbitrageEngineInstance.stop(); logger.info("Engine stopped."); } catch (error) { logger.error("Error stopping Engine:", error); ErrorHandler?.handleError(error, 'GracefulShutdownStop'); }} else { logger.warn("Engine instance not found."); }
    logger.info("Shutdown complete. Exiting."); process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT')); process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', (error, origin) => { logger.error('--- UNCAUGHT EXCEPTION ---', { error: error?.message, origin }); ErrorHandler?.handleError(error, `UncaughtException (${origin})`); process.exit(1); });
process.on('unhandledRejection', (reason, promise) => { logger.error('--- UNHANDLED REJECTION ---', { reason }); const error = reason instanceof Error ? reason : new Error(`Unhandled Rejection: ${JSON.stringify(reason)}`); ErrorHandler?.handleError(error, 'UnhandledRejection'); });

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
        logger.info(`[Main] Step 2b: Provider connected to ${network.name} (ID: ${network.chainId})`);

        // --- STEP 3 ---
        logger.debug('[Main] Step 3: Augmenting config with provider...');
        config.provider = provider;
        logger.debug('[Main] Step 3: Added provider to config object.');

        // --- STEP 4 ---
        logger.info('[Main] Step 4: Initializing Swap Simulator...');
        if (!SwapSimulator || typeof SwapSimulator !== 'function') { throw new TypeError(`SwapSimulator class not loaded or invalid.`); }
        logger.debug('[Main] Step 4a: Calling SwapSimulator constructor...');
        try { swapSimulatorInstance = new SwapSimulator(config, provider); } catch (simError) { logger.error("!!! CRASH DURING SwapSimulator INSTANTIATION !!!", simError); throw simError; }
        logger.debug('[Main] Step 4b: SwapSimulator constructor returned.');
        logger.info('[Main] Step 4: Swap Simulator initialized.');

        // --- STEP 5 ---
        logger.info('[Main] Step 5: Initializing Gas Estimator...');
        if (!GasEstimator || typeof GasEstimator !== 'function') { throw new TypeError(`GasEstimator class not loaded or invalid.`); }
        logger.debug('[Main] Step 5a: Calling GasEstimator constructor...');
         try { gasEstimatorInstance = new GasEstimator(config, provider); } catch (gasError) { logger.error("!!! CRASH DURING GasEstimator INSTANTIATION !!!", gasError); throw gasError; }
        logger.debug('[Main] Step 5b: GasEstimator constructor returned.');
        logger.info('[Main] Step 5: Gas Estimator initialized.');

        // --- STEP 6 ---
        logger.info('[Main] Step 6: Initializing Flash Swap Manager...');
        if (!FlashSwapManager || typeof FlashSwapManager !== 'function') { throw new TypeError(`FlashSwapManager class invalid.`); }
        logger.debug('[Main] Step 6a: Calling FlashSwapManager constructor...');
         try { flashSwapManagerInstance = new FlashSwapManager(config, provider); } catch (fsmError) { logger.error("!!! CRASH FlashSwapManager INST !!!", fsmError); throw fsmError; }
        logger.debug('[Main] Step 6b: FlashSwapManager constructor returned.');
        // *** Explicit check immediately after instantiation ***
        if (!flashSwapManagerInstance || typeof flashSwapManagerInstance.getSignerAddress !== 'function') {
             logger.error(`[Main] CRITICAL: flashSwapManagerInstance invalid AFTER construction! Type: ${typeof flashSwapManagerInstance}`);
             throw new Error("FlashSwapManager instantiation failed silently or returned invalid object.");
        }
        logger.debug('[Main] Step 6c: Instance validity check passed.'); // Log success
        const signerAddress = await flashSwapManagerInstance.getSignerAddress(); logger.info(`[Main] Step 6: Flash Swap Manager initialized. Signer: ${signerAddress}`);
        const contractTarget = flashSwapManagerInstance.getFlashSwapContract()?.target; logger.info(`[Main] Using FlashSwap contract at: ${contractTarget || 'Not Initialized'}`);

        // --- STEP 7 ---
        logger.info('[Main] Step 7: Initializing Arbitrage Engine...');
        if (!ArbitrageEngine || typeof ArbitrageEngine !== 'function') { throw new TypeError(`ArbitrageEngine constructor invalid.`); }
         // *** Explicit check right before passing ***
         logger.debug(`[Main] Step 7a: Validating FSM instance before passing to AE: Instance Exists? ${!!flashSwapManagerInstance}, Has getSignerAddress? ${!!flashSwapManagerInstance?.getSignerAddress}`);
         if (!flashSwapManagerInstance || typeof flashSwapManagerInstance.getSignerAddress !== 'function') {
              logger.error(`[Main] CRITICAL FSM Validation Failed just before AE init. Instance: ${flashSwapManagerInstance}, Method Type: ${typeof flashSwapManagerInstance?.getSignerAddress}`);
              throw new Error("Cannot init ArbitrageEngine: flashSwapManagerInstance is invalid before passing.");
         }
         logger.debug('[Main] Step 7b: Calling ArbitrageEngine constructor...');
         try {
             // Pass all required dependencies
             arbitrageEngineInstance = new ArbitrageEngine(config, provider, swapSimulatorInstance, gasEstimatorInstance, flashSwapManagerInstance);
         } catch (aeError) {
             logger.error("!!! CRASH DURING ArbitrageEngine INSTANTIATION !!!", aeError);
             // Log the error type that AE constructor received/threw
             if (aeError instanceof Error) { logger.error(`AE Error Type: ${aeError.constructor.name}, Message: ${aeError.message}`); }
             throw aeError;
         }
        logger.debug('[Main] Step 7c: ArbitrageEngine constructor returned.');
        logger.info('[Main] Step 7: Arbitrage Engine initialized.');

        // --- STEP 8 ---
        logger.info('[Main] Step 8: Setting up event listeners...');
        arbitrageEngineInstance.on('profitableOpportunities', (trades) => { /* ... */ });
        logger.info('[Main] Step 8: Event listeners set up.');

        // --- STEP 9 ---
        logger.info('[Main] Step 9: Starting Arbitrage Engine cycle...');
        await arbitrageEngineInstance.start();

        logger.info('\n>>> BOT IS RUNNING <<<'); logger.info('(Press Ctrl+C to stop)'); logger.info('======================');

    } catch (error) { /* ... Unchanged Error Handling ... */
        const errorType = error instanceof Error ? error.constructor.name : 'UnknownError'; logger.error(`!!! BOT FAILED STARTUP !!! [Type: ${errorType}]`, error); if (ErrorHandler && ErrorHandler.handleError) { ErrorHandler.handleError(error, 'MainProcessStartup'); } logger.error('Exiting due to critical startup error...'); process.exit(1);
    }
}

// --- Start Main Execution ---
main().catch(error => { /* ... Unchanged Error Handling ... */
    const errorType = error instanceof Error ? error.constructor.name : 'UnknownError'; logger.error(`!!! UNEXPECTED CRITICAL ERROR IN MAIN !!! [Type: ${errorType}]`, error); if (ErrorHandler && ErrorHandler.handleError) { ErrorHandler.handleError(error, 'MainExecutionCatch'); } process.exit(1);
});
