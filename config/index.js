// config/index.js
// Main configuration loader - Attempt 5: Isolate Validation Failures

require('dotenv').config();
const { ethers } = require('ethers');
const { Token } = require('@uniswap/sdk-core');
let logger; try { logger = require('../utils/logger'); } catch(e) { console.error("No logger"); logger = console; }

// --- Load Network Metadata Helper ---
function getNetworkMetadata(networkName) { if (networkName === 'arbitrum') return { CHAIN_ID: 42161, NAME: 'arbitrum', NATIVE_SYMBOL: 'ETH', NATIVE_DECIMALS: 18 }; return null; }

// --- Load Shared Protocol Addresses ---
const { PROTOCOL_ADDRESSES } = require('../constants/addresses');
// --- Load SDK Token Instances ---
const { TOKENS } = require('../constants/tokens');

// --- Validation Functions --- (Assume correct implementations from before)
function validateAndNormalizeAddress(rawAddress, contextName) { /* ... */ }
function validatePrivateKey(rawKey, contextName) { /* ... */ }
function validateRpcUrls(rawUrls, contextName) { /* ... */ }
function safeParseBigInt(valueStr, contextName, defaultValue = 0n) { /* ... */ }
function safeParseInt(valueStr, contextName, defaultValue = 0) { /* ... */ }
function parseBoolean(valueStr) { /* ... */ }
// --- End Validation Functions ---


