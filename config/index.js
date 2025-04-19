// config/index.js
// Main configuration loader

require('dotenv').config(); // Load .env file first
const { ethers } = require('ethers');
const { Token } = require('@uniswap/sdk-core');
// --- Load logger first ---
let logger; try { logger = require('../utils/logger'); } catch(e) { console.error("Failed to load logger!", e); logger = console; }

// --- Load Network Metadata Helper (Simplified) ---
function getNetworkMetadata(networkName) { /* ... implementation ... */ }

// --- Load Shared Protocol Addresses ---
const { PROTOCOL_ADDRESSES } = require('../constants/addresses');
// --- Load SDK Token Instances ---
const { TOKENS } = require('../constants/tokens'); // This logs "Exporting tokens..."

// --- Validation Functions ---
function validateAndNormalizeAddress(rawAddress, contextName) { /* ... implementation ... */ }

function validatePrivateKey(rawKey, contextName) {
    console.log(`[DEBUG Validate PK Console] Validating Key for ${contextName}`); // CONSOLE LOG
    const keyString = String(rawKey || '').trim().replace(/^0x/, '');
    if (!keyString) {
        console.error(`[CONSOLE Config Validate] CRITICAL ${contextName}: Private key is empty after cleaning.`); // CONSOLE LOG
        logger.error(`[Config Validate] CRITICAL ${contextName}: Private key is empty after cleaning.`);
        return null;
    }
    const isValidFormat = /^[a-fA-F0-9]{64}$/.test(keyString);
    if (!isValidFormat) {
        console.error(`[CONSOLE Config Validate] CRITICAL ${contextName}: Invalid format. Length: ${keyString.length}`); // CONSOLE LOG
        logger.error(`[Config Validate] CRITICAL ${contextName}: Invalid format. Must be 64 hex chars (no '0x'). Len: ${keyString.length}`);
        return null;
    }
    console.log(`[DEBUG Validate PK Console] Validation successful for ${contextName}.`); // CONSOLE LOG
    return keyString;
}

function validateRpcUrls(rawUrls, contextName) {
    console.log(`[DEBUG Validate RPC Console] Validating RPC for ${contextName}`); // CONSOLE LOG
    const urlsString = String(rawUrls || '').trim();
    if (!urlsString) {
        console.error(`[CONSOLE Config Validate] CRITICAL ${contextName}: RPC URL(s) string is empty.`); // CONSOLE LOG
        logger.error(`[Config Validate] CRITICAL ${contextName}: RPC URL(s) string is empty.`);
        return null;
    }
    const urls = urlsString.split(',')
        .map(url => url.trim())
        .filter(url => /^(https?|wss?):\/\/.+/i.test(url));
    if (urls.length === 0) {
        console.error(`[CONSOLE Config Validate] CRITICAL ${contextName}: No valid RPC URLs found.`); // CONSOLE LOG
        logger.error(`[Config Validate] CRITICAL ${contextName}: No valid RPC URLs found after parsing "${urlsString}".`);
        return null;
    }
    console.log(`[DEBUG Validate RPC Console] Validation successful for ${contextName}. Found ${urls.length} URL(s).`); // CONSOLE LOG
    return urls;
}

function safeParseBigInt(valueStr, contextName, defaultValue = 0n) { /* ... implementation ... */ }
function safeParseInt(valueStr, contextName, defaultValue = 0) { /* ... implementation ... */ }
function parseBoolean(valueStr) { /* ... implementation ... */ }
// --- End Validation Functions ---

