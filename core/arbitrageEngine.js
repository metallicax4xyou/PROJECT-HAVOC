// /workspaces/arbitrum-flash/core/arbitrageEngine.js
// --- VERSION 1.9: Removed MIN_PROFIT_THRESHOLD_ETH dependency ---

const { ethers } = require('ethers');
const { PoolScanner } = require('./poolScanner');
const GasEstimator = require('./gasEstimator');
const ProfitCalculator = require('./profitCalculator');
const logger = require('../utils/logger');
const ErrorHandler = require('../utils/errorHandler');
const FlashSwapManager = require('./flashSwapManager');
const { processOpportunity } = require('./opportunityProcessor'); // Assuming this is needed later
const { ArbitrageError } = require('../utils/errorHandler');
const QuoteSimulator = require('./quoteSimulator');

// --- Import Finder Classes ---
const TriangularV3Finder = require('./finders/triangularV3Finder');
const SpatialFinder = require('./finders/spatialFinder');
// --- ---

class ArbitrageEngine {
    constructor(manager, config) {
        logger.info('[Engine Constructor] Initializing ArbitrageEngine...');
        // --- Validation ---
        if (!manager || !(manager instanceof FlashSwapManager)) { throw new ArbitrageError('EngineInit', 'Invalid Manager passed to Engine constructor'); }
        if (!config) { throw new ArbitrageError('EngineInit', 'Config object required for Engine'); }

        // *** MODIFIED: Removed MIN_PROFIT_THRESHOLD_ETH, added MIN_PROFIT_THRESHOLDS ***
        const requiredConfigKeys = [
            'POOL_CONFIGS', 'CYCLE_INTERVAL_MS', 'MIN_PROFIT_THRESHOLDS', // Use the new object key
            'MAX_GAS_GWEI', 'GAS_ESTIMATE_BUFFER_PERCENT', 'FALLBACK_GAS_LIMIT',
            'PROFIT_BUFFER_PERCENT', 'DRY_RUN', 'STOP_ON_FIRST_EXECUTION',
            'CHAINLINK_FEEDS', 'NATIVE_CURRENCY_SYMBOL' // Ensure native symbol is in config
        ];
        const missingKeys = requiredConfigKeys.filter(key => !(key in config));
        if (missingKeys.length > 0) { throw new ArbitrageError('EngineInit', `Missing required config keys: ${missingKeys.join(', ')}`); }
        if (!Array.isArray(config.POOL_CONFIGS) || config.POOL_CONFIGS.length === 0) { throw new ArbitrageError('EngineInit', 'Config.POOL_CONFIGS must be a non-empty array'); }
        // Add validation for the threshold object itself
        if (typeof config.MIN_PROFIT_THRESHOLDS !== 'object' || !config.MIN_PROFIT_THRESHOLDS.DEFAULT || !config.MIN_PROFIT_THRESHOLDS.NATIVE) {
            throw new ArbitrageError('EngineInit', 'Config.MIN_PROFIT_THRESHOLDS must be an object with DEFAULT and NATIVE keys.');
        }


        this.manager = manager;
        this.config = config; // Store the whole config
        this.provider = manager.getProvider();
        this.signer = manager.getSigner();

        // --- Parse Config Values (Simplified) ---
        // We no longer parse minProfitWei here; ProfitCalculator handles its own thresholds.
        // We only parse values directly used by the Engine or passed generically.
        logger.debug('[Engine Constructor] Parsing configuration values...');
        try {
             // Keep parsed values needed directly by Engine or GasEstimator etc.
            this.config.parsed = {
                 // minProfitWei: NO LONGER NEEDED HERE
                 maxGasGweiParsed: parseFloat(config.MAX_GAS_GWEI || '0.5'),
                 gasEstimateBufferPercent: parseInt(config.GAS_ESTIMATE_BUFFER_PERCENT || '20', 10),
                 fallbackGasLimitParsed: BigInt(config.FALLBACK_GAS_LIMIT || '3000000'),
            };
             if (isNaN(this.config.parsed.maxGasGweiParsed) || this.config.parsed.maxGasGweiParsed <= 0) { throw new Error('Invalid MAX_GAS_GWEI value'); }
             logger.debug('[Engine Constructor] Config parsing complete.');
        } catch (parseError) {
            logger.error('[Engine Constructor] CRITICAL: Failed to parse configuration values.', parseError);
            throw new ArbitrageError('EngineInit', `Config Parsing Error: ${parseError.message}`);
         }

        // --- Initialize Core Component Instances ---
        try {
            logger.debug('[Engine Constructor] Initializing QuoteSimulator...');
            this.quoteSimulator = new QuoteSimulator(this.provider, this.config);

            logger.debug('[Engine Constructor] Initializing SIMPLIFIED PoolScanner...');
            this.poolScanner = new PoolScanner(this.config, this.provider);

            logger.debug('[Engine Constructor] Initializing GasEstimator...');
            this.gasEstimator = new GasEstimator(this.provider, this.config); // Pass full config

            // --- Initialize ProfitCalculator ---
            logger.debug('[Engine Constructor] Initializing ProfitCalculator...');
            // ProfitCalculator constructor now takes the main config object directly
            // (It extracts MIN_PROFIT_THRESHOLDS, PROFIT_BUFFER_PERCENT, etc. internally)
            this.profitCalculator = new ProfitCalculator(this.config); // Pass full config

            // --- Instantiate Finder Classes ---
            logger.debug('[Engine Constructor] Initializing Opportunity Finders...');
            this.triangularV3Finder = new TriangularV3Finder();
            this.spatialFinder = new SpatialFinder();
            logger.debug('[Engine Constructor] Core component initialization complete.');
        } catch (initError) {
            logger.error('[Engine Constructor] CRITICAL: Failed to initialize core components.', initError);
            // Add more context to the error if possible
            throw new ArbitrageError('EngineInit', `Component Init Error in ${initError.constructor?.name || 'UnknownComponent'}: ${initError.message}`);
        }

        // --- State variables ---
        this.isRunning = false;
        this.isCycleRunning = false;
        this.cycleCount = 0;
        this.cycleInterval = parseInt(this.config.CYCLE_INTERVAL_MS || '5000', 10);
        this.intervalId = null;
        logger.info('[Engine Constructor] Arbitrage Engine Constructor Finished Successfully.');
    }

