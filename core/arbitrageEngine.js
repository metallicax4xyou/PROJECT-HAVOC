// core/arbitrageEngine.js
// --- VERSION v1.6 --- Adjusted log levels for less verbose per-cycle output

const { EventEmitter } = require('events');
const { ethers } = require('ethers');
const PoolScanner = require('./poolScanner');
const ProfitCalculator = require('./profitCalculator');
const SpatialFinder = require('./finders/spatialFinder');
const logger = require('../utils/logger');
const { ArbitrageError } = require('../utils/errorHandler');
const { TOKENS } = require('../constants/tokens');

class ArbitrageEngine extends EventEmitter {
    constructor(config, provider, swapSimulator, gasEstimator, flashSwapManager) {
        super();
        logger.info('[AE v1.6] Initializing ArbitrageEngine components...'); // Updated version log
        // Validation...
        if (!config) throw new ArbitrageError('InitializationError', 'AE: Missing config.');
        if (!provider) throw new ArbitrageError('InitializationError', 'AE: Missing provider.');
        if (!swapSimulator?.simulateSwap) throw new ArbitrageError('InitializationError', 'AE: Invalid SwapSimulator.');
        if (!gasEstimator?.estimateTxGasCost) throw new ArbitrageError('InitializationError', 'AE: Invalid GasEstimator.');
        if (!flashSwapManager || typeof flashSwapManager.getSignerAddress !== 'function') { throw new ArbitrageError('InitializationError', 'AE: Invalid FlashSwapManager instance required.'); }
        // No need to check config.provider here, bot.js ensures it

        this.config = config;
        this.provider = provider;
        this.flashSwapManager = flashSwapManager;
        // Pass dependencies directly to ProfitCalculator constructor
        this.profitCalculator = new ProfitCalculator(this.config, this.provider, swapSimulator, gasEstimator);

        this.isRunning = false;
        this.cycleInterval = null;
        this.isCycleRunning = false;
        this.nativeSymbol = this.config.NATIVE_CURRENCY_SYMBOL || 'ETH';

        // +++ ADD DEBUG LOG +++
        logger.debug('[AE Constructor] Received config object keys:', Object.keys(config));
        // Log specifically if FINDER_SETTINGS exists and its type
        logger.debug(`[AE Constructor] config.FINDER_SETTINGS exists: ${!!config.FINDER_SETTINGS}, type: ${typeof config.FINDER_SETTINGS}`);
        // Optionally log the FINDER_SETTINGS content if debug is needed (can be large)
        // try { logger.debug('[AE Constructor] config.FINDER_SETTINGS content:', JSON.stringify(config.FINDER_SETTINGS, (k,v) => typeof v === 'bigint' ? v.toString() : v, 2)); } catch {}
        // +++ END DEBUG LOG +++

        try {
            // Initialize components used within the cycle
            this.poolScanner = new PoolScanner(config); // Pass full config
            // This is where the error occurs if config is missing FINDER_SETTINGS
            this.spatialFinder = new SpatialFinder(config); // Pass full config
            // Initialize other finders here as they are added
            // this.triangularFinder = new TriangularV3Finder(config);
        } catch (error) {
            logger.error(`[AE] CRITICAL ERROR during component init: ${error.message}`, error);
            // Add more context to the wrapping error
            throw new ArbitrageError(`InitializationError`, `Failed AE components: ${error.message}`, error);
        }
        logger.info('[AE v1.6] ArbitrageEngine components initialized successfully.'); // Updated version log
    }

