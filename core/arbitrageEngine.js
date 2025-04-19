// /workspaces/arbitrum-flash/core/arbitrageEngine.js
// --- VERSION UPDATED TO USE SEPARATE FINDER CLASSES ---

const { ethers } = require('ethers');
const { PoolScanner } = require('./poolScanner'); // Uses the simplified PoolScanner
const GasEstimator = require('./gasEstimator');
const ProfitCalculator = require('./profitCalculator');
const logger = require('../utils/logger');
const ErrorHandler = require('../utils/errorHandler');
const FlashSwapManager = require('./flashSwapManager');
const { processOpportunity } = require('./opportunityProcessor');
const { ArbitrageError } = require('../utils/errorHandler');
const QuoteSimulator = require('./quoteSimulator'); // Keep for now, processor uses it

// --- Import Finder Classes ---
const TriangularV3Finder = require('./finders/triangularV3Finder');
const SpatialFinder = require('./finders/spatialFinder');
// --- ---

class ArbitrageEngine {
    constructor(manager, config) {
        logger.info('[Engine Constructor] Initializing ArbitrageEngine...');
        // --- Validation (Keep existing checks) ---
        if (!manager || !(manager instanceof FlashSwapManager)) { throw new ArbitrageError('EngineInit', 'Invalid Manager'); }
        if (!config) { throw new ArbitrageError('EngineInit', 'Config required'); }
        const requiredConfigKeys = [ /*...*/ 'POOL_CONFIGS'];
        const missingKeys = requiredConfigKeys.filter(key => !(key in config));
        if (missingKeys.length > 0) { throw new ArbitrageError('EngineInit', `Missing Config: ${missingKeys.join(', ')}`); }
        if (!Array.isArray(config.POOL_CONFIGS) || config.POOL_CONFIGS.length === 0) { throw new ArbitrageError('EngineInit', 'Config.POOL_CONFIGS invalid'); }
        // --- End Validation ---

        this.manager = manager;
        this.config = config;
        this.provider = manager.getProvider();
        this.signer = manager.getSigner();

        // --- Parse Config Values (Keep existing parsing) ---
        logger.debug('[Engine Constructor] Parsing configuration values...');
        try { /* ... (keep existing parsing logic for minProfitWei etc.) ... */
             this.config.parsed = { /* ... */ };
        } catch (parseError) { /* ... */ }
        // --- End Config Parsing ---

        // --- Initialize Core Component Instances ---
        try {
            logger.debug('[Engine Constructor] Initializing QuoteSimulator...');
            this.quoteSimulator = new QuoteSimulator(/* ... */);

            logger.debug('[Engine Constructor] Initializing SIMPLIFIED PoolScanner...');
            this.poolScanner = new PoolScanner(this.config, this.provider); // Uses simplified scanner

            logger.debug('[Engine Constructor] Initializing GasEstimator...');
            this.gasEstimator = new GasEstimator(/* ... */);

            logger.debug('[Engine Constructor] Initializing ProfitCalculator...');
            this.profitCalculator = new ProfitCalculator({ /* ... */ });

            // --- Instantiate Finder Classes ---
            logger.debug('[Engine Constructor] Initializing Opportunity Finders...');
            this.triangularV3Finder = new TriangularV3Finder();
            this.spatialFinder = new SpatialFinder();
            // --- ---

        } catch (initError) { /* ... */ }
        // --- End Instance Initialization ---

        this.isRunning = false; this.isCycleRunning = false; this.cycleCount = 0;
        this.cycleInterval = parseInt(this.config.CYCLE_INTERVAL_MS || '5000', 10);
        this.intervalId = null;
        logger.info('[Engine Constructor] Arbitrage Engine Constructor Finished Successfully.');
    }

    async initialize() { /* ... (keep existing initialize) ... */ }
    start() { /* ... (keep existing start) ... */ }
    stop() { /* ... (keep existing stop) ... */ }

    // --- Updated runCycle ---
    async runCycle() {
        if (!this.isRunning) { return; }
        if (this.isCycleRunning) { logger.warn('[Engine] Cycle overlap detected.'); return; }
        this.isCycleRunning = true; this.cycleCount++;
        const cycleStartTime = Date.now();
        logger.info(`\n===== [Engine] Starting Cycle #${this.cycleCount} =====`);
        try {
            // 1. Get Pool List from Config
            const poolInfosToFetch = this.config.POOL_CONFIGS;
            if (!Array.isArray(poolInfosToFetch) || poolInfosToFetch.length === 0) { /* ... */ }

            // 2. Fetch Live Pool States (Uses simplified PoolScanner)
            logger.debug(`[Engine] Fetching states for ${poolInfosToFetch.length} pools...`);
            const livePoolStatesMap = await this.poolScanner.fetchPoolStates(poolInfosToFetch);
            const fetchedCount = livePoolStatesMap ? Object.keys(livePoolStatesMap).length : 0;
            if (fetchedCount === 0) { /* ... */ }
            logger.info(`[Engine] Fetched ${fetchedCount} live pool states (V3 & Sushi).`);

            // 3. Find Opportunities (Using separate finders)
            logger.debug('[Engine] Finding potential opportunities (Triangular & Spatial)...');
            // --- Call V3 Triangular Finder ---
            const triangularOpportunities = this.triangularV3Finder.findOpportunities(livePoolStatesMap);
            // --- Call Spatial Finder ---
            const spatialOpportunities = this.spatialFinder.findOpportunities(livePoolStatesMap);
            // --- Combine ---
            const potentialOpportunities = [...triangularOpportunities, ...spatialOpportunities];

            if (potentialOpportunities.length === 0) { /* ... */ }
            logger.info(`[Engine] Found ${potentialOpportunities.length} potential opportunities (${triangularOpportunities.length} Tri, ${spatialOpportunities.length} Spatial). Processing...`);

            // 4. Process Opportunities
            let executedThisCycle = false;
            const engineContext = { /* ... (keep existing context setup) ... */ };
            for (const opp of potentialOpportunities) {
                if (!this.isRunning) break;
                const stopAfterFirst = this.config.STOP_ON_FIRST_EXECUTION === true || this.config.STOP_ON_FIRST_EXECUTION === 'true';
                if (executedThisCycle && stopAfterFirst) break;
                const logPrefix = `[Engine Cycle ${this.cycleCount}, Opp Type: ${opp?.type || 'N/A'}]`;
                logger.info(`${logPrefix} Processing opportunity: ${opp?.groupName || opp?.pathSymbols?.join('->')}`);
                // Processor still needs update for 'spatial' type
                const processResult = await processOpportunity(opp, engineContext);
                // Handle result...
                if (processResult.executed && processResult.success) { executedThisCycle = true; /*...*/ }
                else if (processResult.executed && !processResult.success) { /*...*/ }
                else if (processResult.error) { /*...*/ }
                else { /*...*/ }
            } // End loop
            this.logCycleEnd(cycleStartTime);
        } catch (error) { /* ... */ }
        finally { this.isCycleRunning = false; }
    } // End runCycle

    logCycleEnd(startTime, hadError = false) { /* ... */ }
}
module.exports = { ArbitrageEngine };
