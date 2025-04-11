// config.js
require('dotenv').config();
const { ethers } = require("ethers");

// --- Chain-Specific Configurations ---
const NETWORK_CONFIGS = {
    // --- Arbitrum ---
    arbitrum: {
        CHAIN_ID: 42161,
        RPC_URL: process.env.ARBITRUM_RPC_URL || "YOUR_ARBITRUM_RPC_URL",
        SCAN_API_KEY: process.env.ARBISCAN_API_KEY,
        EXPLORER_URL: "https://arbiscan.io",
        FLASH_SWAP_CONTRACT_ADDRESS: process.env.ARBITRUM_FLASH_SWAP_ADDRESS || "0x675BCDd612973C75cA682f9B8b0e27032A4B3FB6",
        WETH_ADDRESS: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
        USDC_ADDRESS: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        QUOTER_V2_ADDRESS: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
        POOL_A_ADDRESS: "0xC6962004f452bE9203591991D15f6b388e09E8D0", // 0.05%
        POOL_A_FEE_BPS: 500,
        POOL_B_ADDRESS: "0xc473e2aEE3441BF9240Be85eb122aBB059A3B57c", // 0.30%
        POOL_B_FEE_BPS: 3000,
        GAS_LIMIT_ESTIMATE: 1_000_000n,
        MIN_NET_PROFIT_WEI: ethers.parseUnits("0.0001", 18),
        BORROW_AMOUNT_WETH_STR: "0.1",
        MULTI_QUOTE_SIM_AMOUNT_WETH_STR: "0.0001",
        TICK_DELTA_WARNING_THRESHOLD: 20,
        POLLING_INTERVAL_MS: 10000,
    },
    // --- Polygon ---
    polygon: {
        CHAIN_ID: 137,
        RPC_URL: process.env.POLYGON_RPC_URL || "YOUR_POLYGON_RPC_URL",
        SCAN_API_KEY: process.env.POLYGONSCAN_API_KEY,
        EXPLORER_URL: "https://polygonscan.com",
        FLASH_SWAP_CONTRACT_ADDRESS: process.env.POLYGON_FLASH_SWAP_ADDRESS || "",
        WETH_ADDRESS: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
        USDC_ADDRESS: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
        QUOTER_V2_ADDRESS: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
        // <<< Updated Polygon Pool Addresses >>>
        POOL_A_ADDRESS: "0x45dDa9cb7c25131DF268515131f647d726f50608", // WETH/USDC 0.05%
        POOL_A_FEE_BPS: 500,
        POOL_B_ADDRESS: "0x0e44cEb592AcFC5D3F09D996302eB4C499ff8c10", // WETH/USDC 0.30%
        POOL_B_FEE_BPS: 3000,
        GAS_LIMIT_ESTIMATE: 1_200_000n,
        MIN_NET_PROFIT_WEI: ethers.parseUnits("0.00002", 18),
        BORROW_AMOUNT_WETH_STR: "0.1",
        MULTI_QUOTE_SIM_AMOUNT_WETH_STR: "0.0001",
        TICK_DELTA_WARNING_THRESHOLD: 10,
        POLLING_INTERVAL_MS: 5000,
    },
    // --- Base ---
    base: {
        CHAIN_ID: 8453,
        RPC_URL: process.env.BASE_RPC_URL || "YOUR_BASE_RPC_URL",
        SCAN_API_KEY: process.env.BASESCAN_API_KEY,
        EXPLORER_URL: "https://basescan.org",
        FLASH_SWAP_CONTRACT_ADDRESS: process.env.BASE_FLASH_SWAP_ADDRESS || "",
        WETH_ADDRESS: "0x4200000000000000000000000000000000000006",
        USDC_ADDRESS: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        QUOTER_V2_ADDRESS: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
         // <<< Base Pool Addresses Placeholder - Needs Factory Address Fix >>>
        POOL_A_ADDRESS: "BASE_POOL_500_ADDRESS_PLACEHOLDER", // WETH/USDC 0.05% - FIND THIS
        POOL_A_FEE_BPS: 500,
        POOL_B_ADDRESS: "BASE_POOL_3000_ADDRESS_PLACEHOLDER", // WETH/USDC 0.30% - FIND THIS
        POOL_B_FEE_BPS: 3000,
        GAS_LIMIT_ESTIMATE: 1_000_000n,
        MIN_NET_PROFIT_WEI: ethers.parseUnits("0.00001", 18),
        BORROW_AMOUNT_WETH_STR: "0.1",
        MULTI_QUOTE_SIM_AMOUNT_WETH_STR: "0.0001",
        TICK_DELTA_WARNING_THRESHOLD: 5,
        POLLING_INTERVAL_MS: 3000,
    },
    // --- Optimism ---
    optimism: {
        CHAIN_ID: 10,
        RPC_URL: process.env.OPTIMISM_RPC_URL || "YOUR_OPTIMISM_RPC_URL",
        SCAN_API_KEY: process.env.OPTIMISMSCAN_API_KEY,
        EXPLORER_URL: "https://optimistic.etherscan.io",
        FLASH_SWAP_CONTRACT_ADDRESS: process.env.OPTIMISM_FLASH_SWAP_ADDRESS || "",
        WETH_ADDRESS: "0x4200000000000000000000000000000000000006",
        USDC_ADDRESS: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
        QUOTER_V2_ADDRESS: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
         // <<< Updated Optimism Pool Addresses >>>
        POOL_A_ADDRESS: "0x1fb3cf6e48F1E7B10213E7b6d87D4c073C7Fdb7b", // WETH/USDC 0.05%
        POOL_A_FEE_BPS: 500,
        POOL_B_ADDRESS: "0xc1738D90E2E26C35784A0d3E3d8A9f795074bcA4", // WETH/USDC 0.30%
        POOL_B_FEE_BPS: 3000,
        GAS_LIMIT_ESTIMATE: 1_000_000n,
        MIN_NET_PROFIT_WEI: ethers.parseUnits("0.00001", 18),
        BORROW_AMOUNT_WETH_STR: "0.1",
        MULTI_QUOTE_SIM_AMOUNT_WETH_STR: "0.0001",
        TICK_DELTA_WARNING_THRESHOLD: 5,
        POLLING_INTERVAL_MS: 4000,
    }
};

