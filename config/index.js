// config/index.js
// Main configuration loader - Refactored
// --- VERSION UPDATED TO LOAD V3 & SUSHI POOLS ---

require('dotenv').config(); // Load .env file first
const { ethers } = require('ethers'); // Ethers v6+
const { Token } = require('@uniswap/sdk-core'); // Keep if needed
let logger; try { logger = require('../utils/logger'); } catch(e) { console.error("No logger"); logger = console; }

// --- Load Helper Modules ---
const ConfigHelpers = require('./helpers'); // Load barrel file

// --- Load Network Metadata Helper ---
function getNetworkMetadata(networkName) { /* ... (keep existing) ... */ }

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
    // ... (keep existing validations for RPC, PK, FlashSwap, TickLens) ...
    const rpcUrlsEnvKey = `${networkName.toUpperCase()}_RPC_URLS`; /*...*/
    const validatedRpcUrls = ConfigHelpers.Validators.validateRpcUrls(process.env[rpcUrlsEnvKey], rpcUrlsEnvKey); /*...*/
    const validatedPrivateKey = ConfigHelpers.Validators.validatePrivateKey(process.env.PRIVATE_KEY, 'PRIVATE_KEY'); /*...*/
    const flashSwapEnvKey = `${networkName.toUpperCase()}_FLASH_SWAP_ADDRESS`; /*...*/
    const validatedFlashSwapAddress = ConfigHelpers.Validators.validateAndNormalizeAddress(process.env[flashSwapEnvKey], flashSwapEnvKey); /*...*/
    const tickLensEnvKey = `${networkName.toUpperCase()}_TICKLENS_ADDRESS`; /*...*/
    const validatedTickLensAddress = ConfigHelpers.Validators.validateAndNormalizeAddress(process.env[tickLensEnvKey], tickLensEnvKey); /*...*/
    // --- ---

    // --- Load Network Metadata ---
    const networkMetadata = getNetworkMetadata(networkName);
    if (!networkMetadata) { throw new Error(`[Config] CRITICAL: No metadata for network: ${networkName}`); }

    // --- Load Network Specific File ---
    let networkSpecificConfig;
    try {
        networkSpecificConfig = require(`./${networkName}.js`);
        logger.log(`[Config] Loaded ./${networkName}.js`);
    } catch (e) { throw new Error(`[Config] CRITICAL: Failed to load config/${networkName}.js: ${e.message}`); }

    // --- Load Global Settings from .env ---
    // ... (keep existing: cycleIntervalMs, slippageToleranceBps, isDryRun, stopOnFirst) ...
    const cycleIntervalMs = ConfigHelpers.Validators.safeParseInt(process.env.CYCLE_INTERVAL_MS, 'CYCLE_INTERVAL_MS', 5000);
    const slippageToleranceBps = ConfigHelpers.Validators.safeParseInt(process.env.SLIPPAGE_TOLERANCE_BPS, 'SLIPPAGE_TOLERANCE_BPS', 10);
    const isDryRun = ConfigHelpers.Validators.parseBoolean(process.env.DRY_RUN);
    const stopOnFirst = ConfigHelpers.Validators.parseBoolean(process.env.STOP_ON_FIRST_EXECUTION, false);

    // --- Combine Base Config Object (Merge step-by-step) ---
    const baseConfig = {
        ...networkMetadata,
        TOKENS: TOKENS,
        RPC_URLS: validatedRpcUrls,
        PRIMARY_RPC_URL: validatedRpcUrls[0],
        PRIVATE_KEY: validatedPrivateKey,
        FLASH_SWAP_CONTRACT_ADDRESS: validatedFlashSwapAddress || ethers.ZeroAddress,
        TICKLENS_ADDRESS: validatedTickLensAddress,
        CYCLE_INTERVAL_MS: cycleIntervalMs,
        SLIPPAGE_TOLERANCE_BPS: slippageToleranceBps,
        DRY_RUN: isDryRun,
        STOP_ON_FIRST_EXECUTION: stopOnFirst,
        FACTORY_ADDRESS: PROTOCOL_ADDRESSES.UNISWAP_V3_FACTORY,
        QUOTER_ADDRESS: PROTOCOL_ADDRESSES.QUOTER_V2,
        CHAINLINK_FEEDS: networkSpecificConfig.CHAINLINK_FEEDS || {},
        // Add Sushi router if defined in network config
        SUSHISWAP_ROUTER_ADDRESS: networkSpecificConfig.SUSHISWAP_ROUTER_ADDRESS || null,
    };
    logger.debug('[loadConfig] Base config object created.');

    // --- Merge Global Settings from Network Config File ---
    const handledKeys = ['CHAINLINK_FEEDS', 'UNISWAP_V3_POOLS', 'SUSHISWAP_POOLS', 'SUSHISWAP_ROUTER_ADDRESS']; // Update handled keys
    for (const key in networkSpecificConfig) {
        if (!handledKeys.includes(key)) {
            if (baseConfig[key] !== undefined) { logger.warn(`[Config] Network config key "${key}" overrides a base value.`); }
            baseConfig[key] = networkSpecificConfig[key];
            logger.debug(`[Config] Merged global setting from ${networkName}.js: ${key}`);
        }
    }
    // --- End Merge ---

    // --- *** Process POOLS (V3 and Sushi) *** ---
    const allPoolConfigs = [];
    const loadedPoolAddresses = new Set(); // Track addresses to avoid duplicates if needed

    // Process Uniswap V3 Pools
    const rawV3PoolGroups = networkSpecificConfig.UNISWAP_V3_POOLS || [];
    for (const group of rawV3PoolGroups) {
        const token0 = TOKENS[group.token0Symbol];
        const token1 = TOKENS[group.token1Symbol];
        if (!token0 || !token1) { logger.warn(`[Config V3 Pools] Skipping group ${group.name}: Invalid token symbols ${group.token0Symbol}/${group.token1Symbol}`); continue; }

        for (const feeTierStr in group.feeTierToEnvMap) {
            const fee = parseInt(feeTierStr, 10);
            const envVarName = group.feeTierToEnvMap[feeTierStr];
            const poolAddress = ConfigHelpers.Validators.validateAndNormalizeAddress(process.env[envVarName], envVarName);
            if (poolAddress && poolAddress !== ethers.ZeroAddress) {
                if (loadedPoolAddresses.has(poolAddress.toLowerCase())) { logger.warn(`[Config V3 Pools] Duplicate pool address ${poolAddress} for ${group.name}/${fee}bps. Skipping.`); continue; }
                 allPoolConfigs.push({
                     address: poolAddress,
                     dexType: 'uniswapV3', // Add DEX type
                     fee: fee,
                     token0: token0,
                     token1: token1,
                     token0Symbol: group.token0Symbol,
                     token1Symbol: group.token1Symbol,
                     groupName: group.name,
                 });
                 loadedPoolAddresses.add(poolAddress.toLowerCase());
                 logger.debug(`[Config V3 Pools] Loaded ${group.name} (${fee}bps): ${poolAddress}`);
            } else { logger.warn(`[Config V3 Pools] Skipping ${group.name} (${fee}bps): Missing or invalid address in env var ${envVarName}.`); }
        }
    }

    // Process SushiSwap Pools
    const rawSushiPools = networkSpecificConfig.SUSHISWAP_POOLS || [];
     for (const poolInfo of rawSushiPools) {
         const token0 = TOKENS[poolInfo.token0Symbol];
         const token1 = TOKENS[poolInfo.token1Symbol];
         if (!token0 || !token1) { logger.warn(`[Config Sushi Pools] Skipping group ${poolInfo.name}: Invalid token symbols ${poolInfo.token0Symbol}/${poolInfo.token1Symbol}`); continue; }

         const envVarName = poolInfo.poolAddressEnv;
         const poolAddress = ConfigHelpers.Validators.validateAndNormalizeAddress(process.env[envVarName], envVarName);
         if (poolAddress && poolAddress !== ethers.ZeroAddress) {
              if (loadedPoolAddresses.has(poolAddress.toLowerCase())) { logger.warn(`[Config Sushi Pools] Duplicate pool address ${poolAddress} for ${poolInfo.name}. Skipping.`); continue; }
              allPoolConfigs.push({
                  address: poolAddress,
                  dexType: 'sushiswap', // Add DEX type
                  fee: 30, // SushiSwap fixed fee is 0.3% = 30 bps
                  token0: token0,
                  token1: token1,
                  token0Symbol: poolInfo.token0Symbol,
                  token1Symbol: poolInfo.token1Symbol,
                  groupName: poolInfo.name,
              });
              loadedPoolAddresses.add(poolAddress.toLowerCase());
              logger.debug(`[Config Sushi Pools] Loaded ${poolInfo.name}: ${poolAddress}`);
         } else { logger.warn(`[Config Sushi Pools] Skipping ${poolInfo.name}: Missing or invalid address in env var ${envVarName}.`); }
     }

    // --- Assign Processed Pools to Config ---
    baseConfig.POOL_CONFIGS = allPoolConfigs; // Store the combined list
    // Update the helper function to use the new list
    baseConfig.getAllPoolConfigs = () => baseConfig.POOL_CONFIGS || [];
    // --- ---

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
    // --- Update Essential Key Check ---
    const essentialKeys = [ /* ... keep existing ... */ 'POOL_CONFIGS']; // Check for POOL_CONFIGS now
    const missingEssential = essentialKeys.filter(key => config[key] === undefined || config[key] === null || (key === 'RPC_URLS' && config[key].length === 0) || ((key === 'TICKLENS_ADDRESS' || key === 'FLASH_SWAP_CONTRACT_ADDRESS') && config[key] === ethers.ZeroAddress) || (key === 'POOL_CONFIGS' && (!Array.isArray(config[key]) || config[key].length === 0)) );
    if (missingEssential.length > 0) { /* ... (keep existing error handling) ... */ }
    logger.info(`[Config] Config loaded successfully: Network=${config.NAME}, ChainID=${config.CHAIN_ID}, Pools Loaded=${config.POOL_CONFIGS.length}`); // Log pool count
} catch (error) { /* ... (keep existing error handling) ... */ }
module.exports = config;
console.log('[Config Top Level] module.exports reached.');
