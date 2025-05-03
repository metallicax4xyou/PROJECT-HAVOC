// core/arbitrageEngine.js
// --- VERSION v1.7 --- Updated constructor to receive FlashSwapManager and pass it to ProfitCalculator.

const logger = require('../utils/logger');
const PoolScanner = require('./poolScanner');
const SpatialFinder = require('./finders/spatialFinder');
const TriangularV3Finder = require('./finders/triangularV3Finder'); // Assuming Triangular V3 finder exists
const ProfitCalculator = require('./profitCalculator');
const TradeHandler = require('./tradeHandler'); // Assuming TradeHandler exists
const { ArbitrageError, handleError } = require('../utils/errorHandler'); // Import error handling


class ArbitrageEngine {
    /**
     * @param {object} config - Application configuration.
     * @param {ethers.Provider} provider - Ethers provider.
     * @param {SwapSimulator} swapSimulator - Instance of SwapSimulator.
     * @param {GasEstimator} gasEstimator - Instance of GasEstimator.
     * @param {FlashSwapManager} flashSwapManager - Instance of FlashSwapManager. <-- ADDED THIS PARAMETER
     */
    constructor(config, provider, swapSimulator, gasEstimator, flashSwapManager) { // <-- ADDED THIS PARAMETER
        logger.info('[AE v1.7] Initializing ArbitrageEngine components...'); // Version bump
        if (!config) throw new ArbitrageError('ArbitrageEngineInit', 'Missing config.');
        if (!provider) throw new ArbitrageError('ArbitrageEngineInit', 'Missing provider.');
        if (!swapSimulator) throw new ArbitrageError('ArbitrageEngineInit', 'Invalid SwapSimulator instance.');
        if (!gasEstimator) throw new ArbitrageError('ArbitrageEngineInit', 'Invalid GasEstimator instance.');
        // Added validation for flashSwapManager, as ProfitCalculator will need it.
        if (!flashSwapManager) throw new ArbitrageError('ArbitrageEngineInit', 'Invalid FlashSwapManager instance.');


        this.config = config;
        this.provider = provider;
        this.swapSimulator = swapSimulator;
        this.gasEstimator = gasEstimator;
        this.flashSwapManager = flashSwapManager; // Store the instance


        // Initialize child components
        this.poolScanner = new PoolScanner(config, provider);
        logger.info('[PoolScanner v1.3] PoolScanner fetcher initialization complete.'); // Confirmed v1.3 in logs
        // Pass finder settings from config
        this.spatialFinder = new SpatialFinder(config, this.config.FINDER_SETTINGS);
         // Initialize other finders if they exist and are needed
         // this.triangularV3Finder = new TriangularV3Finder(config, this.config.FINDER_SETTINGS); // Example


        // Initialize ProfitCalculator, passing required dependencies
        // Pass the flashSwapManager instance to ProfitCalculator <-- ADDED THIS PARAMETER
        this.profitCalculator = new ProfitCalculator(config, provider, swapSimulator, gasEstimator, flashSwapManager);


        // Initialize TradeHandler, passing required dependencies
        // Pass the flashSwapManager instance to TradeHandler
        this.tradeHandler = new TradeHandler(config, provider, flashSwapManager, this.profitCalculator); // Assuming TradeHandler constructor takes these


        // Event listeners map (Opportunity type -> Handler function)
        this.opportunityHandlers = {
            'spatial': this.tradeHandler.handleSpatialArbitrage.bind(this.tradeHandler),
            // Add other handlers as implemented
            // 'triangular': this.tradeHandler.handleTriangularArbitrage.bind(this.tradeHandler), // Example
        };

        // State variables
        this.isRunning = false;
        this.currentCycleTimeout = null; // To hold the timeout ID

        logger.info('[AE v1.7] ArbitrageEngine components initialized successfully.'); // Version bump
    }

