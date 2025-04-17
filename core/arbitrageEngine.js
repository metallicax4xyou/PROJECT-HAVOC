// /workspaces/arbitrum-flash/core/arbitrageEngine.js

const { ethers } = require('ethers');
const { PoolScanner } = require('./poolScanner');
const QuoteSimulator = require('./quoteSimulator');
const GasEstimator = require('./gasEstimator');
const Config = require('../utils/config');
const logger = require('../utils/logger');
const ErrorHandler = require('../utils/errorHandler');
const { TOKENS } = require('../constants/tokens');

let flashSwapAbi;
try {
    flashSwapAbi = require('../artifacts/contracts/FlashSwap.sol/FlashSwap.json').abi;
    if (!flashSwapAbi || flashSwapAbi.length === 0) { throw new Error("ABI loaded is empty."); }
    logger.debug("[Engine] Successfully loaded FlashSwap ABI from artifact.");
} catch (err) {
    logger.fatal("[Engine] CRITICAL: FAILED TO LOAD FlashSwap ABI.", err);
    process.exit(1);
}

function safeStringify(obj, indent = null) {
    try {
        return JSON.stringify(obj, (_, value) =>
            typeof value === 'bigint' ? value.toString() : value, indent);
    } catch (e) { return "[Unstringifiable Object]"; }
}


class ArbitrageEngine {
    constructor(signer) {
        if (!signer || !signer.provider) {
             logger.fatal('[Engine Constructor] Invalid Signer object received.');
             throw new Error('Invalid signer provided to ArbitrageEngine constructor.');
        }

        this.signer = signer;
        this.provider = signer.provider;
        this.config = Config.getConfig();
        // ** Explicitly get network config again within constructor context **
        // Although loaded in bot.js, ensure 'this' context has it correctly.
        this.networkConfig = Config.getNetworkConfig();

        this.flashSwapAddress = this.networkConfig.flashSwapAddress;
         if (!this.flashSwapAddress || !ethers.isAddress(this.flashSwapAddress)) {
             throw new Error(`[Engine Constructor] Invalid or missing FlashSwap address in config: ${this.flashSwapAddress}`);
         }
        try {
            this.flashSwapContract = new ethers.Contract(this.flashSwapAddress, flashSwapAbi, this.signer);
            logger.info(`[Engine] Connected to FlashSwap contract at ${this.flashSwapAddress} via Signer: ${this.signer.address}`);
        } catch (error) {
             logger.fatal(`[Engine Constructor] Failed to instantiate FlashSwap contract: ${error.message}`);
             throw error;
        }

        // --- ADDED DEBUG LOG ---
        logger.debug(`[Engine Constructor] Initializing PoolScanner. Provider exists: ${!!this.provider}`);
        logger.debug(`[Engine Constructor] PoolGroups from networkConfig: ${safeStringify(this.networkConfig.poolGroups)}`);
        logger.debug(`[Engine Constructor] TOKENS object keys: ${Object.keys(TOKENS || {}).join(', ')}`);
        // --- END ADDED DEBUG LOG ---

        // Ensure all dependencies are valid before creating PoolScanner
        if (!this.provider || !this.networkConfig || !this.networkConfig.poolGroups || !TOKENS) {
            throw new Error('[Engine Constructor] Missing dependencies for PoolScanner initialization.');
        }

        this.poolScanner = new PoolScanner(this.provider, this.networkConfig.poolGroups, TOKENS);
        this.gasEstimator = new GasEstimator(this.provider);
        this.isRunning = false;
        this.cycleCount = 0;
        this.cycleInterval = this.config.engine.cycleIntervalMs || 5000;
        this.profitThresholdUsd = this.config.engine.profitThresholdUsd || 1.0;

        logger.info('[Engine] Arbitrage Engine Constructor Finished.');
    }

    async initialize() {
        logger.info('[Engine] Arbitrage Engine Initialized Successfully.');
    }

