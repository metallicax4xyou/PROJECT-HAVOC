// /workspaces/arbitrum-flash/core/arbitrageEngine.js
// --- VERSION UPDATED FOR ETHERS V6 UTILS & PHASE 1 REFACTOR ---
// Initializes parsed config, new GasEstimator, new ProfitCalculator

const { ethers } = require('ethers'); // Ethers v6+
const { PoolScanner } = require('./poolScanner');
const GasEstimator = require('./gasEstimator'); // Import new GasEstimator class
const ProfitCalculator = require('./profitCalculator'); // Import new ProfitCalculator class
const logger = require('../utils/logger');
const ErrorHandler = require('../utils/errorHandler');
const FlashSwapManager = require('./flashSwapManager');
const { processOpportunity } = require('./opportunityProcessor'); // Ensure this uses v6 syntax if needed
const { ArbitrageError } = require('../utils/errorHandler');
const QuoteSimulator = require('./quoteSimulator'); // Keep QuoteSimulator import

class ArbitrageEngine {
    /**
     * @param {FlashSwapManager} manager Initialized FlashSwapManager instance.
     * @param {object} config The raw configuration object loaded from config/index.js.
     */
    constructor(manager, config) {
        logger.info('[Engine Constructor] Initializing ArbitrageEngine...');

        // --- Validate Inputs ---
        if (!manager || !(manager instanceof FlashSwapManager)) {
            throw new ArbitrageError('EngineInit', 'Invalid FlashSwapManager instance received.');
        }
        if (!config) {
            throw new ArbitrageError('EngineInit', 'Config object is required.');
        }
        // Add essential config checks early
        const requiredConfigKeys = ['TICKLENS_ADDRESS', 'CHAIN_ID', 'CHAINLINK_FEEDS', 'MIN_PROFIT_THRESHOLD_ETH', 'MAX_GAS_GWEI', 'GAS_ESTIMATE_BUFFER_PERCENT', 'FALLBACK_GAS_LIMIT', 'PROFIT_BUFFER_PERCENT'];
        const missingKeys = requiredConfigKeys.filter(key => !(key in config));
        if (missingKeys.length > 0) {
            throw new ArbitrageError('EngineInit', `Config object is missing required keys: ${missingKeys.join(', ')}`);
        }
        // --- End Validation ---

        this.manager = manager;
        this.config = config; // Store raw config
        this.provider = manager.getProvider();
        this.signer = manager.getSigner();

        // --- Parse Config Values ---
        logger.debug('[Engine Constructor] Parsing configuration values...');
        try {
            // --- Use ethers v6 top-level functions ---
            const parsed = {
                minProfitWei: ethers.parseUnits(config.MIN_PROFIT_THRESHOLD_ETH, 'ether'),
                maxGasWei: ethers.parseUnits(config.MAX_GAS_GWEI, 'gwei'),
                // --- ---
                // Keep buffer percentages as numbers for direct use
                gasEstimateBufferPercent: parseInt(config.GAS_ESTIMATE_BUFFER_PERCENT, 10),
                profitBufferPercent: parseInt(config.PROFIT_BUFFER_PERCENT, 10),
                // Keep fallback limit as string for GasEstimator constructor
                fallbackGasLimit: config.FALLBACK_GAS_LIMIT,
                nativeDecimals: config.NATIVE_DECIMALS || 18, // Use default if not provided
                nativeSymbol: config.NATIVE_SYMBOL || 'ETH',   // Use default if not provided
                wrappedNativeSymbol: config.WRAPPED_NATIVE_SYMBOL || 'WETH' // Added for ProfitCalculator
            };
            // Attach parsed values to the config object for easy access
            this.config.parsed = parsed;
            logger.info(`[Engine Constructor] Parsed Config: MinProfit=${config.MIN_PROFIT_THRESHOLD_ETH} ETH, MaxGas=${config.MAX_GAS_GWEI} Gwei`);

        } catch (parseError) {
            logger.error(`[Engine Constructor] Failed to parse config values: ${parseError.message}`, parseError);
            throw new ArbitrageError('EngineInit', `Failed to parse configuration values: ${parseError.message}`, parseError);
        }
        // --- End Config Parsing ---


        // --- Initialize Core Component Instances ---
        try {
            logger.debug('[Engine Constructor] Initializing QuoteSimulator...');
            this.quoteSimulator = new QuoteSimulator(
                this.config.TICKLENS_ADDRESS,
                this.provider,
                this.config.CHAIN_ID
            );

            logger.debug('[Engine Constructor] Initializing PoolScanner...');
            // Ensure PoolScanner uses ethers v6 compatible syntax if needed
            this.poolScanner = new PoolScanner(this.config, this.provider);

            logger.debug('[Engine Constructor] Initializing GasEstimator...');
            // Instantiate NEW GasEstimator, passing provider and specific config values
            this.gasEstimator = new GasEstimator(this.provider, {
                GAS_ESTIMATE_BUFFER_PERCENT: this.config.parsed.gasEstimateBufferPercent,
                FALLBACK_GAS_LIMIT: this.config.parsed.fallbackGasLimit // Pass the string value
            });

            logger.debug('[Engine Constructor] Initializing ProfitCalculator...');
            // Instantiate ProfitCalculator, passing necessary parsed and raw config values
            this.profitCalculator = new ProfitCalculator({
                minProfitWei: this.config.parsed.minProfitWei, // Pass BigInt
                PROFIT_BUFFER_PERCENT: this.config.parsed.profitBufferPercent, // Pass number
                provider: this.provider,
                chainlinkFeeds: this.config.CHAINLINK_FEEDS,
                nativeDecimals: this.config.parsed.nativeDecimals,
                nativeSymbol: this.config.parsed.nativeSymbol,
                WRAPPED_NATIVE_SYMBOL: this.config.parsed.wrappedNativeSymbol // Pass wrapped symbol
            });

        } catch (initError) {
            logger.fatal(`[Engine Constructor] Failed to initialize core component: ${initError.message}`, initError);
            // Re-throw to prevent engine from starting in broken state
            throw initError;
        }
        // --- End Instance Initialization ---

        this.isRunning = false;
        this.isCycleRunning = false; // Flag to prevent cycle overlap
        this.cycleCount = 0;
        this.cycleInterval = parseInt(this.config.CYCLE_INTERVAL_MS || '5000', 10); // Ensure integer, default 5 seconds
        this.intervalId = null; // Store interval timer ID

        logger.info('[Engine Constructor] Arbitrage Engine Constructor Finished Successfully.');
    }

