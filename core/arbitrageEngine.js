// core/arbitrageEngine.js
const { ethers } = require('ethers');
const logger = require('../utils/logger'); // Corrected path from previous step
const { handleError, ArbitrageError } = require('../utils/errorHandler');
const quoteSimulator = require('./quoteSimulator'); // Assuming needed internally or passed correctly

class ArbitrageEngine {
    constructor(flashSwapManager, poolScanner, checkProfitabilityFn, provider, executeTransactionFn, config, engineLogger) {
        // Store dependencies
        this.flashSwapManager = flashSwapManager;
        this.poolScanner = poolScanner;
        this.checkProfitability = checkProfitabilityFn;
        this.provider = provider;
        this.executeTransaction = executeTransactionFn;
        this.config = config;
        this.logger = engineLogger || logger; // Use injected logger or fallback

        // --- Validation of dependencies ---
        if (!this.flashSwapManager || typeof this.flashSwapManager.executeFlashSwap !== 'function') {
            throw new Error('ArbitrageEngine dependency error: Invalid flashSwapManager.');
        }
        if (!this.poolScanner || typeof this.poolScanner.fetchPoolStates !== 'function' || typeof this.poolScanner.findOpportunities !== 'function') {
            throw new Error('ArbitrageEngine dependency error: Invalid poolScanner.');
        }
        if (typeof this.checkProfitability !== 'function') {
            throw new Error('ArbitrageEngine dependency error: checkProfitabilityFn is not a function.');
        }
        if (!this.provider || typeof this.provider.getBlockNumber !== 'function') {
            throw new Error('ArbitrageEngine dependency error: Invalid provider.');
        }
        if (typeof this.executeTransaction !== 'function') {
            throw new Error('ArbitrageEngine dependency error: executeTransactionFn is not a function.');
        }
        // --- CORRECTED CONFIG CHECK ---
        // Use NAME instead of NETWORK_NAME as defined in config/index.js
        if (!this.config || !this.config.NAME) { // Check for NAME property
             throw new Error('ArbitrageEngine dependency error: Invalid or missing config object.');
        }
        // --- ---
        if (!this.logger || typeof this.logger.info !== 'function') {
             throw new Error('ArbitrageEngine dependency error: Invalid or missing logger object.');
        }
        if (typeof this.flashSwapManager.getProvider !== 'function') {
             throw new Error("ArbitrageEngine dependency error: flashSwapManager missing getProvider method.");
        }
        const internalProviderCheck = this.flashSwapManager.getProvider();
        if (!internalProviderCheck) {
             this.logger.fatal('[Engine] CRITICAL: FlashSwapManager did not return a provider instance!');
             throw new Error("ArbitrageEngine could not get Provider from FlashSwapManager!");
        }
        // --- End Validation ---

        this.isMonitoring = false;
        this.cycleCount = 0;
        this.lastCycleTimestamp = 0;
        this.cycleInterval = this.config.CYCLE_INTERVAL_MS || 5000;

        this.logger.info('[Engine] Initializing Arbitrage Engine...');
        this.logger.debug(`[Engine] Dependencies Check: FlashSwapManager=${!!this.flashSwapManager}, PoolScanner=${!!this.poolScanner}, ProfitChecker=${!!this.checkProfitability}, Provider=${!!this.provider}, TxExecutor=${!!this.executeTransaction}`);
        this.logger.info('[Engine] Arbitrage Engine Initialized Successfully.');
    }

    // startMonitoring and stopMonitoring methods...
    startMonitoring() {
        if (this.isMonitoring) { this.logger.warn('[Engine] Monitoring is already active.'); return; }
        this.isMonitoring = true;
        this.cycleCount = 0;
        // Use the NAME property from the injected config
        this.logger.info(`[Engine] Starting arbitrage monitoring loop for ${this.config.NAME}...`);
        this.logger.info(`[Engine] Cycle Interval: ${this.cycleInterval / 1000} seconds.`);
        this.logger.info('>>> Engine started. Monitoring for opportunities... (Press Ctrl+C to stop) <<<');
        // Run initial cycle immediately, then set interval
        this.runCycle().catch(err => handleError(err, 'Engine.InitialRunCycle'));
        this.monitorInterval = setInterval(() => {
            // Ensure monitoring hasn't been stopped between intervals
            if (this.isMonitoring) {
                this.runCycle().catch(err => handleError(err, `Engine.IntervalCycle (${this.cycleCount})`));
            } else {
                 if(this.monitorInterval) clearInterval(this.monitorInterval); // Clear interval if stopped
            }
        }, this.cycleInterval);
    }

    stopMonitoring() {
         if (!this.isMonitoring) { this.logger.warn('[Engine] Monitoring is not active.'); return; }
         this.isMonitoring = false;
         if (this.monitorInterval) { clearInterval(this.monitorInterval); this.monitorInterval = null; }
         this.logger.info('[Engine] Arbitrage monitoring stopped.');
    }


