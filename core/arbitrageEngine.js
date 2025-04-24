// core/arbitrageEngine.js
// --- VERSION v1.3.1 ---
// Fetches and passes signerAddress to profitCalculator.calculate. Enhanced Logging.

const { EventEmitter } = require('events');
const { ethers } = require('ethers');
const PoolScanner = require('./poolScanner');
const ProfitCalculator = require('./profitCalculator');
const SpatialFinder = require('./finders/spatialFinder');
const SwapSimulator = require('./swapSimulator');
const GasEstimator = require('../utils/gasEstimator');
const FlashSwapManager = require('./flashSwapManager'); // Keep for type validation if needed
const logger = require('../utils/logger');
const { ArbitrageError } = require('../utils/errorHandler');
const { TOKENS } = require('../constants/tokens'); // Needed for logging

class ArbitrageEngine extends EventEmitter {
    // *** ADD flashSwapManager to constructor args ***
    constructor(config, provider, swapSimulator, gasEstimator, flashSwapManager) {
        super();
        logger.info('[AE] Initializing ArbitrageEngine components...');
        // *** VALIDATE dependencies ***
        if (!config) throw new ArbitrageError('InitializationError', 'AE: Missing config.');
        if (!provider) throw new ArbitrageError('InitializationError', 'AE: Missing provider.');
        if (!swapSimulator?.simulateSwap) throw new ArbitrageError('InitializationError', 'AE: Invalid SwapSimulator.');
        if (!gasEstimator?.estimateTxGasCost) throw new ArbitrageError('InitializationError', 'AE: Invalid GasEstimator.');
        if (!flashSwapManager || typeof flashSwapManager.getSignerAddress !== 'function') {
             // Check if the passed object is valid and has the method
             logger.error(`[AE Init] Invalid FlashSwapManager passed. Type: ${typeof flashSwapManager}, Has getSignerAddress: ${!!flashSwapManager?.getSignerAddress}`);
             throw new ArbitrageError('InitializationError', 'AE: Invalid FlashSwapManager instance required.');
        }
        if (!config.provider) { config.provider = provider; logger.warn('[AE Init] Provider added to config object inside AE.'); } // Ensure provider is in config

        this.config = config;
        this.provider = provider;
        this.swapSimulator = swapSimulator;
        this.gasEstimator = gasEstimator;
        this.flashSwapManager = flashSwapManager; // *** STORE flashSwapManager ***

        this.isRunning = false; this.cycleInterval = null; this.isCycleRunning = false;

        try {
            this.poolScanner = new PoolScanner(config);
            // *** Pass gasEstimator to ProfitCalculator ***
            this.profitCalculator = new ProfitCalculator(this.config, this.provider, this.swapSimulator, this.gasEstimator);
            this.spatialFinder = new SpatialFinder(config);
        } catch (error) {
            logger.error(`[AE] CRITICAL ERROR during component init: ${error.message}`, error);
            throw new ArbitrageError('InitializationError', `Failed AE components: ${error.message}`, error);
        }
        logger.info('[AE v1.3.1] ArbitrageEngine components initialized successfully');
    }

    async start() {
        logger.info('[AE.start] Attempting to start engine...');
        if (this.isRunning) { logger.warn('[AE.start] Engine already running.'); return; }
        this.isRunning = true;
        logger.info('[AE.start] Engine marked as running. Executing initial runCycle...');

        try {
             logger.debug('[AE.start] >>> Calling initial runCycle...');
            await this.runCycle();
             logger.debug('[AE.start] <<< Initial runCycle finished.');

        } catch(error) {
            logger.error('[AE.start] CRITICAL ERROR during initial runCycle execution:', error);
            logger.info('[AE.start] Stopping engine due to initial cycle failure.');
            this.stop(); return;
        }

        if (this.isRunning) {
            logger.debug('[AE.start] Setting up cycle interval...');
            this.cycleInterval = setInterval(() => {
                 this.runCycle().catch(intervalError => {
                     logger.error('[AE Interval Error] Error caught from runCycle:', intervalError);
                 });
            }, this.config.CYCLE_INTERVAL_MS);

            if (this.cycleInterval) {
                 logger.info(`[AE.start] Engine started successfully. Cycle interval: ${this.config.CYCLE_INTERVAL_MS}ms`);
            } else {
                 logger.error('[AE.start] Failed to set cycle interval!'); this.stop();
            }
        } else { logger.warn('[AE.start] Engine stopped during initial runCycle.'); }
    }

    stop() {
        logger.info('[AE.stop] Stopping Arbitrage Engine...');
        if (!this.isRunning && !this.cycleInterval) { logger.warn('[AE.stop] Engine already stopped.'); return; }
        this.isRunning = false;
        if (this.cycleInterval) { clearInterval(this.cycleInterval); this.cycleInterval = null; logger.debug('[AE.stop] Cycle interval cleared.'); }
        this.isCycleRunning = false;
        logger.info('[AE.stop] Arbitrage Engine stopped.');
    }