    async initialize() {
        logger.info('[Engine] Arbitrage Engine Initializing (post-constructor)...');
        try {
            if (this.signer && typeof this.signer.initialize === 'function') {
                await this.signer.initialize();
                // Log initial nonce AFTER initialization
                logger.info(`[Engine] Nonce Manager initialized via Engine. Initial Nonce: ${await this.signer.getNextNonce()}`);
            } else {
                logger.warn('[Engine] Signer does not have an initialize method (expected for NonceManager).');
            }
        } catch (nonceError) {
            logger.error(`[Engine] Failed to initialize Nonce Manager during engine init: ${nonceError.message}`, nonceError);
            throw new ArbitrageError('EngineInit', `Nonce Manager initialization failed: ${nonceError.message}`, nonceError);
        }
         logger.info('[Engine] Arbitrage Engine Initialized Successfully.');
    }

    async start() {
        if (this.isRunning) { logger.warn('[Engine] Engine already running.'); return; }
        this.isRunning = true;
        logger.info(`[Engine] Starting arbitrage monitoring loop for Network: ${this.config.NETWORK || this.config.NAME}...`); // Use loaded network name
        logger.info(`[Engine] Cycle Interval: ${this.cycleInterval / 1000} seconds.`);

        // Use setImmediate for the first run, then setInterval
        setImmediate(() => {
            if (this.isRunning) this.runCycle(); // Check running status before first run
        });

        this.intervalId = setInterval(() => {
            if (!this.isRunning) { // Check if stopped
                logger.info('[Engine] Engine stopped, clearing interval.');
                if (this.intervalId) clearInterval(this.intervalId);
                this.intervalId = null;
                return;
            }
             if (this.isCycleRunning) { // Prevent overlap
                  logger.warn(`[Engine] Previous cycle still running. Skipping interval tick.`);
                  return;
             }
             this.runCycle();
        }, this.cycleInterval);

        logger.info('>>> Engine started. Monitoring for opportunities... (Press Ctrl+C to stop) <<<');
    }