    async runCycle() {
        if (!this.isMonitoring) {
             this.logger.debug('[Engine] Monitoring stopped, skipping cycle run.');
             return;
        }
        this.cycleCount++;
        const cycleStartTime = Date.now();
        this.lastCycleTimestamp = cycleStartTime;
        this.logger.info(`\n===== [Engine] Starting Cycle #${this.cycleCount} =====`);

        try {
            // Step 1: Scan Pools
            this.logger.debug('[Engine] Step 1: Fetching pool states...');
            const poolConfigs = this.config.getPoolConfigs ? this.config.getPoolConfigs() : [];
            if (poolConfigs.length === 0) {
                 this.logger.warn('[Engine] No pool configurations found in config. Cannot scan.');
                 this.logCycleEnd(cycleStartTime); return;
            }
            const livePoolStates = await this.poolScanner.fetchPoolStates(poolConfigs);
            const liveStateCount = Object.keys(livePoolStates).length;
            this.logger.info(`[Engine] Fetched ${liveStateCount} live pool states.`);
            if (liveStateCount === 0) {
                 this.logCycleEnd(cycleStartTime); return;
            }

            // Step 2: Find Opportunities
            this.logger.debug('[Engine] Step 2: Finding potential opportunities...');
            const opportunities = this.poolScanner.findOpportunities(livePoolStates);
            this.logger.info(`[Engine] Found ${opportunities.length} potential opportunities.`);
            if (opportunities.length === 0) {
                this.logCycleEnd(cycleStartTime); return;
            }

            // Step 3: Simulate Opportunities
            this.logger.debug(`[Engine] Step 3: Simulating ${opportunities.length} opportunities...`);
            const simulationPromises = opportunities.map(opportunity =>
                quoteSimulator.simulateArbitrage(opportunity, this.provider) // Pass provider if needed
                    .then(simResult => ({ ...opportunity, simResult }))
                    .catch(error => {
                        this.logger.error(`[Engine] Error during simulation for opp ${opportunity.groupName}: ${error.message}`);
                        handleError(error, `Engine.SimulationPromise (${opportunity.groupName})`);
                        return { ...opportunity, simResult: null };
                    })
            );
            const simulationResults = await Promise.all(simulationPromises);
            const successfulSimulations = simulationResults.filter(res => res.simResult !== null && res.simResult.profit > 0n);

            this.logger.info(`[Engine] ${successfulSimulations.length} opportunities passed simulation with gross profit > 0.`);
            if (successfulSimulations.length === 0) {
                this.logCycleEnd(cycleStartTime); return;
            }

            // Step 4: Check Profitability (includes gas)
            this.logger.debug(`[Engine] Step 4: Checking profitability for ${successfulSimulations.length} simulations...`);
            const profitabilityCheckPromises = successfulSimulations.map(async (simulatedOpp) => {
                const groupConfig = this.config.POOL_GROUPS.find(g => g.name === simulatedOpp.groupName);
                if (!groupConfig) {
                    this.logger.error(`[Engine] Internal Error: Cannot find group config for ${simulatedOpp.groupName} during profit check.`);
                    return null;
                }
                const profitCheckResult = await this.checkProfitability(simulatedOpp.simResult, this.provider, groupConfig);
                return { ...simulatedOpp, profitabilityResult: profitCheckResult };
            });
            const checkedOpportunities = (await Promise.all(profitabilityCheckPromises)).filter(opp => opp !== null && opp.profitabilityResult.isProfitable);

            this.logger.info(`[Engine] Found ${checkedOpportunities.length} profitable opportunities after gas calculation.`);

            // Step 5: Execute Best Opportunity
            if (checkedOpportunities.length > 0) {
                 checkedOpportunities.sort((a, b) => (b.profitabilityResult.netProfitWei ?? -1n) - (a.profitabilityResult.netProfitWei ?? -1n));
                 const bestTrade = checkedOpportunities[0];
                 const profitSymbol = bestTrade.sdkTokenBorrowed?.symbol || 'N/A';
                 const netProfitWei = bestTrade.profitabilityResult.netProfitWei ?? 'N/A';
                 const nativeSymbol = this.config.NATIVE_SYMBOL || 'ETH';
                 const nativeDecimals = this.config.NATIVE_DECIMALS || 18;
                 const formattedProfit = (typeof netProfitWei === 'bigint' && netProfitWei !== -1n) ? ethers.formatUnits(netProfitWei, nativeDecimals) : 'N/A';

                 this.logger.info(`[Engine] Best Profitable Opportunity: Group ${bestTrade.groupName}, Est. Net Profit: ${formattedProfit} ${nativeSymbol}. Attempting execution...`);
                 this.logger.debug(`[Engine] Best Trade Details:`, bestTrade);

                 // Call the injected executeTransaction function
                 this.logger.info(`[Engine] Calling executeTransaction for group ${bestTrade.groupName}...`);
                 const execResult = await this.executeTransaction(bestTrade, this.flashSwapManager, bestTrade.profitabilityResult);

                 if (execResult.success) {
                     this.logger.info(`[Engine] >>> Execution Successful! TxHash: ${execResult.txHash} <<<`);
                 } else {
                     this.logger.error(`[Engine] >>> Execution Failed for group ${bestTrade.groupName}: ${execResult.error?.message || 'Unknown execution error'} <<<`);
                     handleError(execResult.error || new Error('Unknown execution error'), 'Engine.ExecuteTransaction');
                 }

            } else {
                this.logger.info('[Engine] No profitable opportunities found after simulation and profit check.');
            }

        } catch (error) {
            this.logger.error('[Engine] Critical error during cycle execution:', error);
            handleError(error, `Engine.runCycle (${this.cycleCount})`);
        } finally {
             this.logCycleEnd(cycleStartTime);
        }
    }

    logCycleEnd(startTime) {
         const duration = Date.now() - startTime;
         this.logger.info(`===== [Engine] Cycle #${this.cycleCount} Finished (${duration}ms) =====`);
    }

    async shutdown() {
        this.logger.info('[Engine] Initiating graceful shutdown...');
        this.stopMonitoring();
        this.logger.info('[Engine] Shutdown complete.');
    }
}

module.exports = ArbitrageEngine;