    /**
     * Starts the main arbitrage cycle.
     */
    async start() {
        if (this.isRunning) {
            logger.info('[AE.start] Engine is already running.');
            return;
        }
        this.isRunning = true;
        logger.info('[AE.start] Attempting to start engine...');

        // Initial run cycle
        logger.debug('[AE.start] >>> Calling initial runCycle...');
        await this.runCycle();
        logger.debug('[AE.start] <<< Initial runCycle finished.');


        // Schedule subsequent cycles
        logger.debug('[AE.start] Setting up cycle interval...');
        this.currentCycleTimeout = setInterval(
            () => this.runCycle().catch(error => {
                 logger.error('[AE.runCycle] Uncaught error in cycle:', error);
                 handleError(error, 'ArbitrageEngine.runCycle'); // Centralized error handling
            }),
            this.config.CYCLE_INTERVAL_MS
        );

        logger.info(`[AE.start] Engine started successfully. Cycle interval: ${this.config.CYCLE_INTERVAL_MS}ms`);
         logger.info(`\n>>> BOT IS RUNNING <<<\n`);
         logger.info(`(Press Ctrl+C to stop)\n======================`);
    }

    /**
     * Stops the main arbitrage cycle.
     */
    stop() {
        if (!this.isRunning) {
            logger.info('[AE.stop] Engine is not running.');
            return;
        }
        clearInterval(this.currentCycleTimeout);
        this.isRunning = false;
        logger.info('[AE.stop] Engine stopped.');
         logger.info(`\n>>> BOT STOPPED <<<\n`);
         logger.info(`======================`);
    }

    /**
     * Executes one full cycle of scanning, finding, calculating, and dispatching trades.
     */
    async runCycle() {
        logger.debug('===== Starting New Cycle =====');
        const cycleStartTime = Date.now();

        try {
            // 1. Fetch latest pool data
            const fetchedPoolStates = await this._fetchPoolData();
            if (!fetchedPoolStates || fetchedPoolStates.length === 0) {
                logger.debug('[AE.runCycle] No pool states fetched in this cycle.');
            } else {
                // 2. Find potential arbitrage opportunities
                const potentialOpportunities = await this._findOpportunities(fetchedPoolStates);

                if (!potentialOpportunities || potentialOpportunities.length === 0) {
                     logger.debug('[AE.runCycle] No potential opportunities found in this cycle.');
                } else {
                    // 3. Calculate profitability and filter
                    const profitableOpportunities = await this._calculateProfitability(potentialOpportunities);

                    if (!profitableOpportunities || profitableOpportunities.length === 0) {
                         logger.debug(`[AE.runCycle] Opportunities found (${potentialOpportunities.length}) but none were profitable after calculation.`);
                    } else {
                        // 4. Dispatch profitable trades
                        await this._dispatchTrades(profitableOpportunities);
                    }
                }
            }

        } catch (error) {
            // Catch unexpected errors in the main cycle flow
             logger.error('[AE.runCycle] Uncaught error in main cycle flow:', error);
             handleError(error, 'ArbitrageEngine.runCycle'); // Use centralized handler
        } finally {
            const cycleDuration = Date.now() - cycleStartTime;
            logger.debug(`===== Cycle COMPLETED. Duration: ${cycleDuration}ms =====`);
        }
    }

    /**
     * Fetches the latest state for all configured pools.
     * @returns {Promise<Array<object>|null>} Array of pool state objects, or null on critical error.
     * @private
     */
    async _fetchPoolData() {
        logger.debug('[AE._fetchPoolData] Fetching pool states...');
        try {
            const poolStates = await this.poolScanner.fetchPoolStates(this.config.POOL_CONFIGS);
            logger.debug(`[AE._fetchPoolData] Fetched ${poolStates?.length || 0} pool states. Registry size: ${this.poolScanner.getPairRegistrySize()}`);
            return poolStates;
        } catch (error) {
            logger.error('[AE._fetchPoolData] Failed to fetch pool data:', error);
            handleError(error, 'ArbitrageEngine._fetchPoolData');
            return null; // Return null on failure
        }
    }

