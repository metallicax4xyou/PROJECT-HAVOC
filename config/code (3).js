// config/index.js
// --- VERSION 1.8 --- Refactored final essential keys validation.

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
        networkSpecificSettings = require(`./${networkMetadata.NAME}.js`);
        logger.log(`[Config] Loaded network settings from ./${networkMetadata.NAME}.js`);
    } catch (e) {
        throw new Error(`[Config] CRITICAL: Failed to load config/${networkMetadata.NAME}.js. Make sure it exists and is valid: ${e.message}`);
    }


    // --- Get Flash Swap Address ---
    // Prioritize address from network-specific settings file, fallback to environment variable
    let finalFlashSwapAddress = networkSpecificSettings.FLASH_SWAP_CONTRACT_ADDRESS;
    const flashSwapEnvKey = `${networkName.toUpperCase()}_FLASH_SWAP_ADDRESS`; // Use original networkName for env lookup
    const rawFlashSwapAddressFromEnv = process.env[flashSwapEnvKey];

    if (!finalFlashSwapAddress && rawFlashSwapAddressFromEnv) {
        // If not found in settings file, check environment variable
         logger.debug(`[Config] Flash Swap address not found in ${networkMetadata.NAME}.js, checking environment variable ${flashSwapEnvKey}.`);
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
         logger.debug(`[Config] Using Flash Swap address from ${networkMetadata.NAME}.js: ${finalFlashSwapAddress}`);
         // Attempt to normalize it just in case it's not checksummed in the file
         try {
             finalFlashSwapAddress = ethers.getAddress(finalFlashSwapAddress);
             logger.debug(`[Config] Normalized Flash Swap address from settings: ${finalFlashSwapAddress}`);
         } catch (e) {
             logger.warn(`[Config] Normalization FAILED for Flash Swap address from settings "${finalFlashSwapAddress}", using raw. Error: ${e.message}`);
         }
    } else {
         // If not found in either place
         logger.error(`[Config] CRITICAL: FLASH_SWAP_CONTRACT_ADDRESS is missing from both ${networkMetadata.NAME}.js AND environment variable ${flashSwapEnvKey}. Cannot initialize FlashSwapManager.`);
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

        // Add other network-specific settings loaded from the file here
        // ...
    };
    logger.debug('[loadConfig] Base config object created and merged.');

    // --- Final Validation Checks (post-merge) ---
    const missingEssential = [];
    const emptyObjectKeys = ['TOKENS', 'RPC_URLS', 'MIN_PROFIT_THRESHOLDS', 'CHAINLINK_FEEDS', 'GAS_COST_ESTIMATES', 'POOL_CONFIGS', 'FINDER_SETTINGS']; // Keys expected to be non-empty objects/arrays
    const addressKeys = ['FLASH_SWAP_CONTRACT_ADDRESS', 'TITHE_WALLET_ADDRESS', 'AAVE_POOL_ADDRESS', 'TICKLENS_ADDRESS', 'SUSHISWAP_ROUTER_ADDRESS', 'FACTORY_ADDRESS', 'QUOTER_ADDRESS']; // Keys expected to be addresses

    // Check for existence and non-null/undefined for critical keys
    const criticalKeys = ['NAME', 'CHAIN_ID', 'FLASH_SWAP_CONTRACT_ADDRESS', 'TITHE_WALLET_ADDRESS', 'POOL_CONFIGS'];
     // Add PRIVATE_KEY as critical only for non-local networks
    if (baseConfig.CHAIN_ID !== 31337 && baseConfig.CHAIN_ID !== 1337) {
         criticalKeys.push('PRIVATE_KEY');
    }

    for (const key of criticalKeys) {
        if (!(key in baseConfig) || baseConfig[key] === null || baseConfig[key] === undefined) {
            missingEssential.push(key);
        }
    }

    // Check for non-empty objects/arrays where required
    for (const key of emptyObjectKeys) {
        // Only check if it wasn't already marked as missing critical
        if (criticalKeys.includes(key) && missingEssential.includes(key)) continue;

        if (!(key in baseConfig) || typeof baseConfig[key] !== 'object' || baseConfig[key] === null || Object.keys(baseConfig[key]).length === 0) {
             // Special case: POOL_CONFIGS can be empty if no DEXs are enabled, but not if DEXs ARE enabled.
             if (key === 'POOL_CONFIGS') {
                 if (baseConfig.UNISWAP_V3_ENABLED || baseConfig.SUSHISWAP_ENABLED || baseConfig.DODO_ENABLED) {
                      missingEssential.push(key); // Only missing if DEXs are enabled
                 }
             } else {
                 missingEssential.push(key); // Missing for other empty object keys
             }
        }
    }

    // Check for valid addresses where required (non-empty string, not ZeroAddress)
    for (const key of addressKeys) {
         // Only check if it wasn't already marked as missing critical
         if (criticalKeys.includes(key) && missingEssential.includes(key)) continue;

         // Aave Pool, TickLens, Sushi Router, Factory, Quoter are not strictly critical if the relevant DEX/Protocol is disabled
         if (key === 'AAVE_POOL_ADDRESS' && !baseConfig.AAVE_FLASH_LOAN_FEE_BPS) continue; // If Aave fee is 0/not set, maybe Aave isn't used
         if (key === 'TICKLENS_ADDRESS' && !baseConfig.UNISWAP_V3_ENABLED) continue; // Only needed if UniV3 is enabled
         if (key === 'SUSHISWAP_ROUTER_ADDRESS' && !baseConfig.SUSHISWAP_ENABLED) continue; // Only needed if Sushi is enabled
         // Factory/Quoter are needed if UniV3 enabled
         if ((key === 'FACTORY_ADDRESS' || key === 'QUOTER_ADDRESS') && !baseConfig.UNISWAP_V3_ENABLED) continue;


         if (!(key in baseConfig) || typeof baseConfig[key] !== 'string' || baseConfig[key].trim() === '' || baseConfig[key] === ethers.ZeroAddress) {
             missingEssential.push(key);
         }
    }


    if (missingEssential.length > 0) {
        // Use the logger if available, otherwise console.error
        const logFunc = logger && logger.error ? logger.error : console.error;
        logFunc(`[Config Export] CRITICAL: Final configuration object is missing essential keys or values are zero/null/empty: ${missingEssential.join(', ')}`);
        // Re-throw to ensure application stops
        throw new Error(`[Config Export] CRITICAL: Missing essential configuration: ${missingEssential.join(', ')}`);
    }

    // Warning if DEXs are enabled but no pools were loaded - this is now handled by the emptyObjectKeys check for POOL_CONFIGS

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