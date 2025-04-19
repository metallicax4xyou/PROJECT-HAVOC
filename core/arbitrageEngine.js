// /workspaces/arbitrum-flash/core/arbitrageEngine.js

const { ethers } = require('ethers');
const { PoolScanner } = require('./poolScanner');
const QuoteSimulator = require('./quoteSimulator'); // Now includes simulateArbitrage
const GasEstimator = require('./gasEstimator');
// --- Import ProfitCalculator ---
const ProfitCalculator = require('./profitCalculator');
const logger = require('../utils/logger');
const ErrorHandler = require('../utils/errorHandler');
const FlashSwapManager = require('./flashSwapManager');
// --- Import executeTransaction ---
const { executeTransaction } = require('./txExecutor');
const { ArbitrageError } = require('../utils/errorHandler'); // Import error type

// Load FlashSwap ABI (Ensure this path is correct)
let flashSwapAbi;
try {
    flashSwapAbi = require('../abis/FlashSwap.json');
    if (!flashSwapAbi || (Array.isArray(flashSwapAbi) && flashSwapAbi.length === 0) || (typeof flashSwapAbi === 'object' && !flashSwapAbi.abi && Object.keys(flashSwapAbi).length === 0)) {
        throw new Error("ABI loaded is empty or invalid structure.");
    }
    if (flashSwapAbi.abi) { flashSwapAbi = flashSwapAbi.abi; } // Use nested ABI if present
    logger.debug("[Engine] Successfully loaded FlashSwap ABI.");
} catch (err) {
    logger.fatal("[Engine] CRITICAL: FAILED TO LOAD FlashSwap ABI.", err);
    process.nextTick(() => process.exit(1));
    throw new Error("Failed to load FlashSwap ABI.");
}

