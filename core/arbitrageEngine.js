// /workspaces/arbitrum-flash/core/arbitrageEngine.js
// --- VERSION 1.15: Explicitly bind 'this' in setInterval runCycle call ---

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
    constructor(manager, config) { /* ... unchanged constructor ... */ }
    async initialize() { /* ... unchanged ... */ }

    // --- start() method with explicit 'this' binding ---
    start() {
        logger.info('[Engine] >>> Entering start() method...');
        if (this.isRunning) { /* ... */ return; }
        this.isRunning = true; this.isCycleRunning = false; this.cycleCount = 0;
        logger.info(`[Engine start()] Starting run loop with interval: ${this.cycleInterval}ms`);

        // Initial immediate call
        logger.info('[Engine start()] Attempting immediate first runCycle call...');
        setTimeout(async () => {
            if (!this.isRunning) return;
            // Call initial cycle, bind 'this' for safety although setTimeout often preserves it
            await this.runCycle.bind(this)(true).catch(error => {
                 console.error(`CONSOLE_LOG: [${new Date().toISOString()}] !!! CATCH BLOCK FOR INITIAL runCycle CALL !!!`); console.error(error);
                 logger.error("[Engine start()] Error during initial immediate runCycle execution:", error);
                 ErrorHandler.handleError(error, 'EngineImmediateCycle'); this.stop();
             });
        }, 50);

        logger.info('[Engine start()] Initial runCycle call scheduled. Setting interval...');

        // *** BIND 'this' to the runCycle method reference ***
        const boundRunCycle = this.runCycle.bind(this);

        this.intervalId = setInterval(async () => {
            const intervalTime = new Date().toISOString();
            console.log(`CONSOLE_LOG: [${intervalTime}] setInterval callback triggered.`);
            try {
                 logger.debug(`[Engine Interval Callback / ${intervalTime}] Interval triggered.`);
                 console.log(`CONSOLE_LOG: [${intervalTime}] Checking conditions: isRunning=${this.isRunning}, isCycleRunning=${this.isCycleRunning}`);
                if (this.isRunning && !this.isCycleRunning) {
                     console.log(`CONSOLE_LOG: [${intervalTime}] Conditions met, calling BOUND runCycle...`);
                     logger.debug(`[Engine Interval Callback / ${intervalTime}] Conditions met, calling runCycle...`);
                     // *** Call the BOUND function ***
                     boundRunCycle(false).catch(error => { // Call boundRunCycle, pass 'false' for scheduled call
                        console.error(`CONSOLE_LOG: [${new Date().toISOString()}] !!! CATCH BLOCK IN setInterval FOR runCycle Promise !!!`); console.error(error);
                        logger.error(`[Engine Interval RunCycle Catch / ${intervalTime}] Error during async runCycle execution (Cycle ${this.cycleCount}):`, error);
                        ErrorHandler.handleError(error, `EngineScheduledCycle_${this.cycleCount}`);
                        if (error instanceof ArbitrageError && error.isFatal) { this.stop(); }
                    });
                } else { /* ... unchanged logging for skipping ... */ }
            } catch (intervalCallbackError) { /* ... unchanged error handling ... */ }
        }, this.cycleInterval);

         logger.info('[Engine start()] Interval set.');
         logger.info('[Engine] <<< Exiting start() method.');
    }
    // --- *** ---

    stop() { /* ... unchanged ... */ }

    // --- runCycle() method (Keep console logs for now) ---
    async runCycle(isInitialCall = false) {
        const callType = isInitialCall ? 'INITIAL' : 'SCHEDULED';
        console.log(`CONSOLE_LOG: [${new Date().toISOString()}] >>>>> Entered runCycle Method (${callType} Call). Attempting Cycle ${this.cycleCount + 1} <<<<<`);

        // --- *** ADD CHECK FOR this.config at the VERY START *** ---
        if (!this.config) {
            console.error(`CONSOLE_LOG: [${new Date().toISOString()}] !!! FATAL in runCycle: this.config is undefined/null !!!`);
            logger.error(`[Engine Cycle ${this.cycleCount + 1}] CRITICAL ERROR: this.config is not defined at the start of runCycle!`);
            this.stop(); // Stop the engine if config is missing
            return;
        }
        // --- *** ---

        if (!this.isRunning) { /* ... */ return; }
        if (this.isCycleRunning) { /* Allow initial call, but block subsequent? */
             if (!isInitialCall) { // Block scheduled calls if already running
                 console.log(`CONSOLE_LOG: [${new Date().toISOString()}] Exiting ${callType} runCycle early: isCycleRunning=${this.isCycleRunning}. Aborting.`);
                 logger.warn(`[Engine runCycle / ${callType}] Attempted to start cycle ${this.cycleCount + 1} while cycle ${this.cycleCount} is already running. Aborting.`);
                 return;
             } else {
                 console.log(`CONSOLE_LOG: [${new Date().toISOString()}] Warning: Initial runCycle called while isCycleRunning is true. Proceeding cautiously.`);
                 // Decide if initial call should also be blocked. For now, allow it maybe?
             }
        }

        console.log(`CONSOLE_LOG: [${new Date().toISOString()}] Setting isCycleRunning = true`);
        this.isCycleRunning = true;
        this.cycleCount++;
        const currentCycleNum = this.cycleCount;
        const cycleStartTime = Date.now();
        console.log(`CONSOLE_LOG: ===== [Engine / ${callType}] Starting Cycle Logic #${currentCycleNum} =====`);
        logger.info(`\n===== [Engine] Starting Cycle #${currentCycleNum} at ${new Date().toISOString()} =====`);

        let fetchedPoolCount = -1; let executedThisCycle = false; let cycleError = null;

        try {
            console.log(`CONSOLE_LOG: Cycle ${currentCycleNum} - Step 1 Start: Get Pool List`);
            // Now use 'this.config' which we checked above
            const poolInfosToFetch = this.config.POOL_CONFIGS;
            if (!poolInfosToFetch || poolInfosToFetch.length === 0) { throw new ArbitrageError('RunCycleError', 'No pool configurations found in this.config.', true); }
            console.log(`CONSOLE_LOG: Cycle ${currentCycleNum} - Step 1 End: Found ${poolInfosToFetch.length} pools`);

            console.log(`CONSOLE_LOG: Cycle ${currentCycleNum} - Step 2 Start: Fetch Pool States`);
            // Pass 'this.config' if needed by scanner, though constructor already got it
            const { livePoolStatesMap, pairRegistry } = await this.poolScanner.fetchPoolStates(poolInfosToFetch);
            fetchedPoolCount = Object.keys(livePoolStatesMap).length;
            /* ... logging ... */
            console.log(`CONSOLE_LOG: Cycle ${currentCycleNum} - Step 2 End`);

            console.log(`CONSOLE_LOG: Cycle ${currentCycleNum} - Step 3 Start: Find Opportunities`);
            /* ... find opportunities ... */
            console.log(`CONSOLE_LOG: Cycle ${currentCycleNum} - Step 3 End`);

            console.log(`CONSOLE_LOG: Cycle ${currentCycleNum} - Step 4 Start: Process Opportunities`);
            /* ... process opportunities ... */
            console.log(`CONSOLE_LOG: Cycle ${currentCycleNum} - Step 4 End`);

        } catch (error) { /* ... unchanged error handling ... */ }
        finally { /* ... unchanged finally block ... */ }
    }
    // --- *** ---

    logCycleEnd(cycleNum, startTime, fetchedPoolCount, executed = false, hadError = false) { /* ... unchanged ... */ }
}

module.exports = { ArbitrageEngine };