// --- Shared Constants ---
const SHARED_DEFAULTS = {
    WETH_DECIMALS: 18,
    USDC_DECIMALS: 6,
};

// --- Function to Get Config ---
function getConfig(networkName) {
    if (!networkName) {
        throw new Error("Network name must be provided to getConfig");
    }
    const lowerNetworkName = networkName.toLowerCase();
    if (!NETWORK_CONFIGS[lowerNetworkName]) {
        throw new Error(`Configuration for network "${networkName}" not found.`);
    }

    const networkConfig = {
        ...SHARED_DEFAULTS,
        ...NETWORK_CONFIGS[lowerNetworkName]
    };

    networkConfig.BORROW_AMOUNT_WETH_WEI = ethers.parseUnits(networkConfig.BORROW_AMOUNT_WETH_STR, networkConfig.WETH_DECIMALS);
    networkConfig.MULTI_QUOTE_SIM_AMOUNT_WETH_WEI = ethers.parseUnits(networkConfig.MULTI_QUOTE_SIM_AMOUNT_WETH_STR, networkConfig.WETH_DECIMALS);

    // Basic validation (can be expanded)
    const required = ['RPC_URL', 'FLASH_SWAP_CONTRACT_ADDRESS', 'WETH_ADDRESS', 'USDC_ADDRESS', 'QUOTER_V2_ADDRESS', 'POOL_A_ADDRESS', 'POOL_B_ADDRESS'];
    for (const key of required) {
         if (!networkConfig[key] && networkConfig[key] !== "") { // Allow empty string for not-yet-deployed contracts
             console.warn(`[Config] Warning: Missing config key "${key}" for network "${lowerNetworkName}".`);
         }
         // Check for remaining placeholders only if network is not Base (since we know Base failed)
         if (lowerNetworkName !== 'base' && typeof networkConfig[key] === 'string' && networkConfig[key].includes("_ADDRESS")) {
             console.warn(`[Config] Placeholder detected for ${key} on ${lowerNetworkName}. Please update.`);
         }
    }

    return networkConfig;
}

module.exports = { getConfig }; // Export the function
