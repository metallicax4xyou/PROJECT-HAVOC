// /workspaces/arbitrum-flash/core/arbitrageEngine.js
// --- Added more logging to initialize() and start() ---

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

// --- Import Finder Classes ---
const TriangularV3Finder = require('./finders/triangularV3Finder');
const SpatialFinder = require('./finders/spatialFinder');
// --- ---

class ArbitrageEngine {
    constructor(manager, config) {
        // --- Constructor logging is fine ---
        logger.info('[Engine Constructor] Initializing ArbitrageEngine...');
        // ... (keep constructor content as is) ...
        this.manager = manager;
        this.config = config;
        this.provider = manager.getProvider();
        this.signer = manager.getSigner();
        logger.debug('[Engine Constructor] Parsing configuration values...');
        try {
            this.config.parsed = { /* ... */ };
             logger.debug('[Engine Constructor] Config parsing complete.');
        } catch (parseError) { /* ... */ }
        try {
            logger.debug('[Engine Constructor] Initializing QuoteSimulator...');
            this.quoteSimulator = new QuoteSimulator(this.provider, this.config);
            logger.debug('[Engine Constructor] Initializing SIMPLIFIED PoolScanner...');
            this.poolScanner = new PoolScanner(this.config, this.provider);
            logger.debug('[Engine Constructor] Initializing GasEstimator...');
            this.gasEstimator = new GasEstimator(this.provider, this.config);
            logger.debug('[Engine Constructor] Initializing ProfitCalculator...');
            this.profitCalculator = new ProfitCalculator(this.config);
            logger.debug('[Engine Constructor] Initializing Opportunity Finders...');
            this.triangularV3Finder = new TriangularV3Finder(this.config);
            this.spatialFinder = new SpatialFinder(this.config);
            logger.debug('[Engine Constructor] Core component initialization complete.');
        } catch (initError) { /* ... */ }
        this.isRunning = false;
        this.isCycleRunning = false;
        this.cycleCount = 0;
        this.cycleInterval = parseInt(this.config.CYCLE_INTERVAL_MS || '5000', 10);
        this.intervalId = null;
        logger.info('[Engine Constructor] Arbitrage Engine Constructor Finished Successfully.');
    }

    // --- ADDED LOGGING TO initialize() ---
    async initialize() {
         logger.info('[Engine] >>> Entering initialize() method...'); // *** ADDED ***
         try {
            // Add any async initialization steps for components if needed
            logger.info('[Engine initialize()] Performing async setup steps (if any)...'); // *** ADDED ***
            // Example: await this.poolScanner.warmupCache();
            await Promise.resolve(); // Placeholder for any async work
            logger.info('[Engine initialize()] Async setup steps complete.'); // *** ADDED ***
            logger.info('[Engine] <<< Exiting initialize() method successfully.'); // *** ADDED ***
         } catch(err) {
            logger.error('[Engine CRITICAL] Failed during engine initialize() method.', err); // *** ADDED ***
            throw err; // Rethrow to prevent starting
         }
    }
    // --- END initialize() UPDATE ---

    // --- ADDED LOGGING TO start() ---
    start() { // Note: start() itself isn't async in the provided code, but it calls async runCycle
        logger.info('[Engine] >>> Entering start() method...'); // *** ADDED ***
        if (this.isRunning) {
            logger.warn('[Engine start()] Start called but already running.');
            return;
        }
        this.isRunning = true;
        this.isCycleRunning = false; // Reset cycle lock
        this.cycleCount = 0; // Reset count
        logger.info(`[Engine start()] Starting run loop with interval: ${this.cycleInterval}ms`); // *** MODIFIED ***

        // Run first cycle immediately, then set interval
        logger.info('[Engine start()] Attempting immediate first runCycle call...'); // *** ADDED ***
        this.runCycle().then(() => { // *** ADDED .then() logging ***
             logger.info('[Engine start()] Initial immediate runCycle call promise resolved.');
        }).catch(error => {
            logger.error("[Engine start()] Error during initial immediate runCycle execution:", error); // *** MODIFIED ***
             ErrorHandler.handleError(error, 'EngineImmediateCycle'); // Use correct name
             this.stop(); // Stop if initial cycle fails critically
        });
        logger.info('[Engine start()] Initial runCycle call invoked (runs async). Setting interval...'); // *** ADDED ***

        this.intervalId = setInterval(async () => {
             logger.debug('[Engine Interval Callback] Interval triggered.'); // *** ADDED ***
            if (this.isRunning && !this.isCycleRunning) {
                 logger.debug('[Engine Interval Callback] Conditions met, calling runCycle...'); // *** ADDED ***
                await this.runCycle().catch(error => {
                     logger.error(`[Engine Interval Callback] Error during scheduled runCycle (Cycle ${this.cycleCount}):`, error); // *** MODIFIED ***
                      ErrorHandler.handleError(error, `EngineScheduledCycle_${this.cycleCount}`); // Use correct name
                     if (error instanceof ArbitrageError && error.isFatal) {
                          logger.warn("[Engine Interval Callback] Stopping due to fatal error in cycle."); // *** MODIFIED ***
                          this.stop();
                     }
                });
            } else if (this.isCycleRunning) {
                 logger.warn(`[Engine Interval Callback] Skipping scheduled cycle start - previous cycle (Cycle ${this.cycleCount}) still running.`); // *** MODIFIED ***
            } else if (!this.isRunning) {
                 logger.warn('[Engine Interval Callback] Skipping cycle start - engine is not running.'); // *** ADDED ***
            }
        }, this.cycleInterval);

         logger.info('[Engine start()] Interval set.'); // *** ADDED ***
         logger.info('[Engine] <<< Exiting start() method.'); // *** ADDED ***
    }
    // --- END start() UPDATE ---

