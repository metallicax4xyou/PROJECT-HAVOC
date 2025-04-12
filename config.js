// config.js (Structure Example - Fill with real addresses)
require('dotenv').config();
const { ethers } = require("ethers");

// Helper to easily define pool objects
const pool = (address, feeBps) => ({ address: ethers.getAddress(address), feeBps }); // Add getAddress validation

// --- Token Addresses (Per Network) ---
// It's useful to have these defined once per network
const TOKENS = {
    optimism: {
        WETH: "0x4200000000000000000000000000000000000006",
        USDC: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", // Native USDC
        USDT: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", // Standard USDT
    },
    polygon: {
        WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
        USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
        USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    },
    arbitrum: {
        WETH: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
        USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        USDT: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", // Standard USDT
    },
    base: {
        WETH: "0x4200000000000000000000000000000000000006",
        USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        USDT: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", // Bridged USDT? Verify
    }
};

// --- Token Decimals (Centralized) ---
const DECIMALS = {
    [TOKENS.optimism.WETH]: 18, [TOKENS.optimism.USDC]: 6, [TOKENS.optimism.USDT]: 6,
    [TOKENS.polygon.WETH]: 18, [TOKENS.polygon.USDC]: 6, [TOKENS.polygon.USDT]: 6,
    [TOKENS.arbitrum.WETH]: 18, [TOKENS.arbitrum.USDC]: 6, [TOKENS.arbitrum.USDT]: 6,
    [TOKENS.base.WETH]: 18, [TOKENS.base.USDC]: 6, [TOKENS.base.USDT]: 6,
    // Add other common tokens if needed
};

