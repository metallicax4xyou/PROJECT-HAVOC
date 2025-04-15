// config/arbitrum.js
const { ethers } = require('ethers');

// --- Add Chainlink Feed Addresses ---
const CHAINLINK_FEEDS = {
    // Format: SYMBOL/ETH
    // Find addresses at: https://docs.chain.link/data-feeds/price-feeds/addresses?network=arbitrum
    'USDC/ETH': '0x50834F3163758fcC1Df9973b6e91f0F0F0434AD3', // Arbitrum USDC/ETH feed
    'USDT/ETH': '0x0A599A8555303467150f2aA046764Fa435551F76', // Arbitrum USDT/ETH feed
    // Add feeds for other tokens vs ETH as needed (e.g., WBTC/ETH)
};

const ARBITRUM_CONFIG = {
    // Define Tokens available on Arbitrum
    TOKENS: {
        WETH: { address: ethers.getAddress('0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'), decimals: 18, symbol: 'WETH' },
        USDC: { address: ethers.getAddress('0xaf88d065e77c8cC2239327C5EDb3A432268e5831'), decimals: 6, symbol: 'USDC' },
        USDT: { address: ethers.getAddress('0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9'), decimals: 6, symbol: 'USDT' },
        // Add other tokens if needed
    },

    // --- Expose Chainlink Feeds in Config ---
    CHAINLINK_FEEDS: CHAINLINK_FEEDS,

    // Define Pool Groups to monitor
    POOL_GROUPS: [
        {
            name: 'WETH_USDC',         // Unique name for the group
            token0Symbol: 'WETH',      // Symbol matching key in TOKENS above
            token1Symbol: 'USDC',      // Symbol matching key in TOKENS above
            borrowTokenSymbol: 'WETH', // Default token to borrow for this pair
            // --- Define minNetProfit in ETH (wei) ---
            minNetProfit: '1000000000000000', // Example: 0.001 ETH

            // --- Map Fee Tier (Number) to the Environment Variable Key ---
            // --- THIS SECTION WAS MISSING THE MAPPINGS ---
            feeTierToEnvMap: {
                100:   'ARBITRUM_WETH_USDC_100_ADDRESS',   // 0.01%
                500:   'ARBITRUM_WETH_USDC_500_ADDRESS',   // 0.05%
                3000:  'ARBITRUM_WETH_USDC_3000_ADDRESS',  // 0.30%
                10000: 'ARBITRUM_WETH_USDC_10000_ADDRESS', // 1.00%
            }
        },
        {
            name: 'USDC_USDT',
            token0Symbol: 'USDC',
            token1Symbol: 'USDT',
            borrowTokenSymbol: 'USDC', // Borrowing USDC
            // --- Define minNetProfit in ETH (wei) ---
            minNetProfit: '1000000000000000', // Example: 0.001 ETH (Same standard!)

            // --- Map Fee Tier (Number) to the Environment Variable Key ---
            // --- THIS SECTION WAS MISSING THE MAPPINGS ---
            feeTierToEnvMap: {
                100:   'ARBITRUM_USDC_USDT_100_ADDRESS', // 0.01%
                500:   'ARBITRUM_USDC_USDT_500_ADDRESS', // 0.05%
            }
        },
        // Add other groups like WETH/USDT if desired
    ],

    // Optional: Network-specific overrides for global settings
    // GAS_PRICE_MULTIPLIER: 1.2,
    // BLOCK_TIME_MS: 1000,
};

module.exports = ARBITRUM_CONFIG;
