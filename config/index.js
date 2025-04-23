// config/index.js
// --- VERSION LOADING GAS_COST_ESTIMATES ---

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
    const uniswapV3Enabled = ConfigHelpers.Validators.parseBoolean(process.env.UNISWAP_V3_ENABLED, false);
    const sushiswapEnabled = ConfigHelpers.Validators.parseBoolean(process.env.SUSHISWAP_ENABLED, false);
    const dodoEnabled = ConfigHelpers.Validators.parseBoolean(process.env.DODO_ENABLED, false);

    const networkMetadata = getNetworkMetadata(networkName);
    if (!networkMetadata) { throw new Error(`[Config] CRITICAL: No metadata for network: ${networkName}`); }
    logger.info(`[Config] Loaded metadata for network: ${networkMetadata.NAME} (ChainID: ${networkMetadata.CHAIN_ID})`);

    let networkSpecificConfig;
    try { networkSpecificConfig = require(`./${networkName}.js`); logger.log(`[Config] Loaded ./${networkName}.js`);
    } catch (e) { throw new Error(`[Config] CRITICAL: Failed to load config/${networkName}.js: ${e.message}`); }

    // Other Env Vars / Defaults
    const cycleIntervalMs = ConfigHelpers.Validators.safeParseInt(process.env.CYCLE_INTERVAL_MS, 'CYCLE_INTERVAL_MS', 5000);
    const slippageToleranceBps = ConfigHelpers.Validators.safeParseInt(process.env.SLIPPAGE_TOLERANCE_BPS, 'SLIPPAGE_TOLERANCE_BPS', 10);
    const isDryRun = ConfigHelpers.Validators.parseBoolean(process.env.DRY_RUN, true);
    const stopOnFirst = ConfigHelpers.Validators.parseBoolean(process.env.STOP_ON_FIRST_EXECUTION, false);
    const maxGasGwei = ConfigHelpers.Validators.safeParseInt(process.env.MAX_GAS_GWEI, 'MAX_GAS_GWEI', networkSpecificConfig.MAX_GAS_GWEI || 10);
    const gasBufferPercent = ConfigHelpers.Validators.safeParseInt(process.env.GAS_ESTIMATE_BUFFER_PERCENT, 'GAS_ESTIMATE_BUFFER_PERCENT', networkSpecificConfig.GAS_ESTIMATE_BUFFER_PERCENT || 20);
    const fallbackGasLimit = ConfigHelpers.Validators.safeParseInt(process.env.FALLBACK_GAS_LIMIT, 'FALLBACK_GAS_LIMIT', networkSpecificConfig.FALLBACK_GAS_LIMIT || 3000000); // Increased default
    const profitBufferPercent = ConfigHelpers.Validators.safeParseInt(process.env.PROFIT_BUFFER_PERCENT, 'PROFIT_BUFFER_PERCENT', networkSpecificConfig.PROFIT_BUFFER_PERCENT || 5);

    const baseConfig = {
        NAME: networkMetadata.NAME, CHAIN_ID: networkMetadata.CHAIN_ID, NATIVE_CURRENCY_SYMBOL: networkMetadata.NATIVE_SYMBOL, EXPLORER_URL: networkMetadata.EXPLORER_URL,
        TOKENS: TOKENS, RPC_URLS: validatedRpcUrls, PRIMARY_RPC_URL: validatedRpcUrls[0], PRIVATE_KEY: validatedPrivateKey, FLASH_SWAP_CONTRACT_ADDRESS: validatedFlashSwapAddress || ethers.ZeroAddress, TICKLENS_ADDRESS: validatedTickLensAddress || ethers.ZeroAddress,
        CYCLE_INTERVAL_MS: cycleIntervalMs, SLIPPAGE_TOLERANCE_BPS: slippageToleranceBps, DRY_RUN: isDryRun, STOP_ON_FIRST_EXECUTION: stopOnFirst,
        UNISWAP_V3_ENABLED: uniswapV3Enabled, SUSHISWAP_ENABLED: sushiswapEnabled, DODO_ENABLED: dodoEnabled,
        MAX_GAS_GWEI: maxGasGwei, GAS_ESTIMATE_BUFFER_PERCENT: gasBufferPercent, FALLBACK_GAS_LIMIT: fallbackGasLimit, PROFIT_BUFFER_PERCENT: profitBufferPercent,
        FACTORY_ADDRESS: PROTOCOL_ADDRESSES.UNISWAP_V3_FACTORY, QUOTER_ADDRESS: PROTOCOL_ADDRESSES.QUOTER_V2,
    };
    logger.debug('[loadConfig] Base config object created.');

    // --- Merge Required Settings from network file ---
    // *** Add GAS_COST_ESTIMATES to required/checked keys ***
    const requiredNetworkKeys = ['MIN_PROFIT_THRESHOLDS', 'CHAINLINK_FEEDS', 'GAS_COST_ESTIMATES'];
    for (const key of requiredNetworkKeys) {
        if (!networkSpecificConfig[key] || typeof networkSpecificConfig[key] !== 'object' || Object.keys(networkSpecificConfig[key]).length === 0) {
            throw new Error(`Invalid or empty ${key} definition in ${networkName}.js`);
        }
        baseConfig[key] = networkSpecificConfig[key];
        logger.debug(`[Config Merge] Merged ${key}: ${Object.keys(baseConfig[key]).length} entries`);
    }
    // Specific check for MIN_PROFIT_THRESHOLDS content
    if (!baseConfig.MIN_PROFIT_THRESHOLDS.NATIVE || !baseConfig.MIN_PROFIT_THRESHOLDS.DEFAULT) {
         throw new Error(`MIN_PROFIT_THRESHOLDS missing NATIVE/DEFAULT keys.`);
    }
    // Specific check for GAS_COST_ESTIMATES content (add more checks if needed)
    if (!baseConfig.GAS_COST_ESTIMATES.FLASH_SWAP_BASE) {
        throw new Error(`GAS_COST_ESTIMATES missing FLASH_SWAP_BASE key.`);
    }

    // Merge Sushi Router Address
    baseConfig.SUSHISWAP_ROUTER_ADDRESS = process.env[`${networkName.toUpperCase()}_SUSHISWAP_ROUTER_ADDRESS`] || networkSpecificConfig.SUSHISWAP_ROUTER_ADDRESS || null;
    logger.debug(`[Config Merge] SUSHISWAP_ROUTER_ADDRESS: ${baseConfig.SUSHISWAP_ROUTER_ADDRESS || 'Not Set'}`);
    // --- End Merge ---

    // --- INLINE POOL PROCESSING LOGIC ---
    logger.debug('[loadConfig] Starting INLINE pool processing...');
    const allPoolConfigs = [];
    const loadedPoolAddresses = new Set();

    // V3 Pools
    if (baseConfig.UNISWAP_V3_ENABLED && networkSpecificConfig.UNISWAP_V3_POOLS) { /* ... unchanged V3 loop ... */
        for (const group of networkSpecificConfig.UNISWAP_V3_POOLS) { const token0 = baseConfig.TOKENS[group.token0Symbol]; const token1 = baseConfig.TOKENS[group.token1Symbol]; if (!token0 || !token1) continue; const pairTokenObjects = [token0, token1]; for (const feeTierStr in group.feeTierToEnvMap) { const envVarName = group.feeTierToEnvMap[feeTierStr]; if (!envVarName) continue; const fee = parseInt(feeTierStr, 10); if (isNaN(fee)) continue; const poolAddress = ConfigHelpers.Validators.validateAndNormalizeAddress(process.env[envVarName], envVarName); if (poolAddress && poolAddress !== ethers.ZeroAddress) { const lowerCaseAddress = poolAddress.toLowerCase(); if (loadedPoolAddresses.has(lowerCaseAddress)) continue; allPoolConfigs.push({ address: poolAddress, dexType: 'uniswapV3', fee: fee, token0Symbol: group.token0Symbol, token1Symbol: group.token1Symbol, pair: pairTokenObjects, groupName: group.name }); loadedPoolAddresses.add(lowerCaseAddress); } } }
    }
    // Sushi Pools
    if (baseConfig.SUSHISWAP_ENABLED && networkSpecificConfig.SUSHISWAP_POOLS) { /* ... unchanged Sushi loop ... */
        for (const poolInfo of networkSpecificConfig.SUSHISWAP_POOLS) { const token0 = baseConfig.TOKENS[poolInfo.token0Symbol]; const token1 = baseConfig.TOKENS[poolInfo.token1Symbol]; if (!token0 || !token1) continue; const pairTokenObjects = [token0, token1]; const envVarName = poolInfo.poolAddressEnv; if (!envVarName) continue; const poolAddress = ConfigHelpers.Validators.validateAndNormalizeAddress(process.env[envVarName], envVarName); if (poolAddress && poolAddress !== ethers.ZeroAddress) { const lowerCaseAddress = poolAddress.toLowerCase(); if (loadedPoolAddresses.has(lowerCaseAddress)) continue; const feeBps = poolInfo.fee; if (typeof feeBps !== 'number' || isNaN(feeBps)) { logger.warn(`[Config Sushi Detail] Pool ${poolInfo.name}: Invalid fee.`); } allPoolConfigs.push({ address: poolAddress, dexType: 'sushiswap', fee: feeBps, token0Symbol: poolInfo.token0Symbol, token1Symbol: poolInfo.token1Symbol, pair: pairTokenObjects, groupName: poolInfo.name }); loadedPoolAddresses.add(lowerCaseAddress); } }
    }
    // DODO Pools
    if (baseConfig.DODO_ENABLED && networkSpecificConfig.DODO_POOLS) { /* ... unchanged DODO loop ... */
        for (const poolInfo of networkSpecificConfig.DODO_POOLS) { const token0 = baseConfig.TOKENS[poolInfo.token0Symbol]; const token1 = baseConfig.TOKENS[poolInfo.token1Symbol]; if (!token0 || !token1) continue; const pairTokenObjects = [token0, token1]; if (!poolInfo.baseTokenSymbol || (poolInfo.baseTokenSymbol !== poolInfo.token0Symbol && poolInfo.baseTokenSymbol !== poolInfo.token1Symbol)) continue; const envVarName = poolInfo.poolAddressEnv; if (!envVarName) continue; const poolAddress = ConfigHelpers.Validators.validateAndNormalizeAddress(process.env[envVarName], envVarName); if (poolAddress && poolAddress !== ethers.ZeroAddress) { const lowerCaseAddress = poolAddress.toLowerCase(); if (loadedPoolAddresses.has(lowerCaseAddress)) continue; const feeBps = poolInfo.fee; if (feeBps !== undefined && (typeof feeBps !== 'number' || isNaN(feeBps))) { logger.warn(`[Config DODO Detail] Pool ${poolInfo.name}: Invalid fee.`); } allPoolConfigs.push({ address: poolAddress, dexType: 'dodo', fee: feeBps, token0Symbol: poolInfo.token0Symbol, token1Symbol: poolInfo.token1Symbol, pair: pairTokenObjects, baseTokenSymbol: poolInfo.baseTokenSymbol, groupName: poolInfo.name }); loadedPoolAddresses.add(lowerCaseAddress); } }
    }
    // --- *** END INLINE POOL PROCESSING *** ---

    baseConfig.POOL_CONFIGS = allPoolConfigs;

    if (baseConfig.DRY_RUN) { logger.warn("[Config] --- DRY RUN MODE ENABLED ---"); }
    else { logger.info("[Config] --- LIVE TRADING MODE ---"); }

    // --- Debug Log Before Return ---
    logger.debug("-----------------------------------------");
    logger.debug("[loadConfig] Final config keys before export:", Object.keys(baseConfig));
    logger.debug(`[loadConfig] UNISWAP_V3_ENABLED: ${baseConfig.UNISWAP_V3_ENABLED}`); // etc...
    logger.debug(`[loadConfig] GAS_COST_ESTIMATES type: ${typeof baseConfig.GAS_COST_ESTIMATES}, keys: ${baseConfig.GAS_COST_ESTIMATES ? Object.keys(baseConfig.GAS_COST_ESTIMATES).length : 'N/A'}`);
    logger.debug(`[loadConfig] POOL_CONFIGS length: ${baseConfig.POOL_CONFIGS?.length}`);
    logger.debug("-----------------------------------------");

    logger.info(`[loadConfig] Exiting loadConfig successfully with ${allPoolConfigs.length} pools loaded.`);
    return baseConfig;
}

