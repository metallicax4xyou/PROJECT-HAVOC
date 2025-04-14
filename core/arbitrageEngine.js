// core/arbitrageEngine.js
const { ethers } = require('ethers');
const config = require('../config/index.js');
const logger = require('../utils/logger');
const { handleError } = require('../utils/errorHandler');

// Require necessary core components/functions
const { PoolScanner } = require('./poolScanner');
const QuoteSimulator = require('./quoteSimulator');
// TxExecutor class is not imported anymore
const FlashSwapManager = require('./flashSwapManager');

class ArbitrageEngine {
    // --->>> UPDATED Constructor Signature <<<---
    constructor(flashSwapManager, poolScanner, checkProfitabilityFn, provider, executeTransactionFn) {
        this.flashSwapManager = flashSwapManager;
        this.poolScanner = poolScanner;
        this.checkProfitability = checkProfitabilityFn;
        this.provider = provider;
        // --->>> Store the execution function <<<---
        this.executeTransaction = executeTransactionFn;

        // Basic validation of dependencies
        if (!this.flashSwapManager || !this.poolScanner || typeof this.checkProfitability !== 'function' || !this.provider || typeof this.executeTransaction !== 'function') {
            logger.fatal('[Engine] CRITICAL: Missing one or more core dependencies or functions!');
            throw new Error('ArbitrageEngine missing core dependencies.');
        }
         if (!this.flashSwapManager.getProvider()) {
              logger.fatal('[Engine] CRITICAL: FlashSwapManager does not have a provider instance!');
              throw new Error("ArbitrageEngine could not get Provider from FlashSwapManager!");
         }

        this.isMonitoring = false;
        this.cycleCount = 0;
        this.lastCycleTimestamp = 0;
        this.cycleInterval = config.CYCLE_INTERVAL_MS || 5000;

        logger.info('[Engine] Initializing Arbitrage Engine...');
        logger.info('[Engine] Arbitrage Engine Initialized Successfully.');
    }

    async startMonitoring() {
        // ... (startMonitoring logic remains the same) ...
        if (this.isMonitoring) { logger.warn('[Engine] Monitoring is already active.'); return; }
        this.isMonitoring = true;
        this.cycleCount = 0;
        logger.info(`[Engine] Starting arbitrage monitoring loop for ${config.NETWORK_NAME}...`);
        logger.info(`[Engine] Cycle Interval: ${this.cycleInterval / 1000} seconds.`);
        logger.info('>>> Engine started. Monitoring for opportunities... (Press Ctrl+C to stop) <<<');
        await this.runCycle(); // Initial cycle
        this.monitorInterval = setInterval(async () => { await this.runCycle(); }, this.cycleInterval);
    }

    stopMonitoring() {
         // ... (stopMonitoring logic remains the same) ...
         if (!this.isMonitoring) { logger.warn('[Engine] Monitoring is not active.'); return; }
         this.isMonitoring = false;
         if (this.monitorInterval) { clearInterval(this.monitorInterval); this.monitorInterval = null; }
         logger.info('[Engine] Arbitrage monitoring stopped.');
    }

