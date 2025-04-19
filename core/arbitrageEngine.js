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
// Removed LensTickDataProvider import here, as simulator handles it
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
        if (!config.TICKLENS_ADDRESS) {
            logger.fatal('[Engine Constructor] Config object is missing TICKLENS_ADDRESS.');
            throw new Error('Config object missing TICKLENS_ADDRESS.');
        }
        if (!config.CHAIN_ID) {
            logger.fatal('[Engine Constructor] Config object is missing CHAIN_ID.');
            throw new Error('Config object missing CHAIN_ID.');
        }


        this.manager = manager;
        this.config = config;
        this.provider = manager.getProvider();
        this.signer = manager.getSigner();

        // --- Initialize Instances ---
        // Removed LensTickDataProvider instantiation here

        try {
            logger.debug('[Engine Constructor] Initializing QuoteSimulator...');
            // *** Updated QuoteSimulator Instantiation ***
            this.quoteSimulator = new QuoteSimulator(
                this.config.TICKLENS_ADDRESS, // Pass TickLens address from config
                this.provider,               // Pass provider
                this.config.CHAIN_ID         // Pass chainId from config
            );
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
        logger.info('[Engine] Arbitrage Engine Initializing...');
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
         logger.info('[Engine] Arbitrage Engine Initialized Successfully.');
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
            if (!poolInfosToFetch || poolInfosToFetch.length === 0) {
                logger.warn('[Engine] No pool configurations found in config.');
                this.logCycleEnd(cycleStartTime);
                return;
            }

            // 2. Fetch Live Pool States (Same)
            const livePoolStatesMap = await this.poolScanner.fetchPoolStates(poolInfosToFetch);
            const fetchedCount = livePoolStatesMap ? Object.keys(livePoolStatesMap).length : 0;
            if (fetchedCount === 0) {
                logger.warn('[Engine] Failed to fetch any live pool states.');
                this.logCycleEnd(cycleStartTime, true);
                return;
             }
            logger.info(`[Engine] Fetched ${fetchedCount} live pool states.`);

            // 3. Find Opportunities (Same)
            const potentialOpportunities = this.poolScanner.findOpportunities(livePoolStatesMap);
            if (potentialOpportunities.length === 0) {
                logger.info('[Engine] No potential opportunities found in this cycle.');
                this.logCycleEnd(cycleStartTime);
                return;
            }
            logger.info(`[Engine] Found ${potentialOpportunities.length} potential opportunities.`);

            // --- 4. Process Opportunities using OpportunityProcessor ---
            let executedThisCycle = false;

            // Create the context object
            const engineContext = {
                config: this.config,
                manager: this.manager,
                gasEstimator: this.gasEstimator,
                quoteSimulator: this.quoteSimulator, // Pass the simulator instance
                logger: logger
            };

            for (const opp of potentialOpportunities) {
                if (executedThisCycle) {
                     logger.info(`[Engine Cycle ${this.cycleCount}] Skipping remaining opportunities as one was executed.`);
                     break;
                 }

                const logPrefix = `[Engine Cycle ${this.cycleCount}]`;

                // Call the Opportunity Processor with updated context
                const processResult = await processOpportunity(opp, engineContext);

                // Check result logic
                if (processResult.executed && processResult.success) {
                    logger.info(`${logPrefix} Opportunity processed and SUCCESSFULLY executed. Tx: ${processResult.txHash}`);
                    executedThisCycle = true;
                }
                else if (processResult.executed && !processResult.success) {
                    logger.warn(`${logPrefix} Opportunity processed but execution FAILED. Tx: ${processResult.txHash}, Error: ${processResult.error?.message}`);
                    // Decide if you want to stop processing other opportunities after a failed execution attempt
                    // executedThisCycle = true; // Optional: stop after failed attempt too
                }
                else if (processResult.error) {
                     logger.warn(`${logPrefix} Opportunity processing failed before execution attempt. Error: ${processResult.error.message}`);
                     // Continue to next opportunity
                 }
                else {
                     // Not executed, likely due to simulation/profitability check failure (already logged by processor)
                     logger.debug(`${logPrefix} Opportunity processing finished without execution.`);
                 }

            } // End for loop

            this.logCycleEnd(cycleStartTime);

        } catch (error) { // Catch errors in the main cycle logic
            logger.error(`[Engine] Critical error during cycle execution: ${error.message}`);
            ErrorHandler.handleError(error, `Engine.runCycle (${this.cycleCount})`);
            // Log stack trace for better debugging
            if (error.stack) { console.error(error.stack); }
            this.logCycleEnd(cycleStartTime, true);
        }
    } // End runCycle

    logCycleEnd(startTime, hadError = false) {
        const duration = Date.now() - startTime;
        logger.info(`===== [Engine] Cycle #${this.cycleCount} Finished (${duration}ms) ${hadError ? '[WITH ERROR]' : ''} =====`);
    }
}

module.exports = { ArbitrageEngine };
