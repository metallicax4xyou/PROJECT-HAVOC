// core/arbitrageEngine.js
const { EventEmitter } = require('events');
const { ethers } = require('ethers'); // Keep ethers if needed
const PoolScanner = require('./poolScanner');
const ProfitCalculator = require('./profitCalculator'); // Keep this require
const SpatialFinder = require('./finders/spatialFinder'); // Adjust path if needed
const logger = require('../utils/logger');
const { ArbitrageError } = require('../utils/errorHandler'); // Adjust path if needed

class ArbitrageEngine extends EventEmitter {
    // Constructor accepts config (expected to contain provider) and provider separately
    constructor(config, provider) { // Added provider back as separate arg for clarity
        super();
        logger.info('Initializing ArbitrageEngine components...');

        // --- Validate Inputs ---
        if (!config || typeof config !== 'object') { throw new ArbitrageError('InitializationError', 'ArbitrageEngine: Invalid config object.'); }
        if (!provider) { throw new ArbitrageError('InitializationError', 'ArbitrageEngine: Provider instance required.'); }
        // Check if provider is ALSO inside config (as required by ProfitCalculator)
        if (!config.provider) {
             logger.warn('[ArbitrageEngine] Provider instance was not found *inside* the config object. Augmenting config object now.');
             config.provider = provider; // Ensure provider is in config for ProfitCalculator
        } else if (config.provider !== provider) {
             logger.warn('[ArbitrageEngine] Provider passed separately differs from provider found inside config object. Using the one passed separately for engine context.');
        }

        this.config = config; // Store the (potentially augmented) config
        this.provider = provider; // Store provider for potential direct use by engine

        this.isRunning = false;
        this.cycleInterval = null;
        this.isCycleRunning = false;

        // Initialize core components
        try {
            this.poolScanner = new PoolScanner(config);

            // --- ProfitCalculator uses the config object (which MUST contain provider) ---
            this.profitCalculator = new ProfitCalculator(this.config);
            // --- ---

            this.spatialFinder = new SpatialFinder(config);

        } catch (error) {
            logger.error(`[ArbitrageEngine] CRITICAL ERROR during component initialization: ${error.message}`, error);
            throw new ArbitrageError('InitializationError', `Failed to initialize core components: ${error.message}`, error);
        }

        // --- Keep debug logging for pool configs ---
        const poolConfigs = this.config.POOL_CONFIGS || [];
        const totalPools = poolConfigs.length;
        logger.debug(`[ArbitrageEngine] Loaded ${totalPools} pools from config. Checking sample dexTypes...`);
        poolConfigs.slice(0, Math.min(5, totalPools)).forEach((pool, i) => {
             logger.debug(`[ArbitrageEngine] Pool Config [${i}]: Pair=${pool.pair?.join('/') || 'N/A'}, dexType='${pool.dexType}' (Addr: ${pool.address})`);
         });
         if (totalPools > 5) { /* ... log last 5 ... */
             logger.debug('[ArbitrageEngine] Checking last 5 pools...');
             poolConfigs.slice(Math.max(0, totalPools - 5)).forEach((pool, i) => {
                 const originalIndex = Math.max(0, totalPools - 5) + i;
                 logger.debug(`[ArbitrageEngine] Pool Config [${originalIndex}]: Pair=${pool.pair?.join('/') || 'N/A'}, dexType='${pool.dexType}' (Addr: ${pool.address})`);
             });
         }
        // --- END DEBUG LOGGING ---

        logger.info('ArbitrageEngine initialized successfully');
    }

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
          } else if (poolStates.length === 0 && Object.keys(this.poolScanner.fetchers || {}).length === 0) {
              logger.warn("No pool states fetched AND no fetchers seem initialized. Check DEX enable flags.");
          }

          if (this.spatialFinder && pairRegistry) {
              this.spatialFinder.updatePairRegistry(pairRegistry);
              logger.debug("[ArbitrageEngine] Updated SpatialFinder pair registry.");
          } else if (!this.spatialFinder) {
              logger.warn("[ArbitrageEngine] SpatialFinder not initialized.");
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
            // Profit calculator might need async if it uses provider internally
            // For now, assuming calculate is synchronous based on its code structure shown
            // If calculate becomes async, add 'await' here.
            profitableTrades = this.profitCalculator.calculate(allOpportunities);
            logger.info(`Found ${profitableTrades.length} profitable trades.`);

            if (profitableTrades.length > 0) {
                profitableTrades.forEach((trade, index) => {
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
