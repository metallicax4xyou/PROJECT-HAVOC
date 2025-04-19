// config/index.js
// Main configuration loader - Attempt 7: Correct TickLens Address Loading

require('dotenv').config(); // Load .env file first
const { ethers } = require('ethers');
const { Token } = require('@uniswap/sdk-core');
let logger; try { logger = require('../utils/logger'); } catch(e) { console.error("No logger"); logger = console; }

// --- Load Network Metadata Helper ---
function getNetworkMetadata(networkName) { if (networkName === 'arbitrum') return { CHAIN_ID: 42161, NAME: 'arbitrum', NATIVE_SYMBOL: 'ETH', NATIVE_DECIMALS: 18 }; return null; }

// --- Load Shared Protocol Addresses ---
// We still need this for Factory and Quoter
const { PROTOCOL_ADDRESSES } = require('../constants/addresses');
// --- Load SDK Token Instances ---
const { TOKENS } = require('../constants/tokens');

// --- Validation Functions --- (Keep existing full implementations)
function validateAndNormalizeAddress(rawAddress, contextName) {
    const addressString = String(rawAddress || '').trim();
    if (!addressString) { return null; }
    try {
        const cleanAddress = addressString.replace(/^['"]+|['"]+$/g, '');
        if (!ethers.isAddress(cleanAddress)) {
            logger.warn(`[Config Validate] ${contextName}: Invalid address format "${cleanAddress}".`);
            return null;
        }
        return ethers.getAddress(cleanAddress);
    } catch (error) {
        logger.warn(`[Config Validate] ${contextName}: Validation error for "${rawAddress}" - ${error.message}`);
        return null;
    }
}
function validatePrivateKey(rawKey, contextName) {
    const keyString = String(rawKey||'').trim().replace(/^0x/,'');
    const valid = /^[a-fA-F0-9]{64}$/.test(keyString);
    if(!valid) logger.error(`[Config Validate PK] Invalid PK for ${contextName}, length ${keyString.length}`);
    return valid ? keyString : null;
}
function validateRpcUrls(rawUrls, contextName) {
    logger.debug(`[ValidateRPC INNER] Received rawUrls for ${contextName}: "${rawUrls}"`);
    const urlsString = String(rawUrls || '').trim();
    if (!urlsString) { logger.error(`[Config Validate] CRITICAL ${contextName}: RPC URL(s) string is empty.`); return null; }
    const urls = urlsString.split(',')
        .map(url => url.trim())
        .filter(url => {
            if (!url) return false;
            const isValidFormat = /^(https?|wss?):\/\/.+/i.test(url);
            if (!isValidFormat) { logger.warn(`[Config Validate] ${contextName}: Invalid URL format skipped: "${url}"`); return false; }
            return true;
        });
    logger.debug(`[ValidateRPC INNER] Filtered URLs count: ${urls.length}`);
    if (urls.length === 0) { logger.error(`[Config Validate] CRITICAL ${contextName}: No valid RPC URLs found.`); return null; }
    logger.debug(`[ValidateRPC INNER] Validation successful for ${contextName}.`);
    return urls;
}
function safeParseBigInt(valueStr, contextName, defaultValue = 0n) { try { const s=String(valueStr||'').trim(); if(s.includes('.')) throw new Error("Decimal in BigInt"); return s ? BigInt(s) : defaultValue; } catch(e) { logger.warn(`[Config Parse BigInt] ${contextName}: Failed "${valueStr}": ${e.message}`); return defaultValue; } }
function safeParseInt(valueStr, contextName, defaultValue = 0) { const n = parseInt(String(valueStr||'').trim(), 10); if(isNaN(n)) { logger.warn(`[Config Parse Int] ${contextName}: Failed "${valueStr}"`); return defaultValue; } return n; }
function parseBoolean(valueStr) { return String(valueStr || '').trim().toLowerCase() !== 'false'; }
// --- End Validation Functions ---


// --- loadConfig Function ---
function loadConfig() {
    logger.debug('[loadConfig] Starting loadConfig function...');
    const networkName = process.env.NETWORK?.toLowerCase();
    if (!networkName) { throw new Error(`[Config] CRITICAL: Missing NETWORK environment variable.`); }

    // --- Validate Core Env Vars ---
    const rpcUrlsEnvKey = `${networkName.toUpperCase()}_RPC_URLS`;
    const validatedRpcUrls = validateRpcUrls(process.env[rpcUrlsEnvKey], rpcUrlsEnvKey);
    if (!validatedRpcUrls) { throw new Error(`[Config] CRITICAL: Invalid or missing RPC URL(s). Env var needed: ${rpcUrlsEnvKey}`); }

    const validatedPrivateKey = validatePrivateKey(process.env.PRIVATE_KEY, 'PRIVATE_KEY');
    if (!validatedPrivateKey) { throw new Error(`[Config] CRITICAL: Invalid or missing PRIVATE_KEY.`); }

    const flashSwapEnvKey = `${networkName.toUpperCase()}_FLASH_SWAP_ADDRESS`;
    const validatedFlashSwapAddress = validateAndNormalizeAddress(process.env[flashSwapEnvKey], flashSwapEnvKey);
    if (!validatedFlashSwapAddress) {
        logger.warn(`[Config] WARNING: FlashSwap address not set or invalid. Env var checked: ${flashSwapEnvKey}. Bot may fail if execution is attempted.`);
        // Consider throwing an error if flash swap is absolutely required to run
        // throw new Error(`[Config] CRITICAL: Invalid or missing FlashSwap address. Env var needed: ${flashSwapEnvKey}`);
    }

    // *** NEW: Validate TickLens Address ***
    const tickLensEnvKey = `${networkName.toUpperCase()}_TICKLENS_ADDRESS`;
    const validatedTickLensAddress = validateAndNormalizeAddress(process.env[tickLensEnvKey], tickLensEnvKey);
    if (!validatedTickLensAddress) {
        // TickLens IS essential for simulation, so throw an error if it's missing/invalid
        throw new Error(`[Config] CRITICAL: Invalid or missing TickLens address. Env var needed: ${tickLensEnvKey}`);
    }
    // --- ---

    const networkMetadata = getNetworkMetadata(networkName);
    if (!networkMetadata) { throw new Error(`[Config] CRITICAL: No metadata for network: ${networkName}`); }

    let networkSpecificConfig;
    try { networkSpecificConfig = require(`./${networkName}.js`); logger.log(`[Config] Loaded ./${networkName}.js`); }
    catch (e) { throw new Error(`[Config] CRITICAL: Failed to load config/${networkName}.js: ${e.message}`); }

    // Load Global Settings
    const cycleIntervalMs = safeParseInt(process.env.CYCLE_INTERVAL_MS, 'CYCLE_INTERVAL_MS', 5000);
    const gasLimitEstimate = safeParseBigInt(process.env.GAS_LIMIT_ESTIMATE, 'GAS_LIMIT_ESTIMATE', 1500000n);
    const slippageToleranceBps = safeParseInt(process.env.SLIPPAGE_TOLERANCE_BPS, 'SLIPPAGE_TOLERANCE_BPS', 10);
    const isDryRun = parseBoolean(process.env.DRY_RUN);

    // --- Combine Base Config Object ---
     const baseConfig = {
         ...networkMetadata,
         CHAINLINK_FEEDS: networkSpecificConfig.CHAINLINK_FEEDS || {}, // From arbitrum.js
         TOKENS: TOKENS, // From constants/tokens.js

         // Core items from .env
         RPC_URLS: validatedRpcUrls,
         PRIMARY_RPC_URL: validatedRpcUrls[0],
         PRIVATE_KEY: validatedPrivateKey,
         FLASH_SWAP_CONTRACT_ADDRESS: validatedFlashSwapAddress || ethers.ZeroAddress, // Use validated or default
         TICKLENS_ADDRESS: validatedTickLensAddress, // *** Use the validated address from .env ***

         // Global bot settings from .env
         CYCLE_INTERVAL_MS: cycleIntervalMs,
         GAS_LIMIT_ESTIMATE: gasLimitEstimate,
         SLIPPAGE_TOLERANCE_BPS: slippageToleranceBps,
         DRY_RUN: isDryRun,

         // Protocol constants (still useful)
         FACTORY_ADDRESS: PROTOCOL_ADDRESSES.UNISWAP_V3_FACTORY,
         QUOTER_ADDRESS: PROTOCOL_ADDRESSES.QUOTER_V2,
         // Removed TICK_LENS_ADDRESS: PROTOCOL_ADDRESSES.TICK_LENS
     };
     logger.debug('[loadConfig] Base config object created.');


    // --- Process POOL_GROUPS with Correct Logic --- (Keep existing logic)
    let totalPoolsLoaded = 0;
    const loadedPoolAddresses = new Set();
    const validProcessedPoolGroups = [];

    const rawPoolGroups = networkSpecificConfig.POOL_GROUPS;

    if (!rawPoolGroups || !Array.isArray(rawPoolGroups)) {
        logger.warn('[Config] POOL_GROUPS array is missing or invalid in network config.');
    } else {
        logger.debug(`[DEBUG Config] Processing ${rawPoolGroups.length} raw POOL_GROUPS...`);
        rawPoolGroups.forEach((groupInput, groupIndex) => {
            const group = { ...groupInput }; // Work on a copy
            let currentGroupIsValid = true;
            const errorMessages = [];

            try {
                // Validate Group Structure
                if (!group || !group.name || !group.token0Symbol || !group.token1Symbol || !group.borrowTokenSymbol || typeof group.minNetProfit === 'undefined') {
                    errorMessages.push(`Group #${groupIndex}: Missing required fields.`); currentGroupIsValid = false;
                }

                // Enrich with SDK Tokens
                if (currentGroupIsValid) {
                    group.token0 = baseConfig.TOKENS[group.token0Symbol];
                    group.token1 = baseConfig.TOKENS[group.token1Symbol];
                    group.borrowToken = baseConfig.TOKENS[group.borrowTokenSymbol];
                    if (!(group.token0 instanceof Token) || !(group.token1 instanceof Token) || !(group.borrowToken instanceof Token)) {
                         errorMessages.push(`Group "${group.name}": Failed SDK Token lookup.`); currentGroupIsValid = false;
                    } else {
                         group.sdkToken0 = group.token0; group.sdkToken1 = group.token1; group.sdkBorrowToken = group.borrowToken;
                         logger.debug(`[DEBUG Config] Assigned SDK tokens for group ${group.name}`);
                    }
                }

                 // Enrich with Borrow Amount
                 if (currentGroupIsValid) {
                      const borrowAmountEnvKey = `BORROW_AMOUNT_${group.borrowTokenSymbol}`;
                      const rawBorrowAmount = process.env[borrowAmountEnvKey];
                      if (!rawBorrowAmount) {
                           errorMessages.push(`Group "${group.name}": Missing env var ${borrowAmountEnvKey}.`); currentGroupIsValid = false;
                      } else {
                           try {
                                group.borrowAmount = ethers.parseUnits(rawBorrowAmount, group.borrowToken.decimals);
                                if (group.borrowAmount <= 0n) { throw new Error("must be positive"); }
                                logger.log(`[Config] Group ${group.name}: Borrow Amount set to ${rawBorrowAmount} ${group.borrowTokenSymbol}`);
                           } catch (e) { errorMessages.push(`Group "${group.name}": Invalid borrow amt "${rawBorrowAmount}": ${e.message}`); currentGroupIsValid = false; }
                      }
                 }

                 // Enrich with Min Net Profit
                 if (currentGroupIsValid) {
                      group.minNetProfit = safeParseBigInt(group.minNetProfit, `Group ${group.name} minNetProfit`, 0n);
                      logger.log(`[Config] Group ${group.name}: Min Net Profit set to ${ethers.formatUnits(group.minNetProfit, 18)} ${baseConfig.NATIVE_SYMBOL}`);
                 }

                 // Load Pools for Group
                 if (currentGroupIsValid) {
                     group.pools = []; // Initialize pools array
                     let poolsFoundForGroup = 0; // Counter for this specific group
                     if (group.feeTierToEnvMap && typeof group.feeTierToEnvMap === 'object') {
                         for (const feeTierStr in group.feeTierToEnvMap) {
                             const feeTier = parseInt(feeTierStr, 10);
                             if (isNaN(feeTier)) { logger.warn(`[Config] Invalid fee tier key "${feeTierStr}" for group ${group.name}.`); continue; }
                             const envVarKey = group.feeTierToEnvMap[feeTierStr];
                             const rawAddress = process.env[envVarKey];
                             if (rawAddress) {
                                 const validatedAddress = validateAndNormalizeAddress(rawAddress, envVarKey);
                                 if (validatedAddress) {
                                     if (loadedPoolAddresses.has(validatedAddress.toLowerCase())) {
                                          logger.warn(`[Config] Skipping duplicate pool address ${validatedAddress} from ${envVarKey}.`);
                                          continue;
                                     }
                                     const poolConfig = {
                                         address: validatedAddress,
                                         fee: feeTier,
                                         groupName: group.name,
                                         token0Symbol: group.token0Symbol,
                                         token1Symbol: group.token1Symbol
                                     };
                                     group.pools.push(poolConfig);
                                     totalPoolsLoaded++;
                                     poolsFoundForGroup++;
                                     loadedPoolAddresses.add(validatedAddress.toLowerCase());
                                 } else { logger.warn(`[Config] Invalid address format for ${envVarKey}. Skipping pool.`); }
                             } // else { logger.debug(`[Config] Optional: Env var ${envVarKey} not found.`); }
                         } // end for feeTierStr
                         logger.log(`[Config] Group ${group.name} processed with ${poolsFoundForGroup} pools found in .env.`);
                     } else { logger.warn(`[Config] No feeTierToEnvMap for group ${group.name}.`); }

                     // Only add group if it has at least one valid pool loaded
                     if (group.pools.length > 0) {
                         validProcessedPoolGroups.push(group);
                     } else {
                         logger.warn(`[Config] Group ${group.name} skipped: No valid pools loaded from .env based on feeTierToEnvMap.`);
                     }
                 } else {
                     logger.error(`[Config] Skipping POOL_GROUP ${group?.name || `#${groupIndex}`} due to errors: ${errorMessages.join('; ')}`);
                 }

            } catch (groupError) {
                 logger.error(`[Config] Unexpected error processing POOL_GROUP ${groupInput?.name || `#${groupIndex}`}: ${groupError.message}. Skipping.`);
            }
        }); // End forEach groupInput
    } // End else rawPoolGroups valid

    baseConfig.POOL_GROUPS = validProcessedPoolGroups;
    logger.log(`[Config] Finished processing pool groups. Valid groups loaded: ${baseConfig.POOL_GROUPS.length}`);
    logger.log(`[Config] Total unique pools loaded across all valid groups: ${loadedPoolAddresses.size}`);
    if (loadedPoolAddresses.size === 0) { console.warn("[Config] WARNING: No pool addresses were loaded from .env variables."); }
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
    // Add TICKLENS_ADDRESS check here
    if (!config || !config.NAME || !config.CHAIN_ID || !config.PRIVATE_KEY || !config.RPC_URLS || config.RPC_URLS.length === 0 || !config.TICKLENS_ADDRESS || config.TICKLENS_ADDRESS === ethers.ZeroAddress) {
         logger.error(`[Config Load Check] loadConfig result missing essential properties (RPC, PK, TickLens)!`, config); throw new Error("Config object incomplete after loading.");
    }
    logger.info(`[Config] Config loaded: Network=${config.NAME}, ChainID=${config.CHAIN_ID}`);
} catch (error) {
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"); console.error("!!! FATAL CONFIGURATION ERROR !!!"); console.error(`!!! ${error.message}`); console.error("!!! Bot cannot start."); console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"); process.exit(1);
}
module.exports = config;
console.log('[Config Top Level] module.exports reached.');
