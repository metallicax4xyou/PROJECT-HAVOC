// core/arbitrageEngine.js
// --- VERSION v1.18 --- Updated constructor to accept NonceManager instance and pass to TradeHandler.

const { EventEmitter } = require('events');
// const { ethers } = require('ethers'); // Not strictly needed in AE logic itself?
const PoolScanner = require('./poolScanner');
const ProfitCalculator = require('./profitCalculator');
const SpatialFinder = require('./finders/spatialFinder');
const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler');
// Import the TradeHandler CLASS (AE initializes the instance)
const TradeHandlerClass = require('./tradeHandler'); // Renamed import to distinguish from instance property

class ArbitrageEngine extends EventEmitter {
    /**
     * @param {object} config - Application configuration.
     * @param {ethers.Provider} provider - Ethers provider.
     * @param {SwapSimulator} swapSimulatorInstance - Instance of SwapSimulator.
     * @param {GasEstimator} gasEstimatorInstance - Instance of GasEstimator.
     * @param {FlashSwapManager} flashSwapManagerInstance - Instance of FlashSwapManager.
     * @param {NonceManager} nonceManagerInstance - Instance of NonceManager. // <-- NEW PARAMETER
     * // Note: TradeHandlerClass is passed as a constructor reference, AE creates the instance
     */
    constructor(config, provider, swapSimulatorInstance, gasEstimatorInstance, flashSwapManagerInstance, nonceManagerInstance, TradeHandlerClass) { // <-- ADD nonceManagerInstance HERE
        super();
        logger.info('[AE v1.18] Initializing ArbitrageEngine components...'); // Version bump

        // --- Validate Instances ---
        if (!config) throw new ArbitrageError('InitializationError', 'AE: Missing config.');
        if (!provider) throw new ArbitrageError('InitializationError', 'AE: Missing provider.');
        if (typeof swapSimulatorInstance?.simulateSwap !== 'function') throw new ArbitrageError('InitializationError', 'AE: Invalid SwapSimulator instance.');
        if (typeof gasEstimatorInstance?.estimateTxGasCost !== 'function' || typeof gasEstimatorInstance?.getFeeData !== 'function') { // Added getFeeData check
             throw new ArbitrageError('InitializationError', 'AE: Invalid GasEstimator instance.');
        }
        if (typeof flashSwapManagerInstance?.initiateAaveFlashLoan !== 'function' || typeof flashSwapManagerInstance?.getFlashSwapABI !== 'function' || typeof flashSwapManagerInstance?.getFlashSwapContract !== 'function') { // Added getFlashSwapContract check
             throw new ArbitrageError('InitializationError', 'AE: Invalid FlashSwapManager instance.');
        }
         // --- Validate NonceManager Instance ---
         if (typeof nonceManagerInstance?.sendTransaction !== 'function' || typeof nonceManagerInstance?.getAddress !== 'function') {
             throw new ArbitrageError('InitializationError', 'AE: Invalid NonceManager instance.');
         }
         // --- Validate TradeHandler CLASS ---
         if (!TradeHandlerClass || typeof TradeHandlerClass !== 'function' || typeof TradeHandlerClass.prototype?.handleTrades !== 'function') {
              throw new ArbitrageError('InitializationError', 'AE: Invalid TradeHandler Class constructor provided.');
         }


        this.config = config;
        this.provider = provider;
        this.flashSwapManager = flashSwapManagerInstance; // Store instance
        this.nativeSymbol = this.config.NATIVE_CURRENCY_SYMBOL || 'ETH'; // Define here


        // Initialize child components that AE is responsible for creating/managing
        this.poolScanner = new PoolScanner(config);
        this.spatialFinder = new SpatialFinder(config);
        // this.triangularV3Finder = new TriangularV3Finder(config);


        // --- Use the passed instances ---
        this.swapSimulator = swapSimulatorInstance; // Use passed instance
        this.gasEstimator = gasEstimatorInstance; // Use passed instance
        this.nonceManager = nonceManagerInstance; // <-- Store NonceManager instance

        // Initialize ProfitCalculator instance - it needs instances of its dependencies
        this.profitCalculator = new ProfitCalculator(
            config,
            provider,
            this.swapSimulator, // Pass instance
            this.gasEstimator, // Pass instance
            this.flashSwapManager // Pass instance
            // ProfitCalculator also needed NonceManager before v2.10? No, it just needed signer address from FSM.
        );


        // Initialize TradeHandler INSTANCE - it needs instances of its dependencies
        // TradeHandler requires config, provider, flashSwapManager, gasEstimator, NonceManager
        this.tradeHandler = new TradeHandlerClass( // Create instance from passed Class
            config,
            provider,
            this.flashSwapManager, // Pass instance
            this.gasEstimator, // Pass instance
            this.nonceManager, // <-- PASS NONCEManager INSTANCE HERE
            logger // Pass logger instance (if constructor expects it)
        );

        // State variables
        this.isRunning = false;
        this.cycleInterval = null;
        this.isCycleRunning = false;


        logger.info('[AE v1.18] ArbitrageEngine components initialized successfully.'); // Version bump
    }

