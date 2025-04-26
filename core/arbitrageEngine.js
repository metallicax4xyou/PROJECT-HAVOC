// core/arbitrageEngine.js
// --- VERSION v1.4 --- Refactored runCycle

const { EventEmitter } = require('events');
const { ethers } = require('ethers');
const PoolScanner = require('./poolScanner');
const ProfitCalculator = require('./profitCalculator');
const SpatialFinder = require('./finders/spatialFinder');
// SwapSimulator and FlashSwapManager are injected but not directly used in *this* file's methods after refactor
// const SwapSimulator = require('./swapSimulator'); // Keep if needed for type hints/future use
// const FlashSwapManager = require('./flashSwapManager'); // Keep if needed for type hints/future use
const logger = require('../utils/logger');
const { ArbitrageError } = require('../utils/errorHandler');
const { TOKENS } = require('../constants/tokens'); // Needed for logging profits

class ArbitrageEngine extends EventEmitter {
    constructor(config, provider, swapSimulator, gasEstimator, flashSwapManager) {
        super();
        logger.info('[AE] Initializing ArbitrageEngine components...');
        // Validation... (remains unchanged)
        if (!config) throw new ArbitrageError('InitializationError', 'AE: Missing config.');
        if (!provider) throw new ArbitrageError('InitializationError', 'AE: Missing provider.');
        if (!swapSimulator?.simulateSwap) throw new ArbitrageError('InitializationError', 'AE: Invalid SwapSimulator.');
        if (!gasEstimator?.estimateTxGasCost) throw new ArbitrageError('InitializationError', 'AE: Invalid GasEstimator.');
        if (!flashSwapManager || typeof flashSwapManager.getSignerAddress !== 'function') {
             logger.error(`[AE Init] Invalid FlashSwapManager passed.`);
             throw new ArbitrageError('InitializationError', 'AE: Invalid FlashSwapManager instance required.');
        }
        if (!config.provider) { config.provider = provider; logger.warn('[AE Init] Provider added to config object inside AE.'); }

        this.config = config;
        this.provider = provider;
        // Store injected instances needed by helper methods
        this.flashSwapManager = flashSwapManager;
        this.profitCalculator = new ProfitCalculator(this.config, this.provider, swapSimulator, gasEstimator); // Pass simulator/estimator here

        this.isRunning = false; this.cycleInterval = null; this.isCycleRunning = false;
        this.nativeSymbol = this.config.NATIVE_CURRENCY_SYMBOL || 'ETH'; // Store for logging profit

        try {
            // Initialize components used within the cycle
            this.poolScanner = new PoolScanner(config);
            this.spatialFinder = new SpatialFinder(config);
            // Add other finders here if needed (e.g., this.triangularFinder = new TriangularFinder(config);)
        } catch (error) {
            logger.error(`[AE] CRITICAL ERROR during component init: ${error.message}`, error);
            throw new ArbitrageError('InitializationError', `Failed AE components: ${error.message}`, error);
        }
        logger.info('[AE v1.4] ArbitrageEngine components initialized successfully (runCycle refactored).');
    }

    async start() {
        // --- Body remains unchanged ---
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
                     // Decide if certain errors should stop the interval?
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
        // --- Body remains unchanged ---
        logger.info('[AE.stop] Stopping Arbitrage Engine...');
        if (!this.isRunning && !this.cycleInterval) { logger.warn('[AE.stop] Engine already stopped.'); return; }
        this.isRunning = false;
        if (this.cycleInterval) { clearInterval(this.cycleInterval); this.cycleInterval = null; logger.debug('[AE.stop] Cycle interval cleared.'); }
        this.isCycleRunning = false;
        logger.info('[AE.stop] Arbitrage Engine stopped.');
    }

