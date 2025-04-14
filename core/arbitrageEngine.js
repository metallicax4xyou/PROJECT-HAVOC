// core/arbitrageEngine.js
const { ethers } = require('ethers');
const config = require('../config/index.js');
const logger = require('../utils/logger');
const { handleError } = require('../utils/errorHandler');

// Require necessary core components/functions
const { PoolScanner } = require('./poolScanner'); // Assuming named export was intended or fixed
const QuoteSimulator = require('./quoteSimulator');
// Note: ProfitCalculator class is not imported anymore
const TxExecutor = require('./txExecutor');
const FlashSwapManager = require('./flashSwapManager');

class ArbitrageEngine {
    // --->>> UPDATED Constructor Signature <<<---
    constructor(flashSwapManager, poolScanner, checkProfitabilityFn, provider, txExecutor) {
        this.flashSwapManager = flashSwapManager;
        this.poolScanner = poolScanner;
        // --->>> Store the function and provider <<<---
        this.checkProfitability = checkProfitabilityFn; // Store the function passed from bot.js
        this.provider = provider;                    // Store the provider passed from bot.js
        this.txExecutor = txExecutor;

        // Basic validation of dependencies
        if (!this.flashSwapManager || !this.poolScanner || typeof this.checkProfitability !== 'function' || !this.provider || !this.txExecutor) {
            logger.fatal('[Engine] CRITICAL: Missing one or more core dependencies or functions!');
            throw new Error('ArbitrageEngine missing core dependencies.');
        }
         // Additional check for provider on flashSwapManager for safety
         if (!this.flashSwapManager.getProvider()) {
              logger.fatal('[Engine] CRITICAL: FlashSwapManager does not have a provider instance!');
              throw new Error("ArbitrageEngine could not get Provider from FlashSwapManager!");
         }
         // Ensure the passed provider is the same? Maybe overkill.
         // if (this.provider !== this.flashSwapManager.getProvider()) {
         //     logger.warn('[Engine] Provider passed directly differs from FlashSwapManager provider.');
         // }


        this.isMonitoring = false;
        this.cycleCount = 0;
        this.lastCycleTimestamp = 0;
        this.cycleInterval = config.CYCLE_INTERVAL_MS || 5000;

        logger.info('[Engine] Initializing Arbitrage Engine...');
        logger.info('[Engine] Arbitrage Engine Initialized Successfully.');
    }

    async startMonitoring() {
        // ... (startMonitoring logic remains the same) ...
        if (this.isMonitoring) {
            logger.warn('[Engine] Monitoring is already active.');
            return;
        }
        this.isMonitoring = true;
        this.cycleCount = 0;
        logger.info(`[Engine] Starting arbitrage monitoring loop for ${config.NETWORK_NAME}...`);
        logger.info(`[Engine] Cycle Interval: ${this.cycleInterval / 1000} seconds.`);
        logger.info('>>> Engine started. Monitoring for opportunities... (Press Ctrl+C to stop) <<<');
        await this.runCycle(); // Initial cycle
        this.monitorInterval = setInterval(async () => {
            await this.runCycle();
        }, this.cycleInterval);
    }