    async start() {
        logger.info('[AE.start] Attempting to start engine...');
        if (this.isRunning) {
            logger.warn('[AE.start] Engine already running.');
            return;
        }
        this.isRunning = true;
        logger.info('[AE.start] Engine marked as running. Executing initial runCycle...');

        try {
            logger.debug('[AE.start] >>> Calling initial runCycle...');
            await this.runCycle();
            logger.debug('[AE.start] <<< Initial runCycle finished.');
        } catch(error) {
            logger.error('[AE.start] CRITICAL ERROR during initial runCycle execution:', error);
            logger.info('[AE.start] Stopping engine due to initial cycle failure.');
            this.stop(); // Ensure engine stops on initial cycle failure
            return;
        }


        if (this.isRunning) { // Check if engine is still running after the initial cycle
            logger.debug('[AE.start] Setting up cycle interval...');
            this.cycleInterval = setInterval(() => {
                this.runCycle().catch(intervalError => {
                    logger.error('[AE Interval Error] Error caught from runCycle:', intervalError);
                });
            }, this.config.CYCLE_INTERVAL_MS);

            if (this.cycleInterval) {
                logger.info(`[AE.start] Engine started successfully. Cycle interval: ${this.config.CYCLE_INTERVAL_MS}ms`);
                // Indicate that the bot is fully operational
                logger.info('\n>>> BOT IS RUNNING <<<\n'); // Added clear indicator
                logger.info('(Press Ctrl+C to stop)\n======================'); // Added stop instruction
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
        if (!this.isRunning && !this.cycleInterval) {
            logger.warn('[AE.stop] Engine already stopped.');
            return;
        }
        this.isRunning = false; // Set flag first
        if (this.cycleInterval) {
            clearInterval(this.cycleInterval);
            this.cycleInterval = null;
            logger.debug('[AE.stop] Cycle interval cleared.');
        }
        this.isCycleRunning = false; // Ensure cycle running flag is reset
        logger.info('[AE.stop] Arbitrage Engine stopped.');
    }

    async runCycle() {
        // Use debug level for frequent cycle start/end logs
        const cycleStartTime = Date.now();
        logger.debug('[AE.runCycle] ===== Starting New Cycle =====');

        if (!this.isRunning) {
            logger.info('[AE.runCycle] Engine stopped.');
            return;
        }
        if (this.isCycleRunning) {
            logger.warn('[AE.runCycle] Previous cycle still running. Skipping.');
            return;
        }
        this.isCycleRunning = true;

        let cycleStatus = 'FAILED'; // Default status
        try {
            const { poolStates, pairRegistry } = await this._fetchPoolData();
            const allOpportunities = this._findOpportunities(poolStates, pairRegistry);

            if (allOpportunities.length > 0) {
                const profitableTrades = await this._calculateProfitability(allOpportunities);
                if (profitableTrades.length > 0) {
                    this._handleProfitableTrades(profitableTrades);
                    // If STOP_ON_FIRST_EXECUTION is true and we handle profitable trades, stop the engine
                    if (this.config.STOP_ON_FIRST_EXECUTION) {
                         logger.info('[AE.runCycle] STOP_ON_FIRST_EXECUTION is true. Stopping engine after finding profitable trade(s).');
                         this.stop(); // Stop the engine gracefully
                    }
                } else {
                    // Use debug level when no profitable trades are found
                    logger.debug(`[AE.runCycle] Opportunities found (${allOpportunities.length}) but none were profitable after calculation.`);
                }
            } else {
                // Use debug level when no potential opportunities are found by finders
                logger.debug('[AE.runCycle] No potential opportunities found by finders.');
            }

            // If the cycle completes without errors and is still running (not stopped by STOP_ON_FIRST_EXECUTION)
            if (this.isRunning) {
                 cycleStatus = 'COMPLETED';
            } else {
                 // If engine stopped during the cycle (e.g. by STOP_ON_FIRST_EXECUTION)
                 cycleStatus = 'STOPPED';
            }


        } catch (error) {
            logger.error('[AE.runCycle] !!!!!!!! ERROR during cycle !!!!!!!!!!');
            logger.error(`[AE.runCycle] Error Type: ${error.constructor.name}, Msg: ${error.message}`);
             // Log stack trace only for non-ArbitrageErrors or if LOG_LEVEL is debug/verbose
            if (!(error instanceof ArbitrageError) || logger.level <= logger.levels.DEBUG) {
                 logger.error('[AE.runCycle] Stack:', error.stack);
            }
            cycleStatus = `FAILED (${error.type || error.constructor.name})`; // Update status on failure
        } finally {
            const cycleEndTime = Date.now();
            const duration = cycleEndTime - cycleStartTime;
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
             throw new ArbitrageError(errorMsg, 'INTERNAL_ERROR');
        }
        const { poolStates, pairRegistry } = await this.poolScanner.fetchPoolStates();
        // Use debug level for summary of fetching
        logger.debug(`[AE._fetchPoolData] Fetched ${poolStates.length} pool states. Registry size: ${pairRegistry.size}`);
        return { poolStates, pairRegistry };
    }

    _findOpportunities(poolStates, pairRegistry) {
        // Use debug level for start of finding
        logger.debug('[AE._findOpportunities] Finding potential opportunities...');
        let allOpportunities = [];

        if (this.spatialFinder && pairRegistry) {
             // Update the finder's internal registry if it uses one
             // Note: SpatialFinder v1.12 might not use this method explicitly anymore,
             // it might rely on the pairRegistry passed to findArbitrage.
             // Keeping this call here as a potential future hook or if the finder implementation changes.
            try {
                 if (typeof this.spatialFinder.updatePairRegistry === 'function') {
                      this.spatialFinder.updatePairRegistry(pairRegistry);
                 } else {
                      logger.debug('[AE._findOpportunities] SpatialFinder does not have updatePairRegistry method.');
                 }
            } catch (e) {
                 logger.warn(`[AE._findOpportunities] Error calling updatePairRegistry on SpatialFinder: ${e.message}`);
            }
        }


        if (this.spatialFinder && poolStates.length > 0) {
            // Use debug level for starting a specific finder
            logger.debug('[AE._findOpportunities] Running SpatialFinder...');
            const spatialOpportunities = this.spatialFinder.findArbitrage(poolStates); // Pass poolStates directly
            // Use debug level for finder results summary
            logger.debug(`[AE._findOpportunities] SpatialFinder found ${spatialOpportunities.length} potentials.`);
            allOpportunities = allOpportunities.concat(spatialOpportunities);
        } else if (!this.spatialFinder) {
            logger.warn("[AE._findOpportunities] SpatialFinder instance missing.");
        }

        // Add other finders here as they are added
        // if (this.triangularFinder && poolStates.length > 0) {
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
             throw new ArbitrageError(errorMsg, 'INTERNAL_ERROR');
        }
         if (!this.flashSwapManager) {
             const errorMsg = "FlashSwapManager instance missing!";
             logger.error(`[AE._calculateProfitability] CRITICAL: ${errorMsg}`);
             throw new ArbitrageError(errorMsg, 'INTERNAL_ERROR');
         }

        let signerAddress = null;
        try {
            signerAddress = await this.flashSwapManager.getSignerAddress();
            if (!signerAddress || !ethers.isAddress(signerAddress) || signerAddress === ethers.ZeroAddress) {
                 throw new Error(`Invalid signer address returned: ${signerAddress}`);
            }
            logger.debug(`[AE._calculateProfitability] Using signer address for gas estimation: ${signerAddress}`);
        } catch (addrError) {
            logger.error(`[AE._calculateProfitability] CRITICAL: Could not get signer address: ${addrError.message}`);
            throw new ArbitrageError(`Failed to retrieve signer address: ${addrError.message}`, 'INTERNAL_ERROR', addrError);
        }


        const profitableTrades = await this.profitCalculator.calculate(opportunities, signerAddress);

        // Keep info level for the summary of profitable trades found
        logger.info(`[AE._calculateProfitability] Found ${profitableTrades.length} profitable trades (after gas/threshold).`);

        return profitableTrades;
    }

    _handleProfitableTrades(profitableTrades) {
        // Keep info level for the start and end of handling profitable trades - this is a key event!
        logger.info(`[AE._handleProfitableTrades] --- ✅ Profitable Trades Found (${profitableTrades.length}) ---`);
        profitableTrades.forEach((trade, index) => {
            this._logTradeDetails(trade, index + 1);
        });

        // Emit the event for the TradeHandler
        this.emit('profitableOpportunities', profitableTrades);
        logger.info(`[AE._handleProfitableTrades] --- Emitted 'profitableOpportunities' event ---`);
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
                    const token = this.config.TOKENS[tokenSymbol];
                    const decimals = token?.decimals || 18;
                    // Ensure amountStr is a string or BigInt before passing to formatUnits
                    return ethers.formatUnits(BigInt(amountStr), decimals);
                } catch (e) {
                    logger.debug(`[AE._logTradeDetails] Error formatting units for ${amountStr} ${tokenSymbol}: ${e.message}`);
                    return 'Error';
                }
            };

