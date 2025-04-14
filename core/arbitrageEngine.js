// core/arbitrageEngine.js
const config = require('../config/index.js');
const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler');
const { FlashSwapManager } = require('./flashSwapManager');
const { PoolScanner } = require('./poolScanner');
const { simulateArbitrage } = require('./quoteSimulator');
const { checkProfitability } = require('./profitCalculator');
const { executeTransaction } = require('./txExecutor');

class ArbitrageEngine {
    constructor() {
        this.config = config;
        this.manager = new FlashSwapManager(); // Manager handles provider, signer, contracts, nonce
        this.scanner = null; // Will be initialized after manager
        this.isRunning = false;
        this.isProcessing = false; // Simple lock to prevent overlapping cycles
        this.cycleCount = 0;
        this.lastErrorTimestamp = 0;
        this.errorBackoffMs = 5000; // Start backoff at 5 seconds
    }

    async initialize() {
        logger.log('[Engine] Initializing Arbitrage Engine...');
        try {
            await this.manager.initialize(); // Initialize provider, signer, contracts, nonce manager
            // Pass the initialized provider to the scanner
            this.scanner = new PoolScanner(this.config, this.manager.getProvider());
            logger.log('[Engine] Arbitrage Engine Initialized Successfully.');
            return true;
        } catch (error) {
            // Initialization errors are critical
            handleError(error, 'ArbitrageEngine Initialization');
            logger.error('[Engine] CRITICAL: Engine initialization failed. Exiting.');
            return false; // Indicate failure
        }
    }

    /**
     * Starts the main arbitrage monitoring loop.
     */
    start() {
        if (this.isRunning) {
            logger.warn('[Engine] Engine is already running.');
            return;
        }
        if (!this.scanner || !this.manager.isInitialized) {
             logger.error('[Engine] Cannot start, initialization failed or not complete.');
             return;
        }

        logger.log(`[Engine] Starting arbitrage monitoring loop for ${this.config.NAME}...`);
        this.isRunning = true;
        this.runCycle(); // Run the first cycle immediately

        // Set interval for subsequent cycles
        const pollingIntervalMs = this.config.BLOCK_TIME_MS || 5000; // Use config or default
        logger.log(`[Engine] Cycle Interval: ${pollingIntervalMs / 1000} seconds.`);
        setInterval(async () => {
            if (this.isRunning && !this.isProcessing) {
                 await this.runCycle();
            } else if (this.isProcessing) {
                 logger.debug('[Engine] Skipping cycle run - previous cycle still processing.');
            }
        }, pollingIntervalMs);
    }

    /**
     * Stops the main arbitrage monitoring loop.
     */
    stop() {
        logger.log('[Engine] Stopping arbitrage engine...');
        this.isRunning = false;
        // TODO: Add any cleanup logic if necessary (e.g., clear timeouts/intervals explicitly if needed)
    }

