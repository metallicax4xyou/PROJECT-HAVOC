// config/index.js
// Main configuration loader - Refactored

require('dotenv').config(); // Load .env file first
const { ethers } = require('ethers');
const { Token } = require('@uniswap/sdk-core'); // Still needed for final check potentially
let logger; try { logger = require('../utils/logger'); } catch(e) { console.error("No logger"); logger = console; }

// --- Load Helper Modules ---
const ConfigHelpers = require('./helpers'); // Load barrel file

// --- Load Network Metadata Helper ---
function getNetworkMetadata(networkName) { if (networkName === 'arbitrum') return { CHAIN_ID: 42161, NAME: 'arbitrum', NATIVE_SYMBOL: 'ETH', NATIVE_DECIMALS: 18 }; return null; }

// --- Load Shared Protocol Addresses ---
const { PROTOCOL_ADDRESSES } = require('../constants/addresses');
// --- Load SDK Token Instances ---
const { TOKENS } = require('../constants/tokens');

// --- loadConfig Function ---
function loadConfig() {
    logger.debug('[loadConfig] Starting loadConfig function...');
    const networkName = process.env.NETWORK?.toLowerCase();
    if (!networkName) { throw new Error(`[Config] CRITICAL: Missing NETWORK environment variable.`); }

    // --- Validate Core Env Vars using Helpers ---
    const rpcUrlsEnvKey = `${networkName.toUpperCase()}_RPC_URLS`;
    const validatedRpcUrls = ConfigHelpers.Validators.validateRpcUrls(process.env[rpcUrlsEnvKey], rpcUrlsEnvKey);
    if (!validatedRpcUrls) { throw new Error(`[Config] CRITICAL: Invalid or missing RPC URL(s). Env var needed: ${rpcUrlsEnvKey}`); }

    const validatedPrivateKey = ConfigHelpers.Validators.validatePrivateKey(process.env.PRIVATE_KEY, 'PRIVATE_KEY');
    if (!validatedPrivateKey) { throw new Error(`[Config] CRITICAL: Invalid or missing PRIVATE_KEY.`); }

    const flashSwapEnvKey = `${networkName.toUpperCase()}_FLASH_SWAP_ADDRESS`;
    const validatedFlashSwapAddress = ConfigHelpers.Validators.validateAndNormalizeAddress(process.env[flashSwapEnvKey], flashSwapEnvKey);
    if (!validatedFlashSwapAddress) {
        logger.warn(`[Config] WARNING: FlashSwap address not set or invalid. Env var checked: ${flashSwapEnvKey}. Bot may fail if execution is attempted.`);
    }

    const tickLensEnvKey = `${networkName.toUpperCase()}_TICKLENS_ADDRESS`;
    const validatedTickLensAddress = ConfigHelpers.Validators.validateAndNormalizeAddress(process.env[tickLensEnvKey], tickLensEnvKey);
    if (!validatedTickLensAddress) {
        throw new Error(`[Config] CRITICAL: Invalid or missing TickLens address. Env var needed: ${tickLensEnvKey}`);
    }
    // --- ---

    const networkMetadata = getNetworkMetadata(networkName);
    if (!networkMetadata) { throw new Error(`[Config] CRITICAL: No metadata for network: ${networkName}`); }

    let networkSpecificConfig;
    try { networkSpecificConfig = require(`./${networkName}.js`); logger.log(`[Config] Loaded ./${networkName}.js`); }
    catch (e) { throw new Error(`[Config] CRITICAL: Failed to load config/${networkName}.js: ${e.message}`); }

    // Load Global Settings using Helpers
    const cycleIntervalMs = ConfigHelpers.Validators.safeParseInt(process.env.CYCLE_INTERVAL_MS, 'CYCLE_INTERVAL_MS', 5000);
    const gasLimitEstimate = ConfigHelpers.Validators.safeParseBigInt(process.env.GAS_LIMIT_ESTIMATE, 'GAS_LIMIT_ESTIMATE', 1500000n);
    const slippageToleranceBps = ConfigHelpers.Validators.safeParseInt(process.env.SLIPPAGE_TOLERANCE_BPS, 'SLIPPAGE_TOLERANCE_BPS', 10);
    const isDryRun = ConfigHelpers.Validators.parseBoolean(process.env.DRY_RUN);

    // --- Combine Base Config Object (without POOL_GROUPS initially) ---
    const baseConfig = {
        ...networkMetadata,
        CHAINLINK_FEEDS: networkSpecificConfig.CHAINLINK_FEEDS || {}, // From arbitrum.js
        TOKENS: TOKENS, // From constants/tokens.js

        // Core items from .env
        RPC_URLS: validatedRpcUrls,
        PRIMARY_RPC_URL: validatedRpcUrls[0],
        PRIVATE_KEY: validatedPrivateKey,
        FLASH_SWAP_CONTRACT_ADDRESS: validatedFlashSwapAddress || ethers.ZeroAddress, // Use validated or default
        TICKLENS_ADDRESS: validatedTickLensAddress, // Use the validated address from .env

        // Global bot settings from .env
        CYCLE_INTERVAL_MS: cycleIntervalMs,
        GAS_LIMIT_ESTIMATE: gasLimitEstimate,
        SLIPPAGE_TOLERANCE_BPS: slippageToleranceBps,
        DRY_RUN: isDryRun,

        // Protocol constants
        FACTORY_ADDRESS: PROTOCOL_ADDRESSES.UNISWAP_V3_FACTORY,
        QUOTER_ADDRESS: PROTOCOL_ADDRESSES.QUOTER_V2,
    };
    logger.debug('[loadConfig] Base config object created.');

    // --- Process POOL_GROUPS using PoolProcessor Helper ---
    const rawPoolGroups = networkSpecificConfig.POOL_GROUPS;
    const { validProcessedPoolGroups, loadedPoolAddresses } = ConfigHelpers.PoolProcessor.processPoolGroups(baseConfig, rawPoolGroups);

    // Add processed groups to the config
    baseConfig.POOL_GROUPS = validProcessedPoolGroups;
    // --- ---

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
    // Add TICKLENS_ADDRESS check here (remains important)
    if (!config || !config.NAME || !config.CHAIN_ID || !config.PRIVATE_KEY || !config.RPC_URLS || config.RPC_URLS.length === 0 || !config.TICKLENS_ADDRESS || config.TICKLENS_ADDRESS === ethers.ZeroAddress) {
        logger.error(`[Config Load Check] loadConfig result missing essential properties (RPC, PK, TickLens)!`, config); throw new Error("Config object incomplete after loading.");
    }
    logger.info(`[Config] Config loaded: Network=${config.NAME}, ChainID=${config.CHAIN_ID}`);
} catch (error) {
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"); console.error("!!! FATAL CONFIGURATION ERROR !!!"); console.error(`!!! ${error.message}`); console.error("!!! Bot cannot start."); console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"); process.exit(1);
}
module.exports = config;
console.log('[Config Top Level] module.exports reached.');
