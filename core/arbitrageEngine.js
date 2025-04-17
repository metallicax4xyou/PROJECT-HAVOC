// /workspaces/arbitrum-flash/core/arbitrageEngine.js

const { ethers } = require('ethers');
const { PoolScanner } = require('./poolScanner');
const QuoteSimulator = require('./quoteSimulator');
const GasEstimator = require('./gasEstimator');
const Config = require('../utils/config');
const logger = require('../utils/logger');
const ErrorHandler = require('../utils/errorHandler');
// --- REMOVED: const { getProvider, getSigner } = require('../utils/provider'); --- No longer needed here
// --- ADDED: Need TOKENS definition ---
const { TOKENS } = require('../constants/tokens'); // Make sure this path is correct

// ABI for FlashSwap contract (loaded directly)
let flashSwapAbi;
try {
    flashSwapAbi = require('../artifacts/contracts/FlashSwap.sol/FlashSwap.json').abi;
    if (!flashSwapAbi || flashSwapAbi.length === 0) { throw new Error("ABI loaded is empty."); }
    logger.debug("[Engine] Successfully loaded FlashSwap ABI from artifact.");
} catch (err) {
    logger.fatal("[Engine] CRITICAL: FAILED TO LOAD FlashSwap ABI.", err);
    process.exit(1); // Exit if ABI cannot be loaded
}

// Helper to safely stringify objects with BigInts
function safeStringify(obj, indent = null) {
    try {
        return JSON.stringify(obj, (_, value) =>
            typeof value === 'bigint' ? value.toString() : value, indent);
    } catch (e) { return "[Unstringifiable Object]"; }
}


class ArbitrageEngine {
    // --- UPDATED CONSTRUCTOR ---
    constructor(signer) { // Accept signer directly
        if (!signer || !signer.provider) {
             logger.fatal('[Engine Constructor] Invalid Signer object received. Must be an ethers Wallet or Signer with a provider.');
             throw new Error('Invalid signer provided to ArbitrageEngine constructor.');
        }

        this.signer = signer;
        this.provider = signer.provider; // Get provider from the signer

        this.config = Config.getConfig();
        this.networkConfig = Config.getNetworkConfig(); // Ensure config is loaded after dotenv in bot.js

        // Instantiate FlashSwap Contract using the passed signer
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

        // Initialize other components
        this.poolScanner = new PoolScanner(this.provider, this.networkConfig.poolGroups, TOKENS); // Pass necessary info
        this.gasEstimator = new GasEstimator(this.provider);
        this.isRunning = false;
        this.cycleCount = 0;
        this.cycleInterval = this.config.engine.cycleIntervalMs || 5000;
        this.profitThresholdUsd = this.config.engine.profitThresholdUsd || 1.0;

        logger.info('[Engine] Arbitrage Engine Constructor Finished.');
        // Note: Avoid heavy async operations in constructor
    }
    // --- END UPDATED CONSTRUCTOR ---

    async initialize() {
        // Placeholder for any async setup needed AFTER construction
        // e.g., fetching initial token prices if needed by GasEstimator
        // await this.gasEstimator.initialize();
        logger.info('[Engine] Arbitrage Engine Initialized Successfully.');
    }

    async start() {
        if (this.isRunning) { logger.warn('[Engine] Engine already running.'); return; }
        this.isRunning = true;
        logger.info(`[Engine] Starting arbitrage monitoring loop for ${this.networkConfig.name}...`);
        logger.info(`[Engine] Cycle Interval: ${this.cycleInterval / 1000} seconds.`);
        logger.info(`[Engine] Minimum Profit Threshold: $${this.profitThresholdUsd.toFixed(2)} USD`);

        // Initial cycle run immediately
        // Use setImmediate or setTimeout to allow current execution context to finish
        setImmediate(() => this.runCycle());

        // Set interval for subsequent cycles
        this.intervalId = setInterval(() => {
            if (this.isRunning) { // Check if still running before starting next cycle
                this.runCycle();
            } else {
                 logger.info('[Engine] Stopping interval loop.');
                 clearInterval(this.intervalId);
                 this.intervalId = null;
            }
        }, this.cycleInterval);

        logger.info('>>> Engine started. Monitoring for opportunities... (Press Ctrl+C to stop) <<<');
    }