    // --- Refactored Run Cycle ---
    async runCycle() {
        const cycleStartTime = Date.now();
        logger.info('[AE.runCycle] ===== Starting New Cycle =====');
        if (!this.isRunning) { logger.info('[AE.runCycle] Engine stopped.'); return; }
        if (this.isCycleRunning) { logger.warn('[AE.runCycle] Previous cycle still running. Skipping.'); return; }

        this.isCycleRunning = true;
        let cycleStatus = 'FAILED'; // Default status

        try {
            // Step 1: Fetch Pool Data
            const { poolStates, pairRegistry } = await this._fetchPoolData();

            // Step 2: Find Potential Opportunities
            const allOpportunities = this._findOpportunities(poolStates, pairRegistry);

            // Step 3: Calculate Profitability
            if (allOpportunities.length > 0) {
                const profitableTrades = await this._calculateProfitability(allOpportunities);

                // Step 4: Handle Profitable Trades (Emit Event)
                if (profitableTrades.length > 0) {
                    this._handleProfitableTrades(profitableTrades);
                }
            } else {
                 logger.info('[AE.runCycle] No potential opportunities found by finders.');
            }

            cycleStatus = 'COMPLETED'; // Mark as completed if no errors thrown

        } catch (error) {
            logger.error('[AE.runCycle] !!!!!!!! ERROR during cycle !!!!!!!!!!');
            logger.error(`[AE.runCycle] Error Type: ${error.constructor.name}, Msg: ${error.message}`);
            // Only log stack for unexpected errors, not ArbitrageErrors which are handled
            if (!(error instanceof ArbitrageError)) {
                logger.error('[AE.runCycle] Stack:', error.stack);
            }
            // Consider adding specific error handling if needed (e.g., stop engine on certain errors)
            cycleStatus = `FAILED (${error.type || error.constructor.name})`; // Add error type to status

        } finally {
            const cycleEndTime = Date.now();
            const duration = cycleEndTime - cycleStartTime;
            logger.info(`[AE.runCycle] ===== Cycle ${cycleStatus}. Duration: ${duration}ms =====`);
            this.isCycleRunning = false; // Ensure lock is released
        }
    }

    // --- Private Helper Methods ---

    /**
     * Fetches pool states using the PoolScanner.
     * @returns {Promise<{poolStates: Array<object>, pairRegistry: Map<string, Set<string>>}>}
     * @private
     */
    async _fetchPoolData() {
        logger.info('[AE._fetchPoolData] Fetching pool states...');
        if (!this.poolScanner) throw new ArbitrageError("PoolScanner missing.", 'INTERNAL_ERROR');
        const { poolStates, pairRegistry } = await this.poolScanner.fetchPoolStates();
        logger.info(`[AE._fetchPoolData] Fetched ${poolStates.length} pool states. Registry size: ${pairRegistry.size}`);
        return { poolStates, pairRegistry };
    }

    /**
     * Finds potential arbitrage opportunities using configured finders.
     * @param {Array<object>} poolStates - The fetched pool states.
     * @param {Map<string, Set<string>>} pairRegistry - The registry mapping pairs to pool addresses.
     * @returns {Array<object>} An array of potential opportunity objects.
     * @private
     */
    _findOpportunities(poolStates, pairRegistry) {
        logger.info('[AE._findOpportunities] Finding potential opportunities...');
        let allOpportunities = [];

        // Update finders with the latest registry
        if (this.spatialFinder && pairRegistry) {
            this.spatialFinder.updatePairRegistry(pairRegistry);
        }
        // if (this.triangularFinder && pairRegistry) { // Example for future
        //     this.triangularFinder.updatePairRegistry(pairRegistry);
        // }

        // Call spatial finder
        if (this.spatialFinder && poolStates.length > 0) {
             logger.info('[AE._findOpportunities] Running SpatialFinder...');
             const spatialOpportunities = this.spatialFinder.findArbitrage(poolStates);
             logger.info(`[AE._findOpportunities] SpatialFinder found ${spatialOpportunities.length} potentials.`);
             allOpportunities = allOpportunities.concat(spatialOpportunities);
        } else if (!this.spatialFinder) {
             logger.warn("[AE._findOpportunities] SpatialFinder missing.");
        }

        // Call other finders (e.g., triangular)
        // if (this.triangularFinder && poolStates.length > 0) {
        //     logger.info('[AE._findOpportunities] Running TriangularFinder...');
        //     const triangularOpportunities = this.triangularFinder.findArbitrage(poolStates); // Assuming similar interface
        //     logger.info(`[AE._findOpportunities] TriangularFinder found ${triangularOpportunities.length} potentials.`);
        //     allOpportunities = allOpportunities.concat(triangularOpportunities);
        // }

        logger.info(`[AE._findOpportunities] Total potential opportunities found: ${allOpportunities.length}`);
        return allOpportunities;
    }

