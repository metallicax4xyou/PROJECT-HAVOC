// config/index.js
// Main configuration loader - SIMPLIFIED FOR DEBUGGING

require('dotenv').config();
const { ethers } = require('ethers');
const { Token } = require('@uniswap/sdk-core');
let logger; try { logger = require('../utils/logger'); } catch(e) { console.error("No logger"); logger = console; }

// --- Loaders ---
function getNetworkMetadata(networkName) { if (networkName === 'arbitrum') return { CHAIN_ID: 42161, NAME: 'arbitrum', NATIVE_SYMBOL: 'ETH', NATIVE_DECIMALS: 18 }; return null; }
const { PROTOCOL_ADDRESSES } = require('../constants/addresses');
const { TOKENS } = require('../constants/tokens');

// --- Validation Functions ---
function validateAndNormalizeAddress(rawAddress, contextName) { try { const addr = String(rawAddress || '').trim(); return addr ? ethers.getAddress(addr) : null; } catch { return null; } }
function validatePrivateKey(rawKey, contextName) { const k = String(rawKey||'').trim().replace(/^0x/,''); return /^[a-fA-F0-9]{64}$/.test(k) ? k : null; }
function validateRpcUrls(rawUrls, contextName) { const s = String(rawUrls||'').trim(); if(!s) return null; const urls = s.split(',').map(u=>u.trim()).filter(u=>/^(https?|wss?):\/\/.+/i.test(u)); return urls.length > 0 ? urls : null; }
function safeParseBigInt(valueStr, contextName, defaultValue = 0n) { try { const s=String(valueStr||'').trim(); return s ? BigInt(s) : defaultValue; } catch { return defaultValue; } }
function safeParseInt(valueStr, contextName, defaultValue = 0) { const n = parseInt(String(valueStr||'').trim(), 10); return isNaN(n) ? defaultValue : n; }
function parseBoolean(valueStr) { return String(valueStr || '').trim().toLowerCase() !== 'false'; }


// --- loadConfig Function (SIMPLIFIED) ---
function loadConfig() {
    console.log('[loadConfig INNER - Simple] Entered loadConfig function.');

    const networkName = process.env.NETWORK?.toLowerCase();
    if (!networkName) { throw new Error(`[Config] CRITICAL: Missing NETWORK.`); }
    console.log(`[loadConfig INNER - Simple] Network: ${networkName}`);

    // --- Core Validations ---
    const rpcUrlsEnvKey = `${networkName.toUpperCase()}_RPC_URLS`;
    const validatedRpcUrls = validateRpcUrls(process.env[rpcUrlsEnvKey], rpcUrlsEnvKey);
    if (!validatedRpcUrls) { throw new Error(`[Config] CRITICAL: Invalid RPC URL(s) in ${rpcUrlsEnvKey}.`); }
    console.log(`[loadConfig INNER - Simple] RPC URLs OK: ${validatedRpcUrls.length}`);

    const validatedPrivateKey = validatePrivateKey(process.env.PRIVATE_KEY, 'PRIVATE_KEY');
    if (!validatedPrivateKey) { throw new Error(`[Config] CRITICAL: Invalid PRIVATE_KEY.`); }
    console.log(`[loadConfig INNER - Simple] Private Key OK.`);

    const networkMetadata = getNetworkMetadata(networkName);
    if (!networkMetadata) { throw new Error(`[Config] CRITICAL: No metadata for network: ${networkName}`); }
    console.log(`[loadConfig INNER - Simple] Network metadata OK: ${networkMetadata.NAME}`);

    // --- Load Network Specific Config ---
    let networkSpecificConfig = {}; // Default to empty object
    try {
        networkSpecificConfig = require(`./${networkName}.js`);
        console.log(`[loadConfig INNER - Simple] Loaded ./${networkName}.js OK.`);
    } catch (e) { throw new Error(`[Config] CRITICAL: Failed to load config/${networkName}.js: ${e.message}`); }

    // --- Validate Optional Flash Swap Address ---
    const flashSwapEnvKey = `${networkName.toUpperCase()}_FLASH_SWAP_ADDRESS`;
    const validatedFlashSwapAddress = validateAndNormalizeAddress(process.env[flashSwapEnvKey], flashSwapEnvKey);
    if (!validatedFlashSwapAddress) { logger.warn(`[Config] WARNING: ${flashSwapEnvKey} not set or invalid.`); }
    console.log(`[loadConfig INNER - Simple] Flash Swap Addr: ${validatedFlashSwapAddress || 'Not Set'}`);

    // --- Load Global Settings ---
    const cycleIntervalMs = safeParseInt(process.env.CYCLE_INTERVAL_MS, 'CYCLE_INTERVAL_MS', 5000);
    const gasLimitEstimate = safeParseBigInt(process.env.GAS_LIMIT_ESTIMATE, 'GAS_LIMIT_ESTIMATE', 1500000n);
    const slippageToleranceBps = safeParseInt(process.env.SLIPPAGE_TOLERANCE_BPS, 'SLIPPAGE_TOLERANCE_BPS', 10);
    const isDryRun = parseBoolean(process.env.DRY_RUN);
    console.log(`[loadConfig INNER - Simple] Global settings loaded.`);

    // --- Combine Config Object (NO POOL GROUP PROCESSING YET) ---
    const combinedConfig = {
        ...networkMetadata,           // CHAIN_ID, NAME, etc.
        ...networkSpecificConfig,     // Should include POOL_GROUPS, CHAINLINK_FEEDS
        TOKENS: TOKENS,               // SDK Token instances
        RPC_URLS: validatedRpcUrls,
        PRIMARY_RPC_URL: validatedRpcUrls[0],
        PRIVATE_KEY: validatedPrivateKey,
        FLASH_SWAP_CONTRACT_ADDRESS: validatedFlashSwapAddress || ethers.ZeroAddress,
        CYCLE_INTERVAL_MS: cycleIntervalMs,
        GAS_LIMIT_ESTIMATE: gasLimitEstimate,
        SLIPPAGE_TOLERANCE_BPS: slippageToleranceBps,
        DRY_RUN: isDryRun,
        FACTORY_ADDRESS: PROTOCOL_ADDRESSES.UNISWAP_V3_FACTORY,
        QUOTER_ADDRESS: PROTOCOL_ADDRESSES.QUOTER_V2,
        TICK_LENS_ADDRESS: PROTOCOL_ADDRESSES.TICK_LENS,
    };
    console.log(`[loadConfig INNER - Simple] Combined config object created. Keys: ${Object.keys(combinedConfig).join(', ')}`);

    // --- TEMPORARILY SKIPPING POOL GROUP PROCESSING ---
    console.log('[loadConfig INNER - Simple] Skipping POOL_GROUP processing for debugging.');
    // We need to ensure POOL_GROUPS exists, even if empty, for later steps
    if (!combinedConfig.POOL_GROUPS) {
        combinedConfig.POOL_GROUPS = [];
    }
    combinedConfig.getAllPoolConfigs = () => []; // Return empty array for now
    // --- ---

    if (combinedConfig.DRY_RUN) { console.warn("[Config] --- DRY RUN MODE ENABLED ---"); } else { console.log("[Config] --- LIVE TRADING MODE ---"); }
    console.log('[loadConfig INNER - Simple] Exiting loadConfig successfully.');
    return combinedConfig;
}
// --- End loadConfig Function ---


// --- Load and Export Config ---
let config;
console.log('[Config] Attempting to call loadConfig inside try block...');
try {
    config = loadConfig();
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
console.log('[Config Top Level] module.exports reached.');
