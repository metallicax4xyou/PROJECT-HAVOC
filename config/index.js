// config/index.js
// Main configuration loader - Refactored
// --- VERSION UPDATED TO MERGE GLOBAL SETTINGS ---

require('dotenv').config(); // Load .env file first
const { ethers } = require('ethers'); // Ethers v6+
const { Token } = require('@uniswap/sdk-core'); // Keep if needed
let logger; try { logger = require('../utils/logger'); } catch(e) { console.error("No logger"); logger = console; }

// --- Load Helper Modules ---
const ConfigHelpers = require('./helpers'); // Load barrel file

// --- Load Network Metadata Helper ---
// TODO: Potentially move this to a dedicated networks config file
function getNetworkMetadata(networkName) {
    if (networkName === 'arbitrum') return { CHAIN_ID: 42161, NAME: 'arbitrum', NETWORK: 'arbitrum', NATIVE_SYMBOL: 'ETH', NATIVE_DECIMALS: 18, WRAPPED_NATIVE_SYMBOL: 'WETH' };
    // Add other networks here if needed
    return null;
}

// --- Load Shared Protocol Addresses ---
const { PROTOCOL_ADDRESSES } = require('../constants/addresses');
// --- Load SDK Token Instances ---
const { TOKENS } = require('../constants/tokens');

// --- loadConfig Function ---
function loadConfig() {
    logger.debug('[loadConfig] Starting loadConfig function...');
    const networkName = process.env.NETWORK?.toLowerCase();
    if (!networkName) { throw new Error(`[Config] CRITICAL: Missing NETWORK environment variable.`); }

    // --- Validate Core Env Vars ---
    const rpcUrlsEnvKey = `${networkName.toUpperCase()}_RPC_URLS`;
    const validatedRpcUrls = ConfigHelpers.Validators.validateRpcUrls(process.env[rpcUrlsEnvKey], rpcUrlsEnvKey);
    if (!validatedRpcUrls) { throw new Error(`[Config] CRITICAL: Invalid or missing RPC URL(s). Env var needed: ${rpcUrlsEnvKey}`); }

    const validatedPrivateKey = ConfigHelpers.Validators.validatePrivateKey(process.env.PRIVATE_KEY, 'PRIVATE_KEY');
    if (!validatedPrivateKey) { throw new Error(`[Config] CRITICAL: Invalid or missing PRIVATE_KEY.`); }

    const flashSwapEnvKey = `${networkName.toUpperCase()}_FLASH_SWAP_ADDRESS`;
    const validatedFlashSwapAddress = ConfigHelpers.Validators.validateAndNormalizeAddress(process.env[flashSwapEnvKey], flashSwapEnvKey);
    if (!validatedFlashSwapAddress) { logger.warn(`[Config] WARNING: FlashSwap address not set or invalid. Env var checked: ${flashSwapEnvKey}.`); }

    const tickLensEnvKey = `${networkName.toUpperCase()}_TICKLENS_ADDRESS`;
    const validatedTickLensAddress = ConfigHelpers.Validators.validateAndNormalizeAddress(process.env[tickLensEnvKey], tickLensEnvKey);
    if (!validatedTickLensAddress) { throw new Error(`[Config] CRITICAL: Invalid or missing TickLens address. Env var needed: ${tickLensEnvKey}`); }
    // --- ---

    // --- Load Network Metadata ---
    const networkMetadata = getNetworkMetadata(networkName);
    if (!networkMetadata) { throw new Error(`[Config] CRITICAL: No metadata for network: ${networkName}`); }

    // --- Load Network Specific File ---
    let networkSpecificConfig;
    try {
        networkSpecificConfig = require(`./${networkName}.js`);
        logger.log(`[Config] Loaded ./${networkName}.js`);
    } catch (e) {
        throw new Error(`[Config] CRITICAL: Failed to load config/${networkName}.js: ${e.message}`);
    }

    // --- Load Global Settings from .env ---
    const cycleIntervalMs = ConfigHelpers.Validators.safeParseInt(process.env.CYCLE_INTERVAL_MS, 'CYCLE_INTERVAL_MS', 5000);
    const slippageToleranceBps = ConfigHelpers.Validators.safeParseInt(process.env.SLIPPAGE_TOLERANCE_BPS, 'SLIPPAGE_TOLERANCE_BPS', 10);
    const isDryRun = ConfigHelpers.Validators.parseBoolean(process.env.DRY_RUN);
    const stopOnFirst = ConfigHelpers.Validators.parseBoolean(process.env.STOP_ON_FIRST_EXECUTION, false); // Default false if not set

    // --- Combine Base Config Object (Merge step-by-step) ---
    const baseConfig = {
        ...networkMetadata, // Add CHAIN_ID, NAME, NATIVE_SYMBOL etc.
        TOKENS: TOKENS,    // Add token constants

        // Add Core items from .env
        RPC_URLS: validatedRpcUrls,
        PRIMARY_RPC_URL: validatedRpcUrls[0],
        PRIVATE_KEY: validatedPrivateKey,
        FLASH_SWAP_CONTRACT_ADDRESS: validatedFlashSwapAddress || ethers.ZeroAddress,
        TICKLENS_ADDRESS: validatedTickLensAddress,

        // Add Global bot settings from .env
        CYCLE_INTERVAL_MS: cycleIntervalMs,
        SLIPPAGE_TOLERANCE_BPS: slippageToleranceBps, // Note: GAS_LIMIT_ESTIMATE removed, handled by FALLBACK_GAS_LIMIT now
        DRY_RUN: isDryRun,
        STOP_ON_FIRST_EXECUTION: stopOnFirst,

        // Add Protocol constants
        FACTORY_ADDRESS: PROTOCOL_ADDRESSES.UNISWAP_V3_FACTORY,
        QUOTER_ADDRESS: PROTOCOL_ADDRESSES.QUOTER_V2,

        // Add specific structures from network file
        CHAINLINK_FEEDS: networkSpecificConfig.CHAINLINK_FEEDS || {},
        // POOL_GROUPS will be added after processing
    };
    logger.debug('[loadConfig] Base config object created.');

    // --- *** Merge Global Settings from Network Config File *** ---
    // Iterate over keys in networkSpecificConfig and add them if they aren't already handled
    const handledKeys = ['CHAINLINK_FEEDS', 'POOL_GROUPS']; // Keys already explicitly handled
    for (const key in networkSpecificConfig) {
        if (!handledKeys.includes(key)) {
            // Check if key already exists in baseConfig (e.g., from networkMetadata) - override if needed, but log warning?
            if (baseConfig[key] !== undefined) {
                logger.warn(`[Config] Network config key "${key}" overrides a base value.`);
            }
            baseConfig[key] = networkSpecificConfig[key];
            logger.debug(`[Config] Merged global setting from ${networkName}.js: ${key}`);
        }
    }
    // Now baseConfig should contain MIN_PROFIT_THRESHOLD_ETH, MAX_GAS_GWEI etc.
    // --- *** End Merge *** ---


    // --- Process POOL_GROUPS using PoolProcessor Helper ---
    // Pass the now-enriched baseConfig (contains NATIVE_SYMBOL etc.)
    const rawPoolGroups = networkSpecificConfig.POOL_GROUPS;
    const { validProcessedPoolGroups, loadedPoolAddresses } = ConfigHelpers.PoolProcessor.processPoolGroups(baseConfig, rawPoolGroups);

    // Add processed groups to the config
    baseConfig.POOL_GROUPS = validProcessedPoolGroups;
    baseConfig._loadedPoolAddresses = loadedPoolAddresses; // Store for reference if needed
    // --- ---

    // Add helper function AFTER groups are processed
    baseConfig.getAllPoolConfigs = () => baseConfig.POOL_GROUPS.flatMap(group => group.pools || []);

    // Log final mode
    if (baseConfig.DRY_RUN) { console.warn("[Config] --- DRY RUN MODE ENABLED ---"); } else { console.log("[Config] --- LIVE TRADING MODE ---"); }
    logger.debug('[loadConfig] Exiting loadConfig successfully.');
    return baseConfig;
}
// --- End loadConfig Function ---


