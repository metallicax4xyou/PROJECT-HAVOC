// config/index.js
// Main configuration loader

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
// Can be overridden by network-specific config if needed
const SLIPPAGE_TOLERANCE_BPS = parseInt(process.env.SLIPPAGE_TOLERANCE_BPS || '10', 10);


// --- Config Loading Function ---

function loadConfig() {
    const networkName = process.env.NETWORK?.toLowerCase();
    if (!networkName) {
        throw new Error(`Missing NETWORK environment variable. Choose from supported networks.`);
    }

    // 1. Load base network metadata
    const networkMetadata = getNetworkMetadata(networkName);

    // 2. Load network-specific config file (e.g., arbitrum.js)
    let networkSpecificConfig;
    try {
        networkSpecificConfig = require(`./${networkName}.js`); // Assumes file exists named after network
    } catch (e) {
        throw new Error(`Failed to load configuration file for network "${networkName}": ${e.message}`);
    }

    // 3. Combine base metadata and network-specific settings
    const combinedConfig = {
        ...networkMetadata, // NAME, CHAIN_ID, NATIVE_SYMBOL, EXPLORER_URL
        ...networkSpecificConfig, // TOKENS, POOL_GROUPS structure, specific overrides
        // Add global constants/settings
        FACTORY_ADDRESS: PROTOCOL_ADDRESSES.UNISWAP_V3_FACTORY,
        QUOTER_ADDRESS: PROTOCOL_ADDRESSES.QUOTER_V2, // Assuming same QuoterV2 for now
        FLASH_LOAN_FEE_BPS: FLASH_LOAN_FEE_BPS,
        GAS_LIMIT_ESTIMATE: GAS_LIMIT_ESTIMATE,
        SLIPPAGE_TOLERANCE_BPS: SLIPPAGE_TOLERANCE_BPS,
        MIN_NET_PROFIT_WEI: MIN_NET_PROFIT_WEI, // Map of min profits
        BORROW_AMOUNTS_WEI: BORROW_AMOUNTS_WEI, // Map of borrow amounts
    };

    // 4. Process POOL_GROUPS: Load addresses, create Token objects, link borrow amounts/min profits
    let totalPoolsLoaded = 0;
    combinedConfig.POOL_GROUPS?.forEach(group => {
        // Get Token objects from the config's TOKENS definition
        group.token0 = combinedConfig.TOKENS[group.token0Symbol];
        group.token1 = combinedConfig.TOKENS[group.token1Symbol];
        group.borrowToken = combinedConfig.TOKENS[group.borrowTokenSymbol];
        group.quoteToken = combinedConfig.TOKENS[group.quoteTokenSymbol];

        // Validate tokens exist
        if (!group.token0 || !group.token1 || !group.borrowToken || !group.quoteToken) {
            console.error(`[Config] ERROR: Invalid token symbols (${group.token0Symbol}, ${group.token1Symbol}, ${group.borrowTokenSymbol}, ${group.quoteTokenSymbol}) in POOL_GROUP "${group.name}"`);
            throw new Error(`Invalid token symbols in POOL_GROUP "${group.name}"`);
        }
        // Create SDK Token objects for convenience later
        group.sdkToken0 = new Token(combinedConfig.CHAIN_ID, group.token0.address, group.token0.decimals, group.token0.symbol);
        group.sdkToken1 = new Token(combinedConfig.CHAIN_ID, group.token1.address, group.token1.decimals, group.token1.symbol);
        group.sdkBorrowToken = new Token(combinedConfig.CHAIN_ID, group.borrowToken.address, group.borrowToken.decimals, group.borrowToken.symbol);
        group.sdkQuoteToken = new Token(combinedConfig.CHAIN_ID, group.quoteToken.address, group.quoteToken.decimals, group.quoteToken.symbol);


        // Assign borrow amount and min profit specific to this group
        group.borrowAmount = BORROW_AMOUNTS_WEI[group.borrowTokenSymbol];
        group.minNetProfit = MIN_NET_PROFIT_WEI[group.quoteTokenSymbol] || 0n; // Default 0 if not set

        if (!group.borrowAmount) {
            console.error(`[Config] ERROR: Borrow amount not defined for symbol ${group.borrowTokenSymbol} in BORROW_AMOUNTS_WEI`);
            throw new Error(`Missing borrow amount config for ${group.borrowTokenSymbol}`);
        }
        if (!MIN_NET_PROFIT_WEI[group.quoteTokenSymbol]) {
             console.warn(`[Config] Warning: MIN_NET_PROFIT_WEI not configured for quote token ${group.quoteTokenSymbol} in group ${group.name}. Defaulting min profit to 0.`);
        }

        // Load pool addresses from .env based on the feeTierToEnvMap
        group.pools = []; // Initialize pools array for the group
        for (const feeTier in group.feeTierToEnvMap) {
            const envVarKey = group.feeTierToEnvMap[feeTier];
            const address = process.env[envVarKey];

            if (address) {
                try {
                    const poolConfig = {
                        address: ethers.getAddress(address.trim()), // Validate checksum
                        feeBps: parseInt(feeTier, 10),
                        groupName: group.name, // Link back to group
                    };
                    group.pools.push(poolConfig);
                    totalPoolsLoaded++;
                    console.log(`[Config] Loaded Pool: ${group.name} Fee ${feeTier} (${envVarKey}) -> ${poolConfig.address}`);
                } catch (e) {
                    console.warn(`[Config] Invalid address format for env var ${envVarKey}: "${address}". Skipping.`);
                }
            } else {
                // console.log(`[Config] Env var not found for ${group.name} Fee ${feeTier} (${envVarKey}). Skipping.`);
            }
        }
        console.log(`[Config] Group ${group.name} initialized with ${group.pools.length} pools.`);

    }); // End loop through POOL_GROUPS

    console.log(`[Config] Total unique pools loaded from .env: ${totalPoolsLoaded}`);
    if (totalPoolsLoaded === 0) {
         console.warn("[Config] WARNING: No pool addresses were loaded from environment variables for the configured groups!");
    }

    // --- Add Provider/Signer Info (Can be done here or later) ---
    combinedConfig.RPC_URL = process.env[`${networkName.toUpperCase()}_RPC_URL`]; // Ensure RPC URL matches network name convention
    combinedConfig.PRIVATE_KEY = process.env.PRIVATE_KEY;

    if (!combinedConfig.RPC_URL) {
         throw new Error(`RPC URL environment variable (${networkName.toUpperCase()}_RPC_URL) not set.`);
    }
     if (!combinedConfig.PRIVATE_KEY) {
         throw new Error(`PRIVATE_KEY environment variable not set.`);
     }


    // Return the final, fully populated config object
    return combinedConfig;
}

// Load the config immediately and export it
const config = loadConfig();

console.log(`[Config] Configuration loaded successfully for network: ${config.NAME}`);

module.exports = config; // Export the loaded config object directly
