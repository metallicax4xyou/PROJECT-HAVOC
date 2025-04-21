// config/index.js
// Main configuration loader - Refactored
// --- VERSION UPDATED TO ADD NATIVE_CURRENCY_SYMBOL to baseConfig ---

require('dotenv').config(); // Load .env file first
const { ethers } = require('ethers'); // Ethers v6+
const { Token } = require('@uniswap/sdk-core');
let logger; try { logger = require('../utils/logger'); } catch (e) { console.error("No logger"); logger = console; }

// --- Load Helper Modules ---
const ConfigHelpers = require('./helpers');

// --- Import from networks.js ---
const { getNetworkMetadata } = require('./networks'); // Use the function from networks.js

// --- Load Shared Protocol Addresses ---
const { PROTOCOL_ADDRESSES } = require('../constants/addresses');
// --- Load SDK Token Instances ---
const { TOKENS } = require('../constants/tokens'); // Loads tokens for the NETWORK specified in .env

// --- loadConfig Function ---
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
    // --- ---

    // --- Load Network Metadata ---
    const networkMetadata = getNetworkMetadata(networkName);
    if (!networkMetadata) { throw new Error(`[Config] CRITICAL: No metadata for network: ${networkName}`); }
    logger.info(`[Config] Loaded metadata for network: ${networkMetadata.NAME} (ChainID: ${networkMetadata.CHAIN_ID})`);

    // --- Load Network Specific File ---
    let networkSpecificConfig;
    try {
        networkSpecificConfig = require(`./${networkName}.js`);
        logger.log(`[Config] Loaded ./${networkName}.js`);
    } catch (e) { throw new Error(`[Config] CRITICAL: Failed to load config/${networkName}.js: ${e.message}`); }

    // --- Load Global Settings from .env ---
    const cycleIntervalMs = ConfigHelpers.Validators.safeParseInt(process.env.CYCLE_INTERVAL_MS, 'CYCLE_INTERVAL_MS', 5000);
    const slippageToleranceBps = ConfigHelpers.Validators.safeParseInt(process.env.SLIPPAGE_TOLERANCE_BPS, 'SLIPPAGE_TOLERANCE_BPS', 10);
    if(process.env.SLIPPAGE_TOLERANCE_BPS === undefined) { logger.warn(`[Config Parse Int] SLIPPAGE_TOLERANCE_BPS env var not set, using default: ${slippageToleranceBps}`); }
    const isDryRun = ConfigHelpers.Validators.parseBoolean(process.env.DRY_RUN);
    const stopOnFirst = ConfigHelpers.Validators.parseBoolean(process.env.STOP_ON_FIRST_EXECUTION, false);

    // --- Combine Base Config Object (Merge step-by-step) ---
    const baseConfig = {
        // From Network Metadata
        NAME: networkMetadata.NAME,
        CHAIN_ID: networkMetadata.CHAIN_ID,
        // *** EXPLICITLY ADD NATIVE_CURRENCY_SYMBOL ***
        NATIVE_CURRENCY_SYMBOL: networkMetadata.NATIVE_SYMBOL,
        // *** --- ***
        EXPLORER_URL: networkMetadata.EXPLORER_URL, // Keep other meta if needed

        // From Loaded Tokens
        TOKENS: TOKENS,

        // From Validated Env Vars
        RPC_URLS: validatedRpcUrls,
        PRIMARY_RPC_URL: validatedRpcUrls[0],
        PRIVATE_KEY: validatedPrivateKey,
        FLASH_SWAP_CONTRACT_ADDRESS: validatedFlashSwapAddress || ethers.ZeroAddress,
        TICKLENS_ADDRESS: validatedTickLensAddress || ethers.ZeroAddress,

        // From Parsed Env Vars / Defaults
        CYCLE_INTERVAL_MS: cycleIntervalMs,
        SLIPPAGE_TOLERANCE_BPS: slippageToleranceBps,
        DRY_RUN: isDryRun,
        STOP_ON_FIRST_EXECUTION: stopOnFirst,

        // From Constants
        FACTORY_ADDRESS: PROTOCOL_ADDRESSES.UNISWAP_V3_FACTORY,
        QUOTER_ADDRESS: PROTOCOL_ADDRESSES.QUOTER_V2,
    };
    logger.debug('[loadConfig] Base config object created (Env Vars + Network Meta).');

    // --- Merge Global Settings & Routers from Network Config File ---
    const handledKeys = ['UNISWAP_V3_POOLS', 'SUSHISWAP_POOLS', 'CAMELOT_POOLS', 'DODO_POOLS', 'CHAINLINK_FEEDS'];
    for (const key in networkSpecificConfig) {
        if (!handledKeys.includes(key)) {
            if (baseConfig[key] !== undefined) { logger.warn(`[Config Merge] Network config key "${key}" overrides a base/env value.`); }
            baseConfig[key] = networkSpecificConfig[key];
            logger.debug(`[Config Merge] Merged global setting from ${networkName}.js: ${key}`);
        }
    }
    baseConfig.CHAINLINK_FEEDS = networkSpecificConfig.CHAINLINK_FEEDS || {};
    baseConfig.SUSHISWAP_ROUTER_ADDRESS = process.env[`${networkName.toUpperCase()}_SUSHISWAP_ROUTER_ADDRESS`] || networkSpecificConfig.SUSHISWAP_ROUTER_ADDRESS || null;
    logger.debug('[loadConfig] Merged global settings from network file.');
    // --- End Merge ---

    // --- Process POOLS ---
    const allPoolConfigs = [];
    const loadedPoolAddresses = new Set();

    // Process Uniswap V3 Pools (Unchanged)
    const rawV3PoolGroups = networkSpecificConfig.UNISWAP_V3_POOLS || [];
    logger.debug(`[Config V3 Pools] Found ${rawV3PoolGroups.length} V3 pool groups defined in ${networkName}.js`);
    for (const group of rawV3PoolGroups) { /* ... unchanged V3 processing loop ... */ }

    // Process SushiSwap Pools (Unchanged - already uses poolInfo.fee)
    const rawSushiPools = networkSpecificConfig.SUSHISWAP_POOLS || [];
    logger.debug(`[Config Sushi Pools] Found ${rawSushiPools.length} Sushi pool definitions in ${networkName}.js`);
    for (const poolInfo of rawSushiPools) { /* ... unchanged Sushi processing loop ... */ }

    // --- Add loops here later to process CAMELOT_POOLS, DODO_POOLS etc. ---
    // Example for Camelot (assuming similar structure to Sushi)
    const rawCamelotPools = networkSpecificConfig.CAMELOT_POOLS || [];
    // logger.debug(`[Config Camelot Pools] Found ${rawCamelotPools.length} Camelot pool definitions.`);
    // for (const poolInfo of rawCamelotPools) { /* ... process camelot pools ... */ }

    baseConfig.POOL_CONFIGS = allPoolConfigs;
    baseConfig.getAllPoolConfigs = () => baseConfig.POOL_CONFIGS || [];

    if (baseConfig.DRY_RUN) { console.warn("[Config] --- DRY RUN MODE ENABLED ---"); } else { console.log("[Config] --- LIVE TRADING MODE ---"); }
    logger.debug(`[loadConfig] Exiting loadConfig successfully with ${allPoolConfigs.length} pools.`);
    return baseConfig;
}
// --- End loadConfig Function ---


