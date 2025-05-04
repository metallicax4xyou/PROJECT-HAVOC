// core/arbitrageEngine.js
// --- VERSION v1.16 --- Added debug log for FlashSwap ABI retrieved from FlashSwapManager.

const { EventEmitter } = require('events');
const { ethers } = require('ethers');
const PoolScanner = require('./poolScanner');
const ProfitCalculator = require('./profitCalculator');
const SpatialFinder = require('./finders/spatialFinder');
const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler');
// Import the TradeHandler CLASS
const TradeHandler = require('./tradeHandler');

class ArbitrageEngine extends EventEmitter {
    /**
     * @param {object} config - Application configuration.
     * @param {ethers.Provider} provider - Ethers provider.
     * @param {SwapSimulator} swapSimulator - Instance of SwapSimulator.
     * @param {GasEstimator} GasEstimatorClass - The GasEstimator class constructor.
     * @param {FlashSwapManager} flashSwapManager - Instance of FlashSwapManager.
     * @param {TradeHandler} TradeHandlerClass - The TradeHandler class constructor.
     */
    constructor(config, provider, swapSimulator, GasEstimatorClass, flashSwapManager, TradeHandlerClass) {
        super();
        logger.info('[AE v1.16] Initializing ArbitrageEngine components...'); // Version bump
        // Validation...
        if (!config) throw new ArbitrageError('InitializationError', 'AE: Missing config.');
        if (!provider) throw new ArbitrageError('InitializationError', 'AE: Missing provider.');
        if (!swapSimulator?.simulateSwap) throw new ArbitrageError('InitializationError', 'AE: Invalid SwapSimulator.');
        if (!GasEstimatorClass || typeof GasEstimatorClass !== 'function' || !GasEstimatorClass.prototype || typeof GasEstimatorClass.prototype.estimateTxGasCost !== 'function') {
             throw new ArbitrageError('InitializationError', 'AE: Invalid GasEstimator Class constructor provided.');
        }
        if (!flashSwapManager || typeof flashSwapManager.initiateAaveFlashLoan !== 'function' || typeof flashSwapManager.getFlashSwapABI !== 'function') {
             throw new ArbitrageError('InitializationError', 'AE: Invalid FlashSwapManager instance required (Missing initiate methods or getFlashSwapABI).');
        }
        if (!TradeHandlerClass || typeof TradeHandlerClass !== 'function' || !TradeHandlerClass.prototype || typeof TradeHandlerClass.prototype.handleTrades !== 'function') {
             throw new ArbitrageError('InitializationError', 'AE: Invalid TradeHandler Class constructor provided.');
        }


        this.config = config;
        this.provider = provider;
        this.flashSwapManager = flashSwapManager;


        // Initialize child components
        this.poolScanner = new PoolScanner(config);
        this.spatialFinder = new SpatialFinder(config);
        // this.triangularV3Finder = new TriangularV3Finder(config);


        // --- GET ABI from FlashSwapManager and initialize GasEstimator ---
        const flashSwapABI = this.flashSwapManager.getFlashSwapABI();

        // --- ADD DEBUG LOG HERE ---
        logger.debug('[AE Init] FlashSwap ABI retrieved from FSM:', flashSwapABI ? 'Valid Array' : 'Null/Undefined', Array.isArray(flashSwapABI) ? `(Length: ${flashSwapABI.length})` : '');
        // --- END DEBUG LOG ---

        if (!flashSwapABI) { // Removed !Array.isArray(flashSwapABI) check here, let GasEstimator handle it
             const errorMsg = "Failed to get FlashSwap ABI from FlashSwapManager.";
             logger.error(`[AE Init] CRITICAL: ${errorMsg}`);
             throw new ArbitrageError('InitializationError', errorMsg);
        }
        // Initialize GasEstimator, passing config, provider, and the FlashSwap ABI
        this.gasEstimator = new GasEstimatorClass(config, provider, flashSwapABI); // Pass FlashSwap ABI


        // Initialize ProfitCalculator, passing required dependencies
        this.profitCalculator = new ProfitCalculator(config, provider, swapSimulator, this.gasEstimator, flashSwapManager); // Pass the initialized gasEstimator

        // Initialize TradeHandler INSTANCE
        this.tradeHandler = new TradeHandlerClass(config, provider, flashSwapManager, this.gasEstimator, logger); // Pass the initialized gasEstimator


        // State variables
        this.isRunning = false;
        this.cycleInterval = null;
        this.isCycleRunning = false;
        this.nativeSymbol = this.config.NATIVE_CURRENCY_SYMBOL || 'ETH';


        logger.info('[AE v1.16] ArbitrageEngine components initialized successfully.'); // Version bump
    }