    stopMonitoring() {
         // ... (stopMonitoring logic remains the same) ...
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
        // ... (Cycle setup logic remains the same) ...
        if (!this.isMonitoring) { return; }
        this.cycleCount++;
        const cycleStartTime = Date.now();
        this.lastCycleTimestamp = cycleStartTime;
        logger.info(`\n===== [Engine] Starting Cycle #${this.cycleCount} =====`);

        try {
            // 1. Scan for Potential Opportunities using PoolScanner instance
            const livePoolStates = await this.poolScanner.fetchPoolStates(this.poolScanner.config.getPoolConfigs()); // Need access to pool configs
             if (!livePoolStates || Object.keys(livePoolStates).length === 0) {
                 logger.info('[Engine] No live pool states fetched this cycle.');
                 this.logCycleEnd(cycleStartTime);
                 return;
             }
             const opportunities = this.poolScanner.findOpportunities(livePoolStates);
            if (!opportunities || opportunities.length === 0) {
                logger.info('[Engine] No potential opportunities found by scanner in this cycle.');
                this.logCycleEnd(cycleStartTime);
                return;
            }
            logger.info(`[Engine] Found ${opportunities.length} potential opportunities. Simulating...`);

            // 2. Simulate Each Opportunity
            const simulationPromises = opportunities.map(opportunity =>
                // Pass the provider instance stored in the engine
                QuoteSimulator.simulateArbitrage(this.provider, opportunity)
                    .then(simResult => ({ ...opportunity, simResult }))
                    .catch(error => {
                        logger.error(`[Engine] Error during simulation promise for opportunity ${opportunity.groupName}: ${error.message}`);
                        handleError(error, `Engine.SimulationPromise (${opportunity.groupName})`);
                        return { ...opportunity, simResult: null };
                    })
            );
            const simulationResults = await Promise.all(simulationPromises);
            const successfulSimulations = simulationResults.filter(res => res.simResult !== null);

            if (successfulSimulations.length === 0) {
                logger.info('[Engine] No opportunities passed simulation phase.');
                this.logCycleEnd(cycleStartTime);
                return;
            }
            logger.info(`[Engine] ${successfulSimulations.length} opportunities passed simulation. Checking profitability...`);


            // 3. Calculate Profitability (Including Gas Costs)
            // --->>> UPDATED: Call checkProfitability function directly <<<---
            const profitabilityCheckPromises = successfulSimulations.map(async (simulatedOpp) => {
                const groupConfig = config.POOL_GROUPS.find(g => g.name === simulatedOpp.groupName);
                if (!groupConfig) {
                     logger.error(`[Engine] Cannot find group config for ${simulatedOpp.groupName} during profitability check.`);
                     return null; // Skip if config missing
                }
                // Call the checkProfitability function stored in this.checkProfitability
                const profitCheckResult = await this.checkProfitability(
                    simulatedOpp.simResult, // Pass the result object from the simulation
                    this.provider,         // Pass the provider instance stored in the engine
                    groupConfig            // Pass the relevant group config
                );
                // Combine original opportunity data with profitability results
                return {
                     ...simulatedOpp, // Contains original opp details + simResult
                     ...profitCheckResult // Contains isProfitable, netProfit, estimatedGasCost
                 };
            });

            const checkedOpportunities = (await Promise.all(profitabilityCheckPromises)).filter(opp => opp !== null); // Filter out nulls from config errors
            const profitableTrades = checkedOpportunities.filter(opp => opp.isProfitable);

            // 4. Execute Best Opportunity if Found
            if (profitableTrades && profitableTrades.length > 0) {
                 // Simple sort: highest net profit first (assuming netProfit is comparable or native)
                 // WARNING: Need price feed for non-native comparisons
                 profitableTrades.sort((a, b) => {
                     // Handle potential non-BigInt netProfit values if errors occurred
                     const netA = typeof a.netProfit === 'bigint' ? a.netProfit : -Infinity;
                     const netB = typeof b.netProfit === 'bigint' ? b.netProfit : -Infinity;
                     if (netB > netA) return 1;
                     if (netA > netB) return -1;
                     return 0;
                 });

                const bestTrade = profitableTrades[0];
                 const profitSymbol = bestTrade.sdkTokenBorrowed.symbol || '?';
                 const formattedProfit = bestTrade.netProfit !== -1n ? ethers.formatUnits(bestTrade.netProfit, bestTrade.sdkTokenBorrowed.decimals) : 'N/A';
                 logger.info(`[Engine] Profitable opportunity found! Group: ${bestTrade.groupName}, Est. Net Profit: ${formattedProfit} ${profitSymbol}. Attempting execution...`);

                if (config.DRY_RUN) {
                     logger.warn(`[Engine] --- DRY RUN MODE --- Would execute trade: Group ${bestTrade.groupName}, Start Pool: ${bestTrade.startPoolInfo.address}, Swap Pool: ${bestTrade.swapPoolInfo.address}, Borrow: ${ethers.formatUnits(bestTrade.borrowAmount, bestTrade.sdkTokenBorrowed.decimals)} ${profitSymbol}`);
                } else {
                    await this.txExecutor.executeTrade(bestTrade); // Pass the combined object
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
        // process.exit(0); // Don't exit from here, let bot.js handle it
    }
}

// --->>> Ensure direct export <<<---
module.exports = ArbitrageEngine;