    /**
     * Starts the main arbitrage cycle.
     */
    async start() {
        logger.info('[AE.start] Attempting to start engine...');
        if (this.isRunning) {
            logger.warn('[AE.start] Engine already running.');
            return;
        }
        this.isRunning = true;
        logger.info('[AE.start] Engine marked as running. Executing initial runCycle... (DEBUG log level for details)');

        // Initial run cycle
        try {
            logger.debug('[AE.start] >>> Calling initial runCycle... (v1.18)'); // Version bump
            await this.runCycle();
            logger.debug('[AE.start] <<< Initial runCycle finished.');
        } catch(error) {
            logger.error('[AE.start] !!!!!!!! CRITICAL ERROR during initial runCycle execution !!!!!!!!');
            handleError(error, 'ArbitrageEngine.initialRunCycle');
            logger.info('[AE.start] Stopping engine due to initial cycle failure.');
            this.stop();
            // Optionally re-throw if you want the main bot.js script to catch it
            // throw error; // Decided against re-throwing here to allow graceful stop logging
        }

        // Schedule subsequent cycles only if engine is still running after the initial cycle
        if (this.isRunning) {
            logger.debug('[AE.start] Setting up cycle interval...');
            this.cycleInterval = setInterval(() => {
                // Wrap runCycle call in try/catch for interval errors
                this.runCycle().catch(intervalError => {
                    logger.error("[AE Interval Error] Uncaught error from runCycle in interval:", intervalError);
                    handleError(intervalError, 'ArbitrageEngine.runCycleInterval');
                    // Consider stopping the bot if persistent errors occur in the interval
                    // if (shouldStopOnIntervalError(intervalError)) { this.stop(); }
                });
            }, this.config.CYCLE_INTERVAL_MS);

            if (this.cycleInterval) {
                logger.info(`[AE.start] Engine started successfully. Cycle interval: ${this.config.CYCLE_INTERVAL_MS}ms`);
                 logger.info('\n>>> BOT IS RUNNING <<<\n======================\n(Press Ctrl+C to stop)');
            } else {
                 logger.error('[AE.start] Failed to set cycle interval!');
                 this.stop(); // Stop if interval couldn't be set
            }
        } else {
            logger.warn('[AE.start] Engine stopped during initial runCycle.');
        }
    }

