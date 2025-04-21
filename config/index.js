// config/index.js
// --- VERSION WITH DEBUG LOGS BEFORE EXPORT ---

require('dotenv').config();
const { ethers } = require('ethers');
const { Token } = require('@uniswap/sdk-core'); // Assuming this is still needed somewhere
let logger; try { logger = require('../utils/logger'); } catch (e) { console.error("No logger"); logger = console; }

const ConfigHelpers = require('./helpers'); // Assuming ./helpers/index.js exports { Validators, PoolProcessing }
const { getNetworkMetadata } = require('./networks');
const { PROTOCOL_ADDRESSES } = require('../constants/addresses'); // Assuming paths are correct
const { TOKENS } = require('../constants/tokens');

function loadConfig() {
    logger.debug('[loadConfig] Starting loadConfig function...');
    const networkName = process.env.NETWORK?.toLowerCase();
    if (!networkName) { throw new Error(`[Config] CRITICAL: Missing NETWORK environment variable.`); }

    // --- Validate Core Env Vars ---
    const rpcUrlsEnvKey = `${networkName.toUpperCase()}_RPC_URLS`;
    const validatedRpcUrls = ConfigHelpers.Validators.validateRpcUrls(process.env[rpcUrlsEnvKey], rpcUrlsEnvKey);
    const validatedPrivateKey = ConfigHelpers.Validators.validatePrivateKey(process.env.PRIVATE_KEY, 'PRIVATE_KEY');
    const flashSwapEnvKey = `${networkName.toUpperCase()}_FLASH_SWAP_ADDRESS`;
    const validatedFlashSwapAddress = ConfigHelpers.Validators.validateAndNormalizeAddress(process.env[flashSwapEnvKey], flashSwapEnvKey);
    const tickLensEnvKey = `${networkName.toUpperCase()}_TICKLENS_ADDRESS`;
    const validatedTickLensAddress = ConfigHelpers.Validators.validateAndNormalizeAddress(process.env[tickLensEnvKey], tickLensEnvKey);
     // Parse Boolean Flags (assuming parseBoolean handles 'true'/'false' strings)
     const uniswapV3Enabled = ConfigHelpers.Validators.parseBoolean(process.env.UNISWAP_V3_ENABLED, false);
     const sushiswapEnabled = ConfigHelpers.Validators.parseBoolean(process.env.SUSHISWAP_ENABLED, false);
     const dodoEnabled = ConfigHelpers.Validators.parseBoolean(process.env.DODO_ENABLED, false);


    const networkMetadata = getNetworkMetadata(networkName);
    if (!networkMetadata) { throw new Error(`[Config] CRITICAL: No metadata for network: ${networkName}`); }
    logger.info(`[Config] Loaded metadata for network: ${networkMetadata.NAME} (ChainID: ${networkMetadata.CHAIN_ID})`);

    let networkSpecificConfig;
    try {
        networkSpecificConfig = require(`./${networkName}.js`);
        logger.log(`[Config] Loaded ./${networkName}.js`);
    } catch (e) { throw new Error(`[Config] CRITICAL: Failed to load config/${networkName}.js: ${e.message}`); }

    // Other Env Vars
    const cycleIntervalMs = ConfigHelpers.Validators.safeParseInt(process.env.CYCLE_INTERVAL_MS, 'CYCLE_INTERVAL_MS', 5000);
    const slippageToleranceBps = ConfigHelpers.Validators.safeParseInt(process.env.SLIPPAGE_TOLERANCE_BPS, 'SLIPPAGE_TOLERANCE_BPS', 10);
    const isDryRun = ConfigHelpers.Validators.parseBoolean(process.env.DRY_RUN, true); // Default DRY_RUN to true
    const stopOnFirst = ConfigHelpers.Validators.parseBoolean(process.env.STOP_ON_FIRST_EXECUTION, false);
    const maxGasGwei = ConfigHelpers.Validators.safeParseInt(process.env.MAX_GAS_GWEI, 'MAX_GAS_GWEI', 10); // Example default
     const gasBufferPercent = ConfigHelpers.Validators.safeParseInt(process.env.GAS_ESTIMATE_BUFFER_PERCENT, 'GAS_ESTIMATE_BUFFER_PERCENT', 20); // Example default
     const fallbackGasLimit = ConfigHelpers.Validators.safeParseInt(process.env.FALLBACK_GAS_LIMIT, 'FALLBACK_GAS_LIMIT', 1500000); // Example default
     const profitBufferPercent = ConfigHelpers.Validators.safeParseInt(process.env.PROFIT_BUFFER_PERCENT, 'PROFIT_BUFFER_PERCENT', 5); // Example default


    const baseConfig = {
        NAME: networkMetadata.NAME, CHAIN_ID: networkMetadata.CHAIN_ID, NATIVE_CURRENCY_SYMBOL: networkMetadata.NATIVE_SYMBOL, EXPLORER_URL: networkMetadata.EXPLORER_URL,
        TOKENS: TOKENS,
        RPC_URLS: validatedRpcUrls, PRIMARY_RPC_URL: validatedRpcUrls[0], PRIVATE_KEY: validatedPrivateKey, FLASH_SWAP_CONTRACT_ADDRESS: validatedFlashSwapAddress || ethers.ZeroAddress, TICKLENS_ADDRESS: validatedTickLensAddress || ethers.ZeroAddress,
        // Add parsed env vars
        CYCLE_INTERVAL_MS: cycleIntervalMs, SLIPPAGE_TOLERANCE_BPS: slippageToleranceBps, DRY_RUN: isDryRun, STOP_ON_FIRST_EXECUTION: stopOnFirst,
        // Add DEX enable flags directly from parsed env vars
         UNISWAP_V3_ENABLED: uniswapV3Enabled,
         SUSHISWAP_ENABLED: sushiswapEnabled,
         DODO_ENABLED: dodoEnabled,
         // Add other parsed settings
         MAX_GAS_GWEI: maxGasGwei,
         GAS_ESTIMATE_BUFFER_PERCENT: gasBufferPercent,
         FALLBACK_GAS_LIMIT: fallbackGasLimit,
         PROFIT_BUFFER_PERCENT: profitBufferPercent,
         // Add protocol addresses
        FACTORY_ADDRESS: PROTOCOL_ADDRESSES.UNISWAP_V3_FACTORY, QUOTER_ADDRESS: PROTOCOL_ADDRESSES.QUOTER_V2,
        // provider will be added later in bot.js
    };
    logger.debug('[loadConfig] Base config object created (Env Vars + Network Meta).');

    // --- Merge Global Settings from network file ---
    // Keys handled specifically by pool processing loops or other logic later
    const handledKeys = ['UNISWAP_V3_POOLS', 'SUSHISWAP_POOLS', 'CAMELOT_POOLS', 'DODO_POOLS', 'CHAINLINK_FEEDS', 'MIN_PROFIT_THRESHOLDS'];
    for (const key in networkSpecificConfig) {
        // Only merge if not handled specifically AND not already set in baseConfig from env vars
        if (!handledKeys.includes(key) && !(key in baseConfig)) {
             baseConfig[key] = networkSpecificConfig[key];
             logger.debug(`[Config Merge] Merged global setting from ${networkName}.js: ${key}`);
        } else if (handledKeys.includes(key)) {
             logger.debug(`[Config Merge] Skipping merge for handled key: ${key}`);
        } else {
             logger.debug(`[Config Merge] Skipping merge for key already set from env: ${key}`);
        }
    }
    // --- Explicitly merge MIN_PROFIT_THRESHOLDS and CHAINLINK_FEEDS ---
    // Ensure MIN_PROFIT_THRESHOLDS is valid (required by ProfitCalculator)
     if (!networkSpecificConfig.MIN_PROFIT_THRESHOLDS || typeof networkSpecificConfig.MIN_PROFIT_THRESHOLDS !== 'object' || !networkSpecificConfig.MIN_PROFIT_THRESHOLDS.NATIVE || !networkSpecificConfig.MIN_PROFIT_THRESHOLDS.DEFAULT) {
         logger.error(`[Config Merge] CRITICAL: MIN_PROFIT_THRESHOLDS definition in ${networkName}.js is missing, invalid, or lacks NATIVE/DEFAULT keys.`);
         // Throw error as ProfitCalculator requires this structure
         throw new Error(`Invalid MIN_PROFIT_THRESHOLDS definition in ${networkName}.js`);
     }
     baseConfig.MIN_PROFIT_THRESHOLDS = networkSpecificConfig.MIN_PROFIT_THRESHOLDS;

    // Ensure CHAINLINK_FEEDS is valid (required by ProfitCalculator)
     if (!networkSpecificConfig.CHAINLINK_FEEDS || typeof networkSpecificConfig.CHAINLINK_FEEDS !== 'object' || Object.keys(networkSpecificConfig.CHAINLINK_FEEDS).length === 0) {
          logger.error(`[Config Merge] CRITICAL: CHAINLINK_FEEDS definition in ${networkName}.js is missing, invalid, or empty.`);
          // Throw error as ProfitCalculator requires this structure
          throw new Error(`Invalid or empty CHAINLINK_FEEDS definition in ${networkName}.js`);
      }
     baseConfig.CHAINLINK_FEEDS = networkSpecificConfig.CHAINLINK_FEEDS;

    logger.debug(`[Config Merge] Merged MIN_PROFIT_THRESHOLDS: ${Object.keys(baseConfig.MIN_PROFIT_THRESHOLDS).length} entries`);
    logger.debug(`[Config Merge] Merged CHAINLINK_FEEDS: ${Object.keys(baseConfig.CHAINLINK_FEEDS).length} entries`);

    // Ensure Sushi Router is present if needed
    baseConfig.SUSHISWAP_ROUTER_ADDRESS = process.env[`${networkName.toUpperCase()}_SUSHISWAP_ROUTER_ADDRESS`] || networkSpecificConfig.SUSHISWAP_ROUTER_ADDRESS || null;
    logger.debug('[loadConfig] Merged global settings from network file.');
    // --- End Merge ---

    // --- Process POOLS ---
    const allPoolConfigs = [];
    const loadedPoolAddresses = new Set();

    // Use helper functions if they exist in ConfigHelpers.PoolProcessing
    const poolProcessor = ConfigHelpers.PoolProcessing || {};

    if (baseConfig.UNISWAP_V3_ENABLED && networkSpecificConfig.UNISWAP_V3_POOLS) {
         logger.debug(`[loadConfig] Processing V3 Pools...`);
         if (typeof poolProcessor.processV3Pools === 'function') {
             poolProcessor.processV3Pools(networkSpecificConfig.UNISWAP_V3_POOLS, baseConfig.TOKENS, loadedPoolAddresses, allPoolConfigs);
         } else { logger.warn('[loadConfig] processV3Pools helper not found in ConfigHelpers.PoolProcessing.'); }
    }

    if (baseConfig.SUSHISWAP_ENABLED && networkSpecificConfig.SUSHISWAP_POOLS) {
         logger.debug(`[loadConfig] Processing Sushi Pools...`);
          if (typeof poolProcessor.processSushiPools === 'function') {
             poolProcessor.processSushiPools(networkSpecificConfig.SUSHISWAP_POOLS, baseConfig.TOKENS, loadedPoolAddresses, allPoolConfigs);
          } else { logger.warn('[loadConfig] processSushiPools helper not found in ConfigHelpers.PoolProcessing.'); }
    }

    if (baseConfig.DODO_ENABLED && networkSpecificConfig.DODO_POOLS) {
         logger.debug(`[loadConfig] Processing DODO Pools...`);
         if (typeof poolProcessor.processDodoPools === 'function') {
             poolProcessor.processDodoPools(networkSpecificConfig.DODO_POOLS, baseConfig.TOKENS, loadedPoolAddresses, allPoolConfigs);
         } else { logger.warn('[loadConfig] processDodoPools helper not found in ConfigHelpers.PoolProcessing.'); }
     }

    baseConfig.POOL_CONFIGS = allPoolConfigs;

    if (baseConfig.DRY_RUN) { logger.warn("[Config] --- DRY RUN MODE ENABLED ---"); }
    else { logger.info("[Config] --- LIVE TRADING MODE ---"); }

    // --- *** DEBUG LOG BEFORE RETURN *** ---
    logger.debug("-----------------------------------------");
    logger.debug("[loadConfig] Final config object keys before export:", Object.keys(baseConfig));
    logger.debug(`[loadConfig] UNISWAP_V3_ENABLED: ${baseConfig.UNISWAP_V3_ENABLED}`);
    logger.debug(`[loadConfig] SUSHISWAP_ENABLED: ${baseConfig.SUSHISWAP_ENABLED}`);
    logger.debug(`[loadConfig] DODO_ENABLED: ${baseConfig.DODO_ENABLED}`);
    logger.debug(`[loadConfig] CHAINLINK_FEEDS type: ${typeof baseConfig.CHAINLINK_FEEDS}, keys: ${baseConfig.CHAINLINK_FEEDS ? Object.keys(baseConfig.CHAINLINK_FEEDS).length : 'N/A'}`);
    logger.debug(`[loadConfig] MIN_PROFIT_THRESHOLDS type: ${typeof baseConfig.MIN_PROFIT_THRESHOLDS}, keys: ${baseConfig.MIN_PROFIT_THRESHOLDS ? Object.keys(baseConfig.MIN_PROFIT_THRESHOLDS).length : 'N/A'}`);
    logger.debug(`[loadConfig] POOL_CONFIGS length: ${baseConfig.POOL_CONFIGS?.length}`);
    logger.debug("-----------------------------------------");
    // --- *** END DEBUG LOG *** ---

    logger.debug(`[loadConfig] Exiting loadConfig successfully with ${allPoolConfigs.length} pools.`);
    return baseConfig;
}


