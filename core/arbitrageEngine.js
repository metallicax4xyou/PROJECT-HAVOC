// core/arbitrageEngine.js
// --- VERSION v1.13 --- Passed pairRegistry to SpatialFinder.findArbitrage.

const { EventEmitter } = require('events');
const { ethers } = require('ethers');
const PoolScanner = require('./poolScanner');
const ProfitCalculator = require('./profitCalculator');
const SpatialFinder = require('./finders/spatialFinder');
const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler'); // Import error handling
const { TOKENS } = require('../constants/tokens');
// Import the TradeHandler CLASS
const TradeHandler = require('./tradeHandler'); // Import the class

class ArbitrageEngine extends EventEmitter {
    /**
     * @param {object} config - Application configuration.
     * @param {ethers.Provider} provider - Ethers provider.
     * @param {SwapSimulator} swapSimulator - Instance of SwapSimulator.
     * @param {GasEstimator} gasEstimator - Instance of GasEstimator.
     * @param {FlashSwapManager} flashSwapManager - Instance of FlashSwapManager.
     * @param {TradeHandler} TradeHandlerClass - The TradeHandler class constructor. <-- ADDED THIS PARAMETER
     */
    constructor(config, provider, swapSimulator, gasEstimator, flashSwapManager, TradeHandlerClass) { // <-- ADDED THIS PARAMETER
        super();
        logger.info('[AE v1.13] Initializing ArbitrageEngine components...'); // Version bump
        // Validation...
        if (!config) throw new ArbitrageError('InitializationError', 'AE: Missing config.');
        if (!provider) throw new ArbitrageError('InitializationError', 'AE: Missing provider.');
        if (!swapSimulator?.simulateSwap) throw new ArbitrageError('InitializationError', 'AE: Invalid SwapSimulator.');
        if (!gasEstimator?.estimateTxGasCost) throw new ArbitrageError('InitializationError', 'AE: Invalid GasEstimator.');
        if (!flashSwapManager || typeof flashSwapManager.initiateAaveFlashLoan !== 'function') { throw new ArbitrageError('InitializationError', 'AE: Invalid FlashSwapManager instance required.'); }
        // Validate the TradeHandler Class constructor
        if (!TradeHandlerClass || typeof TradeHandlerClass !== 'function' || !TradeHandlerClass.prototype || typeof TradeHandlerClass.prototype.handleTrades !== 'function') {
             throw new ArbitrageError('InitializationError', 'AE: Invalid TradeHandler Class constructor provided.');
        }


        this.config = config;
        this.provider = provider;
        this.flashSwapManager = flashSwapManager;
        this.gasEstimator = gasEstimator;


        // Initialize child components
        this.poolScanner = new PoolScanner(config); // Pass full config
        this.spatialFinder = new SpatialFinder(config); // Pass full config
        // Initialize other finders here as they are added
        // this.triangularV3Finder = new TriangularV3Finder(config);


        // Initialize ProfitCalculator, passing required dependencies
        this.profitCalculator = new ProfitCalculator(config, provider, swapSimulator, gasEstimator, flashSwapManager);


        // Initialize TradeHandler INSTANCE
        this.tradeHandler = new TradeHandlerClass(config, provider, flashSwapManager, gasEstimator, logger);


        // State variables
        this.isRunning = false;
        this.cycleInterval = null; // To hold the timeout ID
        this.isCycleRunning = false; // Flag to prevent overlapping cycles
        this.nativeSymbol = this.config.NATIVE_CURRENCY_SYMBOL || 'ETH';


        logger.info('[AE v1.13] ArbitrageEngine components initialized successfully.'); // Version bump
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


        // Initial run cycle - wrapped in try/catch to log failure but not necessarily exit
        try {
            logger.debug('[AE.start] >>> Calling initial runCycle...');
            await this.runCycle();
            logger.debug('[AE.start] <<< Initial runCycle finished.');
        } catch(error) {
            // Catch unexpected errors only in the initial cycle
            logger.error('[AE.start] CRITICAL ERROR during initial runCycle execution:', error);
            handleError(error, 'ArbitrageEngine.initialRunCycle'); // Centralized error handling
            logger.info('[AE.start] Stopping engine due to initial cycle failure.');
            this.stop(); // Ensure engine stops on initial cycle failure
        }


        // Schedule subsequent cycles only if engine is still running after the initial cycle
        if (this.isRunning) {
            logger.debug('[AE.start] Setting up cycle interval...');
            this.cycleInterval = setInterval(() => {
                this.runCycle().catch(intervalError => {
                    logger.error('[AE Interval Error] Error caught from runCycle:', intervalError);
                    handleError(intervalError, 'ArbitrageEngine.runCycleInterval'); // Centralized error handling for interval runs
                });
            }, this.config.CYCLE_INTERVAL_MS);

            if (this.cycleInterval) {
                logger.info(`[AE.start] Engine started successfully. Cycle interval: ${this.config.CYCLE_INTERVAL_MS}ms`);
            } else {
                 logger.error('[AE.start] Failed to set cycle interval!');
                 this.stop(); // Ensure engine stops if interval setup fails
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
        this.isRunning = false; // Set flag first
        if (this.cycleInterval) {
            clearInterval(this.cycleInterval);
            this.cycleInterval = null;
            logger.debug('[AE.stop] Cycle interval cleared.');
        }
        this.isCycleRunning = false; // Ensure flag is reset immediately
        logger.info('[AE.stop] Arbitrage Engine stopped.');

         logger.info('\n>>> BOT STOPPED <<<\n');
         logger.info('======================');
    }

    async runCycle() {
        const cycleStartTime = Date.now();
        logger.debug('[AE.runCycle] ===== Starting New Cycle =====');

        if (!this.isRunning) {
            logger.info('[AE.runCycle] Engine is stopping. Skipping cycle execution.');
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
            const { poolStates, pairRegistry } = await this._fetchPoolData(); // fetchPoolData returns object

            if (!poolStates || poolStates.length === 0) {
                logger.debug('[AE.runCycle] No pool states fetched in this cycle.');
            } else {
                // 2. Find potential arbitrage opportunities
                // Pass the pairRegistry received from fetchPoolData to _findOpportunities
                const potentialOpportunities = this._findOpportunities(poolStates, pairRegistry);


                if (!potentialOpportunities || potentialOpportunities.length === 0) {
                     logger.debug(`[AE.runCycle] Opportunities found (${potentialOpportunities.length}) but none were profitable after calculation.`);
                } else {
                    // 3. Calculate profitability and filter
                    const profitableOpportunities = await this._calculateProfitability(potentialOpportunities);

                    if (!profitableOpportunities || profitableOpportunities.length === 0) {
                         logger.debug(`[AE.runCycle] Opportunities found (${potentialOpportunities.length}) but none were profitable after calculation.`);
                    } else {
                        // 4. Dispatch profitable trades
                        this._handleProfitableTrades(profitableOpportunities);
                    }
                }
            }

            if (this.isRunning) {
                 cycleStatus = 'COMPLETED';
            } else {
                 cycleStatus = 'STOPPED';
            }


        } catch (error) {
            logger.error('[AE.runCycle] !!!!!!!! UNEXPECTED ERROR during cycle !!!!!!!!!!');
            logger.error(`[AE.runCycle] Error Type: ${error.constructor.name}, Msg: ${error.message}`);
            if (!(error instanceof ArbitrageError) || logger.level <= logger.levels.DEBUG) {
                 logger.error('[AE.runCycle] Stack:', error.stack);
            }
            cycleStatus = `FAILED (${error.type || error.constructor.name})`;
        } finally {
            const cycleEndTime = Date.now();
            const duration = cycleEndTime - cycleStartTime; // Calculate duration
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
        logger.debug(`[AE._fetchPoolData] Fetched ${fetchResult.poolStates?.length || 0} pool states. Pair Registry size: ${fetchResult.pairRegistry?.size || 0}`);
        return fetchResult;
    }

    _findOpportunities(poolStates, pairRegistry) {
        logger.debug('[AE._findOpportunities] Finding potential opportunities...');
        let allOpportunities = [];

        if (!this.spatialFinder) {
            logger.warn("[AE._findOpportunities] SpatialFinder instance missing.");
             // Can we still proceed with other finders if spatial is missing? Yes.
        }

        // Pass the pairRegistry received from fetchPoolData to SpatialFinder.findArbitrage
        // SpatialFinder v1.26+ findArbitrage signature: (poolStates, pairRegistry)
        if (this.spatialFinder && poolStates?.length > 0 && pairRegistry) {
            logger.debug('[AE._findOpportunities] Running SpatialFinder...');
            const spatialOpportunities = this.spatialFinder.findArbitrage(poolStates, pairRegistry); // Pass the pairRegistry here
            logger.debug(`[AE._findOpportunities] SpatialFinder found ${spatialOpportunities?.length || 0} potentials.`);
            allOpportunities = allOpportunities.concat(spatialOpportunities);
        }


        // Add other finders here and pass pairRegistry
        // if (this.triangularFinder && poolStates?.length > 0 && pairRegistry) {
        //      logger.debug('[AE._findOpportunities] Running TriangularV3Finder...');
        //      const triangularOpportunities = this.triangularFinder.findArbitrage(poolStates, pairRegistry);
        //      logger.debug(`[AE._findOpportunities] TriangularV3Finder found ${triangularOpportunities?.length || 0} potentials.`);
        //      allOpportunities = allOpportunities.concat(triangularOpportunities);
        // } else if (!this.triangularFinder) {
        //      logger.warn("[AE._findOpportunities] TriangularV3Finder instance missing.");
        // }


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

        logger.info(`[AE._calculateProfitability] Found ${profitableTrades.length} profitable trades (after gas/threshold).`);

        return profitableTrades;
    }

    _handleProfitableTrades(profitableTrades) {
        if (!this.tradeHandler) {
            logger.error('[AE._handleProfitableTrades] CRITICAL: TradeHandler instance missing!');
            return;
        }

        logger.info(`[AE._handleProfitableTrades] --- ✅ Profitable Trades Found (${profitableTrades.length}) ---`);
        profitableTrades.forEach((trade, index) => {
             this._logTradeDetails(trade, index + 1);
        });


        this.tradeHandler.handleTrades(profitableTrades).catch(handlerError => {
             logger.error("[AE._handleProfitableTrades] Uncaught error from trade handler:", handlerError);
             handleError(handlerError, 'TradeHandlerMethodTopLevelCatch');
        });

        logger.info(`[AE._handleProfitableTrades] --- Dispatched trades for handling ---`);
    }

    _logTradeDetails(trade, index) {
        try {
            const pathDesc = trade.path?.map(p => {
                const symbols = p.poolState?.token0Symbol && p.poolState?.token1Symbol ? `${p.poolState.token0Symbol}/${p.poolState.token1Symbol}` : '?/?';
                return `${p.dex || '?'}(${symbols})`;
            }).join('->') || 'N/A';

            const formatEth = (weiStr) => {
                if (weiStr === null || weiStr === undefined) return 'N/A';
                try { return ethers.formatEther(BigInt(weiStr)); } catch { return 'Error'; }
            };
             const formatUnits = (amountStr, tokenSymbol) => {
                if (amountStr === null || amountStr === undefined || !tokenSymbol) return 'N/A';
                try {
                    const token = this.config.TOKENS[tokenSymbol];
                    const decimals = token?.decimals || 18;
                    return ethers.formatUnits(BigInt(amountStr), decimals);
                } catch (e) {
                    logger.debug(`[AE._logTradeDetails] Error formatting units for ${amountStr} ${tokenSymbol}: ${e.message}`);
                    return 'Error';
                }
            };

            logger.info(`  [${index}] ${trade.type} | ${pathDesc}`);
            logger.info(`      In: ${formatUnits(trade.amountIn, trade.tokenIn?.symbol)} ${trade.tokenIn?.symbol} | Sim Out: ${formatUnits(trade.amountOut, trade.tokenOut?.symbol)} ${trade.tokenOut?.symbol}`);

            if (trade.netProfitNativeWei !== undefined && trade.netProfitNativeWei !== null) {
                 logger.info(`      NET Profit: ~${formatEth(trade.netProfitNativeWei)} ${this.nativeSymbol} (Gas Cost ~${formatEth(trade.gasEstimate || 0n)} ${this.nativeSymbol}, EstimateGas Check: ${trade.gasEstimateSuccess ? 'OK' : 'FAIL'})`);
                 if (trade.thresholdNativeWei !== undefined && trade.thresholdNativeWei !== null) {
                      logger.info(`      Threshold Used (Native): ${formatEth(trade.thresholdNativeWei)} ${this.nativeSymbol}`);
                 }
                 if (trade.titheAmountNativeWei !== null && trade.titheAmountNativeWei !== undefined) {
                      logger.info(`      Tithe Amount: ~${formatEth(trade.titheAmountNativeWei)} ${this.nativeSymbol}`);
                 }
                 if (trade.profitPercentage !== null && trade.profitPercentage !== undefined) {
                      logger.info(`      Profit Percentage: ~${trade.profitPercentage.toFixed(4)}%`);
                 }
            } else {
                 logger.info(`      Profit details not calculated or available.`);
                 logger.info(`      Raw Simulation Output (Borrowed): ${trade.amountOut?.toString() || 'N/A'} ${trade.tokenOut?.symbol || '?'}`);
            }

             if (trade.flashLoanDetails) {
                  logger.info(`      Flash Loan: ${formatUnits(trade.flashLoanDetails.amount, trade.flashLoanDetails.token.symbol)} ${trade.flashLoanDetails.token.symbol} (Fee: ${formatEth(trade.flashLoanDetails.feeNativeWei || 0n)} ${this.nativeSymbol})`);
             }


        } catch (logError) {
            logger.error(`[AE._logTradeDetails] Error logging trade details for index ${index}: ${logError.message}`);
            try { logger.debug("Raw trade object:", JSON.stringify(trade, (k,v) => typeof v === 'bigint' ? v.toString() : v, 2)); } catch { logger.debug("Raw trade object: (Cannot stringify)");}
        }
    }

} // End ArbitrageEngine class

// Export the class
module.exports = ArbitrageEngine;