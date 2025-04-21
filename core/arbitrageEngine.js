// /workspaces/arbitrum-flash/core/arbitrageEngine.js
// --- VERSION 1.18: Deepseek Debugging - Force Error, Verbose Finally ---

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
        logger.info('[Engine Constructor] Initializing ArbitrageEngine...');
        if (!manager || !(manager instanceof FlashSwapManager)) { /* ... */ }
        if (!config) { /* ... */ }
        const requiredConfigKeys = [ /* ... */ ];
        const missingKeys = requiredConfigKeys.filter(key => !(key in config));
        if (missingKeys.length > 0) { /* ... */ }
        if (!Array.isArray(config.POOL_CONFIGS) || config.POOL_CONFIGS.length === 0) { /* ... */ }
        if (typeof config.MIN_PROFIT_THRESHOLDS !== 'object' || !config.MIN_PROFIT_THRESHOLDS.DEFAULT || !config.MIN_PROFIT_THRESHOLDS.NATIVE) { /* ... */ }
        this.manager = manager; this.config = config; this.provider = manager.getProvider(); this.signer = manager.getSigner();
        try { this.config.parsed = { /* ... */ }; } catch (e) { /*...*/ }
        try {
            this.quoteSimulator = new QuoteSimulator(this.provider, this.config);
            this.poolScanner = new PoolScanner(this.config, this.provider);
            this.gasEstimator = new GasEstimator(this.provider, this.config);
            const profitCalcConfig = { /* ... passes explicit config ... */ };
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

    // --- start() method (Keep explicit 'self' reference) ---
    start() {
        logger.info('[Engine] >>> Entering start() method...');
        if (this.isRunning) { /* ... */ return; }
        this.isRunning = true; this.isCycleRunning = false; this.cycleCount = 0;
        logger.info(`[Engine start()] Starting run loop with interval: ${this.cycleInterval}ms`);

        const self = this; // Reference for callbacks

        // Initial immediate call
        logger.info('[Engine start()] Attempting immediate first runCycle call...');
        setTimeout(async () => {
            console.log(`CONSOLE_LOG: [${new Date().toISOString()}] Inside setTimeout for initial runCycle call.`);
            if (!self.isRunning) { /* ... */ return; }
            console.log(`CONSOLE_LOG: [${new Date().toISOString()}] Calling initial runCycle...`);
            await self.runCycle(true).catch(error => { /* ... */ });
        }, 50);

        logger.info('[Engine start()] Initial runCycle call scheduled. Setting interval...');

        this.intervalId = setInterval(async () => {
            const intervalTime = new Date().toISOString();
            console.log(`CONSOLE_LOG: [${intervalTime}] setInterval callback triggered.`);
            try {
                logger.debug(`[Engine Interval Callback / ${intervalTime}] Interval triggered.`);
                console.log(`CONSOLE_LOG: [${intervalTime}] Checking conditions: isRunning=${self.isRunning}, isCycleRunning=${self.isCycleRunning}`);
                if (self.isRunning && !self.isCycleRunning) {
                    console.log(`CONSOLE_LOG: [${intervalTime}] Conditions met, calling runCycle via 'self'...`);
                    logger.debug(`[Engine Interval Callback / ${intervalTime}] Conditions met, calling runCycle...`);
                    self.runCycle(false).catch(error => { /* ... */ });
                } else { /* ... */ }
            } catch (intervalCallbackError) { /* ... */ }
        }, this.cycleInterval);

        logger.info('[Engine start()] Interval set.');
        logger.info('[Engine] <<< Exiting start() method.');
    }
    // --- *** ---

    stop() { /* ... unchanged ... */ }

    // --- runCycle() method with Deepseek Debugging ---
    async runCycle(isInitialCall = false) {
        const callType = isInitialCall ? 'INITIAL' : 'SCHEDULED';
        const self = this; // Keep reference for nested async checks if needed, although 'this' should work now
        console.log(`CONSOLE_LOG: [${new Date().toISOString()}] >>>>> Entered runCycle Method (${callType} Call). Attempting Cycle ${this.cycleCount + 1} <<<<<`);
        console.log(`CONSOLE_LOG: Pre-check - isCycleRunning: ${this.isCycleRunning}, isRunning: ${this.isRunning}`); // Added Pre-check

        if (!this.config) { console.error(`CONSOLE_LOG: !!! FATAL in runCycle: this.config is undefined !!!`); this.stop(); return; } // Check config
        if (!this.isRunning) { console.log(`CONSOLE_LOG: Exiting runCycle early: !isRunning.`); return; } // Check running
        if (this.isCycleRunning && !isInitialCall) { console.log(`CONSOLE_LOG: Skipping due to lock (isCycleRunning: ${this.isCycleRunning})`); return; } // Check lock

        console.log(`CONSOLE_LOG: [${new Date().toISOString()}] Setting isCycleRunning = true`);
        this.isCycleRunning = true; // Set Lock
        const currentCycleNum = ++this.cycleCount; // Increment Cycle Count Here
        const cycleStartTime = Date.now();

        console.log(`CONSOLE_LOG: ===== [Engine / ${callType}] Starting Cycle Logic #${currentCycleNum} =====`);
        // console.log(`CONSOLE_LOG: Current this reference check: ${this === self ? 'VALID' : 'INVALID'}`); // Check 'this' reference (optional)

        let fetchedPoolCount = -1; let executedThisCycle = false; let cycleError = null;

        try {
            console.log(`CONSOLE_LOG: Cycle ${currentCycleNum} - Step 1 Start: Get Pool List`);
            const poolInfosToFetch = this.config.POOL_CONFIGS;
            console.log(`CONSOLE_LOG: Found ${poolInfosToFetch.length} pools to fetch in config`);
            if (!poolInfosToFetch || poolInfosToFetch.length === 0) { throw new ArbitrageError('RunCycleError', 'No pool configurations found in this.config.', true); }
            console.log(`CONSOLE_LOG: Cycle ${currentCycleNum} - Step 1 End`);

            console.log(`CONSOLE_LOG: Cycle ${currentCycleNum} - Step 2 Start: fetchPoolStates`);
            const fetchStart = Date.now();
            // --- *** ADDED .then and .catch for direct promise logging *** ---
            const poolStates = await this.poolScanner.fetchPoolStates(poolInfosToFetch)
                .then(res => {
                    console.log(`CONSOLE_LOG: fetchPoolStates resolved successfully after ${Date.now() - fetchStart}ms`);
                    return res; // Pass the result through
                })
                .catch(err => {
                    // This catch might not be hit if PoolScanner's internal catch returns null
                    console.error(`CONSOLE_LOG: fetchPoolStates promise REJECTED after ${Date.now() - fetchStart}ms`);
                    throw err; // Re-throw to be caught by outer try/catch
                });
             // --- *** ---

            // Check if poolStates is valid (could be {} if scanner failed internally)
             if (!poolStates || !poolStates.livePoolStatesMap || !poolStates.pairRegistry) {
                 logger.warn(`[Engine Cycle ${currentCycleNum}] PoolScanner returned invalid data structure. Skipping rest of cycle.`);
                 throw new Error("PoolScanner returned invalid data."); // Force into catch block
             }

            fetchedPoolCount = Object.keys(poolStates.livePoolStatesMap).length;
            console.log(`CONSOLE_LOG: Fetched ${fetchedPoolCount} pool states. Registry has ${Object.keys(poolStates.pairRegistry).length} pairs.`);
            console.log(`CONSOLE_LOG: Cycle ${currentCycleNum} - Step 2 End`);

            // --- *** TEMPORARILY SKIPPING Steps 3 & 4 *** ---
            console.log(`CONSOLE_LOG: Cycle ${currentCycleNum} - Skipping Step 3 (Find Opps)`);
            console.log(`CONSOLE_LOG: Cycle ${currentCycleNum} - Skipping Step 4 (Process Opps)`);
            // --- *** ---

            // --- *** Force an error to explicitly test finally block *** ---
            console.log(`CONSOLE_LOG: Cycle ${currentCycleNum} - Throwing TEST ERROR to check finally block execution...`);
            throw new Error('TEST ERROR - This should trigger finally block');
            // --- *** ---

        } catch (error) {
             cycleError = error; // Store the error
             console.log(`CONSOLE_LOG: !!!!! CATCH BLOCK IN runCycle (Cycle ${currentCycleNum}) !!!!! Error: ${error.message}`);
             // Log full error if needed for debugging
             // console.error(error);
             logger.error(`[Engine Cycle ${currentCycleNum}] ERROR during cycle execution: ${error.message}`, error instanceof Error ? error : undefined); // Log actual error object if available
             // ErrorHandler.handleError(error, `RunCycleCritical_${currentCycleNum}`); // Can optionally call global handler
             if (error instanceof ArbitrageError && error.isFatal) {
                 console.log(`CONSOLE_LOG: Stopping engine due to fatal error flag.`);
                 this.stop();
             }
        } finally {
             // --- *** ADDED VERBOSE FINALLY LOGGING *** ---
             console.log(`CONSOLE_LOG: [${new Date().toISOString()}] >>> ENTERED FINALLY BLOCK for runCycle ${currentCycleNum} <<<`);
             console.log(`CONSOLE_LOG: Error caught in try block was: ${cycleError ? `'${cycleError.message}'` : 'null'}`);
             console.log(`CONSOLE_LOG: State before release: isCycleRunning=${this.isCycleRunning}, cycleCount=${this.cycleCount}`);
             this.isCycleRunning = false; // Release the lock
             console.log(`CONSOLE_LOG: State after release: isCycleRunning=${this.isCycleRunning}`);
             this.logCycleEnd(currentCycleNum, cycleStartTime, fetchedPoolCount, executedThisCycle, !!cycleError); // Log the outcome
             console.log(`CONSOLE_LOG: [${new Date().toISOString()}] <<< EXITING FINALLY BLOCK for runCycle ${currentCycleNum} >>>`);
             logger.debug(`[Engine Cycle ${currentCycleNum}] <<< Exiting runCycle. Cycle lock released.`);
             // --- *** ---
        }
    }
    // --- *** END runCycle() *** ---

    logCycleEnd(cycleNum, startTime, fetchedPoolCount, executed = false, hadError = false) { /* ... unchanged ... */ }
}

module.exports = { ArbitrageEngine };
