// core/arbitrageEngine.js
const { EventEmitter } = require('events');
const { ethers } = require('ethers');
const PoolScanner = require('./poolScanner');
const ProfitCalculator = require('./profitCalculator'); // Keep this require
const SpatialFinder = require('./finders/spatialFinder');
const logger = require('../utils/logger');
const { ArbitrageError } = require('../utils/errorHandler');

class ArbitrageEngine extends EventEmitter {
    // Constructor still accepts config and provider separately
    constructor(config, provider) {
        super();
        logger.info('Initializing ArbitrageEngine components...');

        if (!config || typeof config !== 'object') { throw new ArbitrageError('InitializationError', 'ArbitrageEngine: Invalid config object.'); }
        // Provider is now expected *inside* config for ProfitCalculator, but engine might use it directly too
        if (!provider) { throw new ArbitrageError('InitializationError', 'ArbitrageEngine: Provider instance required.'); }
        if (!config.provider) { logger.warn('[ArbitrageEngine] Provider instance was not found *inside* the config object passed. This might cause issues if ProfitCalculator relies on it.')}

        this.config = config;
        this.provider = provider; // Store provider for potential direct use by engine

        this.isRunning = false;
        this.cycleInterval = null;
        this.isCycleRunning = false;

        try {
            this.poolScanner = new PoolScanner(config);

            // --- *** CORRECTED INSTANTIATION FOR PROFIT CALCULATOR *** ---
            // Pass only the config object, as ProfitCalculator expects 'provider' within it
            this.profitCalculator = new ProfitCalculator(this.config);
            // --- *** ---

            this.spatialFinder = new SpatialFinder(config);

        } catch (error) {
            logger.error(`[ArbitrageEngine] CRITICAL ERROR during component initialization: ${error.message}`, error);
            throw new ArbitrageError('InitializationError', `Failed to initialize core components: ${error.message}`, error);
        }

        // Keep debug logging for pool configs
        const poolConfigs = this.config.POOL_CONFIGS || [];
        const totalPools = poolConfigs.length;
        logger.debug(`[ArbitrageEngine] Loaded ${totalPools} pools. Checking sample dexTypes...`);
        poolConfigs.slice(0, Math.min(5, totalPools)).forEach((pool, i) => {
             logger.debug(`[ArbitrageEngine] Pool Config [${i}]: Pair=${pool.pair?.join('/') || 'N/A'}, dexType='${pool.dexType}' (Addr: ${pool.address})`);
         });
         // Log last 5 if needed

        logger.info('ArbitrageEngine initialized successfully');
    }

    // --- start(), stop(), runCycle() methods remain unchanged from the previous version ---
    async start() {
        if (this.isRunning) { logger.warn('Engine already running.'); return; }
        this.isRunning = true;
        logger.info('Starting Arbitrage Engine...');
        try { await this.runCycle(); }
        catch(error) { logger.error('[ArbitrageEngine] Error during initial runCycle:', error); this.stop(); return; }
        if (this.isRunning) {
            this.cycleInterval = setInterval(() => this.runCycle(), this.config.CYCLE_INTERVAL_MS);
            logger.info(`Engine started. Cycle interval: ${this.config.CYCLE_INTERVAL_MS}ms`);
        }
      }

      stop() {
        if (!this.isRunning && !this.cycleInterval) { logger.warn('Engine already stopped.'); return; }
        logger.info('Stopping Arbitrage Engine...');
        this.isRunning = false;
        if (this.cycleInterval) { clearInterval(this.cycleInterval); this.cycleInterval = null; }
        this.isCycleRunning = false;
        logger.info('Arbitrage Engine stopped.');
      }

    async runCycle() {
        if (!this.isRunning) { logger.info('Engine is stopped, skipping cycle.'); return; }
        if (this.isCycleRunning) { logger.warn('Previous cycle still running, skipping.'); return; }
        this.isCycleRunning = true;

        logger.info('Starting new arbitrage cycle...');
        const cycleStartTime = Date.now();

        try {
          logger.info('Fetching pool states...');
          if (!this.poolScanner) throw new Error("PoolScanner is not initialized.");
          const { poolStates, pairRegistry } = await this.poolScanner.fetchPoolStates();
          logger.info(`Fetched ${poolStates.length} pool states.`);
          logger.debug(`Pair Registry size after fetch: ${pairRegistry?.size || 'N/A'}`);

          if (poolStates.length === 0 && Object.keys(this.poolScanner.fetchers || {}).length > 0) {
               logger.warn("No pool states fetched, but fetchers ARE initialized. Check RPC/Network or pool errors.");
          } else if (poolStates.length === 0) {
              logger.warn("No pool states fetched AND no fetchers seem initialized. Check DEX enable flags.");
          }

          if (this.spatialFinder && pairRegistry) {
              this.spatialFinder.updatePairRegistry(pairRegistry);
              logger.debug("[ArbitrageEngine] Updated SpatialFinder pair registry.");
          }

          let spatialOpportunities = [];
          if (this.spatialFinder && poolStates.length > 0) {
              logger.info('Finding spatial arbitrage opportunities...');
              spatialOpportunities = this.spatialFinder.findArbitrage(poolStates);
              logger.info(`Found ${spatialOpportunities.length} potential spatial opportunities.`);
          }

          const triangularOpportunities = []; // Placeholder

          const allOpportunities = [...spatialOpportunities, ...triangularOpportunities];

          let profitableTrades = [];
          if (allOpportunities.length > 0 && this.profitCalculator) {
            logger.info(`Calculating profitability for ${allOpportunities.length} opportunities...`);
            // Use the instance method - calculate() might be async if it uses provider
            // Adjust if calculate becomes async
            profitableTrades = this.profitCalculator.calculate(allOpportunities);
            logger.info(`Found ${profitableTrades.length} profitable trades.`);

            if (profitableTrades.length > 0) {
                profitableTrades.forEach((trade, index) => {
                    // Use optional chaining for safer logging
                    const pathDesc = trade.path?.map(p => `${p.dex}(${p.pair?.join('/')})`).join('->') || 'N/A';
                    const profitPerc = trade.profitPercentage?.toFixed(4) || 'N/A';
                    logger.info(`Profitable Trade [${index + 1}]: Type: ${trade.type}, Path: ${pathDesc}, In: ${trade.amountIn} ${trade.tokenIn}, Out: ${trade.amountOut} ${trade.tokenOut}, Profit: ${trade.profitAmount} ${trade.tokenIn} (${profitPerc}%)`);
                });
                this.emit('profitableOpportunities', profitableTrades);
            }

          } else if (allOpportunities.length === 0) {
            logger.info('No potential opportunities found in this cycle.');
          } else if (!this.profitCalculator) {
             logger.warn('[ArbitrageEngine] ProfitCalculator not initialized.');
          }

        } catch (error) {
          logger.error('Error during arbitrage cycle:', error);
        } finally {
            const cycleEndTime = Date.now();
            logger.info(`Arbitrage cycle finished. Duration: ${cycleEndTime - cycleStartTime}ms`);
            this.isCycleRunning = false;
        }
      }
}

module.exports = ArbitrageEngine;
