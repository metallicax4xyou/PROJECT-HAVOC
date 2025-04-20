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
// TODO: Implement or ensure this function correctly maps networkName to chainId, name etc.
function getNetworkMetadata(networkName) {
    // Example implementation (replace with your actual logic if needed)
    if (networkName === 'arbitrum') {
        return {
            NAME: 'arbitrum',
            CHAIN_ID: 42161,
            NATIVE_CURRENCY_SYMBOL: 'ETH',
            // Add other relevant metadata
        };
    }
    // Add other networks if necessary
    return null; // Return null if network is not found
}

// --- Load Shared Protocol Addresses ---
const { PROTOCOL_ADDRESSES } = require('../constants/addresses');
// --- Load SDK Token Instances ---
// *** This imports the TOKENS object exported by constants/tokens.js ***
const { TOKENS } = require('../constants/tokens');

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

    // --- Load Network Specific File ---
    let networkSpecificConfig;
    try {
        networkSpecificConfig = require(`./${networkName}.js`);
        logger.log(`[Config] Loaded ./${networkName}.js`);
    } catch (e) { throw new Error(`[Config] CRITICAL: Failed to load config/${networkName}.js: ${e.message}`); }

    // --- Load Global Settings from .env ---
    const cycleIntervalMs = ConfigHelpers.Validators.safeParseInt(process.env.CYCLE_INTERVAL_MS, 'CYCLE_INTERVAL_MS', 5000);
    const slippageToleranceBps = ConfigHelpers.Validators.safeParseInt(process.env.SLIPPAGE_TOLERANCE_BPS, 'SLIPPAGE_TOLERANCE_BPS', 10); // Still use default if env var missing
    if(process.env.SLIPPAGE_TOLERANCE_BPS === undefined) {
         logger.warn(`[Config Parse Int] SLIPPAGE_TOLERANCE_BPS env variable not set, using default: ${slippageToleranceBps}`);
    }
    const isDryRun = ConfigHelpers.Validators.parseBoolean(process.env.DRY_RUN);
    const stopOnFirst = ConfigHelpers.Validators.parseBoolean(process.env.STOP_ON_FIRST_EXECUTION, false);

    // --- Combine Base Config Object (Merge step-by-step) ---
    const baseConfig = {
        ...networkMetadata,
        TOKENS: TOKENS, // Assign the imported TOKENS object
        RPC_URLS: validatedRpcUrls,
        PRIMARY_RPC_URL: validatedRpcUrls[0],
        PRIVATE_KEY: validatedPrivateKey,
        FLASH_SWAP_CONTRACT_ADDRESS: validatedFlashSwapAddress || ethers.ZeroAddress,
        TICKLENS_ADDRESS: validatedTickLensAddress || ethers.ZeroAddress, // Handle potential missing TickLens too
        CYCLE_INTERVAL_MS: cycleIntervalMs,
        SLIPPAGE_TOLERANCE_BPS: slippageToleranceBps,
        DRY_RUN: isDryRun,
        STOP_ON_FIRST_EXECUTION: stopOnFirst,
        FACTORY_ADDRESS: PROTOCOL_ADDRESSES.UNISWAP_V3_FACTORY,
        QUOTER_ADDRESS: PROTOCOL_ADDRESSES.QUOTER_V2,
        CHAINLINK_FEEDS: networkSpecificConfig.CHAINLINK_FEEDS || {},
        // Add Sushi router if defined in network config or env
        SUSHISWAP_ROUTER_ADDRESS: networkSpecificConfig.SUSHISWAP_ROUTER_ADDRESS || process.env[`${networkName.toUpperCase()}_SUSHISWAP_ROUTER_ADDRESS`] || null,
    };
    logger.debug('[loadConfig] Base config object created.');

    // --- Merge Global Settings from Network Config File ---
    const handledKeys = ['CHAINLINK_FEEDS', 'UNISWAP_V3_POOLS', 'SUSHISWAP_POOLS', 'SUSHISWAP_ROUTER_ADDRESS'];
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
    logger.debug(`[Config V3 Pools] Found ${rawV3PoolGroups.length} V3 pool groups defined in ${networkName}.js`);
    for (const group of rawV3PoolGroups) {
        // Use the TOKENS object from the baseConfig (which came from the import)
        const token0 = baseConfig.TOKENS[group.token0Symbol];
        const token1 = baseConfig.TOKENS[group.token1Symbol];
        if (!token0 || !token1) {
            logger.warn(`[Config V3 Pools] Skipping group ${group.name}: Invalid token symbols ${group.token0Symbol}/${group.token1Symbol}. Ensure they exist in constants/tokens.js`);
            continue;
        }

        for (const feeTierStr in group.feeTierToEnvMap) {
            // Skip processing if feeTierToEnvMap value is null or undefined (e.g., for commented out entries in arbitrum.js)
             const envVarName = group.feeTierToEnvMap[feeTierStr];
             if (!envVarName) {
                 // logger.debug(`[Config V3 Pools] Skipping fee tier "${feeTierStr}" for group ${group.name}: No env var defined in feeTierToEnvMap.`);
                 continue;
             }

            const fee = parseInt(feeTierStr, 10);
            if (isNaN(fee)) {
                 logger.warn(`[Config V3 Pools] Skipping fee tier "${feeTierStr}" for group ${group.name}: Invalid fee tier format.`);
                 continue;
            }
            const poolAddress = ConfigHelpers.Validators.validateAndNormalizeAddress(process.env[envVarName], envVarName);
            if (poolAddress && poolAddress !== ethers.ZeroAddress) {
                if (loadedPoolAddresses.has(poolAddress.toLowerCase())) {
                    logger.warn(`[Config V3 Pools] Duplicate pool address ${poolAddress} for ${group.name}/${fee}bps. Skipping.`);
                    continue;
                }
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
            } else {
                 // Only warn if the address wasn't found for a defined env var
                 if(process.env[envVarName] === undefined) {
                    // Don't warn if the env var itself is missing (e.g., ARBITRUM_WETH_USDC_10000_ADDRESS wasn't set)
                    // logger.debug(`[Config V3 Pools] Env var ${envVarName} not found for ${group.name} (${fee}bps).`);
                 } else {
                    logger.warn(`[Config V3 Pools] Skipping ${group.name} (${fee}bps): Invalid address in env var ${envVarName} (Value: ${process.env[envVarName]}).`);
                 }
            }
        }
    }

    // Process SushiSwap Pools
    const rawSushiPools = networkSpecificConfig.SUSHISWAP_POOLS || [];
    logger.debug(`[Config Sushi Pools] Found ${rawSushiPools.length} Sushi pool definitions in ${networkName}.js`);

    // *** ADDED DEBUG LOG HERE ***
    console.log("DEBUG: Available TOKENS keys before Sushi loop:", Object.keys(baseConfig.TOKENS));

     for (const poolInfo of rawSushiPools) {
         // Use the TOKENS object from the baseConfig
         const token0 = baseConfig.TOKENS[poolInfo.token0Symbol];
         const token1 = baseConfig.TOKENS[poolInfo.token1Symbol];
         if (!token0 || !token1) {
             logger.warn(`[Config Sushi Pools] Skipping group ${poolInfo.name}: Invalid token symbols ${poolInfo.token0Symbol}/${poolInfo.token1Symbol}. Ensure they exist in constants/tokens.js`);
             continue;
         }

         const envVarName = poolInfo.poolAddressEnv;
         if (!envVarName) {
             logger.warn(`[Config Sushi Pools] Skipping group ${poolInfo.name}: Missing 'poolAddressEnv' key in definition.`);
             continue;
         }
         const poolAddress = ConfigHelpers.Validators.validateAndNormalizeAddress(process.env[envVarName], envVarName);
         if (poolAddress && poolAddress !== ethers.ZeroAddress) {
              if (loadedPoolAddresses.has(poolAddress.toLowerCase())) {
                  logger.warn(`[Config Sushi Pools] Duplicate pool address ${poolAddress} for ${poolInfo.name}. Skipping.`);
                  continue;
              }
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
         } else {
             // Only warn if the address wasn't found for a defined env var
              if(process.env[envVarName] === undefined) {
                  // logger.debug(`[Config Sushi Pools] Env var ${envVarName} not found for ${poolInfo.name}.`);
              } else {
                 logger.warn(`[Config Sushi Pools] Skipping ${poolInfo.name}: Invalid address in env var ${envVarName} (Value: ${process.env[envVarName]}).`);
              }
         }
     }

    // --- Assign Processed Pools to Config ---
    baseConfig.POOL_CONFIGS = allPoolConfigs; // Store the combined list
    baseConfig.getAllPoolConfigs = () => baseConfig.POOL_CONFIGS || [];
    // --- ---

    // Log final mode
    if (baseConfig.DRY_RUN) { console.warn("[Config] --- DRY RUN MODE ENABLED ---"); } else { console.log("[Config] --- LIVE TRADING MODE ---"); }
    logger.debug(`[loadConfig] Exiting loadConfig successfully with ${allPoolConfigs.length} pools.`); // Log pool count on exit
    return baseConfig;
}
// --- End loadConfig Function ---


