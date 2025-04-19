// config/index.js
// Main configuration loader

require('dotenv').config(); // Load .env file first
const { ethers } = require('ethers');
const { Token } = require('@uniswap/sdk-core');
// --- Load logger earlier for validation functions ---
const logger = require('../utils/logger');

// --- Load Network Metadata Helper (Simplified) ---
function getNetworkMetadata(networkName) {
    const lowerName = networkName?.toLowerCase();
    if (lowerName === 'arbitrum') { return { CHAIN_ID: 42161, NAME: 'arbitrum', NATIVE_SYMBOL: 'ETH', NATIVE_DECIMALS: 18 }; }
    return null;
}

// --- Load Shared Protocol Addresses ---
const { PROTOCOL_ADDRESSES } = require('../constants/addresses');
// --- Load SDK Token Instances ---
const { TOKENS } = require('../constants/tokens');

// --- Validation Functions ---
function validateAndNormalizeAddress(rawAddress, contextName) { /* ... implementation ... */ }

/**
 * Validates a private key string.
 * @param {string} rawKey Raw private key string.
 * @param {string} contextName Name for logging.
 * @returns {string|null} Validated private key (without 0x) or null if invalid.
 */
function validatePrivateKey(rawKey, contextName) {
    // --- ADDED DEBUG LOGGING ---
    logger.debug(`[DEBUG Validate PK] Received rawKey for ${contextName}: "${rawKey}" (Type: ${typeof rawKey})`);
    const keyString = String(rawKey || '').trim().replace(/^0x/, '');
    logger.debug(`[DEBUG Validate PK] Trimmed/Cleaned keyString: "${keyString}" (Length: ${keyString.length})`);
    // --- ---

    if (!keyString) {
        logger.error(`[Config Validate] CRITICAL ${contextName}: Private key is empty after cleaning.`);
        return null;
    }

    const isValidFormat = /^[a-fA-F0-9]{64}$/.test(keyString);
    // --- ADDED DEBUG LOGGING ---
    logger.debug(`[DEBUG Validate PK] Regex test result (/^[a-fA-F0-9]{64}$/): ${isValidFormat}`);
    // --- ---

    if (!isValidFormat) {
        logger.error(`[Config Validate] CRITICAL ${contextName}: Invalid format. Must be 64 hexadecimal characters (without '0x' prefix). Actual length: ${keyString.length}`);
        return null;
    }
    logger.debug(`[DEBUG Validate PK] Validation successful for ${contextName}.`);
    return keyString; // Return the clean key (no 0x)
}

function validateRpcUrls(rawUrls, contextName) { /* ... implementation ... */ }
function safeParseBigInt(valueStr, contextName, defaultValue = 0n) { /* ... implementation ... */ }
function safeParseInt(valueStr, contextName, defaultValue = 0) { /* ... implementation ... */ }
function parseBoolean(valueStr) { /* ... implementation ... */ }
// --- End Validation Functions ---


