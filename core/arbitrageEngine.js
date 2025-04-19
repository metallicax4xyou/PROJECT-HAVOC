// /workspaces/arbitrum-flash/core/arbitrageEngine.js

const { ethers } = require('ethers');
const { PoolScanner } = require('./poolScanner');
const QuoteSimulator = require('./quoteSimulator'); // Keep for calling simulateArbitrage
const GasEstimator = require('./gasEstimator'); // Keep for potential future integration
const logger = require('../utils/logger');
const ErrorHandler = require('../utils/errorHandler');
const FlashSwapManager = require('./flashSwapManager'); // Need type hint / validation
const { TOKENS } = require('../constants/tokens'); // Keep for now, might be needed for token lookups?

// Load FlashSwap ABI (Consider moving to constants/abis.js if not already there)
let flashSwapAbi;
try {
    // Assuming abi is directly exported from the JSON require if it's CommonJS
    flashSwapAbi = require('../abis/FlashSwap.json');
    if (!flashSwapAbi || (Array.isArray(flashSwapAbi) && flashSwapAbi.length === 0) || (typeof flashSwapAbi === 'object' && !flashSwapAbi.abi && Object.keys(flashSwapAbi).length === 0) ) {
        throw new Error("ABI loaded is empty or invalid structure.");
    }
    // If the require gives { abi: [...] }, use flashSwapAbi.abi
    if (flashSwapAbi.abi) {
        flashSwapAbi = flashSwapAbi.abi;
    }
    logger.debug("[Engine] Successfully loaded FlashSwap ABI.");
} catch (err) {
    logger.fatal("[Engine] CRITICAL: FAILED TO LOAD FlashSwap ABI.", err);
    // Ensure process exit happens correctly even in async context potentially
    process.nextTick(() => process.exit(1));
    // Throw error to prevent constructor from proceeding partially
    throw new Error("Failed to load FlashSwap ABI.");
}

// Helper for safe stringify (can be moved to utils later)
function safeStringify(obj, indent = null) {
    try { return JSON.stringify(obj, (_, value) => typeof value === 'bigint' ? value.toString() : value, indent); }
    catch (e) { return "[Unstringifiable Object]"; }
}

class ArbitrageEngine {
    // --- Updated Constructor Signature ---
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
        this.config = config; // Use the passed-in consolidated config
        this.provider = manager.getProvider(); // Get provider from manager
        this.signer = manager.getSigner(); // Get nonce-managed signer from manager

        // Get FlashSwap contract instance from manager
        this.flashSwapContract = manager.getFlashSwapContract();
        if (!this.flashSwapContract) { // Add check
             throw new Error(`[Engine Constructor] Failed to get FlashSwap contract instance from manager.`);
        }
        logger.info(`[Engine] Using FlashSwap contract at ${this.flashSwapContract.target} via Manager`); // Use target for address

        // --- Initialize other components ---
        logger.debug('[Engine Constructor] Initializing PoolScanner...');
        try {
            // Pass the main config object and the provider
            this.poolScanner = new PoolScanner(this.config, this.provider);
        } catch(scannerError){
             logger.fatal(`[Engine Constructor] Failed to initialize PoolScanner: ${scannerError.message}`);
             throw scannerError;
        }

        // GasEstimator might be used later for net profit check
        this.gasEstimator = new GasEstimator(this.provider);
        this.isRunning = false;
        this.cycleCount = 0;
        // Get cycle interval from the main config object
        this.cycleInterval = this.config.CYCLE_INTERVAL_MS || 5000; // Use || for safety

        // Remove profitThresholdUsd - profit check is now per-group in Wei via ProfitCalculator
        // this.profitThresholdUsd = ...;

