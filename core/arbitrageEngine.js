// /workspaces/arbitrum-flash/core/arbitrageEngine.js
// --- VERSION 1.13: Added try...catch inside setInterval callback ---

const { ethers } = require('ethers');
const { PoolScanner } = require('./poolScanner');
const GasEstimator = require('./gasEstimator');
const ProfitCalculator = require('./profitCalculator');
const logger = require('../utils/logger');
const ErrorHandler = require('../utils/errorHandler');
const FlashSwapManager = require('./flashSwapManager');
const { processOpportunity } = require('./opportunityProcessor');
const { ArbitrageError } = require('../utils/errorHandler');
const QuoteSimulator = require('./quoteSimulator');

const TriangularV3Finder = require('./finders/triangularV3Finder');
const SpatialFinder = require('./finders/spatialFinder');

class ArbitrageEngine {
    constructor(manager, config) {
        // --- Constructor logic unchanged ---
        logger.info('[Engine Constructor] Initializing ArbitrageEngine...');
        if (!manager || !(manager instanceof FlashSwapManager)) { /* ... */ }
        if (!config) { /* ... */ }
        const requiredConfigKeys = [ /* ... */ ];
        const missingKeys = requiredConfigKeys.filter(key => !(key in config));
        if (missingKeys.length > 0) { /* ... */ }
        if (!Array.isArray(config.POOL_CONFIGS) || config.POOL_CONFIGS.length === 0) { /* ... */ }
        if (typeof config.MIN_PROFIT_THRESHOLDS !== 'object' || !config.MIN_PROFIT_THRESHOLDS.DEFAULT || !config.MIN_PROFIT_THRESHOLDS.NATIVE) { /* ... */ }
        this.manager = manager; this.config = config; this.provider = manager.getProvider(); this.signer = manager.getSigner();
        logger.debug('[Engine Constructor] Parsing configuration values...');
        try { this.config.parsed = { /* ... */ }; /* ... */ } catch (parseError) { /* ... */ }
        logger.debug('[Engine Constructor] Initializing core components...');
        try {
            this.quoteSimulator = new QuoteSimulator(this.provider, this.config);
            this.poolScanner = new PoolScanner(this.config, this.provider);
            this.gasEstimator = new GasEstimator(this.provider, this.config);
            const profitCalcConfig = { /* ... passes explicit config ... */ };
            this.profitCalculator = new ProfitCalculator(profitCalcConfig);
            this.triangularV3Finder = new TriangularV3Finder();
            this.spatialFinder = new SpatialFinder();
            logger.debug('[Engine Constructor] Core component initialization complete.');
        } catch (initError) { /* ... */ }
        this.isRunning = false; this.isCycleRunning = false; this.cycleCount = 0;
        this.cycleInterval = parseInt(this.config.CYCLE_INTERVAL_MS || '5000', 10);
        this.intervalId = null;
        logger.info('[Engine Constructor] Arbitrage Engine Constructor Finished Successfully.');
    }

    async initialize() { /* ... unchanged ... */ }

    // --- start() method with try...catch in interval ---
    start() {
        logger.info('[Engine] >>> Entering start() method...');
        if (this.isRunning) { /* ... */ return; }
        this.isRunning = true; this.isCycleRunning = false; this.cycleCount = 0;
        logger.info(`[Engine start()] Starting run loop with interval: ${this.cycleInterval}ms`);

        // Initial immediate call (unchanged logic, small delay)
        logger.info('[Engine start()] Attempting immediate first runCycle call...');
        setTimeout(async () => {
            if (!this.isRunning) return;
            await this.runCycle().catch(error => { /* ... error handling ... */ });
        }, 10);

        logger.info('[Engine start()] Initial runCycle call scheduled. Setting interval...');

        this.intervalId = setInterval(async () => {
            // --- *** ADDED try...catch around the entire callback *** ---
            try {
                 console.log(`CONSOLE_LOG: setInterval callback triggered. Time: ${new Date().toISOString()}`); // Keep console log
                 logger.debug('[Engine Interval Callback] Interval triggered.');

                if (this.isRunning && !this.isCycleRunning) {
                     console.log(`CONSOLE_LOG: Conditions met, calling runCycle...`); // Keep console log
                     logger.debug('[Engine Interval Callback] Conditions met, calling runCycle...');
                    // Don't await runCycle directly here to prevent blocking next interval
                    this.runCycle().catch(error => {
                        // Catch errors specifically from the runCycle promise
                         logger.error(`[Engine Interval RunCycle Catch] Error during async runCycle execution (Cycle ${this.cycleCount}):`, error);
                         ErrorHandler.handleError(error, `EngineScheduledCycle_${this.cycleCount}`);
                         if (error instanceof ArbitrageError && error.isFatal) {
                              logger.warn("[Engine Interval RunCycle Catch] Stopping due to fatal error in cycle.");
                              this.stop();
                         }
                    });
                } else {
                    console.log(`CONSOLE_LOG: Conditions NOT met (isRunning=${this.isRunning}, isCycleRunning=${this.isCycleRunning}), skipping runCycle.`); // Keep console log
                     if (this.isCycleRunning) { logger.warn(`[Engine Interval Callback] Skipping scheduled cycle start - previous cycle (Cycle ${this.cycleCount}) still running.`); }
                     else if (!this.isRunning) { logger.warn('[Engine Interval Callback] Skipping cycle start - engine is not running.'); }
                }
            } catch (intervalCallbackError) {
                // Catch any synchronous errors happening *within* the interval callback itself
                 console.error(`CONSOLE_LOG: !!! ERROR INSIDE setInterval CALLBACK !!!`);
                 console.error(intervalCallbackError);
                 logger.error(`[Engine Interval Callback] CRITICAL ERROR inside interval callback itself: ${intervalCallbackError.message}`, intervalCallbackError);
                 // Consider stopping the engine if the interval callback itself is broken
                 // this.stop();
            }
            // --- *** END try...catch *** ---
        }, this.cycleInterval);

         logger.info('[Engine start()] Interval set.');
         logger.info('[Engine] <<< Exiting start() method.');
    }
    // --- *** ---

    stop() { /* ... unchanged ... */ }
    async runCycle() { /* ... unchanged ... */ }
    logCycleEnd(cycleNum, startTime, fetchedPoolCount, executed = false, hadError = false) { /* ... unchanged ... */ }
}

module.exports = { ArbitrageEngine };
