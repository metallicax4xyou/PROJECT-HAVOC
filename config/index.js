// config/index.js
// Main configuration loader - Refactored
// --- VERSION UPDATED WITH DETAILED POOL PROCESSING LOGS ---

require('dotenv').config();
const { ethers } = require('ethers');
const { Token } = require('@uniswap/sdk-core');
let logger; try { logger = require('../utils/logger'); } catch (e) { console.error("No logger"); logger = console; }

const ConfigHelpers = require('./helpers');
const { getNetworkMetadata } = require('./networks');
const { PROTOCOL_ADDRESSES } = require('../constants/addresses');
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
    // --- ---

    const networkMetadata = getNetworkMetadata(networkName);
    if (!networkMetadata) { throw new Error(`[Config] CRITICAL: No metadata for network: ${networkName}`); }
    logger.info(`[Config] Loaded metadata for network: ${networkMetadata.NAME} (ChainID: ${networkMetadata.CHAIN_ID})`);

    let networkSpecificConfig;
    try {
        networkSpecificConfig = require(`./${networkName}.js`);
        logger.log(`[Config] Loaded ./${networkName}.js`);
    } catch (e) { throw new Error(`[Config] CRITICAL: Failed to load config/${networkName}.js: ${e.message}`); }

    const cycleIntervalMs = ConfigHelpers.Validators.safeParseInt(process.env.CYCLE_INTERVAL_MS, 'CYCLE_INTERVAL_MS', 5000);
    const slippageToleranceBps = ConfigHelpers.Validators.safeParseInt(process.env.SLIPPAGE_TOLERANCE_BPS, 'SLIPPAGE_TOLERANCE_BPS', 10);
    if(process.env.SLIPPAGE_TOLERANCE_BPS === undefined) { logger.warn(`[Config Parse Int] SLIPPAGE_TOLERANCE_BPS env var not set, using default: ${slippageToleranceBps}`); }
    const isDryRun = ConfigHelpers.Validators.parseBoolean(process.env.DRY_RUN);
    const stopOnFirst = ConfigHelpers.Validators.parseBoolean(process.env.STOP_ON_FIRST_EXECUTION, false);

    const baseConfig = {
        NAME: networkMetadata.NAME, CHAIN_ID: networkMetadata.CHAIN_ID, NATIVE_CURRENCY_SYMBOL: networkMetadata.NATIVE_SYMBOL, EXPLORER_URL: networkMetadata.EXPLORER_URL,
        TOKENS: TOKENS,
        RPC_URLS: validatedRpcUrls, PRIMARY_RPC_URL: validatedRpcUrls[0], PRIVATE_KEY: validatedPrivateKey, FLASH_SWAP_CONTRACT_ADDRESS: validatedFlashSwapAddress || ethers.ZeroAddress, TICKLENS_ADDRESS: validatedTickLensAddress || ethers.ZeroAddress,
        CYCLE_INTERVAL_MS: cycleIntervalMs, SLIPPAGE_TOLERANCE_BPS: slippageToleranceBps, DRY_RUN: isDryRun, STOP_ON_FIRST_EXECUTION: stopOnFirst,
        FACTORY_ADDRESS: PROTOCOL_ADDRESSES.UNISWAP_V3_FACTORY, QUOTER_ADDRESS: PROTOCOL_ADDRESSES.QUOTER_V2,
    };
    logger.debug('[loadConfig] Base config object created (Env Vars + Network Meta).');

    const handledKeys = ['UNISWAP_V3_POOLS', 'SUSHISWAP_POOLS', 'CAMELOT_POOLS', 'DODO_POOLS', 'CHAINLINK_FEEDS'];
    for (const key in networkSpecificConfig) {
        if (!handledKeys.includes(key)) { baseConfig[key] = networkSpecificConfig[key]; logger.debug(`[Config Merge] Merged global setting from ${networkName}.js: ${key}`); }
    }
    baseConfig.CHAINLINK_FEEDS = networkSpecificConfig.CHAINLINK_FEEDS || {};
    baseConfig.SUSHISWAP_ROUTER_ADDRESS = process.env[`${networkName.toUpperCase()}_SUSHISWAP_ROUTER_ADDRESS`] || networkSpecificConfig.SUSHISWAP_ROUTER_ADDRESS || null;
    logger.debug('[loadConfig] Merged global settings from network file.');

    // --- Process POOLS with Enhanced Logging ---
    const allPoolConfigs = [];
    const loadedPoolAddresses = new Set();

    // Process Uniswap V3 Pools
    const rawV3PoolGroups = networkSpecificConfig.UNISWAP_V3_POOLS || [];
    logger.debug(`[Config V3 Pools] Processing ${rawV3PoolGroups.length} V3 pool groups...`);
    for (const group of rawV3PoolGroups) {
        logger.debug(`[Config V3 Detail] Processing Group: ${group.name}`);
        const token0 = baseConfig.TOKENS[group.token0Symbol];
        const token1 = baseConfig.TOKENS[group.token1Symbol];
        if (!token0 || !token1) {
            logger.warn(`[Config V3 Detail] -> Skipping Group ${group.name}: Invalid token symbols ${group.token0Symbol}(${!!token0}) / ${group.token1Symbol}(${!!token1}). Check constants/tokens.js`);
            continue;
        }
        logger.debug(`[Config V3 Detail] Tokens OK: ${group.token0Symbol} & ${group.token1Symbol}`);

        for (const feeTierStr in group.feeTierToEnvMap) {
            const envVarName = group.feeTierToEnvMap[feeTierStr];
            logger.debug(`[Config V3 Detail]   Fee Tier ${feeTierStr}, Env Var: ${envVarName}`);
            if (!envVarName) {
                logger.debug(`[Config V3 Detail]   -> Skipping Fee Tier ${feeTierStr}: No env var defined in map.`);
                continue;
            }
            const fee = parseInt(feeTierStr, 10);
            if (isNaN(fee)) {
                 logger.warn(`[Config V3 Detail]   -> Skipping Fee Tier "${feeTierStr}": Invalid fee format.`);
                 continue;
            }
            const rawEnvAddress = process.env[envVarName];
            logger.debug(`[Config V3 Detail]   Raw address from env ${envVarName}: ${rawEnvAddress}`);
            const poolAddress = ConfigHelpers.Validators.validateAndNormalizeAddress(rawEnvAddress, envVarName);
            logger.debug(`[Config V3 Detail]   Validated address: ${poolAddress}`);

            if (poolAddress && poolAddress !== ethers.ZeroAddress) {
                 logger.debug(`[Config V3 Detail]   Address is valid.`);
                 if (loadedPoolAddresses.has(poolAddress.toLowerCase())) {
                     logger.warn(`[Config V3 Detail]   -> Skipping: Duplicate pool address ${poolAddress}.`);
                     continue;
                 }
                 allPoolConfigs.push({ address: poolAddress, dexType: 'uniswapV3', fee: fee, token0: token0, token1: token1, token0Symbol: group.token0Symbol, token1Symbol: group.token1Symbol, groupName: group.name, borrowTokenSymbol: group.borrowTokenSymbol });
                 loadedPoolAddresses.add(poolAddress.toLowerCase());
                 logger.debug(`[Config V3 Detail]   -> SUCCESS: Loaded ${group.name} (${fee}bps): ${poolAddress}`);
            } else {
                 logger.warn(`[Config V3 Detail]   -> Skipping: Invalid or missing address for env var ${envVarName} (Raw: ${rawEnvAddress}, Validated: ${poolAddress})`);
            }
        }
    }

    // Process SushiSwap Pools
    const rawSushiPools = networkSpecificConfig.SUSHISWAP_POOLS || [];
    logger.debug(`[Config Sushi Pools] Processing ${rawSushiPools.length} Sushi pool definitions...`);
    for (const poolInfo of rawSushiPools) {
         logger.debug(`[Config Sushi Detail] Processing Pool: ${poolInfo.name}`);
         const token0 = baseConfig.TOKENS[poolInfo.token0Symbol];
         const token1 = baseConfig.TOKENS[poolInfo.token1Symbol];
         if (!token0 || !token1) {
             logger.warn(`[Config Sushi Detail] -> Skipping Pool ${poolInfo.name}: Invalid token symbols ${poolInfo.token0Symbol}(${!!token0}) / ${poolInfo.token1Symbol}(${!!token1}). Check constants/tokens.js`);
             continue;
         }
         logger.debug(`[Config Sushi Detail] Tokens OK: ${poolInfo.token0Symbol} & ${poolInfo.token1Symbol}`);

         const envVarName = poolInfo.poolAddressEnv;
         logger.debug(`[Config Sushi Detail] Env Var: ${envVarName}`);
         if (!envVarName) {
             logger.warn(`[Config Sushi Detail] -> Skipping Pool ${poolInfo.name}: Missing 'poolAddressEnv' key.`);
             continue;
         }
         const rawEnvAddress = process.env[envVarName];
         logger.debug(`[Config Sushi Detail] Raw address from env ${envVarName}: ${rawEnvAddress}`);
         const poolAddress = ConfigHelpers.Validators.validateAndNormalizeAddress(rawEnvAddress, envVarName);
         logger.debug(`[Config Sushi Detail] Validated address: ${poolAddress}`);

         if (poolAddress && poolAddress !== ethers.ZeroAddress) {
             logger.debug(`[Config Sushi Detail] Address is valid.`);
             if (loadedPoolAddresses.has(poolAddress.toLowerCase())) {
                 logger.warn(`[Config Sushi Detail] -> Skipping: Duplicate pool address ${poolAddress}.`);
                 continue;
             }
             const feeBps = poolInfo.fee;
             logger.debug(`[Config Sushi Detail] Fee from config: ${feeBps}`);
             if (typeof feeBps !== 'number' || isNaN(feeBps)) {
                 logger.warn(`[Config Sushi Detail] -> Skipping ${poolInfo.name}: Invalid or missing 'fee' property (${feeBps}).`);
                 continue;
             }
             allPoolConfigs.push({ address: poolAddress, dexType: 'sushiswap', fee: feeBps, token0: token0, token1: token1, token0Symbol: poolInfo.token0Symbol, token1Symbol: poolInfo.token1Symbol, groupName: poolInfo.name });
             loadedPoolAddresses.add(poolAddress.toLowerCase());
             logger.debug(`[Config Sushi Detail]   -> SUCCESS: Loaded ${poolInfo.name}: ${poolAddress} (Fee: ${feeBps}bps)`);
         } else {
             logger.warn(`[Config Sushi Detail]   -> Skipping: Invalid or missing address for env var ${envVarName} (Raw: ${rawEnvAddress}, Validated: ${poolAddress})`);
         }
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

    // --- Essential Key Check (Add NATIVE_CURRENCY_SYMBOL) ---
    const essentialKeys = [ 'NAME', 'CHAIN_ID', 'RPC_URLS', 'PRIVATE_KEY', 'FLASH_SWAP_CONTRACT_ADDRESS', 'POOL_CONFIGS', 'TOKENS', 'NATIVE_CURRENCY_SYMBOL' ];
    const missingEssential = essentialKeys.filter(key => {
        const value = config?.[key];
        if (value === undefined || value === null) return true;
        if (key === 'RPC_URLS' && (!Array.isArray(value) || value.length === 0)) return true;
        // *** MODIFY POOL CHECK TO WARN INSTEAD OF ERRORING IF EMPTY ***
        if (key === 'POOL_CONFIGS') {
             if (!Array.isArray(value)) return true; // Still error if not an array
             if (value.length === 0) {
                 logger.error(`[Config Check] CRITICAL: ${key} is empty. No pools were loaded successfully. Check .env variables and config/${config.NAME}.js definitions.`);
                 // Allow startup but log error, maybe throw later if needed
                 // return true; // Temporarily allow empty pools for debugging
             }
        }
        // *** --- ***
        if (key === 'TOKENS' && (typeof value !== 'object' || Object.keys(value).length === 0)) return true;
        return false;
    });

    if (missingEssential.length > 0) {
        throw new Error(`[Config] CRITICAL: Missing or invalid essential config keys: ${missingEssential.join(', ')}.`);
    }
     // Add separate check specifically for pool length after initial essential checks pass
     if (!Array.isArray(config.POOL_CONFIGS) || config.POOL_CONFIGS.length === 0) {
         throw new Error(`[Config] CRITICAL: POOL_CONFIGS is empty after loading. Cannot proceed without pools. Check .env addresses and config files.`);
     }


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
console.log('[Config Top Level] module.exports reached.');
