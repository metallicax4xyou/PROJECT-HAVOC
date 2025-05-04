// bot.js
// Arbitrage Bot Entry Point
// --- VERSION 1.3 --- Initialization logic moved to core/initializer.js

require('dotenv').config(); // Load environment variables from .env file

// No need for ethers here anymore
const config = require('./config'); // Load configuration
const logger = require('./utils/logger'); // Import logger utility
const { handleError } = require('./utils/errorHandler'); // Import error handling

// Import the new initializer function
const { initializeBot } = require('./core/initializer');

let arbitrageEngineInstance = null; // Keep track of the engine instance for shutdown
let flashSwapManagerInstance = null; // Keep track of FSM for potential NonceManager cleanup

async function main() {
    logger.info('\n==============================================');
    logger.info('>>> PROJECT HAVOC ARBITRAGE BOT STARTING <<<');
    logger.info('==============================================');

    try {
        // Delegate initialization and startup to the initializer module
        logger.info('[Main] Initializing bot components via initializer...');
        const initializedComponents = await initializeBot(config);

        // Check if initialization was successful and instances were returned
        if (!initializedComponents || !initializedComponents.arbitrageEngine) {
             // initializeBot should throw on error, but this is a safeguard
             throw new Error("Initialization failed - initializeBot did not return expected components.");
        }

        arbitrageEngineInstance = initializedComponents.arbitrageEngine;
        flashSwapManagerInstance = initializedComponents.flashSwapManager; // Store FSM instance

        logger.info('[Main] Bot initialization complete. Starting Arbitrage Engine...');

        // Start the arbitrage cycle - this is the main loop
        await arbitrageEngineInstance.start();

        logger.info('[Main] Arbitrage Engine started. Bot is running.');

        // The process will stay alive because the ArbitrageEngine is running its interval cycle.

    } catch (error) {
        // This catch handles errors thrown by initializeBot or potential errors right after start()
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
         try {
              // Use the instance returned by the initializer
              if (arbitrageEngineInstance && typeof arbitrageEngineInstance.stop === 'function') {
                 logger.debug('[Main Shutdown] Stopping Arbitrage Engine...');
                 await arbitrageEngineInstance.stop(); // Call stop on the initialized instance
              } else if (flashSwapManagerInstance?.signer?.stop) { // Check if FSM and its signer (NonceManager) exist
                  logger.debug('[Main Shutdown] AE instance not available, attempting to stop NonceManager directly via FSM.');
                  // Assuming flashSwapManager.signer is the NonceManager instance
                  await flashSwapManagerInstance.signer.stop(); // Gracefully stop NonceManager
              } else {
                   logger.debug('[Main Shutdown] No active components with stop methods found.');
              }
             logger.info('[Main Shutdown] Cleanup complete. Exiting.');
             process.exit(0); // Exit gracefully
         } catch (cleanupError) {
             logger.error('[Main Shutdown] Error during graceful shutdown:', cleanupError);
             handleError(cleanupError, 'MainProcessShutdown'); // Log shutdown error
             process.exit(1); // Exit with error code
         }
     });

} // End main()

// Execute the main function
main().catch(mainError => {
    // This catch serves as a final safety net for any uncaught exceptions
    // that might escape the main try/catch block *after* initial setup.
    logger.error('!!! Uncaught Exception in main() after startup handled !!!', mainError);
    handleError(mainError, 'MainProcessUncaught');
    process.exit(1); // Exit on uncaught exception
});