    /**
     * Starts the main arbitrage cycle.
     */
    async start() {
        logger.info('[AE.start] Attempting to start engine...');
        if (this.isRunning) {
            logger.warn('[AE.start] Engine already running.');
            return;
        }
        this.isRunning = true;
        logger.info('[AE.start] Engine marked as running. Executing initial runCycle... (DEBUG log level for details)');


        // Initial run cycle
        try {
            logger.debug('[AE.start] >>> Calling initial runCycle... (v1.16)');
            await this.runCycle();
            logger.debug('[AE.start] <<< Initial runCycle finished.');
        } catch(error) {
            logger.error('[AE.start] !!!!!!!! CRITICAL ERROR during initial runCycle execution !!!!!!!!');
            handleError(error, 'ArbitrageEngine.initialRunCycle');
            logger.info('[AE.start] Stopping engine due to initial cycle failure.');
            this.stop();
            // Optionally re-throw if you want the main bot.js script to catch it
            // throw error;
        }


        // Schedule subsequent cycles only if engine is still running after the initial cycle
        if (this.isRunning) {
            logger.debug('[AE.start] Setting up cycle interval...');
            this.cycleInterval = setInterval(() => {
                // Wrap runCycle call in try/catch for interval errors
                this.runCycle().catch(intervalError => {
                    logger.error("[AE Interval Error] Uncaught error from runCycle in interval:", intervalError);
                    handleError(intervalError, 'ArbitrageEngine.runCycleInterval');
                    // Consider stopping the bot if persistent errors occur in the interval
                    // if (shouldStopOnIntervalError(intervalError)) { this.stop(); }
                });
            }, this.config.CYCLE_INTERVAL_MS);

            if (this.cycleInterval) {
                logger.info(`[AE.start] Engine started successfully. Cycle interval: ${this.config.CYCLE_INTERVAL_MS}ms`);
                 logger.info('\n>>> BOT IS RUNNING <<<\n======================\n(Press Ctrl+C to stop)');
            } else {
                 logger.error('[AE.start] Failed to set cycle interval!');
                 this.stop();
            }
        } else {
            logger.warn('[AE.start] Engine stopped during initial runCycle.');
        }
    }

    stop() {
        logger.info('[AE.stop] Stopping Arbitrage Engine...');
        if (!this.isRunning && !this.cycleInterval && !this.isCycleRunning) {
            logger.warn('[AE.stop] Engine already fully stopped.');
            return;
        }
        this.isRunning = false;
        if (this.cycleInterval) {
            clearInterval(this.cycleInterval);
            this.cycleInterval = null;
            logger.debug('[AE.stop] Cycle interval cleared.');
        }
        this.isCycleRunning = false;
        logger.info('[AE.stop] Arbitrage Engine stopped.');

         logger.info('\n>>> BOT STOPPED <<<\n');
         logger.info('======================');
    }

    async runCycle() {
        const cycleStartTime = Date.now();
        logger.debug('[AE.runCycle] ===== Starting New Cycle (v1.16) ====='); // Version bump in cycle log

        if (!this.isRunning) {
            logger.debug('[AE.runCycle] Engine is stopping. Skipping cycle execution.');
            this.isCycleRunning = false;
            return;
        }
         if (this.isCycleRunning) {
             logger.warn('[AE.runCycle] Previous cycle still running. Skipping this cycle.');
             return;
         }
        this.isCycleRunning = true;

        let cycleStatus = 'FAILED';
        try {
            // 1. Fetch latest pool data
            const { poolStates, pairRegistry } = await this._fetchPoolData();


            if (!poolStates || poolStates.length === 0) {
                logger.debug('[AE.runCycle] No pool states fetched in this cycle.');
                cycleStatus = 'COMPLETED (No Data)';
            } else {
                // 2. Find potential arbitrage opportunities
                const potentialOpportunities = this._findOpportunities(poolStates, pairRegistry);


                if (!potentialOpportunities || potentialOpportunities.length === 0) {
                     logger.debug(`[AE.runCycle] No potential opportunities found after finder execution.`);
                     cycleStatus = 'COMPLETED (No Potential Opps)';
                } else {
                    // 3. Calculate profitability and filter
                    const profitableOpportunities = await this._calculateProfitability(potentialOpportunities);

                    if (!profitableOpportunities || profitableOpportunities.length === 0) {
                         logger.debug(`[AE.runCycle] Opportunities found (${potentialOpportunities.length}) but none were profitable after calculation.`);
                         cycleStatus = 'COMPLETED (No Profitable Opps)';
                    } else {
                        // 4. Dispatch profitable trades
                        logger.info(`[AE.runCycle] Found ${profitableOpportunities.length} profitable opportunities! Dispatching trades.`);
                        await this._handleProfitableTrades(profitableOpportunities);
                         cycleStatus = 'COMPLETED (Trades Dispatched)';
                    }
                }
            }

            if (this.isRunning && cycleStatus.startsWith('COMPLETED')) {
            } else if (this.isRunning) {
                 cycleStatus = 'FAILED (Uncaught)';
            }


        } catch (error) {
            logger.error('[AE.runCycle] !!!!!!!! UNEXPECTED ERROR during cycle !!!!!!!!!!');
            logger.error(`[AE.runCycle] Error Type: ${error.constructor.name}, Msg: ${error.message}`);
            if (!(error instanceof ArbitrageError) || logger.level <= logger.levels.DEBUG) {
                 logger.error('[AE.runCycle] Stack:', error.stack);
            }
            handleError(error, 'ArbitrageEngine.runCycleTopLevelCatch');
            cycleStatus = `FAILED (${error.type || error.constructor.name})`;
        } finally {
            const cycleEndTime = Date.now();
            const duration = cycleEndTime - cycleStartTime;
            logger.debug(`[AE.runCycle] ===== Cycle ${cycleStatus}. Duration: ${duration}ms =====`);
            this.isCycleRunning = false;
        }
    }

