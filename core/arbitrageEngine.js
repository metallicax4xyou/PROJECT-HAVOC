// /workspaces/arbitrum-flash/core/arbitrageEngine.js
// --- VERSION 1.16: Pass engine instance to setInterval callback ---

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
        // --- Constructor logic largely unchanged ---
        // ... (validations, component initializations as before) ...
        this.manager = manager; this.config = config; this.provider = manager.getProvider(); this.signer = manager.getSigner();
        try { this.config.parsed = { /* ... */ }; } catch (e) { /*...*/ }
        try {
            this.quoteSimulator = new QuoteSimulator(this.provider, this.config);
            this.poolScanner = new PoolScanner(this.config, this.provider);
            this.gasEstimator = new GasEstimator(this.provider, this.config);
            const profitCalcConfig = { /* ... */ };
            this.profitCalculator = new ProfitCalculator(profitCalcConfig);
            this.triangularV3Finder = new TriangularV3Finder();
            this.spatialFinder = new SpatialFinder();
        } catch (e) { /*...*/ }
        this.isRunning = false; this.isCycleRunning = false; this.cycleCount = 0;
        this.cycleInterval = parseInt(this.config.CYCLE_INTERVAL_MS || '5000', 10);
        this.intervalId = null;
        logger.info('[Engine Constructor] Arbitrage Engine Constructor Finished Successfully.');
    }

    async initialize() { /* ... unchanged ... */ }

    // --- start() method modified to pass 'this' ---
    start() {
        logger.info('[Engine] >>> Entering start() method...');
        if (this.isRunning) { /* ... */ return; }
        this.isRunning = true; this.isCycleRunning = false; this.cycleCount = 0;
        logger.info(`[Engine start()] Starting run loop with interval: ${this.cycleInterval}ms`);

        // Initial immediate call - Use 'this' directly here, less likely to fail
        logger.info('[Engine start()] Attempting immediate first runCycle call...');
        setTimeout(async () => {
            console.log(`CONSOLE_LOG: [${new Date().toISOString()}] Inside setTimeout for initial runCycle call.`);
            if (!this.isRunning) { console.log(`CONSOLE_LOG: [${new Date().toISOString()}] Engine stopped before initial runCycle.`); return; }
            console.log(`CONSOLE_LOG: [${new Date().toISOString()}] Calling initial runCycle...`);
            // No need to bind here usually, but doesn't hurt
            await this.runCycle.call(this, true).catch(error => { // Use .call(this, ...)
                 console.error(`CONSOLE_LOG: [${new Date().toISOString()}] !!! CATCH BLOCK FOR INITIAL runCycle CALL !!!`); console.error(error);
                 logger.error("[Engine start()] Error during initial immediate runCycle execution:", error);
                 ErrorHandler.handleError(error, 'EngineImmediateCycle'); this.stop();
             });
        }, 50);

        logger.info('[Engine start()] Initial runCycle call scheduled. Setting interval...');

        // --- *** Pass 'this' (the engine instance) to the callback *** ---
        const self = this; // Create reference to 'this' that won't change context

        this.intervalId = setInterval(async () => {
            const intervalTime = new Date().toISOString();
            console.log(`CONSOLE_LOG: [${intervalTime}] setInterval callback triggered.`);
            try {
                 logger.debug(`[Engine Interval Callback / ${intervalTime}] Interval triggered.`);
                 // *** Use 'self' instead of 'this' inside the callback ***
                 console.log(`CONSOLE_LOG: [${intervalTime}] Checking conditions: isRunning=${self.isRunning}, isCycleRunning=${self.isCycleRunning}`);
                if (self.isRunning && !self.isCycleRunning) {
                     console.log(`CONSOLE_LOG: [${intervalTime}] Conditions met, calling runCycle via 'self'...`);
                     logger.debug(`[Engine Interval Callback / ${intervalTime}] Conditions met, calling runCycle...`);
                     // *** Call runCycle on the 'self' instance ***
                     self.runCycle(false).catch(error => {
                        console.error(`CONSOLE_LOG: [${new Date().toISOString()}] !!! CATCH BLOCK IN setInterval FOR runCycle Promise !!!`); console.error(error);
                        logger.error(`[Engine Interval RunCycle Catch / ${intervalTime}] Error during async runCycle execution (Cycle ${self.cycleCount}):`, error);
                        ErrorHandler.handleError(error, `EngineScheduledCycle_${self.cycleCount}`);
                        if (error instanceof ArbitrageError && error.isFatal) { self.stop(); } // Use self.stop()
                    });
                } else { /* ... unchanged logging for skipping, using self if needed ... */ }
            } catch (intervalCallbackError) { /* ... unchanged error handling ... */ }
        }, this.cycleInterval);
         // --- *** ---

         logger.info('[Engine start()] Interval set.');
         logger.info('[Engine] <<< Exiting start() method.');
    }
    // --- *** ---

    stop() { /* ... unchanged ... */ }

    // --- runCycle() method (Keep console logs) ---
    async runCycle(isInitialCall = false) {
        // ... (console logs and initial checks remain the same) ...
        console.log(`CONSOLE_LOG: [${new Date().toISOString()}] >>>>> Entered runCycle Method (${isInitialCall ? 'INITIAL' : 'SCHEDULED'} Call). Attempting Cycle ${this.cycleCount + 1} <<<<<`);
        if (!this.config) { /* ... fatal error ... */ } // Keep this check
        if (!this.isRunning) { /* ... */ return; }
        if (this.isCycleRunning && !isInitialCall) { /* ... */ return; }
        console.log(`CONSOLE_LOG: [${new Date().toISOString()}] Setting isCycleRunning = true`);
        this.isCycleRunning = true;
        this.cycleCount++;
        // ... (rest of runCycle is unchanged, uses 'this' which should now be correct) ...
        try {
             console.log(`CONSOLE_LOG: Cycle ${this.cycleCount} - Step 1 Start: Get Pool List`);
             const poolInfosToFetch = this.config.POOL_CONFIGS; // 'this' should be correct now
             if (!poolInfosToFetch || poolInfosToFetch.length === 0) { /* ... */ }
             console.log(`CONSOLE_LOG: Cycle ${this.cycleCount} - Step 1 End`);
             // ... etc ...
        } catch (error) { /* ... */ }
        finally { /* ... */ }
    }
    // --- *** ---

    logCycleEnd(cycleNum, startTime, fetchedPoolCount, executed = false, hadError = false) { /* ... unchanged ... */ }
}

module.exports = { ArbitrageEngine };
