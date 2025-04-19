// config/index.js
// Main configuration loader

require('dotenv').config(); // Load .env file first
const { ethers } = require('ethers');
const { Token } = require('@uniswap/sdk-core');
const logger = require('../utils/logger'); // Assuming logger exists

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
function validatePrivateKey(rawKey, contextName) { /* ... implementation ... */ }

/**
 * Validates RPC URL(s) string.
 * @param {string} rawUrls Raw RPC URL string (potentially comma-separated).
 * @param {string} contextName Name for logging.
 * @returns {string[]|null} Array of valid, trimmed URLs or null if none are valid.
 */
function validateRpcUrls(rawUrls, contextName) {
    // --- ADDED DEBUG LOGGING ---
    logger.debug(`[DEBUG Validate RPC] Received rawUrls for ${contextName}: "${rawUrls}" (Type: ${typeof rawUrls})`);
    // --- ---
    const urlsString = String(rawUrls || '').trim();
    if (!urlsString) {
        logger.error(`[Config Validate] CRITICAL ${contextName}: RPC URL(s) string is empty.`);
        return null;
    }
    const urls = urlsString.split(',')
        .map(url => {
             const trimmedUrl = url.trim();
             logger.debug(`[DEBUG Validate RPC] Processing URL part: "${trimmedUrl}"`); // DEBUG
             return trimmedUrl;
        })
        .filter(url => {
            if (!url) {
                logger.debug(`[DEBUG Validate RPC] Filtering out empty URL part.`); // DEBUG
                return false;
            }
            const isValidFormat = /^(https?|wss?):\/\/.+/i.test(url);
             logger.debug(`[DEBUG Validate RPC] Testing URL "${url}", Format OK: ${isValidFormat}`); // DEBUG
            if (!isValidFormat) {
                 logger.warn(`[Config Validate] ${contextName}: Invalid URL format skipped: "${url}"`);
                 return false;
            }
            return true;
        });

    logger.debug(`[DEBUG Validate RPC] Filtered URLs: [${urls.join(', ')}] (Count: ${urls.length})`); // DEBUG
    if (urls.length === 0) {
        logger.error(`[Config Validate] CRITICAL ${contextName}: No valid RPC URLs found after parsing "${urlsString}".`);
        return null;
    }
    logger.debug(`[DEBUG Validate RPC] Validation successful for ${contextName}.`);
    return urls;
}

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
    logger.debug(`[DEBUG loadConfig] Raw RPC URLs from process.env.${rpcUrlsEnvKey}: "${rawRpcUrls}"`); // DEBUG
    const validatedRpcUrls = validateRpcUrls(rawRpcUrls, rpcUrlsEnvKey);
    // Throw error immediately if validation returns null
    if (!validatedRpcUrls) { throw new Error(`[Config] CRITICAL: Missing or invalid RPC URL(s) in ${rpcUrlsEnvKey}. Bot cannot start.`); }

    // 3. Validate Private Key EARLY
    const rawPrivateKey = process.env.PRIVATE_KEY;
    const validatedPrivateKey = validatePrivateKey(rawPrivateKey, 'PRIVATE_KEY');
    if (!validatedPrivateKey) { throw new Error(`[Config] CRITICAL: Missing or invalid PRIVATE_KEY. Bot cannot start.`); }

    // ... (rest of loadConfig remains the same as the previous version) ...
    // 4. Load Network Metadata
    const networkMetadata = getNetworkMetadata(networkName);
    if (!networkMetadata) { throw new Error(`[Config] CRITICAL: No network metadata found for network: ${networkName}`); }

    // 5. Load Network Specific Config
    let networkSpecificConfig;
    try { networkSpecificConfig = require(`./${networkName}.js`); logger.log(`[Config] Loaded network-specific config for ${networkName}.`); }
    catch (e) { throw new Error(`[Config] CRITICAL: Failed to load config/${networkName}.js: ${e.message}`); }

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
    const combinedConfig = { /* ... combine all config parts ... */ };

    // 9. Process POOL_GROUPS
    let totalPoolsLoaded = 0; const loadedPoolAddresses = new Set();
    if (!combinedConfig.POOL_GROUPS || !Array.isArray(combinedConfig.POOL_GROUPS)) { /*...*/ }
    else { combinedConfig.POOL_GROUPS.forEach((group, groupIndex) => { /* ... FULL GROUP PROCESSING LOGIC ... */ }); combinedConfig.POOL_GROUPS = combinedConfig.POOL_GROUPS.filter(group => group !== null); }
    console.log(`[Config] Total unique pools loaded from .env: ${loadedPoolAddresses.size}`);
    if (loadedPoolAddresses.size === 0) { console.warn("[Config] WARNING: No pool addresses loaded."); }

    // 10. Add Helper Function & Log Dry Run
    combinedConfig.getAllPoolConfigs = () => { /* ... implementation ... */ };
    if (combinedConfig.DRY_RUN) { console.warn("[Config] --- DRY RUN MODE ENABLED ---"); } else { console.log("[Config] --- LIVE TRADING MODE ---"); }

    return combinedConfig;
} // End loadConfig function

// --- Load and Export Config --- (Same as before)
let config;
try { config = loadConfig(); console.log(`[Config] Configuration loaded successfully for network: ${config.NAME} (Chain ID: ${config.CHAIN_ID})`); }
catch (error) { /* ... fatal error logging ... */ process.exit(1); }
module.exports = config;
