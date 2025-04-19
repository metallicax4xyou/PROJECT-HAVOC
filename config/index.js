// config/index.js

// --- Log immediately ---
console.log('[Config Top Level] File execution started.');

// --- Basic Requires First ---
require('dotenv').config();
console.log('[Config Top Level] dotenv loaded.');
const { ethers } = require('ethers');
console.log('[Config Top Level] ethers loaded.');
const { Token } = require('@uniswap/sdk-core');
console.log('[Config Top Level] sdk-core loaded.');

// --- Try loading logger ---
let logger;
try {
    logger = require('../utils/logger');
    console.log('[Config Top Level] Logger loaded successfully.');
} catch(e) {
    console.error("[Config Top Level] FAILED TO LOAD LOGGER:", e);
    logger = console; // Fallback to console
}

// --- Try loading constants ---
let PROTOCOL_ADDRESSES, TOKENS;
try {
    PROTOCOL_ADDRESSES = require('../constants/addresses').PROTOCOL_ADDRESSES;
    console.log('[Config Top Level] constants/addresses loaded.');
    TOKENS = require('../constants/tokens').TOKENS; // constants/tokens.js logs internally
    console.log('[Config Top Level] constants/tokens loaded.');
} catch(e) {
    console.error("[Config Top Level] FAILED TO LOAD CONSTANTS:", e);
    // If constants fail, we probably can't continue
    process.exit(1);
}

// --- Validation Functions (Keep Definitions Simple for now) ---
function validateAndNormalizeAddress(rawAddress, contextName) { try { return ethers.getAddress(String(rawAddress || '').trim()); } catch { return null; } }
function validatePrivateKey(rawKey, contextName) { const k = String(rawKey||'').trim().replace(/^0x/,''); return /^[a-fA-F0-9]{64}$/.test(k) ? k : null; }
function validateRpcUrls(rawUrls, contextName) { const s = String(rawUrls||'').trim(); if(!s) return null; const urls = s.split(',').map(u=>u.trim()).filter(u=>/^(https?|wss?):\/\/.+/i.test(u)); return urls.length > 0 ? urls : null; }
function safeParseBigInt(valueStr, contextName, defaultValue = 0n) { try { const s=String(valueStr||'').trim(); return s ? BigInt(s) : defaultValue; } catch { return defaultValue; } }
function safeParseInt(valueStr, contextName, defaultValue = 0) { const n = parseInt(String(valueStr||'').trim(), 10); return isNaN(n) ? defaultValue : n; }
function parseBoolean(valueStr) { return String(valueStr || '').trim().toLowerCase() !== 'false'; }
console.log('[Config Top Level] Validation function definitions OK.');

// --- Network Metadata Helper ---
function getNetworkMetadata(networkName) { if (networkName === 'arbitrum') return { CHAIN_ID: 42161, NAME: 'arbitrum', NATIVE_SYMBOL: 'ETH', NATIVE_DECIMALS: 18 }; return null; }
console.log('[Config Top Level] Network metadata helper definition OK.');


