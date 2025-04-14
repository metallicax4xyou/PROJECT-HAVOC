// bot.js - Main Entry Point
// Loads config implicitly via engine, initializes and starts the arbitrage engine.

// Load logger first for consistent logging
const logger = require('./utils/logger');

// Import the main engine class
const { ArbitrageEngine } = require('./core/arbitrageEngine');

// --- Main Execution Function ---
async function main() {
    logger.log(">>> PROJECT HAVOC ARBITRAGE BOT STARTING <<<");
    logger.log("==============================================");

    // Check for necessary environment variables early (optional but good practice)
    if (!process.env.NETWORK) {
         logger.error("CRITICAL: NETWORK environment variable not set.");
         process.exit(1);
    }
    if (!process.env.PRIVATE_KEY) {
         logger.error("CRITICAL: PRIVATE_KEY environment variable not set.");
         process.exit(1);
    }
     if (!process.env[`${process.env.NETWORK.toUpperCase()}_RPC_URL`]) {
         logger.error(`CRITICAL: ${process.env.NETWORK.toUpperCase()}_RPC_URL environment variable not set.`);
         process.exit(1);
     }


    // Create engine instance (config is loaded inside the engine)
    const engine = new ArbitrageEngine();

    try {
        // Initialize the engine (sets up provider, signer, contracts, nonce manager)
        const initialized = await engine.initialize();

        if (initialized) {
            // Start the main monitoring loop
            engine.start();

            // Keep the process running (until Ctrl+C or an unhandled critical error)
            logger.log(">>> Engine started. Monitoring for opportunities... (Press Ctrl+C to stop) <<<");
            // Prevent Node.js from exiting immediately if start() doesn't block
             process.stdin.resume(); // Keep alive
             // Handle graceful shutdown
             process.on('SIGINT', () => {
                 logger.log("\n>>> Received SIGINT (Ctrl+C). Shutting down gracefully... <<<");
                 engine.stop();
                 // Add any other cleanup needed
                 process.exit(0);
             });

        } else {
            logger.error("!!! Engine failed to initialize. Bot cannot start. Check logs for details. !!!");
            process.exit(1); // Exit if initialization failed
        }

    } catch (error) {
        // Catch any top-level errors during initialization or startup
        logger.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        logger.error("!!! BOT FAILED TO START / CRITICAL ERROR !!!");
        logger.error("Error:", error.message);
        if (error.stack) {
             logger.error("Stack:", error.stack);
        }
        logger.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        process.exit(1); // Exit with error code
    }
}

// --- Execute Main Function ---
main(); // No need to catch here, the function handles its own errors and exits