    /**
     * Stops the main arbitrage cycle.
     */
    async stop() { // Made stop async in case it needs to await cleanup
        logger.info('[AE.stop] Stopping Arbitrage Engine...');
        if (!this.isRunning && !this.cycleInterval && !this.isCycleRunning) {
            logger.warn('[AE.stop] Engine already fully stopped.');
            return;
        }
        this.isRunning = false; // Signal that the engine should stop

        // Clear the interval FIRST so no new cycles start
        if (this.cycleInterval) {
            clearInterval(this.cycleInterval);
            this.cycleInterval = null;
            logger.debug('[AE.stop] Cycle interval cleared.');
        }

        // Wait for any currently running cycle to finish gracefully
        // We don't explicitly wait here, runCycle checks `this.isRunning` at the start.
        // The `isCycleRunning` flag prevents new cycles while one is active.

        // Signal NonceManager to stop its interval/cleanup if it has any
        // Assuming NonceManager has a stop method
        if (this.nonceManager && typeof this.nonceManager.stop === 'function') {
            logger.debug('[AE.stop] Signaling NonceManager to stop...');
            await this.nonceManager.stop(); // Await cleanup like saving nonce
        } else {
             logger.debug('[AE.stop] No NonceManager instance or stop method found.');
        }


        logger.info('[AE.stop] Arbitrage Engine stopped.');
         logger.info('\n>>> BOT STOPPED <<<\n');
         logger.info('======================');

         // Optional: Emit a 'stopped' event
         // this.emit('stopped');
    }

    /**
     * Executes a single arbitrage scanning and trading cycle.
     * Prevents concurrent cycles.
     */
    async runCycle() {
        const cycleStartTime = Date.now();
        logger.debug('[AE.runCycle] ===== Starting New Cycle (v1.18) ====='); // Version bump

        if (!this.isRunning) {
            logger.debug('[AE.runCycle] Engine is stopping. Skipping cycle execution.');
            this.isCycleRunning = false; // Ensure flag is false
            return;
        }
         if (this.isCycleRunning) {
             logger.warn('[AE.runCycle] Previous cycle still running. Skipping this cycle.');
             return;
         }
        this.isCycleRunning = true; // Mark cycle as running

        let cycleStatus = 'FAILED';
        try {
             // --- Safety check: Exit early if stop was requested while waiting for isCycleRunning flag ---
             if (!this.isRunning) {
                  logger.debug('[AE.runCycle] Engine stop requested while waiting for flag. Aborting cycle.');
                  return;
             }

            // 1. Fetch latest pool data
            const { poolStates, pairRegistry } = await this._fetchPoolData();

            if (!poolStates || poolStates.length === 0) {
                logger.debug('[AE.runCycle] No pool states fetched in this cycle.');
                cycleStatus = 'COMPLETED (No Data)';
            } else {
                 // --- Safety check ---
                 if (!this.isRunning) { logger.debug('[AE.runCycle] Stop requested after fetching data. Aborting.'); return; }
                // 2. Find potential arbitrage opportunities
                const potentialOpportunities = this._findOpportunities(poolStates, pairRegistry);

                if (!potentialOpportunities || potentialOpportunities.length === 0) {
                     logger.debug(`[AE.runCycle] No potential opportunities found after finder execution.`);
                     cycleStatus = 'COMPLETED (No Potential Opps)';
                } else {
                     // --- Safety check ---
                     if (!this.isRunning) { logger.debug('[AE.runCycle] Stop requested after finding opps. Aborting.'); return; }
                    // 3. Calculate profitability and filter
                    const profitableOpportunities = await this._calculateProfitability(potentialOpportunities);

                    if (!profitableOpportunities || profitableOpportunities.length === 0) {
                         logger.debug(`[AE.runCycle] Opportunities found (${potentialOpportunities.length}) but none were profitable after calculation.`);
                         cycleStatus = 'COMPLETED (No Profitable Opps)';
                    } else {
                         // --- Safety check ---
                         if (!this.isRunning) { logger.debug('[AE.runCycle] Stop requested after calculating profit. Aborting.'); return; }
                        // 4. Dispatch profitable trades
                        logger.info(`[AE.runCycle] Found ${profitableOpportunities.length} profitable opportunities! Dispatching trades.`);
                        await this._handleProfitableTrades(profitableOpportunities);
                         cycleStatus = 'COMPLETED (Trades Dispatched)';
                    }
                }
            }

            // Cycle finished without throwing major errors
             if (this.isRunning && cycleStatus.startsWith('COMPLETED')) {
                 // Success path
             } else if (this.isRunning) {
                  // If engine is running but status isn't completed, it implies an uncaught error in the try block
                  cycleStatus = 'FAILED (Uncaught)'; // Should be caught below, but safeguard
             }


        } catch (error) {
            // This catch block handles errors specifically from the runCycle logic itself
            logger.error('[AE.runCycle] !!!!!!!! UNEXPECTED ERROR during cycle !!!!!!!!!!');
            logger.error(`[AE.runCycle] Error Type: ${error.constructor.name}, Msg: ${error.message}`);
             // Log stack trace only if it's not an ArbitrageError or if debug logging is enabled
            if (!(error instanceof ArbitrageError) || logger.level <= logger.levels.DEBUG) {
                 logger.error('[AE.runCycle] Stack:', error.stack);
            }
            // Use central error handler for reporting/cleanup if needed (optional, runCycle already logs)
            handleError(error, 'ArbitrageEngine.runCycleTopLevelCatch');
            cycleStatus = `FAILED (${error.type || error.constructor.name})`;
        } finally {
            const cycleEndTime = Date.now();
            const duration = cycleEndTime - cycleStartTime;
            logger.debug(`[AE.runCycle] ===== Cycle ${cycleStatus}. Duration: ${duration}ms =====`);
            this.isCycleRunning = false; // Mark cycle as finished
             // --- Safety check: If stop was requested while cycle was running, call stop now ---
             if (!this.isRunning) {
                 logger.debug('[AE.runCycle] Engine stop was requested during cycle. Calling stop method...');
                 // Use setImmediate to avoid recursive async calls within finally block
                 setImmediate(() => this.stop().catch(stopErr => logger.error('[AE.runCycle] Error during post-cycle stop:', stopErr)));
             }
        }
    }