// --- Load and Export Config ---
let config;
console.log('[Config] Attempting to call loadConfig inside try block...');
try {
    config = loadConfig();
    // Final validation check now includes GAS_COST_ESTIMATES
    const essentialKeys = [ /* ... previous keys ... */ 'GAS_COST_ESTIMATES'];
    const missingEssential = essentialKeys.filter(key => !(key in config) || config[key] === null || config[key] === undefined );
    if (missingEssential.length > 0) { throw new Error(`[Config Export] CRITICAL: Final config missing keys: ${missingEssential.join(', ')}`); }
    if (!Array.isArray(config.POOL_CONFIGS)) { throw new Error(`[Config Export] CRITICAL: POOL_CONFIGS is not an array.`); }
    if ((config.UNISWAP_V3_ENABLED || config.SUSHISWAP_ENABLED || config.DODO_ENABLED) && config.POOL_CONFIGS.length === 0) { logger.warn(`[Config Export] WARNING: DEXs enabled but POOL_CONFIGS empty.`); }
    logger.info(`[Config Export] Config loaded: Network=${config.NAME}, Pools=${config.POOL_CONFIGS.length}`);
} catch (error) { const msg = `[Config Export] CRITICAL FAILURE: ${error.message}`; logger.error(msg, error); console.error(msg, error); throw new Error(msg); }

module.exports = config;
console.log('[Config Top Level] module.exports reached.');
