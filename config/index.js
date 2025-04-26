// config/index.js
// --- VERSION 1.2 --- Added Aave config validation. Using Pool Loader Helper.

require('dotenv').config();
const { ethers } = require('ethers');
const { Token } = require('@uniswap/sdk-core');
let logger; try { logger = require('../utils/logger'); } catch (e) { console.error("No logger"); logger = console; }

const ConfigHelpers = require('./helpers');
const { loadPoolConfigs } = require('./helpers/poolLoader');
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
    // --- ADDED Aave Address Validation from Env ---
    const aavePoolEnvKey = `${networkName.toUpperCase()}_AAVE_POOL_ADDRESS`;
    const validatedAavePoolAddress = ConfigHelpers.Validators.validateAndNormalizeAddress(process.env[aavePoolEnvKey], aavePoolEnvKey);
    // --- ---
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

    // --- Other Env Vars / Defaults ---
    const cycleIntervalMs = ConfigHelpers.Validators.safeParseInt(process.env.CYCLE_INTERVAL_MS, 'CYCLE_INTERVAL_MS', 5000);
    const slippageToleranceBps = ConfigHelpers.Validators.safeParseInt(process.env.SLIPPAGE_TOLERANCE_BPS, 'SLIPPAGE_TOLERANCE_BPS', 10);
    const isDryRun = ConfigHelpers.Validators.parseBoolean(process.env.DRY_RUN, true);
    const stopOnFirst = ConfigHelpers.Validators.parseBoolean(process.env.STOP_ON_FIRST_EXECUTION, false);
    const maxGasGwei = ConfigHelpers.Validators.safeParseInt(process.env.MAX_GAS_GWEI, 'MAX_GAS_GWEI', networkSpecificConfig.MAX_GAS_GWEI || 10);
    const gasBufferPercent = ConfigHelpers.Validators.safeParseInt(process.env.GAS_ESTIMATE_BUFFER_PERCENT, 'GAS_ESTIMATE_BUFFER_PERCENT', networkSpecificConfig.GAS_ESTIMATE_BUFFER_PERCENT || 20);
    const fallbackGasLimit = ConfigHelpers.Validators.safeParseInt(process.env.FALLBACK_GAS_LIMIT, 'FALLBACK_GAS_LIMIT', networkSpecificConfig.FALLBACK_GAS_LIMIT || 3000000);
    const profitBufferPercent = ConfigHelpers.Validators.safeParseInt(process.env.PROFIT_BUFFER_PERCENT, 'PROFIT_BUFFER_PERCENT', networkSpecificConfig.PROFIT_BUFFER_PERCENT || 5);

    // --- Base Config Object ---
    const baseConfig = {
        NAME: networkMetadata.NAME, CHAIN_ID: networkMetadata.CHAIN_ID, NATIVE_CURRENCY_SYMBOL: networkMetadata.NATIVE_SYMBOL, EXPLORER_URL: networkMetadata.EXPLORER_URL,
        TOKENS: TOKENS, RPC_URLS: validatedRpcUrls, PRIMARY_RPC_URL: validatedRpcUrls[0], PRIVATE_KEY: validatedPrivateKey,
        FLASH_SWAP_CONTRACT_ADDRESS: validatedFlashSwapAddress || ethers.ZeroAddress, // Use validated address
        AAVE_POOL_ADDRESS: validatedAavePoolAddress || networkSpecificConfig.AAVE_POOL_ADDRESS, // <<< Use validated env var first, fallback to network file if needed
        TICKLENS_ADDRESS: validatedTickLensAddress || ethers.ZeroAddress,
        CYCLE_INTERVAL_MS: cycleIntervalMs, SLIPPAGE_TOLERANCE_BPS: slippageToleranceBps, DRY_RUN: isDryRun, STOP_ON_FIRST_EXECUTION: stopOnFirst,
        UNISWAP_V3_ENABLED: uniswapV3Enabled, SUSHISWAP_ENABLED: sushiswapEnabled, DODO_ENABLED: dodoEnabled,
        MAX_GAS_GWEI: maxGasGwei, GAS_ESTIMATE_BUFFER_PERCENT: gasBufferPercent, FALLBACK_GAS_LIMIT: fallbackGasLimit, PROFIT_BUFFER_PERCENT: profitBufferPercent,
        FACTORY_ADDRESS: PROTOCOL_ADDRESSES.UNISWAP_V3_FACTORY, QUOTER_ADDRESS: PROTOCOL_ADDRESSES.QUOTER_V2,
    };
    logger.debug('[loadConfig] Base config object created.');

    // --- Merge Required Settings from network file ---
    // Added AAVE_FLASH_LOAN_FEE_BPS check
    const requiredNetworkKeys = ['MIN_PROFIT_THRESHOLDS', 'CHAINLINK_FEEDS', 'GAS_COST_ESTIMATES', 'FINDER_SETTINGS', 'AAVE_FLASH_LOAN_FEE_BPS'];
    for (const key of requiredNetworkKeys) {
        let valueSource = networkSpecificConfig[key]; // Check network file first

        // Special handling for AAVE_POOL_ADDRESS - already loaded above
        if (key === 'AAVE_POOL_ADDRESS') continue;

        // Validate source exists and has expected type/content
        let isValid = false;
        if (key === 'AAVE_FLASH_LOAN_FEE_BPS') {
            isValid = (valueSource !== undefined && typeof valueSource === 'bigint' && valueSource >= 0n);
        } else if (key === 'FINDER_SETTINGS') {
            isValid = (valueSource && typeof valueSource === 'object' && Object.keys(valueSource).length > 0 && valueSource.SPATIAL_SIMULATION_INPUT_AMOUNTS?.DEFAULT);
        } else if (['MIN_PROFIT_THRESHOLDS', 'CHAINLINK_FEEDS', 'GAS_COST_ESTIMATES'].includes(key)) {
             isValid = (valueSource && typeof valueSource === 'object' && Object.keys(valueSource).length > 0);
             // Add specific sub-key checks after merge if needed
        }

        if (!isValid) {
            throw new Error(`Invalid or missing required config key "${key}" in ${networkName}.js`);
        }

        baseConfig[key] = valueSource;
        const logValue = (typeof valueSource === 'bigint') ? `BigInt(${valueSource})` : `${Object.keys(valueSource).length} entries`;
        logger.debug(`[Config Merge] Merged ${key}: ${logValue}`);
    }
    // --- Specific sub-key validation ---
    if (!baseConfig.MIN_PROFIT_THRESHOLDS.NATIVE || !baseConfig.MIN_PROFIT_THRESHOLDS.DEFAULT) { throw new Error(`MIN_PROFIT_THRESHOLDS missing NATIVE/DEFAULT keys.`); }
    if (!baseConfig.GAS_COST_ESTIMATES.FLASH_SWAP_BASE) { throw new Error(`GAS_COST_ESTIMATES missing FLASH_SWAP_BASE key.`); }
    if (!baseConfig.FINDER_SETTINGS?.SPATIAL_SIMULATION_INPUT_AMOUNTS?.DEFAULT) { throw new Error(`FINDER_SETTINGS missing SPATIAL_SIMULATION_INPUT_AMOUNTS.DEFAULT key.`); }
    // --- ---

    // --- Final address checks ---
     if (!baseConfig.FLASH_SWAP_CONTRACT_ADDRESS || baseConfig.FLASH_SWAP_CONTRACT_ADDRESS === ethers.ZeroAddress) { logger.error(`[Config Check] CRITICAL: FLASH_SWAP_CONTRACT_ADDRESS is not set or is Zero Address.`); }
     if (!baseConfig.AAVE_POOL_ADDRESS) { logger.warn(`[Config Check] WARNING: AAVE_POOL_ADDRESS is not set. Aave flash loans will fail.`); }
     // --- ---

    baseConfig.SUSHISWAP_ROUTER_ADDRESS = process.env[`${networkName.toUpperCase()}_SUSHISWAP_ROUTER_ADDRESS`] || networkSpecificConfig.SUSHISWAP_ROUTER_ADDRESS || null;
    logger.debug(`[Config Merge] SUSHISWAP_ROUTER_ADDRESS: ${baseConfig.SUSHISWAP_ROUTER_ADDRESS || 'Not Set'}`);

    // --- CALL POOL LOADER HELPER ---
    logger.info('[loadConfig] Calling pool loader helper...');
    baseConfig.POOL_CONFIGS = loadPoolConfigs(
        baseConfig.TOKENS, networkSpecificConfig,
        baseConfig.UNISWAP_V3_ENABLED, baseConfig.SUSHISWAP_ENABLED, baseConfig.DODO_ENABLED
    );

    if (baseConfig.DRY_RUN) { logger.warn("[Config] --- DRY RUN MODE ENABLED ---"); }
    else { logger.info("[Config] --- LIVE TRADING MODE ---"); }

    // --- Debug Log Before Return (Optional: Can be removed later) ---
    try {
        logger.debug('[loadConfig] Final baseConfig object before return:', JSON.stringify(baseConfig, (key, value) => {
             if (typeof value === 'bigint') { return `BigInt(${value.toString()})`; }
             if (value instanceof Token) { return `Token(${value.symbol} ${value.address} Dec:${value.decimals} Chain:${value.chainId})`; }
             return value;
        }, 2));
    } catch (stringifyError) { logger.error('[loadConfig] Failed to stringify final config object for debugging:', stringifyError); }
    // --- ---

    logger.info(`[loadConfig] Exiting loadConfig successfully with ${baseConfig.POOL_CONFIGS.length} pools loaded.`);
    return baseConfig;
} // End loadConfig function

