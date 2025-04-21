// core/arbitrageEngine.js
const { EventEmitter } = require('events');
const PoolScanner = require('./poolScanner');
const ProfitCalculator = require('./profitCalculator');
const SpatialFinder = require('./finders/spatialFinder'); // Adjusted path based on tree
const logger = require('../utils/logger');

class ArbitrageEngine extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.isRunning = false;
    this.cycleInterval = null;
    this.isCycleRunning = false; // Cycle lock flag

    logger.info('Initializing ArbitrageEngine components...');

    // Initialize core components
    try {
      this.poolScanner = new PoolScanner(config);
      this.profitCalculator = new ProfitCalculator(config);
      this.spatialFinder = new SpatialFinder(config); // Uses pairRegistry from PoolScanner
    } catch (error) {
      logger.error(`[ArbitrageEngine] CRITICAL ERROR during component initialization: ${error.message}`, error);
      // Consider throwing the error or exiting if core components fail
      throw new Error(`Failed to initialize core components: ${error.message}`);
    }


    // --- DEBUG LOGGING START ---
    const poolConfigs = this.config.POOL_CONFIGS || [];
    const totalPools = poolConfigs.length;
    logger.debug(`[ArbitrageEngine] Loaded ${totalPools} pools from config. Checking sample dexTypes...`);

    if (totalPools === 0) {
        logger.warn('[ArbitrageEngine] POOL_CONFIGS array is empty or undefined in the loaded config!');
    } else {
        // Log first 5 pools (or fewer if less than 5)
        poolConfigs.slice(0, Math.min(5, totalPools)).forEach((pool, i) => {
            if (pool && pool.pair && pool.pair.join && pool.dexType) {
                 logger.debug(`[ArbitrageEngine] Pool Config [${i}]: Pair=${pool.pair.join('/')}, dexType='${pool.dexType}' (Address: ${pool.address})`);
            } else {
                 logger.warn(`[ArbitrageEngine] Pool Config [${i}] is malformed or missing required fields: ${JSON.stringify(pool)}`);
            }
        });

        // Log last 5 pools (if total > 5)
        if (totalPools > 5) {
          logger.debug('[ArbitrageEngine] Checking last 5 pools...');
          poolConfigs.slice(Math.max(0, totalPools - 5)).forEach((pool, i) => {
            const originalIndex = Math.max(0, totalPools - 5) + i;
             if (pool && pool.pair && pool.pair.join && pool.dexType) {
                logger.debug(`[ArbitrageEngine] Pool Config [${originalIndex}]: Pair=${pool.pair.join('/')}, dexType='${pool.dexType}' (Address: ${pool.address})`);
             } else {
                logger.warn(`[ArbitrageEngine] Pool Config [${originalIndex}] is malformed or missing required fields: ${JSON.stringify(pool)}`);
             }
          });
        }
    }
    // --- DEBUG LOGGING END ---

    logger.info('ArbitrageEngine initialized successfully');
  }

  async start() {
    if (this.isRunning) {
      logger.warn('Engine already running.');
      return;
    }
    this.isRunning = true;
    logger.info('Starting Arbitrage Engine...');
    // Initial cycle run immediately
    try {
        await this.runCycle();
    } catch(error) {
        logger.error('[ArbitrageEngine] Error during initial runCycle:', error);
        // Decide if we should still start interval or stop
        this.stop();
        return;
    }
    // Then set interval only if initial cycle didn't cause a stop
    if (this.isRunning) {
        this.cycleInterval = setInterval(() => this.runCycle(), this.config.CYCLE_INTERVAL_MS);
        logger.info(`Engine started. Cycle interval: ${this.config.CYCLE_INTERVAL_MS}ms`);
    }
  }

  stop() {
    if (!this.isRunning && !this.cycleInterval) { // Check if already stopped
      logger.warn('Engine already stopped or stopping.');
      return;
    }
    logger.info('Stopping Arbitrage Engine...');
    this.isRunning = false;
    if (this.cycleInterval) {
      clearInterval(this.cycleInterval);
      this.cycleInterval = null;
    }
     // Ensure any ongoing cycle is aware it should stop early if possible
     this.isCycleRunning = false; // Reset cycle lock on stop
    logger.info('Arbitrage Engine stopped.');
  }

  async runCycle() {
    // Check if the engine is meant to be running
     if (!this.isRunning) {
        logger.info('Engine is stopped, skipping cycle.');
        this.isCycleRunning = false; // Ensure lock is released if stop happened mid-cycle check
        return;
     }

    if (this.isCycleRunning) {
        logger.warn('Previous cycle still running, skipping this interval.');
        return;
    }
    this.isCycleRunning = true; // Set lock

    logger.info('Starting new arbitrage cycle...');
    const cycleStartTime = Date.now();

    try {
      // 1. Fetch pool states
      logger.info('Fetching pool states...');
      // Ensure poolScanner exists before calling methods
      if (!this.poolScanner) {
          throw new Error("PoolScanner is not initialized.");
      }
      const { poolStates, pairRegistry } = await this.poolScanner.fetchPoolStates();
      logger.info(`Fetched ${poolStates.length} pool states.`);
      logger.debug(`Pair Registry size after fetch: ${pairRegistry ? pairRegistry.size : 'N/A'}`);


      if (poolStates.length === 0) {
        logger.warn("No pool states fetched in this cycle. Ensure pools are configured and fetchers are working.");
        // Don't skip the rest of the cycle entirely, maybe spatialFinder needs registry update?
        // But opportunity finding will yield nothing.
      }

      // Update SpatialFinder's registry only if pairRegistry is valid
      if (this.spatialFinder && pairRegistry) {
          this.spatialFinder.updatePairRegistry(pairRegistry);
          logger.debug("[ArbitrageEngine] Updated SpatialFinder pair registry.");
      } else if (!this.spatialFinder) {
           logger.warn("[ArbitrageEngine] SpatialFinder not initialized, cannot update registry.");
      }

      // 2. Find Spatial Arbitrage Opportunities
      let spatialOpportunities = [];
      if (this.spatialFinder && poolStates.length > 0) {
          logger.info('Finding spatial arbitrage opportunities...');
          spatialOpportunities = this.spatialFinder.findArbitrage(poolStates);
          logger.info(`Found ${spatialOpportunities.length} potential spatial opportunities.`);
      } else if (!this.spatialFinder) {
          logger.warn("[ArbitrageEngine] SpatialFinder not initialized, skipping spatial search.");
      } else {
          logger.info("No pool states available, skipping spatial search.");
      }

      // 3. Find Triangular Arbitrage Opportunities (Placeholder)
      // logger.info('Finding triangular arbitrage opportunities...');
      const triangularOpportunities = []; // Placeholder for future implementation
      // logger.info(`Found ${triangularOpportunities.length} potential triangular opportunities.`);

      // Combine opportunities
      const allOpportunities = [...spatialOpportunities, ...triangularOpportunities];

      // 4. Calculate Profitability
      let profitableTrades = [];
      if (allOpportunities.length > 0 && this.profitCalculator) {
        logger.info(`Calculating profitability for ${allOpportunities.length} opportunities...`);
        profitableTrades = this.profitCalculator.calculate(allOpportunities);
        logger.info(`Found ${profitableTrades.length} profitable trades.`);

        if (profitableTrades.length > 0) {
            // Log details of profitable trades
            profitableTrades.forEach((trade, index) => {
                logger.info(`Profitable Trade [${index + 1}]:`);
                logger.info(`  Type: ${trade.type}`);
                // Ensure path exists and has elements before mapping
                 const pathDesc = trade.path && Array.isArray(trade.path) && trade.path.length > 0
                    ? trade.path.map(p => `${p.dex} (${p.pair ? p.pair.join('/') : 'N/A'})`).join(' -> ')
                    : 'N/A';
                logger.info(`  Path: ${pathDesc}`);
                logger.info(`  Amount In: ${trade.amountIn} ${trade.tokenIn}`);
                logger.info(`  Amount Out: ${trade.amountOut} ${trade.tokenOut}`);
                logger.info(`  Profit (${trade.tokenIn}): ${trade.profitAmount}`);
                logger.info(`  Profit (%): ${trade.profitPercentage.toFixed(4)}%`);
                logger.info(`  Timestamp: ${new Date(trade.timestamp).toISOString()}`);
            });
            // Emit event or send to execution module
            this.emit('profitableOpportunities', profitableTrades);
        }

      } else if (allOpportunities.length === 0) {
        logger.info('No potential opportunities found in this cycle.');
      } else if (!this.profitCalculator) {
         logger.warn('[ArbitrageEngine] ProfitCalculator not initialized, cannot calculate profits.');
      }

    } catch (error) {
      logger.error('Error during arbitrage cycle:', error);
      // Optional: Implement more robust error handling, maybe stop the engine
      // if certain errors persist. Consider adding specific error checks.
      // Example: if (error.message.includes("NETWORK_ERROR")) { handle differently }
      // this.stop(); // Consider stopping only on critical/unrecoverable errors
    } finally {
        const cycleEndTime = Date.now();
        logger.info(`Arbitrage cycle finished. Duration: ${cycleEndTime - cycleStartTime}ms`);
        this.isCycleRunning = false; // Release lock *always* in finally block
    }
  }
}

module.exports = ArbitrageEngine;