    /**
     * Fetches the latest state data for all configured pools.
     * @returns {Promise<{poolStates: Array<object>, pairRegistry: Map}>}
     */
    async _fetchPoolData() {
        logger.debug('[AE._fetchPoolData] Fetching pool states...');
        if (!this.poolScanner) {
             const errorMsg = "PoolScanner instance missing.";
             logger.error(`[AE._fetchPoolData] CRITICAL: ${errorMsg}`);
             throw new ArbitrageError('InternalError', errorMsg);
        }
        const fetchResult = await this.poolScanner.fetchPoolStates(this.config.POOL_CONFIGS);
        logger.debug(`[AE._fetchPoolData] Fetched ${fetchResult?.poolStates?.length || 0} pool states. Pair Registry size: ${fetchResult?.pairRegistry?.size || 0}`);
        return fetchResult;
    }

    /**
     * Finds potential arbitrage opportunities from fetched pool states using configured finders.
     * @param {Array<object>} poolStates - Array of pool state objects.
     * @param {Map} pairRegistry - Map of token pairs to pools.
     * @returns {Array<object>} Array of potential opportunity objects.
     */
    _findOpportunities(poolStates, pairRegistry) {
        logger.debug('[AE._findOpportunities] Finding potential opportunities...');
        let allOpportunities = [];

        if (!pairRegistry || !(pairRegistry instanceof Map)) {
             const errorMsg = "Invalid pairRegistry received from PoolScanner. Cannot find opportunities.";
             logger.error(`[AE._findOpportunities] CRITICAL: ${errorMsg}`);
             return [];
        }

        // Run Spatial Finder
        if (!this.spatialFinder) {
            logger.warn("[AE._findOpportunities] SpatialFinder instance missing. Skipping spatial search.");
        } else if (poolStates?.length > 0) {
            logger.debug('[AE._findOpportunities] Running SpatialFinder...');
            try {
                const spatialOpportunities = this.spatialFinder.findArbitrage(poolStates, pairRegistry);
                logger.debug(`[AE._findOpportunities] SpatialFinder found ${spatialOpportunities?.length || 0} potentials.`);
                allOpportunities = allOpportunities.concat(spatialOpportunities);
            } catch (finderError) {
                 logger.error('[AE._findOpportunities] Error running SpatialFinder:', finderError);
                 // Decide whether to re-throw or continue with other finders
                 // For now, log and continue
            }
        } else {
             logger.debug('[AE._findOpportunities] No pool states available for SpatialFinder.');
        }

        // Triangular Finder (Add logic when implemented and initialized)
        // if (this.triangularV3Finder) { ... }

        logger.debug(`[AE._findOpportunities] Total potential opportunities found: ${allOpportunities.length}`);
        return allOpportunities;
    }

