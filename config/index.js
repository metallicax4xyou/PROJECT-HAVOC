// config/index.js
// Main configuration loader - Refactored
// --- VERSION UPDATED TO PROCESS DODO_POOLS ---

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

    // --- Validate Core Env Vars (Unchanged) ---
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

    // --- Merge Global Settings (Add DODO_POOLS to handledKeys) ---
    const handledKeys = ['UNISWAP_V3_POOLS', 'SUSHISWAP_POOLS', 'CAMELOT_POOLS', 'DODO_POOLS', 'CHAINLINK_FEEDS']; // Added DODO_POOLS
    for (const key in networkSpecificConfig) {
        if (!handledKeys.includes(key)) { baseConfig[key] = networkSpecificConfig[key]; logger.debug(`[Config Merge] Merged global setting from ${networkName}.js: ${key}`); }
    }
    baseConfig.CHAINLINK_FEEDS = networkSpecificConfig.CHAINLINK_FEEDS || {};
    baseConfig.SUSHISWAP_ROUTER_ADDRESS = process.env[`${networkName.toUpperCase()}_SUSHISWAP_ROUTER_ADDRESS`] || networkSpecificConfig.SUSHISWAP_ROUTER_ADDRESS || null;
    // Add DODO Router/Proxy later if needed for execution
    // baseConfig.DODO_PROXY_ADDRESS = process.env[...] || networkSpecificConfig.DODO_PROXY_ADDRESS || null;
    logger.debug('[loadConfig] Merged global settings from network file.');
    // --- End Merge ---

    // --- Process POOLS ---
    const allPoolConfigs = [];
    const loadedPoolAddresses = new Set();

    // Process Uniswap V3 Pools (Unchanged)
    const rawV3PoolGroups = networkSpecificConfig.UNISWAP_V3_POOLS || [];
    // logger.debug(`[Config V3 Pools] Processing ${rawV3PoolGroups.length} V3 pool groups...`);
    for (const group of rawV3PoolGroups) {
         const token0 = baseConfig.TOKENS[group.token0Symbol]; const token1 = baseConfig.TOKENS[group.token1Symbol];
         if (!token0 || !token1) { logger.warn(`[Config V3 Detail] -> Skipping Group ${group.name}: Invalid token symbols ${group.token0Symbol}/${group.token1Symbol}.`); continue; }
         for (const feeTierStr in group.feeTierToEnvMap) {
             const envVarName = group.feeTierToEnvMap[feeTierStr]; if (!envVarName) continue;
             const fee = parseInt(feeTierStr, 10); if (isNaN(fee)) { logger.warn(`[Config V3 Detail]   -> Skipping Fee Tier "${feeTierStr}": Invalid fee format.`); continue; }
             const poolAddress = ConfigHelpers.Validators.validateAndNormalizeAddress(process.env[envVarName], envVarName);
             if (poolAddress && poolAddress !== ethers.ZeroAddress) {
                 if (loadedPoolAddresses.has(poolAddress.toLowerCase())) { logger.warn(`[Config V3 Detail]   -> Skipping: Duplicate pool address ${poolAddress}.`); continue; }
                 allPoolConfigs.push({ address: poolAddress, dexType: 'uniswapV3', fee: fee, token0: token0, token1: token1, token0Symbol: group.token0Symbol, token1Symbol: group.token1Symbol, groupName: group.name, borrowTokenSymbol: group.borrowTokenSymbol });
                 loadedPoolAddresses.add(poolAddress.toLowerCase());
                 // logger.debug(`[Config V3 Detail]   -> SUCCESS: Loaded ${group.name} (${fee}bps): ${poolAddress}`);
             } else { if (process.env[envVarName] !== undefined) logger.warn(`[Config V3 Detail]   -> Skipping: Invalid or missing address for env var ${envVarName}.`); }
         }
     }


    // Process SushiSwap Pools (Unchanged)
    const rawSushiPools = networkSpecificConfig.SUSHISWAP_POOLS || [];
    // logger.debug(`[Config Sushi Pools] Processing ${rawSushiPools.length} Sushi pool definitions...`);
    for (const poolInfo of rawSushiPools) {
        const token0 = baseConfig.TOKENS[poolInfo.token0Symbol]; const token1 = baseConfig.TOKENS[poolInfo.token1Symbol];
        if (!token0 || !token1) { logger.warn(`[Config Sushi Detail] -> Skipping Pool ${poolInfo.name}: Invalid token symbols.`); continue; }
        const envVarName = poolInfo.poolAddressEnv; if (!envVarName) { logger.warn(`[Config Sushi Detail] -> Skipping Pool ${poolInfo.name}: Missing 'poolAddressEnv' key.`); continue; }
        const poolAddress = ConfigHelpers.Validators.validateAndNormalizeAddress(process.env[envVarName], envVarName);
        if (poolAddress && poolAddress !== ethers.ZeroAddress) {
            if (loadedPoolAddresses.has(poolAddress.toLowerCase())) { logger.warn(`[Config Sushi Detail] -> Skipping: Duplicate pool address ${poolAddress}.`); continue; }
            const feeBps = poolInfo.fee;
            if (typeof feeBps !== 'number' || isNaN(feeBps)) { logger.warn(`[Config Sushi Detail] -> Skipping ${poolInfo.name}: Invalid or missing 'fee' property.`); continue; }
            allPoolConfigs.push({ address: poolAddress, dexType: 'sushiswap', fee: feeBps, token0: token0, token1: token1, token0Symbol: poolInfo.token0Symbol, token1Symbol: poolInfo.token1Symbol, groupName: poolInfo.name });
            loadedPoolAddresses.add(poolAddress.toLowerCase());
            // logger.debug(`[Config Sushi Detail]   -> SUCCESS: Loaded ${poolInfo.name}: ${poolAddress} (Fee: ${feeBps}bps)`);
        } else { if (process.env[envVarName] !== undefined) logger.warn(`[Config Sushi Detail]   -> Skipping: Invalid or missing address for env var ${envVarName}.`); }
    }

    // --- *** Process DODO Pools Loop *** ---
    const rawDodoPools = networkSpecificConfig.DODO_POOLS || [];
    logger.debug(`[Config DODO Pools] Processing ${rawDodoPools.length} DODO pool definitions...`);
    for (const poolInfo of rawDodoPools) {
         logger.debug(`[Config DODO Detail] Processing Pool: ${poolInfo.name}`);
         const token0 = baseConfig.TOKENS[poolInfo.token0Symbol];
         const token1 = baseConfig.TOKENS[poolInfo.token1Symbol];
         if (!token0 || !token1) { logger.warn(`[Config DODO Detail] -> Skipping Pool ${poolInfo.name}: Invalid token symbols ${poolInfo.token0Symbol}(${!!token0}) / ${poolInfo.token1Symbol}(${!!token1}).`); continue; }
         if (!poolInfo.baseTokenSymbol || (poolInfo.baseTokenSymbol !== poolInfo.token0Symbol && poolInfo.baseTokenSymbol !== poolInfo.token1Symbol)) { logger.warn(`[Config DODO Detail] -> Skipping Pool ${poolInfo.name}: Invalid or missing 'baseTokenSymbol'.`); continue; }
         logger.debug(`[Config DODO Detail] Tokens OK: ${poolInfo.token0Symbol} & ${poolInfo.token1Symbol} (Base: ${poolInfo.baseTokenSymbol})`);

         const envVarName = poolInfo.poolAddressEnv;
         logger.debug(`[Config DODO Detail] Env Var: ${envVarName}`);
         if (!envVarName) { logger.warn(`[Config DODO Detail] -> Skipping Pool ${poolInfo.name}: Missing 'poolAddressEnv' key.`); continue; }
         const rawEnvAddress = process.env[envVarName];
         logger.debug(`[Config DODO Detail] Raw address from env ${envVarName}: ${rawEnvAddress}`);
         const poolAddress = ConfigHelpers.Validators.validateAndNormalizeAddress(rawEnvAddress, envVarName);
         logger.debug(`[Config DODO Detail] Validated address: ${poolAddress}`);

         if (poolAddress && poolAddress !== ethers.ZeroAddress) {
             logger.debug(`[Config DODO Detail] Address is valid.`);
             if (loadedPoolAddresses.has(poolAddress.toLowerCase())) { logger.warn(`[Config DODO Detail] -> Skipping: Duplicate pool address ${poolAddress}.`); continue; }
             const feeBps = poolInfo.fee;
             if (feeBps !== undefined && (typeof feeBps !== 'number' || isNaN(feeBps))) { logger.warn(`[Config DODO Detail] Pool ${poolInfo.name}: Invalid 'fee' property (${feeBps}). Fetcher will use default.`); }

             allPoolConfigs.push({
                 address: poolAddress,
                 dexType: 'dodo', // Set dexType
                 fee: feeBps, // Pass fee if specified, otherwise fetcher defaults
                 token0: token0,
                 token1: token1,
                 token0Symbol: poolInfo.token0Symbol,
                 token1Symbol: poolInfo.token1Symbol,
                 baseTokenSymbol: poolInfo.baseTokenSymbol, // Pass the base token symbol
                 groupName: poolInfo.name,
             });
             loadedPoolAddresses.add(poolAddress.toLowerCase());
             logger.debug(`[Config DODO Detail]   -> SUCCESS: Loaded ${poolInfo.name}: ${poolAddress} (Base: ${poolInfo.baseTokenSymbol}, Fee: ${feeBps ?? 'Default'})`);
         } else { logger.warn(`[Config DODO Detail]   -> Skipping: Invalid or missing address for env var ${envVarName} (Raw: ${rawEnvAddress}, Validated: ${poolAddress})`); }
     }
    // --- *** ---

    // --- Add CAMELOT_POOLS processing loop later ---

    baseConfig.POOL_CONFIGS = allPoolConfigs;
    baseConfig.getAllPoolConfigs = () => baseConfig.POOL_CONFIGS || [];

    if (baseConfig.DRY_RUN) { console.warn("[Config] --- DRY RUN MODE ENABLED ---"); } else { console.log("[Config] --- LIVE TRADING MODE ---"); }
    logger.debug(`[loadConfig] Exiting loadConfig successfully with ${allPoolConfigs.length} pools.`);
    return baseConfig;
}
// --- End loadConfig Function ---


// --- Load and Export Config (Unchanged) ---
let config;
console.log('[Config] Attempting to call loadConfig inside try block...');
try {
    config = loadConfig();
    const essentialKeys = [ 'NAME', 'CHAIN_ID', 'RPC_URLS', 'PRIVATE_KEY', 'FLASH_SWAP_CONTRACT_ADDRESS', 'POOL_CONFIGS', 'TOKENS', 'NATIVE_CURRENCY_SYMBOL' ];
    const missingEssential = essentialKeys.filter(key => { /* ... */ });
    if (missingEssential.length > 0) { throw new Error(/* ... */); }
    if (!Array.isArray(config.POOL_CONFIGS) || config.POOL_CONFIGS.length === 0) { throw new Error(`[Config] CRITICAL: POOL_CONFIGS is empty after loading.`); }
    // Optional validation warnings (unchanged)
    logger.info(`[Config] Config loaded successfully: Network=${config.NAME}, ChainID=${config.CHAIN_ID}, Pools Loaded=${config.POOL_CONFIGS.length}`);
} catch (error) { /* ... unchanged error handling ... */ }

module.exports = config;
console.log('[Config Top Level] module.exports reached.');