    stop() {
        if (!this.isRunning) { logger.warn('[Engine] Engine not running.'); return; }
        logger.info('[Engine] Stopping Arbitrage Engine...');
        this.isRunning = false; // Signal runCycle and interval to stop
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
            logger.info('[Engine] Cycle interval cleared.');
        }
        // Consider adding a short delay or mechanism to ensure the current cycle finishes if needed
        logger.info('[Engine] Stop signal sent. Any running cycle will attempt to complete.');
    }

    // --- Refactored runCycle ---
    async runCycle() {
        // Double-check running status at the start of the cycle
        if (!this.isRunning) { logger.debug('[Engine] runCycle called but engine is stopped.'); return; }
        // Prevent overlap
        if (this.isCycleRunning) { logger.warn('[Engine] Attempted to start runCycle while previous cycle running.'); return; }

        this.isCycleRunning = true; // Mark cycle as running
        this.cycleCount++;
        const cycleStartTime = Date.now();
        logger.info(`\n===== [Engine] Starting Cycle #${this.cycleCount} =====`);

        try {
            // 1. Get Pool List from Config
            // Ensure config.getAllPoolConfigs exists and returns the expected format
            const poolInfosToFetch = typeof this.config.getAllPoolConfigs === 'function' ? this.config.getAllPoolConfigs() : [];
            if (!Array.isArray(poolInfosToFetch) || poolInfosToFetch.length === 0) {
                logger.warn('[Engine] No valid pool configurations loaded or getAllPoolConfigs method missing. Check config setup.');
                this.logCycleEnd(cycleStartTime);
                this.isCycleRunning = false; // Ensure flag is reset
                return;
            }

            // 2. Fetch Live Pool States
            logger.debug(`[Engine] Fetching states for ${poolInfosToFetch.length} pools...`);
            const livePoolStatesMap = await this.poolScanner.fetchPoolStates(poolInfosToFetch);
            const fetchedCount = livePoolStatesMap ? Object.keys(livePoolStatesMap).length : 0;
            if (fetchedCount === 0) {
                logger.warn('[Engine] Failed to fetch any live pool states in this cycle.');
                this.logCycleEnd(cycleStartTime, true); // Mark cycle as having an error
                this.isCycleRunning = false; // Ensure flag is reset
                return;
             }
            logger.info(`[Engine] Fetched ${fetchedCount} live pool states.`);

            // 3. Find Opportunities
            logger.debug('[Engine] Finding potential opportunities...');
            const potentialOpportunities = this.poolScanner.findOpportunities(livePoolStatesMap);
            if (potentialOpportunities.length === 0) {
                logger.info('[Engine] No potential opportunities found in this cycle.');
                this.logCycleEnd(cycleStartTime);
                this.isCycleRunning = false; // Ensure flag is reset
                return;
            }
            logger.info(`[Engine] Found ${potentialOpportunities.length} potential opportunities. Processing...`);

            // --- 4. Process Opportunities ---
            let executedThisCycle = false;

            // Create the context object with INITIALIZED instances
            const engineContext = {
                config: this.config, // Pass the config object (contains raw + parsed)
                manager: this.manager,
                gasEstimator: this.gasEstimator, // Pass the initialized GasEstimator instance
                profitCalculator: this.profitCalculator, // Pass the initialized ProfitCalculator instance
                quoteSimulator: this.quoteSimulator, // Pass the initialized QuoteSimulator instance
                logger: logger // Pass the global logger
            };

            for (const opp of potentialOpportunities) {
                if (!this.isRunning) { logger.info(`[Engine Cycle ${this.cycleCount}] Engine stopped during opportunity processing.`); break; }
                // Check stop condition based on config
                const stopAfterFirst = this.config.STOP_ON_FIRST_EXECUTION === true || this.config.STOP_ON_FIRST_EXECUTION === 'true';
                if (executedThisCycle && stopAfterFirst) {
                     logger.info(`[Engine Cycle ${this.cycleCount}] Skipping remaining opportunities as one was executed and STOP_ON_FIRST_EXECUTION is true.`);
                     break;
                 }

                const logPrefix = `[Engine Cycle ${this.cycleCount}, OppID: ${opp?.id || 'N/A'}]`;
                logger.info(`${logPrefix} Processing opportunity: ${opp?.pathSymbols?.join('->') || opp?.groupName}`);

                // Call the Opportunity Processor with the constructed context
                const processResult = await processOpportunity(opp, engineContext);

                // Handle result
                if (processResult.executed && processResult.success) {
                    logger.info(`${logPrefix} Opportunity processed and SUCCESSFULLY ${this.config.DRY_RUN ? 'DRY RUN' : 'EXECUTED'}. Tx: ${processResult.txHash}`);
                    executedThisCycle = true; // Mark execution happened
                }
                else if (processResult.executed && !processResult.success) {
                    logger.warn(`${logPrefix} Opportunity processed but execution FAILED. Tx: ${processResult.txHash || 'N/A'}, Error: ${processResult.error?.message}`);
                    // Optional: Decide if a failed *attempt* should also stop the cycle based on config
                    // if (stopAfterFirst) executedThisCycle = true;
                }
                else if (processResult.error) {
                     logger.warn(`${logPrefix} Opportunity processing failed before execution attempt. Error: ${processResult.error.message} (Type: ${processResult.error.type})`);
                     if (processResult.error.details) logger.debug(`${logPrefix} Error details:`, processResult.error.details);
                 }
                else {
                     logger.info(`${logPrefix} Opportunity processing completed without execution (Reason: ${processResult.reason || 'N/A'}).`);
                 }

            } // End opportunity processing loop

            this.logCycleEnd(cycleStartTime);

        } catch (error) { // Catch errors in the main cycle logic
            logger.error(`[Engine] Critical error during cycle #${this.cycleCount}: ${error.message}`, error);
            if (typeof ErrorHandler.handleError === 'function') {
                 ErrorHandler.handleError(error, `Engine.runCycle (${this.cycleCount})`);
            }
            if (error.stack) { logger.error(`Stack Trace: ${error.stack}`); }
            this.logCycleEnd(cycleStartTime, true); // Mark cycle as having an error
        } finally {
             this.isCycleRunning = false; // IMPORTANT: Ensure flag is reset even if errors occur
        }
    } // End runCycle

    logCycleEnd(startTime, hadError = false) {
        const duration = Date.now() - startTime;
        logger.info(`===== [Engine] Cycle #${this.cycleCount} Finished (${duration}ms) ${hadError ? '[WITH ERROR]' : '[OK]'} =====`);
    }
}

module.exports = { ArbitrageEngine };