// --- loadConfig Function ---
function loadConfig() {
    logger.debug('[loadConfig] Starting loadConfig function...');
    let validatedRpcUrls, validatedPrivateKey, validatedFlashSwapAddress; // Define vars outside try blocks

    // --- STEP 1: Validate Network Name ---
    const networkName = process.env.NETWORK?.toLowerCase();
    if (!networkName) { throw new Error(`[Config] CRITICAL: Missing NETWORK environment variable.`); }
    logger.debug(`[loadConfig] Network name: ${networkName}`);

    // --- STEP 2: Validate RPC URLs ---
    try {
        const rpcUrlsEnvKey = `${networkName.toUpperCase()}_RPC_URLS`;
        const rawRpcFromEnv = process.env[rpcUrlsEnvKey];
        logger.debug(`[loadConfig] Validating RPC: Raw='${rawRpcFromEnv}'`);
        validatedRpcUrls = validateRpcUrls(rawRpcFromEnv, rpcUrlsEnvKey);
        if (!validatedRpcUrls) { throw new Error(`Validation function returned null/empty for RPC URLs.`); }
        logger.debug(`[loadConfig] RPC URLs validation passed.`);
    } catch (error) {
        throw new Error(`[Config] CRITICAL: Error during RPC URL validation: ${error.message}`);
    }

    // --- STEP 3: Validate Private Key ---
    try {
        const rawPrivateKey = process.env.PRIVATE_KEY;
        logger.debug(`[loadConfig] Validating Private Key...`);
        validatedPrivateKey = validatePrivateKey(rawPrivateKey, 'PRIVATE_KEY');
        if (!validatedPrivateKey) { throw new Error(`Validation function returned null for Private Key.`); }
        logger.debug(`[loadConfig] Private Key validation passed.`);
    } catch (error) {
        throw new Error(`[Config] CRITICAL: Error during Private Key validation: ${error.message}`);
    }

    // --- STEP 4: Load Network Metadata ---
    const networkMetadata = getNetworkMetadata(networkName);
    if (!networkMetadata) { throw new Error(`[Config] CRITICAL: No metadata for network: ${networkName}`); }
    logger.debug(`[loadConfig] Network metadata loaded.`);

    // --- STEP 5: Load Network Specific Config ---
    let networkSpecificConfig;
    try { networkSpecificConfig = require(`./${networkName}.js`); logger.log(`[Config] Loaded ./${networkName}.js`); }
    catch (e) { throw new Error(`[Config] CRITICAL: Failed to load config/${networkName}.js: ${e.message}`); }

    // --- STEP 6: Validate Optional Flash Swap Address ---
    try {
         const flashSwapEnvKey = `${networkName.toUpperCase()}_FLASH_SWAP_ADDRESS`;
         validatedFlashSwapAddress = validateAndNormalizeAddress(process.env[flashSwapEnvKey], flashSwapEnvKey);
         if (!validatedFlashSwapAddress) { logger.warn(`[Config] WARNING: ${flashSwapEnvKey} not set or invalid.`); }
         logger.debug(`[loadConfig] Flash Swap Address validated (optional).`);
    } catch (error) {
         logger.warn(`[Config] Error validating Flash Swap Address: ${error.message}`);
         validatedFlashSwapAddress = null; // Treat as unset on error
    }

    // --- STEP 7: Load Global Settings ---
    const cycleIntervalMs = safeParseInt(process.env.CYCLE_INTERVAL_MS, 'CYCLE_INTERVAL_MS', 5000);
    const gasLimitEstimate = safeParseBigInt(process.env.GAS_LIMIT_ESTIMATE, 'GAS_LIMIT_ESTIMATE', 1500000n);
    const slippageToleranceBps = safeParseInt(process.env.SLIPPAGE_TOLERANCE_BPS, 'SLIPPAGE_TOLERANCE_BPS', 10);
    const isDryRun = parseBoolean(process.env.DRY_RUN);
    logger.debug(`[loadConfig] Global settings loaded.`);

    // --- STEP 8: Combine Base Config ---
     const baseConfig = {
         ...networkMetadata, CHAINLINK_FEEDS: networkSpecificConfig.CHAINLINK_FEEDS || {}, TOKENS: TOKENS,
         RPC_URLS: validatedRpcUrls, PRIMARY_RPC_URL: validatedRpcUrls[0], PRIVATE_KEY: validatedPrivateKey,
         FLASH_SWAP_CONTRACT_ADDRESS: validatedFlashSwapAddress || ethers.ZeroAddress,
         CYCLE_INTERVAL_MS: cycleIntervalMs, GAS_LIMIT_ESTIMATE: gasLimitEstimate, SLIPPAGE_TOLERANCE_BPS: slippageToleranceBps, DRY_RUN: isDryRun,
         FACTORY_ADDRESS: PROTOCOL_ADDRESSES.UNISWAP_V3_FACTORY, QUOTER_ADDRESS: PROTOCOL_ADDRESSES.QUOTER_V2, TICK_LENS_ADDRESS: PROTOCOL_ADDRESSES.TICK_LENS,
     };
     logger.debug(`[loadConfig] Base config combined.`);

    // --- STEP 9: Process POOL_GROUPS ---
    let totalPoolsLoaded = 0; const loadedPoolAddresses = new Set(); const validProcessedPoolGroups = [];
    const rawPoolGroups = networkSpecificConfig.POOL_GROUPS;
    if (!rawPoolGroups || !Array.isArray(rawPoolGroups)) { logger.warn('[Config] POOL_GROUPS missing/invalid.'); }
    else {
        logger.debug(`[loadConfig] Starting POOL_GROUP processing for ${rawPoolGroups.length} groups...`);
        rawPoolGroups.forEach((groupInput, groupIndex) => {
             // ... (Full group processing logic with internal try/catch as before) ...
              try {
                   const group = { ...groupInput }; let currentGroupIsValid = true; const errorMessages = [];
                   // Validate structure, enrich tokens, borrow amount, min profit, load pools...
                   if (!group || !group.name /*...*/) { errorMessages.push(/*...*/); currentGroupIsValid = false;}
                   if (currentGroupIsValid) { group.token0 = baseConfig.TOKENS[group.token0Symbol]; /*...*/ if(!group.token0 /*...*/) { errorMessages.push(/*...*/); currentGroupIsValid=false;} else { group.sdkToken0 = /*...*/; } }
                   if (currentGroupIsValid) { const key=`BORROW_AMOUNT_${group.borrowTokenSymbol}`; if(!process.env[key]) { errorMessages.push(/*...*/); currentGroupIsValid=false;} else try{ group.borrowAmount=ethers.parseUnits(/*...*/); } catch(e){/*...*/} }
                   if (currentGroupIsValid) { group.minNetProfit = safeParseBigInt(/*...*/); }
                   if (currentGroupIsValid) { group.pools=[]; if(group.feeTierToEnvMap){/*... load pools ...*/} validProcessedPoolGroups.push(group); }
                   else { logger.error(`[Config] Skipping POOL_GROUP ${group?.name || `#${groupIndex}`} errors: ${errorMessages.join('; ')}`); }
              } catch (groupError) { logger.error(`[Config] Unexpected error processing POOL_GROUP ${groupInput?.name || `#${groupIndex}`}: ${groupError.message}. Skipping.`); }
        });
        logger.log(`[Config] Finished pool group processing. Valid groups: ${validProcessedPoolGroups.length}`);
    }
    baseConfig.POOL_GROUPS = validProcessedPoolGroups; // Assign valid groups
    logger.log(`[Config] Total unique pools loaded: ${loadedPoolAddresses.size}`);
    if (loadedPoolAddresses.size === 0) { console.warn("[Config] WARNING: No pool addresses loaded."); }
    // --- ---

    // --- STEP 10: Final Steps ---
    baseConfig.getAllPoolConfigs = () => baseConfig.POOL_GROUPS.flatMap(group => group.pools || []);
    if (baseConfig.DRY_RUN) { console.warn("[Config] --- DRY RUN MODE ENABLED ---"); } else { console.log("[Config] --- LIVE TRADING MODE ---"); }
    logger.debug('[loadConfig] Exiting loadConfig successfully.');
    return baseConfig;
}
// --- End loadConfig Function ---


// --- Load and Export Config ---
let config;
console.log('[Config] Attempting to call loadConfig inside try block...');
try {
    config = loadConfig();
    // Check essential properties after loadConfig returns
    if (!config || !config.NAME || !config.CHAIN_ID || !config.PRIVATE_KEY || !config.RPC_URLS || config.RPC_URLS.length === 0) {
         logger.error(`[Config Load Check] loadConfig result is missing essential properties!`, config);
         throw new Error("Config object incomplete after loading.");
    }
    logger.info(`[Config] Config loaded OK: Network=${config.NAME}, ChainID=${config.CHAIN_ID}`);
} catch (error) {
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    console.error("!!! FATAL CONFIGURATION ERROR !!!");
    console.error(`!!! ${error.message}`); // Log specific error message
    console.error("!!! Bot cannot start.");
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    process.exit(1);
}
module.exports = config;
console.log('[Config Top Level] module.exports reached.');
