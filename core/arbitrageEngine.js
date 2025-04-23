// core/arbitrageEngine.js
// --- VERSION WITH HEAVY LOGGING in start/runCycle ---
const { EventEmitter } = require('events');
const { ethers } = require('ethers');
const PoolScanner = require('./poolScanner');
const ProfitCalculator = require('./profitCalculator');
const SpatialFinder = require('./finders/spatialFinder');
const SwapSimulator = require('./swapSimulator');
const GasEstimator = require('../utils/gasEstimator');
const logger = require('../utils/logger');
const { ArbitrageError } = require('../utils/errorHandler');

class ArbitrageEngine extends EventEmitter {
    constructor(config, provider, swapSimulator, gasEstimator) {
        super();
        logger.info('[AE] Initializing ArbitrageEngine components...');
        if (!config) throw new ArbitrageError('InitializationError', 'AE: Missing config.');
        if (!provider) throw new ArbitrageError('InitializationError', 'AE: Missing provider.');
        if (!swapSimulator?.simulateSwap) throw new ArbitrageError('InitializationError', 'AE: Invalid SwapSimulator.');
        if (!gasEstimator?.estimateTxGasCost) throw new ArbitrageError('InitializationError', 'AE: Invalid GasEstimator.');
        if (!config.provider) { config.provider = provider; }

        this.config = config;
        this.provider = provider;
        this.swapSimulator = swapSimulator;
        this.gasEstimator = gasEstimator;
        this.isRunning = false; this.cycleInterval = null; this.isCycleRunning = false;

        try {
            this.poolScanner = new PoolScanner(config);
            this.profitCalculator = new ProfitCalculator(this.config, this.provider, this.swapSimulator, this.gasEstimator);
            this.spatialFinder = new SpatialFinder(config);
        } catch (error) {
            logger.error(`[AE] CRITICAL ERROR during component initialization: ${error.message}`, error);
            throw new ArbitrageError('InitializationError', `Failed to initialize AE components: ${error.message}`, error);
        }
        logger.info('[AE] ArbitrageEngine components initialized successfully');
    }

    async start() {
        logger.info('[AE.start] Attempting to start engine...');
        if (this.isRunning) { logger.warn('[AE.start] Engine already running.'); return; }
        this.isRunning = true;
        logger.info('[AE.start] Engine marked as running. Executing initial runCycle...');

        try {
             // *** Log before initial runCycle ***
             logger.debug('[AE.start] >>> Calling initial runCycle...');
            await this.runCycle();
             // *** Log after initial runCycle completes ***
             logger.debug('[AE.start] <<< Initial runCycle finished.');

        } catch(error) {
            // *** Log specific error from initial runCycle ***
            logger.error('[AE.start] CRITICAL ERROR during initial runCycle execution:', error);
            logger.info('[AE.start] Stopping engine due to initial cycle failure.');
            this.stop(); // Stop if initial cycle fails catastrophically
            return; // Prevent setting interval
        }

        // Ensure engine wasn't stopped by an error during the initial cycle
        if (this.isRunning) {
            logger.debug('[AE.start] Setting up cycle interval...');
            this.cycleInterval = setInterval(() => {
                // Add a catch block around the interval's runCycle call too
                 this.runCycle().catch(intervalError => {
                     logger.error('[AE Interval Error] Error caught from runCycle called by setInterval:', intervalError);
                     // Decide if we should stop the bot on interval errors
                     // this.stop();
                 });
            }, this.config.CYCLE_INTERVAL_MS);

            if (this.cycleInterval) {
                 logger.info(`[AE.start] Engine started successfully. Cycle interval: ${this.config.CYCLE_INTERVAL_MS}ms`);
            } else {
                 logger.error('[AE.start] Failed to set cycle interval!');
                 this.stop(); // Stop if interval setup failed
            }
        } else {
            logger.warn('[AE.start] Engine was stopped during initial runCycle, interval not set.');
        }
      }

      stop() {
        logger.info('[AE.stop] Stopping Arbitrage Engine...');
        if (!this.isRunning && !this.cycleInterval) { logger.warn('[AE.stop] Engine already stopped.'); return; }
        this.isRunning = false;
        if (this.cycleInterval) { clearInterval(this.cycleInterval); this.cycleInterval = null; logger.debug('[AE.stop] Cycle interval cleared.'); }
        this.isCycleRunning = false; // Reset lock
        logger.info('[AE.stop] Arbitrage Engine stopped.');
      }

