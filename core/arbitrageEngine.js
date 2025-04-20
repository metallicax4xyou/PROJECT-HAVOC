// /workspaces/arbitrum-flash/core/arbitrageEngine.js
// --- Corrected ProfitCalculator instantiation ---
// --- Includes all previous logging enhancements ---

const { ethers } = require('ethers');
const { PoolScanner } = require('./poolScanner');
const GasEstimator = require('./gasEstimator');
const ProfitCalculator = require('./profitCalculator'); // Require ProfitCalculator
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
        logger.info('[Engine Constructor] Initializing ArbitrageEngine...');
        // --- Validation ---
        if (!manager || !(manager instanceof FlashSwapManager)) { throw new ArbitrageError('EngineInit', 'Invalid Manager passed to Engine constructor'); }
        if (!config) { throw new ArbitrageError('EngineInit', 'Config object required for Engine'); }
        const requiredConfigKeys = [ /* ... other keys ... */ 'PROFIT_BUFFER_PERCENT', 'CHAINLINK_FEEDS' ]; // Ensure these are checked if needed elsewhere too
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
        } catch (parseError) { /* ... */ }

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

            // --- *** CORRECTED ProfitCalculator INSTANTIATION *** ---
            logger.debug('[Engine Constructor] Initializing ProfitCalculator...');
            // Create a specific config object for ProfitCalculator
            const profitCalcConfig = {
                minProfitWei: this.config.parsed.minProfitWei, // Pass the parsed BigInt value
                PROFIT_BUFFER_PERCENT: this.config.PROFIT_BUFFER_PERCENT, // Pass the raw value from config
                provider: this.provider, // Pass the engine's provider instance
                chainlinkFeeds: this.config.CHAINLINK_FEEDS, // Pass the feeds map
                // Optional: Pass other needed values if ProfitCalculator uses them
                nativeDecimals: this.config.nativeDecimals || 18,
                nativeSymbol: this.config.NATIVE_CURRENCY_SYMBOL || 'ETH',
                WRAPPED_NATIVE_SYMBOL: this.config.WRAPPED_NATIVE_SYMBOL || 'WETH' // Assuming WETH is defined in config or use default
            };
            this.profitCalculator = new ProfitCalculator(profitCalcConfig); // Pass the new object
            // --- *** END CORRECTION *** ---

            // --- Instantiate Finder Classes ---
            logger.debug('[Engine Constructor] Initializing Opportunity Finders...');
            this.triangularV3Finder = new TriangularV3Finder(this.config);
            this.spatialFinder = new SpatialFinder(this.config);
            logger.debug('[Engine Constructor] Core component initialization complete.');
        } catch (initError) {
            logger.error('[Engine Constructor] CRITICAL: Failed to initialize core components.', initError);
             // Ensure the error thrown includes the specific component failure message
            throw new ArbitrageError('EngineInit', `Component Init Error: ${initError.message}`);
        }

        this.isRunning = false; this.isCycleRunning = false; this.cycleCount = 0;
        this.cycleInterval = parseInt(this.config.CYCLE_INTERVAL_MS || '5000', 10);
        this.intervalId = null;
        logger.info('[Engine Constructor] Arbitrage Engine Constructor Finished Successfully.');
    }

    // --- initialize(), start(), stop(), runCycle(), logCycleEnd() methods remain the same as previous update ---
    // ... (keep initialize() with logging) ...
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
    // ... (keep start() with logging) ...
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
        }).catch(error => { /* ... */ });
        logger.info('[Engine start()] Initial runCycle call invoked (runs async). Setting interval...');

        this.intervalId = setInterval(async () => { /* ... interval logic ... */ }, this.cycleInterval);

         logger.info('[Engine start()] Interval set.');
         logger.info('[Engine] <<< Exiting start() method.');
    }
    // ... (keep stop() with logging) ...
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
    // ... (keep runCycle() with logging and console.log in catch) ...
    async runCycle() {
        logger.debug(`[Engine runCycle] >>> Entered runCycle (Cycle Attempt: ${this.cycleCount + 1}). Checking conditions... isRunning=${this.isRunning}, isCycleRunning=${this.isCycleRunning}`);
        if (!this.isRunning) { /* return */ }
        if (this.isCycleRunning) { /* return */ }

        this.isCycleRunning = true;
        this.cycleCount++;
        const cycleStartTime = Date.now();
        logger.info(`\n===== [Engine] Starting Cycle #${this.cycleCount} at ${new Date().toISOString()} =====`);
        try {
            // Step 1: Get Pool List
            logger.debug(`[Engine Cycle ${this.cycleCount}] Step 1: Getting pool list from config...`);
            const poolInfosToFetch = this.config.POOL_CONFIGS; /* ... check ... */
            logger.debug(`[Engine Cycle ${this.cycleCount}] Step 1 Complete: Found ${poolInfosToFetch.length} pools.`);

            // Step 2: Fetch Live Pool States
            logger.debug(`[Engine Cycle ${this.cycleCount}] Step 2: Fetching live states for ${poolInfosToFetch.length} pools...`);
            const livePoolStatesMap = await this.poolScanner.fetchPoolStates(poolInfosToFetch); /* ... check count ... */
            const fetchedCount = Object.keys(livePoolStatesMap).length;
            logger.info(`[Engine Cycle ${this.cycleCount}] Step 2 Complete: Successfully gathered state data for ${fetchedCount} pools.`);

            // Step 3: Find Opportunities
            logger.debug(`[Engine Cycle ${this.cycleCount}] Step 3: Finding potential opportunities (Triangular & Spatial)...`);
            let triangularOpportunities = []; let spatialOpportunities = [];
            try { /* finders */ } catch (finderError) { /* handle */ }
            const potentialOpportunities = [...triangularOpportunities, ...spatialOpportunities];
            logger.info(`[Engine Cycle ${this.cycleCount}] Step 3 Complete: Found ${potentialOpportunities.length} potential opportunities (${triangularOpportunities.length} Tri, ${spatialOpportunities.length} Spatial).`);

            // Step 4: Process Opportunities
            if (potentialOpportunities.length === 0) { /* log & end cycle */ }
            else { /* loop and process */ }

        } catch (error) {
             // Catch errors from Steps 1, 3 or rethrown errors
             console.log(`!!!!!! DEBUG: CATCH BLOCK ENTERED in runCycle (Cycle ${this.cycleCount}) !!!!!!`); // Keep for now
             console.log("!!!!!! DEBUG: Raw Error Object:", error);
             logger.error(`[Engine Cycle ${this.cycleCount}] CRITICAL ERROR during cycle execution.`, error);
             ErrorHandler.handleError(error, `RunCycleCritical_${this.cycleCount}`);
             if (error instanceof ArbitrageError && error.isFatal) { /* stop */ }
             this.logCycleEnd(cycleStartTime, -1, false, true);
        } finally {
            this.isCycleRunning = false;
            logger.debug(`[Engine Cycle ${this.cycleCount}] <<< Exiting runCycle. Cycle lock released.`);
        }
    }
    // ... (keep logCycleEnd()) ...
     logCycleEnd(startTime, fetchedPoolCount, executed = false, hadError = false) { /* ... */ }
}

module.exports = { ArbitrageEngine };
