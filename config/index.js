// config/index.js
// --- VERSION 1.8 --- Refined loading/validation for MIN_PROFIT_THRESHOLDS and other required network settings.

require('dotenv').config(); // Load environment variables from .env
const { ethers } = require('ethers'); // Ethers.js for Ethereum interaction
const { Token } = require('@uniswap/sdk-core'); // Uniswap SDK for token objects

// Use custom logger if available, fallback to console
let logger;
try { logger = require('../utils/logger'); }
catch (e) { console.error("No custom logger available for config. Falling back to console.", e); logger = console; }

// Import configuration helpers and data
const ConfigHelpers = require('./helpers'); // Contains Validators
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
    logger.debug('[loadConfig v1.8] Starting loadConfig function...'); // Updated version log

    // Determine the target network from environment variables
    const networkName = process.env.NETWORK?.toLowerCase();
    if (!networkName) {
        throw new Error(`[Config] CRITICAL: Missing NETWORK environment variable. Please set NETWORK (e.g., 'arbitrum' or 'localFork') in your .env file.`);
    }

    // --- Load Network Specific Metadata FIRST ---
    const networkMetadata = getNetworkMetadata(networkName);
    if (!networkMetadata) {
        // This check should ideally not be reached due to the throw in getNetworkMetadata,
        // but keeping for safety.
        throw new Error(`[Config] CRITICAL: No metadata found for network: ${networkName}. Check networks.js.`);
    }
    logger.info(`[Config] Loaded metadata for network: ${networkMetadata.NAME} (ChainID: ${networkMetadata.CHAIN_ID})`);


    // --- Get RPC URLs ---
    let validatedRpcUrls;
    if (networkMetadata.RPC_URL) {
        // If the network metadata explicitly provides an RPC_URL (like for localFork), use that
        validatedRpcUrls = [networkMetadata.RPC_URL];
        logger.debug(`[Config] Using RPC URL from network metadata: ${networkMetadata.RPC_URL}`);
    } else {
        // Otherwise, load and validate RPC URLs from environment variables as before
        const rpcUrlsEnvKey = `${networkName.toUpperCase()}_RPC_URLS`;
        validatedRpcUrls = ConfigHelpers.Validators.validateRpcUrls(process.env[rpcUrlsEnvKey], rpcUrlsEnvKey);
        if (!validatedRpcUrls || validatedRpcUrls.length === 0) {
             // validateRpcUrls logs the specific error, just throw a generic one here
             throw new Error(`[Config] CRITICAL: No valid RPC URLs found for network "${networkName}". Check ${rpcUrlsEnvKey} in your .env.`);
        }
        logger.debug(`[Config] Using RPC URLs from environment variable ${rpcUrlsEnvKey}: ${validatedRpcUrls.join(', ')}`);
    }


    // Validate and get the private key (removes 0x if present)
    // Note: For localFork with hardcoded PK in hardhat.config.js, the bot might not need the PK
    // in the env, but it's validated here for consistency with live networks.
    const validatedPrivateKey = ConfigHelpers.Validators.validatePrivateKey(process.env.PRIVATE_KEY, 'PRIVATE_KEY');
    if (!validatedPrivateKey && networkMetadata.CHAIN_ID !== 31337 && networkMetadata.CHAIN_ID !== 1337) { // Don't warn for local chains
         logger.warn(`[Config] WARNING: Invalid or missing PRIVATE_KEY environment variable for non-local network. Bot will likely fail later.`);
    }


    // --- Load Network Specific SETTINGS file ---
    // This file contains network-specific parameters not read directly from .env (e.g., gas cost estimates, profit thresholds)
    let networkSpecificSettings;
    try {
        // Use the networkName from metadata to load the correct file
        // Ensure the file name matches the lowercase networkName, but the exported object might have the uppercase NAME
        networkSpecificSettings = require(`./${networkName}.js`); // Use lowercase networkName for file path
        logger.info(`[Config] Loaded network settings from ./${networkName}.js`);
    } catch (e) {
        throw new Error(`[Config] CRITICAL: Failed to load config/${networkName}.js. Make sure it exists and is valid: ${e.message}`);
    }


    // --- Get Flash Swap Address ---
    // Prioritize address from network-specific settings file, fallback to environment variable
    let finalFlashSwapAddress = networkSpecificSettings.FLASH_SWAP_CONTRACT_ADDRESS;
    const flashSwapEnvKey = `${networkName.toUpperCase()}_FLASH_SWAP_ADDRESS`;
    const rawFlashSwapAddressFromEnv = process.env[flashSwapEnvKey];

    if (!finalFlashSwapAddress && rawFlashSwapAddressFromEnv) {
        // If not found in settings file, check environment variable
         logger.debug(`[Config] Flash Swap address not found in ${networkName}.js, checking environment variable ${flashSwapEnvKey}.`); // Use lowercase name for log
        // Perform a basic format check and assign
        if (rawFlashSwapAddressFromEnv.trim().length === 42 && rawFlashSwapAddressFromEnv.trim().startsWith('0x')) {
             try {
                  finalFlashSwapAddress = ethers.getAddress(rawFlashSwapAddressFromEnv.trim()); // Normalize to checksum address
                  logger.debug(`[Config] Validated & Normalized ${flashSwapEnvKey} from env: ${finalFlashSwapAddress}`);
             } catch (e) {
                  logger.warn(`[Config] Normalization FAILED for "${rawFlashSwapAddressFromEnv.trim()}" from env, using raw. Error: ${e.message}`);
                  finalFlashSwapAddress = rawFlashSwapAddressFromEnv.trim(); // Fallback to raw string
             }
        } else {
             logger.warn(`[Config] ${flashSwapEnvKey} in .env appears invalid: "${rawFlashSwapAddressFromEnv}". Ignoring.`);
        }
    } else if (finalFlashSwapAddress) {
         // If found in settings file, just log it
         logger.debug(`[Config] Using Flash Swap address from ${networkName}.js: ${finalFlashSwapAddress}`); // Use lowercase name for log
         // Attempt to normalize it just in case it's not checksummed in the file
         try {
             finalFlashSwapAddress = ethers.getAddress(finalFlashSwapAddress);
             logger.debug(`[Config] Normalized Flash Swap address from settings: ${finalFlashSwapAddress}`);
         } catch (e) {
             logger.warn(`[Config] Normalization FAILED for Flash Swap address from settings "${finalFlashSwapAddress}", using raw. Error: ${e.message}`);
         }
    } else {
         // If not found in either place
         logger.error(`[Config] CRITICAL: FLASH_SWAP_CONTRACT_ADDRESS is missing from both ${networkName}.js AND environment variable ${flashSwapEnvKey}. Cannot initialize FlashSwapManager.`); // Use lowercase name for log
         // finalFlashSwapAddress remains potentially undefined or the last assigned value, will be caught in final checks
    }
    // Ensure finalFlashSwapAddress is a string or null/undefined for consistent validation later
    if (finalFlashSwapAddress && typeof finalFlashSwapAddress !== 'string') {
         logger.warn(`[Config] Final Flash Swap Address is not a string (${typeof finalFlashSwapAddress}). Casting to string.`);
         finalFlashSwapAddress = String(finalFlashSwapAddress);
    }


    // Validate and get Aave Pool Address
    // Prioritize from settings file (more reliable for network-specific protocols), fallback to env
    const validatedAavePoolAddress = ConfigHelpers.Validators.validateAndNormalizeAddress(networkSpecificSettings.AAVE_POOL_ADDRESS || process.env[`${networkName.toUpperCase()}_AAVE_POOL_ADDRESS`], 'AAVE_POOL_ADDRESS');

     // Validate and get TickLens Address
     // Prioritize from settings file, fallback to env
    const validatedTickLensAddress = ConfigHelpers.Validators.validateAndNormalizeAddress(networkSpecificSettings.TICKLENS_ADDRESS || process.env[`${networkName.toUpperCase()}_TICKLENS_ADDRESS`], 'TICKLENS_ADDRESS');


    // Validate and get TITHE_WALLET_ADDRESS
    const titheWalletEnvKey = 'TITHE_WALLET_ADDRESS'; // Always from env
    const validatedTitheWalletAddress = ConfigHelpers.Validators.validateAndNormalizeAddress(process.env[titheWalletEnvKey], titheWalletEnvKey);


    // Parse boolean flags for enabled DEXs
    const uniswapV3Enabled = ConfigHelpers.Validators.parseBoolean(process.env.UNISWAP_V3_ENABLED, false);
    const sushiswapEnabled = ConfigHelpers.Validators.parseBoolean(process.env.SUSHISWAP_ENABLED, false);
    const dodoEnabled = ConfigHelpers.Validators.parseBoolean(process.env.DODO_ENABLED, false);


    // --- Parse Other Env Vars with Fallbacks (Prefer Env, then network settings defaults) ---
    // Use safeParseInt/BigInt and parseBoolean from helpers/validators.js
    const cycleIntervalMs = ConfigHelpers.Validators.safeParseInt(process.env.CYCLE_INTERVAL_MS, 'CYCLE_INTERVAL_MS', networkSpecificSettings.CYCLE_INTERVAL_MS || 5000);
    const slippageToleranceBps = ConfigHelpers.Validators.safeParseInt(process.env.SLIPPAGE_TOLERANCE_BPS, 'SLIPPAGE_TOLERANCE_BPS', networkSpecificSettings.SLIPPAGE_TOLERANCE_BPS || 10);
    const isDryRun = ConfigHelpers.Validators.parseBoolean(process.env.DRY_RUN, networkSpecificSettings.DRY_RUN || true); // Default to true for safety
    const stopOnFirst = ConfigHelpers.Validators.parseBoolean(process.env.STOP_ON_FIRST_EXECUTION, networkSpecificSettings.STOP_ON_FIRST_EXECUTION || false);
    // Use network-specific defaults for gas settings if not in .env
    const maxGasGwei = ConfigHelpers.Validators.safeParseInt(process.env.MAX_GAS_GWEI, 'MAX_GAS_GWEI', networkSpecificSettings.MAX_GAS_GWEI || 10);
    const gasBufferPercent = ConfigHelpers.Validators.safeParseInt(process.env.GAS_ESTIMATE_BUFFER_PERCENT, 'GAS_ESTIMATE_BUFFER_PERCENT', networkSpecificSettings.GAS_ESTIMATE_BUFFER_PERCENT || 20);
    const fallbackGasLimit = ConfigHelpers.Validators.safeParseInt(process.env.FALLBACK_GAS_LIMIT, 'FALLBACK_GAS_LIMIT', networkSpecificSettings.FALLBACK_GAS_LIMIT || 3000000);
    const profitBufferPercent = ConfigHelpers.Validators.safeParseInt(process.env.PROFIT_BUFFER_PERCENT, 'PROFIT_BUFFER_PERCENT', networkSpecificSettings.PROFIT_BUFFER_PERCENT || 5);

    // Also load network-specific borrow amounts if they exist in the settings file
    const borrowAmounts = networkSpecificSettings.BORROW_AMOUNTS || {};
    // Merge with env vars if they exist (env vars take precedence)
    Object.keys(process.env).forEach(key => {
        if (key.startsWith('BORROW_AMOUNT_')) {
            const tokenSymbol = key.replace('BORROW_AMOUNT_', '');
            const amount = process.env[key];
            // Basic check if amount looks like a number string
            if (amount && !isNaN(parseFloat(amount))) {
                 borrowAmounts[tokenSymbol] = parseFloat(amount);
                 logger.debug(`[Config Merge] Overriding BORROW_AMOUNT_${tokenSymbol} from env: ${amount}`);
            } else if (amount) {
                 logger.warn(`[Config Merge] Invalid value for ${key} in env: "${amount}". Ignoring.`);
            }
        }
    });
    // Ensure borrow amounts are numbers (or null/undefined if not set)
    for (const symbol in borrowAmounts) {
         if (borrowAmounts[symbol] !== null && borrowAmounts[symbol] !== undefined && typeof borrowAmounts[symbol] !== 'number') {
              logger.warn(`[Config Merge] BORROW_AMOUNT for ${symbol} is not a number (${typeof borrowAmounts[symbol]}). Setting to null.`);
              borrowAmounts[symbol] = null; // Or delete? Set to null for clarity
         }
    }
    logger.debug('[loadConfig] Final Borrow Amounts:', borrowAmounts);


    // --- Construct the Base Configuration Object ---
    const baseConfig = {
        // Network metadata
        NAME: networkMetadata.NAME,
        CHAIN_ID: networkMetadata.CHAIN_ID,
        NATIVE_CURRENCY_SYMBOL: networkMetadata.NATIVE_SYMBOL,
        EXPLORER_URL: networkMetadata.EXPLORER_URL,

        // Core infrastructure
        RPC_URLS: validatedRpcUrls, // Now includes localFork explicit URL
        PRIMARY_RPC_URL: validatedRpcUrls[0],
        PRIVATE_KEY: validatedPrivateKey, // Might be null for localFork if not needed

        // Contract addresses - Use the resolved addresses
        FLASH_SWAP_CONTRACT_ADDRESS: finalFlashSwapAddress,
        AAVE_POOL_ADDRESS: validatedAavePoolAddress,
        TICKLENS_ADDRESS: validatedTickLensAddress,
        SUSHISWAP_ROUTER_ADDRESS: ConfigHelpers.Validators.validateAndNormalizeAddress(networkSpecificSettings.SUSHISWAP_ROUTER_ADDRESS || process.env[`${networkName.toUpperCase()}_SUSHISWAP_ROUTER_ADDRESS`], 'SUSHISWAP_ROUTER_ADDRESS'), // Prefer settings, fallback to env

        // Operational parameters
        CYCLE_INTERVAL_MS: cycleIntervalMs,
        SLIPPAGE_TOLERANCE_BPS: slippageToleranceBps,
        DRY_RUN: isDryRun,
        STOP_ON_FIRST_EXECUTION: stopOnFirst,

        // Enabled DEXs
        UNISWAP_V3_ENABLED: uniswapV3Enabled,
        SUSHISWAP_ENABLED: sushiswapEnabled,
        DODO_ENABLED: dodoEnabled, // Note: DODO execution requires specific builder/contract logic (Phase 2)

        // Gas settings
        MAX_GAS_GWEI: maxGasGwei,
        GAS_ESTIMATE_BUFFER_PERCENT: gasBufferPercent,
        FALLBACK_GAS_LIMIT: fallbackGasLimit,

        // Profitability
        PROFIT_BUFFER_PERCENT: profitBufferPercent,
        TITHE_WALLET_ADDRESS: validatedTitheWalletAddress, // Added Tithe wallet address

        // Tokens and Protocol Defaults
        TOKENS: TOKENS, // Global token definitions
        FACTORY_ADDRESS: PROTOCOL_ADDRESSES.UNISWAP_V3_FACTORY, // UniV3 Factory is a constant across forks/chains? Verify this if going cross-chain.
        QUOTER_ADDRESS: PROTOCOL_ADDRESSES.QUOTER_V2, // Assuming V2 Quoter is used for UniV3 pricing

        // Borrow Amounts (from env or network settings)
        BORROW_AMOUNTS: borrowAmounts,

        // Finder Settings (from network settings)
        FINDER_SETTINGS: networkSpecificSettings.FINDER_SETTINGS,

        // Gas Cost Estimates (from network settings)
        GAS_COST_ESTIMATES: networkSpecificSettings.GAS_COST_ESTIMATES,

        // Chainlink Feeds (from network settings)
        CHAINLINK_FEEDS: networkSpecificSettings.CHAINLINK_FEEDS,

        // Aave Flash Loan Fee (from network settings)
        AAVE_FLASH_LOAN_FEE_BPS: networkSpecificSettings.AAVE_FLASH_LOAN_FEE_BPS,

        // --- Explicitly add MIN_PROFIT_THRESHOLDS from network settings ---
        MIN_PROFIT_THRESHOLDS: networkSpecificSettings.MIN_PROFIT_THRESHOLDS, // <-- Added this line
        // ---

        // Add other network-specific settings loaded from the file here
        // ...
    };
    logger.debug('[loadConfig] Base config object created and merged.');

    // --- Final Address Checks (post-merge) ---
     // Re-check the critical FLASH_SWAP_CONTRACT_ADDRESS after potential assignment
     if (!baseConfig.FLASH_SWAP_CONTRACT_ADDRESS || baseConfig.FLASH_SWAP_CONTRACT_ADDRESS === ethers.ZeroAddress) {
         logger.error(`[Config Check] CRITICAL: FLASH_SWAP_CONTRACT_ADDRESS is still the Zero Address after loading.`);
         throw new Error(`[Config Export] CRITICAL: FLASH_SWAP_CONTRACT_ADDRESS is not configured.`);
     }
      // Check PRIVATE_KEY again - it was validated but we didn't throw immediately
      // Only critical for non-local networks.
     if (!baseConfig.PRIVATE_KEY && networkMetadata.CHAIN_ID !== 31337 && networkMetadata.CHAIN_ID !== 1337) {
          logger.error(`[Config Check] CRITICAL: PRIVATE_KEY is missing or invalid for live network ${networkMetadata.NAME}. Cannot proceed with bot operations.`);
          throw new Error(`[Config Export] CRITICAL: PRIVATE_KEY is missing or invalid.`);
     }
     // Check TITHE_WALLET_ADDRESS - Critical Check
     if (!baseConfig.TITHE_WALLET_ADDRESS || baseConfig.TITHE_WALLET_ADDRESS === ethers.ZeroAddress) {
         logger.error(`[Config Check] CRITICAL: TITHE_WALLET_ADDRESS is missing or invalid.`);
         throw new Error(`[Config Export] CRITICAL: TITHE_WALLET_ADDRESS is not configured.`);
     }

     // Warning for Aave Pool address if it's still not set (Aave might not always be needed)
     if (!baseConfig.AAVE_POOL_ADDRESS || baseConfig.AAVE_POOL_ADDRESS === ethers.ZeroAddress) {
         logger.warn(`[Config Check] WARNING: AAVE_POOL_ADDRESS is not set. Aave flash loans will fail if attempted.`);
     }
      // Warning for TickLens address if not set (needed for UniV3 pricing)
     if (baseConfig.UNISWAP_V3_ENABLED && (!baseConfig.TICKLENS_ADDRESS || baseConfig.TICKLENS_ADDRESS === ethers.ZeroAddress)) {
          logger.warn(`[Config Check] WARNING: UniSwap V3 is enabled but TICKLENS_ADDRESS is not set. UniV3 pricing/scanning may fail.`);
     }
      // Warning for Sushiswap Router if enabled but not set
     if (baseConfig.SUSHISWAP_ENABLED && (!baseConfig.SUSHISWAP_ROUTER_ADDRESS || baseConfig.SUSHISWAP_ROUTER_ADDRESS === ethers.ZeroAddress)) {
         logger.warn(`[Config Check] WARNING: SushiSwap is enabled but SUSHISWAP_ROUTER_ADDRESS is not set. SushiSwap pricing/scanning may fail.`);
     }

    // --- Check MIN_PROFIT_THRESHOLDS structure and content ---
    // This replaces the check in the requiredNetworkKeys loop
    if (!baseConfig.MIN_PROFIT_THRESHOLDS || typeof baseConfig.MIN_PROFIT_THRESHOLDS !== 'object' || Object.keys(baseConfig.MIN_PROFIT_THRESHOLDS).length === 0) {
         logger.error(`[Config Check] CRITICAL: MIN_PROFIT_THRESHOLDS is missing, not an object, or empty.`);
         throw new Error(`[Config Export] CRITICAL: Invalid or missing MIN_PROFIT_THRESHOLDS configuration.`);
    }

    // Optional: Add a check here to ensure every token in TOKENS has a corresponding entry in MIN_PROFIT_THRESHOLDS
    // For now, we rely on the 'DEFAULT' threshold if a specific one is missing.
    // If you want to enforce specific thresholds for all tokens, uncomment and adapt this:
    // const missingThresholds = Object.keys(baseConfig.TOKENS).filter(symbol =>
    //     symbol !== 'NATIVE' && // Assuming NATIVE is handled by baseConfig.MIN_PROFIT_THRESHOLDS.NATIVE
    //     baseConfig.MIN_PROFIT_THRESHOLDS[symbol] === undefined &&
    //     baseConfig.MIN_PROFIT_THRESHOLDS.DEFAULT === undefined // Check if default is also missing
    // );
    // if (missingThresholds.length > 0) {
    //      logger.warn(`[Config Check] WARNING: Missing specific or default profit thresholds for tokens: ${missingThresholds.join(', ')}. Using fallback logic if available.`);
    //      // Decide if this should be a critical error or just a warning
    // }


    // --- Load Pool Configuration ---
    // Calls the poolLoader helper to load pool addresses and metadata from dedicated files
    logger.info('[loadConfig] Calling pool loader helper...');
    try {
        // Pass networkName from metadata to poolLoader
        baseConfig.POOL_CONFIGS = loadPoolConfigs(
            networkMetadata.NAME, // Use networkMetadata.NAME (localFork)
            baseConfig.TOKENS, // Pass global TOKENS object
            baseConfig.UNISWAP_V3_ENABLED, // Pass enabled flags to filter pools
            baseConfig.SUSHISWAP_ENABLED,
            baseConfig.DODO_ENABLED
        );
        logger.info(`[loadConfig] Pool loader loaded ${baseConfig.POOL_CONFIGS.length} pools.`);
    } catch (poolLoadError) {
         logger.error(`[Config] CRITICAL: Failed to load pool configurations: ${poolLoadError.message}`, poolLoadError);
         throw new Error(`[Config] CRITICAL: Pool loading failed.`);
    }

    // Check if pool configs are empty even if DEXs are enabled
     if ((baseConfig.UNISWAP_V3_ENABLED || baseConfig.SUSHISWAP_ENABLED || baseConfig.DODO_ENABLED) && baseConfig.POOL_CONFIGS.length === 0) {
        const logFunc = logger && logger.error ? logger.error : console.error; // Changed to error as this is critical for operation
        logFunc(`[Config Export] CRITICAL: One or more DEXs are enabled in .env, but no pools were loaded for network "${baseConfig.NAME}". Check .env variables and pool definition files in config/pools/${baseConfig.NAME}.`);
        // This is critical, the bot can't do anything without pools
        throw new Error(`[Config Export] CRITICAL: No pools loaded for enabled DEXs.`);
    }


    // Log operating mode (Dry Run or Live)
    if (baseConfig.DRY_RUN) { logger.warn("[Config] --- DRY RUN MODE ENABLED ---"); }
    else { logger.info("[Config] --- LIVE TRADING MODE ---"); }


    // --- Debug Log Final Object ---
    // Log the complete config object in debug mode (handle BigInt and Token objects)
    try {
        // Create a deep copy to avoid modifying original object during stringify
        const stringifyConfig = JSON.parse(JSON.stringify(baseConfig, (key, value) => {
             // Custom replacer function for JSON.stringify
            if (typeof value === 'bigint') { return `BigInt(${value.toString()})`; }
             // Check if value is an object and looks like a Token, avoiding circular references
             if (value && typeof value === 'object' && value.symbol && value.address && value.decimals !== undefined && value.chainId !== undefined) {
                 // Return a simplified representation to avoid huge/circular objects
                 return `Token(${value.symbol} ${value.address.substring(0, 6)}... Dec:${value.decimals})`;
             }
            return value;
        }));
        // Log using stringifyConfig
        logger.debug('[loadConfig] Final baseConfig object before return:', JSON.stringify(stringifyConfig, null, 2));
    } catch (stringifyError) {
        logger.error('[loadConfig] Failed to stringify final config object for debug log:', stringifyError);
    }


    logger.info(`[loadConfig] Exiting loadConfig successfully with ${baseConfig.POOL_CONFIGS.length} pools loaded.`);
    return baseConfig;
} // End loadConfig function