            logger.info(`  [${index}] ${trade.type} | ${pathDesc}`);
            logger.info(`      In: ${formatUnits(trade.amountIn, trade.tokenIn?.symbol)} ${trade.tokenIn?.symbol} | Sim Out: ${formatUnits(trade.amountOut, trade.tokenOut?.symbol)} ${trade.tokenOut?.symbol}`);
            logger.info(`      NET Profit: ~${formatEth(trade.netProfitNativeWei)} ${this.nativeSymbol} (Gas Cost ~${formatEth(trade.gasCostNativeWei)} ${this.nativeSymbol})`);
            logger.info(`      Threshold Used (Native): ${formatEth(trade.thresholdNativeWei)} ${this.nativeSymbol}`);
            // Display Tithe amount if available
            if (trade.titheAmountNativeWei !== null && trade.titheAmountNativeWei !== undefined) {
                 logger.info(`      Tithe Amount: ~${formatEth(trade.titheAmountNativeWei)} ${this.nativeSymbol}`);
            }
            if (trade.profitPercentage !== null && trade.profitPercentage !== undefined) {
                 logger.info(`      Profit Percentage: ~${trade.profitPercentage.toFixed(4)}%`);
            }
             // Add flash loan details if available
             if (trade.flashLoanDetails) {
                  logger.info(`      Flash Loan: ${formatUnits(trade.flashLoanDetails.amount, trade.flashLoanDetails.token.symbol)} ${trade.flashLoanDetails.token.symbol} (Fee: ${formatEth(trade.flashLoanDetails.feeNativeWei)} ${this.nativeSymbol})`);
             }


        } catch (logError) {
            logger.error(`[AE._logTradeDetails] Error logging trade details for index ${index}: ${logError.message}`);
            // Log the raw trade object at debug level on error
            try { logger.debug("Raw trade object:", JSON.stringify(trade, (k,v) => typeof v === 'bigint' ? v.toString() : v, 2)); } catch { logger.debug("Raw trade object: (Cannot stringify)");}
        }
    }

} // End ArbitrageEngine class

module.exports = ArbitrageEngine;
