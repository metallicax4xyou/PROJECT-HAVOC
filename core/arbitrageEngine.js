// core/arbitrageEngine.js
const { EventEmitter } = require('events');
const { ethers } = require('ethers');
const PoolScanner = require('./poolScanner');
const ProfitCalculator = require('./profitCalculator');
const SpatialFinder = require('./finders/spatialFinder');
const SwapSimulator = require('./swapSimulator');
const GasEstimator = require('../utils/gasEstimator'); // *** IMPORT GasEstimator ***
const logger = require('../utils/logger');
const { ArbitrageError } = require('../utils/errorHandler');

class ArbitrageEngine extends EventEmitter {
    // Constructor accepts config, provider, swapSimulator, gasEstimator
    constructor(config, provider, swapSimulator, gasEstimator) { // Added gasEstimator
        super();
        logger.info('Initializing ArbitrageEngine components...');

        // --- Validate Inputs ---
        if (!config) throw new ArbitrageError('InitializationError', 'AE: Missing config.');
        if (!provider) throw new ArbitrageError('InitializationError', 'AE: Missing provider.');
        if (!swapSimulator || typeof swapSimulator.simulateSwap !== 'function') throw new ArbitrageError('InitializationError', 'AE: Invalid SwapSimulator.');
        if (!gasEstimator || typeof gasEstimator.estimateTxGasCost !== 'function') throw new ArbitrageError('InitializationError', 'AE: Invalid GasEstimator.'); // Validate GasEstimator
        if (!config.provider) { config.provider = provider; }

        this.config = config;
        this.provider = provider;
        this.swapSimulator = swapSimulator;
        this.gasEstimator = gasEstimator; // *** Store gasEstimator ***

        this.isRunning = false; this.cycleInterval = null; this.isCycleRunning = false;

        // Initialize core components
        try {
            this.poolScanner = new PoolScanner(config);
            // *** Pass gasEstimator to ProfitCalculator ***
            this.profitCalculator = new ProfitCalculator(this.config, this.provider, this.swapSimulator, this.gasEstimator);
            this.spatialFinder = new SpatialFinder(config);
        } catch (error) {
            logger.error(`[AE] CRITICAL ERROR during component initialization: ${error.message}`, error);
            throw new ArbitrageError('InitializationError', `Failed to initialize core components: ${error.message}`, error);
        }

        // --- Logging ---
        const poolConfigs = this.config.POOL_CONFIGS || []; logger.debug(`[AE] Loaded ${poolConfigs.length} pools.`);
        // ... (keep snippet logging if desired) ...

        logger.info('ArbitrageEngine initialized successfully');
    }

    // --- start(), stop() unchanged ---
    async start() { /* ... */ } stop() { /* ... */ }

    // --- runCycle() - Mark calculate call as async ---
    async runCycle() {
        if (!this.isRunning) { logger.info('Engine stopped.'); return; } if (this.isCycleRunning) { logger.warn('Prev cycle running.'); return; } this.isCycleRunning = true;
        logger.info('Starting new arbitrage cycle...'); const cycleStartTime = Date.now();
        try {
            logger.info('Fetching pool states...'); if (!this.poolScanner) throw new Error("PoolScanner missing.");
            const { poolStates, pairRegistry } = await this.poolScanner.fetchPoolStates(); logger.info(`Fetched ${poolStates.length} pool states.`);
            if (this.spatialFinder && pairRegistry) { this.spatialFinder.updatePairRegistry(pairRegistry); logger.debug("[AE] Updated SpatialFinder registry."); }
            let spatialOpportunities = [];
            if (this.spatialFinder && poolStates.length > 0) { logger.info('Finding spatial opportunities...'); spatialOpportunities = this.spatialFinder.findArbitrage(poolStates); logger.info(`Found ${spatialOpportunities.length} potential spatial opportunities.`); }
            const triangularOpportunities = []; const allOpportunities = [...spatialOpportunities, ...triangularOpportunities];
            let profitableTrades = [];
            if (allOpportunities.length > 0 && this.profitCalculator) {
                logger.info(`Calculating profitability for ${allOpportunities.length} opportunities...`);
                // *** Use await as calculate is now async ***
                profitableTrades = await this.profitCalculator.calculate(allOpportunities);
                logger.info(`Found ${profitableTrades.length} profitable trades (after gas/threshold).`);
                if (profitableTrades.length > 0) {
                     profitableTrades.forEach((trade, index) => {
                         // Enhanced Logging
                         const pathDesc = trade.path?.map(p => `${p.dex}(${p.pairSymbols?.join('/') || '?'})`).join('->') || 'N/A';
                         const profitEth = ethers.formatEther(trade.netProfitNativeWei || '0');
                         const gasEth = ethers.formatEther(trade.gasCostNativeWei || '0');
                         logger.info(`✅ Profitable Trade [${index + 1}]: ${trade.type} | ${pathDesc} | In: ${ethers.formatUnits(trade.amountIn, TOKENS[trade.tokenIn]?.decimals || 18)} ${trade.tokenIn} | Out: ${ethers.formatUnits(trade.amountOut, TOKENS[trade.tokenOut]?.decimals || 18)} ${trade.tokenOut} | NET Profit: ~${profitEth} ${this.nativeSymbol} (Gas ~${gasEth} ${this.nativeSymbol})`);
                     });
                     this.emit('profitableOpportunities', profitableTrades);
                }
            } else if (allOpportunities.length === 0) { logger.info('No potential opportunities found.'); }
            else if (!this.profitCalculator) { logger.warn('[AE] ProfitCalculator missing.'); }
        } catch (error) { logger.error('Error during arbitrage cycle:', error); }
        finally { const cycleEndTime = Date.now(); logger.info(`Arbitrage cycle finished. Duration: ${cycleEndTime - cycleStartTime}ms`); this.isCycleRunning = false; }
    }
}
module.exports = ArbitrageEngine;
