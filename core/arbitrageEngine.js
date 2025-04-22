// core/arbitrageEngine.js
const { EventEmitter } = require('events');
const { ethers } = require('ethers');
const PoolScanner = require('./poolScanner');
const ProfitCalculator = require('./profitCalculator');
const SpatialFinder = require('./finders/spatialFinder');
const SwapSimulator = require('./swapSimulator'); // Need type for validation if using TS
const logger = require('../utils/logger');
const { ArbitrageError } = require('../utils/errorHandler');

class ArbitrageEngine extends EventEmitter {
    // Constructor accepts config, provider, and swapSimulator
    constructor(config, provider, swapSimulator) { // Added swapSimulator
        super();
        logger.info('Initializing ArbitrageEngine components...');

        // --- Validate Inputs ---
        if (!config || typeof config !== 'object') { throw new ArbitrageError('InitializationError', 'ArbitrageEngine: Invalid config object.'); }
        if (!provider) { throw new ArbitrageError('InitializationError', 'ArbitrageEngine: Provider instance required.'); }
        if (!swapSimulator || typeof swapSimulator.simulateSwap !== 'function') { // Check simulator validity
            throw new ArbitrageError('InitializationError', 'ArbitrageEngine: Valid SwapSimulator instance required.');
        }
        if (!config.provider) { config.provider = provider; } // Ensure provider is in config

        this.config = config;
        this.provider = provider;
        this.swapSimulator = swapSimulator; // Store the simulator instance

        this.isRunning = false;
        this.cycleInterval = null;
        this.isCycleRunning = false;

        // Initialize core components
        try {
            this.poolScanner = new PoolScanner(config);

            // --- Pass swapSimulator to ProfitCalculator ---
            this.profitCalculator = new ProfitCalculator(this.config, this.provider, this.swapSimulator); // Pass simulator
            // --- ---

            this.spatialFinder = new SpatialFinder(config);

        } catch (error) {
            logger.error(`[ArbitrageEngine] CRITICAL ERROR during component initialization: ${error.message}`, error);
            throw new ArbitrageError('InitializationError', `Failed to initialize core components: ${error.message}`, error);
        }

        // --- Keep debug logging for pool configs ---
        const poolConfigs = this.config.POOL_CONFIGS || [];
        const totalPools = poolConfigs.length;
        logger.debug(`[ArbitrageEngine] Loaded ${totalPools} pools. Checking sample dexTypes...`);
        poolConfigs.slice(0, Math.min(5, totalPools)).forEach((pool, i) => { /* ... unchanged logging ... */
             const pairStr = `${pool.pair?.[0]?.symbol || '?'}/${pool.pair?.[1]?.symbol || '?'}`;
             logger.debug(`[ArbitrageEngine] Pool Config [${i}]: Pair=${pairStr}, dexType='${pool.dexType}' (Addr: ${pool.address})`);
        });
         if (totalPools > 5) { /* ... unchanged logging ... */
             logger.debug('[ArbitrageEngine] Checking last 5 pools...');
             poolConfigs.slice(Math.max(0, totalPools - 5)).forEach((pool, i) => {
                 const originalIndex = Math.max(0, totalPools - 5) + i;
                 const pairStr = `${pool.pair?.[0]?.symbol || '?'}/${pool.pair?.[1]?.symbol || '?'}`;
                 logger.debug(`[ArbitrageEngine] Pool Config [${originalIndex}]: Pair=${pairStr}, dexType='${pool.dexType}' (Addr: ${pool.address})`);
             });
         }

        logger.info('ArbitrageEngine initialized successfully');
    }