    async _fetchPoolData() {
        logger.debug('[AE._fetchPoolData] Fetching pool states...');
        if (!this.poolScanner) {
             const errorMsg = "PoolScanner instance missing.";
             logger.error(`[AE._fetchPoolData] CRITICAL: ${errorMsg}`);
             throw new ArbitrageError('InternalError', errorMsg);
        }
        const fetchResult = await this.poolScanner.fetchPoolStates(this.config.POOL_CONFIGS);
        logger.debug(`[AE._fetchPoolData] Fetched ${fetchResult?.poolStates?.length || 0} pool states. Pair Registry size: ${fetchResult?.pairRegistry?.size || 0}`);
        return fetchResult;
    }

    _findOpportunities(poolStates, pairRegistry) {
        logger.debug('[AE._findOpportunities] Finding potential opportunities...');
        let allOpportunities = [];

        if (!pairRegistry || !(pairRegistry instanceof Map)) {
             const errorMsg = "Invalid pairRegistry received from PoolScanner. Cannot find opportunities.";
             logger.error(`[AE._findOpportunities] CRITICAL: ${errorMsg}`);
             return [];
        }

        if (!this.spatialFinder) {
            logger.warn("[AE._findOpportunities] SpatialFinder instance missing. Skipping spatial search.");
        } else if (poolStates?.length > 0) {
            logger.debug('[AE._findOpportunities] Running SpatialFinder...');
            const spatialOpportunities = this.spatialFinder.findArbitrage(poolStates, pairRegistry);
            logger.debug(`[AE._findOpportunities] SpatialFinder found ${spatialOpportunities?.length || 0} potentials.`);
            allOpportunities = allOpportunities.concat(spatialOpportunities);
        } else {
             logger.debug('[AE._findOpportunities] No pool states available for SpatialFinder.');
        }


        // Triangular Finder (Add logic when implemented)


        logger.debug(`[AE._findOpportunities] Total potential opportunities found: ${allOpportunities.length}`);
        return allOpportunities;
    }

    async _calculateProfitability(opportunities) {
        logger.debug(`[AE._calculateProfitability] Calculating profitability for ${opportunities.length} opportunities...`);
        if (!this.profitCalculator) {
             const errorMsg = "ProfitCalculator instance missing!";
             logger.error(`[AE._calculateProfitability] CRITICAL: ${errorMsg}`);
             throw new ArbitrageError('InternalError', errorMsg);
        }

        const profitableTrades = await this.profitCalculator.calculate(opportunities);

        return profitableTrades;
    }

    async _handleProfitableTrades(profitableTrades) {
        if (!this.tradeHandler) {
            logger.error('[AE._handleProfitableTrades] CRITICAL: TradeHandler instance missing!');
            return;
        }

        if (profitableTrades?.length > 0) {
             logger.info(`[AE._handleProfitableTrades] --- ✅ Profitable Trades Found (${profitableTrades.length}) ---`);
             profitableTrades.forEach((trade, index) => {
                  this._logTradeDetails(trade, index + 1);
             });

             try {
                 await this.tradeHandler.handleTrades(profitableTrades);
                 logger.debug(`[AE._handleProfitableTrades] TradeHandler completed handling profitable trades.`);
             } catch (handlerError) {
                 logger.error("[AE._handleProfitableTrades] Error caught from TradeHandler.handleTrades:", handlerError);
                 handleError(handlerError, 'TradeHandler.handleTrades');
             }

        } else {
             logger.debug('[AE._handleProfitableTrades] No profitable trades to handle.');
        }

        logger.debug(`[AE._handleProfitableTrades] Finished handling profitable trades.`);
    }