// --- Chain-Specific Configurations ---
const NETWORK_CONFIGS = {
    // --- Arbitrum ---
    arbitrum: {
        CHAIN_ID: 42161,
        RPC_URL: process.env.ARBITRUM_RPC_URL,
        SCAN_API_KEY: process.env.ARBISCAN_API_KEY,
        EXPLORER_URL: "https://arbiscan.io",
        FLASH_SWAP_CONTRACT_ADDRESS: process.env.ARBITRUM_FLASH_SWAP_ADDRESS,
        QUOTER_V2_ADDRESS: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
        TOKENS: TOKENS.arbitrum, // Reference the token object
        POOL_GROUPS: {
            WETH_USDC: { // Group Key: TOKEN_SYMBOL_TOKEN_SYMBOL
                token0Address: TOKENS.arbitrum.WETH, // Use refs for clarity
                token1Address: TOKENS.arbitrum.USDC,
                pools: [ // Pools for this PAIR
                    pool("0xC6962004f452bE9203591991D15f6b388e09E8D0", 500), // 0.05%
                    pool("0xc473e2aEE3441BF9240Be85eb122aBB059A3B57c", 3000), // 0.30%
                    // pool("POOL_ADDRESS_100", 100), // Add 0.01% if exists
                ]
            },
            // Add USDC_USDT group for Arbitrum if pools exist and are found
            // USDC_USDT: {
            //     token0Address: TOKENS.arbitrum.USDC,
            //     token1Address: TOKENS.arbitrum.USDT,
            //     pools: [
            //          pool("ARB_USDC_USDT_100_ADDRESS", 100),
            //          pool("ARB_USDC_USDT_500_ADDRESS", 500), // Less common for stable/stable
            //     ]
            // },
        },
        GAS_LIMIT_ESTIMATE: 1_000_000n,
        MIN_NET_PROFIT_TOKEN: TOKENS.arbitrum.WETH, // Define profit currency
        MIN_NET_PROFIT_WEI: ethers.parseUnits("0.0001", 18), // Profit in WETH Wei
        BORROW_TOKEN_SYMBOL: "WETH", // Default borrow token for logging/defaults
        BORROW_AMOUNT_STR: "0.1", // Amount in borrow token units
        MULTI_QUOTE_SIM_AMOUNT_STR: "0.0001", // Amount in borrow token units
        TICK_DELTA_WARNING_THRESHOLD: 20,
        POLLING_INTERVAL_MS: 10000,
    },
    // --- Polygon ---
    polygon: {
        CHAIN_ID: 137,
        RPC_URL: process.env.POLYGON_RPC_URL,
        SCAN_API_KEY: process.env.POLYGONSCAN_API_KEY,
        EXPLORER_URL: "https://polygonscan.com",
        FLASH_SWAP_CONTRACT_ADDRESS: process.env.POLYGON_FLASH_SWAP_ADDRESS,
        QUOTER_V2_ADDRESS: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
        TOKENS: TOKENS.polygon,
        POOL_GROUPS: {
            WETH_USDC: {
                token0Address: TOKENS.polygon.WETH,
                token1Address: TOKENS.polygon.USDC,
                pools: [
                    pool("0x45dDa9cb7c25131DF268515131f647d726f50608", 500), // 0.05%
                    pool("0x0e44cEb592AcFC5D3F09D996302eB4C499ff8c10", 3000), // 0.30%
                    pool("0x04537F43f6adD7b1b60CAb199c7a910024eE0594", 100), // 0.01%
                ]
            },
            USDC_USDT: {
                 token0Address: TOKENS.polygon.USDC,
                 token1Address: TOKENS.polygon.USDT,
                 pools: [
                      // ** Find these pool addresses using checkPools task **
                      pool("POLYGON_USDC_USDT_100_ADDRESS", 100), // 0.01% is common
                      pool("POLYGON_USDC_USDT_500_ADDRESS", 500), // 0.05% might exist
                 ]
            },
        },
        GAS_LIMIT_ESTIMATE: 1_200_000n,
        MIN_NET_PROFIT_TOKEN: TOKENS.polygon.WETH, // Profit currency
        MIN_NET_PROFIT_WEI: ethers.parseUnits("0.00002", 18), // In WETH Wei
        BORROW_TOKEN_SYMBOL: "WETH",
        BORROW_AMOUNT_STR: "0.1",
        MULTI_QUOTE_SIM_AMOUNT_STR: "0.0001",
        TICK_DELTA_WARNING_THRESHOLD: 10,
        POLLING_INTERVAL_MS: 5000,
    },
    // --- Optimism ---
    optimism: {
        CHAIN_ID: 10,
        RPC_URL: process.env.OPTIMISM_RPC_URL,
        SCAN_API_KEY: process.env.OPTIMISMSCAN_API_KEY,
        EXPLORER_URL: "https://optimistic.etherscan.io",
        FLASH_SWAP_CONTRACT_ADDRESS: process.env.OPTIMISM_FLASH_SWAP_ADDRESS,
        QUOTER_V2_ADDRESS: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
        TOKENS: TOKENS.optimism,
        POOL_GROUPS: {
            WETH_USDC: {
                token0Address: TOKENS.optimism.WETH,
                token1Address: TOKENS.optimism.USDC,
                pools: [
                    pool("0x1fb3cf6e48F1E7B10213E7b6d87D4c073C7Fdb7b", 500), // 0.05%
                    pool("0xc1738D90E2E26C35784A0d3E3d8A9f795074bcA4", 3000), // 0.30%
                    pool("0xeb0D8D9e19B749eFB20c67D71EE50b46dFE5755F", 100), // 0.01%
                ]
            },
             USDC_USDT: {
                 token0Address: TOKENS.optimism.USDC,
                 token1Address: TOKENS.optimism.USDT,
                 pools: [
                      // ** Find these pool addresses using checkPools task **
                      pool("OPTIMISM_USDC_USDT_100_ADDRESS", 100), // 0.01% is common
                      pool("OPTIMISM_USDC_USDT_500_ADDRESS", 500), // 0.05% might exist
                 ]
            },
        },
        GAS_LIMIT_ESTIMATE: 1_000_000n,
        MIN_NET_PROFIT_TOKEN: TOKENS.optimism.WETH, // Profit currency
        MIN_NET_PROFIT_WEI: ethers.parseUnits("0.00001", 18), // In WETH Wei
        BORROW_TOKEN_SYMBOL: "WETH",
        BORROW_AMOUNT_STR: "0.1",
        MULTI_QUOTE_SIM_AMOUNT_STR: "0.0001",
        TICK_DELTA_WARNING_THRESHOLD: 5,
        POLLING_INTERVAL_MS: 4000,
    },
    // --- Base (Mark pools as empty for now) ---
    base: {
        CHAIN_ID: 8453,
        RPC_URL: process.env.BASE_RPC_URL,
        SCAN_API_KEY: process.env.BASESCAN_API_KEY,
        EXPLORER_URL: "https://basescan.org",
        FLASH_SWAP_CONTRACT_ADDRESS: process.env.BASE_FLASH_SWAP_ADDRESS,
        QUOTER_V2_ADDRESS: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
        TOKENS: TOKENS.base,
        POOL_GROUPS: {
             WETH_USDC: { token0Address: TOKENS.base.WETH, token1Address: TOKENS.base.USDC, pools: [] }, // No pools found
             USDC_USDT: { token0Address: TOKENS.base.USDC, token1Address: TOKENS.base.USDT, pools: [] }, // Find pools if they exist
        },
        GAS_LIMIT_ESTIMATE: 1_000_000n,
        MIN_NET_PROFIT_TOKEN: TOKENS.base.WETH, // Profit currency
        MIN_NET_PROFIT_WEI: ethers.parseUnits("0.00001", 18), // In WETH Wei
        BORROW_TOKEN_SYMBOL: "WETH",
        BORROW_AMOUNT_STR: "0.1",
        MULTI_QUOTE_SIM_AMOUNT_STR: "0.0001",
        TICK_DELTA_WARNING_THRESHOLD: 5,
        POLLING_INTERVAL_MS: 3000,
    }
};