        logger.info('[Engine] Arbitrage Engine Constructor Finished.');
    }

    async initialize() {
        // NonceManager is initialized within FlashSwapManager constructor
        // PoolScanner initialization requires no async setup currently
        logger.info('[Engine] Arbitrage Engine Initialized Successfully.');
    }

    async start() {
        if (this.isRunning) { logger.warn('[Engine] Engine already running.'); return; }
        this.isRunning = true;
        logger.info(`[Engine] Starting arbitrage monitoring loop for ${this.config.NAME}...`); // Use config.NAME
        logger.info(`[Engine] Cycle Interval: ${this.cycleInterval / 1000} seconds.`);
        // Remove Min Profit Threshold log here - it's per group now
        // logger.info(`[Engine] Minimum Profit Threshold: ...`);
        setImmediate(() => this.runCycle());
        this.intervalId = setInterval(() => {
            if (this.isRunning) { this.runCycle(); }
            else { logger.info('[Engine] Stopping interval loop.'); clearInterval(this.intervalId); this.intervalId = null; }
        }, this.cycleInterval);
        logger.info('>>> Engine started. Monitoring for opportunities... (Press Ctrl+C to stop) <<<');
    }

    stop() {
        if (!this.isRunning) { logger.warn('[Engine] Engine not running.'); return; }
        logger.info('[Engine] Stopping Arbitrage Engine...');
        this.isRunning = false;
        // Clear interval if it exists
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    async runCycle() {
        if (!this.isRunning) { logger.info('[Engine] runCycle called but engine is stopped.'); return; }
        this.cycleCount++;
        const cycleStartTime = Date.now();
        logger.info(`\n===== [Engine] Starting Cycle #${this.cycleCount} =====`);
        try {
            // --- Use helper on config object to get flat list of pools ---
            const poolInfosToFetch = this.config.getAllPoolConfigs();

            if (!poolInfosToFetch || poolInfosToFetch.length === 0) {
                 logger.warn('[Engine runCycle] No pool configurations found in config.getAllPoolConfigs(). Check config setup.');
                 this.logCycleEnd(cycleStartTime); return;
            }
            logger.debug(`[Engine runCycle] Prepared ${poolInfosToFetch.length} pool infos from config for scanner.`);
            // --- END Preparation ---


            // --- Call fetchPoolStates WITH the poolInfos argument ---
            const livePoolStatesMap = await this.poolScanner.fetchPoolStates(poolInfosToFetch);

            // --- Log fetched state count ---
            const fetchedCount = livePoolStatesMap ? Object.keys(livePoolStatesMap).length : 0;
            if (fetchedCount === 0) {
                logger.warn(`[Engine runCycle] fetchPoolStates returned 0 live states (attempted: ${poolInfosToFetch.length}). Check RPC or pool addresses.`);
                this.logCycleEnd(cycleStartTime); return;
            }
            logger.info(`[Engine] Fetched ${fetchedCount} live pool states.`);

            // --- Call findOpportunities WITH the livePoolStatesMap ---
            const potentialOpportunities = this.poolScanner.findOpportunities(livePoolStatesMap);

            if (potentialOpportunities.length === 0) {
                logger.info('[Engine] No potential opportunities found this cycle.');
                this.logCycleEnd(cycleStartTime); return;
            }
            logger.info(`[Engine] Found ${potentialOpportunities.length} potential opportunities.`);

            // --- Simulation & Execution Logic (NEEDS MAJOR REWORK for Triangular/Profit Calc) ---
            // Placeholder for where the new logic will go:
            // 1. Iterate opportunities
            // 2. For each opp:
            //    a. Determine Group Config (groupName, borrowToken, borrowAmount, minNetProfit) based on opp.pools
            //    b. Simulate using QuoteSimulator.simulateArbitrage(opp, borrowAmount, borrowToken) - NEEDS UPDATED SIGNATURE
            //    c. If simulation successful:
            //       i. Prepare tx data using TxExecutor logic (needs refactor) - get estimated gas limit
            //       ii. Check profitability using ProfitCalculator.checkProfitability(simResult, provider, groupConfig, estimatedGasLimit) - NEEDS UPDATED SIGNATURE?
            //       iii. If profitable:
            //            - Execute using TxExecutor - Needs refactor for triangular
            //
            logger.warn('[Engine] --- SIMULATION & EXECUTION LOGIC NEEDS REFACTOR ---');
            logger.info(`[Engine] Found ${potentialOpportunities.length} potential opps (raw scan), but skipping simulation/execution until refactored.`);


            // TODO: REMOVE OLD SIMULATION/EXECUTION LOGIC BELOW AFTER REFACTOR
            /*
            // --- OLD Simulation Logic ---
            const simulationPromises = potentialOpportunities.map(async (opp) => { ... }); // OLD logic assumes 2-hop
            const simulationResults = await Promise.all(simulationPromises);
            const profitableResults = simulationResults.filter(r => r && r.profitable && r.grossProfit > 0n); // OLD logic
            logger.info(`[Engine] ${profitableResults.length} opportunities passed OLD simulation (Gross Profit Check Only).`);
            if (profitableResults.length === 0) { this.logCycleEnd(cycleStartTime); return; }

            // --- OLD Execution Logic ---
            const bestOpportunity = profitableResults.sort((a, b) => Number(b.grossProfit - a.grossProfit))[0]; // OLD logic
            logger.info(`[Engine] Best Opp (OLD) Gross Profit: ${ethers.formatUnits(bestOpportunity.grossProfit, bestOpportunity.token0.decimals)} ${bestOpportunity.token0.symbol} in group ${bestOpportunity.group}`); // OLD logic

             if (bestOpportunity.grossProfit > 0n) { // OLD logic - NO NET PROFIT CHECK
                logger.info(`[Engine] >>> PROFITABLE OPPORTUNITY DETECTED (OLD LOGIC - GROSS ONLY) <<<`);
                logger.info(`[Engine] Details: Group=${bestOpportunity.group}, Hop1=${bestOpportunity.poolHop1.address}(${bestOpportunity.poolHop1.fee} fee), Hop2=${bestOpportunity.poolHop2.address}(${bestOpportunity.poolHop2.fee} fee)`); // OLD logic

                // Check DRY_RUN using consolidated config
                if (this.config.DRY_RUN) {
                    logger.warn('[Engine] DRY RUN ENABLED. Transaction will NOT be sent.');
                } else {
                    logger.info('[Engine] Attempting to execute Flash Swap (OLD LOGIC - LIKELY WILL FAIL)...');
                    try {
                        // --- THIS CALL IS INCORRECT for triangular AND uses old contract function name likely ---
                        const tx = await this.flashSwapContract.executeSwap( // WRONG FUNCTION / PARAMS
                             bestOpportunity.poolHop1.address,
                             bestOpportunity.poolHop2.address,
                             bestOpportunity.token0.address,
                             bestOpportunity.initialAmountToken0,
                             bestOpportunity.poolHop1.fee,
                             bestOpportunity.poolHop2.fee
                         );
                         // ... rest of old execution ...
                    } catch (error) { ... } // OLD error handling
                }
            } else { ... } // OLD logic
            */
            // END TODO REMOVE OLD LOGIC

            this.logCycleEnd(cycleStartTime);
        } catch (error) {
            logger.error(`[Engine] Critical error during cycle execution: ${error.message}`);
            if (ErrorHandler && typeof ErrorHandler.handleError === 'function') {
                ErrorHandler.handleError(error, `Engine.runCycle (${this.cycleCount})`);
            } else {
                 console.error("[Emergency Log] Cycle Error: ErrorHandler not available.");
            }
            this.logCycleEnd(cycleStartTime, true); // Mark cycle as having error
        }
    } // End runCycle

    logCycleEnd(startTime, hadError = false) {
        const duration = Date.now() - startTime;
        logger.info(`===== [Engine] Cycle #${this.cycleCount} Finished (${duration}ms) ${hadError ? '[ERROR]' : ''} =====`);
    }

    // Remove old convertToUsd - use ProfitCalculator/PriceFeed
    // async convertToUsd(amount, token) { ... }
}

module.exports = { ArbitrageEngine };
