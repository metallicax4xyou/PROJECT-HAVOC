// /workspaces/arbitrum-flash/core/arbitrageEngine.js
// --- Added console.log to runCycle catch block ---
// --- Includes previous logging enhancements from initialize() and start() ---

const { ethers } = require('ethers');
const { PoolScanner } = require('./poolScanner');
const GasEstimator = require('./gasEstimator');
const ProfitCalculator = require('./profitCalculator');
const logger = require('../utils/logger');
const ErrorHandler = require('../utils/errorHandler'); // Use ErrorHandler if available
const FlashSwapManager = require('./flashSwapManager');
const { processOpportunity } = require('./opportunityProcessor');
const { ArbitrageError } = require('../utils/errorHandler'); // Ensure ArbitrageError is imported
const QuoteSimulator = require('./quoteSimulator');

// --- Import Finder Classes ---
const TriangularV3Finder = require('./finders/triangularV3Finder');
const SpatialFinder = require('./finders/spatialFinder');
// --- ---

class ArbitrageEngine {
    constructor(manager, config) {
        // --- Constructor logging is fine ---
        logger.info('[Engine Constructor] Initializing ArbitrageEngine...');
        // ... (constructor content from previous update) ...
        if (!manager || !(manager instanceof FlashSwapManager)) { throw new ArbitrageError('EngineInit', 'Invalid Manager passed to Engine constructor'); }
        if (!config) { throw new ArbitrageError('EngineInit', 'Config object required for Engine'); }
        const requiredConfigKeys = [
            'POOL_CONFIGS', 'CYCLE_INTERVAL_MS', 'MIN_PROFIT_THRESHOLD_ETH',
            'MAX_GAS_GWEI', 'GAS_ESTIMATE_BUFFER_PERCENT', 'FALLBACK_GAS_LIMIT',
            'PROFIT_BUFFER_PERCENT', 'DRY_RUN', 'STOP_ON_FIRST_EXECUTION'
        ];
        const missingKeys = requiredConfigKeys.filter(key => !(key in config));
        if (missingKeys.length > 0) { throw new ArbitrageError('EngineInit', `Missing required config keys: ${missingKeys.join(', ')}`); }
        if (!Array.isArray(config.POOL_CONFIGS) || config.POOL_CONFIGS.length === 0) { throw new ArbitrageError('EngineInit', 'Config.POOL_CONFIGS must be a non-empty array'); }

        this.manager = manager;
        this.config = config;
        this.provider = manager.getProvider();
        this.signer = manager.getSigner();
        logger.debug('[Engine Constructor] Parsing configuration values...');
        try {
            this.config.parsed = {
                 minProfitWei: ethers.parseEther(config.MIN_PROFIT_THRESHOLD_ETH || '0'),
                 maxGasGweiParsed: parseFloat(config.MAX_GAS_GWEI || '0.5'),
                 gasEstimateBufferPercent: parseInt(config.GAS_ESTIMATE_BUFFER_PERCENT || '20', 10),
                 fallbackGasLimitParsed: BigInt(config.FALLBACK_GAS_LIMIT || '3000000'),
                 profitBufferPercent: parseInt(config.PROFIT_BUFFER_PERCENT || '10', 10),
            };
             if (isNaN(this.config.parsed.maxGasGweiParsed) || this.config.parsed.maxGasGweiParsed <= 0) {
                 throw new Error('Invalid MAX_GAS_GWEI value');
             }
             logger.debug('[Engine Constructor] Config parsing complete.');
        } catch (parseError) {
            logger.error('[Engine Constructor] CRITICAL: Failed to parse configuration values.', parseError);
            throw new ArbitrageError('EngineInit', `Config Parsing Error: ${parseError.message}`);
        }
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
        } catch (initError) {
            logger.error('[Engine Constructor] CRITICAL: Failed to initialize core components.', initError);
            throw new ArbitrageError('EngineInit', `Component Init Error: ${initError.message}`);
        }
        this.isRunning = false;
        this.isCycleRunning = false;
        this.cycleCount = 0;
        this.cycleInterval = parseInt(this.config.CYCLE_INTERVAL_MS || '5000', 10);
        this.intervalId = null;
        logger.info('[Engine Constructor] Arbitrage Engine Constructor Finished Successfully.');
    }

    // --- initialize() with logging ---
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

    // --- start() with logging ---
    start() {
        logger.info('[Engine] >>> Entering start() method...');
        if (this.isRunning) { /* ... */ return; }
        this.isRunning = true;
        this.isCycleRunning = false;
        this.cycleCount = 0;
        logger.info(`[Engine start()] Starting run loop with interval: ${this.cycleInterval}ms`);

        logger.info('[Engine start()] Attempting immediate first runCycle call...');
        this.runCycle().then(() => {
             logger.info('[Engine start()] Initial immediate runCycle call promise resolved.');
        }).catch(error => {
            logger.error("[Engine start()] Error during initial immediate runCycle execution:", error);
             ErrorHandler.handleError(error, 'EngineImmediateCycle'); // Use correct name
             this.stop();
        });
        logger.info('[Engine start()] Initial runCycle call invoked (runs async). Setting interval...');

        this.intervalId = setInterval(async () => {
             logger.debug('[Engine Interval Callback] Interval triggered.');
            if (this.isRunning && !this.isCycleRunning) {
                 logger.debug('[Engine Interval Callback] Conditions met, calling runCycle...');
                await this.runCycle().catch(error => {
                     logger.error(`[Engine Interval Callback] Error during scheduled runCycle (Cycle ${this.cycleCount}):`, error);
                      ErrorHandler.handleError(error, `EngineScheduledCycle_${this.cycleCount}`); // Use correct name
                     if (error instanceof ArbitrageError && error.isFatal) {
                          logger.warn("[Engine Interval Callback] Stopping due to fatal error in cycle.");
                          this.stop();
                     }
                });
            } else if (this.isCycleRunning) {
                 logger.warn(`[Engine Interval Callback] Skipping scheduled cycle start - previous cycle (Cycle ${this.cycleCount}) still running.`);
            } else if (!this.isRunning) {
                 logger.warn('[Engine Interval Callback] Skipping cycle start - engine is not running.');
            }
        }, this.cycleInterval);

         logger.info('[Engine start()] Interval set.');
         logger.info('[Engine] <<< Exiting start() method.');
    }

    // --- stop() with logging ---
    stop() {
        logger.warn('[Engine] >>> Entering stop() method...');
        if (!this.isRunning) { /* ... */ return; }
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


    // --- runCycle() with logging and modified catch block ---
    async runCycle() {
        logger.debug(`[Engine runCycle] >>> Entered runCycle (Cycle Attempt: ${this.cycleCount + 1}). Checking conditions... isRunning=${this.isRunning}, isCycleRunning=${this.isCycleRunning}`);

        if (!this.isRunning) { logger.warn(`[Engine runCycle] Returning early: isRunning is false.`); return; }
        if (this.isCycleRunning) { logger.warn(`[Engine runCycle] Returning early: Cycle overlap detected (isCycleRunning is true).`); return; }

        this.isCycleRunning = true;
        this.cycleCount++;
        const cycleStartTime = Date.now();
        logger.info(`\n===== [Engine] Starting Cycle #${this.cycleCount} at ${new Date().toISOString()} =====`);

        try {
            // Step 1: Get Pool List
            logger.debug(`[Engine Cycle ${this.cycleCount}] Step 1: Getting pool list from config...`);
            const poolInfosToFetch = this.config.POOL_CONFIGS;
            if (!Array.isArray(poolInfosToFetch) || poolInfosToFetch.length === 0) {
                throw new ArbitrageError('RunCycle', 'No pools configured or POOL_CONFIGS is invalid.', true);
            }
            logger.debug(`[Engine Cycle ${this.cycleCount}] Step 1 Complete: Found ${poolInfosToFetch.length} pools.`);

            // Step 2: Fetch Live Pool States
            logger.debug(`[Engine Cycle ${this.cycleCount}] Step 2: Fetching live states for ${poolInfosToFetch.length} pools...`);
            // This now calls PoolScanner v2.1 which handles internal errors gracefully
            const livePoolStatesMap = await this.poolScanner.fetchPoolStates(poolInfosToFetch);
            const fetchedCount = livePoolStatesMap ? Object.keys(livePoolStatesMap).length : 0;
            if (fetchedCount === 0 && poolInfosToFetch.length > 0) { // Only warn if pools were expected
                 logger.warn(`[Engine Cycle ${this.cycleCount}] Step 2 Warning: Fetched 0 live pool states despite ${poolInfosToFetch.length} configured. Check RPC/Fetchers.`);
            }
            logger.info(`[Engine Cycle ${this.cycleCount}] Step 2 Complete: Successfully gathered state data for ${fetchedCount} pools.`);


            // Step 3: Find Opportunities
            logger.debug(`[Engine Cycle ${this.cycleCount}] Step 3: Finding potential opportunities (Triangular & Spatial)...`);
            let triangularOpportunities = [];
            let spatialOpportunities = [];
            try {
                triangularOpportunities = this.triangularV3Finder.findOpportunities(livePoolStatesMap);
                spatialOpportunities = this.spatialFinder.findOpportunities(livePoolStatesMap);
            } catch (finderError) {
                 logger.error(`[Engine Cycle ${this.cycleCount}] Step 3 Error: Failure during opportunity finding.`, finderError);
                 throw new ArbitrageError('FinderError', `Error in finder: ${finderError.message}`); // Rethrow
            }
            const potentialOpportunities = [...triangularOpportunities, ...spatialOpportunities];
            logger.info(`[Engine Cycle ${this.cycleCount}] Step 3 Complete: Found ${potentialOpportunities.length} potential opportunities (${triangularOpportunities.length} Tri, ${spatialOpportunities.length} Spatial).`);


            // Step 4: Process Opportunities
            if (potentialOpportunities.length === 0) {
                logger.info(`[Engine Cycle ${this.cycleCount}] Step 4: No potential opportunities found this cycle.`);
                this.logCycleEnd(cycleStartTime, fetchedCount);
                // No 'return' needed here, flow will naturally reach finally block
            } else {
                logger.info(`[Engine Cycle ${this.cycleCount}] Step 4: Processing ${potentialOpportunities.length} potential opportunities...`);
                let executedThisCycle = false;
                const engineContext = {
                    provider: this.provider, signer: this.signer, manager: this.manager,
                    config: this.config, gasEstimator: this.gasEstimator, profitCalculator: this.profitCalculator,
                    quoteSimulator: this.quoteSimulator, logger: logger, errorHandler: ErrorHandler // Pass ErrorHandler itself
                };

                for (const opp of potentialOpportunities) {
                    if (!this.isRunning) { logger.info(`[Engine Cycle ${this.cycleCount}] Stop signal received. Breaking opp loop.`); break; }
                    const stopAfterFirst = this.config.STOP_ON_FIRST_EXECUTION === true || this.config.STOP_ON_FIRST_EXECUTION === 'true';
                    if (executedThisCycle && stopAfterFirst) { logger.info(`[Engine Cycle ${this.cycleCount}] Stopping early due to STOP_ON_FIRST_EXECUTION.`); break; }

                    const logPrefix = `[Engine Cycle ${this.cycleCount}, Opp ${opp?.type || 'N/A'}]`;
                    logger.info(`${logPrefix} Processing opportunity: ${opp?.groupName || opp?.pathSymbols?.join('->') || 'Unknown'}`);

                    try {
                        const processResult = await processOpportunity(opp, engineContext);
                        if (processResult.executed) {
                            if (processResult.success) {
                                logger.info(`${logPrefix} Opportunity successfully executed. Tx: ${processResult.txHash}`);
                                executedThisCycle = true;
                            } else { logger.warn(`${logPrefix} Opportunity execution attempt failed. Reason: ${processResult.failureReason || 'Unknown'}`); }
                        } else if (processResult.error) {
                             logger.error(`${logPrefix} Error processing opportunity: ${processResult.error.message}`, processResult.error);
                              ErrorHandler.handleError(processResult.error, `OppProcessing_${opp?.type || 'N/A'}`); // Use correct name
                        } else { logger.info(`${logPrefix} Opportunity not executed. Reason: ${processResult.filterReason || 'Filter threshold not met'}`); }
                    } catch (processingError) {
                        logger.error(`${logPrefix} CRITICAL UNEXPECTED ERROR during processOpportunity execution for ${opp?.pathSymbols?.join('->') || 'Unknown'}.`, processingError);
                         ErrorHandler.handleError(processingError, `OppProcessingCritical_${opp?.type || 'N/A'}`); // Use correct name
                    }
                } // End opp loop
                logger.info(`[Engine Cycle ${this.cycleCount}] Step 4 Complete: Finished processing opportunities.`);
                this.logCycleEnd(cycleStartTime, fetchedCount, executedThisCycle);
            } // End else (potentialOpportunities > 0)

        // --- CATCH BLOCK WITH ADDED CONSOLE LOGS ---
        } catch (error) {
             // Catch errors from Steps 1, 3 or rethrown errors from Step 2/4 (should be less likely now)

             // *** ADDED CONSOLE LOGS FOR DEBUGGING ***
             console.log(`!!!!!! DEBUG: CATCH BLOCK ENTERED in runCycle (Cycle ${this.cycleCount}) !!!!!!`);
             console.log("!!!!!! DEBUG: Raw Error Object:", error);
             // *** END ADDED CONSOLE LOGS ***

             logger.error(`[Engine Cycle ${this.cycleCount}] CRITICAL ERROR during cycle execution.`, error);
             ErrorHandler.handleError(error, `RunCycleCritical_${this.cycleCount}`); // Use correct name

             // Decide if the engine should stop based on the error
             if (error instanceof ArbitrageError && error.isFatal) {
                 logger.error(`[Engine Cycle ${this.cycleCount}] Encountered fatal error. Stopping engine.`);
                 this.stop();
             }
             // Log cycle end even on error
             this.logCycleEnd(cycleStartTime, -1, false, true); // Use special marker like -1 fetchedCount for error state
        // --- END CATCH BLOCK ---

        } finally {
            this.isCycleRunning = false;
            logger.debug(`[Engine Cycle ${this.cycleCount}] <<< Exiting runCycle. Cycle lock released.`);
        }
    } // End runCycle

    logCycleEnd(startTime, fetchedPoolCount, executed = false, hadError = false) {
        const duration = Date.now() - startTime;
        const status = hadError ? 'ERRORED' : (executed ? 'EXECUTED_OPP' : 'COMPLETED');
        logger.info(`===== [Engine] Finished Cycle #${this.cycleCount} | Status: ${status} | Fetched: ${fetchedPoolCount >= 0 ? fetchedPoolCount : 'N/A'} Pools | Duration: ${duration}ms =====\n`);
    }
}

module.exports = { ArbitrageEngine };
