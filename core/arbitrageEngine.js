// /workspaces/arbitrum-flash/core/arbitrageEngine.js - Refactored with Instances
const { ethers } = require('ethers');
const { PoolScanner } = require('./poolScanner');
const GasEstimator = require('./gasEstimator');
const logger = require('../utils/logger');
const ErrorHandler = require('../utils/errorHandler');
const FlashSwapManager = require('./flashSwapManager');
const { processOpportunity } = require('./opportunityProcessor');
const { ArbitrageError } = require('../utils/errorHandler');

// --- Import classes needed for instances ---
const { LensTickDataProvider } = require('../utils/tickDataProvider');
const QuoteSimulator = require('./quoteSimulator');
// --- ---


class ArbitrageEngine {
    constructor(manager, config) {
        if (!manager || !(manager instanceof FlashSwapManager)) {
            logger.fatal('[Engine Constructor] Invalid FlashSwapManager instance received.');
            throw new Error('Valid FlashSwapManager instance required for ArbitrageEngine.');
        }
        if (!config) {
            logger.fatal('[Engine Constructor] Config object is required.');
            throw new Error('Config object required for ArbitrageEngine.');
        }

        this.manager = manager;
        this.config = config;
        this.provider = manager.getProvider();
        this.signer = manager.getSigner();

        // --- Initialize Instances ---
        try {
            logger.debug('[Engine Constructor] Initializing LensTickDataProvider...');
            this.tickDataProvider = new LensTickDataProvider(
                 this.config.TICKLENS_ADDRESS,
                 this.provider,
                 this.config.CHAIN_ID
            );
        } catch (error) {
             logger.fatal(`[Engine Constructor] Failed to initialize LensTickDataProvider: ${error.message}`);
             // This IS fatal, throw error to prevent startup
             throw error;
        }

         try {
            logger.debug('[Engine Constructor] Initializing QuoteSimulator...');
            this.quoteSimulator = new QuoteSimulator(this.tickDataProvider);
        } catch (error) {
             logger.fatal(`[Engine Constructor] Failed to initialize QuoteSimulator: ${error.message}`);
             // This IS fatal
             throw error;
        }

        logger.debug('[Engine Constructor] Initializing PoolScanner...');
        try {
            this.poolScanner = new PoolScanner(this.config, this.provider);
        } catch (scannerError) {
            logger.fatal(`[Engine Constructor] Failed to initialize PoolScanner: ${scannerError.message}`);
            throw scannerError;
        }

        this.gasEstimator = new GasEstimator(this.provider);
        this.isRunning = false;
        this.cycleCount = 0;
        this.cycleInterval = this.config.CYCLE_INTERVAL_MS || 5000;
        // --- End Instance Initialization ---

        logger.info('[Engine] Arbitrage Engine Constructor Finished.');
    }

    async initialize() {
        logger.info('[Engine] Arbitrage Engine Initializing...'); // Changed log slightly
        // NonceManager init remains the same
        try {
            if (this.signer && typeof this.signer.initialize === 'function') {
                await this.signer.initialize();
                logger.info(`[Engine] Nonce Manager initialized via Engine.`);
            }
        } catch (nonceError) {
            logger.error(`[Engine] Failed to initialize Nonce Manager during engine init: ${nonceError.message}`);
            throw nonceError;
        }
         logger.info('[Engine] Arbitrage Engine Initialized Successfully.'); // Moved success log here
    }

    async start() {
        // Start logic remains the same
        if (this.isRunning) { logger.warn('[Engine] Engine already running.'); return; }
        this.isRunning = true;
        logger.info(`[Engine] Starting arbitrage monitoring loop for ${this.config.NAME}...`);
        logger.info(`[Engine] Cycle Interval: ${this.cycleInterval / 1000} seconds.`);
        setImmediate(() => this.runCycle());
        this.intervalId = setInterval(() => {
            if (this.isRunning) { this.runCycle(); }
            else {
                logger.info('[Engine] Stopping interval loop.');
                if (this.intervalId) clearInterval(this.intervalId);
                this.intervalId = null;
            }
        }, this.cycleInterval);
        logger.info('>>> Engine started. Monitoring for opportunities... (Press Ctrl+C to stop) <<<');
    }

    stop() {
        // Stop logic remains the same
        if (!this.isRunning) { logger.warn('[Engine] Engine not running.'); return; }
        logger.info('[Engine] Stopping Arbitrage Engine...');
        this.isRunning = false;
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    // --- Refactored runCycle ---
    async runCycle() {
        if (!this.isRunning) { logger.info('[Engine] runCycle called but engine is stopped.'); return; }
        this.cycleCount++;
        const cycleStartTime = Date.now();
        logger.info(`\n===== [Engine] Starting Cycle #${this.cycleCount} =====`);

        try {
            // 1. Get Pool List (Same)
            const poolInfosToFetch = this.config.getAllPoolConfigs();
            if (!poolInfosToFetch || poolInfosToFetch.length === 0) { /* ... */ }

            // 2. Fetch Live Pool States (Same)
            const livePoolStatesMap = await this.poolScanner.fetchPoolStates(poolInfosToFetch);
            const fetchedCount = livePoolStatesMap ? Object.keys(livePoolStatesMap).length : 0;
            if (fetchedCount === 0) { /* ... */ }
            logger.info(`[Engine] Fetched ${fetchedCount} live pool states.`);

            // 3. Find Opportunities (Same)
            const potentialOpportunities = this.poolScanner.findOpportunities(livePoolStatesMap);
            if (potentialOpportunities.length === 0) { /* ... */ }
            logger.info(`[Engine] Found ${potentialOpportunities.length} potential opportunities.`);

            // --- 4. Process Opportunities using OpportunityProcessor ---
            let executedThisCycle = false;

            // Create the context object - now pass the simulator instance
            const engineContext = {
                config: this.config,
                manager: this.manager,
                gasEstimator: this.gasEstimator,
                quoteSimulator: this.quoteSimulator, // Pass simulator instance
                logger: logger
            };

            for (const opp of potentialOpportunities) {
                if (executedThisCycle) { /* ... */ break; }

                const logPrefix = `[Engine Cycle ${this.cycleCount}]`;

                // Call the Opportunity Processor with updated context
                const processResult = await processOpportunity(opp, engineContext);

                // Check result logic remains the same
                if (processResult.executed && processResult.success) { /* ... */ executedThisCycle = true; }
                else if (processResult.executed && !processResult.success) { /* ... */ }
                else if (processResult.error) { /* ... */ }
                else { /* ... */ }

            } // End for loop

            this.logCycleEnd(cycleStartTime);

        } catch (error) { // Catch errors in the main cycle logic
            logger.error(`[Engine] Critical error during cycle execution: ${error.message}`);
            ErrorHandler.handleError(error, `Engine.runCycle (${this.cycleCount})`);
            this.logCycleEnd(cycleStartTime, true);
        }
    } // End runCycle

    logCycleEnd(startTime, hadError = false) {
        const duration = Date.now() - startTime;
        logger.info(`===== [Engine] Cycle #${this.cycleCount} Finished (${duration}ms) ${hadError ? '[ERROR]' : ''} =====`);
    }
}

module.exports = { ArbitrageEngine };
