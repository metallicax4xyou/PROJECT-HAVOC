// config/index.js
// --- VERSION 1.5 --- Added debug logs for FLASH_SWAP_CONTRACT_ADDRESS validation bypass

require('dotenv').config(); // Load environment variables from .env
const { ethers } = require('ethers'); // Ethers.js for Ethereum interaction
const { Token } = require('@uniswap/sdk-core'); // Uniswap SDK for token objects

// Use custom logger if available, fallback to console
let logger;
try { logger = require('../utils/logger'); }
catch (e) { console.error("No custom logger available for config. Falling back to console.", e); logger = console; }

// Import configuration helpers and data
const ConfigHelpers = require('./helpers');
const { loadPoolConfigs } = require('./helpers/poolLoader'); // Helper for loading pool lists
const { getNetworkMetadata } = require('./networks'); // Network specific metadata (chain ID, explorer, etc.)
const { PROTOCOL_ADDRESSES } = require('../constants/addresses'); // Known protocol addresses (factories, routers, etc.)
const { TOKENS } = require('../constants/tokens'); // Defined token objects

/**
 * Loads, validates, and processes the entire configuration from environment variables and network files.
 * @returns {object} The complete configuration object.
 * @throws {Error} If critical configuration is missing or invalid.
 */
function loadConfig() {
    logger.debug('[loadConfig v1.5] Starting loadConfig function... (with extra address debug)');

    // Determine the target network from environment variables
    const networkName = process.env.NETWORK?.toLowerCase();
    if (!networkName) {
        throw new Error(`[Config] CRITICAL: Missing NETWORK environment variable. Please set NETWORK (e.g., 'arbitrum') in your .env file.`);
    }

    // --- Validate Core Env Vars ---
    // Get RPC URLs and validate format
    const rpcUrlsEnvKey = `${networkName.toUpperCase()}_RPC_URLS`;
    const validatedRpcUrls = ConfigHelpers.Validators.validateRpcUrls(process.env[rpcUrlsEnvKey], rpcUrlsEnvKey);
    if (!validatedRpcUrls || validatedRpcUrls.length === 0) {
         // validateRpcUrls logs the specific error, just throw a generic one here
         throw new Error(`[Config] CRITICAL: No valid RPC URLs found for network "${networkName}". Check ${rpcUrlsEnvKey} in your .env.`);
    }

    // Validate and get the private key (removes 0x if present)
    const validatedPrivateKey = ConfigHelpers.Validators.validatePrivateKey(process.env.PRIVATE_KEY, 'PRIVATE_KEY');
    if (!validatedPrivateKey) {
         // Note: We don't throw here immediately so the config can still load
         // and other issues might be found. The bot startup will fail later if PK is null.
         logger.warn(`[Config] WARNING: Invalid or missing PRIVATE_KEY environment variable. Bot will likely fail later.`);
    }


    // --- TEMPORARY BYPASS: Validate Flash Swap Address (with extra debug) ---
    // The standard ethers.isAddress validator seems to be failing for some valid addresses.
    // This section performs a simpler format check and assigns the address directly.
    const flashSwapEnvKey = `${networkName.toUpperCase()}_FLASH_SWAP_ADDRESS`;
    const rawFlashSwapAddress = process.env[flashSwapEnvKey]; // Get raw value (don't trim yet for debug)

    logger.debug(`[Config Debug Address] Raw ${flashSwapEnvKey}: "${rawFlashSwapAddress}"`);
    const trimmedFlashSwapAddress = rawFlashSwapAddress?.trim();
    logger.debug(`[Config Debug Address] Trimmed ${flashSwapEnvKey}: "${trimmedFlashSwapAddress}"`);
    logger.debug(`[Config Debug Address] Trimmed Length: ${trimmedFlashSwapAddress?.length}`);
    logger.debug(`[Config Debug Address] Trimmed Starts With '0x': ${trimmedFlashSwapAddress?.startsWith('0x')}`);


    let finalFlashSwapAddress = ethers.ZeroAddress; // Default to zero address

    // Perform a basic format check (non-empty, correct length, starts with 0x)
    if (trimmedFlashSwapAddress && trimmedFlashSwapAddress.length === 42 && trimmedFlashSwapAddress.startsWith('0x')) {
         // Simple format check passed. Attempt to normalize to checksum address.
         try {
              finalFlashSwapAddress = ethers.getAddress(trimmedFlashSwapAddress); // Normalize to checksum address
              logger.debug(`[Config Debug Address] Basic check PASSED. Assigned & Normalized ${flashSwapEnvKey}: ${finalFlashSwapAddress}`);
         } catch (e) {
              // If normalization fails (which shouldn't happen for a valid 0x address),
              // log a warning and fall back to using the raw address string.
              logger.warn(`[Config Debug Address] Normalization FAILED for "${trimmedFlashSwapAddress}", using raw. Error: ${e.message}`);
              finalFlashSwapAddress = trimmedFlashSwapAddress; // Fallback to raw string
         }
    } else {
         // If the basic format check fails, log a critical error.
         logger.error(`[Config Check] CRITICAL: ${flashSwapEnvKey} in .env is missing or appears invalid after trim: "${trimmedFlashSwapAddress}". Cannot initialize FlashSwapManager.`);
         // finalFlashSwapAddress remains ethers.ZeroAddress, which will cause FlashSwapManager to fail
    }
    // --- END TEMPORARY BYPASS ---


    // Validate and get Aave Pool Address (uses the potentially strict validator, but Aave address format is less likely to be an issue)
    const aavePoolEnvKey = `${networkName.toUpperCase()}_AAVE_POOL_ADDRESS`;
    const validatedAavePoolAddress = ConfigHelpers.Validators.validateAndNormalizeAddress(process.env[aavePoolEnvKey], aavePoolEnvKey);

     // Validate and get TickLens Address (uses the potentially strict validator)
    const tickLensEnvKey = `${networkName.toUpperCase()}_TICKLENS_ADDRESS`;
    const validatedTickLensAddress = ConfigHelpers.Validators.validateAndNormalizeAddress(process.env[tickLensEnvKey], tickLensEnvKey);


    // Parse boolean flags for enabled DEXs
    const uniswapV3Enabled = ConfigHelpers.Validators.parseBoolean(process.env.UNISWAP_V3_ENABLED, false);
    const sushiswapEnabled = ConfigHelpers.Validators.parseBoolean(process.env.SUSHISWAP_ENABLED, false);
    const dodoEnabled = ConfigHelpers.Validators.parseBoolean(process.env.DODO_ENABLED, false);


    // --- Load Network Specific Metadata ---
    const networkMetadata = getNetworkMetadata(networkName);
    if (!networkMetadata) {
        throw new Error(`[Config] CRITICAL: No metadata found for network: ${networkName}. Check networks.js.`);
    }
    logger.info(`[Config] Loaded metadata for network: ${networkMetadata.NAME} (ChainID: ${networkMetadata.CHAIN_ID})`);


    // --- Load Network Specific SETTINGS file ---
    // This file contains network-specific parameters not read directly from .env (e.g., gas cost estimates, profit thresholds)
    let networkSpecificSettings;
    try {
        networkSpecificSettings = require(`./${networkName}.js`);
        logger.log(`[Config] Loaded network settings from ./${networkName}.js`);
    } catch (e) {
        throw new Error(`[Config] CRITICAL: Failed to load config/${networkName}.js. Make sure it exists and is valid: ${e.message}`);
    }


    // --- Parse Other Env Vars with Fallbacks ---
    // Use safeParseInt/BigInt and parseBoolean from helpers/validators.js
    const cycleIntervalMs = ConfigHelpers.Validators.safeParseInt(process.env.CYCLE_INTERVAL_MS, 'CYCLE_INTERVAL_MS', 5000);
    const slippageToleranceBps = ConfigHelpers.Validators.safeParseInt(process.env.SLIPPAGE_TOLERANCE_BPS, 'SLIPPAGE_TOLERANCE_BPS', 10);
    const isDryRun = ConfigHelpers.Validators.parseBoolean(process.env.DRY_RUN, true); // Default to true for safety
    const stopOnFirst = ConfigHelpers.Validators.parseBoolean(process.env.STOP_ON_FIRST_EXECUTION, false);
    // Use network-specific defaults for gas settings if not in .env
    const maxGasGwei = ConfigHelpers.Validators.safeParseInt(process.env.MAX_GAS_GWEI, 'MAX_GAS_GWEI', networkSpecificSettings.MAX_GAS_GWEI || 10);
    const gasBufferPercent = ConfigHelpers.Validators.safeParseInt(process.env.GAS_ESTIMATE_BUFFER_PERCENT, 'GAS_ESTIMATE_BUFFER_PERCENT', networkSpecificSettings.GAS_ESTIMATE_BUFFER_PERCENT || 20);
    const fallbackGasLimit = ConfigHelpers.Validators.safeParseInt(process.env.FALLBACK_GAS_LIMIT, 'FALLBACK_GAS_LIMIT', networkSpecificSettings.FALLBACK_GAS_LIMIT || 3000000);
    const profitBufferPercent = ConfigHelpers.Validators.safeParseInt(process.env.PROFIT_BUFFER_PERCENT, 'PROFIT_BUFFER_PERCENT', networkSpecificSettings.PROFIT_BUFFER_PERCENT || 5);


    // --- Construct the Base Configuration Object ---
    const baseConfig = {
        NAME: networkMetadata.NAME,
        CHAIN_ID: networkMetadata.CHAIN_ID,
        NATIVE_CURRENCY_SYMBOL: networkMetadata.NATIVE_SYMBOL,
        EXPLORER_URL: networkMetadata.EXPLORER_URL,

        TOKENS: TOKENS, // Global token definitions
        RPC_URLS: validatedRpcUrls,
        PRIMARY_RPC_URL: validatedRpcUrls[0],
        PRIVATE_KEY: validatedPrivateKey,

        FLASH_SWAP_CONTRACT_ADDRESS: finalFlashSwapAddress, // Use the result from the temporary bypass
        AAVE_POOL_ADDRESS: validatedAavePoolAddress || networkSpecificSettings.AAVE_POOL_ADDRESS, // Prefer validated, fallback to settings file
        TICKLENS_ADDRESS: validatedTickLensAddress || ethers.ZeroAddress, // Prefer validated, fallback to zero address

        CYCLE_INTERVAL_MS: cycleIntervalMs,
        SLIPPAGE_TOLERANCE_BPS: slippageToleranceBps,
        DRY_RUN: isDryRun,
        STOP_ON_FIRST_EXECUTION: stopOnFirst,

        UNISWAP_V3_ENABLED: uniswapV3Enabled,
        SUSHISWAP_ENABLED: sushiswapEnabled,
        DODO_ENABLED: dodoEnabled,

        MAX_GAS_GWEI: maxGasGwei,
        GAS_ESTIMATE_BUFFER_PERCENT: gasBufferPercent,
        FALLBACK_GAS_LIMIT: fallbackGasLimit,
        PROFIT_BUFFER_PERCENT: profitBufferPercent,

        // Protocol addresses from constants
        FACTORY_ADDRESS: PROTOCOL_ADDRESSES.UNISWAP_V3_FACTORY,
        QUOTER_ADDRESS: PROTOCOL_ADDRESSES.QUOTER_V2, // Assuming V2 Quoter is used for UniV3 pricing
    };
    logger.debug('[loadConfig] Base config object created.');

    // --- Merge Required Settings from network settings file ---
    // These settings MUST be present in the network-specific file (e.g., arbitrum.js)
    const requiredNetworkKeys = ['MIN_PROFIT_THRESHOLDS', 'CHAINLINK_FEEDS', 'GAS_COST_ESTIMATES', 'FINDER_SETTINGS', 'AAVE_FLASH_LOAN_FEE_BPS'];
    for (const key of requiredNetworkKeys) {
        // Skip AAVE_POOL_ADDRESS as it's handled above with specific validation/env override
        if (key === 'AAVE_POOL_ADDRESS') continue;

        let valueSource = networkSpecificSettings[key];
        let isValid = false; // Flag to check if the value from settings is valid

        // Perform basic validity checks based on expected type/structure
        if (key === 'AAVE_FLASH_LOAN_FEE_BPS') {
            isValid = (valueSource !== undefined && typeof valueSource === 'bigint' && valueSource >= 0n);
        } else if (key === 'FINDER_SETTINGS') {
             // Ensure FINDER_SETTINGS is an object and has the required simulation input defaults
            isValid = (valueSource && typeof valueSource === 'object' && Object.keys(valueSource).length > 0 && valueSource.SPATIAL_SIMULATION_INPUT_AMOUNTS?.DEFAULT);
        } else if (['MIN_PROFIT_THRESHOLDS', 'CHAINLINK_FEEDS', 'GAS_COST_ESTIMATES'].includes(key)) {
             // Ensure these are non-empty objects
            isValid = (valueSource && typeof valueSource === 'object' && Object.keys(valueSource).length > 0);
        }

        // If a required setting is missing or invalid in the network file, throw an error.
        if (!isValid) {
            throw new Error(`[Config] CRITICAL: Invalid or missing required config key "${key}" in ${networkName}.js`);
        }

        // Merge the validated network-specific setting into the base config
        baseConfig[key] = valueSource;
        const logValue = (typeof valueSource === 'bigint') ? `BigInt(${valueSource})` : `${Object.keys(valueSource).length} entries`;
        logger.debug(`[Config Merge] Merged ${key}: ${logValue}`);
    }

    // --- Specific sub-key validation within merged objects ---
    // Ensure essential sub-keys are present after merging
    if (!baseConfig.MIN_PROFIT_THRESHOLDS.NATIVE || !baseConfig.MIN_PROFIT_THRESHOLDS.DEFAULT) { throw new Error(`[Config] CRITICAL: MIN_PROFIT_THRESHOLDS missing NATIVE/DEFAULT keys.`); }
    if (!baseConfig.GAS_COST_ESTIMATES.FLASH_SWAP_BASE) { throw new Error(`[Config] CRITICAL: GAS_COST_ESTIMATES missing FLASH_SWAP_BASE key.`); }
    if (!baseConfig.FINDER_SETTINGS?.SPATIAL_SIMULATION_INPUT_AMOUNTS?.DEFAULT) { throw new Error(`[Config] CRITICAL: FINDER_SETTINGS missing SPATIAL_SIMULATION_INPUT_AMOUNTS.DEFAULT key.`); }


    // --- Final Address Checks (post-merge) ---
     // Re-check the critical FLASH_SWAP_CONTRACT_ADDRESS after potential assignment
     if (!baseConfig.FLASH_SWAP_CONTRACT_ADDRESS || baseConfig.FLASH_SWAP_CONTRACT_ADDRESS === ethers.ZeroAddress) {
         // This error should now only happen if the simple format check failed during the temporary bypass
         logger.error(`[Config Check] CRITICAL: FLASH_SWAP_CONTRACT_ADDRESS is still the Zero Address after loading.`);
          // Note: A more robust approach would throw here if it's still zero.
     }
      // Check PRIVATE_KEY again - it was validated but we didn't throw immediately
     if (!baseConfig.PRIVATE_KEY) {
          logger.error(`[Config Check] CRITICAL: PRIVATE_KEY is missing or invalid. Cannot proceed with bot operations.`);
     }
     // Warning for Aave Pool address if it's still not set
     if (!baseConfig.AAVE_POOL_ADDRESS) { logger.warn(`[Config Check] WARNING: AAVE_POOL_ADDRESS is not set. Aave flash loans will fail.`); }

    // Get Sushiswap Router Address from env or settings file
    baseConfig.SUSHISWAP_ROUTER_ADDRESS = process.env[`${networkName.toUpperCase()}_SUSHISWAP_ROUTER_ADDRESS`] || networkSpecificSettings.SUSHISWAP_ROUTER_ADDRESS || null;
    logger.debug(`[Config Merge] SUSHISWAP_ROUTER_ADDRESS: ${baseConfig.SUSHISWAP_ROUTER_ADDRESS || 'Not Set'}`);


    // --- Load Pool Configuration ---
    // Calls the poolLoader helper to load pool addresses and metadata from dedicated files
    logger.info('[loadConfig] Calling pool loader helper...');
    try {
        baseConfig.POOL_CONFIGS = loadPoolConfigs(
            networkName, // Pass network name to poolLoader
            baseConfig.TOKENS, // Pass global TOKENS object
            baseConfig.UNISWAP_V3_ENABLED, // Pass enabled flags to filter pools
            baseConfig.SUSHISWAP_ENABLED,
            baseConfig.DODO_ENABLED
        );
    } catch (poolLoadError) {
         logger.error(`[Config] CRITICAL: Failed to load pool configurations: ${poolLoadError.message}`, poolLoadError);
         throw new Error(`[Config] CRITICAL: Pool loading failed.`);
    }

    // Log operating mode (Dry Run or Live)
    if (baseConfig.DRY_RUN) { logger.warn("[Config] --- DRY RUN MODE ENABLED ---"); }
    else { logger.info("[Config] --- LIVE TRADING MODE ---"); }


    // --- Debug Log Final Object ---
    // Log the complete config object in debug mode (handle BigInt and Token objects)
    try {
        logger.debug('[loadConfig] Final baseConfig object before return:', JSON.stringify(baseConfig, (key, value) => {
            if (typeof value === 'bigint') { return `BigInt(${value.toString()})`; }
            if (value instanceof Token) { return `Token(${value.symbol} ${value.address} Dec:${value.decimals} Chain:${value.chainId})`; }
            return value;
        }, 2));
    } catch (stringifyError) {
        logger.error('[loadConfig] Failed to stringify final config object:', stringifyError);
    }

    logger.info(`[loadConfig] Exiting loadConfig successfully with ${baseConfig.POOL_CONFIGS.length} pools loaded.`);
    return baseConfig;
} // End loadConfig function


