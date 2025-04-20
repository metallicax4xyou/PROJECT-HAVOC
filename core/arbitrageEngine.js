// /workspaces/arbitrum-flash/core/arbitrageEngine.js
// --- VERSION 1.8: Restored calls to both finders ---
// --- Includes ProfitCalculator fix and previous logging enhancements ---

const { ethers } = require('ethers');
const { PoolScanner } = require('./poolScanner');
const GasEstimator = require('./gasEstimator');
const ProfitCalculator = require('./profitCalculator'); // Require ProfitCalculator
const logger = require('../utils/logger');
const ErrorHandler = require('../utils/errorHandler');
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
        logger.info('[Engine Constructor] Initializing ArbitrageEngine...');
        // --- Validation ---
        if (!manager || !(manager instanceof FlashSwapManager)) { throw new ArbitrageError('EngineInit', 'Invalid Manager passed to Engine constructor'); }
        if (!config) { throw new ArbitrageError('EngineInit', 'Config object required for Engine'); }
        const requiredConfigKeys = [
            'POOL_CONFIGS', 'CYCLE_INTERVAL_MS', 'MIN_PROFIT_THRESHOLD_ETH',
            'MAX_GAS_GWEI', 'GAS_ESTIMATE_BUFFER_PERCENT', 'FALLBACK_GAS_LIMIT',
            'PROFIT_BUFFER_PERCENT', 'DRY_RUN', 'STOP_ON_FIRST_EXECUTION',
            'PROFIT_BUFFER_PERCENT', 'CHAINLINK_FEEDS' // Added keys needed for ProfitCalc instantiation below
        ];
        const missingKeys = requiredConfigKeys.filter(key => !(key in config));
        if (missingKeys.length > 0) { throw new ArbitrageError('EngineInit', `Missing required config keys: ${missingKeys.join(', ')}`); }
        if (!Array.isArray(config.POOL_CONFIGS) || config.POOL_CONFIGS.length === 0) { throw new ArbitrageError('EngineInit', 'Config.POOL_CONFIGS must be a non-empty array'); }

        this.manager = manager;
        this.config = config;
        this.provider = manager.getProvider(); // Get provider from manager
        this.signer = manager.getSigner();

        // --- Parse Config Values ---
        logger.debug('[Engine Constructor] Parsing configuration values...');
        try {
            this.config.parsed = {
                 minProfitWei: ethers.parseEther(config.MIN_PROFIT_THRESHOLD_ETH || '0'),
                 maxGasGweiParsed: parseFloat(config.MAX_GAS_GWEI || '0.5'),
                 gasEstimateBufferPercent: parseInt(config.GAS_ESTIMATE_BUFFER_PERCENT || '20', 10),
                 fallbackGasLimitParsed: BigInt(config.FALLBACK_GAS_LIMIT || '3000000'),
                 // Profit buffer percent is already parsed by ProfitCalculator, keep raw value in main config
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
            // QuoteSimulator now takes provider and config object directly
            this.quoteSimulator = new QuoteSimulator(this.provider, this.config);

            logger.debug('[Engine Constructor] Initializing SIMPLIFIED PoolScanner...');
            this.poolScanner = new PoolScanner(this.config, this.provider);

            logger.debug('[Engine Constructor] Initializing GasEstimator...');
            // Pass specific config values if needed, or just the whole config
            this.gasEstimator = new GasEstimator(this.provider, this.config);

            // --- Corrected ProfitCalculator INSTANTIATION ---
            logger.debug('[Engine Constructor] Initializing ProfitCalculator...');
            const profitCalcConfig = {
                minProfitWei: this.config.parsed.minProfitWei, // Pass the parsed BigInt value
                PROFIT_BUFFER_PERCENT: this.config.PROFIT_BUFFER_PERCENT, // Pass the raw value from config
                provider: this.provider, // Pass the engine's provider instance
                chainlinkFeeds: this.config.CHAINLINK_FEEDS, // Pass the feeds map
                nativeDecimals: this.config.nativeDecimals || 18,
                nativeSymbol: this.config.NATIVE_CURRENCY_SYMBOL || 'ETH',
                WRAPPED_NATIVE_SYMBOL: this.config.WRAPPED_NATIVE_SYMBOL || 'WETH'
            };
            this.profitCalculator = new ProfitCalculator(profitCalcConfig);
            // --- END CORRECTION ---

            // --- Instantiate Finder Classes ---
            logger.debug('[Engine Constructor] Initializing Opportunity Finders...');
            this.triangularV3Finder = new TriangularV3Finder(); // Constructor takes no args now
            this.spatialFinder = new SpatialFinder(); // Constructor takes no args now
            logger.debug('[Engine Constructor] Core component initialization complete.');
        } catch (initError) {
            logger.error('[Engine Constructor] CRITICAL: Failed to initialize core components.', initError);
            throw new ArbitrageError('EngineInit', `Component Init Error: ${initError.message}`);
        }

        this.isRunning = false; this.isCycleRunning = false; this.cycleCount = 0;
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
        if (this.isRunning) { logger.warn('[Engine start()] Start called but already running.'); return; }
        this.isRunning = true;
        this.isCycleRunning = false;
        this.cycleCount = 0;
        logger.info(`[Engine start()] Starting run loop with interval: ${this.cycleInterval}ms`);

        logger.info('[Engine start()] Attempting immediate first runCycle call...');
        this.runCycle().then(() => {
             logger.info('[Engine start()] Initial immediate runCycle call promise resolved.');
        }).catch(error => {
            logger.error("[Engine start()] Error during initial immediate runCycle execution:", error);
             ErrorHandler.handleError(error, 'EngineImmediateCycle');
             this.stop();
        });
        logger.info('[Engine start()] Initial runCycle call invoked (runs async). Setting interval...');

        this.intervalId = setInterval(async () => {
             logger.debug('[Engine Interval Callback] Interval triggered.');
            if (this.isRunning && !this.isCycleRunning) {
                 logger.debug('[Engine Interval Callback] Conditions met, calling runCycle...');
                await this.runCycle().catch(error => {
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

    // --- stop() with logging ---
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


    // --- runCycle() with restored calls to both finders ---
    async runCycle() {
        logger.debug(`[Engine runCycle] >>> Entered runCycle (Cycle Attempt: ${this.cycleCount + 1}). Checking conditions... isRunning=${this.isRunning}, isCycleRunning=${this.isCycleRunning}`);
        if (!this.isRunning || this.isCycleRunning) { /* return conditions */ return; }

        this.isCycleRunning = true;
        this.cycleCount++;
        const cycleStartTime = Date.now();
        logger.info(`\n===== [Engine] Starting Cycle #${this.cycleCount} at ${new Date().toISOString()} =====`);

        try {
            // Step 1: Get Pool List (OK)
            logger.debug(`[Engine Cycle ${this.cycleCount}] Step 1: Getting pool list from config...`);
            const poolInfosToFetch = this.config.POOL_CONFIGS; /* ... check ... */
            logger.debug(`[Engine Cycle ${this.cycleCount}] Step 1 Complete: Found ${poolInfosToFetch.length} pools.`);

            // Step 2: Fetch Live Pool States (OK)
            logger.debug(`[Engine Cycle ${this.cycleCount}] Step 2: Fetching live states for ${poolInfosToFetch.length} pools...`);
            const livePoolStatesMap = await this.poolScanner.fetchPoolStates(poolInfosToFetch);
            const fetchedCount = Object.keys(livePoolStatesMap).length;
            logger.info(`[Engine Cycle ${this.cycleCount}] Step 2 Complete: Successfully gathered state data for ${fetchedCount} pools.`);

            // Step 3: Find Opportunities (Calling both finders)
            logger.debug(`[Engine Cycle ${this.cycleCount}] Step 3: Finding potential opportunities (Triangular & Spatial)...`);

            let triangularOpportunities = [];
            let spatialOpportunities = [];

            try {
                // --- Call Triangular Finder ---
                logger.debug(`[Engine Cycle ${this.cycleCount}] Calling triangularV3Finder...`);
                triangularOpportunities = this.triangularV3Finder.findOpportunities(livePoolStatesMap); // Actual call
                logger.debug(`[Engine Cycle ${this.cycleCount}] triangularV3Finder returned ${triangularOpportunities.length} opps.`);

                // --- Call Spatial Finder ---
                logger.debug(`[Engine Cycle ${this.cycleCount}] Calling spatialFinder...`);
                spatialOpportunities = this.spatialFinder.findOpportunities(livePoolStatesMap); // Actual call
                logger.debug(`[Engine Cycle ${this.cycleCount}] spatialFinder returned ${spatialOpportunities.length} opps.`);

            } catch (finderError) {
                 logger.error(`[Engine Cycle ${this.cycleCount}] Step 3 Error: Failure during opportunity finding.`, finderError);
                 // Decide if this should be fatal or just logged
                 // For now, log and continue, resulting in 0 opportunities found for this cycle.
                 // Consider adding ErrorHandler.handleError here too.
                 // throw new ArbitrageError('FinderError', `Error in finder: ${finderError.message}`); // Optionally re-throw
            }


            const potentialOpportunities = [...triangularOpportunities, ...spatialOpportunities];
            logger.info(`[Engine Cycle ${this.cycleCount}] Step 3 Complete: Found ${potentialOpportunities.length} potential opportunities (${triangularOpportunities.length} Tri, ${spatialOpportunities.length} Spatial).`);

            // Step 4: Process Opportunities
            if (potentialOpportunities.length === 0) {
                logger.info(`[Engine Cycle ${this.cycleCount}] Step 4: No potential opportunities found this cycle.`);
                this.logCycleEnd(cycleStartTime, fetchedCount);
            } else {
                logger.info(`[Engine Cycle ${this.cycleCount}] Step 4: Processing ${potentialOpportunities.length} potential opportunities...`);
                let executedThisCycle = false;
                const engineContext = { /* ... as before ... */ };
                for (const opp of potentialOpportunities) {
                     // ... process loop ...
                     if (!this.isRunning) break;
                     const stopAfterFirst = this.config.STOP_ON_FIRST_EXECUTION === true || this.config.STOP_ON_FIRST_EXECUTION === 'true';
                     if (executedThisCycle && stopAfterFirst) break;
                     // ... call processOpportunity ...
                 }
                logger.info(`[Engine Cycle ${this.cycleCount}] Step 4 Complete: Finished processing opportunities.`);
                this.logCycleEnd(cycleStartTime, fetchedCount, executedThisCycle);
            }

        } catch (error) {
             // Catch errors from Steps 1, 2 or rethrown finder errors
             console.log(`!!!!!! DEBUG: CATCH BLOCK ENTERED in runCycle (Cycle ${this.cycleCount}) !!!!!!`); // Keep debug console log
             console.log("!!!!!! DEBUG: Raw Error Object:", error);
             logger.error(`[Engine Cycle ${this.cycleCount}] CRITICAL ERROR during cycle execution.`, error);
             ErrorHandler.handleError(error, `RunCycleCritical_${this.cycleCount}`);
             if (error instanceof ArbitrageError && error.isFatal) { this.stop(); }
             this.logCycleEnd(cycleStartTime, -1, false, true);
        } finally {
            this.isCycleRunning = false;
            logger.debug(`[Engine Cycle ${this.cycleCount}] <<< Exiting runCycle. Cycle lock released.`);
        }
    }
     logCycleEnd(startTime, fetchedPoolCount, executed = false, hadError = false) {
         const duration = Date.now() - startTime;
         const status = hadError ? 'ERRORED' : (executed ? 'EXECUTED_OPP' : 'COMPLETED');
         logger.info(`===== [Engine] Finished Cycle #${this.cycleCount} | Status: ${status} | Fetched: ${fetchedPoolCount >= 0 ? fetchedPoolCount : 'N/A'} Pools | Duration: ${duration}ms =====\n`);
     }
}

module.exports = { ArbitrageEngine };
