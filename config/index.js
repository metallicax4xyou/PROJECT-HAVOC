// config/index.js
// Main configuration loader - Attempt 3: Restore Pool Groups Carefully

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

// --- Validation Functions --- (Assume these are correct)
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
    const networkName = process.env.NETWORK?.toLowerCase();
    if (!networkName) { throw new Error(`[Config] CRITICAL: Missing NETWORK.`); }

    // --- Validate Core Env Vars ---
    const rpcUrlsEnvKey = `${networkName.toUpperCase()}_RPC_URLS`;
    const validatedRpcUrls = validateRpcUrls(process.env[rpcUrlsEnvKey], rpcUrlsEnvKey);
    if (!validatedRpcUrls) { throw new Error(`[Config] CRITICAL: Invalid RPC URL(s).`); }
    const validatedPrivateKey = validatePrivateKey(process.env.PRIVATE_KEY, 'PRIVATE_KEY');
    if (!validatedPrivateKey) { throw new Error(`[Config] CRITICAL: Invalid PRIVATE_KEY.`); }
    const flashSwapEnvKey = `${networkName.toUpperCase()}_FLASH_SWAP_ADDRESS`;
    const validatedFlashSwapAddress = validateAndNormalizeAddress(process.env[flashSwapEnvKey], flashSwapEnvKey);
    // --- ---

    const networkMetadata = getNetworkMetadata(networkName);
    if (!networkMetadata) { throw new Error(`[Config] CRITICAL: No metadata for network: ${networkName}`); }

    let networkSpecificConfig;
    try { networkSpecificConfig = require(`./${networkName}.js`); logger.log(`[Config] Loaded network-specific config for ${networkName}.`); }
    catch (e) { throw new Error(`[Config] CRITICAL: Failed to load config/${networkName}.js: ${e.message}`); }

    // --- Load Global Settings ---
    const cycleIntervalMs = safeParseInt(process.env.CYCLE_INTERVAL_MS, 'CYCLE_INTERVAL_MS', 5000);
    const gasLimitEstimate = safeParseBigInt(process.env.GAS_LIMIT_ESTIMATE, 'GAS_LIMIT_ESTIMATE', 1500000n);
    const slippageToleranceBps = safeParseInt(process.env.SLIPPAGE_TOLERANCE_BPS, 'SLIPPAGE_TOLERANCE_BPS', 10);
    const isDryRun = parseBoolean(process.env.DRY_RUN);
    // --- ---

    // --- Define the BASE config object FIRST ---
     const baseConfig = {
         ...networkMetadata,
         // Do NOT spread networkSpecificConfig here yet, process its POOL_GROUPS separately
         CHAINLINK_FEEDS: networkSpecificConfig.CHAINLINK_FEEDS || {}, // Add feeds safely
         TOKENS: TOKENS,
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
     logger.debug('[loadConfig] Base config object created.');


    // --- Process POOL_GROUPS from networkSpecificConfig ---
    let totalPoolsLoaded = 0;
    const loadedPoolAddresses = new Set();
    const validProcessedPoolGroups = []; // Store fully processed, valid groups

    const rawPoolGroups = networkSpecificConfig.POOL_GROUPS; // Get groups from arbitrum.js etc.

    if (!rawPoolGroups || !Array.isArray(rawPoolGroups)) {
        logger.warn('[Config] POOL_GROUPS array is missing or invalid in network config.');
    } else {
        logger.debug(`[DEBUG Config] Processing ${rawPoolGroups.length} raw POOL_GROUPS...`);
        rawPoolGroups.forEach((groupInput, groupIndex) => {
            // Create a *copy* of the groupInput to avoid modifying the original require cache
            const group = { ...groupInput };
            let currentGroupIsValid = true;
            const errorMessages = [];

            try {
                // --- Validate Group Structure ---
                if (!group || !group.name || !group.token0Symbol || !group.token1Symbol || !group.borrowTokenSymbol || typeof group.minNetProfit === 'undefined') {
                    errorMessages.push(`Group #${groupIndex}: Missing required fields.`); currentGroupIsValid = false;
                }

                // --- Enrich with SDK Tokens (using baseConfig.TOKENS) ---
                if (currentGroupIsValid) {
                    group.token0 = baseConfig.TOKENS[group.token0Symbol];
                    group.token1 = baseConfig.TOKENS[group.token1Symbol];
                    group.borrowToken = baseConfig.TOKENS[group.borrowTokenSymbol];
                    if (!(group.token0 instanceof Token) || !(group.token1 instanceof Token) || !(group.borrowToken instanceof Token)) {
                         errorMessages.push(`Group "${group.name}": Failed SDK Token lookup.`); currentGroupIsValid = false;
                    } else {
                         group.sdkToken0 = group.token0; group.sdkToken1 = group.token1; group.sdkBorrowToken = group.borrowToken;
                    }
                }

                 // --- Enrich with Borrow Amount ---
                 if (currentGroupIsValid) {
                      const borrowAmountEnvKey = `BORROW_AMOUNT_${group.borrowTokenSymbol}`;
                      const rawBorrowAmount = process.env[borrowAmountEnvKey];
                      if (!rawBorrowAmount) {
                           errorMessages.push(`Group "${group.name}": Missing env var ${borrowAmountEnvKey}.`); currentGroupIsValid = false;
                      } else {
                           try {
                                group.borrowAmount = ethers.parseUnits(rawBorrowAmount, group.borrowToken.decimals);
                                if (group.borrowAmount <= 0n) { throw new Error("must be positive"); }
                           } catch (e) { errorMessages.push(`Group "${group.name}": Invalid borrow amt: ${e.message}`); currentGroupIsValid = false; }
                      }
                 }

                 // --- Enrich with Min Net Profit ---
                 if (currentGroupIsValid) {
                      group.minNetProfit = safeParseBigInt(group.minNetProfit, `Group ${group.name} minNetProfit`, 0n);
                 }

                 // --- Load Pools for Group ---
                 if (currentGroupIsValid) {
                     group.pools = []; // Initialize pools array
                     if (group.feeTierToEnvMap && typeof group.feeTierToEnvMap === 'object') {
                         for (const feeTierStr in group.feeTierToEnvMap) {
                             const feeTier = parseInt(feeTierStr, 10); if (isNaN(feeTier)) continue;
                             const envVarKey = group.feeTierToEnvMap[feeTierStr]; const rawAddress = process.env[envVarKey];
                             if (rawAddress) {
                                 const validatedAddress = validateAndNormalizeAddress(rawAddress, envVarKey);
                                 if (validatedAddress) {
                                     if (loadedPoolAddresses.has(validatedAddress.toLowerCase())) continue; // Skip duplicate across groups
                                     const poolConfig = {
                                         address: validatedAddress, fee: feeTier, groupName: group.name,
                                         token0Symbol: group.token0Symbol, token1Symbol: group.token1Symbol
                                     };
                                     group.pools.push(poolConfig); totalPoolsLoaded++; loadedPoolAddresses.add(validatedAddress.toLowerCase());
                                 } else { logger.warn(`[Config] Invalid address format for ${envVarKey}. Skipping.`); }
                             }
                         }
                         logger.log(`[Config] Group ${group.name} processed with ${group.pools.length} pools.`);
                     } else { logger.warn(`[Config] No feeTierToEnvMap for group ${group.name}.`); }

                     // If group is still valid after all processing, add it to the final list
                     validProcessedPoolGroups.push(group);
                 } else {
                     // Log errors for the skipped group
                     logger.error(`[Config] Skipping POOL_GROUP ${group.name || `#${groupIndex}`} due to errors: ${errorMessages.join('; ')}`);
                 }

            } catch (groupError) {
                 logger.error(`[Config] Unexpected error processing POOL_GROUP ${group?.name || `#${groupIndex}`}: ${groupError.message}. Skipping.`);
            }
        }); // End forEach groupInput
    } // End else (rawPoolGroups valid)


    // --- Add the VALIDATED and PROCESSED pool groups to the final config ---
    baseConfig.POOL_GROUPS = validProcessedPoolGroups;
    logger.log(`[Config] Finished processing pool groups. Valid groups loaded: ${baseConfig.POOL_GROUPS.length}`);


    logger.log(`[Config] Total unique pools loaded from .env: ${loadedPoolAddresses.size}`);
    if (loadedPoolAddresses.size === 0) { console.warn("[Config] WARNING: No pool addresses were loaded from .env vars."); }

    // --- Add Helper Function & Log Dry Run ---
    baseConfig.getAllPoolConfigs = () => {
        if (!baseConfig.POOL_GROUPS) return [];
        return baseConfig.POOL_GROUPS.flatMap(group => group.pools || []);
    };
    if (baseConfig.DRY_RUN) { console.warn("[Config] --- DRY RUN MODE ENABLED ---"); } else { console.log("[Config] --- LIVE TRADING MODE ---"); }
    logger.debug('[loadConfig] Exiting loadConfig successfully.');
    return baseConfig; // Return the final assembled config
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
    console.error(`!!! Config Load Failed: ${error.message}`); // More specific message
    console.error("!!! Bot cannot start.");
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    process.exit(1);
}
module.exports = config;
console.log('[Config Top Level] module.exports reached.');
