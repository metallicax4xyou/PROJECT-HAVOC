// config/index.js
// Main configuration loader - FINAL VERSION

require('dotenv').config(); // Load .env file first
const { ethers } = require('ethers');
const { Token } = require('@uniswap/sdk-core'); // For creating Token objects

const { getNetworkMetadata } = require('./networks');
const { PROTOCOL_ADDRESSES } = require('../constants/addresses');

// --- Global Settings & Defaults (from .env or defaults) ---

const MIN_NET_PROFIT_WEI = {
    WETH: ethers.parseUnits(process.env.MIN_PROFIT_WETH || '0.0005', 18),
    USDC: ethers.parseUnits(process.env.MIN_PROFIT_USDC || '1', 6),
    USDT: ethers.parseUnits(process.env.MIN_PROFIT_USDT || '1', 6),
    // Add other tokens if needed
};

const FLASH_LOAN_FEE_BPS = parseInt(process.env.FLASH_LOAN_FEE_BPS || '9', 10); // Default 0.09%

const GAS_LIMIT_ESTIMATE = BigInt(process.env.GAS_LIMIT_ESTIMATE || '1000000');

const BORROW_AMOUNTS_WEI = {
    WETH: ethers.parseUnits(process.env.BORROW_AMOUNT_WETH_WEI || '100000000000000000', 18), // Default 0.1 WETH
    USDC: ethers.parseUnits(process.env.BORROW_AMOUNT_USDC_WEI || '100000000', 6),          // Default 100 USDC
    USDT: ethers.parseUnits(process.env.BORROW_AMOUNT_USDT_WEI || '100000000', 6),          // Default 100 USDT
    // Add other tokens if needed
};

// Default Slippage Tolerance (in basis points, e.g., 10 = 0.1%)
const SLIPPAGE_TOLERANCE_BPS = parseInt(process.env.SLIPPAGE_TOLERANCE_BPS || '10', 10);
// --- End Global Settings ---


