// config/index.js
// Main configuration loader - Includes MIN_LIQUIDITY_REQUIREMENTS

require('dotenv').config(); // Load .env file first
const { ethers } = require('ethers');
const { Token } = require('@uniswap/sdk-core'); // For creating Token objects

const { getNetworkMetadata } = require('./networks');
const { PROTOCOL_ADDRESSES } = require('../constants/addresses');

// --- Global Settings & Defaults ---
// NOTE: MIN_NET_PROFIT_WEI defined here might be superseded by the per-group config in arbitrum.js for the new profit calc logic
const MIN_NET_PROFIT_WEI = {
    WETH: ethers.parseUnits(process.env.MIN_PROFIT_WETH || '0.0005', 18),
    USDC: ethers.parseUnits(process.env.MIN_PROFIT_USDC || '1', 6),
    USDT: ethers.parseUnits(process.env.MIN_PROFIT_USDT || '1', 6),
};
const FLASH_LOAN_FEE_BPS = parseInt(process.env.FLASH_LOAN_FEE_BPS || '9', 10);
const GAS_LIMIT_ESTIMATE = BigInt(process.env.GAS_LIMIT_ESTIMATE || '1000000'); // Used as fallback if specific estimate fails
const BORROW_AMOUNTS_WEI = {
    WETH: ethers.parseUnits(process.env.BORROW_AMOUNT_WETH || '0.1', 18), // Renamed env var for clarity? Ensure this matches .env
    USDC: ethers.parseUnits(process.env.BORROW_AMOUNT_USDC || '100', 6),  // Renamed env var for clarity? Ensure this matches .env
    USDT: ethers.parseUnits(process.env.BORROW_AMOUNT_USDT || '100', 6),  // Renamed env var for clarity? Ensure this matches .env
};
const SLIPPAGE_TOLERANCE_BPS = parseInt(process.env.SLIPPAGE_TOLERANCE_BPS || '10', 10); // 0.1%
const MIN_LIQUIDITY_REQUIREMENTS = {
    WETH_USDC: { MIN_RAW_LIQUIDITY: BigInt(process.env.MIN_LIQ_WETH_USDC_RAW || '10000000000000000') },
    USDC_USDT: { MIN_RAW_LIQUIDITY: BigInt(process.env.MIN_LIQ_USDC_USDT_RAW || '1000000000000000') }
};
const CYCLE_INTERVAL_MS = parseInt(process.env.CYCLE_INTERVAL_MS || '5000', 10); // Default 5 seconds


