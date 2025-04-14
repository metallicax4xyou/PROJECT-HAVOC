// core/arbitrageEngine.js
const { ethers } = require('ethers');
const config = require('../config/index.js');
const logger = require('../utils/logger');
const { handleError } = require('../utils/errorHandler');

// Require necessary core components
const PoolScanner = require('./poolScanner');
const QuoteSimulator = require('./quoteSimulator');
const ProfitCalculator = require('./profitCalculator');
const TxExecutor = require('./txExecutor');
// FlashSwapManager is needed for provider and eventual execution via TxExecutor
const FlashSwapManager = require('./flashSwapManager');

class ArbitrageEngine {
    constructor(flashSwapManager, poolScanner, profitCalculator, txExecutor) {
        this.flashSwapManager = flashSwapManager; // Store FlashSwapManager instance
        this.poolScanner = poolScanner;
        this.profitCalculator = profitCalculator;
        this.txExecutor = txExecutor;

        // --->>> ADDED: Get provider from FlashSwapManager <<<---
        this.provider = this.flashSwapManager.getProvider();
        if (!this.provider) {
            const errorMsg = "ArbitrageEngine CRITICAL: Could not get Provider instance from FlashSwapManager during initialization!";
            logger.fatal(errorMsg); // Use fatal to indicate critical setup failure
            throw new Error(errorMsg);
        }
        // --->>> END ADDED SECTION <<<---


        this.isMonitoring = false;
        this.cycleCount = 0;
        this.lastCycleTimestamp = 0;
        this.cycleInterval = config.CYCLE_INTERVAL_MS || 5000; // Default 5 seconds

        logger.info('[Engine] Initializing Arbitrage Engine...');
        // Validate dependencies
        if (!this.flashSwapManager || !this.poolScanner || !this.profitCalculator || !this.txExecutor) {
            logger.fatal('[Engine] CRITICAL: Missing one or more core dependencies!');
            throw new Error('ArbitrageEngine missing core dependencies.');
        }
        logger.info('[Engine] Arbitrage Engine Initialized Successfully.');
    }

    async startMonitoring() {
        if (this.isMonitoring) {
            logger.warn('[Engine] Monitoring is already active.');
            return;
        }
        this.isMonitoring = true;
        this.cycleCount = 0; // Reset cycle count on start
        logger.info(`[Engine] Starting arbitrage monitoring loop for ${config.NETWORK_NAME}...`);
        logger.info(`[Engine] Cycle Interval: ${this.cycleInterval / 1000} seconds.`);
        logger.info('>>> Engine started. Monitoring for opportunities... (Press Ctrl+C to stop) <<<');

        // Initial cycle immediate run
        await this.runCycle();

        // Set interval for subsequent cycles
        this.monitorInterval = setInterval(async () => {
            await this.runCycle();
        }, this.cycleInterval);
    }

    stopMonitoring() {
        if (!this.isMonitoring) {
            logger.warn('[Engine] Monitoring is not active.');
            return;
        }
        this.isMonitoring = false;
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
            this.monitorInterval = null;
        }
        logger.info('[Engine] Arbitrage monitoring stopped.');
    }

    async runCycle() {
        if (!this.isMonitoring) {
            logger.warn('[Engine] runCycle called but monitoring is stopped.');
            return;
        }

        this.cycleCount++;
        const cycleStartTime = Date.now();
        this.lastCycleTimestamp = cycleStartTime;
        logger.info(`\n===== [Engine] Starting Cycle #${this.cycleCount} =====`);

        try {
            // 1. Scan for Potential Opportunities
            const opportunities = await this.poolScanner.scan();
            if (!opportunities || opportunities.length === 0) {
                logger.info('[Engine] No potential opportunities found by scanner in this cycle.');
                this.logCycleEnd(cycleStartTime);
                return;
            }
            logger.info(`[Engine] Found ${opportunities.length} potential opportunities. Simulating...`);

            // 2. Simulate Each Opportunity
            const simulationPromises = opportunities.map(opportunity =>
                // --->>> UPDATED: Pass this.provider to simulateArbitrage <<<---
                QuoteSimulator.simulateArbitrage(this.provider, opportunity)
                    .then(simResult => ({ ...opportunity, simResult })) // Attach result to opportunity
                    .catch(error => {
                        // Catch errors *during* simulation promise itself
                        logger.error(`[Engine] Unexpected error during simulation promise for opportunity ${opportunity.groupName}: ${error.message}`);
                        handleError(error, `Engine.SimulationPromise (${opportunity.groupName})`);
                        return { ...opportunity, simResult: null }; // Ensure it returns null result on error
                    })
            );

            const simulationResults = await Promise.all(simulationPromises);

            // Filter out failed simulations (where simResult is null)
            const successfulSimulations = simulationResults.filter(res => res.simResult !== null);

            if (successfulSimulations.length === 0) {
                logger.info('[Engine] No opportunities passed simulation phase.');
                this.logCycleEnd(cycleStartTime);
                return;
            }
            logger.info(`[Engine] ${successfulSimulations.length} opportunities passed simulation. Checking profitability...`);


            // 3. Calculate Profitability (Including Gas Costs)
            // We need to pass the simulation results (which now include gross profit)
            // to the ProfitCalculator, which will estimate gas and determine net profit.
            const profitableTrades = await this.profitCalculator.findMostProfitable(successfulSimulations); // Assuming this method exists and takes simulations

            // 4. Execute Best Opportunity if Found
            if (profitableTrades && profitableTrades.length > 0) {
                // Assuming findMostProfitable returns an array sorted by profitability
                const bestTrade = profitableTrades[0]; // Take the top one
                logger.info(`[Engine] Profitable opportunity found! Group: ${bestTrade.groupName}, Est. Net Profit: ${bestTrade.netProfitEth} ETH. Attempting execution...`);

                // TODO: Implement Dry Run Check
                if (config.DRY_RUN) {
                     logger.warn(`[Engine] --- DRY RUN MODE --- Would execute trade: Group ${bestTrade.groupName}, Start Pool: ${bestTrade.startPoolInfo.address}, Swap Pool: ${bestTrade.swapPoolInfo.address}, Borrow: ${ethers.formatUnits(bestTrade.borrowAmount, bestTrade.sdkTokenBorrowed.decimals)} ${bestTrade.sdkTokenBorrowed.symbol}`);
                } else {
                    // Pass the fully prepared trade object to the executor
                    await this.txExecutor.executeTrade(bestTrade);
                }

            } else {
                logger.info('[Engine] No profitable opportunities found after simulation and profit check.');
            }

        } catch (error) {
            logger.error('[Engine] Critical error during cycle execution:', error);
            handleError(error, `Engine.runCycle (${this.cycleCount})`);
            // Decide if we should stop monitoring on critical errors
            // this.stopMonitoring();
        } finally {
             this.logCycleEnd(cycleStartTime);
        }
    }

    logCycleEnd(startTime) {
         const duration = Date.now() - startTime;
         logger.info(`===== [Engine] Cycle #${this.cycleCount} Finished (${duration}ms) =====`);
    }

    // Graceful shutdown handler
    async shutdown() {
        logger.info('[Engine] Initiating graceful shutdown...');
        this.stopMonitoring();
        // Add any other cleanup tasks if needed
        logger.info('[Engine] Shutdown complete.');
        process.exit(0); // Exit cleanly
    }
}

module.exports = ArbitrageEngine;