    _logTradeDetails(trade, index) {
        try {
            const pathDesc = trade.path?.map(p => {
                const symbols = p.poolState?.token0Symbol && p.poolState?.token1Symbol ? `${p.poolState.token0Symbol}/${p.poolState.token1Symbol}` : '?/?';
                 const fee = p.fee !== undefined && p.fee !== null ? `@${p.fee}` : '';
                return `${p.dex || '?'}(${symbols}${fee})`;
            }).join('->') || 'N/A';

            const formatAmount = (amountBigInt, token) => {
                if (amountBigInt === null || amountBigInt === undefined || !token?.decimals) return 'N/A';
                try {
                    if (typeof amountBigInt !== 'bigint') amountBigInt = BigInt(amountBigInt);
                    if (amountBigInt === 0n) return `0.0 ${token.symbol || '?'}`;
                    return `${ethers.formatUnits(amountBigInt, token.decimals)} ${token.symbol || '?'}`;
                } catch (e) {
                    logger.debug(`[AE._logTradeDetails] Error formatting amount ${amountBigInt} for ${token?.symbol}: ${e.message}`);
                    return `Error formatting (${amountBigInt.toString()})`;
                }
            };

             const formatEth = (weiAmount) => {
                 if (weiAmount === null || weiAmount === undefined) return 'N/A';
                 try {
                     if (typeof weiAmount !== 'bigint') weiAmount = BigInt(weiAmount);
                     return `${ethers.formatEther(weiAmount)} ${this.nativeSymbol}`;
                 } catch (e) {
                     logger.debug(`[AE._logTradeDetails] Error formatting ETH amount ${weiAmount}: ${e.message}`);
                     return `Error formatting (${weiAmount.toString()}) ${this.nativeSymbol}`;
                 }
             };


            logger.info(`  [${index}] ${trade.type || '?'}-Arb | Path: ${pathDesc}`);
            logger.info(`      Borrow: ${formatAmount(trade.amountIn, trade.tokenIn)}`);
            if (trade.intermediateAmountOut !== undefined && trade.intermediateAmountOut !== null && trade.tokenIntermediate) {
                 logger.info(`      -> Intermediate Out: ${formatAmount(trade.intermediateAmountOut, trade.tokenIntermediate)}`);
            }
            logger.info(`      -> Final Out: ${formatAmount(trade.amountOut, trade.tokenOut)}`);

            if (trade.netProfitNativeWei !== undefined && trade.netProfitNativeWei !== null) {
                 logger.info(`      NET Profit: ${formatEth(trade.netProfitNativeWei)} (Gross: ${formatEth(trade.estimatedProfit || 0n)})`);
                 logger.info(`      Costs: Gas ~${formatEth(trade.gasEstimate?.totalCostWei || 0n)}, Loan Fee ~${formatEth(trade.flashLoanDetails?.feeNativeWei || 0n)}`);
                 logger.info(`      Gas Estimate Check: ${trade.gasEstimateSuccess ? 'OK' : 'FAIL'} ${trade.gasEstimate?.errorMessage ? '(' + trade.gasEstimate.errorMessage + ')' : ''}`);

                 if (trade.thresholdNativeWei !== undefined && trade.thresholdNativeWei !== null) {
                      logger.info(`      Threshold Required: ${formatEth(trade.thresholdNativeWei)}`);
                 }
                 if (trade.titheAmountNativeWei !== null && trade.titheAmountNativeWei !== undefined && trade.titheAmountNativeWei > 0n) {
                      logger.info(`      Tithe Amount: ${formatEth(trade.titheAmountNativeWei)} (To: ${trade.titheRecipient})`);
                 }
                 if (trade.profitPercentage !== null && trade.profitPercentage !== undefined) {
                      logger.info(`      Profit Percentage: ~${trade.profitPercentage.toFixed(4)}% (vs borrowed ${trade.tokenIn?.symbol || '?'})`);
                 }
            } else {
                 logger.info(`      Profit calculation details not available or failed.`);
                 logger.debug(`      Raw Simulation Output (Borrowed Token Decimals): ${trade.amountOut?.toString() || 'N/A'}`);
            }

             logger.debug(`      Raw Amounts: Borrow=${trade.amountIn?.toString()}, IntermediateOut=${trade.intermediateAmountOut?.toString()}, FinalOut=${trade.amountOut?.toString()}`);


        } catch (logError) {
            logger.error(`[AE._logTradeDetails] Error logging trade details for index ${index}: ${logError.message}`);
            try { logger.debug("Raw trade object:", JSON.stringify(trade, (k,v) => typeof v === 'bigint' ? v.toString() : v, 2)); } catch { logger.debug("Raw trade object: (Cannot stringify)");}
        }
    }

} // End ArbitrageEngine class

// Export the class
module.exports = ArbitrageEngine;