    async runCycle() {
        logger.info('[AE.runCycle] Attempting cycle...'); if (!this.isRunning) { logger.info('[AE.runCycle] Engine stopped.'); return; } if (this.isCycleRunning) { logger.warn('[AE.runCycle] Previous cycle running.'); return; }
        this.isCycleRunning = true; logger.info('[AE.runCycle] ===== Starting New Cycle ====='); const cycleStartTime = Date.now(); let cycleStatus = 'FAILED';
        try {
            logger.debug('[AE.runCycle] --- START Try Block ---');
            logger.info('[AE.runCycle] Fetching pool states...'); if (!this.poolScanner) throw new Error("PoolScanner missing.");
            const { poolStates, pairRegistry } = await this.poolScanner.fetchPoolStates(); logger.info(`[AE.runCycle] Fetched ${poolStates.length} pool states.`);
            logger.debug('[AE.runCycle] Updating SpatialFinder registry...'); if (this.spatialFinder && pairRegistry) { this.spatialFinder.updatePairRegistry(pairRegistry); } else if (!this.spatialFinder) { logger.warn("[AE.runCycle] SpatialFinder missing."); }
            let spatialOpportunities = [];
            if (this.spatialFinder && poolStates.length > 0) { logger.info('[AE.runCycle] Finding spatial opportunities...'); spatialOpportunities = this.spatialFinder.findArbitrage(poolStates); logger.info(`[AE.runCycle] Found ${spatialOpportunities.length} potential opportunities.`); }
            const triangularOpportunities = []; const allOpportunities = [...spatialOpportunities, ...triangularOpportunities];
            let profitableTrades = [];
            if (allOpportunities.length > 0 && this.profitCalculator) {
                logger.info(`[AE.runCycle] Calculating profitability for ${allOpportunities.length} opportunities...`);

                // *** GET signerAddress BEFORE calling calculate ***
                let signerAddress = null;
                try {
                     if (!this.flashSwapManager?.getSignerAddress) throw new Error("FlashSwapManager or getSignerAddress method missing.");
                     signerAddress = await this.flashSwapManager.getSignerAddress();
                     if (!signerAddress || !ethers.isAddress(signerAddress)) {
                         throw new Error(`Invalid address returned: ${signerAddress}`);
                     }
                     logger.debug(`[AE.runCycle] Using signer address for gas estimation: ${signerAddress}`);
                 } catch (addrError) {
                      logger.error(`[AE.runCycle] CRITICAL: Could not get signer address: ${addrError.message}`);
                      throw new Error(`Failed to retrieve signer address: ${addrError.message}`); // Re-throw critical error
                 }

                // *** PASS signerAddress to calculate ***
                profitableTrades = await this.profitCalculator.calculate(allOpportunities, signerAddress);
                logger.info(`[AE.runCycle] Found ${profitableTrades.length} profitable trades (after gas/threshold).`);

                if (profitableTrades.length > 0) {
                     logger.info(`[AE.runCycle] --- ✅ Profitable Trades Found (${profitableTrades.length}) ---`);
                     profitableTrades.forEach((trade, index) => {
                         const pathDesc = trade.path?.map(p => `${p.dex}(${p.pairSymbols?.join('/') || '?'})`).join('->') || 'N/A';
                         const formatEth = (wei) => wei ? ethers.formatEther(wei) : 'N/A';
                         const formatUnits = (amount, symbol) => { const decimals = TOKENS[symbol]?.decimals || 18; return amount ? ethers.formatUnits(amount, decimals) : 'N/A'; };
                         const profitEth = formatEth(trade.netProfitNativeWei);
                         const gasEth = formatEth(trade.gasCostNativeWei);
                         logger.info(`  [${index + 1}] ${trade.type} | ${pathDesc}`);
                         logger.info(`      In: ${formatUnits(trade.amountIn, trade.tokenIn)} ${trade.tokenIn} | Sim Out: ${formatUnits(trade.amountOut, trade.tokenOut)} ${trade.tokenOut}`);
                         logger.info(`      NET Profit: ~${profitEth} ${this.nativeSymbol} (Gas Cost ~${gasEth} ${this.nativeSymbol})`);
                         logger.info(`      Threshold Used (Native): ${formatEth(trade.thresholdNativeWei)} ${this.nativeSymbol}`);
                     });
                     this.emit('profitableOpportunities', profitableTrades);
                     logger.info(`[AE.runCycle] --- Emitted profitableOpportunities event ---`);
                }

            } else if (allOpportunities.length === 0) { logger.info('[AE.runCycle] No potential opportunities found.'); }
            else if (!this.profitCalculator) { logger.warn('[AE.runCycle] ProfitCalculator missing.'); }
            cycleStatus = 'COMPLETED'; logger.debug('[AE.runCycle] --- END Try Block (Success) ---');
        } catch (error) { logger.error('[AE.runCycle] !!!!!!!! ERROR caught !!!!!!!!!!'); logger.error(`[AE.runCycle] Error Type: ${error.constructor.name}, Msg: ${error.message}`); logger.error('[AE.runCycle] Stack:', error.stack); }
        finally { const cycleEndTime = Date.now(); const duration = cycleEndTime - cycleStartTime; logger.info(`[AE.runCycle] ===== Cycle ${cycleStatus}. Duration: ${duration}ms =====`); this.isCycleRunning = false; }
    }
}
module.exports = ArbitrageEngine;