// --- loadConfig Function Definition ---
function loadConfig() {
    // --- Log entry immediately ---
    console.log('[loadConfig INNER] Entered loadConfig function.');
    logger.debug('[loadConfig INNER] Entered loadConfig function (logger).'); // Use logger too

    const networkName = process.env.NETWORK?.toLowerCase();
    console.log(`[loadConfig INNER] Network Name: ${networkName}`);
    if (!networkName) { console.error('!!! NO NETWORK NAME'); throw new Error(`[Config] CRITICAL: Missing NETWORK.`); }

    // --- Try requiring network specific config early ---
    let networkSpecificConfig;
    try {
        console.log(`[loadConfig INNER] Attempting to require('./${networkName}.js')...`);
        networkSpecificConfig = require(`./${networkName}.js`);
        console.log(`[loadConfig INNER] Successfully required ./${networkName}.js`);
        logger.log(`[Config] Loaded network-specific config for ${networkName}.`);
    } catch (e) {
        console.error(`[loadConfig INNER] FAILED to require ./${networkName}.js: ${e.message}`);
        throw new Error(`[Config] CRITICAL: Failed to load config/${networkName}.js: ${e.message}`);
    }
    // --- ---

    const rpcUrlsEnvKey = `${networkName.toUpperCase()}_RPC_URLS`;
    const validatedRpcUrls = validateRpcUrls(process.env[rpcUrlsEnvKey], rpcUrlsEnvKey);
    if (!validatedRpcUrls) { throw new Error(`[Config] CRITICAL: Invalid RPC URL(s) in ${rpcUrlsEnvKey}.`); }
    console.log(`[loadConfig INNER] RPC URLs validated.`);

    const validatedPrivateKey = validatePrivateKey(process.env.PRIVATE_KEY, 'PRIVATE_KEY');
    if (!validatedPrivateKey) { throw new Error(`[Config] CRITICAL: Invalid PRIVATE_KEY.`); }
    console.log(`[loadConfig INNER] Private Key validated.`);

    const networkMetadata = getNetworkMetadata(networkName);
    if (!networkMetadata) { throw new Error(`[Config] CRITICAL: No metadata for network: ${networkName}`); }
    console.log(`[loadConfig INNER] Network metadata loaded.`);

    // ... (Rest of the loadConfig function - FlashSwap Address, Globals, Combine, Pool Group Processing etc. - Keep as before)
    const flashSwapEnvKey = `${networkName.toUpperCase()}_FLASH_SWAP_ADDRESS`;
    const validatedFlashSwapAddress = validateAndNormalizeAddress(process.env[flashSwapEnvKey], flashSwapEnvKey);
    if (!validatedFlashSwapAddress) { logger.warn(`[Config] WARNING: ${flashSwapEnvKey} not set or invalid.`); }
    const cycleIntervalMs = safeParseInt(/*...*/); const gasLimitEstimate = safeParseBigInt(/*...*/); const slippageToleranceBps = safeParseInt(/*...*/); const isDryRun = parseBoolean(/*...*/);
    const combinedConfig = { /* ... */ }; // Combine all parts
    let totalPoolsLoaded = 0; const loadedPoolAddresses = new Set();
    if (!combinedConfig.POOL_GROUPS || !Array.isArray(combinedConfig.POOL_GROUPS)) { /*...*/ }
    else { combinedConfig.POOL_GROUPS.forEach((group, groupIndex) => { /* ... FULL GROUP PROCESSING LOGIC ... */ }); combinedConfig.POOL_GROUPS = combinedConfig.POOL_GROUPS.filter(/*...*/); }
    console.log(`[Config] Total unique pools loaded: ${loadedPoolAddresses.size}`); if (loadedPoolAddresses.size === 0) { console.warn(/*...*/); }
    combinedConfig.getAllPoolConfigs = () => { /*...*/ }; if (combinedConfig.DRY_RUN) { console.warn(/*...*/); } else { console.log(/*...*/); }

    console.log('[loadConfig INNER] Exiting loadConfig successfully.');
    return combinedConfig;
}
console.log('[Config Top Level] loadConfig function definition OK.');

// --- Load and Export Config ---
let config;
console.log('[Config] Attempting to call loadConfig inside try block...');
try {
    config = loadConfig();
    // Use console log here as well, just in case logger failed but config loaded
    console.log(`[CONSOLE Config] Configuration loaded successfully for network: ${config?.NAME} (Chain ID: ${config?.CHAIN_ID})`);
    logger.info(`[Config] Configuration loaded successfully for network: ${config?.NAME} (Chain ID: ${config?.CHAIN_ID})`);
} catch (error) {
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    console.error("!!! FATAL CONFIGURATION ERROR !!!");
    console.error(`!!! ${error.message}`);
    console.error("!!! Bot cannot start.");
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    process.exit(1);
}
module.exports = config;
console.log('[Config Top Level] module.exports reached.'); // Final log