    /**
     * Analyzes pool states to find potential arbitrage opportunities.
     * @param {Array<object>} poolStates - Latest fetched pool state objects.
     * @returns {Promise<Array<object>>} Array of potential opportunity objects.
     * @private
     */
    async _findOpportunities(poolStates) {
        logger.debug('[AE._findOpportunities] Finding potential opportunities...');
        this.spatialFinder.updateRegistry(poolStates); // Update the finder's internal pool registry
         // this.triangularV3Finder.updateRegistry(poolStates); // Update other finders

        let potentialOpportunities = [];
        try {
            // Run Spatial Finder
            const spatialOpportunities = this.spatialFinder.findArbitrage(poolStates);
            logger.debug(`[AE._findOpportunities] SpatialFinder found ${spatialOpportunities?.length || 0} potentials.`);
            potentialOpportunities = potentialOpportunities.concat(spatialOpportunities);

            // Run other finders as implemented
            // const triangularOpportunities = this.triangularV3Finder.findArbitrage(poolStates);
            // logger.debug(`[AE._findOpportunities] TriangularV3Finder found ${triangularOpportunities?.length || 0} potentials.`);
            // potentialOpportunities = potentialOpportunities.concat(triangularOpportunities);

        } catch (error) {
            logger.error('[AE._findOpportunities] Error during opportunity finding:', error);
             handleError(error, 'ArbitrageEngine._findOpportunities');
             // Continue with any opportunities found before the error, or an empty array
        }

        logger.debug(`[AE._findOpportunities] Total potential opportunities found: ${potentialOpportunities.length}`);
        return potentialOpportunities;
    }

    /**
     * Calculates the estimated profitability for potential opportunities and filters them.
     * @param {Array<object>} potentialOpportunities - Array of potential opportunity objects.
     * @returns {Promise<Array<object>>} Array of profitable opportunity objects.
     * @private
     */
    async _calculateProfitability(potentialOpportunities) {
        logger.debug(`[AE._calculateProfitability] Calculating profitability for ${potentialOpportunities.length} opportunities...`);
        let profitableOpportunities = [];
        try {
             // Pass the signer address obtained via FlashSwapManager to the calculator
             const signerAddress = await this.flashSwapManager.getSignerAddress();
             if (!signerAddress) {
                 logger.error('[AE._calculateProfitability] Could not get signer address from FlashSwapManager. Cannot calculate profitability.');
                 // Return empty array, but do not throw here. The error is logged.
                 return [];
             }
             // Calculate method now gets signerAddress implicitly via its constructor/instance property
             profitableOpportunities = await this.profitCalculator.calculate(potentialOpportunities);

        } catch (error) {
            // This catch handles errors thrown by the ProfitCalculator itself (e.g., validation)
             logger.error('[AE._calculateProfitability] Error during profitability calculation:', error);
             handleError(error, 'ArbitrageEngine._calculateProfitability');
             // Return empty array on failure
        }

        return profitableOpportunities;
    }

    /**
     * Dispatches the profitable trades for execution.
     * @param {Array<object>} profitableOpportunities - Array of profitable opportunity objects.
     * @private
     */
    async _dispatchTrades(profitableOpportunities) {
        logger.info(`[AE._dispatchTrades] Found ${profitableOpportunities.length} profitable trades. Dispatching...`);

        // For now, just handle the first profitable opportunity and stop if configured.
        if (profitableOpportunities.length > 0) {
            const bestOpportunity = profitableOpportunities[0]; // Simple selection: take the first one

            // Pass the opportunity to the TradeHandler
            try {
                 await this.tradeHandler.handleTrade(bestOpportunity);
                 logger.info('[AE._dispatchTrades] Trade handling process completed.');

                 // Stop bot after first successful trade if configured
                 if (this.config.STOP_ON_FIRST_EXECUTION) {
                     logger.info('[AE._dispatchTrades] STOP_ON_FIRST_EXECUTION is true. Stopping engine.');
                     this.stop(); // Stop the cycle
                 }

            } catch (error) {
                 logger.error('[AE._dispatchTrades] Error handling trade:', error);
                 handleError(error, 'ArbitrageEngine._dispatchTrades');
                 // Continue to next cycle even if trade handling fails
            }
        }
    }
}

module.exports = ArbitrageEngine;