// --- loadConfig Function ---
function loadConfig() {
    // 1. Get Network Name
    const networkName = process.env.NETWORK?.toLowerCase();
    if (!networkName) { throw new Error(`[Config] CRITICAL: Missing NETWORK environment variable.`); }

    // 2. Validate RPC URLs EARLY
    const rpcUrlsEnvKey = `${networkName.toUpperCase()}_RPC_URLS`;
    const rawRpcUrls = process.env[rpcUrlsEnvKey];
    const validatedRpcUrls = validateRpcUrls(rawRpcUrls, rpcUrlsEnvKey);
    if (!validatedRpcUrls) { throw new Error(`[Config] CRITICAL: Missing or invalid RPC URL(s) in ${rpcUrlsEnvKey}. Bot cannot start.`); }

    // 3. Validate Private Key EARLY (Now with debug logs inside the function)
    const rawPrivateKey = process.env.PRIVATE_KEY;
    const validatedPrivateKey = validatePrivateKey(rawPrivateKey, 'PRIVATE_KEY');
    if (!validatedPrivateKey) { throw new Error(`[Config] CRITICAL: Missing or invalid PRIVATE_KEY. Bot cannot start.`); } // Error thrown if validation returns null

    // ... (rest of loadConfig remains the same as the previous version) ...
    // 4. Load Network Metadata
    const networkMetadata = getNetworkMetadata(networkName);
    if (!networkMetadata) { throw new Error(`[Config] CRITICAL: No network metadata found for network: ${networkName}`); }

    // 5. Load Network Specific Config
    let networkSpecificConfig;
    try {
        networkSpecificConfig = require(`./${networkName}.js`);
        logger.log(`[Config] Loaded network-specific config for ${networkName}.`);
    } catch (e) { throw new Error(`[Config] CRITICAL: Failed to load config/${networkName}.js: ${e.message}`); }

    // 6. Validate Optional Flash Swap Address
    const flashSwapEnvKey = `${networkName.toUpperCase()}_FLASH_SWAP_ADDRESS`;
    const rawFlashSwapAddress = process.env[flashSwapEnvKey];
    const validatedFlashSwapAddress = validateAndNormalizeAddress(rawFlashSwapAddress, flashSwapEnvKey);
    if (!validatedFlashSwapAddress) { logger.warn(`[Config] WARNING: ${flashSwapEnvKey} not set or invalid. Defaulting to ZeroAddress.`); }

    // 7. Load Global Settings
    const cycleIntervalMs = safeParseInt(process.env.CYCLE_INTERVAL_MS, 'CYCLE_INTERVAL_MS', 5000);
    const gasLimitEstimate = safeParseBigInt(process.env.GAS_LIMIT_ESTIMATE, 'GAS_LIMIT_ESTIMATE', 1500000n);
    const slippageToleranceBps = safeParseInt(process.env.SLIPPAGE_TOLERANCE_BPS, 'SLIPPAGE_TOLERANCE_BPS', 10);
    const isDryRun = parseBoolean(process.env.DRY_RUN);

    // 8. Combine Config Object
    const combinedConfig = {
        ...networkMetadata,
        ...networkSpecificConfig,
        TOKENS: TOKENS,
        RPC_URLS: validatedRpcUrls,
        PRIMARY_RPC_URL: validatedRpcUrls[0],
        PRIVATE_KEY: validatedPrivateKey, // Store the validated key (no 0x)
        FLASH_SWAP_CONTRACT_ADDRESS: validatedFlashSwapAddress || ethers.ZeroAddress,
        CYCLE_INTERVAL_MS: cycleIntervalMs,
        GAS_LIMIT_ESTIMATE: gasLimitEstimate,
        SLIPPAGE_TOLERANCE_BPS: slippageToleranceBps,
        DRY_RUN: isDryRun,
        FACTORY_ADDRESS: PROTOCOL_ADDRESSES.UNISWAP_V3_FACTORY,
        QUOTER_ADDRESS: PROTOCOL_ADDRESSES.QUOTER_V2,
        TICK_LENS_ADDRESS: PROTOCOL_ADDRESSES.TICK_LENS,
    };

    // 9. Process POOL_GROUPS (enrich with data, validate pools from env)
    // ...(Same POOL_GROUP processing logic as before, including debug logs)...
    let totalPoolsLoaded = 0;
    const loadedPoolAddresses = new Set();
    if (!combinedConfig.POOL_GROUPS || !Array.isArray(combinedConfig.POOL_GROUPS)) { /*...*/ }
    else {
         combinedConfig.POOL_GROUPS.forEach((group, groupIndex) => { /* ... FULL GROUP PROCESSING LOGIC ... */ });
         combinedConfig.POOL_GROUPS = combinedConfig.POOL_GROUPS.filter(group => group !== null);
    }
    console.log(`[Config] Total unique pools loaded from .env: ${loadedPoolAddresses.size}`);
    if (loadedPoolAddresses.size === 0) { console.warn("[Config] WARNING: No pool addresses loaded."); }


    // 10. Add Helper Function & Log Dry Run
    combinedConfig.getAllPoolConfigs = () => {
         if (!combinedConfig.POOL_GROUPS) return [];
         return combinedConfig.POOL_GROUPS.flatMap(group => group.pools || []);
    };
    if (combinedConfig.DRY_RUN) { console.warn("[Config] --- DRY RUN MODE ENABLED ---"); } else { console.log("[Config] --- LIVE TRADING MODE ---"); }

    return combinedConfig;
} // End loadConfig function

// --- Load and Export Config --- (Same as before)
let config;
try {
    config = loadConfig();
    console.log(`[Config] Configuration loaded successfully for network: ${config.NAME} (Chain ID: ${config.CHAIN_ID})`);
} catch (error) {
    const log = typeof logger !== 'undefined' ? logger : console;
    log.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    log.error("!!! FATAL CONFIGURATION ERROR !!!");
    log.error(`!!! ${error.message}`); // Log the specific error message from the throw statement
    log.error("!!! Bot cannot start. Please check your .env file and config files.");
    log.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    process.exit(1);
}
module.exports = config; // Export the loaded config object directly