// --- Load and Export Config ---
let config;
console.log('[Config] Attempting to call loadConfig inside try block...');
try {
    config = loadConfig();

    // --- Essential Key Check (Add NATIVE_CURRENCY_SYMBOL) ---
    const essentialKeys = [ 'NAME', 'CHAIN_ID', 'RPC_URLS', 'PRIVATE_KEY', 'FLASH_SWAP_CONTRACT_ADDRESS', 'POOL_CONFIGS', 'TOKENS', 'NATIVE_CURRENCY_SYMBOL' ];
    const missingEssential = essentialKeys.filter(key => { /* ... same validation logic ... */ });
    if (missingEssential.length > 0) { throw new Error(`[Config] CRITICAL: Missing or invalid essential config keys: ${missingEssential.join(', ')}.`); }

    // Optional validation warnings (unchanged)
    if (config.TICKLENS_ADDRESS && config.TICKLENS_ADDRESS !== ethers.ZeroAddress && !ethers.isAddress(config.TICKLENS_ADDRESS)) { logger.warn(`[Config Check] TICKLENS_ADDRESS looks invalid.`); }
    if (config.FLASH_SWAP_CONTRACT_ADDRESS && config.FLASH_SWAP_CONTRACT_ADDRESS !== ethers.ZeroAddress && !ethers.isAddress(config.FLASH_SWAP_CONTRACT_ADDRESS)) { logger.warn(`[Config Check] FLASH_SWAP_CONTRACT_ADDRESS looks invalid.`); }

    logger.info(`[Config] Config loaded successfully: Network=${config.NAME}, ChainID=${config.CHAIN_ID}, Pools Loaded=${config.POOL_CONFIGS.length}`);
} catch (error) { /* ... unchanged error handling ... */ }

module.exports = config;
console.log('[Config Top Level] module.exports reached.');
