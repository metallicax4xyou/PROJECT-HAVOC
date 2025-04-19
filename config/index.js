// config/index.js
// Main configuration loader

require('dotenv').config(); // Load .env file first
const { ethers } = require('ethers');
const { Token } = require('@uniswap/sdk-core'); // For creating Token objects

// --- Load Network Metadata Helper (Simplified) ---
function getNetworkMetadata(networkName) {
    const lowerName = networkName?.toLowerCase();
    if (lowerName === 'arbitrum') {
        return {
            CHAIN_ID: 42161,
            NAME: 'arbitrum',
            NATIVE_SYMBOL: 'ETH', // Native token symbol
            NATIVE_DECIMALS: 18, // Native token decimals
        };
    }
    // Add other networks here if needed later
    return null;
}

// --- Load Shared Protocol Addresses ---
const { PROTOCOL_ADDRESSES } = require('../constants/addresses');
// --- Load SDK Token Instances ---
const { TOKENS } = require('../constants/tokens'); // Import the exported TOKENS map

// --- Validation Functions (Migrated from utils/config.js) ---

/**
 * Validates and normalizes an Ethereum address string.
 * @param {string} rawAddress The raw address string from env or config.
 * @param {string} contextName Name of the variable/context for logging.
 * @returns {string|null} Checksummed address or null if invalid.
 */