    stop() {
        if (!this.isRunning) { logger.warn('[Engine] Engine not running.'); return; }
        logger.info('[Engine] Stopping Arbitrage Engine...');
        this.isRunning = false; // Signal runCycle and interval to stop
        // Interval clear happens within the interval check itself now
    }

    async runCycle() {
        // Double check running status at start of cycle
        if (!this.isRunning) {
             logger.info('[Engine] runCycle called but engine is stopped.');
             return;
        }

        this.cycleCount++;
        const cycleStartTime = Date.now();
        logger.info(`\n===== [Engine] Starting Cycle #${this.cycleCount} =====`);

        try {
            // 1. Fetch Live Pool States
            const livePoolStates = await this.poolScanner.fetchPoolStates();
            if (!livePoolStates || livePoolStates.length === 0) {
                logger.warn('[Engine] No live pool states fetched.');
                this.logCycleEnd(cycleStartTime); return;
            }
            logger.info(`[Engine] Fetched ${livePoolStates.length} live pool states.`);

            // 2. Scan for Potential Opportunities
            const potentialOpportunities = this.poolScanner.findOpportunities(livePoolStates);
            if (potentialOpportunities.length === 0) {
                logger.info('[Engine] No potential opportunities found.');
                this.logCycleEnd(cycleStartTime); return;
            }
            logger.info(`[Engine] Found ${potentialOpportunities.length} potential opportunities.`);

            // 3. Simulate Opportunities
            const simulationPromises = potentialOpportunities.map(async (opp) => {
                 try {
                    if (!opp.token0 || typeof opp.token0.decimals === 'undefined') { throw new Error(`Invalid token0 in opportunity: ${safeStringify(opp.token0)}`); }
                    const initialAmount = ethers.parseUnits(this.config.flashSwap.borrowAmount, opp.token0.decimals);
                    const simResult = await QuoteSimulator.simulateArbitrage(opp, initialAmount);
                    // Log results appropriately (consider logging only failures or profitable ones to reduce noise)
                    if (!simResult) { logger.error(`[Engine] Simulation returned null for ${opp.group} (${opp.poolHop1?.fee/10000}bps -> ${opp.poolHop2?.fee/10000}bps)`); return null; }
                    if (simResult.error) { logger.warn(`[Engine] Simulation Failed: ${opp.group} (${opp.poolHop1?.fee/10000}bps -> ${opp.poolHop2?.fee/10000}bps). Reason: ${simResult.error}`); }
                    // if (simResult.profitable) { logger.info(`[Engine] ✅ Profitable Sim: ${opp.group} (${opp.poolHop1.fee/10000}bps -> ${opp.poolHop2.fee/10000}bps). Profit: ${ethers.formatUnits(simResult.grossProfit, opp.token0.decimals)} ${opp.token0.symbol}`); }
                    return simResult;
                } catch (error) {
                    const oppIdentifier = opp ? `${opp.group} (${opp.poolHop1?.fee/10000}bps -> ${opp.poolHop2?.fee/10000}bps)` : 'Unknown Opp';
                    logger.error(`[Engine] Error during single simulation promise for ${oppIdentifier}: ${error.message}`);
                    ErrorHandler.handleError(error, `Engine.SimulationPromise (${oppIdentifier})`, { opportunity: safeStringify(opp) });
                    return { profitable: false, error: `Engine-level simulation error: ${error.message}`, grossProfit: -1n };
                }
            });

            const simulationResults = await Promise.all(simulationPromises);
            const profitableResults = simulationResults.filter(r => r && r.profitable && r.grossProfit > 0n);
            logger.info(`[Engine] ${profitableResults.length} opportunities passed simulation with gross profit > 0.`);

            if (profitableResults.length === 0) { this.logCycleEnd(cycleStartTime); return; }

            // 4. Estimate Gas & Net Profit (Simplified Check)
             // TODO: Add proper net profit calculation using GasEstimator and price feeds
            const bestOpportunity = profitableResults.sort((a, b) => Number(b.grossProfit - a.grossProfit))[0];
            logger.info(`[Engine] Best Opp Gross Profit: ${ethers.formatUnits(bestOpportunity.grossProfit, bestOpportunity.token0.decimals)} ${bestOpportunity.token0.symbol}`);


            // 5. Execute Transaction
             if (bestOpportunity.grossProfit > 0n) { // Basic check - REPLACE with Net Profit Check
                logger.info(`[Engine] >>> PROFITABLE OPPORTUNITY DETECTED <<<`);
                // Avoid logging sensitive details like raw results unless needed for debug
                logger.info(`[Engine] Details: Group=${bestOpportunity.details.group}, Hop1=${bestOpportunity.details.hop1Pool}(${bestOpportunity.details.hop1Fee} fee), Hop2=${bestOpportunity.details.hop2Pool}(${bestOpportunity.details.hop2Fee} fee)`);

                if (this.config.global.dryRun) {
                    logger.warn('[Engine] DRY RUN ENABLED. Transaction will NOT be sent.');
                } else {
                    logger.info('[Engine] Attempting to execute Flash Swap...');
                    try {
                        // Ensure parameters match the actual FlashSwap.sol function signature
                        const tx = await this.flashSwapContract.executeSwap(
                             bestOpportunity.details.hop1Pool,
                             bestOpportunity.details.hop2Pool,
                             TOKENS[bestOpportunity.token0.symbol].address, // Get address from TOKENS constant
                             bestOpportunity.initialAmountToken0,
                             bestOpportunity.details.hop1Fee, // Ensure this is number/uint24
                             bestOpportunity.details.hop2Fee  // Ensure this is number/uint24
                         );
                         logger.info(`[Engine] Flash Swap TX sent: ${tx.hash}`);
                         const receipt = await tx.wait();
                         logger.info(`[Engine] SUCCESS! Flash Swap confirmed. Block: ${receipt.blockNumber}, Status: ${receipt.status}`);
                         if (receipt.status !== 1) { throw new Error(`Transaction failed: ${tx.hash}`); }

                    } catch (error) {
                        logger.error(`[Engine] Flash Swap Execution FAILED: ${error.message}`);
                        ErrorHandler.handleError(error, 'Engine.ExecuteSwap', { opportunity: safeStringify(bestOpportunity.details) });
                    }
                }
            } else {
                 logger.info(`[Engine] Best opportunity gross profit is positive but potentially insufficient after gas.`);
            }

            this.logCycleEnd(cycleStartTime);

        } catch (error) {
            logger.error(`[Engine] Critical error during cycle execution: ${error.message}`);
             ErrorHandler.handleError(error, `Engine.runCycle (${this.cycleCount})`);
             this.logCycleEnd(cycleStartTime, true);
             // Consider stopping the engine on critical cycle errors?
             // this.stop();
        }
    } // End runCycle

    logCycleEnd(startTime, hadError = false) {
        const duration = Date.now() - startTime;
        logger.info(`===== [Engine] Cycle #${this.cycleCount} Finished (${duration}ms) ${hadError ? '[ERROR]' : ''} =====`);
    }

    // Placeholder USD conversion
    async convertToUsd(amount, token) {
        // Replace with actual price feed logic
        return parseFloat(ethers.formatUnits(amount, token.decimals));
    }
}

module.exports = { ArbitrageEngine };
