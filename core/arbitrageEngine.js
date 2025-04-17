// /workspaces/arbitrum-flash/core/arbitrageEngine.js

const { ethers } = require('ethers');
const { PoolScanner } = require('./poolScanner'); // Import the class
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
    logger.debug("[Engine] Successfully loaded FlashSwap ABI.");
} catch (err) {
    logger.fatal("[Engine] CRITICAL: FAILED TO LOAD FlashSwap ABI.", err);
    process.exit(1);
}

function safeStringify(obj, indent = null) {
    try { return JSON.stringify(obj, (_, value) => typeof value === 'bigint' ? value.toString() : value, indent); }
    catch (e) { return "[Unstringifiable Object]"; }
}

class ArbitrageEngine {
    constructor(signer) {
        if (!signer || !signer.provider) {
             logger.fatal('[Engine Constructor] Invalid Signer object received.');
             throw new Error('Invalid signer provided to ArbitrageEngine constructor.');
        }

        this.signer = signer;
        this.provider = signer.provider;
        // ** Get config ONCE in constructor **
        this.config = Config.getConfig();
        this.networkConfig = Config.getNetworkConfig(); // Assumes network already validated

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

        // --- CORRECTED PoolScanner Initialization ---
        // Pass the main config object and the provider
        logger.debug('[Engine Constructor] Initializing PoolScanner...');
        try {
            this.poolScanner = new PoolScanner(this.config, this.provider);
        } catch(scannerError){
             logger.fatal(`[Engine Constructor] Failed to initialize PoolScanner: ${scannerError.message}`);
             throw scannerError;
        }
        // --- END CORRECTION ---

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
        if (!this.isRunning) { logger.warn('[Engine] Engine not running.'); return; }
        logger.info('[Engine] Stopping Arbitrage Engine...');
        this.isRunning = false;
    }