    async start() {
        // ... start function remains the same ...
        if (this.isRunning) { logger.warn('[Engine] Engine already running.'); return; }
        this.isRunning = true;
        logger.info(`[Engine] Starting arbitrage monitoring loop for ${this.networkConfig.name}...`);
        logger.info(`[Engine] Cycle Interval: ${this.cycleInterval / 1000} seconds.`);
        logger.info(`[Engine] Minimum Profit Threshold: $${this.profitThresholdUsd.toFixed(2)} USD`);
        setImmediate(() => this.runCycle());
        this.intervalId = setInterval(() => {
            if (this.isRunning) { this.runCycle(); }
            else { logger.info('[Engine] Stopping interval loop.'); clearInterval(this.intervalId); this.intervalId = null; }
        }, this.cycleInterval);
        logger.info('>>> Engine started. Monitoring for opportunities... (Press Ctrl+C to stop) <<<');
    }

    stop() {
        // ... stop function remains the same ...
        if (!this.isRunning) { logger.warn('[Engine] Engine not running.'); return; }
        logger.info('[Engine] Stopping Arbitrage Engine...');
        this.isRunning = false;
    }

    async runCycle() {
        // ... runCycle function remains the same ...
        if (!this.isRunning) { logger.info('[Engine] runCycle called but engine is stopped.'); return; }
        this.cycleCount++;
        const cycleStartTime = Date.now();
        logger.info(`\n===== [Engine] Starting Cycle #${this.cycleCount} =====`);
        try {
            // *** Pass the configured groups to fetchPoolStates ***
            // Ensure poolScanner has the groups correctly initialized. The warning suggests it doesn't.
            // Let's assume poolScanner stores the groups internally from constructor.
            // If fetchPoolStates *requires* groups passed each time, that's the fix.
            // For now, we rely on the constructor having initialized it correctly.
            const livePoolStates = await this.poolScanner.fetchPoolStates(); // Assuming fetchPoolStates uses internal config

            if (!livePoolStates || livePoolStates.length === 0) {
                // Scanner should log why it has no states if initialized correctly but fetch fails.
                // The warning "No pool configurations provided" implies it *never got* the config.
                logger.warn('[Engine] No live pool states returned by scanner.');
                this.logCycleEnd(cycleStartTime); return;
            }
            logger.info(`[Engine] Fetched ${livePoolStates.length} live pool states.`);

            const potentialOpportunities = this.poolScanner.findOpportunities(livePoolStates);
            if (potentialOpportunities.length === 0) {
                logger.info('[Engine] No potential opportunities found.');
                this.logCycleEnd(cycleStartTime); return;
            }
            logger.info(`[Engine] Found ${potentialOpportunities.length} potential opportunities.`);

            const simulationPromises = potentialOpportunities.map(async (opp) => { /* ... simulation ... */ });
            const simulationResults = await Promise.all(simulationPromises);
            const profitableResults = simulationResults.filter(r => r && r.profitable && r.grossProfit > 0n);
            logger.info(`[Engine] ${profitableResults.length} opportunities passed simulation with gross profit > 0.`);

            if (profitableResults.length === 0) { this.logCycleEnd(cycleStartTime); return; }

            const bestOpportunity = profitableResults.sort((a, b) => Number(b.grossProfit - a.grossProfit))[0];
            logger.info(`[Engine] Best Opp Gross Profit: ${ethers.formatUnits(bestOpportunity.grossProfit, bestOpportunity.token0.decimals)} ${bestOpportunity.token0.symbol}`);

             if (bestOpportunity.grossProfit > 0n) {
                logger.info(`[Engine] >>> PROFITABLE OPPORTUNITY DETECTED <<<`);
                // ... execution logic ...
                if (this.config.global.dryRun) { logger.warn('[Engine] DRY RUN ENABLED. Transaction will NOT be sent.'); }
                else { /* ... TX execution ... */ }
            } else { logger.info(`[Engine] Best opportunity gross profit is positive but potentially insufficient after gas.`); }
            this.logCycleEnd(cycleStartTime);
        } catch (error) {
            logger.error(`[Engine] Critical error during cycle execution: ${error.message}`);
             ErrorHandler.handleError(error, `Engine.runCycle (${this.cycleCount})`);
             this.logCycleEnd(cycleStartTime, true);
        }
    } // End runCycle

    logCycleEnd(startTime, hadError = false) {
        const duration = Date.now() - startTime;
        logger.info(`===== [Engine] Cycle #${this.cycleCount} Finished (${duration}ms) ${hadError ? '[ERROR]' : ''} =====`);
    }

    async convertToUsd(amount, token) {
        return parseFloat(ethers.formatUnits(amount, token.decimals));
    }
}

module.exports = { ArbitrageEngine };