    /**
     * Calculates the profitability of potential opportunities using the ProfitCalculator.
     * Filters out non-profitable opportunities.
     * @param {Array<object>} opportunities - Array of potential opportunity objects.
     * @returns {Promise<Array<object>>} Array of profitable opportunity objects.
     * @throws {ArbitrageError} If ProfitCalculator instance is missing.
     */
    async _calculateProfitability(opportunities) {
        logger.debug(`[AE._calculateProfitability] Calculating profitability for ${opportunities.length} opportunities...`);
        if (!this.profitCalculator) {
             const errorMsg = "ProfitCalculator instance missing!";
             logger.error(`[AE._calculateProfitability] CRITICAL: ${errorMsg}`);
             throw new ArbitrageError('InternalError', errorMsg);
        }
        if (opportunities.length === 0) {
             logger.debug('[AE._calculateProfitability] No opportunities to calculate profit for.');
             return [];
        }

        const profitableTrades = await this.profitCalculator.calculate(opportunities);

        logger.debug(`[AE._calculateProfitability] Profitability calculation complete. Found ${profitableTrades.length} profitable trades.`);
        return profitableTrades;
    }

    /**
     * Dispatches profitable trades to the TradeHandler for potential execution.
     * Logs details of the profitable trades before dispatch.
     * @param {Array<object>} profitableTrades - Array of profitable opportunity objects.
     * @throws {ArbitrageError} If TradeHandler instance is missing.
     */
    async _handleProfitableTrades(profitableTrades) {
        if (!this.tradeHandler) {
            logger.error('[AE._handleProfitableTrades] CRITICAL: TradeHandler instance missing!');
            // Decide whether to throw or just log and return. Throwing might be safer.
            throw new ArbitrageError('InternalError', 'TradeHandler instance missing.');
        }

        if (profitableTrades?.length > 0) {
             logger.info(`[AE._handleProfitableTrades] --- ✅ Profitable Trades Found (${profitableTrades.length}) ---`);
             // Log details using the external tradeLogger utility
             const tradeLogger = require('../utils/tradeLogger'); // Lazy require if not already imported
             profitableTrades.forEach((trade, index) => {
                  tradeLogger.logTradeDetails(trade, index + 1, this.nativeSymbol);
             });

             try {
                 // TradeHandler handles the actual transaction execution
                 await this.tradeHandler.handleTrades(profitableTrades);
                 logger.debug(`[AE._handleProfitableTrades] TradeHandler completed handling profitable trades.`);
             } catch (handlerError) {
                 logger.error("[AE._handleProfitableTrades] Error caught from TradeHandler.handleTrades:", handlerError);
                 // The TradeHandler should handle its own errors internally and log them.
                 // Catching here is for unexpected errors escaping the TradeHandler.
                 handleError(handlerError, 'TradeHandler.handleTrades');
                 // Decide whether to re-throw or just log. Logging seems sufficient for this level.
             }

        } else {
             logger.debug('[AE._handleProfitableTrades] No profitable trades to handle.');
        }

        logger.debug(`[AE._handleProfitableTrades] Finished handling profitable trades.`);
    }

    // --- _logTradeDetails method has been removed and moved to utils/tradeLogger.js ---

} // End ArbitrageEngine class

// Export the class
module.exports = ArbitrageEngine;