// --- Address Validation Function ---
function validateAndNormalizeAddress(rawAddress, envVarName) {
    const addressString = String(rawAddress || '').trim();
    if (!addressString) {
        return null; // Allow empty/null if optional
    }
    try {
        // Basic cleaning: remove potential quotes and non-hex characters (except x)
        const cleanAddress = addressString.replace(/^['"]+|['"]+$/g, '').replace(/[^a-zA-Z0-9x]/g, '');

        // Basic checks before passing to ethers
        if (!cleanAddress.startsWith('0x')) {
            console.warn(`[Config] Validation FAILED for ${envVarName} ("${cleanAddress}"): Missing 0x prefix.`);
            return null;
        }
        if (cleanAddress.length !== 42) {
            console.warn(`[Config] Validation FAILED for ${envVarName} ("${cleanAddress}"): Invalid length (${cleanAddress.length} chars).`);
            return null;
        }
        // Final check using ethers
        if (!ethers.isAddress(cleanAddress)) {
            // This check is robust and handles checksums
            console.warn(`[Config] Validation FAILED for ${envVarName} ("${cleanAddress}"): Failed ethers.isAddress() check (likely invalid hex or checksum).`);
            return null;
        }
        // Return the checksummed address
        return ethers.getAddress(cleanAddress);
    } catch (error) {
        // Catch any unexpected errors during validation
        console.warn(`[Config] ${envVarName}: Unexpected validation error for raw value "${rawAddress}" - ${error.message}`);
        return null;
    }
}


// --- Config Loading Function ---
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

    // 2. Load network-specific config file
    let networkSpecificConfig;
    try {
        networkSpecificConfig = require(`./${networkName}.js`);
        console.log(`[Config] Loaded network-specific config for ${networkName}.`);
    } catch (e) {
        throw new Error(`[Config] CRITICAL: Failed to load configuration file for network "${networkName}": ${e.message}`);
    }

    // 3. Combine config elements
    const combinedConfig = {
        ...networkMetadata, // Includes CHAIN_ID, NAME, NATIVE_SYMBOL, NATIVE_DECIMALS etc.
        ...networkSpecificConfig, // Includes TOKENS, POOL_GROUPS, CHAINLINK_FEEDS etc.
        // Add global constants/addresses
        FACTORY_ADDRESS: PROTOCOL_ADDRESSES.UNISWAP_V3_FACTORY,
        QUOTER_ADDRESS: PROTOCOL_ADDRESSES.QUOTER_V2, // Assuming V2 Quoter usage elsewhere
        // Add global settings from .env or defaults
        FLASH_LOAN_FEE_BPS: FLASH_LOAN_FEE_BPS,
        GAS_LIMIT_ESTIMATE: GAS_LIMIT_ESTIMATE, // Fallback gas limit
        SLIPPAGE_TOLERANCE_BPS: SLIPPAGE_TOLERANCE_BPS,
        // Note: MIN_NET_PROFIT_WEI and BORROW_AMOUNTS_WEI are handled per-group below
        MIN_LIQUIDITY_REQUIREMENTS: MIN_LIQUIDITY_REQUIREMENTS, // Global liquidity settings
        CYCLE_INTERVAL_MS: CYCLE_INTERVAL_MS, // Bot loop interval
    };

    // 4. Process POOL_GROUPS (enrich with data)
    let totalPoolsLoaded = 0;
    if (!combinedConfig.POOL_GROUPS || !Array.isArray(combinedConfig.POOL_GROUPS)) {
        console.warn('[Config] POOL_GROUPS array is missing or invalid in network config. Bot may not find pools.');
        combinedConfig.POOL_GROUPS = []; // Ensure it's an array to prevent downstream errors
    } else {
        combinedConfig.POOL_GROUPS.forEach(group => {
            // Validate required group fields
            if (!group.name || !group.token0Symbol || !group.token1Symbol || !group.borrowTokenSymbol) {
                console.error(`[Config] Skipping invalid POOL_GROUP entry: Missing required fields (name, token0Symbol, token1Symbol, borrowTokenSymbol). Entry:`, group);
                return; // Skip this invalid group
            }

            // Look up tokens from the TOKENS list
            group.token0 = combinedConfig.TOKENS[group.token0Symbol];
            group.token1 = combinedConfig.TOKENS[group.token1Symbol];
            group.borrowToken = combinedConfig.TOKENS[group.borrowTokenSymbol];
            // group.quoteToken = combinedConfig.TOKENS[group.quoteTokenSymbol]; // quoteTokenSymbol might be removed

            if (!group.token0 || !group.token1 || !group.borrowToken /*|| !group.quoteToken*/) {
                 console.error(`[Config] Skipping POOL_GROUP "${group.name}": Contains invalid token symbols not found in TOKENS config.`);
                 return; // Skip group if tokens are invalid
            }

            // Create Uniswap SDK Token objects
            try {
                group.sdkToken0 = new Token(combinedConfig.CHAIN_ID, group.token0.address, group.token0.decimals, group.token0.symbol);
                group.sdkToken1 = new Token(combinedConfig.CHAIN_ID, group.token1.address, group.token1.decimals, group.token1.symbol);
                group.sdkBorrowToken = new Token(combinedConfig.CHAIN_ID, group.borrowToken.address, group.borrowToken.decimals, group.borrowToken.symbol);
                // group.sdkQuoteToken = new Token(combinedConfig.CHAIN_ID, group.quoteToken.address, group.quoteToken.decimals, group.quoteToken.symbol);
            } catch (sdkError) {
                console.error(`[Config] Error creating SDK Token for group "${group.name}": ${sdkError.message}. Skipping group.`);
                return; // Skip group if SDK token creation fails
            }

            // Assign borrow amount (from global BORROW_AMOUNTS_WEI)
            group.borrowAmount = BORROW_AMOUNTS_WEI[group.borrowTokenSymbol];
            if (!group.borrowAmount || group.borrowAmount <= 0n) {
                 console.error(`[Config] Skipping POOL_GROUP "${group.name}": Missing or invalid borrow amount config (BORROW_AMOUNT_${group.borrowTokenSymbol}) in .env or defaults.`);
                 return; // Skip group if borrow amount is invalid
            }

            // Assign minNetProfit (now read directly from group config in arbitrum.js)
            // Ensure it's a BigInt, default to 0 if missing (though ProfitCalc also checks)
            group.minNetProfit = BigInt(group.minNetProfit || '0');

            // Validate and load pool addresses for this group
            group.pools = []; // Initialize pools array for the group
            if (group.feeTierToEnvMap && typeof group.feeTierToEnvMap === 'object') {
                for (const feeTier in group.feeTierToEnvMap) {
                    const envVarKey = group.feeTierToEnvMap[feeTier];
                    const rawAddress = process.env[envVarKey];
                    if (rawAddress) {
                        const validatedAddress = validateAndNormalizeAddress(rawAddress, envVarKey);
                        if (validatedAddress) {
                            const poolConfig = {
                                address: validatedAddress,
                                feeBps: parseInt(feeTier, 10), // Store fee tier (e.g., 500, 3000)
                                groupName: group.name // Link back to the group
                            };
                            group.pools.push(poolConfig); // Add validated pool config
                            totalPoolsLoaded++;
                        } else {
                            console.warn(`[Config] Invalid address format for pool ${envVarKey} in group ${group.name}. Skipping pool.`);
                        }
                    } else {
                         // Optional: Log if an expected env var is missing
                         // console.debug(`[Config] Env variable ${envVarKey} for group ${group.name} not found.`);
                    }
                }
            } else {
                 console.warn(`[Config] Missing or invalid feeTierToEnvMap for group ${group.name}. No pools loaded for this group.`);
            }
            console.log(`[Config] Group ${group.name} initialized with ${group.pools.length} pools.`);
        }); // End forEach POOL_GROUP
    } // End else (POOL_GROUPS exists)

    console.log(`[Config] Total unique pools loaded from .env: ${totalPoolsLoaded}`);
    if (totalPoolsLoaded === 0) {
        console.warn("[Config] WARNING: No pool addresses were successfully loaded from .env variables. Bot cannot scan pools.");
    }

    // 5. Add Provider/Signer Info & Flash Swap Address
    const rpcEnvKey = `${networkName.toUpperCase()}_RPC_URL`;
    combinedConfig.RPC_URL = process.env[rpcEnvKey];
    combinedConfig.PRIVATE_KEY = process.env.PRIVATE_KEY;
    const flashSwapEnvKey = `${networkName.toUpperCase()}_FLASH_SWAP_ADDRESS`;
    const rawFlashSwapAddress = process.env[flashSwapEnvKey];

    if (!combinedConfig.RPC_URL) {
        throw new Error(`[Config] CRITICAL: RPC URL environment variable (${rpcEnvKey}) not set.`);
    }
    if (!combinedConfig.PRIVATE_KEY || !combinedConfig.PRIVATE_KEY.startsWith('0x') || combinedConfig.PRIVATE_KEY.length !== 66) { // Basic validation
        throw new Error(`[Config] CRITICAL: PRIVATE_KEY environment variable not set, missing '0x' prefix, or not 66 chars long.`);
    }

    if (rawFlashSwapAddress) {
        const validatedFlashSwapAddress = validateAndNormalizeAddress(rawFlashSwapAddress, flashSwapEnvKey);
        if (validatedFlashSwapAddress) {
            combinedConfig.FLASH_SWAP_CONTRACT_ADDRESS = validatedFlashSwapAddress;
            console.log(`[Config] Loaded Flash Swap Address: ${combinedConfig.FLASH_SWAP_CONTRACT_ADDRESS}`);
        } else {
            throw new Error(`[Config] CRITICAL: Invalid address format provided for ${flashSwapEnvKey}: "${rawFlashSwapAddress}"`);
        }
    } else {
        console.warn(`[Config] WARNING: ${flashSwapEnvKey} not set in environment variables. FlashSwap interactions will fail unless deployed.`);
        combinedConfig.FLASH_SWAP_CONTRACT_ADDRESS = ethers.ZeroAddress; // Set to ZeroAddress if not provided
    }

    // --->>> ADDED: Read and parse DRY_RUN environment variable <<<---
    const dryRunEnv = process.env.DRY_RUN?.toLowerCase();
    // Default to TRUE if not explicitly set to 'false' for safety
    combinedConfig.DRY_RUN = (dryRunEnv !== 'false');
    if (combinedConfig.DRY_RUN) {
        console.warn("[Config] --- DRY RUN MODE ENABLED --- Transactions will NOT be sent.");
    } else {
        console.log("[Config] --- LIVE TRADING MODE --- Transactions WILL be sent.");
    }
    // --->>> --- <<<---

    // --->>> ADDED HELPER FUNCTION TO EXTRACT POOL CONFIGS <<<---
    // This helper makes it easier for PoolScanner to get a flat list of pools to check
    combinedConfig.getPoolConfigs = () => {
        if (!combinedConfig.POOL_GROUPS || !Array.isArray(combinedConfig.POOL_GROUPS)) {
            return []; // Return empty array if groups don't exist or are invalid
        }
        // Use flatMap to get all 'pools' arrays from each valid group and concatenate them
        return combinedConfig.POOL_GROUPS.flatMap(group => group.pools || []);
    };
    // --->>> --- <<<---

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

module.exports = config; // Export the loaded config object
