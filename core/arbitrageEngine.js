// /workspaces/arbitrum-flash/core/arbitrageEngine.js
// --- VERSION UPDATED TO CALL RENAMED/NEW FINDERS FROM REFACTORED SCANNER ---
// Initializes parsed config, GasEstimator, ProfitCalculator

const { ethers } = require('ethers'); // Ethers v6+
const { PoolScanner } = require('./poolScanner'); // Import the REFACTORED PoolScanner
const GasEstimator = require('./gasEstimator');
const ProfitCalculator = require('./profitCalculator');
const logger = require('../utils/logger');
const ErrorHandler = require('../utils/errorHandler');
const FlashSwapManager = require('./flashSwapManager');
const { processOpportunity } = require('./opportunityProcessor');
const { ArbitrageError } = require('../utils/errorHandler');
const QuoteSimulator = require('./quoteSimulator');

class ArbitrageEngine {
    /**
     * @param {FlashSwapManager} manager Initialized FlashSwapManager instance.
     * @param {object} config The raw configuration object loaded from config/index.js (should include POOL_CONFIGS).
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
        // Updated check for POOL_CONFIGS array from refactored config loader
        const requiredConfigKeys = ['TICKLENS_ADDRESS', 'CHAIN_ID', 'CHAINLINK_FEEDS', 'MIN_PROFIT_THRESHOLD_ETH', 'MAX_GAS_GWEI', 'GAS_ESTIMATE_BUFFER_PERCENT', 'FALLBACK_GAS_LIMIT', 'PROFIT_BUFFER_PERCENT', 'POOL_CONFIGS'];
        const missingKeys = requiredConfigKeys.filter(key => !(key in config));
        if (missingKeys.length > 0) {
            throw new ArbitrageError('EngineInit', `Config object is missing required keys: ${missingKeys.join(', ')}`);
        }
        if (!Array.isArray(config.POOL_CONFIGS) || config.POOL_CONFIGS.length === 0) {
             throw new ArbitrageError('EngineInit', 'Config.POOL_CONFIGS is missing, empty, or not an array. Check config loading.');
        }
        // --- End Validation ---

        this.manager = manager;
        this.config = config; // Store raw config (now including POOL_CONFIGS directly)
        this.provider = manager.getProvider();
        this.signer = manager.getSigner();

        // --- Parse Config Values ---
        logger.debug('[Engine Constructor] Parsing configuration values...');
        try {
            const parsed = {
                minProfitWei: ethers.parseUnits(config.MIN_PROFIT_THRESHOLD_ETH, 'ether'),
                maxGasWei: ethers.parseUnits(config.MAX_GAS_GWEI, 'gwei'),
                gasEstimateBufferPercent: parseInt(config.GAS_ESTIMATE_BUFFER_PERCENT, 10),
                profitBufferPercent: parseInt(config.PROFIT_BUFFER_PERCENT, 10),
                fallbackGasLimit: config.FALLBACK_GAS_LIMIT,
                nativeDecimals: config.NATIVE_DECIMALS || 18,
                nativeSymbol: config.NATIVE_SYMBOL || 'ETH',
                wrappedNativeSymbol: config.WRAPPED_NATIVE_SYMBOL || 'WETH'
            };
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

            logger.debug('[Engine Constructor] Initializing REFACTORED PoolScanner...');
            // Ensure PoolScanner uses ethers v6 compatible syntax if needed
            this.poolScanner = new PoolScanner(this.config, this.provider); // Uses the refactored scanner

            logger.debug('[Engine Constructor] Initializing GasEstimator...');
            this.gasEstimator = new GasEstimator(this.provider, {
                GAS_ESTIMATE_BUFFER_PERCENT: this.config.parsed.gasEstimateBufferPercent,
                FALLBACK_GAS_LIMIT: this.config.parsed.fallbackGasLimit
            });

            logger.debug('[Engine Constructor] Initializing ProfitCalculator...');
            this.profitCalculator = new ProfitCalculator({
                minProfitWei: this.config.parsed.minProfitWei,
                PROFIT_BUFFER_PERCENT: this.config.parsed.profitBufferPercent,
                provider: this.provider,
                chainlinkFeeds: this.config.CHAINLINK_FEEDS,
                nativeDecimals: this.config.parsed.nativeDecimals,
                nativeSymbol: this.config.parsed.nativeSymbol,
                WRAPPED_NATIVE_SYMBOL: this.config.parsed.wrappedNativeSymbol
            });

        } catch (initError) {
            logger.fatal(`[Engine Constructor] Failed to initialize core component: ${initError.message}`, initError);
            throw initError;
        }
        // --- End Instance Initialization ---

        this.isRunning = false;
        this.isCycleRunning = false;
        this.cycleCount = 0;
        this.cycleInterval = parseInt(this.config.CYCLE_INTERVAL_MS || '5000', 10);
        this.intervalId = null;

        logger.info('[Engine Constructor] Arbitrage Engine Constructor Finished Successfully.');
    }

    async initialize() {
        logger.info('[Engine] Arbitrage Engine Initializing (post-constructor)...');
        try {
            if (this.signer && typeof this.signer.initialize === 'function') {
                await this.signer.initialize();
                logger.info(`[Engine] Nonce Manager initialized via Engine. Initial Nonce: ${await this.signer.getNextNonce()}`);
            } else { logger.warn('[Engine] Signer does not have an initialize method.'); }
        } catch (nonceError) {
            logger.error(`[Engine] Failed to initialize Nonce Manager: ${nonceError.message}`, nonceError);
            throw new ArbitrageError('EngineInit', `Nonce Manager initialization failed: ${nonceError.message}`, nonceError);
        }
         logger.info('[Engine] Arbitrage Engine Initialized Successfully.');
    }

    start() {
        if (this.isRunning) { logger.warn('[Engine] Engine already running.'); return; }
        this.isRunning = true;
        logger.info(`[Engine] Starting arbitrage monitoring loop for Network: ${this.config.NETWORK || this.config.NAME}...`);
        logger.info(`[Engine] Cycle Interval: ${this.cycleInterval / 1000} seconds.`);
        setImmediate(() => { if (this.isRunning) this.runCycle(); });
        this.intervalId = setInterval(() => {
            if (!this.isRunning) {
                logger.info('[Engine] Engine stopped, clearing interval.');
                if (this.intervalId) clearInterval(this.intervalId);
                this.intervalId = null; return;
            }
             if (this.isCycleRunning) { logger.warn(`[Engine] Previous cycle still running. Skipping interval tick.`); return; }
             this.runCycle();
        }, this.cycleInterval);
        logger.info('>>> Engine started. Monitoring for opportunities... (Press Ctrl+C to stop) <<<');
    }

    stop() {
        if (!this.isRunning) { logger.warn('[Engine] Engine not running.'); return; }
        logger.info('[Engine] Stopping Arbitrage Engine...');
        this.isRunning = false;
        if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; logger.info('[Engine] Cycle interval cleared.'); }
        logger.info('[Engine] Stop signal sent. Any running cycle will attempt to complete.');
    }

    // --- Updated runCycle ---
    async runCycle() {
        if (!this.isRunning) { logger.debug('[Engine] runCycle called but engine is stopped.'); return; }
        if (this.isCycleRunning) { logger.warn('[Engine] Attempted to start runCycle while previous cycle running.'); return; }

        this.isCycleRunning = true;
        this.cycleCount++;
        const cycleStartTime = Date.now();
        logger.info(`\n===== [Engine] Starting Cycle #${this.cycleCount} =====`);

        try {
            // 1. Get Pool List from Config (Now uses POOL_CONFIGS directly)
            const poolInfosToFetch = this.config.POOL_CONFIGS; // Use the processed list from config
            if (!Array.isArray(poolInfosToFetch) || poolInfosToFetch.length === 0) {
                logger.warn('[Engine] Config.POOL_CONFIGS is missing or empty. Check config loading.');
                this.logCycleEnd(cycleStartTime, true); // Mark cycle as having an error
                this.isCycleRunning = false; return;
            }

            // 2. Fetch Live Pool States (Uses refactored PoolScanner)
            logger.debug(`[Engine] Fetching states for ${poolInfosToFetch.length} pools via refactored scanner...`);
            const livePoolStatesMap = await this.poolScanner.fetchPoolStates(poolInfosToFetch); // Scanner handles delegation
            const fetchedCount = livePoolStatesMap ? Object.keys(livePoolStatesMap).length : 0;
            if (fetchedCount === 0) {
                logger.warn('[Engine] Failed to fetch any live pool states in this cycle.');
                // Don't necessarily stop the engine, just log and end cycle
                this.logCycleEnd(cycleStartTime);
                this.isCycleRunning = false; return;
             }
            logger.info(`[Engine] Fetched ${fetchedCount} live pool states (V3 & Sushi).`);

            // 3. Find Opportunities (Both Types)
            logger.debug('[Engine] Finding potential opportunities (Triangular & Spatial)...');
            // --- *** CORRECTLY CALL RENAMED FUNCTION *** ---
            const triangularOpportunities = this.poolScanner.findTriangularOpportunities(livePoolStatesMap);
            // --- Call Spatial Finder ---
            const spatialOpportunities = this.poolScanner.findSpatialOpportunities(livePoolStatesMap);
            // --- Combine ---
            const potentialOpportunities = [...triangularOpportunities, ...spatialOpportunities];

            if (potentialOpportunities.length === 0) {
                logger.info('[Engine] No potential V3 Triangular or Spatial opportunities found in this cycle.');
                this.logCycleEnd(cycleStartTime);
                this.isCycleRunning = false; return;
            }
            logger.info(`[Engine] Found ${potentialOpportunities.length} potential opportunities (${triangularOpportunities.length} Tri, ${spatialOpportunities.length} Spatial). Processing...`);

            // --- 4. Process Opportunities ---
            let executedThisCycle = false;
            const engineContext = {
                config: this.config,
                manager: this.manager,
                gasEstimator: this.gasEstimator,
                profitCalculator: this.profitCalculator,
                quoteSimulator: this.quoteSimulator,
                logger: logger
            };

            for (const opp of potentialOpportunities) {
                if (!this.isRunning) { logger.info(`[Engine Cycle ${this.cycleCount}] Engine stopped during opportunity processing.`); break; }
                const stopAfterFirst = this.config.STOP_ON_FIRST_EXECUTION === true || this.config.STOP_ON_FIRST_EXECUTION === 'true';
                if (executedThisCycle && stopAfterFirst) {
                     logger.info(`[Engine Cycle ${this.cycleCount}] Skipping remaining opportunities as one was executed and STOP_ON_FIRST_EXECUTION is true.`);
                     break;
                 }

                const logPrefix = `[Engine Cycle ${this.cycleCount}, Opp Type: ${opp?.type || 'N/A'}]`;
                logger.info(`${logPrefix} Processing opportunity: ${opp?.groupName || opp?.pathSymbols?.join('->')}`);

                // --- IMPORTANT: Opportunity Processor needs update later ---
                // It will likely fail on 'spatial' type until processor is updated
                const processResult = await processOpportunity(opp, engineContext);

                // Handle result
                if (processResult.executed && processResult.success) {
                    logger.info(`${logPrefix} Opportunity processed and SUCCESSFULLY ${this.config.DRY_RUN ? 'DRY RUN' : 'EXECUTED'}. Tx: ${processResult.txHash}`);
                    executedThisCycle = true;
                }
                else if (processResult.executed && !processResult.success) {
                    logger.warn(`${logPrefix} Opportunity processed but execution FAILED. Tx: ${processResult.txHash || 'N/A'}, Error: ${processResult.error?.message}`);
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