// Helper for safe stringify
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

        this.manager = manager;
        this.config = config;
        this.provider = manager.getProvider();
        this.signer = manager.getSigner(); // This is the NonceManager instance
        this.flashSwapContract = manager.getFlashSwapContract(); // Contract instance connected to NonceManager

        logger.info(`[Engine] Using FlashSwap contract at ${this.flashSwapContract.target} via Manager`);

        logger.debug('[Engine Constructor] Initializing PoolScanner...');
        try {
            this.poolScanner = new PoolScanner(this.config, this.provider);
        } catch(scannerError){
             logger.fatal(`[Engine Constructor] Failed to initialize PoolScanner: ${scannerError.message}`);
             throw scannerError;
        }

        this.gasEstimator = new GasEstimator(this.provider); // Keep for profit calc
        this.isRunning = false;
        this.cycleCount = 0;
        this.cycleInterval = this.config.CYCLE_INTERVAL_MS || 5000;

        logger.info('[Engine] Arbitrage Engine Constructor Finished.');
    }

    async initialize() {
        logger.info('[Engine] Arbitrage Engine Initialized Successfully.');
        // Attempt to initialize NonceManager early
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
        if (this.isRunning) { logger.warn('[Engine] Engine already running.'); return; }
        this.isRunning = true;
        logger.info(`[Engine] Starting arbitrage monitoring loop for ${this.config.NAME}...`);
        logger.info(`[Engine] Cycle Interval: ${this.cycleInterval / 1000} seconds.`);
        // Run first cycle immediately, then set interval
        setImmediate(() => this.runCycle());
        this.intervalId = setInterval(() => {
            if (this.isRunning) { this.runCycle(); }
            else {
                 logger.info('[Engine] Stopping interval loop.');
                 if(this.intervalId) clearInterval(this.intervalId);
                 this.intervalId = null;
            }
        }, this.cycleInterval);
        logger.info('>>> Engine started. Monitoring for opportunities... (Press Ctrl+C to stop) <<<');
    }

    stop() {
        if (!this.isRunning) { logger.warn('[Engine] Engine not running.'); return; }
        logger.info('[Engine] Stopping Arbitrage Engine...');
        this.isRunning = false; // Signal runCycle to stop
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    // Updated runCycle with Profit Calculator integration
    async runCycle() {
        if (!this.isRunning) { logger.info('[Engine] runCycle called but engine is stopped.'); return; }
        this.cycleCount++;
        const cycleStartTime = Date.now();
        logger.info(`\n===== [Engine] Starting Cycle #${this.cycleCount} =====`);

        try {
            // 1. Get Pool List from Config
            const poolInfosToFetch = this.config.getAllPoolConfigs();
            if (!poolInfosToFetch || poolInfosToFetch.length === 0) {
                 logger.warn('[Engine runCycle] No pool configurations found. Check config setup.');
                 this.logCycleEnd(cycleStartTime); return;
            }
            logger.debug(`[Engine runCycle] Prepared ${poolInfosToFetch.length} pool infos for scanner.`);

            // 2. Fetch Live Pool States
            const livePoolStatesMap = await this.poolScanner.fetchPoolStates(poolInfosToFetch);
            const fetchedCount = livePoolStatesMap ? Object.keys(livePoolStatesMap).length : 0;
            if (fetchedCount === 0) {
                logger.warn(`[Engine runCycle] fetchPoolStates returned 0 live states (attempted: ${poolInfosToFetch.length}).`);
                this.logCycleEnd(cycleStartTime); return;
            }
            logger.info(`[Engine] Fetched ${fetchedCount} live pool states.`);

            // 3. Find Opportunities
            const potentialOpportunities = this.poolScanner.findOpportunities(livePoolStatesMap);
            if (potentialOpportunities.length === 0) {
                logger.info('[Engine] No potential opportunities found this cycle.');
                this.logCycleEnd(cycleStartTime); return;
            }
            logger.info(`[Engine] Found ${potentialOpportunities.length} potential opportunities.`);

            // --- 4. Process Opportunities (Simulation, Profit Check, Execution) ---
            let executedThisCycle = false;

            for (const opp of potentialOpportunities) {
                if (executedThisCycle) break;

                const logPrefix = `[Engine OppProc Type: ${opp.type}, Group: ${opp.groupName}]`;
                logger.info(`${logPrefix} Processing potential opportunity...`);
                logger.debug(`${logPrefix} Details: ${safeStringify(opp)}`);

                if (opp.type !== 'triangular') {
                    logger.warn(`${logPrefix} Skipping opportunity type '${opp.type}' (only 'triangular' supported).`);
                    continue;
                }

                try {
                    // a. Find Group Config
                    const groupConfig = this.config.POOL_GROUPS.find(g => g.name === opp.groupName);
                    if (!groupConfig) { logger.error(`${logPrefix} Could not find group config. Skipping.`); continue; }
                    if (!groupConfig.sdkBorrowToken || !groupConfig.borrowAmount || typeof groupConfig.minNetProfit === 'undefined') {
                        logger.error(`${logPrefix} Incomplete group config. Skipping.`); continue;
                    }

                    // b. Verify Borrow Token Matches Path Start
                    const borrowTokenSymbol = groupConfig.borrowTokenSymbol;
                    if (opp.pathSymbols[0] !== borrowTokenSymbol) {
                        logger.error(`${logPrefix} Path start token (${opp.pathSymbols[0]}) != group borrow token (${borrowTokenSymbol}). Skipping.`); continue;
                    }
                    const initialAmount = groupConfig.borrowAmount;

                    // c. Simulate
                    logger.info(`${logPrefix} Simulating path: ${opp.pathSymbols.join(' -> ')} with ${ethers.formatUnits(initialAmount, groupConfig.sdkBorrowToken.decimals)} ${borrowTokenSymbol}`);
                    const simulationResult = await QuoteSimulator.simulateArbitrage(opp, initialAmount);

                    if (!simulationResult) { logger.warn(`${logPrefix} Simulation returned null. Skipping.`); continue; }
                    if (simulationResult.error) { logger.warn(`${logPrefix} Simulation failed: ${simulationResult.error}. Skipping.`); continue; }
                    if (!simulationResult.profitable) { // Checks gross profit > 0
                        logger.info(`${logPrefix} Simulation shows NO gross profit (${ethers.formatUnits(simulationResult.grossProfit, groupConfig.sdkBorrowToken.decimals)} ${borrowTokenSymbol}). Skipping.`);
                        continue;
                    }
                    logger.info(`${logPrefix} ✅ Simulation shows POSITIVE gross profit: ${ethers.formatUnits(simulationResult.grossProfit, groupConfig.sdkBorrowToken.decimals)} ${borrowTokenSymbol}`);

                    // --- d. Net Profit Check & Gas Estimation ---
                    logger.info(`${logPrefix} Performing Net Profit Check...`);
                    // Call checkProfitability, passing the simulation result, gas estimator instance, and group config.
                    // We pass null for txRequest for now, so it uses fallback GAS_LIMIT_ESTIMATE.
                    const profitabilityResult = await ProfitCalculator.checkProfitability(
                         simulationResult,
                         this.gasEstimator, // Pass the engine's gas estimator instance
                         groupConfig,
                         null // txRequest - using fallback gas limit estimate for now
                    );

                    // Check the result from the Profit Calculator
                    if (!profitabilityResult || !profitabilityResult.isProfitable) {
                        logger.info(`${logPrefix} ❌ Not profitable after estimated gas cost. Skipping execution.`);
                        // Log details if available
                         if(profitabilityResult) {
                              logger.debug(`${logPrefix} Profit Check Details: NetProfitWei=${profitabilityResult.netProfitWei}, EstGasCostWei=${profitabilityResult.estimatedGasCostWei}, GrossProfitWei=${profitabilityResult.grossProfitWei}`);
                         }
                        continue; // Skip to the next opportunity
                    }
                    // If we reach here, profitabilityResult.isProfitable is true
                    logger.info(`${logPrefix} ✅✅ Opportunity IS Profitable after estimated gas! (Net Profit: ${ethers.formatUnits(profitabilityResult.netProfitWei, 18)} ${this.config.NATIVE_SYMBOL})`);


                    // e. Execute if profitable
                    logger.info(`${logPrefix} >>> Attempting Execution... <<<`);
                    const executionResult = await executeTransaction(
                        opp,
                        simulationResult,
                        this.manager,
                        this.gasEstimator // Pass estimator (though executor might re-estimate gas)
                    );

                    if (executionResult.success) {
                        logger.info(`${logPrefix} ✅✅✅ EXECUTION SUCCEEDED! TxHash: ${executionResult.txHash}`);
                        executedThisCycle = true; // Stop processing after first successful execution
                    } else {
                        logger.error(`${logPrefix} ❌ Execution FAILED: ${executionResult.error?.message || 'Unknown execution error'}`);
                        if (executionResult.error instanceof ArbitrageError && executionResult.error.details) {
                            logger.error(`${logPrefix} Execution Details: ${safeStringify(executionResult.error.details)}`);
                        }
                    }
                } catch (oppError) {
                    logger.error(`${logPrefix} Error processing opportunity: ${oppError.message}`);
                    ErrorHandler.handleError(oppError, `Engine Opportunity Processing (${opp.groupName})`);
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
        const duration = Date.now() - startTime;
        logger.info(`===== [Engine] Cycle #${this.cycleCount} Finished (${duration}ms) ${hadError ? '[ERROR]' : ''} =====`);
    }
}

module.exports = { ArbitrageEngine };
