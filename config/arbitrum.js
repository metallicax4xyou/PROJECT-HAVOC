// config/arbitrum.js
// --- VERSION UPDATED FOR TESTING (Lowered Min Profit) ---

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
const POOL_GROUPS = [
    {
        name: 'WETH_USDC',
        token0Symbol: 'WETH',
        token1Symbol: 'USDC',
        borrowTokenSymbol: 'WETH',
        feeTierToEnvMap: {
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
        borrowTokenSymbol: 'USDC',
        feeTierToEnvMap: {
            '100':   'ARBITRUM_USDC_USDT_100_ADDRESS',
            '500':   'ARBITRUM_USDC_USDT_500_ADDRESS',
        }
    },
    {
        name: 'ARB_USDC',
        token0Symbol: 'ARB',
        token1Symbol: 'USDC',
        borrowTokenSymbol: 'USDC',
        feeTierToEnvMap: {
            '500': 'ARBITRUM_ARB_USDC_500_ADDRESS',
        }
    },
    {
        name: 'USDC_DAI',
        token0Symbol: 'USDC',
        token1Symbol: 'DAI',
        borrowTokenSymbol: 'USDC',
        feeTierToEnvMap: {
            '100': 'ARBITRUM_USDC_DAI_100_ADDRESS',
        }
    },
    {
        name: 'WBTC_WETH',
        token0Symbol: 'WBTC',
        token1Symbol: 'WETH',
        borrowTokenSymbol: 'WETH',
        feeTierToEnvMap: {
            '500': 'ARBITRUM_WBTC_WETH_500_ADDRESS',
        }
    },
    {
        name: 'WBTC_USDT',
        token0Symbol: 'WBTC',
        token1Symbol: 'USDT',
        borrowTokenSymbol: 'USDT',
        feeTierToEnvMap: {
            '500': 'ARBITRUM_WBTC_USDT_500_ADDRESS',
        }
    },
    {
        name: 'ARB_WETH',
        token0Symbol: 'ARB',
        token1Symbol: 'WETH',
        borrowTokenSymbol: 'WETH',
        feeTierToEnvMap: {
            '500': 'ARBITRUM_ARB_WETH_500_ADDRESS',
        }
    },
    {
        name: 'WETH_USDT',
        token0Symbol: 'WETH',
        token1Symbol: 'USDT',
        borrowTokenSymbol: 'WETH',
        feeTierToEnvMap: {
            '500': 'ARBITRUM_WETH_USDT_500_ADDRESS',
        }
    },
];

// --- Combine and Export ---
const ARBITRUM_CONFIG = {
    CHAINLINK_FEEDS: CHAINLINK_FEEDS,
    POOL_GROUPS: POOL_GROUPS,

    // --- Global Settings ---
    // *** TEMPORARILY LOWERED FOR TESTING ***
    MIN_PROFIT_THRESHOLD_ETH: '0.000000000000000001', // Set to 1 Wei (near zero)
    // *** RESTORE THIS VALUE AFTER TESTING ***
    // MIN_PROFIT_THRESHOLD_ETH: '0.0005', // Original Value

    MAX_GAS_GWEI: '0.5',               // Maximum gas price (maxFeePerGas) in GWEI

    // Gas Estimation Settings
    GAS_ESTIMATE_BUFFER_PERCENT: 20,
    FALLBACK_GAS_LIMIT: '3000000',

    // Profit Calculation Settings
    PROFIT_BUFFER_PERCENT: 10,

    // --- Optional Settings ---
    // NATIVE_DECIMALS: 18,
    // NATIVE_SYMBOL: 'ETH',
    // WRAPPED_NATIVE_SYMBOL: 'WETH',
};

module.exports = ARBITRUM_CONFIG;
