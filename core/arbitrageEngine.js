// /workspaces/arbitrum-flash/core/arbitrageEngine.js

const { ethers } = require('ethers');
const { PoolScanner } = require('./poolScanner');
const QuoteSimulator = require('./quoteSimulator');
// const FlashSwap = require('../contracts/flashSwap'); // <-- REMOVE THIS LINE or comment out
const GasEstimator = require('./gasEstimator');
const Config = require('../utils/config');
const logger = require('../utils/logger');
const ErrorHandler = require('../utils/errorHandler');
const { getProvider, getSigner } = require('../utils/provider');
const { TOKENS } = require('../constants/tokens'); // Assuming TOKENS are defined here correctly

// --- FIX: Require the artifact directly and get the ABI ---
let flashSwapAbi;
try {
    // Adjust path if your hardhat config outputs elsewhere
    flashSwapAbi = require('../artifacts/contracts/FlashSwap.sol/FlashSwap.json').abi;
    if (!flashSwapAbi || flashSwapAbi.length === 0) {
        throw new Error("ABI loaded from artifact is empty.");
    }
    logger.debug("[Engine] Successfully loaded FlashSwap ABI from artifact.");
} catch (err) {
    logger.error("[Engine] CRITICAL: FAILED TO LOAD FlashSwap ABI from artifacts/contracts/FlashSwap.sol/FlashSwap.json");
    logger.error("[Engine] Did you run 'npx hardhat compile'?");
    logger.error(err);
    // Application cannot proceed without the ABI
    process.exit(1); // Exit if ABI cannot be loaded
}
// --- End Fix ---


// Helper to safely stringify objects with BigInts
function safeStringify(obj, indent = null) {
    try {
        return JSON.stringify(obj, (_, value) =>
            typeof value === 'bigint' ? value.toString() : value,
        indent);
    } catch (e) {
        console.error("Error during safeStringify:", e);
        return "[Unstringifiable Object]";
    }
}


class ArbitrageEngine {
    constructor() {
        this.config = Config.getConfig();
        this.networkConfig = Config.getNetworkConfig();
        this.provider = getProvider();
        this.signer = getSigner();

        // --- FIX: Instantiate the contract using the loaded ABI directly ---
        this.flashSwapAddress = this.networkConfig.flashSwapAddress;
         if (!this.flashSwapAddress || !ethers.isAddress(this.flashSwapAddress)) {
             logger.error(`[Engine] Invalid or missing FlashSwap contract address in config for network ${this.networkConfig.name}: ${this.flashSwapAddress}`);
             throw new Error("Missing or invalid FlashSwap address in config.");
         }
        try {
            this.flashSwapContract = new ethers.Contract(this.flashSwapAddress, flashSwapAbi, this.signer);
            logger.info(`[Engine] Connected to FlashSwap contract at ${this.flashSwapAddress}`);
        } catch (error) {
             logger.error(`[Engine] Failed to instantiate FlashSwap contract: ${error.message}`);
             throw error; // Rethrow critical error
        }
        // --- End Fix ---

        this.poolScanner = new PoolScanner(this.provider, this.networkConfig.poolGroups, TOKENS);
        this.gasEstimator = new GasEstimator(this.provider);
        this.isRunning = false;
        this.cycleCount = 0;
        this.cycleInterval = this.config.engine.cycleIntervalMs || 5000;
        this.profitThresholdUsd = this.config.engine.profitThresholdUsd || 1.0;

        logger.info('[Engine] Initializing Arbitrage Engine...');
    }

    async initialize() {
        logger.info('[Engine] Arbitrage Engine Initialized Successfully.');
    }

    async start() {
        if (this.isRunning) { logger.warn('[Engine] Engine already running.'); return; }
        this.isRunning = true;
        logger.info(`[Engine] Starting arbitrage monitoring loop for ${this.networkConfig.name}...`);
        logger.info(`[Engine] Cycle Interval: ${this.cycleInterval / 1000} seconds.`);
        logger.info(`[Engine] Minimum Profit Threshold: $${this.profitThresholdUsd.toFixed(2)} USD`);

        await this.runCycle(); // Initial cycle
        this.intervalId = setInterval(() => this.runCycle(), this.cycleInterval); // Subsequent cycles
        logger.info('>>> Engine started. Monitoring for opportunities... (Press Ctrl+C to stop) <<<');
    }