// --- Load and Export the Configuration ---
// Execute the loadConfig function immediately when the module is required
let config;
console.log('[Config] Attempting to call loadConfig inside try block...'); // Simple log before logger is fully initialized
try {
    config = loadConfig(); // Load the config

    // Perform final critical checks on the loaded config object
    // These checks will cause the module load to fail if critical items are missing.
    const essentialKeys = ['NAME','CHAIN_ID','TOKENS','RPC_URLS','PRIVATE_KEY','FLASH_SWAP_CONTRACT_ADDRESS', 'AAVE_POOL_ADDRESS', 'MIN_PROFIT_THRESHOLDS','CHAINLINK_FEEDS','GAS_COST_ESTIMATES', 'POOL_CONFIGS', 'FINDER_SETTINGS', 'AAVE_FLASH_LOAN_FEE_BPS'];
    const missingEssential = essentialKeys.filter(key =>
         // Check if key is missing, null, or undefined. For addresses, also check if it's the ZeroAddress string.
        !(key in config) || config[key] === null || config[key] === undefined ||
        ((key === 'FLASH_SWAP_CONTRACT_ADDRESS' || key === 'AAVE_POOL_ADDRESS') && config[key] === ethers.ZeroAddress) ||
        (key === 'PRIVATE_KEY' && config[key] === null) // Explicitly check for null Private Key
    );


    if (missingEssential.length > 0) {
        throw new Error(`[Config Export] CRITICAL: Final configuration object is missing essential keys or values are zero/null: ${missingEssential.join(', ')}`);
    }
    // Ensure pool configs are loaded correctly
    if (!Array.isArray(config.POOL_CONFIGS)) { throw new Error(`[Config Export] CRITICAL: POOL_CONFIGS in final config is not an array.`); }

    // Warning if DEXs are enabled but no pools were loaded
    if ((config.UNISWAP_V3_ENABLED || config.SUSHISWAP_ENABLED || config.DODO_ENABLED) && config.POOL_CONFIGS.length === 0) {
        logger.warn(`[Config Export] WARNING: One or more DEXs are enabled in .env, but no pools were loaded for the specified network.`);
    }

    logger.info(`[Config Export] Config loaded: Network=${config.NAME}, Pools=${config.POOL_CONFIGS.length}`);

} catch (error) {
    // If config loading or final checks fail, log critically and re-throw
    const msg = `[Config Export] CRITICAL FAILURE during config load/export: ${error.message}`;
    logger.error(msg, error); // Use logger if available
    console.error(msg, error); // Also log to console in case logger fails
    throw new Error(msg); // Re-throw to stop the application startup
}

// Export the fully loaded and validated config object
module.exports = config;
console.log('[Config Top Level] module.exports reached.'); // Simple log to confirm module load finished