    async runCycle() {
        // *** Log cycle start attempt ***
        logger.info('[AE.runCycle] Attempting to start new cycle...');
        if (!this.isRunning) { logger.info('[AE.runCycle] Engine stopped, skipping cycle run.'); return; }
        if (this.isCycleRunning) { logger.warn('[AE.runCycle] Previous cycle still running, skipping.'); return; }

        this.isCycleRunning = true; // Set lock
        logger.info('[AE.runCycle] ===== Starting New Arbitrage Cycle =====');
        const cycleStartTime = Date.now();
        let cycleStatus = 'FAILED'; // Default status

        try {
          // *** Log entering the main try block ***
          logger.debug('[AE.runCycle] --- START Try Block ---');

          logger.info('[AE.runCycle] Fetching pool states...');
          if (!this.poolScanner) throw new Error("PoolScanner missing.");
          const { poolStates, pairRegistry } = await this.poolScanner.fetchPoolStates();
          logger.info(`[AE.runCycle] Fetched ${poolStates.length} pool states.`);

          logger.debug('[AE.runCycle] Updating SpatialFinder registry...');
          if (this.spatialFinder && pairRegistry) { this.spatialFinder.updatePairRegistry(pairRegistry); }
          else if (!this.spatialFinder) { logger.warn("[AE.runCycle] SpatialFinder missing."); }

          let spatialOpportunities = [];
          if (this.spatialFinder && poolStates.length > 0) {
              logger.info('[AE.runCycle] Finding spatial opportunities...');
              spatialOpportunities = this.spatialFinder.findArbitrage(poolStates);
              logger.info(`[AE.runCycle] Found ${spatialOpportunities.length} potential spatial opportunities.`);
          }

          const triangularOpportunities = []; // Placeholder
          const allOpportunities = [...spatialOpportunities, ...triangularOpportunities];

          let profitableTrades = [];
          if (allOpportunities.length > 0 && this.profitCalculator) {
            logger.info(`[AE.runCycle] Calculating profitability for ${allOpportunities.length} opportunities...`);
            profitableTrades = await this.profitCalculator.calculate(allOpportunities);
            logger.info(`[AE.runCycle] Found ${profitableTrades.length} profitable trades (after gas/threshold).`);

            if (profitableTrades.length > 0) {
                 logger.info(`[AE.runCycle] --- Profitable Trades Found (${profitableTrades.length}) ---`);
                 profitableTrades.forEach((trade, index) => { /* ... log trade details ... */ });
                 this.emit('profitableOpportunities', profitableTrades);
                 logger.info(`[AE.runCycle] --- Emitted profitableOpportunities event ---`);
            }

          } else if (allOpportunities.length === 0) {
            logger.info('[AE.runCycle] No potential opportunities found.');
          } else if (!this.profitCalculator) {
             logger.warn('[AE.runCycle] ProfitCalculator missing.');
          }

          // *** Log successful completion of try block ***
          cycleStatus = 'COMPLETED';
          logger.debug('[AE.runCycle] --- END Try Block (Success) ---');

        } catch (error) {
            // *** Log error caught within runCycle ***
            logger.error('[AE.runCycle] !!!!!!!! ERROR caught within runCycle !!!!!!!!!!');
            logger.error(`[AE.runCycle] Error Type: ${error.constructor.name}`);
            logger.error(`[AE.runCycle] Error Message: ${error.message}`);
            logger.error('[AE.runCycle] Error Stack:', error.stack); // Log stack trace
            // Decide if error is critical enough to stop the bot
            // if (error instanceof CriticalError) { this.stop(); }
        } finally {
            const cycleEndTime = Date.now();
            const duration = cycleEndTime - cycleStartTime;
            // *** Log cycle finish regardless of success/failure ***
            logger.info(`[AE.runCycle] ===== Arbitrage Cycle ${cycleStatus}. Duration: ${duration}ms =====`);
            this.isCycleRunning = false; // Release lock *always*
        }
      }
}
module.exports = ArbitrageEngine;
