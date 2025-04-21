// /workspaces/arbitrum-flash/core/arbitrageEngine.js
// --- VERSION 1.10: Correctly pass provider/feeds to ProfitCalculator ---

const { ethers } = require('ethers');
const { PoolScanner } = require('./poolScanner');
const GasEstimator = require('./gasEstimator');
const ProfitCalculator = require('./profitCalculator');
const logger = require('../utils/logger');
const ErrorHandler = require('../utils/errorHandler');
const FlashSwapManager = require('./flashSwapManager');
const { processOpportunity } = require('./opportunityProcessor'); // Assuming this is needed later
const { ArbitrageError } = require('../utils/errorHandler');
const QuoteSimulator = require('./quoteSimulator');

// --- Import Finder Classes ---
const TriangularV3Finder = require('./finders/triangularV3Finder');
const SpatialFinder = require('./finders/spatialFinder');
// --- ---

class ArbitrageEngine {
    constructor(manager, config) {
        logger.info('[Engine Constructor] Initializing ArbitrageEngine...');
        // --- Validation ---
        if (!manager || !(manager instanceof FlashSwapManager)) { throw new ArbitrageError('EngineInit', 'Invalid Manager passed to Engine constructor'); }
        if (!config) { throw new ArbitrageError('EngineInit', 'Config object required for Engine'); }

        const requiredConfigKeys = [
            'POOL_CONFIGS', 'CYCLE_INTERVAL_MS', 'MIN_PROFIT_THRESHOLDS',
            'MAX_GAS_GWEI', 'GAS_ESTIMATE_BUFFER_PERCENT', 'FALLBACK_GAS_LIMIT',
            'PROFIT_BUFFER_PERCENT', 'DRY_RUN', 'STOP_ON_FIRST_EXECUTION',
            'CHAINLINK_FEEDS', 'NATIVE_CURRENCY_SYMBOL'
        ];
        const missingKeys = requiredConfigKeys.filter(key => !(key in config));
        if (missingKeys.length > 0) { throw new ArbitrageError('EngineInit', `Missing required config keys: ${missingKeys.join(', ')}`); }
        if (!Array.isArray(config.POOL_CONFIGS) || config.POOL_CONFIGS.length === 0) { throw new ArbitrageError('EngineInit', 'Config.POOL_CONFIGS must be a non-empty array'); }
        if (typeof config.MIN_PROFIT_THRESHOLDS !== 'object' || !config.MIN_PROFIT_THRESHOLDS.DEFAULT || !config.MIN_PROFIT_THRESHOLDS.NATIVE) {
            throw new ArbitrageError('EngineInit', 'Config.MIN_PROFIT_THRESHOLDS must be an object with DEFAULT and NATIVE keys.');
        }


        this.manager = manager;
        this.config = config; // Store the whole config
        this.provider = manager.getProvider(); // Get provider instance
        this.signer = manager.getSigner();

        // --- Parse Config Values (Simplified) ---
        logger.debug('[Engine Constructor] Parsing configuration values...');
        try {
            this.config.parsed = {
                 maxGasGweiParsed: parseFloat(config.MAX_GAS_GWEI || '0.5'),
                 gasEstimateBufferPercent: parseInt(config.GAS_ESTIMATE_BUFFER_PERCENT || '20', 10),
                 fallbackGasLimitParsed: BigInt(config.FALLBACK_GAS_LIMIT || '3000000'),
            };
             if (isNaN(this.config.parsed.maxGasGweiParsed) || this.config.parsed.maxGasGweiParsed <= 0) { throw new Error('Invalid MAX_GAS_GWEI value'); }
             logger.debug('[Engine Constructor] Config parsing complete.');
        } catch (parseError) {
            logger.error('[Engine Constructor] CRITICAL: Failed to parse configuration values.', parseError);
            throw new ArbitrageError('EngineInit', `Config Parsing Error: ${parseError.message}`);
         }

        // --- Initialize Core Component Instances ---
        try {
            logger.debug('[Engine Constructor] Initializing QuoteSimulator...');
            // Pass provider and config needed by QuoteSimulator
            this.quoteSimulator = new QuoteSimulator(this.provider, this.config);

            logger.debug('[Engine Constructor] Initializing SIMPLIFIED PoolScanner...');
            // Pass config and provider needed by PoolScanner
            this.poolScanner = new PoolScanner(this.config, this.provider);

            logger.debug('[Engine Constructor] Initializing GasEstimator...');
            // Pass provider and config needed by GasEstimator
            this.gasEstimator = new GasEstimator(this.provider, this.config);

            // --- Initialize ProfitCalculator ---
            logger.debug('[Engine Constructor] Initializing ProfitCalculator...');
            // *** REVERTED: Pass necessary config keys explicitly + provider ***
            const profitCalcConfig = {
                MIN_PROFIT_THRESHOLDS: config.MIN_PROFIT_THRESHOLDS, // Pass the threshold object
                PROFIT_BUFFER_PERCENT: config.PROFIT_BUFFER_PERCENT, // Pass buffer percent
                provider: this.provider, // Pass the provider instance
                chainlinkFeeds: config.CHAINLINK_FEEDS, // Pass chainlink feeds from config
                NATIVE_CURRENCY_SYMBOL: config.NATIVE_CURRENCY_SYMBOL, // Pass native symbol
                WRAPPED_NATIVE_SYMBOL: config.WRAPPED_NATIVE_SYMBOL || 'WETH' // Pass wrapped symbol (optional)
                // Note: nativeDecimals is derived inside ProfitCalculator now
            };
            this.profitCalculator = new ProfitCalculator(profitCalcConfig); // Initialize with specific config object

            // --- Instantiate Finder Classes ---
            logger.debug('[Engine Constructor] Initializing Opportunity Finders...');
            this.triangularV3Finder = new TriangularV3Finder();
            this.spatialFinder = new SpatialFinder();
            logger.debug('[Engine Constructor] Core component initialization complete.');
        } catch (initError) {
            logger.error('[Engine Constructor] CRITICAL: Failed to initialize core components.', initError);
            throw new ArbitrageError('EngineInit', `Component Init Error in ${initError.constructor?.name || 'UnknownComponent'}: ${initError.message}`);
        }

        // --- State variables ---
        this.isRunning = false; this.isCycleRunning = false; this.cycleCount = 0;
        this.cycleInterval = parseInt(this.config.CYCLE_INTERVAL_MS || '5000', 10);
        this.intervalId = null;
        logger.info('[Engine Constructor] Arbitrage Engine Constructor Finished Successfully.');
    }

    // --- initialize() method ---
    async initialize() { /* ... unchanged ... */ } // Keep unchanged

    // --- start() method ---
    start() { /* ... unchanged ... */ } // Keep unchanged

    // --- stop() method ---
    stop() { /* ... unchanged ... */ } // Keep unchanged

    // --- runCycle() method ---
    async runCycle() { /* ... unchanged ... */ } // Keep unchanged

    // --- logCycleEnd() method ---
     logCycleEnd(cycleNum, startTime, fetchedPoolCount, executed = false, hadError = false) { /* ... unchanged ... */ } // Keep unchanged
}

module.exports = { ArbitrageEngine };