// --- loadConfig Function ---
function loadConfig() {
    console.log('[DEBUG loadConfig Console] Starting loadConfig function...'); // CONSOLE LOG
    // 1. Get Network Name
    const networkName = process.env.NETWORK?.toLowerCase();
    if (!networkName) { throw new Error(`[Config] CRITICAL: Missing NETWORK environment variable.`); }
    console.log('[DEBUG loadConfig Console] Network name OK:', networkName); // CONSOLE LOG

    // 2. Validate RPC URLs EARLY
    const rpcUrlsEnvKey = `${networkName.toUpperCase()}_RPC_URLS`;
    const rawRpcUrls = process.env[rpcUrlsEnvKey];
    const validatedRpcUrls = validateRpcUrls(rawRpcUrls, rpcUrlsEnvKey);
    if (!validatedRpcUrls) { throw new Error(`[Config] CRITICAL: Missing or invalid RPC URL(s) in ${rpcUrlsEnvKey}. Bot cannot start.`); }
    console.log('[DEBUG loadConfig Console] RPC URLs OK.'); // CONSOLE LOG

    // 3. Validate Private Key EARLY
    const rawPrivateKey = process.env.PRIVATE_KEY;
    const validatedPrivateKey = validatePrivateKey(rawPrivateKey, 'PRIVATE_KEY');
    if (!validatedPrivateKey) { throw new Error(`[Config] CRITICAL: Missing or invalid PRIVATE_KEY. Bot cannot start.`); }
    console.log('[DEBUG loadConfig Console] Private Key OK.'); // CONSOLE LOG

    // ... (rest of loadConfig remains the same) ...
    const networkMetadata = getNetworkMetadata(networkName); /*...*/
    let networkSpecificConfig; try { networkSpecificConfig = require(`./${networkName}.js`); logger.log(`[Config] Loaded network-specific config for ${networkName}.`); } catch (e) { /*...*/ }
    const flashSwapEnvKey = `${networkName.toUpperCase()}_FLASH_SWAP_ADDRESS`; const validatedFlashSwapAddress = validateAndNormalizeAddress(process.env[flashSwapEnvKey], flashSwapEnvKey); if (!validatedFlashSwapAddress) { logger.warn(`[Config] WARNING: ${flashSwapEnvKey} not set or invalid.`); }
    const cycleIntervalMs = safeParseInt(/*...*/); const gasLimitEstimate = safeParseBigInt(/*...*/); const slippageToleranceBps = safeParseInt(/*...*/); const isDryRun = parseBoolean(/*...*/);
    const combinedConfig = { /* ... combine all parts ... */ };
    let totalPoolsLoaded = 0; const loadedPoolAddresses = new Set();
    if (!combinedConfig.POOL_GROUPS || !Array.isArray(combinedConfig.POOL_GROUPS)) { /*...*/ } else { combinedConfig.POOL_GROUPS.forEach((group, groupIndex) => { /* ... GROUP PROCESSING ... */ }); combinedConfig.POOL_GROUPS = combinedConfig.POOL_GROUPS.filter(/*...*/); }
    console.log(`[Config] Total unique pools loaded from .env: ${loadedPoolAddresses.size}`); if (loadedPoolAddresses.size === 0) { console.warn(/*...*/); }
    combinedConfig.getAllPoolConfigs = () => { /*...*/ };
    if (combinedConfig.DRY_RUN) { console.warn(/*...*/); } else { console.log(/*...*/); }
    console.log('[DEBUG loadConfig Console] Exiting loadConfig function successfully.'); // CONSOLE LOG
    return combinedConfig;
} // End loadConfig function

// --- Load and Export Config ---
let config;
// --- Add console log before try block ---
console.log('[Config] Attempting to call loadConfig inside try block...');
// --- ---
try {
    config = loadConfig();
    console.log(`[Config] Configuration loaded successfully for network: ${config.NAME} (Chain ID: ${config.CHAIN_ID})`);
} catch (error) {
    // Log using console as logger might fail
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    console.error("!!! FATAL CONFIGURATION ERROR !!!");
    console.error(`!!! ${error.message}`); // Log the specific error message
    console.error("!!! Bot cannot start. Please check your .env file and config files.");
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    process.exit(1);
}
module.exports = config;