// --- Load and Export Config ---
let config;
console.log('[Config] Attempting to call loadConfig inside try block...');
try {
    config = loadConfig();
    // Final check for essential keys needed by engine and manager
    const essentialKeys = ['NAME', 'CHAIN_ID', 'PRIVATE_KEY', 'RPC_URLS', 'TICKLENS_ADDRESS', 'FLASH_SWAP_CONTRACT_ADDRESS', 'MIN_PROFIT_THRESHOLD_ETH', 'MAX_GAS_GWEI', 'GAS_ESTIMATE_BUFFER_PERCENT', 'FALLBACK_GAS_LIMIT', 'PROFIT_BUFFER_PERCENT'];
    const missingEssential = essentialKeys.filter(key => config[key] === undefined || config[key] === null || (key === 'RPC_URLS' && config[key].length === 0) || ((key === 'TICKLENS_ADDRESS' || key === 'FLASH_SWAP_CONTRACT_ADDRESS') && config[key] === ethers.ZeroAddress) );
    if (missingEssential.length > 0) {
         logger.error(`[Config Load Check] loadConfig result missing essential properties! Missing: ${missingEssential.join(', ')}`, config);
         throw new Error("Config object incomplete after loading.");
    }
    logger.info(`[Config] Config loaded successfully: Network=${config.NAME}, ChainID=${config.CHAIN_ID}`);
} catch (error) {
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    console.error("!!! FATAL CONFIGURATION ERROR !!!");
    console.error(`!!! ${error.message}`);
    console.error("!!! Bot cannot start.");
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    if (error.stack) console.error(error.stack); // Log stack for config errors
    process.exit(1);
}
module.exports = config;
console.log('[Config Top Level] module.exports reached.');