// --- Load and Export Config ---
let config;
console.log('[Config] Attempting to call loadConfig inside try block...');
try {
    config = loadConfig();
    // Added AAVE_POOL_ADDRESS, AAVE_FLASH_LOAN_FEE_BPS checks
    const essentialKeys = ['NAME','CHAIN_ID','TOKENS','RPC_URLS','PRIVATE_KEY','FLASH_SWAP_CONTRACT_ADDRESS', 'AAVE_POOL_ADDRESS', 'MIN_PROFIT_THRESHOLDS','CHAINLINK_FEEDS','GAS_COST_ESTIMATES', 'POOL_CONFIGS', 'FINDER_SETTINGS', 'AAVE_FLASH_LOAN_FEE_BPS'];
    const missingEssential = essentialKeys.filter(key => !(key in config) || config[key] === null || config[key] === undefined );
    if (missingEssential.length > 0) { throw new Error(`[Config Export] CRITICAL: Final config missing keys: ${missingEssential.join(', ')}`); }
    if (!Array.isArray(config.POOL_CONFIGS)) { throw new Error(`[Config Export] CRITICAL: POOL_CONFIGS is not an array.`); }
    if ((config.UNISWAP_V3_ENABLED || config.SUSHISWAP_ENABLED || config.DODO_ENABLED) && config.POOL_CONFIGS.length === 0) { logger.warn(`[Config Export] WARNING: DEXs enabled but POOL_CONFIGS empty.`); }
    logger.info(`[Config Export] Config loaded: Network=${config.NAME}, Pools=${config.POOL_CONFIGS.length}`);
} catch (error) { const msg = `[Config Export] CRITICAL FAILURE: ${error.message}`; logger.error(msg, error); console.error(msg, error); throw new Error(msg); }

module.exports = config;
console.log('[Config Top Level] module.exports reached.');
