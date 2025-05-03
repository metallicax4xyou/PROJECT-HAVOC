// core/arbitrageEngine.js
// --- VERSION v1.10 --- Corrected typo in TradeHandlerClass validation (TradeHandlerClassClass -> TradeHandlerClass).

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
        logger.info('[AE v1.10] Initializing ArbitrageEngine components...'); // Version bump
        // Validation...
        if (!config) throw new ArbitrageError('InitializationError', 'AE: Missing config.');
        if (!provider) throw new ArbitrageError('InitializationError', 'AE: Missing provider.');
        if (!swapSimulator?.simulateSwap) throw new ArbitrageError('InitializationError', 'AE: Invalid SwapSimulator.');
        if (!gasEstimator?.estimateTxGasCost) throw new ArbitrageError('InitializationError', 'AE: Invalid GasEstimator.');
        if (!flashSwapManager || typeof flashSwapManager.initiateAaveFlashLoan !== 'function') { throw new ArbitrageError('InitializationError', 'AE: Invalid FlashSwapManager instance required.'); }
        // Validate the TradeHandler Class constructor
        // --- CORRECTED TYPO HERE ---
        if (!TradeHandlerClass || typeof TradeHandlerClass !== 'function' || !TradeHandlerClass.prototype || typeof TradeHandlerClass.prototype.handleTrades !== 'function') {
             throw new ArbitrageError('InitializationError', 'AE: Invalid TradeHandler Class constructor provided.');
        }


        this.config = config;
        this.provider = provider;
        this.flashSwapManager = flashSwapManager;
        this.gasEstimator = gasEstimator;


        // Initialize child components
        this.poolScanner = new PoolScanner(config); // Pass full config
        // logger.info('[PoolScanner v1.3] PoolScanner fetcher initialization complete.'); // Moved log out of constructor
        // Pass finder settings from config
        this.spatialFinder = new SpatialFinder(config); // Pass full config
        // Initialize other finders here as they are added
        // this.triangularV3Finder = new TriangularV3Finder(config);


        // Initialize ProfitCalculator, passing required dependencies
        // Pass the flashSwapManager instance to ProfitCalculator
        this.profitCalculator = new ProfitCalculator(config, provider, swapSimulator, gasEstimator, flashSwapManager); // Pass flashSwapManager


        // Initialize TradeHandler INSTANCE, passing required dependencies
        // Use the provided TradeHandlerClass constructor
        this.tradeHandler = new TradeHandlerClass(config, provider, flashSwapManager, gasEstimator, logger); // Pass all dependencies + logger


        // Event listeners map (Opportunity type -> Handler function) - NOT USED IN CURRENT DESIGN
        // The design now is that _calculateProfitability calls _handleProfitableTrades,
        // which calls tradeHandler.handleTrades directly.
        // Keeping this map commented out unless we revert to event-based dispatch.
        /*
        this.opportunityHandlers = {
            'spatial': this.tradeHandler.handleTrades.bind(this.tradeHandler), // Bind to instance method
            // Add other handlers as implemented
            // 'triangular': this.tradeHandler.handleTriangularArbitrage.bind(this.tradeHandler), // Example
        };
        */


        // State variables
        this.isRunning = false;
        this.cycleInterval = null; // To hold the timeout ID
        this.isCycleRunning = false; // Flag to prevent overlapping cycles
        this.nativeSymbol = this.config.NATIVE_CURRENCY_SYMBOL || 'ETH';


        logger.info('[AE v1.10] ArbitrageEngine components initialized successfully.'); // Version bump
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
            // Do NOT return here, let the rest of start() (setting interval) potentially run if isRunning is still true (it shouldn't be after stop())
        }


        // Schedule subsequent cycles only if engine is still running after the initial cycle
        if (this.isRunning) {
            logger.debug('[AE.start] Setting up cycle interval...');
            this.cycleInterval = setInterval(() => {
                // Wrap interval callback in a try/catch
                this.runCycle().catch(intervalError => {
                    logger.error('[AE Interval Error] Error caught from runCycle:', intervalError);
                    handleError(intervalError, 'ArbitrageEngine.runCycleInterval'); // Centralized error handling for interval runs
                });
            }, this.config.CYCLE_INTERVAL_MS);

            // Check if the interval was successfully set
            if (this.cycleInterval) {
                logger.info(`[AE.start] Engine started successfully. Cycle interval: ${this.config.CYCLE_INTERVAL_MS}ms`);
                // Moved "BOT IS RUNNING" message here
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

         // Add explicit BOT STOPPED message here
         logger.info('\n>>> BOT STOPPED <<<\n');
         logger.info('======================');
    }

    async runCycle() {
        const cycleStartTime = Date.now();
        // Use debug level for frequent cycle start/end logs
        logger.debug('[AE.runCycle] ===== Starting New Cycle =====');


        // Prevent overlapping cycles
        if (!this.isRunning) {
            logger.info('[AE.runCycle] Engine is stopping. Skipping cycle execution.');
            this.isCycleRunning = false; // Ensure flag is false
            return;
        }
         if (this.isCycleRunning) {
             logger.warn('[AE.runCycle] Previous cycle still running. Skipping this cycle.');
             return;
         }
        this.isCycleRunning = true; // Set flag at start of execution

        let cycleStatus = 'FAILED'; // Default status
        try {
            // 1. Fetch latest pool data
            const { poolStates, pairRegistry } = await this._fetchPoolData(); // fetchPoolData now returns object

            if (!poolStates || poolStates.length === 0) {
                logger.debug('[AE.runCycle] No pool states fetched in this cycle.');
            } else {
                // 2. Find potential arbitrage opportunities
                // Pass pairRegistry to findOpportunities if finders need it
                const potentialOpportunities = this._findOpportunities(poolStates, pairRegistry);


                if (!potentialOpportunities || potentialOpportunities.length === 0) {
                     logger.debug('[AE.runCycle] No potential opportunities found in this cycle.');
                } else {
                    // 3. Calculate profitability and filter
                    const profitableOpportunities = await this._calculateProfitability(potentialOpportunities);

                    if (!profitableOpportunities || profitableOpportunities.length === 0) {
                         logger.debug(`[AE.runCycle] Opportunities found (${potentialOpportunities.length}) but none were profitable after calculation.`);
                    } else {
                        // 4. Dispatch profitable trades
                        this._handleProfitableTrades(profitableOpportunities); // Call the method on the TradeHandler instance
                        // The instance method will handle STOP_ON_FIRST_EXECUTION logic
                    }
                }
            }

            // If the cycle completes without errors and is still running (not stopped by STOP_ON_FIRST_EXECUTION)
            // Check this.isRunning again after potential trade handling
            if (this.isRunning) {
                 cycleStatus = 'COMPLETED';
            } else {
                 // If engine stopped during the cycle (e.g. by STOP_ON_FIRST_EXECUTION)
                 cycleStatus = 'STOPPED';
            }


        } catch (error) {
            // Catch unexpected errors in the main cycle flow
            logger.error('[AE.runCycle] !!!!!!!! UNEXPECTED ERROR during cycle !!!!!!!!!!');
            logger.error(`[AE.runCycle] Error Type: ${error.constructor.name}, Msg: ${error.message}`);
             // Log stack trace only for non-ArbitrageErrors or if LOG_LEVEL is debug/verbose
            if (!(error instanceof ArbitrageError) || logger.level <= logger.levels.DEBUG) {
                 logger.error('[AE.runCycle] Stack:', error.stack);
            }
            cycleStatus = `FAILED (${error.type || error.constructor.name})`; // Update status on failure
             // Do NOT re-throw here. The interval timer should continue unless startup failed.
        } finally {
            const cycleDuration = Date.now() - cycleStartTime; // Calculate duration
            // Use debug level for frequent cycle start/end logs
            logger.debug(`[AE.runCycle] ===== Cycle ${cycleStatus}. Duration: ${duration}ms =====`);
            this.isCycleRunning = false; // Ensure flag is reset regardless of outcome
        }
    }

    async _fetchPoolData() {
        // Use debug level for start/end of fetching
        logger.debug('[AE._fetchPoolData] Fetching pool states...');
        if (!this.poolScanner) {
             const errorMsg = "PoolScanner instance missing.";
             logger.error(`[AE._fetchPoolData] CRITICAL: ${errorMsg}`);
             throw new ArbitrageError('InternalError', errorMsg); // Use consistent error type
        }
         // fetchPoolStates now returns { poolStates, pairRegistry }
        const fetchResult = await this.poolScanner.fetchPoolStates(this.config.POOL_CONFIGS); // Pass config pools
        // Use debug level for summary of fetching
        logger.debug(`[AE._fetchPoolData] Fetched ${fetchResult.poolStates?.length || 0} pool states. Pair Registry size: ${fetchResult.pairRegistry?.size || 0}`);
        return fetchResult; // Return the object { poolStates, pairRegistry }
    }

    _findOpportunities(poolStates, pairRegistry) {
        // Use debug level for start of finding
        logger.debug('[AE._findOpportunities] Finding potential opportunities...');
        let allOpportunities = [];

        // Pass pairRegistry to SpatialFinder constructor if it needs it directly (SpatialFinder v1.25 does not use updateRegistry, it expects registry in constructor/method)
        // SpatialFinder v1.25 constructor takes config and settings. findArbitrage takes poolStates.
        // It needs the Token config and sim amounts which are in config.
        // It needs the pair registry. Let's update findArbitrage signature.

         // UPDATE: SpatialFinder v1.25 findArbitrage already uses the internal registry updated by updateRegistry.
         // Let's ensure updateRegistry is called correctly *before* findArbitrage.
         // SpatialFinder v1.25 constructor does NOT take pairRegistry. UpdateRegistry takes pairRegistry.
        if (this.spatialFinder) {
            try {
                // SpatialFinder v1.25's updateRegistry is internal and happens within its constructor/initialization based on config.
                // Let's re-check the SpatialFinder constructor and findArbitrage method signature to confirm how it gets the registry.
                 // Re-read SpatialFinder v1.25 code... It seems the pair registry is managed *within* PoolScanner and passed *to* findArbitrage.
                 // Yes, SpatialFinder v1.25 findArbitrage signature is (poolStates). It must get the registry internally or from its constructor.
                 // Looking at AE constructor, SpatialFinder is created with `new SpatialFinder(config)`.
                 // Re-reading SpatialFinder v1.25 code again, it initializes its *own* pairRegistry. This is NOT what we want.
                 // The pair registry should be managed centrally by PoolScanner and passed to Finders.
                 // Let's revert SpatialFinder to an earlier version (v1.12) that took the pairRegistry.
                 // Alternatively, update SpatialFinder v1.25 to *accept* the pairRegistry in findArbitrage.
                 // Option 2 is better to keep latest code. Update SpatialFinder's findArbitrage signature.
                 // TEMPORARY HACK: SpatialFinder needs the pairRegistry. Let's pass it here to its method.
                 // findArbitrage method needs to accept pairRegistry.

                 // --- Need to update SpatialFinder.findArbitrage to accept pairRegistry ---
                 // For now, continuing *as if* it was updated, will need to provide updated SpatialFinder code.
                 // Assuming SpatialFinder v1.26 findArbitrage will have signature (poolStates, pairRegistry)

            } catch (e) {
                 logger.warn(`[AE._findOpportunities] Error with SpatialFinder registry update/prep: ${e.message}`);
            }
        }


        if (this.spatialFinder && poolStates.length > 0 && pairRegistry) { // Added pairRegistry check
            // Use debug level for starting a specific finder
            logger.debug('[AE._findOpportunities] Running SpatialFinder...');
            // Pass pairRegistry to findArbitrage (assuming signature update in SpatialFinder v1.26)
            const spatialOpportunities = this.spatialFinder.findArbitrage(poolStates, pairRegistry);
            // Use debug level for finder results summary
            logger.debug(`[AE._findOpportunities] SpatialFinder found ${spatialOpportunities.length} potentials.`);
            allOpportunities = allOpportunities.concat(spatialOpportunities);
        } else if (!this.spatialFinder) {
            logger.warn("[AE._findOpportunities] SpatialFinder instance missing.");
        } else if (!pairRegistry) { // Added condition for missing pairRegistry
             logger.error("[AE._findOpportunities] Pair Registry is missing. Cannot run finders.");
        }


        // Add other finders here as they are added
        // if (this.triangularFinder && poolStates.length > 0 && pairRegistry) { // Triangular also needs registry
        //      logger.debug('[AE._findOpportunities] Running TriangularV3Finder...');
        //      const triangularOpportunities = this.triangularFinder.findArbitrage(poolStates, pairRegistry); // Triangular needs pairRegistry
        //      logger.debug(`[AE._findOpportunities] TriangularV3Finder found ${triangularOpportunities.length} potentials.`);
        //      allOpportunities = allOpportunities.concat(triangularOpportunities);
        // } else if (!this.triangularFinder) {
        //      logger.warn("[AE._findOpportunities] TriangularV3Finder instance missing.");
        // }


        // Use debug level for total potentials found summary
        logger.debug(`[AE._findOpportunities] Total potential opportunities found: ${allOpportunities.length}`);
        return allOpportunities;
    }

    async _calculateProfitability(opportunities) {
        // Use debug level for start of calculation
        logger.debug(`[AE._calculateProfitability] Calculating profitability for ${opportunities.length} opportunities...`);
        if (!this.profitCalculator) {
             const errorMsg = "ProfitCalculator instance missing!";
             logger.error(`[AE._calculateProfitability] CRITICAL: ${errorMsg}`);
             throw new ArbitrageError('InternalError', errorMsg); // Use consistent error type
        }
         // Signer address is now handled internally by ProfitCalculator using its instance property


        const profitableTrades = await this.profitCalculator.calculate(opportunities); // No longer pass signerAddress here

        // Keep info level for the summary of profitable trades found
        logger.info(`[AE._calculateProfitability] Found ${profitableTrades.length} profitable trades (after gas/threshold).`);

        return profitableTrades;
    }

    _handleProfitableTrades(profitableTrades) {
        // This method is called by runCycle when profitable trades are found.
        // It should call the method on the TradeHandler instance.
        if (!this.tradeHandler) {
            logger.error('[AE._handleProfitableTrades] CRITICAL: TradeHandler instance missing!');
             // Do not throw here, let cycle finish, but log error
            return;
        }

        // Keep info level for the start and end of handling profitable trades - this is a key event!
        logger.info(`[AE._handleProfitableTrades] --- ✅ Profitable Trades Found (${profitableTrades.length}) ---`);
        profitableTrades.forEach((trade, index) => {
             // Add the log message for each profitable trade
             this._logTradeDetails(trade, index + 1);
        });


        // Call the method on the TradeHandler instance
        // handleTrades method takes the array of profitable trades
        this.tradeHandler.handleTrades(profitableTrades).catch(handlerError => {
             // Catch errors specifically from the handler's async execution
             logger.error("[AE._handleProfitableTrades] Uncaught error from trade handler:", handlerError);
             handleError(handlerError, 'TradeHandlerMethodTopLevelCatch'); // Centralized error handling
        });

        logger.info(`[AE._handleProfitableTrades] --- Dispatched trades for handling ---`);
    }

    _logTradeDetails(trade, index) {
        // Keep info level for detailed trade logs - this happens only for profitable trades
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
                    // Need the actual Token object from config to get decimals
                    const token = this.config.TOKENS[tokenSymbol];
                    const decimals = token?.decimals || 18; // Default to 18 if token not found
                    // Ensure amountStr is a string or BigInt before passing to formatUnits
                    return ethers.formatUnits(BigInt(amountStr), decimals);
                } catch (e) {
                    logger.debug(`[AE._logTradeDetails] Error formatting units for ${amountStr} ${tokenSymbol}: ${e.message}`);
                    return 'Error';
                }
            };

            logger.info(`  [${index}] ${trade.type} | ${pathDesc}`);
            logger.info(`      In: ${formatUnits(trade.amountIn, trade.tokenIn?.symbol)} ${trade.tokenIn?.symbol} | Sim Out: ${formatUnits(trade.amountOut, trade.tokenOut?.symbol)} ${trade.tokenOut?.symbol}`);

            // Check if profitability calculation happened and has expected properties
            if (trade.netProfitNativeWei !== undefined && trade.netProfitNativeWei !== null) {
                 logger.info(`      NET Profit: ~${formatEth(trade.netProfitNativeWei)} ${this.nativeSymbol} (Gas Cost ~${formatEth(trade.gasEstimate || 0n)} ${this.nativeSymbol}, EstimateGas Check: ${trade.gasEstimateSuccess ? 'OK' : 'FAIL'})`);
                 if (trade.thresholdNativeWei !== undefined && trade.thresholdNativeWei !== null) {
                      logger.info(`      Threshold Used (Native): ${formatEth(trade.thresholdNativeWei)} ${this.nativeSymbol}`);
                 }
                 // Display Tithe amount if available
                 if (trade.titheAmountNativeWei !== null && trade.titheAmountNativeWei !== undefined) {
                      logger.info(`      Tithe Amount: ~${formatEth(trade.titheAmountNativeWei)} ${this.nativeSymbol}`);
                 }
                 if (trade.profitPercentage !== null && trade.profitPercentage !== undefined) {
                      logger.info(`      Profit Percentage: ~${trade.profitPercentage.toFixed(4)}%`);
                 }
            } else {
                 logger.info(`      Profit details not calculated or available.`);
                 // Log simulation output even if profit calc failed
                 logger.info(`      Raw Simulation Output (Borrowed): ${trade.amountOut?.toString() || 'N/A'} ${trade.tokenOut?.symbol || '?'}`);
            }

             // Add flash loan details if available
             if (trade.flashLoanDetails) {
                  logger.info(`      Flash Loan: ${formatUnits(trade.flashLoanDetails.amount, trade.flashLoanDetails.token.symbol)} ${trade.flashLoanDetails.token.symbol} (Fee: ${formatEth(trade.flashLoanDetails.feeNativeWei || 0n)} ${this.nativeSymbol})`);
             }


        } catch (logError) {
            logger.error(`[AE._logTradeDetails] Error logging trade details for index ${index}: ${logError.message}`);
            // Log the raw trade object at debug level on error
            try { logger.debug("Raw trade object:", JSON.stringify(trade, (k,v) => typeof v === 'bigint' ? v.toString() : v, 2)); } catch { logger.debug("Raw trade object: (Cannot stringify)");}
        }
    }

} // End ArbitrageEngine class

// Export the class
module.exports = ArbitrageEngine;