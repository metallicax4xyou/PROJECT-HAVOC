// core/arbitrageEngine.js
const { ethers } = require('ethers');
const logger = require('../utils/logger'); // Corrected path
const { handleError, ArbitrageError } = require('../utils/errorHandler');
const quoteSimulator = require('./quoteSimulator'); // Import the simulator module

class ArbitrageEngine {
    constructor(flashSwapManager, poolScanner, checkProfitabilityFn, provider, executeTransactionFn, config, engineLogger) {
        // Store dependencies
        this.flashSwapManager = flashSwapManager;
        this.poolScanner = poolScanner;
        this.checkProfitability = checkProfitabilityFn;
        this.provider = provider;
        this.executeTransaction = executeTransactionFn;
        this.config = config;
        this.logger = engineLogger || logger;

        // Validation of dependencies
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
        if (!this.config || !this.config.NAME) { // Check NAME property
             this.logger.error('[Engine Constructor] Config validation failed! Missing NAME property.', this.config);
             throw new Error('ArbitrageEngine dependency error: Invalid or missing config object.');
        }
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

    startMonitoring() {
        if (this.isMonitoring) { this.logger.warn('[Engine] Monitoring is already active.'); return; }
        this.isMonitoring = true;
        this.cycleCount = 0;
        this.logger.info(`[Engine] Starting arbitrage monitoring loop for ${this.config.NAME}...`); // Use NAME property
        this.logger.info(`[Engine] Cycle Interval: ${this.cycleInterval / 1000} seconds.`);
        this.logger.info('>>> Engine started. Monitoring for opportunities... (Press Ctrl+C to stop) <<<');
        this.runCycle().catch(err => handleError(err, 'Engine.InitialRunCycle'));
        this.monitorInterval = setInterval(() => {
            if (this.isMonitoring) {
                this.runCycle().catch(err => handleError(err, `Engine.IntervalCycle (${this.cycleCount})`));
            } else {
                 if(this.monitorInterval) clearInterval(this.monitorInterval);
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

            this.logger.debug('[Engine] Step 2: Finding potential opportunities...');
            // scannerOpp structure: { groupName, startPoolInfo, swapPoolInfo, sdkTokenBorrowed, sdkTokenIntermediate, borrowAmount }
            const opportunities = this.poolScanner.findOpportunities(livePoolStates);
            this.logger.info(`[Engine] Found ${opportunities.length} potential opportunities.`);
            if (opportunities.length === 0) {
                this.logCycleEnd(cycleStartTime); return;
            }

            this.logger.debug(`[Engine] Step 3: Simulating ${opportunities.length} opportunities...`);
            const simulationPromises = opportunities.map(scannerOpp => { // Renamed for clarity
                // --- ***** CORRECTED OPPORTUNITY STRUCTURE PASSED TO SIMULATOR ***** ---
                const simOpportunity = {
                    groupName: scannerOpp.groupName,           // Pass groupName if needed by simulator
                    poolBorrow: scannerOpp.startPoolInfo,      // Use startPoolInfo as poolBorrow state
                    poolSwap: scannerOpp.swapPoolInfo,         // Use swapPoolInfo as poolSwap state
                    token0: scannerOpp.sdkTokenBorrowed,       // Token to borrow initially
                    token1: scannerOpp.sdkTokenIntermediate,   // Token swapped to in middle
                    flashLoanAmount: scannerOpp.borrowAmount,  // Amount to borrow (use correct name)
                    provider: this.provider                    // Pass provider instance
                };
                // --- ***** ---

                this.logger.debug(`[Engine] Passing to simulateArbitrage: group=${simOpportunity.groupName}, borrowPool=${simOpportunity.poolBorrow?.address}, swapPool=${simOpportunity.poolSwap?.address}`);

                // Call the simulateArbitrage function from the imported quoteSimulator module
                return quoteSimulator.simulateArbitrage(simOpportunity)
                    .then(simResult => ({ ...scannerOpp, simResult })) // Combine result with original scannerOpp
                    .catch(error => {
                        // Log the specific error from simulation
                        this.logger.error(`[Engine] Simulation Error for opp ${scannerOpp.groupName} (${scannerOpp.startPoolInfo?.feeBps}bps -> ${scannerOpp.swapPoolInfo?.feeBps}bps): ${error.message}`);
                        // Log the opportunity that caused the error (JSON.stringify should work now)
                        this.logger.debug(`[Engine] Failing Opportunity Details: ${JSON.stringify(simOpportunity)}`);
                        handleError(error, `Engine.SimulationPromise (${scannerOpp.groupName})`);
                        return { ...scannerOpp, simResult: null }; // Mark simulation as failed
                    });
            });
            const simulationResults = await Promise.all(simulationPromises);
            // Filter for successful simulations AND where profit was calculated (not null) and > 0
            const successfulSimulations = simulationResults.filter(res => res.simResult !== null && typeof res.simResult.profit !== 'undefined' && res.simResult.profit > 0n);

            this.logger.info(`[Engine] ${successfulSimulations.length} opportunities passed simulation with gross profit > 0.`);
            if (successfulSimulations.length === 0) {
                this.logCycleEnd(cycleStartTime); return;
            }

            this.logger.debug(`[Engine] Step 4: Checking profitability for ${successfulSimulations.length} simulations...`);
            const profitabilityCheckPromises = successfulSimulations.map(async (simulatedOpp) => {
                const groupConfig = this.config.POOL_GROUPS.find(g => g.name === simulatedOpp.groupName);
                if (!groupConfig) {
                    this.logger.error(`[Engine] Internal Error: Cannot find group config for ${simulatedOpp.groupName} during profit check.`);
                    return null;
                }
                // Pass the simulation result object which should contain grossProfit and sdkTokenBorrowed
                const profitCheckResult = await this.checkProfitability(simulatedOpp.simResult, this.provider, groupConfig);
                // Combine original scanner opportunity, simulation result, and profitability result
                return { ...simulatedOpp, profitabilityResult: profitCheckResult };
            });
            const checkedOpportunities = (await Promise.all(profitabilityCheckPromises)).filter(opp => opp !== null && opp.profitabilityResult.isProfitable);

            this.logger.info(`[Engine] Found ${checkedOpportunities.length} profitable opportunities after gas calculation.`);

            if (checkedOpportunities.length > 0) {
                 checkedOpportunities.sort((a, b) => (b.profitabilityResult.netProfitWei ?? -1n) - (a.profitabilityResult.netProfitWei ?? -1n));
                 const bestTrade = checkedOpportunities[0];
                 const profitSymbol = bestTrade.sdkTokenBorrowed?.symbol || 'N/A';
                 const netProfitWei = bestTrade.profitabilityResult.netProfitWei ?? 'N/A';
                 const nativeSymbol = this.config.NATIVE_SYMBOL || 'ETH';
                 const nativeDecimals = this.config.NATIVE_DECIMALS || 18;
                 const formattedProfit = (typeof netProfitWei === 'bigint' && netProfitWei !== -1n) ? ethers.formatUnits(netProfitWei, nativeDecimals) : 'N/A';

                 this.logger.info(`[Engine] Best Profitable Opportunity: Group ${bestTrade.groupName}, Est. Net Profit: ${formattedProfit} ${nativeSymbol}. Attempting execution...`);
                 this.logger.debug(`[Engine] Best Trade Details:`, JSON.stringify(bestTrade, null, 2)); // Log safely

                 this.logger.info(`[Engine] Calling executeTransaction for group ${bestTrade.groupName}...`);
                 // Ensure the executeTransaction function signature matches
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
