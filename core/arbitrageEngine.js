// /workspaces/arbitrum-flash/core/arbitrageEngine.js
// --- VERSION 1.7 Debug: Simplified SpatialFinder call ---

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

// --- Import Finder Classes ---
const TriangularV3Finder = require('./finders/triangularV3Finder');
const SpatialFinder = require('./finders/spatialFinder'); // Still require it
// --- ---

class ArbitrageEngine {
    constructor(manager, config) {
        // --- Constructor remains the same as v1.6 ---
        logger.info('[Engine Constructor] Initializing ArbitrageEngine...');
        if (!manager || !(manager instanceof FlashSwapManager)) { /* ... */ }
        if (!config) { /* ... */ }
        // ... other validation ...
        this.manager = manager;
        this.config = config;
        this.provider = manager.getProvider();
        this.signer = manager.getSigner();
        logger.debug('[Engine Constructor] Parsing configuration values...');
        try { this.config.parsed = { /* ... */ }; } catch (parseError) { /* ... */ }
        try {
            logger.debug('[Engine Constructor] Initializing QuoteSimulator...');
            this.quoteSimulator = new QuoteSimulator(this.provider, this.config);
            logger.debug('[Engine Constructor] Initializing SIMPLIFIED PoolScanner...');
            this.poolScanner = new PoolScanner(this.config, this.provider);
            logger.debug('[Engine Constructor] Initializing GasEstimator...');
            this.gasEstimator = new GasEstimator(this.provider, this.config);
            logger.debug('[Engine Constructor] Initializing ProfitCalculator...');
            const profitCalcConfig = { /* ... as defined previously ... */
                minProfitWei: this.config.parsed.minProfitWei,
                PROFIT_BUFFER_PERCENT: this.config.PROFIT_BUFFER_PERCENT,
                provider: this.provider,
                chainlinkFeeds: this.config.CHAINLINK_FEEDS,
                nativeDecimals: this.config.nativeDecimals || 18,
                nativeSymbol: this.config.NATIVE_CURRENCY_SYMBOL || 'ETH',
                WRAPPED_NATIVE_SYMBOL: this.config.WRAPPED_NATIVE_SYMBOL || 'WETH'
             };
            this.profitCalculator = new ProfitCalculator(profitCalcConfig);
            logger.debug('[Engine Constructor] Initializing Opportunity Finders...');
            this.triangularV3Finder = new TriangularV3Finder(this.config);
            this.spatialFinder = new SpatialFinder(this.config); // Instantiation is fine
            logger.debug('[Engine Constructor] Core component initialization complete.');
        } catch (initError) { /* ... */ }
        this.isRunning = false; this.isCycleRunning = false; this.cycleCount = 0;
        this.cycleInterval = parseInt(this.config.CYCLE_INTERVAL_MS || '5000', 10);
        this.intervalId = null;
        logger.info('[Engine Constructor] Arbitrage Engine Constructor Finished Successfully.');
    }

    async initialize() { /* ... remains the same ... */ }
    start() { /* ... remains the same ... */ }
    stop() { /* ... remains the same ... */ }

    // --- Updated runCycle with simplified SpatialFinder call ---
    async runCycle() {
        logger.debug(`[Engine runCycle] >>> Entered runCycle (Cycle Attempt: ${this.cycleCount + 1}). Checking conditions... isRunning=${this.isRunning}, isCycleRunning=${this.isCycleRunning}`);
        if (!this.isRunning || this.isCycleRunning) { /* return */ }

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

            // Step 3: Find Opportunities
            logger.debug(`[Engine Cycle ${this.cycleCount}] Step 3: Finding potential opportunities (Triangular & Spatial)...`);

            // --- *** TEMPORARILY SIMPLIFIED SPATIAL FINDER CALL FOR DEBUGGING *** ---
            let triangularOpportunities = [];
            let spatialOpportunities = []; // Default to empty

            try {
                logger.debug(`[Engine Cycle ${this.cycleCount}] Calling triangularV3Finder...`);
                triangularOpportunities = this.triangularV3Finder.findOpportunities(livePoolStatesMap);
                logger.debug(`[Engine Cycle ${this.cycleCount}] triangularV3Finder returned ${triangularOpportunities.length} opps.`);

                // --- Log before/after the *intended* spatial call ---
                console.log(`****** DEBUG: About to call SpatialFinder (Cycle ${this.cycleCount}) ******`);
                // Comment out the actual call:
                // spatialOpportunities = this.spatialFinder.findOpportunities(livePoolStatesMap);
                console.log(`****** DEBUG: Skipped actual SpatialFinder call (Cycle ${this.cycleCount}) ******`);
                // spatialOpportunities remains []

            } catch (finderError) {
                 logger.error(`[Engine Cycle ${this.cycleCount}] Step 3 Error: Failure during opportunity finding.`, finderError);
                 throw new ArbitrageError('FinderError', `Error in finder: ${finderError.message}`);
            }
            // --- *** END SIMPLIFIED CALL *** ---


            const potentialOpportunities = [...triangularOpportunities, ...spatialOpportunities]; // Will only contain triangular opps now
            logger.info(`[Engine Cycle ${this.cycleCount}] Step 3 Complete: Found ${potentialOpportunities.length} potential opportunities (${triangularOpportunities.length} Tri, ${spatialOpportunities.length} Spatial).`); // Spatial will be 0

            // Step 4: Process Opportunities (will only process triangular if any found)
            if (potentialOpportunities.length === 0) { /* log & end cycle */ }
            else { /* loop and process */ }

        } catch (error) {
             console.log(`!!!!!! DEBUG: CATCH BLOCK ENTERED in runCycle (Cycle ${this.cycleCount}) !!!!!!`);
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
     logCycleEnd(startTime, fetchedPoolCount, executed = false, hadError = false) { /* ... */ }
}

module.exports = { ArbitrageEngine };
