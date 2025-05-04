// bot.js
// Arbitrage Bot Entry Point
// --- VERSION 1.2 --- Pass GasEstimator CLASS to ArbitrageEngine constructor.

require('dotenv').config(); // Load environment variables from .env file

const { ethers } = require('ethers'); // Ensure ethers is available
const config = require('./config'); // Load configuration
const { getProvider } = require('./utils/provider'); // Import provider utility
const logger = require('./utils/logger'); // Import logger utility
const { handleError, ArbitrageError } = require('./utils/errorHandler'); // Import error handling
// Import component Classes
const ArbitrageEngine = require('./core/arbitrageEngine');
const SwapSimulator = require('./core/swapSimulator');
const GasEstimator = require('./utils/gasEstimator'); // Import GasEstimator CLASS
const FlashSwapManager = require('./core/flashSwapManager');
const TradeHandler = require('./core/tradeHandler'); // Import TradeHandler CLASS


async function main() {
    logger.info('\n==============================================');
    logger.info('>>> PROJECT HAVOC ARBITRAGE BOT STARTING <<<');
    logger.info('==============================================');

    let provider;
    let flashSwapManager; // Define flashSwapManager outside try for cleanup

    try {
        // Step 1: Validate token configuration (Assuming this is done by config loader helpers)
        logger.info('[Main] Step 1: Token configuration validated.'); // Placeholder, validation is in config helpers

        // Step 2: Get Provider instance
        logger.info('[Main] Step 2: Getting Provider instance...');
        // getProvider handles FallbackProvider and config loading
        provider = getProvider(config);
        logger.debug('[Main] Step 2a: Provider instance obtained. Fetching network...');

        // Wait for provider to connect and fetch network details to ensure it's working
        const network = await provider.getNetwork();
        logger.info(`[Main] Step 2b: Provider connected to ${network.name} (ID: ${network.chainId})`);
         // Optional: Log current block number to confirm connectivity is live/forked
        const currentBlock = await provider.getBlockNumber();
         logger.info(`[Main] Provider Current Block: ${currentBlock}`);


        // Step 3: Augment config with provider (pass provider to config object)
         // This might be redundant if config itself loads provider, but ensures provider is attached.
         // Check if config object already has a provider property before adding.
         if (!config.provider) {
              config.provider = provider;
              logger.debug('[Main] Step 3: Added provider to config object.');
         } else {
              logger.debug('[Main] Step 3: Config already contains provider.');
         }


        // Step 4: Initializing Swap Simulator
        logger.info('[Main] Step 4: Initializing Swap Simulator...');
        // SwapSimulator constructor needs provider and config
        logger.debug('[Main] Step 4a: Calling SwapSimulator constructor...');
        const swapSimulator = new SwapSimulator(config, provider);
        logger.debug('[Main] Step 4b: SwapSimulator constructor returned.');
         // Add a check after initialization
         if (swapSimulator?.simulateSwap) { // Basic check for instance validity
              logger.info('[Main] Step 4: Swap Simulator initialized.');
         } else {
              const errorMsg = 'Swap Simulator failed to initialize correctly.';
              logger.error(`[Main] CRITICAL: ${errorMsg}`);
              throw new ArbitrageError('InitializationError', errorMsg);
         }


        // Step 5: Initializing Flash Swap Manager
        // FSM needs config and provider, handles ABI loading internally now
        logger.info('[Main] Step 6: Initializing Flash Swap Manager...'); // Corrected step number sequence
        logger.debug('[Main] Step 6a: Calling FlashSwapManager constructor...');
        flashSwapManager = new FlashSwapManager(config, provider); // Needs config and provider
        logger.debug('[Main] Step 6b: FlashSwapManager constructor returned.');
         // Add validity check for FSM instance
         if (flashSwapManager?.getFlashSwapContract && flashSwapManager?.getSignerAddress) { // Basic checks
             logger.debug('[Main] Step 6c: Instance validity check passed.');
             logger.info(`[Main] Step 6: Flash Swap Manager initialized. Signer: ${await flashSwapManager.getSignerAddress()}`);
              logger.info(`[Main] Using FlashSwap contract at: ${flashSwapManager.getFlashSwapContract()?.address || 'N/A'}`);
         } else {
             const errorMsg = 'Flash Swap Manager failed to initialize correctly.';
              logger.error(`[Main] CRITICAL: ${errorMsg}`);
              throw new ArbitrageError('InitializationError', errorMsg);
         }


         // Step 5 (Moved): Initializing Gas Estimator
         // GasEstimator now requires the FlashSwap ABI, obtained from the initialized FlashSwapManager
         logger.info('[Main] Step 5: Initializing Gas Estimator...'); // Corrected step number
         // We pass the GasEstimator CLASS directly to ArbitrageEngine,
         // which will get the ABI from FSM and create the instance.
         // No need to create the GasEstimator instance here anymore.
         // Skipping instance creation here: const gasEstimator = new GasEstimator(config, provider, flashSwapABI); // REMOVED from v1.1

        // Step 7: Initializing Arbitrage Engine
        logger.info('[Main] Step 7: Initializing Arbitrage Engine...');
        // Pass *Classes* for components that AE manages/initializes internally
        logger.debug('[Main] Step 7a: Validating FSM instance before passing to AE: Instance Exists? true, Has getSignerAddress? true'); // Check validity before passing
         const isFsmValidForAE = flashSwapManager && typeof flashSwapManager.getSignerAddress === 'function' && typeof flashSwapManager.getFlashSwapABI === 'function';
         if (!isFsmValidForAE) {
             const errorMsg = 'FlashSwapManager instance is invalid for ArbitrageEngine initialization.';
             logger.error(`[Main] CRITICAL: ${errorMsg}`);
             throw new ArbitrageError('InitializationError', errorMsg);
         }

        logger.debug('[Main] Step 7b: Calling ArbitrageEngine constructor...');
        const arbitrageEngine = new ArbitrageEngine(
            config,
            provider,
            swapSimulator,
            GasEstimator, // Pass the GasEstimator CLASS here
            flashSwapManager, // Pass the FlashSwapManager instance
            TradeHandler // Pass the TradeHandler CLASS here
        );
        logger.debug('[Main] Step 7c: ArbitrageEngine constructor returned.');
         // Add validity check for AE instance
         if (arbitrageEngine?.start && arbitrageEngine?.stop && arbitrageEngine?.runCycle) { // Basic checks
              logger.info('[Main] Step 7: Arbitrage Engine initialized.');
         } else {
             const errorMsg = 'Arbitrage Engine failed to initialize correctly.';
             logger.error(`[Main] CRITICAL: ${errorMsg}`);
             throw new ArbitrageError('InitializationError', errorMsg);
         }


        // Step 8: Set up event listeners (Moved into ArbitrageEngine constructor)
        logger.info('[Main] Step 8: Event listeners set up. AE handles dispatch.'); // Placeholder/Info


        // Step 9: Start the arbitrage cycle
        logger.info('[Main] Step 9: Starting Arbitrage Engine cycle...');
        await arbitrageEngine.start(); // Start the engine's main loop


        // The script will now keep running because the ArbitrageEngine is running its interval cycle.
        // Keep the main process alive indefinitely.
        // You'll need to press Ctrl+C to stop the bot.

    } catch (error) {
        logger.error('!!! CRASH DURING STARTUP !!!', error);
        // Use central error handler for reporting/cleanup
        handleError(error, 'MainProcessStartup');
        logger.error('Exiting due to critical startup error...');
        process.exit(1); // Exit with a non-zero code to indicate failure
    }

     // Keep the process alive, but set up graceful shutdown
     process.stdin.resume(); // Keep the process from exiting immediately
     process.on('SIGINT', async () => {
         logger.info('\nSIGINT received. Shutting down bot...');
         // Attempt graceful shutdown of components if they were initialized
         // The ArbitrageEngine should handle its own stop logic which includes clearing its interval.
         // The NonceManager needs to finish any pending transactions.
         try {
              // Assuming arbitrageEngine instance exists and has a stop method
              // Note: Calling stop might trigger cleanup already handled elsewhere, need careful sequencing.
              // Let's assume the ArbitrageEngine's stop method is the primary shutdown trigger.
              // If AE failed to initialize, flashSwapManager might still exist for NonceManager cleanup.
              if (ArbitrageEngine?.isRunning) { // Check if AE was successfully started and is running
                 await ArbitrageEngine.stop(); // Call stop if AE is active
              } else if (flashSwapManager?.signer instanceof require('./utils/nonceManager')) {
                  // If AE didn't even start, manually stop the NonceManager if it exists
                  logger.debug('[Main Shutdown] AE not running, attempting to stop NonceManager directly.');
                  await flashSwapManager.signer.stop(); // Gracefully stop NonceManager
              }
             logger.info('[Main Shutdown] Cleanup complete. Exiting.');
             process.exit(0); // Exit gracefully
         } catch (cleanupError) {
             logger.error('[Main Shutdown] Error during graceful shutdown:', cleanupError);
             process.exit(1); // Exit with error code
         }
     });

} // End main()

// Execute the main function
main().catch(mainError => {
    // This catch should ideally not be hit if inner errors are handled/re-thrown as ArbitrageError
    // but serves as a final safety net for unexpected issues.
    logger.error('!!! Uncaught Exception in main() !!!', mainError);
    handleError(mainError, 'MainProcessUncaught');
    process.exit(1); // Exit on uncaught exception
});