// --- Load and Export Config ---
// This part immediately calls loadConfig when the file is required
let config;
console.log('[Config] Attempting to call loadConfig inside try block...'); // Log moved here
try {
    config = loadConfig(); // Call the function defined above

    // Minimal validation after loadConfig returns
    // Note: loadConfig itself now throws errors for critical missing fields like CHAINLINK_FEEDS
    const essentialKeys = [ 'NAME', 'CHAIN_ID', 'RPC_URLS', 'PRIVATE_KEY', 'FLASH_SWAP_CONTRACT_ADDRESS', 'POOL_CONFIGS', 'TOKENS', 'NATIVE_CURRENCY_SYMBOL', 'CHAINLINK_FEEDS', 'MIN_PROFIT_THRESHOLDS'];
    const missingEssential = essentialKeys.filter(key => !(key in config) || config[key] === null || config[key] === undefined );

    if (missingEssential.length > 0) {
        logger.error(`[Config Export] CRITICAL: Final config object missing essential keys after loadConfig returned: ${missingEssential.join(', ')}`);
        throw new Error(`[Config] CRITICAL: Final config object missing essential keys: ${missingEssential.join(', ')}`);
    }
    if (!Array.isArray(config.POOL_CONFIGS)) { // POOL_CONFIGS must be an array
         throw new Error(`[Config] CRITICAL: POOL_CONFIGS is not an array after loading.`);
    }
    logger.info(`[Config Export] Config loaded successfully: Network=${config.NAME}, Pools Loaded=${config.POOL_CONFIGS.length}`);

} catch (error) {
    const msg = `[Config Export] CRITICAL FAILURE during config loading: ${error.message}`;
    logger.error(msg, error);
    console.error(msg, error);
    throw new Error(msg); // Re-throw
}

module.exports = config; // Export the loaded config object
console.log('[Config Top Level] module.exports reached.');
