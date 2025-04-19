// config/arbitrum.js

// --- Add Chainlink Feed Addresses ---
const CHAINLINK_FEEDS = {
    // Format: SYMBOL/ETH
    // Find addresses at: https://docs.chain.link/data-feeds/price-feeds/addresses?network=arbitrum
    'USDC/ETH': '0x50834F3163758fcC1Df9973b6e91f0F0F0434AD3', // Arbitrum USDC/ETH feed
    'USDT/ETH': '0x0A599A8555303467150f2aA046764Fa435551F76', // Arbitrum USDT/ETH feed
    'ARB/ETH': '0xb2A824043730FE05F3DA2efaFa1CBbe83fa548D6',   // Arbitrum ARB/ETH feed
    'DAI/ETH': '0xcAE0036F347a9459510A411DA0937A21f5571D35',   // Arbitrum DAI/ETH feed
    'WBTC/ETH': '0x11A839134e1A4039F852F63D46475F1D5c049394', // Arbitrum WBTC/ETH feed
    // Add feeds for other tokens vs ETH if needed by ProfitCalculator
};

// --- Define Pool Groups to monitor ---
// NOTE: Ensure 'name' matches the prefix used in .env variable names (e.g., name: 'WETH_USDC' corresponds to ARBITRUM_WETH_USDC_xxx_ADDRESS)
const POOL_GROUPS = [
    {
        name: 'WETH_USDC',
        token0Symbol: 'WETH',
        token1Symbol: 'USDC',
        borrowTokenSymbol: 'WETH', // Default token to borrow for this pair
        minNetProfit: '1000000000000000', // Example: 0.001 ETH in Wei (string)
        feeTierToEnvMap: { // Maps fee tier (as string key) to env var name suffix
            '100':   'ARBITRUM_WETH_USDC_100_ADDRESS',
            '500':   'ARBITRUM_WETH_USDC_500_ADDRESS',
            '3000':  'ARBITRUM_WETH_USDC_3000_ADDRESS',
            '10000': 'ARBITRUM_WETH_USDC_10000_ADDRESS',
        }
    },
    {
        name: 'USDC_USDT',
        token0Symbol: 'USDC',
        token1Symbol: 'USDT',
        borrowTokenSymbol: 'USDC', // Borrowing USDC
        minNetProfit: '1000000000000000', // Example: 0.001 ETH in Wei (string)
        feeTierToEnvMap: {
            '100':   'ARBITRUM_USDC_USDT_100_ADDRESS',
            '500':   'ARBITRUM_USDC_USDT_500_ADDRESS', // Add if monitoring 500bps pool for this pair
        }
    },
    // --- ADDED GROUPS BASED ON .ENV POOLS ---
    {
        name: 'ARB_USDC',
        token0Symbol: 'ARB', // Ensure ARB is defined in constants/tokens.js
        token1Symbol: 'USDC',
        borrowTokenSymbol: 'USDC', // <<< DECIDE/VERIFY which token to borrow
        minNetProfit: '1000000000000000', // <<< SET desired profit in Wei
        feeTierToEnvMap: {
            '500': 'ARBITRUM_ARB_USDC_500_ADDRESS',
            // Add other fee tiers if needed (e.g., '3000': 'ARBITRUM_ARB_USDC_3000_ADDRESS')
        }
    },
    {
        name: 'USDC_DAI',
        token0Symbol: 'USDC',
        token1Symbol: 'DAI', // Ensure DAI is defined in constants/tokens.js
        borrowTokenSymbol: 'USDC', // <<< DECIDE/VERIFY which token to borrow
        minNetProfit: '1000000000000000', // <<< SET desired profit in Wei
        feeTierToEnvMap: {
            '100': 'ARBITRUM_USDC_DAI_100_ADDRESS',
        }
    },
    {
        name: 'WBTC_WETH',
        token0Symbol: 'WBTC', // Ensure WBTC is defined in constants/tokens.js
        token1Symbol: 'WETH',
        borrowTokenSymbol: 'WETH', // <<< DECIDE/VERIFY which token to borrow
        minNetProfit: '1000000000000000', // <<< SET desired profit in Wei
        feeTierToEnvMap: {
            '500': 'ARBITRUM_WBTC_WETH_500_ADDRESS',
        }
    },
    {
        name: 'WBTC_USDT',
        token0Symbol: 'WBTC',
        token1Symbol: 'USDT',
        borrowTokenSymbol: 'USDT', // <<< DECIDE/VERIFY which token to borrow
        minNetProfit: '1000000000000000', // <<< SET desired profit in Wei
        feeTierToEnvMap: {
            '500': 'ARBITRUM_WBTC_USDT_500_ADDRESS',
        }
    },
    {
        name: 'ARB_WETH',
        token0Symbol: 'ARB',
        token1Symbol: 'WETH',
        borrowTokenSymbol: 'WETH', // <<< DECIDE/VERIFY which token to borrow
        minNetProfit: '1000000000000000', // <<< SET desired profit in Wei
        feeTierToEnvMap: {
            '500': 'ARBITRUM_ARB_WETH_500_ADDRESS',
        }
    },
    {
        name: 'WETH_USDT',
        token0Symbol: 'WETH',
        token1Symbol: 'USDT',
        borrowTokenSymbol: 'WETH', // <<< DECIDE/VERIFY which token to borrow
        minNetProfit: '1000000000000000', // <<< SET desired profit in Wei
        feeTierToEnvMap: {
            '500': 'ARBITRUM_WETH_USDT_500_ADDRESS',
        }
    },
    // Add more groups here if needed for other pairs/strategies
];

// --- Combine and Export ---
const ARBITRUM_CONFIG = {
    CHAINLINK_FEEDS: CHAINLINK_FEEDS,
    POOL_GROUPS: POOL_GROUPS,
    // Optional: Network-specific overrides for global settings
    // GAS_PRICE_MULTIPLIER: 1.2,
    // BLOCK_TIME_MS: 1000,
};

module.exports = ARBITRUM_CONFIG;