    // --- start(), stop(), runCycle() methods remain unchanged ---
    async start() { /* ... unchanged ... */
        if (this.isRunning) { logger.warn('Engine already running.'); return; }
        this.isRunning = true; logger.info('Starting Arbitrage Engine...');
        try { await this.runCycle(); } catch(error) { logger.error('[ArbitrageEngine] Error during initial runCycle:', error); this.stop(); return; }
        if (this.isRunning) { this.cycleInterval = setInterval(() => this.runCycle(), this.config.CYCLE_INTERVAL_MS); logger.info(`Engine started. Cycle interval: ${this.config.CYCLE_INTERVAL_MS}ms`); }
    }
    stop() { /* ... unchanged ... */
        if (!this.isRunning && !this.cycleInterval) { logger.warn('Engine already stopped.'); return; }
        logger.info('Stopping Arbitrage Engine...'); this.isRunning = false; if (this.cycleInterval) { clearInterval(this.cycleInterval); this.cycleInterval = null; } this.isCycleRunning = false; logger.info('Arbitrage Engine stopped.');
    }
    async runCycle() { /* ... unchanged ... */
        if (!this.isRunning) { logger.info('Engine stopped, skipping cycle.'); return; } if (this.isCycleRunning) { logger.warn('Previous cycle running, skipping.'); return; } this.isCycleRunning = true;
        logger.info('Starting new arbitrage cycle...'); const cycleStartTime = Date.now();
        try {
            logger.info('Fetching pool states...'); if (!this.poolScanner) throw new Error("PoolScanner missing.");
            const { poolStates, pairRegistry } = await this.poolScanner.fetchPoolStates(); logger.info(`Fetched ${poolStates.length} pool states.`); logger.debug(`Pair Registry size: ${pairRegistry?.size || 'N/A'}`);
            if (poolStates.length === 0 && Object.keys(this.poolScanner.fetchers || {}).length > 0) { logger.warn("No pool states fetched, check RPC/Pool errors."); }
            else if (poolStates.length === 0) { logger.warn("No pool states fetched AND no fetchers initialized."); }
            if (this.spatialFinder && pairRegistry) { this.spatialFinder.updatePairRegistry(pairRegistry); logger.debug("[ArbitrageEngine] Updated SpatialFinder registry."); }
            let spatialOpportunities = [];
            if (this.spatialFinder && poolStates.length > 0) { logger.info('Finding spatial opportunities...'); spatialOpportunities = this.spatialFinder.findArbitrage(poolStates); logger.info(`Found ${spatialOpportunities.length} potential spatial opportunities.`); }
            const triangularOpportunities = []; const allOpportunities = [...spatialOpportunities, ...triangularOpportunities];
            let profitableTrades = [];
            if (allOpportunities.length > 0 && this.profitCalculator) {
                logger.info(`Calculating profitability for ${allOpportunities.length} opportunities...`);
                // *** ProfitCalculator.calculate might become async ***
                profitableTrades = await this.profitCalculator.calculate(allOpportunities); // Use await if calculate becomes async
                logger.info(`Found ${profitableTrades.length} profitable trades.`);
                if (profitableTrades.length > 0) { /* ... unchanged logging & emit ... */
                     profitableTrades.forEach((trade, index) => {
                         const pathDesc = trade.path?.map(p => { const pairStr = `${p.pair?.[0] || '?'}/${p.pair?.[1] || '?'}`; return `${p.dex}(${pairStr})`; }).join('->') || 'N/A';
                         const profitPerc = trade.profitPercentage?.toFixed(4) || 'N/A';
                         logger.info(`Profitable Trade [${index + 1}]: Type: ${trade.type}, Path: ${pathDesc}, In: ${trade.amountIn} ${trade.tokenIn}, Out: ${trade.amountOut} ${trade.tokenOut}, Profit: ${trade.profitAmount} ${trade.tokenIn} (${profitPerc}%)`);
                     });
                     this.emit('profitableOpportunities', profitableTrades);
                }
            } else if (allOpportunities.length === 0) { logger.info('No potential opportunities found.'); }
            else if (!this.profitCalculator) { logger.warn('[ArbitrageEngine] ProfitCalculator missing.'); }
        } catch (error) { logger.error('Error during arbitrage cycle:', error); }
        finally { const cycleEndTime = Date.now(); logger.info(`Arbitrage cycle finished. Duration: ${cycleEndTime - cycleStartTime}ms`); this.isCycleRunning = false; }
    }
}
module.exports = ArbitrageEngine;