    /**
     * Executes a single arbitrage check cycle.
     */
    async runCycle() {
        if (this.isProcessing) {
             logger.warn('[Engine] Attempted to run cycle while already processing.');
             return; // Prevent overlap
        }
        // Simple error backoff mechanism
        if (Date.now() < this.lastErrorTimestamp + this.errorBackoffMs) {
            logger.warn(`[Engine] In error backoff period. Skipping cycle. Waiting ${this.errorBackoffMs}ms...`);
            return;
        }

        this.isProcessing = true;
        this.cycleCount++;
        const startTime = Date.now();
        logger.log(`\n===== [Engine] Starting Cycle #${this.cycleCount} =====`);

        try {
            // 1. Scan for Pools & Find Raw Opportunities
            // Get all pool configurations from the loaded config
            const allPoolInfos = this.config.POOL_GROUPS.flatMap(group =>
                 group.pools.map(p => ({ ...p, groupName: group.name })) // Ensure groupName is included
            );
            const livePoolStates = await this.scanner.fetchPoolStates(allPoolInfos);
            const potentialOpportunities = this.scanner.findOpportunities(livePoolStates);

            if (!potentialOpportunities || potentialOpportunities.length === 0) {
                logger.log('[Engine] No potential opportunities found in this cycle.');
                this.resetErrorBackoff(); // Reset backoff on a successful (even if no opps) cycle
                return; // End cycle early
            }

            logger.log(`[Engine] Found ${potentialOpportunities.length} potential opportunities. Simulating...`);

            // 2. Simulate and Check Profitability for each opportunity
            let bestProfitableOpportunity = null;
            let maxNetProfit = -1n; // Use -1n to handle potential zero profit scenarios correctly

            for (const opportunity of potentialOpportunities) {
                const simulationResult = await simulateArbitrage(opportunity);
                if (simulationResult && simulationResult.grossProfit > 0n) {
                    // Pass the specific group config for minProfit check
                    const groupConfig = this.config.POOL_GROUPS.find(g => g.name === opportunity.groupName);
                    if (!groupConfig) {
                         logger.error(`[Engine] Internal Error: Could not find group config for ${opportunity.groupName} during profitability check.`);
                         continue;
                    }

                    const profitabilityResult = await checkProfitability(simulationResult, this.manager.getProvider(), groupConfig);

                    if (profitabilityResult.isProfitable) {
                         logger.log(`[Engine] ✅ PROFITABLE Opportunity found for ${opportunity.groupName}! Net Profit: ~${profitabilityResult.netProfit >= 0n ? ethers.formatUnits(profitabilityResult.netProfit, opportunity.sdkTokenBorrowed.decimals) : 'N/A'} ${opportunity.sdkTokenBorrowed.symbol}`);
                        // Track the best one found so far
                        // TODO: Add more sophisticated ranking (e.g., ROI, consider non-native accuracy)
                        if (profitabilityResult.netProfit > maxNetProfit) {
                            maxNetProfit = profitabilityResult.netProfit;
                            bestProfitableOpportunity = {
                                ...opportunity, // Carry over opportunity details
                                ...simulationResult, // Add trade1, trade2, grossProfit etc.
                                ...profitabilityResult // Add netProfit, isProfitable, estimatedGasCost
                            };
                        }
                    }
                }
            } // End loop through opportunities

            // 3. Execute the Best Opportunity (if any)
            if (bestProfitableOpportunity) {
                 logger.log(`[Engine] Attempting to execute best opportunity: ${bestProfitableOpportunity.groupName} (Net: ~${maxNetProfit})`);
                 const executionResult = await executeTransaction(bestProfitableOpportunity, this.manager, bestProfitableOpportunity); // Pass manager and profitability result

                 if (executionResult.success) {
                     logger.log(`[Engine] Execution successful (or simulation passed). TxHash/Status: ${executionResult.txHash}`);
                     // Consider adding a cooldown period after successful execution
                 } else {
                      logger.error('[Engine] Execution failed.', executionResult.error);
                      // Implement error handling strategies (e.g., circuit breaker, specific backoff)
                      this.increaseErrorBackoff();
                 }
            } else {
                 logger.log('[Engine] No profitable opportunities found after simulation and profit check.');
                 this.resetErrorBackoff(); // Reset backoff if cycle completed without execution errors
            }

        } catch (error) {
            handleError(error, `Engine Cycle #${this.cycleCount}`);
            this.increaseErrorBackoff(); // Increase backoff on any cycle error
        } finally {
            const endTime = Date.now();
            logger.log(`===== [Engine] Cycle #${this.cycleCount} Finished (${endTime - startTime}ms) =====\n`);
            this.isProcessing = false; // Release lock
        }
    }

    // Simple exponential backoff for errors
    increaseErrorBackoff() {
        this.lastErrorTimestamp = Date.now();
        // Increase backoff, cap at ~1 minute
        this.errorBackoffMs = Math.min(this.errorBackoffMs * 2, 60000);
        logger.log(`[Engine] Increasing error backoff to ${this.errorBackoffMs / 1000} seconds.`);
    }

    resetErrorBackoff() {
        if (this.errorBackoffMs > 5000) {
             logger.log('[Engine] Resetting error backoff period.');
        }
        this.errorBackoffMs = 5000; // Reset to base
        this.lastErrorTimestamp = 0;
    }

}

module.exports = { ArbitrageEngine };
