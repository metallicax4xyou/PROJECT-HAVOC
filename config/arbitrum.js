// config/arbitrum.js
// --- VERSION UPDATED TO ADD SUSHISWAP POOLS ---
// --- Modified WETH_USDC_SUSHI entry to use USDC.e and correct ENV variable ---

// --- Add Chainlink Feed Addresses ---
const CHAINLINK_FEEDS = {
    // ... (keep existing feeds) ...
    'USDC/ETH': '0x50834F3163758fcC1Df9973b6e91f0F0F0434AD3',
    'USDT/ETH': '0x0A599A8555303467150f2aA046764Fa435551F76',
    'ARB/ETH': '0xb2A824043730FE05F3DA2efaFa1CBbe83fa548D6',
    'DAI/ETH': '0xcAE0036F347a9459510A411DA0937A21f5571D35',
    'WBTC/ETH': '0x11A839134e1A4039F852F63D46475F1D5c049394',
};

// --- Define Uniswap V3 Pool Groups to monitor ---
const UNISWAP_V3_POOLS = [
    {
        name: 'WETH_USDC_V3', // Added V3 suffix for clarity
        token0Symbol: 'WETH',
        token1Symbol: 'USDC', // Native USDC
        borrowTokenSymbol: 'WETH',
        feeTierToEnvMap: {
            '100':   'ARBITRUM_WETH_USDC_100_ADDRESS',
            '500':   'ARBITRUM_WETH_USDC_500_ADDRESS',
            '3000':  'ARBITRUM_WETH_USDC_3000_ADDRESS',
            // '10000': 'ARBITRUM_WETH_USDC_10000_ADDRESS', // Keep commented if not used
        }
    },
    // ... (keep other V3 pools, maybe add _V3 suffix to names) ...
    {
        name: 'WBTC_WETH_V3',
        token0Symbol: 'WBTC',
        token1Symbol: 'WETH',
        borrowTokenSymbol: 'WETH',
        feeTierToEnvMap: {
            '500': 'ARBITRUM_WBTC_WETH_500_ADDRESS',
        }
    },
    // Add other V3 pools here if needed, matching the structure
];

// --- Define SushiSwap (V2 Style) Pools ---
// Get addresses from SushiSwap Analytics or directly from the Factory/Router contracts
const SUSHISWAP_POOLS = [
    {
        name: 'WETH_USDCe_SUSHI', // Renamed to reflect USDC.e
        token0Symbol: 'WETH',
        token1Symbol: 'USDC.e', // *** IMPORTANT: Use the symbol for Bridged USDC (USDC.e) ***
        // This now matches the variable in your .env file
        poolAddressEnv: 'ARBITRUM_SUSHI_WETH_USDC_E_ADDRESS'
    },
    {
        name: 'WBTC_WETH_SUSHI',
        token0Symbol: 'WBTC',
        token1Symbol: 'WETH',
        poolAddressEnv: 'ARBITRUM_SUSHI_WBTC_WETH_ADDRESS' // This was already correct
    },
    // Add other SushiSwap pools you want to monitor here
    {
        name: 'ARB_WETH_SUSHI',
        token0Symbol: 'ARB',
        token1Symbol: 'WETH',
        // Make sure ARBITRUM_SUSHI_ARB_WETH_ADDRESS is defined in your .env if you uncomment this
        poolAddressEnv: 'ARBITRUM_SUSHI_ARB_WETH_ADDRESS'
    },
];


// --- Combine and Export ---
const ARBITRUM_CONFIG = {
    CHAINLINK_FEEDS: CHAINLINK_FEEDS,
    UNISWAP_V3_POOLS: UNISWAP_V3_POOLS,
    SUSHISWAP_POOLS: SUSHISWAP_POOLS,

    // --- Global Settings ---
    MIN_PROFIT_THRESHOLD_ETH: '0.000000000000000001', // Keep 1 Wei for testing
    MAX_GAS_GWEI: '0.5',
    GAS_ESTIMATE_BUFFER_PERCENT: 20,
    FALLBACK_GAS_LIMIT: '3000000',
    PROFIT_BUFFER_PERCENT: 10,

    // Define SushiSwap Router Address - Get from Sushi Docs for Arbitrum
    SUSHISWAP_ROUTER_ADDRESS: process.env.ARBITRUM_SUSHISWAP_ROUTER_ADDRESS || '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',

};

module.exports = ARBITRUM_CONFIG;