// --- Load and Export the Configuration ---
// Execute the loadConfig function immediately when the module is required
let config;
// Use a basic console.log before logger is fully initialized for very early startup messages
console.log('[Config] Attempting to call loadConfig inside try block...');
try {
    config = loadConfig(); // Load the config

    // Perform final critical checks on the loaded config object
    // These checks will cause the module load to fail if critical items are missing.
    // NOTE: These checks largely duplicate the checks within loadConfig() but act as a final safeguard
    // Remove MIN_PROFIT_THRESHOLDS from this list, as it's checked specifically within loadConfig now
    const essentialKeys = ['NAME','CHAIN_ID','TOKENS','RPC_URLS','FLASH_SWAP_CONTRACT_ADDRESS', 'TITHE_WALLET_ADDRESS','CHAINLINK_FEEDS','GAS_COST_ESTIMATES', 'POOL_CONFIGS', 'FINDER_SETTINGS', 'AAVE_FLASH_LOAN_FEE_BPS'];

    // PRIVATE_KEY is not strictly essential for localFork, so don't include it in the essential list for all networks
    if (config.CHAIN_ID !== 31337 && config.CHAIN_ID !== 1337) { // Only check PRIVATE_KEY for non-local networks
         essentialKeys.push('PRIVATE_KEY');
    }

    // Check the essential keys list (excluding MIN_PROFIT_THRESHOLDS here)
    const missingEssential = essentialKeys.filter(key =>
         // Check if key is missing, null, or undefined. For strings/addresses, also check if they are empty or ZeroAddress.
        !(key in config) || config[key] === null || config[key] === undefined ||
        (typeof config[key] === 'string' && (config[key].trim() === '' || config[key] === ethers.ZeroAddress)) ||
        // For objects/arrays, ensure they are non-empty if expected to be
        ((key === 'TOKENS' || key === 'RPC_URLS' || key === 'MIN_PROFIT_THRESHOLDS' || key === 'CHAINLINK_FEEDS' || key === 'GAS_COST_ESTIMATES' || key === 'POOL_CONFIGS' || key === 'FINDER_SETTINGS') && (typeof config[key] !== 'object' || Object.keys(config[key]).length === 0))
    );


    if (missingEssential.length > 0) {
        // Use the logger if available, otherwise console.error
        const logFunc = logger && logger.error ? logger.error : console.error;
        logFunc(`[Config Export] CRITICAL: Final configuration object is missing essential keys or values are zero/null/empty: ${missingEssential.join(', ')}`);
        // Re-throw to ensure application stops
        throw new Error(`[Config Export] CRITICAL: Missing essential configuration: ${missingEssential.join(', ')}`);
    }

    // Ensure pool configs are loaded correctly and is an array
    if (!Array.isArray(config.POOL_CONFIGS)) {
        const logFunc = logger && logger.error ? logger.error : console.error;
        logFunc(`[Config Export] CRITICAL: POOL_CONFIGS in final config is not an array.`);
        throw new Error(`[Config Export] CRITICAL: POOL_CONFIGS not loaded as array.`);
    }

    // Check if pool configs are empty even if DEXs are enabled
     if ((config.UNISWAP_V3_ENABLED || config.SUSHISWAP_ENABLED || config.DODO_ENABLED) && config.POOL_CONFIGS.length === 0) {
        const logFunc = logger && logger.error ? logger.error : console.error; // Changed to error as this is critical for operation
        logFunc(`[Config Export] CRITICAL: One or more DEXs are enabled in .env, but no pools were loaded for network "${config.NAME}". Check .env variables and pool definition files in config/pools/${config.NAME}.`);
        // This is critical, the bot can't do anything without pools
        throw new Error(`[Config Export] CRITICAL: No pools loaded for enabled DEXs.`);
    }


    // Log success using the logger
    logger.info(`[Config Export] Config loaded: Network=${config.NAME}, Pools=${config.POOL_CONFIGS.length}`);

} catch (error) {
    // If config loading or final checks fail, log critically and re-throw
    const msg = `[Config Export] CRITICAL FAILURE during config load/export: ${error.message}`;
    const logFunc = logger && logger.error ? logger.error : console.error;
    logFunc(msg, error); // Use logger if available, fallback to console
    throw new Error(msg); // Re-throw to stop the application startup
}

// Export the fully loaded and validated config object
module.exports = config;
// Use a simple console.log as this is the very last step of module load
console.log('[Config Top Level] module.exports reached.');