function validateAndNormalizeAddress(rawAddress, contextName) {
    const addressString = String(rawAddress || '').trim();
    if (!addressString) {
        // Allow empty address if it's optional (like flash swap address initially)
        // console.warn(`[Config Validate] ${contextName}: Address is empty or null.`);
        return null;
    }
    try {
        const cleanAddress = addressString.replace(/^['"]+|['"]+$/g, ''); // Remove potential quotes

        if (!ethers.isAddress(cleanAddress)) {
            console.warn(`[Config Validate] ${contextName}: Invalid address format "${cleanAddress}" (Failed ethers.isAddress()).`);
            return null;
        }
        // Return the checksummed address
        return ethers.getAddress(cleanAddress);
    } catch (error) {
        console.warn(`[Config Validate] ${contextName}: Unexpected validation error for raw value "${rawAddress}" - ${error.message}`);
        return null;
    }
}

/**
 * Validates a private key string.
 * @param {string} rawKey Raw private key string.
 * @param {string} contextName Name for logging.
 * @returns {string|null} Validated private key (without 0x) or null if invalid.
 */
function validatePrivateKey(rawKey, contextName) {
    const keyString = String(rawKey || '').trim().replace(/^0x/, ''); // Remove 0x prefix if present
    if (!keyString) {
        console.error(`[Config Validate] CRITICAL ${contextName}: Private key is empty.`);
        return null;
    }
    // Basic check: 64 hex characters
    if (!/^[a-fA-F0-9]{64}$/.test(keyString)) {
        console.error(`[Config Validate] CRITICAL ${contextName}: Invalid format. Must be 64 hexadecimal characters (without '0x' prefix). Length found: ${keyString.length}`);
        return null;
    }
    return keyString;
}

/**
 * Validates RPC URL(s) string.
 * @param {string} rawUrls Raw RPC URL string (potentially comma-separated).
 * @param {string} contextName Name for logging.
 * @returns {string[]|null} Array of valid, trimmed URLs or null if none are valid.
 */
function validateRpcUrls(rawUrls, contextName) {
    const urlsString = String(rawUrls || '').trim();
    if (!urlsString) {
        console.error(`[Config Validate] CRITICAL ${contextName}: RPC URL(s) string is empty.`);
        return null;
    }
    const urls = urlsString.split(',')
        .map(url => url.trim())
        .filter(url => {
            if (!url) return false;
            // Basic URL format check
            if (!/^(https?|wss?):\/\/.+/i.test(url)) {
                 console.warn(`[Config Validate] ${contextName}: Invalid URL format skipped: "${url}"`);
                 return false;
            }
            return true;
        });

    if (urls.length === 0) {
        console.error(`[Config Validate] CRITICAL ${contextName}: No valid RPC URLs found after parsing "${urlsString}".`);
        return null;
    }
    return urls;
}

/**
 * Parses a string into a BigInt, handling potential errors.
 * @param {string} valueStr String to parse.
 * @param {string} contextName Name for logging.
 * @param {bigint} defaultValue Default value if parsing fails or input is invalid.
 * @returns {bigint} Parsed BigInt or default value.
 */
function safeParseBigInt(valueStr, contextName, defaultValue = 0n) {
    const str = String(valueStr || '').trim();
    if (!str) return defaultValue;
    try {
        // Ensure it doesn't contain decimals before converting
        if (str.includes('.')) {
            throw new Error("BigInt string cannot contain decimals.");
        }
        return BigInt(str);
    } catch (e) {
        console.warn(`[Config Parse] ${contextName}: Failed to parse "${str}" as BigInt. Using default ${defaultValue}. Error: ${e.message}`);
        return defaultValue;
    }
}

/**
 * Parses a string into an integer, handling potential errors.
 * @param {string} valueStr String to parse.
 * @param {string} contextName Name for logging.
 * @param {number} defaultValue Default value if parsing fails or input is invalid.
 * @returns {number} Parsed integer or default value.
 */
function safeParseInt(valueStr, contextName, defaultValue = 0) {
     const str = String(valueStr || '').trim();
     if (!str) return defaultValue;
     const num = parseInt(str, 10);
     if (isNaN(num) || str !== num.toString()) { // Added check to ensure it parsed cleanly
          console.warn(`[Config Parse] ${contextName}: Failed to parse "${str}" as integer. Using default ${defaultValue}.`);
          return defaultValue;
     }
     return num;
}

/**
 * Parses a string into a boolean. Treats 'false' (case-insensitive) as false, everything else as true if present.
 * @param {string} valueStr String to parse.
 * @returns {boolean} Parsed boolean. Defaults to true if value exists and is not 'false'.
 */
function parseBoolean(valueStr) {
    const str = String(valueStr || '').trim().toLowerCase();
    // Default to TRUE unless explicitly 'false'
    return (str !== 'false');
}
// --- End Validation Functions ---


// --- Updated loadConfig Function ---
function loadConfig() {
    const networkName = process.env.NETWORK?.toLowerCase();
    if (!networkName) {
        throw new Error(`[Config] CRITICAL: Missing NETWORK environment variable.`);
    }

    // 1. Load base network metadata
    const networkMetadata = getNetworkMetadata(networkName);
    if (!networkMetadata) {
        throw new Error(`[Config] CRITICAL: No network metadata found for network: ${networkName}`);
    }

    // 2. Load network-specific config file (e.g., config/arbitrum.js)
    let networkSpecificConfig;
    try {
        // This file defines POOL_GROUPS structure, CHAINLINK_FEEDS, etc.
        networkSpecificConfig = require(`./${networkName}.js`);
        console.log(`[Config] Loaded network-specific config for ${networkName}.`);
    } catch (e) {
        throw new Error(`[Config] CRITICAL: Failed to load configuration file for network "${networkName}": ${e.message}`);
    }

    // 3. Validate Required Environment Variables
    const rpcUrlsEnvKey = `${networkName.toUpperCase()}_RPC_URLS`;
    const rawRpcUrls = process.env[rpcUrlsEnvKey];
    const validatedRpcUrls = validateRpcUrls(rawRpcUrls, rpcUrlsEnvKey);
    if (!validatedRpcUrls) { throw new Error(`[Config] CRITICAL: Missing or invalid RPC URL(s) in environment variable ${rpcUrlsEnvKey}.`); }

    const rawPrivateKey = process.env.PRIVATE_KEY;
    const validatedPrivateKey = validatePrivateKey(rawPrivateKey, 'PRIVATE_KEY');
    if (!validatedPrivateKey) { throw new Error(`[Config] CRITICAL: Missing or invalid PRIVATE_KEY in environment variable.`); }

    const flashSwapEnvKey = `${networkName.toUpperCase()}_FLASH_SWAP_ADDRESS`;
    const rawFlashSwapAddress = process.env[flashSwapEnvKey];
    const validatedFlashSwapAddress = validateAndNormalizeAddress(rawFlashSwapAddress, flashSwapEnvKey);
    if (!validatedFlashSwapAddress) { console.warn(`[Config] WARNING: ${flashSwapEnvKey} not set or invalid in environment. FlashSwap calls will fail. Defaulting to ZeroAddress.`); }


    // 4. Load Global Settings from .env or Defaults
    const cycleIntervalMs = safeParseInt(process.env.CYCLE_INTERVAL_MS, 'CYCLE_INTERVAL_MS', 5000);
    const gasLimitEstimate = safeParseBigInt(process.env.GAS_LIMIT_ESTIMATE, 'GAS_LIMIT_ESTIMATE', 1500000n);
    const slippageToleranceBps = safeParseInt(process.env.SLIPPAGE_TOLERANCE_BPS, 'SLIPPAGE_TOLERANCE_BPS', 10);
    const isDryRun = parseBoolean(process.env.DRY_RUN);


    // 5. Combine config elements
    const combinedConfig = {
        ...networkMetadata,           // CHAIN_ID, NAME, NATIVE_SYMBOL, etc.
        ...networkSpecificConfig,     // POOL_GROUPS, CHAINLINK_FEEDS from arbitrum.js etc.

        // Use the TOKENS object directly from constants/tokens.js
        TOKENS: TOKENS, // This object contains SDK Token instances

        // Validated critical env vars
        RPC_URLS: validatedRpcUrls,
        PRIMARY_RPC_URL: validatedRpcUrls[0],
        PRIVATE_KEY: validatedPrivateKey,
        FLASH_SWAP_CONTRACT_ADDRESS: validatedFlashSwapAddress || ethers.ZeroAddress,

        // Global settings
        CYCLE_INTERVAL_MS: cycleIntervalMs,
        GAS_LIMIT_ESTIMATE: gasLimitEstimate,
        SLIPPAGE_TOLERANCE_BPS: slippageToleranceBps,
        DRY_RUN: isDryRun,

        // Protocol Addresses
        FACTORY_ADDRESS: PROTOCOL_ADDRESSES.UNISWAP_V3_FACTORY,
        QUOTER_ADDRESS: PROTOCOL_ADDRESSES.QUOTER_V2,
    };

    // 6. Process POOL_GROUPS (enrich with data, validate pools from env)
    let totalPoolsLoaded = 0;
    const loadedPoolAddresses = new Set();

    if (!combinedConfig.POOL_GROUPS || !Array.isArray(combinedConfig.POOL_GROUPS)) {
        console.warn('[Config] POOL_GROUPS array is missing or invalid in network config.');
        combinedConfig.POOL_GROUPS = [];
    } else {
        console.log(`[DEBUG Config] Processing ${combinedConfig.POOL_GROUPS.length} POOL_GROUPS defined in ${networkName}.js`); // DEBUG
        combinedConfig.POOL_GROUPS.forEach((group, groupIndex) => {
            // Basic structure validation
            if (!group || !group.name || !group.token0Symbol || !group.token1Symbol || !group.borrowTokenSymbol || typeof group.minNetProfit === 'undefined') {
                console.error(`[Config] Skipping invalid POOL_GROUP entry #${groupIndex}: Missing required fields (name, token0Symbol, token1Symbol, borrowTokenSymbol, minNetProfit). Entry:`, group);
                combinedConfig.POOL_GROUPS[groupIndex] = null; // Mark as invalid
                return;
            }
            const groupName = group.name; // For logging
            console.log(`[DEBUG Config] Processing Group: ${groupName}`); // DEBUG

            // Look up SDK Token instances from combinedConfig.TOKENS
            console.log(`[DEBUG Config] Attempting token lookup for: ${group.token0Symbol}, ${group.token1Symbol}, ${group.borrowTokenSymbol}`); // DEBUG
            group.token0 = combinedConfig.TOKENS[group.token0Symbol];
            group.token1 = combinedConfig.TOKENS[group.token1Symbol];
            group.borrowToken = combinedConfig.TOKENS[group.borrowTokenSymbol];

            // --- ADDED DETAILED DEBUG LOGS ---
            console.log(`[DEBUG Config] Lookup Result for ${group.token0Symbol}:`, group.token0 ? `Type: ${typeof group.token0}, IsTokenInstance: ${group.token0 instanceof Token}` : 'Not Found');
            console.log(`[DEBUG Config] Lookup Result for ${group.token1Symbol}:`, group.token1 ? `Type: ${typeof group.token1}, IsTokenInstance: ${group.token1 instanceof Token}` : 'Not Found');
            console.log(`[DEBUG Config] Lookup Result for ${group.borrowTokenSymbol}:`, group.borrowToken ? `Type: ${typeof group.borrowToken}, IsTokenInstance: ${group.borrowToken instanceof Token}` : 'Not Found');
            // --- END DETAILED DEBUG LOGS ---

            // Now check if the lookup result is actually an SDK Token instance
            if (!(group.token0 instanceof Token) || !(group.token1 instanceof Token) || !(group.borrowToken instanceof Token)) {
                 console.error(`[Config] Skipping POOL_GROUP "${groupName}": Failed to find valid SDK Token instances for symbols. Check constants/tokens.js and group definition in config/${networkName}.js.`);
                 combinedConfig.POOL_GROUPS[groupIndex] = null; return;
            }

            // Assign SDK Tokens directly now that they are validated instances
            group.sdkToken0 = group.token0;
            group.sdkToken1 = group.token1;
            group.sdkBorrowToken = group.borrowToken;
            console.log(`[DEBUG Config] Successfully assigned SDK tokens for group ${groupName}`); // DEBUG

            // Assign borrow amount
            const borrowAmountEnvKey = `BORROW_AMOUNT_${group.borrowTokenSymbol}`;
            const rawBorrowAmount = process.env[borrowAmountEnvKey];
            if (!rawBorrowAmount) {
                 console.error(`[Config] Skipping POOL_GROUP "${groupName}": Missing required environment variable ${borrowAmountEnvKey}.`);
                 combinedConfig.POOL_GROUPS[groupIndex] = null; return;
            }
            try {
                 // Use parseUnits based on the borrow token's decimals
                 group.borrowAmount = ethers.parseUnits(rawBorrowAmount, group.borrowToken.decimals);
                 if (group.borrowAmount <= 0n) { throw new Error("Borrow amount must be positive."); }
                 console.log(`[Config] Group ${groupName}: Borrow Amount set to ${rawBorrowAmount} ${group.borrowTokenSymbol} (${group.borrowAmount} smallest units)`);
            } catch (e) {
                 console.error(`[Config] Skipping POOL_GROUP "${groupName}": Invalid borrow amount format in ${borrowAmountEnvKey}="${rawBorrowAmount}". Error: ${e.message}`);
                 combinedConfig.POOL_GROUPS[groupIndex] = null; return;
            }

            // Assign minNetProfit (convert string from config to BigInt, expect Wei)
            group.minNetProfit = safeParseBigInt(group.minNetProfit, `Group ${groupName} minNetProfit`, 0n);
            console.log(`[Config] Group ${groupName}: Min Net Profit set to ${ethers.formatUnits(group.minNetProfit, 18)} ${combinedConfig.NATIVE_SYMBOL} (Wei: ${group.minNetProfit})`);

            // Validate and load pool addresses for this group using feeTierToEnvMap
            group.pools = []; // Initialize pools array for the group
            if (group.feeTierToEnvMap && typeof group.feeTierToEnvMap === 'object') {
                for (const feeTierStr in group.feeTierToEnvMap) {
                    const feeTier = parseInt(feeTierStr, 10);
                    if (isNaN(feeTier)) {
                         console.warn(`[Config] Invalid fee tier key "${feeTierStr}" in feeTierToEnvMap for group ${groupName}. Skipping.`);
                         continue;
                    }

                    const envVarKey = group.feeTierToEnvMap[feeTierStr];
                    const rawAddress = process.env[envVarKey];

                    if (rawAddress) {
                        const validatedAddress = validateAndNormalizeAddress(rawAddress, envVarKey);
                        if (validatedAddress) {
                            // Prevent adding duplicate pool addresses across all groups
                            if (loadedPoolAddresses.has(validatedAddress.toLowerCase())) {
                                 console.warn(`[Config] Skipping duplicate pool address ${validatedAddress} (defined in ${envVarKey} for group ${groupName}) as it was loaded previously.`);
                                 continue;
                            }

                            const poolConfig = {
                                address: validatedAddress,
                                fee: feeTier, // Store fee tier (e.g., 500, 3000)
                                groupName: group.name, // Link back to the group
                                token0Symbol: group.token0Symbol, // Add symbols for scanner
                                token1Symbol: group.token1Symbol, // Add symbols for scanner
                            };
                            group.pools.push(poolConfig); // Add validated pool config
                            totalPoolsLoaded++;
                            loadedPoolAddresses.add(validatedAddress.toLowerCase());
                        } else {
                            console.warn(`[Config] Invalid address format for pool ${envVarKey} in group ${groupName}. Skipping pool.`);
                        }
                    } else {
                         // Optional: Log if an expected env var is missing
                         // console.debug(`[Config] Optional: Env variable ${envVarKey} for group ${group.name} not found.`);
                    }
                }
            } else {
                 console.warn(`[Config] Missing or invalid feeTierToEnvMap for group ${groupName}. No pools loaded for this group.`);
            }
            console.log(`[Config] Group ${groupName} initialized with ${group.pools.length} pools.`);
        }); // End forEach POOL_GROUP

        // Filter out any groups that were marked as invalid
        combinedConfig.POOL_GROUPS = combinedConfig.POOL_GROUPS.filter(group => group !== null);
    } // End else (POOL_GROUPS exists)


    console.log(`[Config] Total unique pools loaded from .env: ${loadedPoolAddresses.size}`);
    if (loadedPoolAddresses.size === 0) {
        console.warn("[Config] WARNING: No pool addresses were successfully loaded from .env variables. Bot cannot scan pools.");
    }

    // 7. Add Helper Function to Extract All Pool Configs
    combinedConfig.getAllPoolConfigs = () => {
        if (!combinedConfig.POOL_GROUPS || !Array.isArray(combinedConfig.POOL_GROUPS)) { return []; }
        // Use flatMap to get all 'pools' arrays from each valid group and concatenate them
        return combinedConfig.POOL_GROUPS.flatMap(group => group.pools || []);
    };

    // 8. Log Dry Run Status
    if (combinedConfig.DRY_RUN) {
        console.warn("[Config] --- DRY RUN MODE ENABLED --- Transactions will NOT be sent.");
    } else {
        console.log("[Config] --- LIVE TRADING MODE --- Transactions WILL be sent.");
    }

    return combinedConfig;
} // End loadConfig function


// --- Load and Export Config ---
let config;
try {
    config = loadConfig();
    console.log(`[Config] Configuration loaded successfully for network: ${config.NAME} (Chain ID: ${config.CHAIN_ID})`);
} catch (error) {
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    console.error("!!! FATAL CONFIGURATION ERROR !!!");
    console.error(`!!! ${error.message}`);
    console.error("!!! Bot cannot start. Please check your .env file and config files.");
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    process.exit(1); // Exit the process if config loading fails
}

// Export the loaded config object directly
module.exports = config;
