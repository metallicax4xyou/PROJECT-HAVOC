// /workspaces/arbitrum-flash/core/arbitrageEngine.js
// --- VERSION 1.11: Uses Pair Registry from PoolScanner ---

const { ethers } = require('ethers');
const { PoolScanner } = require('./poolScanner'); // Updated path if PoolScanner moved
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
        // --- Constructor logic largely unchanged ---
        logger.info('[Engine Constructor] Initializing ArbitrageEngine...');
        if (!manager || !(manager instanceof FlashSwapManager)) { throw new ArbitrageError('EngineInit', 'Invalid Manager passed to Engine constructor'); }
        if (!config) { throw new ArbitrageError('EngineInit', 'Config object required for Engine'); }
        const requiredConfigKeys = [ /* ... same as before ... */ 'POOL_CONFIGS', 'CYCLE_INTERVAL_MS', 'MIN_PROFIT_THRESHOLDS', 'MAX_GAS_GWEI', 'GAS_ESTIMATE_BUFFER_PERCENT', 'FALLBACK_GAS_LIMIT', 'PROFIT_BUFFER_PERCENT', 'DRY_RUN', 'STOP_ON_FIRST_EXECUTION', 'CHAINLINK_FEEDS', 'NATIVE_CURRENCY_SYMBOL'];
        const missingKeys = requiredConfigKeys.filter(key => !(key in config));
        if (missingKeys.length > 0) { throw new ArbitrageError('EngineInit', `Missing required config keys: ${missingKeys.join(', ')}`); }
        if (!Array.isArray(config.POOL_CONFIGS) || config.POOL_CONFIGS.length === 0) { throw new ArbitrageError('EngineInit', 'Config.POOL_CONFIGS must be a non-empty array'); }
        if (typeof config.MIN_PROFIT_THRESHOLDS !== 'object' || !config.MIN_PROFIT_THRESHOLDS.DEFAULT || !config.MIN_PROFIT_THRESHOLDS.NATIVE) { throw new ArbitrageError('EngineInit', 'Config.MIN_PROFIT_THRESHOLDS must be an object with DEFAULT and NATIVE keys.'); }

        this.manager = manager;
        this.config = config;
        this.provider = manager.getProvider();
        this.signer = manager.getSigner();

        logger.debug('[Engine Constructor] Parsing configuration values...');
        try {
            this.config.parsed = { maxGasGweiParsed: parseFloat(config.MAX_GAS_GWEI || '0.5'), gasEstimateBufferPercent: parseInt(config.GAS_ESTIMATE_BUFFER_PERCENT || '20', 10), fallbackGasLimitParsed: BigInt(config.FALLBACK_GAS_LIMIT || '3000000'), };
            if (isNaN(this.config.parsed.maxGasGweiParsed) || this.config.parsed.maxGasGweiParsed <= 0) { throw new Error('Invalid MAX_GAS_GWEI value'); }
            logger.debug('[Engine Constructor] Config parsing complete.');
        } catch (parseError) { /* ... */ }

        logger.debug('[Engine Constructor] Initializing core components...');
        try {
            this.quoteSimulator = new QuoteSimulator(this.provider, this.config);
            this.poolScanner = new PoolScanner(this.config, this.provider);
            this.gasEstimator = new GasEstimator(this.provider, this.config);
            const profitCalcConfig = { /* ... as before ... */ MIN_PROFIT_THRESHOLDS: config.MIN_PROFIT_THRESHOLDS, PROFIT_BUFFER_PERCENT: config.PROFIT_BUFFER_PERCENT, provider: this.provider, chainlinkFeeds: config.CHAINLINK_FEEDS, NATIVE_CURRENCY_SYMBOL: config.NATIVE_CURRENCY_SYMBOL, WRAPPED_NATIVE_SYMBOL: config.WRAPPED_NATIVE_SYMBOL || 'WETH'};
            this.profitCalculator = new ProfitCalculator(profitCalcConfig);
            this.triangularV3Finder = new TriangularV3Finder();
            this.spatialFinder = new SpatialFinder();
            logger.debug('[Engine Constructor] Core component initialization complete.');
        } catch (initError) { /* ... */ }

        this.isRunning = false; this.isCycleRunning = false; this.cycleCount = 0;
        this.cycleInterval = parseInt(this.config.CYCLE_INTERVAL_MS || '5000', 10);
        this.intervalId = null;
        logger.info('[Engine Constructor] Arbitrage Engine Constructor Finished Successfully.');
    }

    async initialize() { /* ... unchanged ... */ }
    start() { /* ... unchanged ... */ }
    stop() { /* ... unchanged ... */ }

    // --- *** MODIFIED runCycle() *** ---
    async runCycle() {
        if (!this.isRunning || this.isCycleRunning) { return; } // Basic guards

        this.isCycleRunning = true;
        this.cycleCount++;
        const currentCycleNum = this.cycleCount;
        const cycleStartTime = Date.now();
        logger.info(`\n===== [Engine] Starting Cycle #${currentCycleNum} at ${new Date().toISOString()} =====`);

        let fetchedPoolCount = -1;
        let executedThisCycle = false;

        try {
            // Step 1: Get Pool List (Unchanged)
            logger.debug(`[Engine Cycle ${currentCycleNum}] Step 1: Getting pool list from config...`);
            const poolInfosToFetch = this.config.POOL_CONFIGS;
            if (!poolInfosToFetch || poolInfosToFetch.length === 0) { throw new ArbitrageError('RunCycleError', 'No pool configurations found.', true); }
            logger.debug(`[Engine Cycle ${currentCycleNum}] Step 1 Complete: Found ${poolInfosToFetch.length} pools.`);

            // Step 2: Fetch Pool States & Build Registry
            logger.debug(`[Engine Cycle ${currentCycleNum}] Step 2: Fetching live states and building registry for ${poolInfosToFetch.length} pools...`);
            // --- *** MODIFIED: Get both map and registry from scanner *** ---
            const { livePoolStatesMap, pairRegistry } = await this.poolScanner.fetchPoolStates(poolInfosToFetch);
            fetchedPoolCount = Object.keys(livePoolStatesMap).length;
            if (fetchedPoolCount === 0 && poolInfosToFetch.length > 0) { logger.warn(`[Engine Cycle ${currentCycleNum}] Step 2 Warning: Failed to fetch state for any pools.`); }
            else { logger.info(`[Engine Cycle ${currentCycleNum}] Step 2 Complete: Fetched ${fetchedPoolCount} states, built registry with ${Object.keys(pairRegistry).length} pairs.`); }
            // --- *** ---

            // Step 3: Find Opportunities
            logger.debug(`[Engine Cycle ${currentCycleNum}] Step 3: Finding potential opportunities (Triangular & Spatial)...`);
            let triangularOpportunities = []; let spatialOpportunities = [];
            try {
                // Triangular finder still uses the map (needs efficient lookup by address for V3 checks)
                logger.debug(`[Engine Cycle ${currentCycleNum}] Calling triangularV3Finder...`);
                triangularOpportunities = this.triangularV3Finder.findOpportunities(livePoolStatesMap);
                logger.debug(`[Engine Cycle ${currentCycleNum}] triangularV3Finder returned ${triangularOpportunities.length} opps.`);

                // --- *** MODIFIED: Pass pairRegistry to spatialFinder *** ---
                logger.debug(`[Engine Cycle ${currentCycleNum}] Calling spatialFinder...`);
                spatialOpportunities = this.spatialFinder.findOpportunities(pairRegistry); // Pass registry directly
                logger.debug(`[Engine Cycle ${currentCycleNum}] spatialFinder returned ${spatialOpportunities.length} opps.`);
                // --- *** ---
            } catch (finderError) { logger.error(`[Engine Cycle ${currentCycleNum}] Step 3 Error: Failure during finding.`, finderError); }
            const potentialOpportunities = [...triangularOpportunities, ...spatialOpportunities];
            logger.info(`[Engine Cycle ${currentCycleNum}] Step 3 Complete: Found ${potentialOpportunities.length} potential opportunities (${triangularOpportunities.length} Tri, ${spatialOpportunities.length} Spatial).`);

            // Step 4: Process Opportunities (Unchanged Logic)
            if (potentialOpportunities.length === 0) { /* ... */ }
            else { /* ... processing loop ... */ }

        } catch (error) { /* ... error handling ... */ }
        finally {
            this.isCycleRunning = false;
            logger.debug(`[Engine Cycle ${currentCycleNum}] <<< Exiting runCycle. Cycle lock released.`);
        }
    }
    // --- *** END MODIFIED runCycle() *** ---


    logCycleEnd(cycleNum, startTime, fetchedPoolCount, executed = false, hadError = false) { /* ... unchanged ... */ }
}

module.exports = { ArbitrageEngine };
