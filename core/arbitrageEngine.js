// /workspaces/arbitrum-flash/core/arbitrageEngine.js
// --- VERSION 1.19: Cleaned up debug logs, final fixes from v1.16 ---

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
        logger.info('[Engine Constructor] Initializing ArbitrageEngine...');
        // --- Validation ---
        if (!manager || !(manager instanceof FlashSwapManager)) { throw new ArbitrageError('EngineInit', 'Invalid Manager'); }
        if (!config) { throw new ArbitrageError('EngineInit', 'Config object required'); }
        const requiredConfigKeys = [ 'POOL_CONFIGS', 'CYCLE_INTERVAL_MS', 'MIN_PROFIT_THRESHOLDS', 'MAX_GAS_GWEI', 'GAS_ESTIMATE_BUFFER_PERCENT', 'FALLBACK_GAS_LIMIT', 'PROFIT_BUFFER_PERCENT', 'DRY_RUN', 'STOP_ON_FIRST_EXECUTION', 'CHAINLINK_FEEDS', 'NATIVE_CURRENCY_SYMBOL'];
        const missingKeys = requiredConfigKeys.filter(key => !(key in config));
        if (missingKeys.length > 0) { throw new ArbitrageError('EngineInit', `Missing required config keys: ${missingKeys.join(', ')}`); }
        if (!Array.isArray(config.POOL_CONFIGS)) { throw new ArbitrageError('EngineInit', 'Config.POOL_CONFIGS must be an array'); }
        if (typeof config.MIN_PROFIT_THRESHOLDS !== 'object' || !config.MIN_PROFIT_THRESHOLDS.DEFAULT || !config.MIN_PROFIT_THRESHOLDS.NATIVE) { throw new ArbitrageError('EngineInit', 'Config.MIN_PROFIT_THRESHOLDS invalid.'); }

        this.manager = manager; this.config = config; this.provider = manager.getProvider(); this.signer = manager.getSigner();

        logger.debug('[Engine Constructor] Parsing configuration values...');
        try { this.config.parsed = { maxGasGweiParsed: parseFloat(config.MAX_GAS_GWEI || '0.5'), gasEstimateBufferPercent: parseInt(config.GAS_ESTIMATE_BUFFER_PERCENT || '20', 10), fallbackGasLimitParsed: BigInt(config.FALLBACK_GAS_LIMIT || '3000000'), };
             if (isNaN(this.config.parsed.maxGasGweiParsed) || this.config.parsed.maxGasGweiParsed <= 0) { throw new Error('Invalid MAX_GAS_GWEI value'); }
             logger.debug('[Engine Constructor] Config parsing complete.');
        } catch (parseError) { logger.error('[Engine Constructor] CRITICAL: Failed to parse configuration values.', parseError); throw new ArbitrageError('EngineInit', `Config Parsing Error: ${parseError.message}`); }

        logger.debug('[Engine Constructor] Initializing core components...');
        try {
            this.quoteSimulator = new QuoteSimulator(this.provider, this.config);
            this.poolScanner = new PoolScanner(this.config, this.provider);
            this.gasEstimator = new GasEstimator(this.provider, this.config);
            const profitCalcConfig = { MIN_PROFIT_THRESHOLDS: config.MIN_PROFIT_THRESHOLDS, PROFIT_BUFFER_PERCENT: config.PROFIT_BUFFER_PERCENT, provider: this.provider, chainlinkFeeds: config.CHAINLINK_FEEDS, NATIVE_CURRENCY_SYMBOL: config.NATIVE_CURRENCY_SYMBOL, WRAPPED_NATIVE_SYMBOL: config.WRAPPED_NATIVE_SYMBOL || 'WETH'};
            this.profitCalculator = new ProfitCalculator(profitCalcConfig);
            this.triangularV3Finder = new TriangularV3Finder();
            this.spatialFinder = new SpatialFinder();
            logger.debug('[Engine Constructor] Core component initialization complete.');
        } catch (initError) { logger.error('[Engine Constructor] CRITICAL: Failed to initialize core components.', initError); throw new ArbitrageError('EngineInit', `Component Init Error: ${initError.message}`); }

        this.isRunning = false; this.isCycleRunning = false; this.cycleCount = 0;
        this.cycleInterval = parseInt(this.config.CYCLE_INTERVAL_MS || '5000', 10);
        this.intervalId = null;
        logger.info('[Engine Constructor] Arbitrage Engine Constructor Finished Successfully.');
    }

    async initialize() {
         logger.info('[Engine] >>> Entering initialize() method...');
         try {
            logger.info('[Engine initialize()] Performing async setup steps (if any)...');
            await Promise.resolve();
            logger.info('[Engine initialize()] Async setup steps complete.');
            logger.info('[Engine] <<< Exiting initialize() method successfully.');
         } catch(err) {
            logger.error('[Engine CRITICAL] Failed during engine initialize() method.', err);
            throw err;
         }
    }

    // --- start() method using 'self' ---
    start() {
        logger.info('[Engine] >>> Entering start() method...');
        if (this.isRunning) { logger.warn('[Engine start()] Already running.'); return; }
        this.isRunning = true; this.isCycleRunning = false; this.cycleCount = 0;
        logger.info(`[Engine start()] Starting run loop with interval: ${this.cycleInterval}ms`);

        const self = this; // Reference for callbacks

        // Initial immediate call
        logger.info('[Engine start()] Attempting immediate first runCycle call...');
        setTimeout(async () => {
            if (!self.isRunning) return;
            // Use .call to ensure 'this' context, although setTimeout usually preserves it
            await self.runCycle.call(self, true).catch(error => {
                 logger.error("[Engine start()] Error during initial runCycle execution:", error);
                 ErrorHandler.handleError(error, 'EngineImmediateCycle');
                 self.stop();
             });
        }, 50);

        logger.info('[Engine start()] Initial runCycle call scheduled. Setting interval...');

        this.intervalId = setInterval(async () => {
            const intervalTime = new Date().toISOString();
            try {
                 logger.debug(`[Engine Interval Callback / ${intervalTime}] Interval triggered.`);
                if (self.isRunning && !self.isCycleRunning) {
                     logger.debug(`[Engine Interval Callback / ${intervalTime}] Conditions met, calling runCycle...`);
                     // Call runCycle without awaiting within interval
                     self.runCycle(false).catch(error => {
                        logger.error(`[Engine Interval RunCycle Catch / ${intervalTime}] Error during async runCycle execution (Cycle ${self.cycleCount}):`, error);
                        ErrorHandler.handleError(error, `EngineScheduledCycle_${self.cycleCount}`);
                        if (error instanceof ArbitrageError && error.isFatal) { self.stop(); }
                    });
                } else if (self.isCycleRunning) {
                    logger.warn(`[Engine Interval Callback / ${intervalTime}] Skipping cycle start - previous cycle (Cycle ${self.cycleCount}) still running.`);
                } else if (!self.isRunning) {
                    logger.warn(`[Engine Interval Callback / ${intervalTime}] Skipping cycle start - engine stopped (clearing interval).`);
                    if(self.intervalId) clearInterval(self.intervalId);
                    self.intervalId = null;
                }
            } catch (intervalCallbackError) {
                 logger.error(`[Engine Interval Callback / ${intervalTime}] CRITICAL ERROR inside interval callback: ${intervalCallbackError.message}`, intervalCallbackError);
                 // self.stop(); // Optional: Stop engine if interval itself breaks
            }
        }, this.cycleInterval);

         logger.info('[Engine start()] Interval set.');
         logger.info('[Engine] <<< Exiting start() method.');
    }
    // --- *** ---

    stop() {
         logger.warn('[Engine] >>> Entering stop() method...');
         if (!this.isRunning) { logger.warn('[Engine stop()] Stop called but not running.'); return; }
         logger.warn('[Engine stop()] Stopping run loop...');
         this.isRunning = false;
         if (this.intervalId) {
             logger.warn('[Engine stop()] Clearing interval...');
             clearInterval(this.intervalId);
             this.intervalId = null;
         }
         logger.warn('[Engine stop()] Run loop stopped.');
         logger.warn('[Engine] <<< Exiting stop() method.');
    }

    // --- runCycle() method - Cleaned up ---
    async runCycle(isInitialCall = false) {
        const callType = isInitialCall ? 'INITIAL' : 'SCHEDULED';
        logger.debug(`[Engine runCycle / ${callType}] Entered. Attempting Cycle ${this.cycleCount + 1}`);

        if (!this.config) { logger.error(`[Engine Cycle ${this.cycleCount + 1}] CRITICAL ERROR: this.config is not defined!`); this.stop(); return; }
        if (!this.isRunning) { logger.warn(`[Engine runCycle / ${callType}] Exiting early: !isRunning.`); return; }
        // Allow initial call to proceed even if lock seems set (could be race condition)
        if (this.isCycleRunning && !isInitialCall) { logger.warn(`[Engine runCycle / ${callType}] Exiting early: isCycleRunning=true.`); return; }

        this.isCycleRunning = true; // Set Lock
        this.cycleCount++;
        const currentCycleNum = this.cycleCount;
        const cycleStartTime = Date.now();
        logger.info(`\n===== [Engine] Starting Cycle #${currentCycleNum} at ${new Date().toISOString()} =====`);

        let fetchedPoolCount = -1; let executedThisCycle = false; let cycleError = null;

        try {
            // Step 1: Get Pool List
            logger.debug(`[Engine Cycle ${currentCycleNum}] Step 1: Getting pool list from config...`);
            const poolInfosToFetch = this.config.POOL_CONFIGS;
            if (!poolInfosToFetch || poolInfosToFetch.length === 0) { throw new ArbitrageError('RunCycleError', 'No pool configurations found.', true); }
            logger.debug(`[Engine Cycle ${currentCycleNum}] Step 1 Complete: Found ${poolInfosToFetch.length} pools.`);

            // Step 2: Fetch Live Pool States & Build Registry
            logger.debug(`[Engine Cycle ${currentCycleNum}] Step 2: Fetching live states and building registry...`);
            const { livePoolStatesMap, pairRegistry } = await this.poolScanner.fetchPoolStates(poolInfosToFetch);
            fetchedPoolCount = Object.keys(livePoolStatesMap).length;
            logger.info(`[Engine Cycle ${currentCycleNum}] Step 2 Complete: Fetched ${fetchedPoolCount} states, built registry with ${Object.keys(pairRegistry).length} pairs.`);

            // Step 3: Find Opportunities
            logger.debug(`[Engine Cycle ${currentCycleNum}] Step 3: Finding potential opportunities...`);
            let triangularOpportunities = []; let spatialOpportunities = [];
            try {
                 triangularOpportunities = this.triangularV3Finder.findOpportunities(livePoolStatesMap);
                 spatialOpportunities = this.spatialFinder.findOpportunities(pairRegistry);
            } catch (finderError) { logger.error(`[Engine Cycle ${currentCycleNum}] Step 3 Error: Failure during finding.`, finderError); }
            const potentialOpportunities = [...triangularOpportunities, ...spatialOpportunities];
            logger.info(`[Engine Cycle ${currentCycleNum}] Step 3 Complete: Found ${potentialOpportunities.length} potential opportunities (${triangularOpportunities.length} Tri, ${spatialOpportunities.length} Spatial).`);

            // Step 4: Process Opportunities
            if (potentialOpportunities.length === 0) {
                 logger.info(`[Engine Cycle ${currentCycleNum}] Step 4: No potential opportunities found this cycle.`);
            } else {
                 logger.info(`[Engine Cycle ${currentCycleNum}] Step 4: Processing ${potentialOpportunities.length} potential opportunities...`);
                 const engineContext = { gasEstimator: this.gasEstimator, profitCalculator: this.profitCalculator, quoteSimulator: this.quoteSimulator, flashSwapManager: this.manager, config: this.config, provider: this.provider, signer: this.signer, currentCycle: currentCycleNum };
                 for (const opp of potentialOpportunities) {
                     if (!this.isRunning) { logger.warn(`[Engine Cycle ${currentCycleNum}] Engine stopped during opp processing.`); break; }
                     try {
                         const result = await processOpportunity(opp, engineContext);
                         if (result && result.executed) {
                             executedThisCycle = true;
                             const stopAfterFirst = this.config.STOP_ON_FIRST_EXECUTION === true || this.config.STOP_ON_FIRST_EXECUTION === 'true';
                             if (stopAfterFirst) { logger.info(`[Engine Cycle ${currentCycleNum}] STOP_ON_FIRST_EXECUTION enabled.`); this.stop(); break; }
                         }
                     } catch (processingError) { logger.error(`[Engine Cycle ${currentCycleNum}] Error processing opp:`, processingError); ErrorHandler.handleError(processingError, `OpportunityProcessing_${currentCycleNum}`);}
                 }
                 logger.info(`[Engine Cycle ${currentCycleNum}] Step 4 Complete: Finished processing opportunities.${executedThisCycle ? ' (Executed at least one)' : ''}`);
            }

        } catch (error) {
             cycleError = error;
             logger.error(`[Engine Cycle ${currentCycleNum}] CRITICAL ERROR during cycle execution: ${error.message}`, error);
             ErrorHandler.handleError(error, `RunCycleCritical_${currentCycleNum}`);
             if (error instanceof ArbitrageError && error.isFatal) { this.stop(); }
        } finally {
            this.logCycleEnd(currentCycleNum, cycleStartTime, fetchedPoolCount, executedThisCycle, !!cycleError);
            this.isCycleRunning = false; // Release lock
            logger.debug(`[Engine Cycle ${currentCycleNum}] <<< Exiting runCycle. Cycle lock released.`);
        }
    }
    // --- *** ---

    logCycleEnd(cycleNum, startTime, fetchedPoolCount, executed = false, hadError = false) {
         const duration = Date.now() - startTime;
         const status = hadError ? 'ERRORED' : (executed ? 'EXECUTED_OPP' : 'COMPLETED');
         logger.info(`===== [Engine] Finished Cycle #${cycleNum} | Status: ${status} | Fetched: ${fetchedPoolCount >= 0 ? fetchedPoolCount : 'N/A'} Pools | Duration: ${duration}ms =====\n`);
     }
}

module.exports = { ArbitrageEngine };