    stop() {
        if (!this.isRunning) { logger.warn('[Engine] Engine not running.'); return; }
        this.isRunning = false;
        if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; }
        logger.info('[Engine] Arbitrage Engine stopped.');
    }

    async runCycle() {
        if (!this.isRunning && this.cycleCount > 0) return;

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
                // ... (simulation logic remains the same, using QuoteSimulator.simulateArbitrage) ...
                 try {
                    if (!opp.token0 || typeof opp.token0.decimals === 'undefined') {
                        throw new Error(`Invalid token0 in opportunity: ${safeStringify(opp.token0)}`);
                    }
                    const initialAmount = ethers.parseUnits(this.config.flashSwap.borrowAmount, opp.token0.decimals);
                    const simResult = await QuoteSimulator.simulateArbitrage(opp, initialAmount);
                    const loggableResult = safeStringify(simResult);

                    if (!simResult) {
                        logger.error(`[Engine] Simulation returned null/undefined for opp ${opp.group} (${opp.poolHop1?.fee/10000}bps -> ${opp.poolHop2?.fee/10000}bps)`);
                        return null;
                    } else if (simResult.error) {
                         logger.warn(`[Engine] Simulation Failed/Not Profitable: ${opp.group} (${opp.poolHop1?.fee/10000}bps -> ${opp.poolHop2?.fee/10000}bps). Reason: ${simResult.error}. Details: ${loggableResult}`);
                         return simResult;
                    } else if (!simResult.profitable) {
                        return simResult;
                    } else {
                         logger.info(`[Engine] ✅ Profitable Simulation Found: ${opp.group} (${opp.poolHop1.fee/10000}bps -> ${opp.poolHop2.fee/10000}bps). Gross Profit: ${ethers.formatUnits(simResult.grossProfit, opp.token0.decimals)} ${opp.token0.symbol}`);
                         return simResult;
                    }
                } catch (error) {
                    const oppIdentifier = opp ? `${opp.group} (${opp.poolHop1?.fee/10000}bps -> ${opp.poolHop2?.fee/10000}bps)` : 'Unknown Opportunity';
                    logger.error(`[Engine] Error during simulation promise for ${oppIdentifier}: ${error.message}`, { stack: error.stack });
                    ErrorHandler.logError(error, `Engine.SimulationPromise (${oppIdentifier})`, { opportunity: safeStringify(opp) });
                    return { profitable: false, error: `Engine-level simulation error: ${error.message}`, grossProfit: -1n };
                }
            }); // End simulationPromises map

            const simulationResults = await Promise.all(simulationPromises);
            const profitableResults = simulationResults.filter(r => r && r.profitable && r.grossProfit > 0n);
            logger.info(`[Engine] ${profitableResults.length} opportunities passed simulation with gross profit > 0.`);

            if (profitableResults.length === 0) {
                this.logCycleEnd(cycleStartTime); return;
            }

            // 4. Estimate Gas & Net Profit (Simplified Check)
            const bestOpportunity = profitableResults.sort((a, b) => Number(b.grossProfit - a.grossProfit))[0];

            // 5. Execute Transaction (using this.flashSwapContract directly)
             if (bestOpportunity.grossProfit > 0n) { // Basic check
                logger.info(`[Engine] >>> PROFITABLE OPPORTUNITY DETECTED <<<`);
                logger.info(`[Engine] Details: ${safeStringify(bestOpportunity)}`); // Log full details

                if (this.config.global.dryRun) {
                    logger.warn('[Engine] DRY RUN ENABLED. Transaction will NOT be sent.');
                } else {
                    logger.info('[Engine] Attempting to execute Flash Swap...');
                    try {
                        // --- FIX: Call executeSwap on the ethers.Contract instance ---
                        // Ensure parameter names and order match your *actual* FlashSwap.sol executeSwap function
                        const tx = await this.flashSwapContract.executeSwap(
                             bestOpportunity.details.hop1Pool, // pool1 address
                             bestOpportunity.details.hop2Pool, // pool2 address
                             bestOpportunity.token0.address,  // borrow token address
                             bestOpportunity.initialAmountToken0, // borrow amount (BigInt)
                             bestOpportunity.details.hop1Fee,  // Fee tier 1 (ensure it's number)
                             bestOpportunity.details.hop2Fee   // Fee tier 2 (ensure it's number)
                             // Add gas options if needed: { gasLimit: ... }
                         );
                         logger.info(`[Engine] Flash Swap TX sent: ${tx.hash}`);
                         const receipt = await tx.wait();
                         logger.info(`[Engine] SUCCESS! Flash Swap confirmed. Block: ${receipt.blockNumber}, Status: ${receipt.status}`);
                         if (receipt.status !== 1) { throw new Error(`Transaction failed: ${tx.hash}`); }
                         // --- End Fix ---

                    } catch (error) {
                        logger.error(`[Engine] Flash Swap Execution FAILED: ${error.message}`);
                        // Log details specific to the failed execution attempt
                        ErrorHandler.logError(error, 'Engine.ExecuteSwap', {
                             opportunity: safeStringify(bestOpportunity),
                             contractAddress: this.flashSwapAddress
                         });
                    }
                }
            } else {
                 logger.info(`[Engine] Best opportunity gross profit is positive but potentially insufficient after gas.`);
            }

            this.logCycleEnd(cycleStartTime);

        } catch (error) {
            logger.error(`[Engine] Critical error during cycle execution: ${error.message}`, { context: `Engine.runCycle (${this.cycleCount})`, errorDetails: safeStringify(error, 2) });
             ErrorHandler.logError(error, `Engine.runCycle (${this.cycleCount})`);
             this.logCycleEnd(cycleStartTime, true);
        }
    } // End runCycle

    logCycleEnd(startTime, hadError = false) {
        const duration = Date.now() - startTime;
        logger.info(`===== [Engine] Cycle #${this.cycleCount} Finished (${duration}ms) ${hadError ? '[ERROR]' : ''} =====`);
    }

    // Placeholder USD conversion
    async convertToUsd(amount, token) {
        return parseFloat(ethers.formatUnits(amount, token.decimals));
    }
}

module.exports = { ArbitrageEngine };
