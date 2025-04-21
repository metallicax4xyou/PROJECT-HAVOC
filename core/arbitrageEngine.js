// /workspaces/arbitrum-flash/core/arbitrageEngine.js
// --- VERSION 1.14: EXTREMELY Verbose logging for cycle start/end/error ---

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

    // --- start() method ---
    start() {
        logger.info('[Engine] >>> Entering start() method...');
        if (this.isRunning) { /* ... */ return; }
        this.isRunning = true; this.isCycleRunning = false; this.cycleCount = 0;
        logger.info(`[Engine start()] Starting run loop with interval: ${this.cycleInterval}ms`);

        // Initial immediate call
        logger.info('[Engine start()] Attempting immediate first runCycle call...');
        setTimeout(async () => {
            console.log(`CONSOLE_LOG: [${new Date().toISOString()}] Inside setTimeout for initial runCycle call.`);
            if (!this.isRunning) { console.log(`CONSOLE_LOG: [${new Date().toISOString()}] Engine stopped before initial runCycle.`); return; }
            console.log(`CONSOLE_LOG: [${new Date().toISOString()}] Calling initial runCycle...`);
            await this.runCycle(true).catch(error => { // Pass flag indicating initial call
                 console.error(`CONSOLE_LOG: [${new Date().toISOString()}] !!! CATCH BLOCK FOR INITIAL runCycle CALL !!!`);
                 console.error(error);
                 logger.error("[Engine start()] Error during initial immediate runCycle execution:", error);
                 ErrorHandler.handleError(error, 'EngineImmediateCycle');
                 this.stop();
             });
        }, 50); // Slightly longer delay just in case

        logger.info('[Engine start()] Initial runCycle call scheduled. Setting interval...');

        this.intervalId = setInterval(async () => {
            const intervalTime = new Date().toISOString();
            console.log(`CONSOLE_LOG: [${intervalTime}] setInterval callback triggered.`); // Log trigger time
            try {
                 logger.debug(`[Engine Interval Callback / ${intervalTime}] Interval triggered.`);
                 console.log(`CONSOLE_LOG: [${intervalTime}] Checking conditions: isRunning=${this.isRunning}, isCycleRunning=${this.isCycleRunning}`); // Log conditions check
                if (this.isRunning && !this.isCycleRunning) {
                     console.log(`CONSOLE_LOG: [${intervalTime}] Conditions met, attempting to call runCycle...`);
                     logger.debug(`[Engine Interval Callback / ${intervalTime}] Conditions met, calling runCycle...`);
                    // Don't await runCycle directly here
                    this.runCycle(false).catch(error => { // Pass flag indicating scheduled call
                        console.error(`CONSOLE_LOG: [${new Date().toISOString()}] !!! CATCH BLOCK IN setInterval FOR runCycle Promise !!!`);
                        console.error(error);
                        logger.error(`[Engine Interval RunCycle Catch / ${intervalTime}] Error during async runCycle execution (Cycle ${this.cycleCount}):`, error);
                        ErrorHandler.handleError(error, `EngineScheduledCycle_${this.cycleCount}`);
                        if (error instanceof ArbitrageError && error.isFatal) { this.stop(); }
                    });
                } else { /* ... unchanged logging for skipping ... */ }
            } catch (intervalCallbackError) {
                 console.error(`CONSOLE_LOG: [${intervalTime}] !!! ERROR INSIDE setInterval CALLBACK !!!`);
                 console.error(intervalCallbackError);
                 logger.error(`[Engine Interval Callback / ${intervalTime}] CRITICAL ERROR inside interval callback itself: ${intervalCallbackError.message}`, intervalCallbackError);
            }
        }, this.cycleInterval);

         logger.info('[Engine start()] Interval set.');
         logger.info('[Engine] <<< Exiting start() method.');
    }
    // --- *** ---

    stop() { /* ... unchanged ... */ }

    // --- runCycle() method with EXTREME logging ---
    async runCycle(isInitialCall = false) { // Added flag for context
        const callType = isInitialCall ? 'INITIAL' : 'SCHEDULED';
        console.log(`CONSOLE_LOG: [${new Date().toISOString()}] >>>>> Entered runCycle Method (${callType} Call). Attempting Cycle ${this.cycleCount + 1} <<<<<`);

        if (!this.isRunning) { /* ... */ return; }
        if (this.isCycleRunning && !isInitialCall) { // Allow initial call even if somehow locked? Maybe not wise. Check if lock is true.
            console.log(`CONSOLE_LOG: [${new Date().toISOString()}] Exiting ${callType} runCycle early: isCycleRunning=${this.isCycleRunning}. Aborting.`);
            logger.warn(`[Engine runCycle / ${callType}] Attempted to start cycle ${this.cycleCount + 1} while cycle ${this.cycleCount} is already running. Aborting.`);
            return;
         }

        console.log(`CONSOLE_LOG: [${new Date().toISOString()}] Setting isCycleRunning = true`);
        this.isCycleRunning = true;
        // Increment cycle count only if it's not the immediate initial call overlapping with first scheduled? Or just always increment.
        this.cycleCount++;
        const currentCycleNum = this.cycleCount;
        const cycleStartTime = Date.now();
        console.log(`CONSOLE_LOG: ===== [Engine / ${callType}] Starting Cycle Logic #${currentCycleNum} =====`);
        logger.info(`\n===== [Engine] Starting Cycle #${currentCycleNum} at ${new Date().toISOString()} =====`);

        let fetchedPoolCount = -1; let executedThisCycle = false; let cycleError = null;

        try {
            console.log(`CONSOLE_LOG: Cycle ${currentCycleNum} - Step 1 Start: Get Pool List`);
            const poolInfosToFetch = this.config.POOL_CONFIGS;
            if (!poolInfosToFetch || poolInfosToFetch.length === 0) { throw new ArbitrageError('RunCycleError', 'No pool configurations found.', true); }
            console.log(`CONSOLE_LOG: Cycle ${currentCycleNum} - Step 1 End: Found ${poolInfosToFetch.length} pools`);

            console.log(`CONSOLE_LOG: Cycle ${currentCycleNum} - Step 2 Start: Fetch Pool States`);
            const { livePoolStatesMap, pairRegistry } = await this.poolScanner.fetchPoolStates(poolInfosToFetch);
            fetchedPoolCount = Object.keys(livePoolStatesMap).length;
            if (fetchedPoolCount === 0 && poolInfosToFetch.length > 0) { logger.warn(`[Engine Cycle ${currentCycleNum}] Step 2 Warning: Failed to fetch state for any pools.`); }
            else { logger.info(`[Engine Cycle ${currentCycleNum}] Step 2 Complete: Fetched ${fetchedPoolCount} states, built registry with ${Object.keys(pairRegistry).length} pairs.`); }
            console.log(`CONSOLE_LOG: Cycle ${currentCycleNum} - Step 2 End`);

            console.log(`CONSOLE_LOG: Cycle ${currentCycleNum} - Step 3 Start: Find Opportunities`);
            let triangularOpportunities = []; let spatialOpportunities = [];
            try {
                 triangularOpportunities = this.triangularV3Finder.findOpportunities(livePoolStatesMap);
                 spatialOpportunities = this.spatialFinder.findOpportunities(pairRegistry);
            } catch (finderError) { logger.error(`[Engine Cycle ${currentCycleNum}] Step 3 Error: Failure during finding.`, finderError); }
            const potentialOpportunities = [...triangularOpportunities, ...spatialOpportunities];
            logger.info(`[Engine Cycle ${currentCycleNum}] Step 3 Complete: Found ${potentialOpportunities.length} potential opportunities (${triangularOpportunities.length} Tri, ${spatialOpportunities.length} Spatial).`);
            console.log(`CONSOLE_LOG: Cycle ${currentCycleNum} - Step 3 End`);

            console.log(`CONSOLE_LOG: Cycle ${currentCycleNum} - Step 4 Start: Process Opportunities`);
            if (potentialOpportunities.length === 0) {
                 logger.info(`[Engine Cycle ${currentCycleNum}] Step 4: No opportunities found.`);
                 // No need to call logCycleEnd here, finally block handles it
            } else {
                 logger.info(`[Engine Cycle ${currentCycleNum}] Step 4: Processing ${potentialOpportunities.length} opportunities...`);
                 const engineContext = { /* ... */ };
                 for (const opp of potentialOpportunities) {
                     if (!this.isRunning) { logger.warn(`[Engine Cycle ${currentCycleNum}] Engine stopped during opp processing.`); break; }
                     try {
                         const result = await processOpportunity(opp, engineContext); // Assuming processOpportunity exists and works
                         if (result && result.executed) {
                             executedThisCycle = true;
                             const stopAfterFirst = this.config.STOP_ON_FIRST_EXECUTION === true || this.config.STOP_ON_FIRST_EXECUTION === 'true';
                             if (stopAfterFirst) { logger.info(`[Engine Cycle ${currentCycleNum}] STOP_ON_FIRST_EXECUTION enabled.`); this.stop(); break; }
                         }
                     } catch (processingError) { /* ... error handling ... */ }
                 }
                 logger.info(`[Engine Cycle ${currentCycleNum}] Step 4 Complete: Finished processing.`);
            }
            console.log(`CONSOLE_LOG: Cycle ${currentCycleNum} - Step 4 End`);

        } catch (error) {
             cycleError = error; // Store error to log in finally
             console.error(`CONSOLE_LOG: !!!!! CATCH BLOCK IN runCycle (Cycle ${currentCycleNum}) !!!!!`);
             console.error(error);
             logger.error(`[Engine Cycle ${currentCycleNum}] CRITICAL ERROR during cycle execution: ${error.message}`, error);
             ErrorHandler.handleError(error, `RunCycleCritical_${currentCycleNum}`);
             if (error instanceof ArbitrageError && error.isFatal) { this.stop(); }
        } finally {
            // Ensure lock is always released and cycle end is logged
            console.log(`CONSOLE_LOG: [${new Date().toISOString()}] >>> FINALLY block for runCycle ${currentCycleNum}. Error was: ${cycleError ? cycleError.message : 'null'} <<<`);
            this.logCycleEnd(currentCycleNum, cycleStartTime, fetchedPoolCount, executedThisCycle, !!cycleError); // Log end status
            console.log(`CONSOLE_LOG: [${new Date().toISOString()}] Releasing runCycle lock for Cycle ${currentCycleNum}. Setting isCycleRunning = false`);
            this.isCycleRunning = false;
            logger.debug(`[Engine Cycle ${currentCycleNum}] <<< Exiting runCycle. Cycle lock released.`);
        }
    }
    // --- *** ---

    logCycleEnd(cycleNum, startTime, fetchedPoolCount, executed = false, hadError = false) { /* ... unchanged ... */ }
}

module.exports = { ArbitrageEngine };