    /**
     * Calculates the profitability of potential opportunities.
     * @param {Array<object>} opportunities - Potential opportunities from finders.
     * @returns {Promise<Array<object>>} An array of profitable tradeData objects.
     * @private
     */
    async _calculateProfitability(opportunities) {
        logger.info(`[AE._calculateProfitability] Calculating profitability for ${opportunities.length} opportunities...`);
        if (!this.profitCalculator) {
             logger.error("[AE._calculateProfitability] ProfitCalculator instance missing!");
             return [];
        }
        if (!this.flashSwapManager) {
             logger.error("[AE._calculateProfitability] FlashSwapManager instance missing!");
             return [];
        }

        let signerAddress = null;
        try {
             signerAddress = await this.flashSwapManager.getSignerAddress();
             if (!signerAddress || !ethers.isAddress(signerAddress)) {
                 throw new Error(`Invalid signer address returned: ${signerAddress}`);
             }
             logger.debug(`[AE._calculateProfitability] Using signer address for gas estimation: ${signerAddress}`);
         } catch (addrError) {
              logger.error(`[AE._calculateProfitability] CRITICAL: Could not get signer address: ${addrError.message}`);
              throw new ArbitrageError(`Failed to retrieve signer address: ${addrError.message}`, 'INTERNAL_ERROR', addrError);
         }

        // Pass opportunities and signer address to the calculator's main method
        const profitableTrades = await this.profitCalculator.calculate(opportunities, signerAddress);
        logger.info(`[AE._calculateProfitability] Found ${profitableTrades.length} profitable trades (after gas/threshold).`);
        return profitableTrades;
    }

    /**
     * Handles profitable trades by logging details and emitting an event.
     * @param {Array<object>} profitableTrades - Array of final tradeData objects.
     * @private
     */
    _handleProfitableTrades(profitableTrades) {
        logger.info(`[AE._handleProfitableTrades] --- ✅ Profitable Trades Found (${profitableTrades.length}) ---`);
        profitableTrades.forEach((trade, index) => {
            // Use helper to format trade details for logging
            this._logTradeDetails(trade, index + 1);
        });
        this.emit('profitableOpportunities', profitableTrades); // Emit event for tradeHandler
        logger.info(`[AE._handleProfitableTrades] --- Emitted 'profitableOpportunities' event ---`);
    }

     /**
     * Helper method to log details of a single profitable trade.
     * @param {object} trade - The profitable tradeData object.
     * @param {number} index - The index of the trade for logging.
     * @private
     */
     _logTradeDetails(trade, index) {
         try {
              // Safely construct path description
              const pathDesc = trade.path?.map(p => {
                  const symbols = p.poolState?.token0Symbol && p.poolState?.token1Symbol
                       ? `${p.poolState.token0Symbol}/${p.poolState.token1Symbol}`
                       : '?/?';
                  return `${p.dex || '?'}(${symbols})`;
              }).join('->') || 'N/A';

             const formatEth = (weiStr) => {
                  if (!weiStr) return 'N/A';
                  try { return ethers.formatEther(BigInt(weiStr)); } catch { return 'Error'; }
              };
             // Function to format token amounts using decimals from trade object if possible
             const formatUnits = (amountStr, tokenSymbol) => {
                  if (!amountStr || !tokenSymbol) return 'N/A';
                  try {
                      // Find token decimals - requires trade object to have tokenIn/tokenOut objects or look up from config
                      const token = this.config.TOKENS[tokenSymbol]; // Assume lookup works
                      const decimals = token?.decimals || 18; // Default to 18 if lookup fails
                      return ethers.formatUnits(BigInt(amountStr), decimals);
                  } catch { return 'Error'; }
              };

             const profitEth = formatEth(trade.netProfitNativeWei);
             const gasEth = formatEth(trade.gasCostNativeWei);
             const thresholdEth = formatEth(trade.thresholdNativeWei);

             logger.info(`  [${index}] ${trade.type} | ${pathDesc}`);
             logger.info(`      In: ${formatUnits(trade.amountIn, trade.tokenIn?.symbol)} ${trade.tokenIn?.symbol} | Sim Out: ${formatUnits(trade.amountOut, trade.tokenOut?.symbol)} ${trade.tokenOut?.symbol}`);
             logger.info(`      NET Profit: ~${profitEth} ${this.nativeSymbol} (Gas Cost ~${gasEth} ${this.nativeSymbol})`);
             logger.info(`      Threshold Used (Native): ${thresholdEth} ${this.nativeSymbol}`);
             if (trade.profitPercentage) {
                   logger.info(`      Profit Percentage: ~${trade.profitPercentage.toFixed(4)}%`);
             }
         } catch (logError) {
              logger.error(`[AE._logTradeDetails] Error logging trade details for index ${index}: ${logError.message}`);
              // Log raw trade object in case of formatting errors
              try { logger.debug("Raw trade object:", JSON.stringify(trade, null, 2)); } catch { logger.debug("Raw trade object: (Cannot stringify)");}
         }
     }

} // End ArbitrageEngine class

module.exports = ArbitrageEngine;
