// config/arbitrum.js
const { ethers } = require('ethers');

// --- Add Chainlink Feed Addresses ---
const CHAINLINK_FEEDS = {
    // Format: SYMBOL/ETH (or SYMBOL/USD if converting via USD)
    // Find addresses at: https://docs.chain.link/data-feeds/price-feeds/addresses?network=arbitrum
    'USDC/ETH': '0x50834F3163758fcC1Df9973b6e91f0F0F0434AD3', // Arbitrum USDC/ETH feed
    'USDT/ETH': '0x0A599A8555303467150f2aA046764Fa435551F76', // Arbitrum USDT/ETH feed (Check if this is the desired pair/address)
    // Add feeds for other tokens vs ETH as needed (e.g., WBTC/ETH)
};

const ARBITRUM_CONFIG = {
    TOKENS: {
        WETH: { address: ethers.getAddress('0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'), decimals: 18, symbol: 'WETH' },
        USDC: { address: ethers.getAddress('0xaf88d065e77c8cC2239327C5EDb3A432268e5831'), decimals: 6, symbol: 'USDC' },
        USDT: { address: ethers.getAddress('0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9'), decimals: 6, symbol: 'USDT' },
    },

    // --- Add Chainlink Feeds Here ---
    CHAINLINK_FEEDS: CHAINLINK_FEEDS,

    POOL_GROUPS: [
        {
            name: 'WETH_USDC',
            token0Symbol: 'WETH',
            token1Symbol: 'USDC',
            borrowTokenSymbol: 'WETH',
            // quoteTokenSymbol: 'USDC', // <-- No longer needed for profit calc if minNetProfit is ETH
            // --- Define minNetProfit in ETH (wei) ---
            minNetProfit: '1000000000000000', // Example: 0.001 ETH
            feeTierToEnvMap: {
                // ... fee tiers ...
            }
        },
        {
            name: 'USDC_USDT',
            token0Symbol: 'USDC',
            token1Symbol: 'USDT',
            borrowTokenSymbol: 'USDC', // Borrowing USDC
            // quoteTokenSymbol: 'USDC', // <-- No longer needed
            // --- Define minNetProfit in ETH (wei) ---
            minNetProfit: '1000000000000000', // Example: 0.001 ETH (Same standard!)
            feeTierToEnvMap: {
                // ... fee tiers ...
            }
        },
    ],
    // ... rest of config ...
};

module.exports = ARBITRUM_CONFIG;