    async runCycle() {
        if (!this.isRunning) { logger.info('[Engine] runCycle called but engine is stopped.'); return; }
        this.cycleCount++;
        const cycleStartTime = Date.now();
        logger.info(`\n===== [Engine] Starting Cycle #${this.cycleCount} =====`);
        try {
            // --- Prepare poolInfos array needed by fetchPoolStates ---
            const poolInfosToFetch = [];
            if (this.networkConfig.poolGroups) {
                for (const groupName in this.networkConfig.poolGroups) {
                    const group = this.networkConfig.poolGroups[groupName];
                    if (group.pools && Array.isArray(group.pools)) {
                        group.pools.forEach(pool => {
                            if (pool.address && typeof pool.fee === 'number') {
                                poolInfosToFetch.push({
                                    address: pool.address,
                                    fee: pool.fee, // Pass fee (scanner recalculates tick spacing)
                                    group: groupName, // Pass group name
                                    token0Symbol: group.token0Symbol, // Pass symbols for token resolution
                                    token1Symbol: group.token1Symbol
                                });
                            }
                        });
                    }
                }
            }
            logger.debug(`[Engine runCycle] Prepared ${poolInfosToFetch.length} pool infos for scanner.`);
            // --- END Preparation ---


            // --- Call fetchPoolStates WITH the poolInfos argument ---
            const livePoolStatesMap = await this.poolScanner.fetchPoolStates(poolInfosToFetch);

            logger.debug(`[Engine runCycle] fetchPoolStates returned map with ${Object.keys(livePoolStatesMap || {}).length} states.`);

            if (!livePoolStatesMap || Object.keys(livePoolStatesMap).length === 0) {
                logger.warn('[Engine] No live pool states returned by scanner this cycle.');
                this.logCycleEnd(cycleStartTime); return;
            }
            logger.info(`[Engine] Fetched ${Object.keys(livePoolStatesMap).length} live pool states.`);

            // --- Call findOpportunities WITH the livePoolStatesMap ---
            const potentialOpportunities = this.poolScanner.findOpportunities(livePoolStatesMap);

            if (potentialOpportunities.length === 0) {
                logger.info('[Engine] No potential opportunities found.');
                this.logCycleEnd(cycleStartTime); return;
            }
            logger.info(`[Engine] Found ${potentialOpportunities.length} potential opportunities.`);

            // --- Simulation Logic ---
            const simulationPromises = potentialOpportunities.map(async (opp) => {
                try {
                    // Ensure opportunity structure is correct for the simulator
                    if (!opp || !opp.token0 || !opp.poolHop1 || !opp.poolHop2 || typeof opp.token0.decimals === 'undefined') {
                        logger.error('[Engine SimPromise] Invalid opportunity structure received from scanner:', safeStringify(opp));
                        return { profitable: false, error: "Invalid opportunity structure", grossProfit: -1n };
                    }
                    const initialAmount = ethers.parseUnits(this.config.flashSwap.borrowAmount, opp.token0.decimals);
                    // Pass the full opportunity object to the simulator
                    const simResult = await QuoteSimulator.simulateArbitrage(opp, initialAmount);
                    // Log results appropriately
                    if (!simResult) { logger.error(`[Engine SimPromise] Sim returned null for ${opp.group}`); return null; }
                    if (simResult.error) { logger.warn(`[Engine SimPromise] Sim Failed: ${opp.group} (${opp.poolHop1?.fee}bps -> ${opp.poolHop2?.fee}bps). Reason: ${simResult.error}`); }
                    return simResult;
                } catch (error) {
                    logger.error(`[Engine SimPromise] Error during single simulation for ${opp?.group}: ${error.message}`);
                    ErrorHandler.handleError(error, `Engine.SimulationPromise (${opp?.group})`, { opportunity: safeStringify(opp) });
                    return { profitable: false, error: `Engine-level simulation error: ${error.message}`, grossProfit: -1n };
                }
            }); // End simulationPromises map

            const simulationResults = await Promise.all(simulationPromises);
            const profitableResults = simulationResults.filter(r => r && r.profitable && r.grossProfit > 0n);
            logger.info(`[Engine] ${profitableResults.length} opportunities passed simulation.`);
            if (profitableResults.length === 0) { this.logCycleEnd(cycleStartTime); return; }

            // --- Execution Logic ---
            const bestOpportunity = profitableResults.sort((a, b) => Number(b.grossProfit - a.grossProfit))[0];
            logger.info(`[Engine] Best Opp Gross Profit: ${ethers.formatUnits(bestOpportunity.grossProfit, bestOpportunity.token0.decimals)} ${bestOpportunity.token0.symbol} in group ${bestOpportunity.group}`);

             if (bestOpportunity.grossProfit > 0n) { // TODO: Replace with Net Profit Check
                logger.info(`[Engine] >>> PROFITABLE OPPORTUNITY DETECTED <<<`);
                logger.info(`[Engine] Details: Group=${bestOpportunity.group}, Hop1=${bestOpportunity.poolHop1.address}(${bestOpportunity.poolHop1.fee} fee), Hop2=${bestOpportunity.poolHop2.address}(${bestOpportunity.poolHop2.fee} fee)`);

                if (this.config.global.dryRun) {
                    logger.warn('[Engine] DRY RUN ENABLED. Transaction will NOT be sent.');
                } else {
                    logger.info('[Engine] Attempting to execute Flash Swap...');
                    try {
                        // Ensure the addresses and fees are correctly extracted from the opportunity object
                        const tx = await this.flashSwapContract.executeSwap(
                             bestOpportunity.poolHop1.address,
                             bestOpportunity.poolHop2.address,
                             bestOpportunity.token0.address, // Borrow token address from opp object
                             bestOpportunity.initialAmountToken0, // Amount from simulation result
                             bestOpportunity.poolHop1.fee,  // Fee from poolHop1 state
                             bestOpportunity.poolHop2.fee   // Fee from poolHop2 state
                         );
                         logger.info(`[Engine] Flash Swap TX sent: ${tx.hash}`);
                         const receipt = await tx.wait();
                         logger.info(`[Engine] SUCCESS! Flash Swap confirmed. Block: ${receipt.blockNumber}, Status: ${receipt.status}`);
                         if (receipt.status !== 1) { throw new Error(`Transaction failed: ${tx.hash}`); }

                    } catch (error) {
                        logger.error(`[Engine] Flash Swap Execution FAILED: ${error.message}`);
                        // Use the actual handleError function
                        if (ErrorHandler && typeof ErrorHandler.handleError === 'function') {
                             ErrorHandler.handleError(error, 'Engine.ExecuteSwap', { opportunity: safeStringify(bestOpportunity) });
                        } else {
                             console.error("[Emergency Log] Flash Swap Failed: ErrorHandler not available.");
                        }
                    }
                }
            } else {
                 logger.info(`[Engine] Best opportunity gross profit is positive but potentially insufficient after gas.`);
            }
            this.logCycleEnd(cycleStartTime);
        } catch (error) {
            logger.error(`[Engine] Critical error during cycle execution: ${error.message}`);
            if (ErrorHandler && typeof ErrorHandler.handleError === 'function') {
                ErrorHandler.handleError(error, `Engine.runCycle (${this.cycleCount})`);
            } else {
                 console.error("[Emergency Log] Cycle Error: ErrorHandler not available.");
            }
             this.logCycleEnd(cycleStartTime, true);
        }
    } // End runCycle

    logCycleEnd(startTime, hadError = false) {
        const duration = Date.now() - startTime;
        logger.info(`===== [Engine] Cycle #${this.cycleCount} Finished (${duration}ms) ${hadError ? '[ERROR]' : ''} =====`);
    }

    async convertToUsd(amount, token) { return parseFloat(ethers.formatUnits(amount, token.decimals)); }
}

module.exports = { ArbitrageEngine };
