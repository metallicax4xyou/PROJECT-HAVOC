// config/index.js
// Main configuration loader

require('dotenv').config(); // Load .env file first
const { ethers } = require('ethers');
const { Token } = require('@uniswap/sdk-core');
let logger; try { logger = require('../utils/logger'); } catch(e) { console.error("Failed to load logger!", e); logger = console; }

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
function validateAndNormalizeAddress(rawAddress, contextName) {
     const addressString = String(rawAddress || '').trim();
     if (!addressString) { return null; } // Allow empty for optional fields
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
function validatePrivateKey(rawKey, contextName) { /* ... implementation ... */ } // Assume correct
function validateRpcUrls(rawUrls, contextName) { /* ... implementation ... */ } // Assume correct
function safeParseBigInt(valueStr, contextName, defaultValue = 0n) { /* ... implementation ... */ }
function safeParseInt(valueStr, contextName, defaultValue = 0) { /* ... implementation ... */ }
function parseBoolean(valueStr) { /* ... implementation ... */ }
// --- End Validation Functions ---


// --- loadConfig Function ---
function loadConfig() {
    logger.debug('[DEBUG loadConfig] Starting loadConfig function...');
    const networkName = process.env.NETWORK?.toLowerCase();
    if (!networkName) { throw new Error(`[Config] CRITICAL: Missing NETWORK.`); }

    // Validate RPC & PK
    const rpcUrlsEnvKey = `${networkName.toUpperCase()}_RPC_URLS`;
    const validatedRpcUrls = validateRpcUrls(process.env[rpcUrlsEnvKey], rpcUrlsEnvKey);
    if (!validatedRpcUrls) { throw new Error(`[Config] CRITICAL: Invalid RPC URL(s) in ${rpcUrlsEnvKey}.`); }
    const validatedPrivateKey = validatePrivateKey(process.env.PRIVATE_KEY, 'PRIVATE_KEY');
    if (!validatedPrivateKey) { throw new Error(`[Config] CRITICAL: Invalid PRIVATE_KEY.`); }

    const networkMetadata = getNetworkMetadata(networkName);
    if (!networkMetadata) { throw new Error(`[Config] CRITICAL: No metadata for network: ${networkName}`); }

    let networkSpecificConfig;
    try { networkSpecificConfig = require(`./${networkName}.js`); logger.log(`[Config] Loaded network-specific config for ${networkName}.`); }
    catch (e) { throw new Error(`[Config] CRITICAL: Failed to load config/${networkName}.js: ${e.message}`); }

    const flashSwapEnvKey = `${networkName.toUpperCase()}_FLASH_SWAP_ADDRESS`;
    const validatedFlashSwapAddress = validateAndNormalizeAddress(process.env[flashSwapEnvKey], flashSwapEnvKey);
    if (!validatedFlashSwapAddress) { logger.warn(`[Config] WARNING: ${flashSwapEnvKey} not set or invalid. Defaulting to ZeroAddress.`); }

    // Load Global Settings
    const cycleIntervalMs = safeParseInt(process.env.CYCLE_INTERVAL_MS, 'CYCLE_INTERVAL_MS', 5000);
    const gasLimitEstimate = safeParseBigInt(process.env.GAS_LIMIT_ESTIMATE, 'GAS_LIMIT_ESTIMATE', 1500000n);
    const slippageToleranceBps = safeParseInt(process.env.SLIPPAGE_TOLERANCE_BPS, 'SLIPPAGE_TOLERANCE_BPS', 10);
    const isDryRun = parseBoolean(process.env.DRY_RUN);

    // Combine Config Object
    const combinedConfig = {
        ...networkMetadata, ...networkSpecificConfig, TOKENS: TOKENS,
        RPC_URLS: validatedRpcUrls, PRIMARY_RPC_URL: validatedRpcUrls[0], PRIVATE_KEY: validatedPrivateKey,
        FLASH_SWAP_CONTRACT_ADDRESS: validatedFlashSwapAddress || ethers.ZeroAddress,
        CYCLE_INTERVAL_MS: cycleIntervalMs, GAS_LIMIT_ESTIMATE: gasLimitEstimate,
        SLIPPAGE_TOLERANCE_BPS: slippageToleranceBps, DRY_RUN: isDryRun,
        FACTORY_ADDRESS: PROTOCOL_ADDRESSES.UNISWAP_V3_FACTORY, QUOTER_ADDRESS: PROTOCOL_ADDRESSES.QUOTER_V2,
        TICK_LENS_ADDRESS: PROTOCOL_ADDRESSES.TICK_LENS,
    };

    // --- Process POOL_GROUPS with Refined Error Handling ---
    let totalPoolsLoaded = 0;
    const loadedPoolAddresses = new Set();
    const validPoolGroups = []; // Build a new array of only valid groups

    if (!combinedConfig.POOL_GROUPS || !Array.isArray(combinedConfig.POOL_GROUPS)) {
        logger.warn('[Config] POOL_GROUPS array is missing or invalid.');
        // combinedConfig.POOL_GROUPS = []; // No need to assign back if we build validPoolGroups
    } else {
        logger.debug(`[DEBUG Config] Processing ${combinedConfig.POOL_GROUPS.length} POOL_GROUPS defined in ${networkName}.js`);
        combinedConfig.POOL_GROUPS.forEach((group, groupIndex) => {
            let currentGroupIsValid = true; // Flag for this specific group
            let errorMessages = []; // Collect errors for this group

            // Wrap checks in a try-catch to prevent one group error stopping all config loading
            try {
                if (!group || !group.name || !group.token0Symbol || !group.token1Symbol || !group.borrowTokenSymbol || typeof group.minNetProfit === 'undefined') {
                    errorMessages.push(`Group #${groupIndex}: Missing required fields.`);
                    currentGroupIsValid = false;
                }

                if (currentGroupIsValid) {
                    const groupName = group.name;
                    logger.debug(`[DEBUG Config] Processing Group: ${groupName}`);
                    group.token0 = combinedConfig.TOKENS[group.token0Symbol];
                    group.token1 = combinedConfig.TOKENS[group.token1Symbol];
                    group.borrowToken = combinedConfig.TOKENS[group.borrowTokenSymbol];

                    if (!(group.token0 instanceof Token) || !(group.token1 instanceof Token) || !(group.borrowToken instanceof Token)) {
                         errorMessages.push(`Group "${groupName}": Failed SDK Token lookup.`);
                         currentGroupIsValid = false;
                    } else {
                        group.sdkToken0 = group.token0; group.sdkToken1 = group.token1; group.sdkBorrowToken = group.borrowToken;
                        logger.debug(`[DEBUG Config] Assigned SDK tokens for group ${groupName}`);
                    }
                }

                if (currentGroupIsValid) {
                     const groupName = group.name;
                     const borrowAmountEnvKey = `BORROW_AMOUNT_${group.borrowTokenSymbol}`;
                     const rawBorrowAmount = process.env[borrowAmountEnvKey];
                     if (!rawBorrowAmount) {
                          errorMessages.push(`Group "${groupName}": Missing env var ${borrowAmountEnvKey}.`);
                          currentGroupIsValid = false;
                     } else {
                          try {
                               group.borrowAmount = ethers.parseUnits(rawBorrowAmount, group.borrowToken.decimals);
                               if (group.borrowAmount <= 0n) { throw new Error("must be positive"); }
                               logger.log(`[Config] Group ${groupName}: Borrow Amount set to ${rawBorrowAmount} ${group.borrowTokenSymbol}`);
                          } catch (e) {
                               errorMessages.push(`Group "${groupName}": Invalid borrow amount "${rawBorrowAmount}": ${e.message}`);
                               currentGroupIsValid = false;
                          }
                     }
                }

                if (currentGroupIsValid) {
                     const groupName = group.name;
                     group.minNetProfit = safeParseBigInt(group.minNetProfit, `Group ${groupName} minNetProfit`, 0n);
                     logger.log(`[Config] Group ${groupName}: Min Net Profit set to ${ethers.formatUnits(group.minNetProfit, 18)} ${combinedConfig.NATIVE_SYMBOL}`);
                }

                // Load Pools only if group is still valid
                if (currentGroupIsValid) {
                    group.pools = [];
                    if (group.feeTierToEnvMap && typeof group.feeTierToEnvMap === 'object') {
                        for (const feeTierStr in group.feeTierToEnvMap) {
                            // ... (pool loading logic - simplified for brevity) ...
                            const feeTier = parseInt(feeTierStr, 10); if (isNaN(feeTier)) continue;
                            const envVarKey = group.feeTierToEnvMap[feeTierStr]; const rawAddress = process.env[envVarKey];
                            if (rawAddress) {
                                const validatedAddress = validateAndNormalizeAddress(rawAddress, envVarKey);
                                if (validatedAddress) {
                                    if (loadedPoolAddresses.has(validatedAddress.toLowerCase())) continue;
                                    const poolConfig = { /* ... */ };
                                    group.pools.push(poolConfig); totalPoolsLoaded++; loadedPoolAddresses.add(validatedAddress.toLowerCase());
                                }
                            }
                        } // end for feeTierStr
                         logger.log(`[Config] Group ${group.name} initialized with ${group.pools.length} pools.`);
                    } else {
                         logger.warn(`[Config] Missing or invalid feeTierToEnvMap for group ${group.name}. No pools loaded.`);
                    }
                    // Add the successfully processed group to our valid list
                    validPoolGroups.push(group);
                } else {
                    // Log collected errors for the skipped group
                    logger.error(`[Config] Skipping POOL_GROUP entry #${groupIndex} due to errors: ${errorMessages.join('; ')}`);
                }

            } catch (groupError) {
                 // Catch any unexpected error during a specific group's processing
                 logger.error(`[Config] Unexpected error processing POOL_GROUP #${groupIndex} (${group?.name || 'N/A'}): ${groupError.message}. Skipping group.`);
                 // Do not add the group if an unexpected error occurred
            }
        }); // End forEach POOL_GROUP

        // Replace original POOL_GROUPS with only the valid ones
        combinedConfig.POOL_GROUPS = validPoolGroups;
    } // End else POOL_GROUPS exists

    console.log(`[Config] Total unique pools loaded from .env: ${loadedPoolAddresses.size}`);
    if (loadedPoolAddresses.size === 0) { console.warn("[Config] WARNING: No pool addresses were successfully loaded from .env variables."); }

    // Add Helper Function & Log Dry Run (remain same)
    combinedConfig.getAllPoolConfigs = () => { /*...*/ };
    if (combinedConfig.DRY_RUN) { console.warn(/*...*/); } else { console.log(/*...*/); }
    logger.debug('[DEBUG loadConfig] Exiting loadConfig function successfully.');
    return combinedConfig;
}

// --- Load and Export Config --- (remain same)
let config;
console.log('[Config] Attempting to call loadConfig inside try block...');
try { config = loadConfig(); console.log(`[Config] Configuration loaded successfully for network: ${config.NAME} (Chain ID: ${config.CHAIN_ID})`); }
catch (error) { console.error(/*...*/); process.exit(1); }
module.exports = config;