// +++ Address Validation Function (from Action 16) +++
function validateAndNormalizeAddress(rawAddress, envVarName) {
    const addressString = String(rawAddress || '').trim();
    if (!addressString) { return null; }
    try {
        const cleanAddress = addressString.replace(/^['"]+|['"]+$/g, '').replace(/[^a-zA-Z0-9x]/g, '');
        if (!cleanAddress.startsWith('0x')) { console.warn(`[Config] Validation FAILED for ${envVarName} ("${cleanAddress}"): Missing 0x prefix.`); return null; }
        if (cleanAddress.length !== 42) { console.warn(`[Config] Validation FAILED for ${envVarName} ("${cleanAddress}"): Invalid length (${cleanAddress.length} chars).`); return null; }
        if (!ethers.isAddress(cleanAddress)) { console.warn(`[Config] Validation FAILED for ${envVarName} ("${cleanAddress}"): Failed ethers.isAddress() check (likely invalid hex or checksum).`); return null; }
        return ethers.getAddress(cleanAddress);
    } catch (error) { console.warn(`[Config] ${envVarName}: Unexpected validation error for raw value "${rawAddress}" - ${error.message}`); return null; }
}
// +++ End Validation Function +++


// --- Config Loading Function ---
function loadConfig() {
    const networkName = process.env.NETWORK?.toLowerCase();
    if (!networkName) {
        throw new Error(`Missing NETWORK environment variable. Choose from supported networks.`);
    }

    // 1. Load base network metadata
    const networkMetadata = getNetworkMetadata(networkName);

    // 2. Load network-specific config file
    let networkSpecificConfig;
    try {
        networkSpecificConfig = require(`./${networkName}.js`);
    } catch (e) {
        throw new Error(`Failed to load configuration file for network "${networkName}": ${e.message}`);
    }

    // 3. Combine base metadata and network-specific settings
    const combinedConfig = {
        ...networkMetadata,
        ...networkSpecificConfig,
        FACTORY_ADDRESS: PROTOCOL_ADDRESSES.UNISWAP_V3_FACTORY,
        QUOTER_ADDRESS: PROTOCOL_ADDRESSES.QUOTER_V2,
        FLASH_LOAN_FEE_BPS: FLASH_LOAN_FEE_BPS,
        GAS_LIMIT_ESTIMATE: GAS_LIMIT_ESTIMATE,
        SLIPPAGE_TOLERANCE_BPS: SLIPPAGE_TOLERANCE_BPS,
        MIN_NET_PROFIT_WEI: MIN_NET_PROFIT_WEI,
        BORROW_AMOUNTS_WEI: BORROW_AMOUNTS_WEI,
    };

    // 4. Process POOL_GROUPS: Use enhanced validation
    let totalPoolsLoaded = 0;
    combinedConfig.POOL_GROUPS?.forEach(group => {
        group.token0 = combinedConfig.TOKENS[group.token0Symbol];
        group.token1 = combinedConfig.TOKENS[group.token1Symbol];
        group.borrowToken = combinedConfig.TOKENS[group.borrowTokenSymbol];
        group.quoteToken = combinedConfig.TOKENS[group.quoteTokenSymbol];

        if (!group.token0 || !group.token1 || !group.borrowToken || !group.quoteToken) { throw new Error(`Invalid token symbols in POOL_GROUP "${group.name}"`); }
        group.sdkToken0 = new Token(combinedConfig.CHAIN_ID, group.token0.address, group.token0.decimals, group.token0.symbol);
        group.sdkToken1 = new Token(combinedConfig.CHAIN_ID, group.token1.address, group.token1.decimals, group.token1.symbol);
        group.sdkBorrowToken = new Token(combinedConfig.CHAIN_ID, group.borrowToken.address, group.borrowToken.decimals, group.borrowToken.symbol);
        group.sdkQuoteToken = new Token(combinedConfig.CHAIN_ID, group.quoteToken.address, group.quoteToken.decimals, group.quoteToken.symbol);

        group.borrowAmount = BORROW_AMOUNTS_WEI[group.borrowTokenSymbol];
        group.minNetProfit = MIN_NET_PROFIT_WEI[group.quoteTokenSymbol] || 0n;
        if (!group.borrowAmount) { throw new Error(`Missing borrow amount config for ${group.borrowTokenSymbol}`); }
        if (!MIN_NET_PROFIT_WEI[group.quoteTokenSymbol]) { console.warn(`[Config] Warning: MIN_NET_PROFIT_WEI not configured for quote token ${group.quoteTokenSymbol}...`); }

        // Load pool addresses from .env using enhanced validation
        group.pools = [];
        // console.log(`[Config] Processing Pool Group: ${group.name}`); // Optional: Keep for debug
        for (const feeTier in group.feeTierToEnvMap) {
            const envVarKey = group.feeTierToEnvMap[feeTier];
            const rawAddress = process.env[envVarKey];
            // console.log(`[DEBUG] Checking env var: ${envVarKey}`); // Optional: Keep for debug
            // console.log(`  - Raw value: "${rawAddress}"`); // Optional: Keep for debug

            if (rawAddress) {
                const validatedAddress = validateAndNormalizeAddress(rawAddress, envVarKey);
                if (validatedAddress) {
                    const poolConfig = { address: validatedAddress, feeBps: parseInt(feeTier, 10), groupName: group.name };
                    group.pools.push(poolConfig);
                    totalPoolsLoaded++;
                    // console.log(`  - SUCCESS: Loaded Pool: ${group.name} Fee ${feeTier} -> ${poolConfig.address}`); // Optional: Keep for debug
                } else {
                    // console.log(`  - SKIPPED: ${envVarKey} due to validation failure.`); // Optional: Keep for debug
                }
            } else {
                 // console.log(`  - Env var not found for ${envVarKey}. Skipping.`); // Optional: Keep for debug
            }
            // console.log("---"); // Optional: Keep for debug
        }
        console.log(`[Config] Group ${group.name} initialized with ${group.pools.length} pools.`);
        // console.log("====================================="); // Optional: Keep for debug

    }); // End loop through POOL_GROUPS

    console.log(`[Config] Total unique pools loaded from .env: ${totalPoolsLoaded}`);
    if (totalPoolsLoaded === 0) { console.warn("[Config] WARNING: No pool addresses were loaded..."); }

    // --- Add Provider/Signer Info & Flash Swap Address ---
    combinedConfig.RPC_URL = process.env[`${networkName.toUpperCase()}_RPC_URL`];
    combinedConfig.PRIVATE_KEY = process.env.PRIVATE_KEY;
    // +++ Load Flash Swap Address +++
    const flashSwapEnvKey = `${networkName.toUpperCase()}_FLASH_SWAP_ADDRESS`;
    const rawFlashSwapAddress = process.env[flashSwapEnvKey];

    if (!combinedConfig.RPC_URL) { throw new Error(`RPC URL environment variable (${networkName.toUpperCase()}_RPC_URL) not set.`); }
    if (!combinedConfig.PRIVATE_KEY || !combinedConfig.PRIVATE_KEY.startsWith('0x')) { throw new Error(`PRIVATE_KEY environment variable not set or missing '0x' prefix.`); }

    if (rawFlashSwapAddress) {
        const validatedFlashSwapAddress = validateAndNormalizeAddress(rawFlashSwapAddress, flashSwapEnvKey);
        if (validatedFlashSwapAddress) {
            combinedConfig.FLASH_SWAP_CONTRACT_ADDRESS = validatedFlashSwapAddress;
            console.log(`[Config] Loaded Flash Swap Address: ${combinedConfig.FLASH_SWAP_CONTRACT_ADDRESS}`);
        } else {
             // Validation function already warned, throw critical error here
             throw new Error(`Invalid address format provided for ${flashSwapEnvKey}: "${rawFlashSwapAddress}"`);
        }
    } else {
         // Set to ZeroAddress if not found, FlashSwapManager should handle this if required
         console.warn(`[Config] WARNING: ${flashSwapEnvKey} not set in environment variables. Setting FlashSwap address to ZeroAddress.`);
         combinedConfig.FLASH_SWAP_CONTRACT_ADDRESS = ethers.ZeroAddress;
         // Throwing error here instead, as manager expects it now
         // throw new Error(`${flashSwapEnvKey} environment variable not set.`);
    }
    // +++ End Load Flash Swap Address +++

    // Return the final, fully populated config object
    return combinedConfig;
} // End loadConfig function

// Load the config immediately and export it
const config = loadConfig();
console.log(`[Config] Configuration loaded successfully for network: ${config.NAME}`);
module.exports = config; // Export the loaded config object directly
