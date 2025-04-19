// /workspaces/arbitrum-flash/core/arbitrageEngine.js - Refactored
const { ethers } = require('ethers'); // Still needed? Maybe not directly. Keep for now.
const { PoolScanner } = require('./poolScanner');
// Removed direct imports for QuoteSimulator, ProfitCalculator, txExecutor
const GasEstimator = require('./gasEstimator'); // Still needed for engineContext
const logger = require('../utils/logger');
const ErrorHandler = require('../utils/errorHandler'); // Still used for top-level cycle errors
const FlashSwapManager = require('./flashSwapManager'); // Still needed for constructor
const { processOpportunity } = require('./opportunityProcessor'); // Import the new processor
const { ArbitrageError } = require('../utils/errorHandler'); // Still needed for logging maybe

// Helper for safe stringify (can likely be removed if only used in processor now)
function safeStringify(obj, indent = null) {
    try { return JSON.stringify(obj, (_, value) => typeof value === 'bigint' ? value.toString() : value, indent); }
    catch (e) { return "[Unstringifiable Object]"; }
}


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

        this.manager = manager; // Keep manager instance
        this.config = config;   // Keep config instance
        this.provider = manager.getProvider(); // Keep provider (used by scanner)
        this.signer = manager.getSigner(); // Keep signer (passed via manager)

        // Removed flashSwapContract instance from engine - manager provides it when needed
        // logger.info(`[Engine] Using FlashSwap contract at ${this.flashSwapContract.target} via Manager`); // Log removed/moved

        logger.debug('[Engine Constructor] Initializing PoolScanner...');
        try {
            this.poolScanner = new PoolScanner(this.config, this.provider);
        } catch (scannerError) {
            logger.fatal(`[Engine Constructor] Failed to initialize PoolScanner: ${scannerError.message}`);
            throw scannerError;
        }

        this.gasEstimator = new GasEstimator(this.provider); // Keep GasEstimator instance
        this.isRunning = false;
        this.cycleCount = 0;
        this.cycleInterval = this.config.CYCLE_INTERVAL_MS || 5000;

        logger.info('[Engine] Arbitrage Engine Constructor Finished.');
    }

    async initialize() {
        logger.info('[Engine] Arbitrage Engine Initialized Successfully.');
        // Attempt to initialize NonceManager early (remains the same)
        try {
            if (this.signer && typeof this.signer.initialize === 'function') {
                await this.signer.initialize();
                logger.info(`[Engine] Nonce Manager initialized via Engine.`);
            }
        } catch (nonceError) {
            logger.error(`[Engine] Failed to initialize Nonce Manager during engine init: ${nonceError.message}`);
            throw nonceError;
        }
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
                logger.warn('[Engine runCycle] No pool configurations found. Check config setup.');
                this.logCycleEnd(cycleStartTime); return;
            }
            logger.debug(`[Engine runCycle] Prepared ${poolInfosToFetch.length} pool infos for scanner.`);

            // 2. Fetch Live Pool States (Same)
            const livePoolStatesMap = await this.poolScanner.fetchPoolStates(poolInfosToFetch);
            const fetchedCount = livePoolStatesMap ? Object.keys(livePoolStatesMap).length : 0;
            if (fetchedCount === 0) {
                logger.warn(`[Engine runCycle] fetchPoolStates returned 0 live states (attempted: ${poolInfosToFetch.length}).`);
                this.logCycleEnd(cycleStartTime); return;
            }
            logger.info(`[Engine] Fetched ${fetchedCount} live pool states.`);

            // 3. Find Opportunities (Same)
            const potentialOpportunities = this.poolScanner.findOpportunities(livePoolStatesMap);
            if (potentialOpportunities.length === 0) {
                logger.info('[Engine] No potential opportunities found this cycle.');
                this.logCycleEnd(cycleStartTime); return;
            }
            logger.info(`[Engine] Found ${potentialOpportunities.length} potential opportunities.`);

            // --- 4. Process Opportunities using OpportunityProcessor ---
            let executedThisCycle = false;

            // Create the context object containing dependencies needed by the processor
            const engineContext = {
                config: this.config,
                manager: this.manager,
                gasEstimator: this.gasEstimator,
                logger: logger // Pass the shared logger instance
            };

            for (const opp of potentialOpportunities) {
                if (executedThisCycle) {
                     logger.debug(`[Engine] Skipping remaining opportunities as one was executed this cycle.`);
                     break; // Stop processing if one tx was sent/attempted successfully
                }

                const logPrefix = `[Engine Cycle ${this.cycleCount}]`; // Simpler prefix for engine-level logs

                // Call the Opportunity Processor
                const processResult = await processOpportunity(opp, engineContext);

                // Check the result and update flag
                if (processResult.executed && processResult.success) {
                    logger.info(`${logPrefix} Opportunity processed and executed successfully (Tx: ${processResult.txHash}). Ending cycle processing.`);
                    executedThisCycle = true;
                } else if (processResult.executed && !processResult.success) {
                     logger.error(`${logPrefix} Opportunity processing attempted execution but failed. Error: ${processResult.error?.message || 'Unknown'}. Continuing cycle.`);
                     // Decide if you want to break here on failure or continue trying others
                     // executedThisCycle = true; // Uncomment if you want to stop after a FAILED execution attempt too
                } else if (processResult.error) {
                    // Log errors that occurred BEFORE execution attempt (sim, profit check, setup)
                     logger.error(`${logPrefix} Error processing opportunity (before execution): ${processResult.error.message}. Continuing cycle.`);
                } else {
                    // Opportunity was skipped (not triangular, not profitable, etc.) - handled by processor logs
                    logger.debug(`${logPrefix} Opportunity skipped or not profitable (processor handled logs).`);
                }

            } // End for loop

            this.logCycleEnd(cycleStartTime);

        } catch (error) { // Catch errors in the main cycle logic (fetching, scanning)
            logger.error(`[Engine] Critical error during cycle execution: ${error.message}`);
            ErrorHandler.handleError(error, `Engine.runCycle (${this.cycleCount})`);
            this.logCycleEnd(cycleStartTime, true);
        }
    } // End runCycle

    logCycleEnd(startTime, hadError = false) {
        // Same as before
        const duration = Date.now() - startTime;
        logger.info(`===== [Engine] Cycle #${this.cycleCount} Finished (${duration}ms) ${hadError ? '[ERROR]' : ''} =====`);
    }
}

module.exports = { ArbitrageEngine };
