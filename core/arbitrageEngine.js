const { ethers } = require('ethers');
const { PoolScanner } = require('./poolScanner');
const QuoteSimulator = require('./quoteSimulator');
const FlashSwap = require('../contracts/flashSwap');
const GasEstimator = require('./gasEstimator');
const Config = require('../utils/config');
const logger = require('../utils/logger');
const ErrorHandler = require('../utils/errorHandler');
const { getProvider, getSigner } = require('../utils/provider');
const { TOKENS } = require('../constants/tokens'); // Assuming TOKENS are defined here correctly


// --- ADDED: Helper to safely stringify objects with BigInts ---
function safeStringify(obj, indent = null) { // indent defaults to null for compact JSON
    try {
        return JSON.stringify(obj, (_, value) =>
            typeof value === 'bigint' ? value.toString() : value, // Convert BigInt to string
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
        this.flashSwap = new FlashSwap(this.signer); // Initialize FlashSwap interaction helper
        this.poolScanner = new PoolScanner(this.provider, this.networkConfig.poolGroups, TOKENS); // Pass TOKENS
        this.gasEstimator = new GasEstimator(this.provider);
        this.isRunning = false;
        this.cycleCount = 0;
        this.cycleInterval = this.config.engine.cycleIntervalMs || 5000; // Default 5 seconds
        this.profitThresholdUsd = this.config.engine.profitThresholdUsd || 1.0; // Minimum USD profit to execute

        logger.info('[Engine] Initializing Arbitrage Engine...');
        // Perform any async initialization if needed
    }

    async initialize() {
        // Placeholder for any async setup needed before starting the loop
        // e.g., fetching initial token prices for profit calculation
        // await this.gasEstimator.initialize(); // If GasEstimator needs async setup
        logger.info('[Engine] Arbitrage Engine Initialized Successfully.');
    }

    async start() {
        if (this.isRunning) {
            logger.warn('[Engine] Engine already running.');
            return;
        }
        this.isRunning = true;
        logger.info(`[Engine] Starting arbitrage monitoring loop for ${this.networkConfig.name}...`);
        logger.info(`[Engine] Cycle Interval: ${this.cycleInterval / 1000} seconds.`);
        logger.info(`[Engine] Minimum Profit Threshold: $${this.profitThresholdUsd.toFixed(2)} USD`);

        // Initial cycle run immediately
        await this.runCycle();

        // Set interval for subsequent cycles
        this.intervalId = setInterval(async () => {
            await this.runCycle();
        }, this.cycleInterval);

        logger.info('>>> Engine started. Monitoring for opportunities... (Press Ctrl+C to stop) <<<');
    }

    stop() {
        if (!this.isRunning) {
            logger.warn('[Engine] Engine not running.');
            return;
        }
        this.isRunning = false;
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        logger.info('[Engine] Arbitrage Engine stopped.');
    }

    async runCycle() {
        if (!this.isRunning && this.cycleCount > 0) return; // Don't run if stopped after first cycle

        this.cycleCount++;
        const cycleStartTime = Date.now();
        logger.info(`\n===== [Engine] Starting Cycle #${this.cycleCount} =====`);

        try {
            // 1. Fetch Live Pool States
            const livePoolStates = await this.poolScanner.fetchPoolStates();
            if (!livePoolStates || livePoolStates.length === 0) {
                logger.warn('[Engine] No live pool states fetched in this cycle.');
                this.logCycleEnd(cycleStartTime);
                return;
            }
            logger.info(`[Engine] Fetched ${livePoolStates.length} live pool states.`);

            // 2. Scan for Potential Opportunities (Price differences + basic liquidity check)
            const potentialOpportunities = this.poolScanner.findOpportunities(livePoolStates);
            if (potentialOpportunities.length === 0) {
                logger.info('[Engine] No potential opportunities found in this cycle.');
                this.logCycleEnd(cycleStartTime);
                return;
            }
            logger.info(`[Engine] Found ${potentialOpportunities.length} potential opportunities.`);

            // 3. Simulate Opportunities Concurrently
            const simulationPromises = potentialOpportunities.map(async (opp) => {
                try {
                    // Ensure borrow amount and token decimals are correctly handled
                    if (!opp.token0 || typeof opp.token0.decimals === 'undefined') {
                        throw new Error(`Invalid token0 in opportunity: ${safeStringify(opp.token0)}`);
                    }
                    const initialAmount = ethers.parseUnits(this.config.flashSwap.borrowAmount, opp.token0.decimals);

                    const simResult = await QuoteSimulator.simulateArbitrage(opp, initialAmount);

                    // --- FIX FOR BigInt Serialization & Logging ---
                    const loggableResult = safeStringify(simResult); // Use helper for safe logging

                    if (!simResult) {
                        // This case should be rare now with internal checks in simulateArbitrage
                        logger.error(`[Engine] Simulation returned null/undefined for opp ${opp.group} (${opp.poolHop1.fee/10000}bps -> ${opp.poolHop2.fee/10000}bps)`);
                        return null; // Return null or a standard error structure
                    } else if (simResult.error) {
                         // Log simulation errors/failures reported by the simulator
                         logger.warn(`[Engine] Simulation Failed/Not Profitable: ${opp.group} (${opp.poolHop1?.fee/10000}bps -> ${opp.poolHop2?.fee/10000}bps). Reason: ${simResult.error}. Details: ${loggableResult}`);
                         return simResult; // Return the result even if not profitable, it contains error info
                    } else if (!simResult.profitable) {
                        // Log non-profitable results if desired (can be verbose)
                        // logger.debug(`[Engine] Simulation Not Profitable: ${opp.group} (${opp.poolHop1.fee/10000}bps -> ${opp.poolHop2.fee/10000}bps). Gross Profit: ${ethers.formatUnits(simResult.grossProfit, opp.token0.decimals)} ${opp.token0.symbol}`);
                        return simResult;
                    } else {
                         // Log profitable simulations
                         logger.info(`[Engine] ✅ Profitable Simulation Found: ${opp.group} (${opp.poolHop1.fee/10000}bps -> ${opp.poolHop2.fee/10000}bps). Gross Profit: ${ethers.formatUnits(simResult.grossProfit, opp.token0.decimals)} ${opp.token0.symbol}`);
                         return simResult; // Return the profitable result
                    }
                    // --- END FIX & Logging ---

                } catch (error) {
                    // Catch unexpected errors *calling* simulateArbitrage or parsing borrow amount
                    const oppIdentifier = opp ? `${opp.group} (${opp.poolHop1?.fee/10000}bps -> ${opp.poolHop2?.fee/10000}bps)` : 'Unknown Opportunity';
                    logger.error(`[Engine] Error during simulation promise for ${oppIdentifier}: ${error.message}`, { stack: error.stack });
                    ErrorHandler.logError(error, `Engine.SimulationPromise (${oppIdentifier})`, { opportunity: safeStringify(opp) });
                    // Return a consistent error structure matching simulateArbitrage's failure format
                    return { profitable: false, error: `Engine-level simulation error: ${error.message}`, grossProfit: -1n };
                }
            });

            // Wait for all simulations to complete
            const simulationResults = await Promise.all(simulationPromises);

            // Filter out nulls/errors and keep only profitable results
            const profitableResults = simulationResults.filter(r => r && r.profitable && r.grossProfit > 0n);
            logger.info(`[Engine] ${profitableResults.length} opportunities passed simulation with gross profit > 0.`);


            if (profitableResults.length === 0) {
                this.logCycleEnd(cycleStartTime);
                return;
            }

            // 4. Estimate Gas Costs & Net Profit for profitable opportunities
            // (This part needs implementation based on GasEstimator and token pricing)
            // For now, we'll just log the gross profit and proceed if DRY_RUN is off

            const bestOpportunity = profitableResults.sort((a, b) => Number(b.grossProfit - a.grossProfit))[0]; // Find best by gross profit for now

             // TODO: Implement Net Profit Calculation
             // const gasCostUsd = await this.gasEstimator.estimateExecutionCostUsd(bestOpportunity);
             // const grossProfitUsd = await this.convertToUsd(bestOpportunity.grossProfit, bestOpportunity.token0); // Needs pricing function
             // const netProfitUsd = grossProfitUsd - gasCostUsd;
             // logger.info(`[Engine] Best Opp Gross Profit: ${ethers.formatUnits(bestOpportunity.grossProfit, bestOpportunity.token0.decimals)} ${bestOpportunity.token0.symbol} (~$${grossProfitUsd.toFixed(2)} USD)`);
             // logger.info(`[Engine] Estimated Gas Cost: ~$${gasCostUsd.toFixed(2)} USD`);
             // logger.info(`[Engine] Estimated Net Profit: ~$${netProfitUsd.toFixed(2)} USD`);


            // 5. Execute Transaction (if profitable after gas and not in dry run)
            // if (netProfitUsd >= this.profitThresholdUsd) {
            // Simplified check based on gross profit for now
            if (bestOpportunity.grossProfit > 0n) { // Basic check
                logger.info(`[Engine] >>> PROFITABLE OPPORTUNITY DETECTED <<<`);
                logger.info(`[Engine] Details: ${safeStringify(bestOpportunity)}`);

                if (this.config.global.dryRun) {
                    logger.warn('[Engine] DRY RUN ENABLED. Transaction will NOT be sent.');
                } else {
                    logger.info('[Engine] Attempting to execute Flash Swap...');
                    try {
                         // TODO: Construct parameters needed for flashSwap.executeSwap
                         // This will depend on your FlashSwap contract's interface
                         // Example: Need pool addresses, fees, borrow token, borrow amount
                         /*
                         const txReceipt = await this.flashSwap.executeSwap(
                             bestOpportunity.details.hop1Pool, // Address of pool 1
                             bestOpportunity.details.hop2Pool, // Address of pool 2
                             bestOpportunity.token0.address,  // Borrow token address
                             bestOpportunity.initialAmountToken0, // Borrow amount (BigInt)
                             bestOpportunity.details.hop1Fee,  // Fee tier 1
                             bestOpportunity.details.hop2Fee   // Fee tier 2
                             // Potentially other parameters like sqrtPriceLimitX96 if needed
                         );
                         logger.info(`[Engine] SUCCESS! Flash Swap executed. Transaction Hash: ${txReceipt.hash}`);
                         */
                         logger.warn('[Engine] Flash Swap execution logic not fully implemented yet.');
                         // Add placeholder for actual execution call
                         await new Promise(resolve => setTimeout(resolve, 100)); // Simulate async operation


                    } catch (error) {
                        logger.error(`[Engine] Flash Swap Execution FAILED: ${error.message}`);
                        ErrorHandler.logError(error, 'Engine.ExecuteSwap', { opportunity: safeStringify(bestOpportunity) });
                        // Potentially add logic to blacklist this opportunity temporarily
                    }
                }
            } else {
                 logger.info(`[Engine] Best opportunity gross profit is positive but potentially insufficient after gas (Net profit check needed).`);
            }

            this.logCycleEnd(cycleStartTime);

        } catch (error) {
            // Catch errors in the main cycle logic (fetching, scanning, promise handling)
            logger.error(`[Engine] Critical error during cycle execution: ${error.message}`, {
                context: `Engine.runCycle (${this.cycleCount})`,
                // Avoid logging raw error object directly if it might contain BigInts or circular refs
                errorDetails: safeStringify(error, 2) // Log safely stringified error details
            });
             ErrorHandler.logError(error, `Engine.runCycle (${this.cycleCount})`);
             this.logCycleEnd(cycleStartTime, true); // Indicate error in cycle end log
        }
    }

    logCycleEnd(startTime, hadError = false) {
        const duration = Date.now() - startTime;
        logger.info(`===== [Engine] Cycle #${this.cycleCount} Finished (${duration}ms) ${hadError ? '[ERROR]' : ''} =====`);
    }

    // Placeholder function - needs implementation with a price feed (e.g., Chainlink, Coingecko)
    async convertToUsd(amount, token) {
        // logger.warn(`[Engine] USD conversion not implemented. Returning placeholder value.`);
        // Example: Fetch price for token.address and multiply
        // const price = await getPriceFromOracle(token.address);
        // return parseFloat(ethers.formatUnits(amount, token.decimals)) * price;
        return parseFloat(ethers.formatUnits(amount, token.decimals)); // Placeholder: return token amount
    }
}

module.exports = { ArbitrageEngine };
