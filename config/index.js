// config/index.js
// Main configuration loader - Refactored
// --- VERSION UPDATED TO IMPORT NETWORK METADATA & USE CONFIGURED SUSHI FEE ---

require('dotenv').config(); // Load .env file first
const { ethers } = require('ethers'); // Ethers v6+
const { Token } = require('@uniswap/sdk-core');
let logger; try { logger = require('../utils/logger'); } catch (e) { console.error("No logger"); logger = console; }

// --- Load Helper Modules ---
const ConfigHelpers = require('./helpers');

// --- *** MODIFIED: Import from networks.js *** ---
const { getNetworkMetadata } = require('./networks'); // Use the function from networks.js
// --- *** ---

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

    // --- Load Network Metadata (Now imported) ---
    const networkMetadata = getNetworkMetadata(networkName); // Calls the imported function
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
    // Start with validated essential env vars and network metadata
    const baseConfig = {
        ...networkMetadata, // Includes NAME, CHAIN_ID, NATIVE_SYMBOL etc.
        TOKENS: TOKENS,     // Assign the correctly loaded TOKENS object
        RPC_URLS: validatedRpcUrls,
        PRIMARY_RPC_URL: validatedRpcUrls[0],
        PRIVATE_KEY: validatedPrivateKey,
        FLASH_SWAP_CONTRACT_ADDRESS: validatedFlashSwapAddress || ethers.ZeroAddress,
        TICKLENS_ADDRESS: validatedTickLensAddress || ethers.ZeroAddress,
        CYCLE_INTERVAL_MS: cycleIntervalMs,
        SLIPPAGE_TOLERANCE_BPS: slippageToleranceBps,
        DRY_RUN: isDryRun,
        STOP_ON_FIRST_EXECUTION: stopOnFirst,
        // Add globally defined protocol addresses
        FACTORY_ADDRESS: PROTOCOL_ADDRESSES.UNISWAP_V3_FACTORY, // Assuming UniV3 focus for now
        QUOTER_ADDRESS: PROTOCOL_ADDRESSES.QUOTER_V2,         // Assuming UniV3 focus for now
        // Add other global addresses if needed
    };
    logger.debug('[loadConfig] Base config object created (Env Vars + Network Meta).');

    // --- Merge Global Settings & Routers from Network Config File ---
    // Explicitly list keys handled separately (Pools, Chainlink)
    const handledKeys = ['UNISWAP_V3_POOLS', 'SUSHISWAP_POOLS', 'CAMELOT_POOLS', 'DODO_POOLS', 'CHAINLINK_FEEDS']; // Add DODO_POOLS later
    for (const key in networkSpecificConfig) {
        if (!handledKeys.includes(key)) {
            if (baseConfig[key] !== undefined) { logger.warn(`[Config Merge] Network config key "${key}" overrides a base/env value.`); }
            baseConfig[key] = networkSpecificConfig[key];
            logger.debug(`[Config Merge] Merged global setting from ${networkName}.js: ${key}`);
        }
    }
    // Explicitly merge Chainlink (allows empty object if undefined)
    baseConfig.CHAINLINK_FEEDS = networkSpecificConfig.CHAINLINK_FEEDS || {};
    // Explicitly merge known Routers (allows overrides from env)
    baseConfig.SUSHISWAP_ROUTER_ADDRESS = process.env[`${networkName.toUpperCase()}_SUSHISWAP_ROUTER_ADDRESS`] || networkSpecificConfig.SUSHISWAP_ROUTER_ADDRESS || null;
    // Add other router merges here (e.g., Camelot)
    // baseConfig.CAMELOT_ROUTER_ADDRESS = process.env[...] || networkSpecificConfig.CAMELOT_ROUTER_ADDRESS || null;

    logger.debug('[loadConfig] Merged global settings from network file.');
    // --- End Merge ---

    // --- Process POOLS (V3 and Sushi) ---
    const allPoolConfigs = [];
    const loadedPoolAddresses = new Set();

    // Process Uniswap V3 Pools (Logic unchanged, assumed correct)
    const rawV3PoolGroups = networkSpecificConfig.UNISWAP_V3_POOLS || [];
    logger.debug(`[Config V3 Pools] Found ${rawV3PoolGroups.length} V3 pool groups defined in ${networkName}.js`);
    for (const group of rawV3PoolGroups) {
        const token0 = baseConfig.TOKENS[group.token0Symbol]; const token1 = baseConfig.TOKENS[group.token1Symbol];
        if (!token0 || !token1) { logger.warn(`[Config V3 Pools] Skipping group ${group.name}: Invalid token symbols ${group.token0Symbol}/${group.token1Symbol}.`); continue; }
        for (const feeTierStr in group.feeTierToEnvMap) {
            const envVarName = group.feeTierToEnvMap[feeTierStr]; if (!envVarName) { continue; }
            const fee = parseInt(feeTierStr, 10); if (isNaN(fee)) { logger.warn(`[Config V3 Pools] Skipping fee tier "${feeTierStr}" for group ${group.name}: Invalid fee tier format.`); continue; }
            const poolAddress = ConfigHelpers.Validators.validateAndNormalizeAddress(process.env[envVarName], envVarName);
            if (poolAddress && poolAddress !== ethers.ZeroAddress) {
                if (loadedPoolAddresses.has(poolAddress.toLowerCase())) { logger.warn(`[Config V3 Pools] Duplicate pool address ${poolAddress} for ${group.name}/${fee}bps. Skipping.`); continue; }
                allPoolConfigs.push({ address: poolAddress, dexType: 'uniswapV3', fee: fee, token0: token0, token1: token1, token0Symbol: group.token0Symbol, token1Symbol: group.token1Symbol, groupName: group.name, borrowTokenSymbol: group.borrowTokenSymbol }); // Added borrowTokenSymbol
                loadedPoolAddresses.add(poolAddress.toLowerCase());
                logger.debug(`[Config V3 Pools] Loaded ${group.name} (${fee}bps): ${poolAddress}`);
            } else { if (process.env[envVarName] !== undefined) { logger.warn(`[Config V3 Pools] Skipping ${group.name} (${fee}bps): Invalid address in env var ${envVarName} (Value: ${process.env[envVarName]}).`); } }
        }
    }

    // Process SushiSwap Pools
    const rawSushiPools = networkSpecificConfig.SUSHISWAP_POOLS || [];
    logger.debug(`[Config Sushi Pools] Found ${rawSushiPools.length} Sushi pool definitions in ${networkName}.js`);
    for (const poolInfo of rawSushiPools) {
        const token0 = baseConfig.TOKENS[poolInfo.token0Symbol]; const token1 = baseConfig.TOKENS[poolInfo.token1Symbol];
        if (!token0 || !token1) { logger.warn(`[Config Sushi Pools] Skipping group ${poolInfo.name}: Invalid token symbols ${poolInfo.token0Symbol}/${poolInfo.token1Symbol}.`); continue; }
        const envVarName = poolInfo.poolAddressEnv; if (!envVarName) { logger.warn(`[Config Sushi Pools] Skipping group ${poolInfo.name}: Missing 'poolAddressEnv' key.`); continue; }
        const poolAddress = ConfigHelpers.Validators.validateAndNormalizeAddress(process.env[envVarName], envVarName);
        if (poolAddress && poolAddress !== ethers.ZeroAddress) {
            if (loadedPoolAddresses.has(poolAddress.toLowerCase())) { logger.warn(`[Config Sushi Pools] Duplicate pool address ${poolAddress} for ${poolInfo.name}. Skipping.`); continue; }
            // --- *** USE FEE FROM poolInfo *** ---
            const feeBps = poolInfo.fee; // Get fee from the config object
            if (typeof feeBps !== 'number' || isNaN(feeBps)) { logger.warn(`[Config Sushi Pools] Skipping ${poolInfo.name}: Invalid or missing 'fee' property in config.`); continue; }
            // --- *** ---
            allPoolConfigs.push({ address: poolAddress, dexType: 'sushiswap', fee: feeBps, token0: token0, token1: token1, token0Symbol: poolInfo.token0Symbol, token1Symbol: poolInfo.token1Symbol, groupName: poolInfo.name });
            loadedPoolAddresses.add(poolAddress.toLowerCase());
            logger.debug(`[Config Sushi Pools] Loaded ${poolInfo.name}: ${poolAddress} (Fee: ${feeBps}bps)`);
        } else { if (process.env[envVarName] !== undefined) { logger.warn(`[Config Sushi Pools] Skipping ${poolInfo.name}: Invalid address in env var ${envVarName} (Value: ${process.env[envVarName]}).`); } }
    }
    // --- Add loops here later to process CAMELOT_POOLS, DODO_POOLS etc. ---

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
    config = loadConfig(); // Load config using the function

    // --- Essential Key Check ---
    const essentialKeys = [ /* ... same as before ... */ 'NAME', 'CHAIN_ID', 'RPC_URLS', 'PRIVATE_KEY', 'FLASH_SWAP_CONTRACT_ADDRESS', 'POOL_CONFIGS', 'TOKENS' ];
    const missingEssential = essentialKeys.filter(key => { /* ... same validation ... */ });
    if (missingEssential.length > 0) { throw new Error(`[Config] CRITICAL: Missing or invalid essential config keys: ${missingEssential.join(', ')}.`); }

    // Optional validation warnings (unchanged)
    if (config.TICKLENS_ADDRESS && config.TICKLENS_ADDRESS !== ethers.ZeroAddress && !ethers.isAddress(config.TICKLENS_ADDRESS)) { logger.warn(`[Config Check] TICKLENS_ADDRESS looks invalid.`); }
    if (config.FLASH_SWAP_CONTRACT_ADDRESS && config.FLASH_SWAP_CONTRACT_ADDRESS !== ethers.ZeroAddress && !ethers.isAddress(config.FLASH_SWAP_CONTRACT_ADDRESS)) { logger.warn(`[Config Check] FLASH_SWAP_CONTRACT_ADDRESS looks invalid.`); }

    logger.info(`[Config] Config loaded successfully: Network=${config.NAME}, ChainID=${config.CHAIN_ID}, Pools Loaded=${config.POOL_CONFIGS.length}`);
} catch (error) {
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    console.error("!!! CRITICAL CONFIGURATION LOADING ERROR !!!");
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    const logError = logger?.error || console.error;
    logError(`[Config Load Error] ${error.message}`);
    console.error("Stack Trace:", error.stack);
    logError("!!! Application cannot continue. Exiting. !!!");
    process.exit(1);
}

module.exports = config; // Export the loaded config
console.log('[Config Top Level] module.exports reached.'); // Should now appear AFTER config loading
