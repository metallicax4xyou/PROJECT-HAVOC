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

// --- Validation Functions --- (Assume these are defined correctly above as before)
function validateAndNormalizeAddress(rawAddress, contextName) { /* ... implementation ... */ }
function validatePrivateKey(rawKey, contextName) { /* ... implementation ... */ }
function validateRpcUrls(rawUrls, contextName) { /* ... implementation ... */ }
function safeParseBigInt(valueStr, contextName, defaultValue = 0n) { /* ... implementation ... */ }
function safeParseInt(valueStr, contextName, defaultValue = 0) { /* ... implementation ... */ }
function parseBoolean(valueStr) { /* ... implementation ... */ }
// --- End Validation Functions ---


// --- loadConfig Function ---
function loadConfig() {
    const networkName = process.env.NETWORK?.toLowerCase();
    if (!networkName) { throw new Error(`[Config] CRITICAL: Missing NETWORK environment variable.`); }
    const networkMetadata = getNetworkMetadata(networkName);
    if (!networkMetadata) { throw new Error(`[Config] CRITICAL: No network metadata found for network: ${networkName}`); }

    let networkSpecificConfig;
    try {
        networkSpecificConfig = require(`./${networkName}.js`);
        console.log(`[Config] Loaded network-specific config for ${networkName}.`);
    } catch (e) { throw new Error(`[Config] CRITICAL: Failed to load configuration file for network "${networkName}": ${e.message}`); }

    // Validate Required Env Vars
    const rpcUrlsEnvKey = `${networkName.toUpperCase()}_RPC_URLS`;
    const validatedRpcUrls = validateRpcUrls(process.env[rpcUrlsEnvKey], rpcUrlsEnvKey);
    if (!validatedRpcUrls) { throw new Error(`[Config] CRITICAL: Missing or invalid RPC URL(s) in ${rpcUrlsEnvKey}.`); }

    const validatedPrivateKey = validatePrivateKey(process.env.PRIVATE_KEY, 'PRIVATE_KEY');
    if (!validatedPrivateKey) { throw new Error(`[Config] CRITICAL: Missing or invalid PRIVATE_KEY.`); }

    const flashSwapEnvKey = `${networkName.toUpperCase()}_FLASH_SWAP_ADDRESS`;
    const validatedFlashSwapAddress = validateAndNormalizeAddress(process.env[flashSwapEnvKey], flashSwapEnvKey);
    if (!validatedFlashSwapAddress) { console.warn(`[Config] WARNING: ${flashSwapEnvKey} not set or invalid. Defaulting to ZeroAddress.`); }

    // Load Global Settings
    const cycleIntervalMs = safeParseInt(process.env.CYCLE_INTERVAL_MS, 'CYCLE_INTERVAL_MS', 5000);
    const gasLimitEstimate = safeParseBigInt(process.env.GAS_LIMIT_ESTIMATE, 'GAS_LIMIT_ESTIMATE', 1500000n);
    const slippageToleranceBps = safeParseInt(process.env.SLIPPAGE_TOLERANCE_BPS, 'SLIPPAGE_TOLERANCE_BPS', 10);
    const isDryRun = parseBoolean(process.env.DRY_RUN);

    // Combine config elements
    const combinedConfig = {
        ...networkMetadata,
        ...networkSpecificConfig,
        TOKENS: TOKENS, // Use SDK Token instances from constants/tokens.js
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
        // --- ADDED TICK LENS ADDRESS ---
        TICK_LENS_ADDRESS: PROTOCOL_ADDRESSES.TICK_LENS,
    };

    // Process POOL_GROUPS (enrich with data, validate pools from env)
    let totalPoolsLoaded = 0;
    const loadedPoolAddresses = new Set();
    if (!combinedConfig.POOL_GROUPS || !Array.isArray(combinedConfig.POOL_GROUPS)) {
        console.warn('[Config] POOL_GROUPS array is missing or invalid.'); combinedConfig.POOL_GROUPS = [];
    } else {
        console.log(`[DEBUG Config] Processing ${combinedConfig.POOL_GROUPS.length} POOL_GROUPS defined in ${networkName}.js`);
        combinedConfig.POOL_GROUPS.forEach((group, groupIndex) => {
             if (!group || !group.name || !group.token0Symbol || !group.token1Symbol || !group.borrowTokenSymbol || typeof group.minNetProfit === 'undefined') {
                 console.error(`[Config] Skipping invalid POOL_GROUP entry #${groupIndex}: Missing required fields.`); combinedConfig.POOL_GROUPS[groupIndex] = null; return;
             }
             const groupName = group.name;
             console.log(`[DEBUG Config] Processing Group: ${groupName}`);
             group.token0 = combinedConfig.TOKENS[group.token0Symbol]; group.token1 = combinedConfig.TOKENS[group.token1Symbol]; group.borrowToken = combinedConfig.TOKENS[group.borrowTokenSymbol];
             // --- DEBUG LOGS from previous step (can be removed later if desired) ---
             console.log(`[DEBUG Config] Lookup Result for ${group.token0Symbol}:`, group.token0 ? `Type: ${typeof group.token0}, IsTokenInstance: ${group.token0 instanceof Token}` : 'Not Found');
             console.log(`[DEBUG Config] Lookup Result for ${group.token1Symbol}:`, group.token1 ? `Type: ${typeof group.token1}, IsTokenInstance: ${group.token1 instanceof Token}` : 'Not Found');
             console.log(`[DEBUG Config] Lookup Result for ${group.borrowTokenSymbol}:`, group.borrowToken ? `Type: ${typeof group.borrowToken}, IsTokenInstance: ${group.borrowToken instanceof Token}` : 'Not Found');
             // --- ---
             if (!(group.token0 instanceof Token) || !(group.token1 instanceof Token) || !(group.borrowToken instanceof Token)) {
                  console.error(`[Config] Skipping POOL_GROUP "${groupName}": Failed to find valid SDK Token instances.`); combinedConfig.POOL_GROUPS[groupIndex] = null; return;
             }
             group.sdkToken0 = group.token0; group.sdkToken1 = group.token1; group.sdkBorrowToken = group.borrowToken;
             console.log(`[DEBUG Config] Successfully assigned SDK tokens for group ${groupName}`);
             const borrowAmountEnvKey = `BORROW_AMOUNT_${group.borrowTokenSymbol}`;
             const rawBorrowAmount = process.env[borrowAmountEnvKey];
             if (!rawBorrowAmount) { console.error(`[Config] Skipping POOL_GROUP "${groupName}": Missing env var ${borrowAmountEnvKey}.`); combinedConfig.POOL_GROUPS[groupIndex] = null; return; }
             try {
                  group.borrowAmount = ethers.parseUnits(rawBorrowAmount, group.borrowToken.decimals);
                  if (group.borrowAmount <= 0n) { throw new Error("Borrow amount must be positive."); }
                  console.log(`[Config] Group ${groupName}: Borrow Amount set to ${rawBorrowAmount} ${group.borrowTokenSymbol} (${group.borrowAmount} smallest units)`);
             } catch (e) { console.error(`[Config] Skipping POOL_GROUP "${groupName}": Invalid borrow amount "${rawBorrowAmount}". Error: ${e.message}`); combinedConfig.POOL_GROUPS[groupIndex] = null; return; }
             group.minNetProfit = safeParseBigInt(group.minNetProfit, `Group ${groupName} minNetProfit`, 0n);
             console.log(`[Config] Group ${groupName}: Min Net Profit set to ${ethers.formatUnits(group.minNetProfit, 18)} ${combinedConfig.NATIVE_SYMBOL} (Wei: ${group.minNetProfit})`);
             group.pools = [];
             if (group.feeTierToEnvMap && typeof group.feeTierToEnvMap === 'object') {
                 for (const feeTierStr in group.feeTierToEnvMap) {
                     const feeTier = parseInt(feeTierStr, 10);
                     if (isNaN(feeTier)) { console.warn(`[Config] Invalid fee tier key "${feeTierStr}" for group ${groupName}.`); continue; }
                     const envVarKey = group.feeTierToEnvMap[feeTierStr]; const rawAddress = process.env[envVarKey];
                     if (rawAddress) {
                         const validatedAddress = validateAndNormalizeAddress(rawAddress, envVarKey);
                         if (validatedAddress) {
                             if (loadedPoolAddresses.has(validatedAddress.toLowerCase())) { console.warn(`[Config] Skipping duplicate pool address ${validatedAddress} from ${envVarKey}.`); continue; }
                             const poolConfig = { address: validatedAddress, fee: feeTier, groupName: group.name, token0Symbol: group.token0Symbol, token1Symbol: group.token1Symbol };
                             group.pools.push(poolConfig); totalPoolsLoaded++; loadedPoolAddresses.add(validatedAddress.toLowerCase());
                         } else { console.warn(`[Config] Invalid address format for pool ${envVarKey} in group ${groupName}. Skipping.`); }
                     }
                 }
             } else { console.warn(`[Config] Missing or invalid feeTierToEnvMap for group ${groupName}.`); }
             console.log(`[Config] Group ${groupName} initialized with ${group.pools.length} pools.`);
        });
        combinedConfig.POOL_GROUPS = combinedConfig.POOL_GROUPS.filter(group => group !== null);
    }

    console.log(`[Config] Total unique pools loaded from .env: ${loadedPoolAddresses.size}`);
    if (loadedPoolAddresses.size === 0) { console.warn("[Config] WARNING: No pool addresses were successfully loaded."); }

    // Add Helper Function
    combinedConfig.getAllPoolConfigs = () => {
        if (!combinedConfig.POOL_GROUPS) return [];
        return combinedConfig.POOL_GROUPS.flatMap(group => group.pools || []);
    };

    // Log Dry Run Status
    if (combinedConfig.DRY_RUN) { console.warn("[Config] --- DRY RUN MODE ENABLED ---"); } else { console.log("[Config] --- LIVE TRADING MODE ---"); }

    return combinedConfig;
}

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
    process.exit(1);
}

module.exports = config; // Export the loaded config object directly