    // --- initialize() method ---
    async initialize() {
         logger.info('[Engine] >>> Entering initialize() method...');
         try {
            logger.info('[Engine initialize()] Performing async setup steps (if any)...');
            // Add any async initialization needed by components here
            await Promise.resolve(); // Placeholder
            logger.info('[Engine initialize()] Async setup steps complete.');
            logger.info('[Engine] <<< Exiting initialize() method successfully.');
         } catch(err) {
            logger.error('[Engine CRITICAL] Failed during engine initialize() method.', err);
            throw err; // Rethrow to be caught by main startup block
         }
    }

    // --- start() method ---
    start() {
        logger.info('[Engine] >>> Entering start() method...');
        if (this.isRunning) { logger.warn('[Engine start()] Start called but already running.'); return; }
        this.isRunning = true;
        this.isCycleRunning = false; // Reset cycle lock on start
        this.cycleCount = 0; // Reset cycle count on start
        logger.info(`[Engine start()] Starting run loop with interval: ${this.cycleInterval}ms`);

        logger.info('[Engine start()] Attempting immediate first runCycle call...');
        // Use setTimeout to ensure the interval setup completes before the first cycle might finish
        setTimeout(async () => {
            if (!this.isRunning) return; // Check if stopped before first run
            await this.runCycle().catch(error => {
                logger.error("[Engine start()] Error during initial immediate runCycle execution:", error);
                ErrorHandler.handleError(error, 'EngineImmediateCycle');
                this.stop(); // Stop if initial cycle fails critically
            });
        }, 0); // Run almost immediately after current event loop tick

        logger.info('[Engine start()] Initial runCycle call scheduled. Setting interval...');

        this.intervalId = setInterval(async () => {
            logger.debug('[Engine Interval Callback] Interval triggered.');
            if (this.isRunning && !this.isCycleRunning) {
                logger.debug('[Engine Interval Callback] Conditions met, calling runCycle...');
                // Don't await here to prevent blocking subsequent interval checks if a cycle hangs
                this.runCycle().catch(error => {
                     logger.error(`[Engine Interval Callback] Error during scheduled runCycle (Cycle ${this.cycleCount}):`, error);
                     ErrorHandler.handleError(error, `EngineScheduledCycle_${this.cycleCount}`);
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

    // --- stop() method ---
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
         // Optionally set isCycleRunning to false too, though not strictly necessary if isRunning is false
         // this.isCycleRunning = false;
         logger.warn('[Engine] <<< Exiting stop() method.');
    }


    // --- runCycle() method ---
    async runCycle() {
        // Prevent race conditions and running if stopped
        if (!this.isRunning) {
            logger.warn(`[Engine runCycle] Attempted to run cycle while engine is stopped. Aborting.`);
            return;
         }
         if (this.isCycleRunning) {
             logger.warn(`[Engine runCycle] Attempted to start cycle ${this.cycleCount + 1} while cycle ${this.cycleCount} is already running. Aborting.`);
             return;
         }

        this.isCycleRunning = true;
        this.cycleCount++; // Increment at the start of the attempt
        const currentCycleNum = this.cycleCount; // Capture for logging consistency
        const cycleStartTime = Date.now();
        logger.info(`\n===== [Engine] Starting Cycle #${currentCycleNum} at ${new Date().toISOString()} =====`);

        let fetchedPoolCount = -1; // Default to indicate failure/unknown
        let executedThisCycle = false; // Track if an opportunity was executed

        try {
            // Step 1: Get Pool List
            logger.debug(`[Engine Cycle ${currentCycleNum}] Step 1: Getting pool list from config...`);
            const poolInfosToFetch = this.config.POOL_CONFIGS;
            if (!poolInfosToFetch || poolInfosToFetch.length === 0) {
                throw new ArbitrageError('RunCycleError', 'No pool configurations found in config.', true); // Fatal if no pools
            }
            logger.debug(`[Engine Cycle ${currentCycleNum}] Step 1 Complete: Found ${poolInfosToFetch.length} pools.`);

            // Step 2: Fetch Live Pool States
            logger.debug(`[Engine Cycle ${currentCycleNum}] Step 2: Fetching live states for ${poolInfosToFetch.length} pools...`);
            const livePoolStatesMap = await this.poolScanner.fetchPoolStates(poolInfosToFetch);
            fetchedPoolCount = Object.keys(livePoolStatesMap).length; // Update fetched count
             // Check if any pools were fetched, warn if not but maybe don't make it fatal?
             if (fetchedPoolCount === 0 && poolInfosToFetch.length > 0) {
                 logger.warn(`[Engine Cycle ${currentCycleNum}] Step 2 Warning: Failed to fetch state for any configured pools.`);
                 // Decide whether to continue or throw. For now, let it continue to Step 3 (which will find 0 opps).
             } else {
                 logger.info(`[Engine Cycle ${currentCycleNum}] Step 2 Complete: Successfully gathered state data for ${fetchedPoolCount} pools.`);
             }


            // Step 3: Find Opportunities
            logger.debug(`[Engine Cycle ${currentCycleNum}] Step 3: Finding potential opportunities (Triangular & Spatial)...`);
            let triangularOpportunities = []; let spatialOpportunities = [];
            try {
                logger.debug(`[Engine Cycle ${currentCycleNum}] Calling triangularV3Finder...`);
                triangularOpportunities = this.triangularV3Finder.findOpportunities(livePoolStatesMap);
                logger.debug(`[Engine Cycle ${currentCycleNum}] triangularV3Finder returned ${triangularOpportunities.length} opps.`);

                logger.debug(`[Engine Cycle ${currentCycleNum}] Calling spatialFinder...`);
                spatialOpportunities = this.spatialFinder.findOpportunities(livePoolStatesMap);
                logger.debug(`[Engine Cycle ${currentCycleNum}] spatialFinder returned ${spatialOpportunities.length} opps.`);
            } catch (finderError) {
                 logger.error(`[Engine Cycle ${currentCycleNum}] Step 3 Error: Failure during opportunity finding.`, finderError);
                 // Continue cycle, effectively finding 0 opportunities
            }
            const potentialOpportunities = [...triangularOpportunities, ...spatialOpportunities];
            logger.info(`[Engine Cycle ${currentCycleNum}] Step 3 Complete: Found ${potentialOpportunities.length} potential opportunities (${triangularOpportunities.length} Tri, ${spatialOpportunities.length} Spatial).`);


            // Step 4: Process Opportunities
            if (potentialOpportunities.length === 0) {
                logger.info(`[Engine Cycle ${currentCycleNum}] Step 4: No potential opportunities found this cycle.`);
                this.logCycleEnd(currentCycleNum, cycleStartTime, fetchedPoolCount, false, false);
            } else {
                logger.info(`[Engine Cycle ${currentCycleNum}] Step 4: Processing ${potentialOpportunities.length} potential opportunities...`);
                // --- Define engineContext once ---
                 const engineContext = {
                     gasEstimator: this.gasEstimator,
                     profitCalculator: this.profitCalculator,
                     quoteSimulator: this.quoteSimulator, // Pass the simulator instance
                     flashSwapManager: this.manager,
                     config: this.config,
                     provider: this.provider,
                     signer: this.signer,
                     currentCycle: currentCycleNum
                 };

                for (const opp of potentialOpportunities) {
                     if (!this.isRunning) {
                         logger.warn(`[Engine Cycle ${currentCycleNum}] Engine stopped during opportunity processing loop. Breaking.`);
                         break; // Exit loop if engine was stopped
                     }
                     try {
                          const result = await processOpportunity(opp, engineContext);
                          if (result && result.executed) {
                              executedThisCycle = true;
                              const stopAfterFirst = this.config.STOP_ON_FIRST_EXECUTION === true || this.config.STOP_ON_FIRST_EXECUTION === 'true';
                              if (stopAfterFirst) {
                                  logger.info(`[Engine Cycle ${currentCycleNum}] STOP_ON_FIRST_EXECUTION enabled. Stopping engine after successful execution.`);
                                  this.stop(); // Stop the engine loop
                                  break; // Exit processing loop
                              }
                          }
                      } catch (processingError) {
                          logger.error(`[Engine Cycle ${currentCycleNum}] Error processing opportunity: ${opp.type} path ${opp.path?.join('->') || 'N/A'}`, processingError);
                          ErrorHandler.handleError(processingError, `OpportunityProcessing_${currentCycleNum}`);
                          // Decide if processing errors should be fatal or just skipped
                          // if (processingError instanceof ArbitrageError && processingError.isFatal) { this.stop(); break; }
                      }
                 } // End of opportunity loop

                logger.info(`[Engine Cycle ${currentCycleNum}] Step 4 Complete: Finished processing opportunities.${executedThisCycle ? ' (Executed at least one)' : ''}`);
                this.logCycleEnd(currentCycleNum, cycleStartTime, fetchedPoolCount, executedThisCycle, false);
            } // End of potentialOpportunities check

        } catch (error) { // Catch errors from Steps 1, 2 or critical setup errors
             logger.error(`[Engine Cycle ${currentCycleNum}] CRITICAL ERROR during cycle execution: ${error.message}`, error);
             ErrorHandler.handleError(error, `RunCycleCritical_${currentCycleNum}`);
             // Stop the engine on critical cycle errors (e.g., config load failure)
             this.logCycleEnd(currentCycleNum, cycleStartTime, fetchedPoolCount, executedThisCycle, true); // Log as errored
             this.stop(); // Stop the engine
        } finally {
            // Ensure the lock is always released, even if errors occur
            this.isCycleRunning = false;
            logger.debug(`[Engine Cycle ${currentCycleNum}] <<< Exiting runCycle. Cycle lock released.`);
        }
    }

    // Updated log function to include cycle number consistently
    logCycleEnd(cycleNum, startTime, fetchedPoolCount, executed = false, hadError = false) {
         const duration = Date.now() - startTime;
         const status = hadError ? 'ERRORED' : (executed ? 'EXECUTED_OPP' : 'COMPLETED');
         logger.info(`===== [Engine] Finished Cycle #${cycleNum} | Status: ${status} | Fetched: ${fetchedPoolCount >= 0 ? fetchedPoolCount : 'N/A'} Pools | Duration: ${duration}ms =====\n`);
     }
}

module.exports = { ArbitrageEngine };