    async runCycle() {
        // ... (Cycle setup logic remains the same) ...
        if (!this.isMonitoring) { return; }
        this.cycleCount++;
        const cycleStartTime = Date.now();
        this.lastCycleTimestamp = cycleStartTime;
        logger.info(`\n===== [Engine] Starting Cycle #${this.cycleCount} =====`);

        try {
            // 1. Scan for Potential Opportunities
            const poolConfigs = config.getPoolConfigs ? config.getPoolConfigs() : []; // Get configs safely
            const livePoolStates = await this.poolScanner.fetchPoolStates(poolConfigs);
            if (!livePoolStates || Object.keys(livePoolStates).length === 0) {
                 logger.info('[Engine] No live pool states fetched this cycle.'); this.logCycleEnd(cycleStartTime); return;
            }
            const opportunities = this.poolScanner.findOpportunities(livePoolStates);
            if (!opportunities || opportunities.length === 0) {
                logger.info('[Engine] No potential opportunities found by scanner in this cycle.'); this.logCycleEnd(cycleStartTime); return;
            }
            logger.info(`[Engine] Found ${opportunities.length} potential opportunities. Simulating...`);

            // 2. Simulate Each Opportunity
            const simulationPromises = opportunities.map(opportunity =>
                QuoteSimulator.simulateArbitrage(this.provider, opportunity)
                    .then(simResult => ({ ...opportunity, simResult }))
                    .catch(error => {
                        logger.error(`[Engine] Error during simulation promise for opp ${opportunity.groupName}: ${error.message}`);
                        handleError(error, `Engine.SimulationPromise (${opportunity.groupName})`);
                        return { ...opportunity, simResult: null };
                    })
            );
            const simulationResults = await Promise.all(simulationPromises);
            const successfulSimulations = simulationResults.filter(res => res.simResult !== null);

            if (successfulSimulations.length === 0) {
                logger.info('[Engine] No opportunities passed simulation phase.'); this.logCycleEnd(cycleStartTime); return;
            }
            logger.info(`[Engine] ${successfulSimulations.length} opportunities passed simulation. Checking profitability...`);

            // 3. Calculate Profitability
            const profitabilityCheckPromises = successfulSimulations.map(async (simulatedOpp) => {
                const groupConfig = config.POOL_GROUPS.find(g => g.name === simulatedOpp.groupName);
                if (!groupConfig) { /* Error handling */ return null; }
                const profitCheckResult = await this.checkProfitability(simulatedOpp.simResult, this.provider, groupConfig);
                return { ...simulatedOpp, ...profitCheckResult };
            });
            const checkedOpportunities = (await Promise.all(profitabilityCheckPromises)).filter(opp => opp !== null);
            const profitableTrades = checkedOpportunities.filter(opp => opp.isProfitable);

            // 4. Execute Best Opportunity if Found
            if (profitableTrades && profitableTrades.length > 0) {
                 profitableTrades.sort((a, b) => /* Sort logic */ (b.netProfit ?? -1n) - (a.netProfit ?? -1n));
                 const bestTrade = profitableTrades[0]; // bestTrade now includes profitabilityResult fields
                 const profitSymbol = bestTrade.sdkTokenBorrowed.symbol || '?';
                 const formattedProfit = bestTrade.netProfit !== -1n ? ethers.formatUnits(bestTrade.netProfit, bestTrade.sdkTokenBorrowed.decimals) : 'N/A';
                 logger.info(`[Engine] Profitable opportunity found! Group: ${bestTrade.groupName}, Est. Net Profit: ${formattedProfit} ${profitSymbol}. Attempting execution...`);

                if (config.DRY_RUN) {
                     logger.warn(`[Engine] --- DRY RUN MODE --- Would execute trade: Group ${bestTrade.groupName}, Borrow: ${ethers.formatUnits(bestTrade.borrowAmount, bestTrade.sdkTokenBorrowed.decimals)} ${profitSymbol}`);
                } else {
                     // --->>> UPDATED: Call executeTransaction function directly <<<---
                     // The function expects (opportunity, manager, profitabilityResult)
                     // 'bestTrade' already contains opportunity details and profitability results combined.
                     logger.info(`[Engine] Calling executeTransaction for group ${bestTrade.groupName}...`);
                     const execResult = await this.executeTransaction(
                         bestTrade,             // Pass the combined trade object
                         this.flashSwapManager, // Pass the manager instance
                         bestTrade              // Pass bestTrade again as it contains profitabilityResult fields like estimatedGasCost
                     );

                     if (execResult.success) {
                         logger.info(`[Engine] Transaction successful! Hash: ${execResult.txHash}`);
                         // Potentially add cooldown or update state
                     } else {
                         logger.error(`[Engine] Transaction execution failed for group ${bestTrade.groupName}: ${execResult.error?.message || 'Unknown execution error'}`);
                         // Handle execution failure (e.g., log, alert, maybe blacklist pool temporarily?)
                     }
                }
            } else {
                logger.info('[Engine] No profitable opportunities found after simulation and profit check.');
            }

        } catch (error) {
            logger.error('[Engine] Critical error during cycle execution:', error);
            handleError(error, `Engine.runCycle (${this.cycleCount})`);
        } finally {
             this.logCycleEnd(cycleStartTime);
        }
    }

    logCycleEnd(startTime) {
         // ... (logCycleEnd logic remains the same) ...
         const duration = Date.now() - startTime;
         logger.info(`===== [Engine] Cycle #${this.cycleCount} Finished (${duration}ms) =====`);
    }

    async shutdown() {
        // ... (shutdown logic remains the same) ...
        logger.info('[Engine] Initiating graceful shutdown...');
        this.stopMonitoring();
        logger.info('[Engine] Shutdown complete.');
    }
}

module.exports = ArbitrageEngine;