// --- Function to Get Config ---
function getConfig(networkName) {
    if (!networkName) throw new Error("Network name required");
    const lowerNetworkName = networkName.toLowerCase();
    if (!NETWORK_CONFIGS[lowerNetworkName]) throw new Error(`Config not found for network: ${networkName}`);

    const networkConfig = NETWORK_CONFIGS[lowerNetworkName];

    // Add Decimals Mapping to the config object for easy access
    networkConfig.DECIMALS = {};
    for (const tokenSymbol in networkConfig.TOKENS) {
        const address = networkConfig.TOKENS[tokenSymbol];
        networkConfig.DECIMALS[address] = DECIMALS[address.toLowerCase()] || 18; // Default 18 if not found
    }

    // Add derived borrow amounts (assuming default borrow token)
    const borrowTokenAddress = networkConfig.TOKENS[networkConfig.BORROW_TOKEN_SYMBOL];
    const borrowTokenDecimals = networkConfig.DECIMALS[borrowTokenAddress];
    if (!borrowTokenAddress || !borrowTokenDecimals) {
        console.warn(`[Config] Cannot derive borrow amounts: Default borrow token ${networkConfig.BORROW_TOKEN_SYMBOL} details missing for ${networkName}.`);
        networkConfig.BORROW_AMOUNT_WEI = 0n;
        networkConfig.MULTI_QUOTE_SIM_AMOUNT_WEI = 0n;
    } else {
        networkConfig.BORROW_AMOUNT_WEI = ethers.parseUnits(networkConfig.BORROW_AMOUNT_STR, borrowTokenDecimals);
        networkConfig.MULTI_QUOTE_SIM_AMOUNT_WEI = ethers.parseUnits(networkConfig.MULTI_QUOTE_SIM_AMOUNT_STR, borrowTokenDecimals);
    }

    // Add derived profit threshold (in wei of the specified profit token)
     const profitTokenAddress = networkConfig.MIN_NET_PROFIT_TOKEN;
     const profitTokenDecimals = networkConfig.DECIMALS[profitTokenAddress];
     if (!profitTokenAddress || !profitTokenDecimals) {
          console.warn(`[Config] Cannot derive min profit wei: MIN_NET_PROFIT_TOKEN details missing for ${networkName}.`);
          networkConfig.MIN_NET_PROFIT_WEI_CALCULATED = 0n; // Use pre-set MIN_NET_PROFIT_WEI as fallback?
     } else {
         // This assumes MIN_NET_PROFIT_WEI in config was already in WETH, needs adjustment if profit token is different
         // For now, let's assume MIN_NET_PROFIT_WEI is always specified in terms of the MIN_NET_PROFIT_TOKEN
         // If MIN_NET_PROFIT_TOKEN is USDC, MIN_NET_PROFIT_WEI should be parseUnits("0.1", 6) for $0.1 profit etc.
         // Let's keep the pre-calculated WETH one for now, requires more thought on config structure.
         networkConfig.MIN_NET_PROFIT_WEI_CALCULATED = networkConfig.MIN_NET_PROFIT_WEI;
     }


    // Validation (Simplified)
    if (!networkConfig.RPC_URL) console.warn(`[Config] RPC_URL missing for ${networkName}`);
    if (!networkConfig.QUOTER_V2_ADDRESS) console.warn(`[Config] QUOTER_V2_ADDRESS missing for ${networkName}`);

    return networkConfig;
}

module.exports = { getConfig }; // Export the function