    stop() {
        // --- ADDED LOGGING TO stop() ---
        logger.warn('[Engine] >>> Entering stop() method...'); // *** ADDED ***
        if (!this.isRunning) {
            logger.warn('[Engine stop()] Stop called but not running.');
            return;
        }
        logger.warn('[Engine stop()] Stopping run loop...'); // *** MODIFIED ***
        this.isRunning = false;
        if (this.intervalId) {
             logger.warn('[Engine stop()] Clearing interval...'); // *** ADDED ***
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        // Optional: Add cleanup logic if needed
        logger.warn('[Engine stop()] Run loop stopped.'); // *** MODIFIED ***
         logger.warn('[Engine] <<< Exiting stop() method.'); // *** ADDED ***
    }

    // --- runCycle() with logging before checks ---
    async runCycle() {
        // *** ADDED LOGGING HERE ***
        logger.debug(`[Engine runCycle] >>> Entered runCycle (Cycle Attempt: ${this.cycleCount + 1}). Checking conditions... isRunning=${this.isRunning}, isCycleRunning=${this.isCycleRunning}`);

        // Check running state & cycle lock (avoids race conditions)
        if (!this.isRunning) {
            logger.warn(`[Engine runCycle] Returning early: isRunning is false.`); // *** ADDED ***
            return;
        }
        if (this.isCycleRunning) {
            logger.warn(`[Engine runCycle] Returning early: Cycle overlap detected (isCycleRunning is true).`); // *** ADDED ***
            return;
        }

        this.isCycleRunning = true;
        this.cycleCount++; // Increment only when cycle actually starts
        const cycleStartTime = Date.now();
        // --- Keep existing runCycle logic below ---
        logger.info(`\n===== [Engine] Starting Cycle #${this.cycleCount} at ${new Date().toISOString()} =====`);
        try {
            logger.debug(`[Engine Cycle ${this.cycleCount}] Step 1: Getting pool list from config...`);
            const poolInfosToFetch = this.config.POOL_CONFIGS;
            if (!Array.isArray(poolInfosToFetch) || poolInfosToFetch.length === 0) { /* ... */ }
            logger.debug(`[Engine Cycle ${this.cycleCount}] Step 1 Complete: Found ${poolInfosToFetch.length} pools.`);

            logger.debug(`[Engine Cycle ${this.cycleCount}] Step 2: Fetching live states for ${poolInfosToFetch.length} pools...`);
            const livePoolStatesMap = await this.poolScanner.fetchPoolStates(poolInfosToFetch);
            const fetchedCount = livePoolStatesMap ? Object.keys(livePoolStatesMap).length : 0;
            if (fetchedCount === 0) { /* ... */ }
            logger.info(`[Engine Cycle ${this.cycleCount}] Step 2 Complete: Fetched ${fetchedCount} live pool states (V3 & Sushi).`);

            logger.debug(`[Engine Cycle ${this.cycleCount}] Step 3: Finding potential opportunities (Triangular & Spatial)...`);
            let triangularOpportunities = []; let spatialOpportunities = [];
            try { /* ... finders ... */ } catch (finderError) { /* ... */ }
            const potentialOpportunities = [...triangularOpportunities, ...spatialOpportunities];
            logger.info(`[Engine Cycle ${this.cycleCount}] Step 3 Complete: Found ${potentialOpportunities.length} potential opportunities (${triangularOpportunities.length} Tri, ${spatialOpportunities.length} Spatial).`);

            if (potentialOpportunities.length === 0) { /* ... return early ... */
                 logger.info(`[Engine Cycle ${this.cycleCount}] Step 4: No potential opportunities found this cycle.`);
                 this.logCycleEnd(cycleStartTime, fetchedCount);
                 this.isCycleRunning = false;
                 return;
            }

            logger.info(`[Engine Cycle ${this.cycleCount}] Step 4: Processing ${potentialOpportunities.length} potential opportunities...`);
            let executedThisCycle = false;
            const engineContext = { /* ... */ };
            for (const opp of potentialOpportunities) { /* ... process opp ... */ }
            logger.info(`[Engine Cycle ${this.cycleCount}] Step 4 Complete: Finished processing opportunities.`);
            this.logCycleEnd(cycleStartTime, fetchedCount, executedThisCycle);

        } catch (error) { /* ... handle cycle error ... */ }
        finally {
            this.isCycleRunning = false;
            logger.debug(`[Engine Cycle ${this.cycleCount}] <<< Exiting runCycle. Cycle lock released.`); // *** ADDED ***
        }
    } // End runCycle

    logCycleEnd(startTime, fetchedPoolCount, executed = false, hadError = false) { /* ... keep as is ... */ }
}

module.exports = { ArbitrageEngine };