// --- Load and Export Config ---
let config;
console.log('[Config] Attempting to call loadConfig inside try block...');
try {
    config = loadConfig();

    // --- Update Essential Key Check ---
    const essentialKeys = [
        'NAME',
        'CHAIN_ID',
        'RPC_URLS',
        'PRIVATE_KEY',
        'FLASH_SWAP_CONTRACT_ADDRESS',
        // 'TICKLENS_ADDRESS', // Optional
        'POOL_CONFIGS',
        'TOKENS'
    ];
    const missingEssential = essentialKeys.filter(key => {
        const value = config?.[key];
        if (value === undefined || value === null) return true;
        if (key === 'RPC_URLS' && (!Array.isArray(value) || value.length === 0)) return true;
        if (key === 'POOL_CONFIGS' && (!Array.isArray(value) || value.length === 0)) {
             logger.error(`[Config Check] CRITICAL: ${key} is empty. No pools were loaded successfully. Check .env variables and config/${config.NAME}.js definitions.`);
             return true;
        }
        if (key === 'TOKENS' && (typeof value !== 'object' || Object.keys(value).length === 0)) return true;
        // Allow ZeroAddress for FLASH_SWAP_CONTRACT_ADDRESS initially
        return false;
    });

    if (missingEssential.length > 0) {
        throw new Error(`[Config] CRITICAL: Missing or invalid essential config keys: ${missingEssential.join(', ')}. Check preceding logs, .env, and network config file.`);
    }

    // Optional validation warnings
    if (config.TICKLENS_ADDRESS && config.TICKLENS_ADDRESS !== ethers.ZeroAddress && !ethers.isAddress(config.TICKLENS_ADDRESS)) {
         logger.warn(`[Config Check] TICKLENS_ADDRESS (${config.TICKLENS_ADDRESS}) looks invalid but is not ZeroAddress.`);
    }
    if (config.FLASH_SWAP_CONTRACT_ADDRESS && config.FLASH_SWAP_CONTRACT_ADDRESS !== ethers.ZeroAddress && !ethers.isAddress(config.FLASH_SWAP_CONTRACT_ADDRESS)) {
         logger.warn(`[Config Check] FLASH_SWAP_CONTRACT_ADDRESS (${config.FLASH_SWAP_CONTRACT_ADDRESS}) looks invalid but is not ZeroAddress.`);
    }

    logger.info(`[Config] Config loaded successfully: Network=${config.NAME}, ChainID=${config.CHAIN_ID}, Pools Loaded=${config.POOL_CONFIGS.length}`); // Log pool count
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

module.exports = config;
console.log('[Config Top Level] module.exports reached.');
