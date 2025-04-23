// config/arbitrum.js
// --- VERSION WITH CORRECTED CHAINLINK FEED STRATEGY (USD-based) ---

// --- Chainlink Feed Addresses (Arbitrum Mainnet - USD BASED) ---
// We will derive Token/ETH prices from Token/USD and ETH/USD feeds.
const CHAINLINK_FEEDS_USD = {
    // Native Token vs USD
    'ETH/USD': '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612',
    // Stablecoins vs USD (Note: USDC feed address IS the USDC/USD feed)
    'USDC/USD': '0x50834F3163758fcC1Df9973b6e91f0F0F0434AD3',
    'USDT/USD': '0x3f3f5dF88dC9F13eac63DF89EC16ef6e7E25DdE7', // Needed if USDT is profit token
    'DAI/USD': '0xc5C8E77B397E531B8EC06BFb0048328B30E9eCfB',   // Needed if DAI is profit token
    // Other Major Tokens vs USD (Add if needed for profit conversion)
    'WBTC/USD': '0x6ce185860a4963106506C203335A2910413708e9',
    'LINK/USD': '0x86E53CF1B870786351Da77A57575e79CB55812CB',
    'ARB/USD': '0xb2A824043730FE05F3DA2efaFa1CBbe83fa548D6',
    // Add GMX/USD, MAGIC/USD, FRAX/USD if directly available and needed
};
// We will pass this object to the priceFeed utility.
// The utility will handle looking up TOKEN/USD and ETH/USD to calculate TOKEN/ETH.

// --- Define Uniswap V3 Pool Groups ---
const UNISWAP_V3_POOLS = [ /* ... unchanged V3 pool definitions ... */
    { name: 'WETH_USDC_V3', token0Symbol: 'WETH', token1Symbol: 'USDC', feeTierToEnvMap: { '100': 'ARBITRUM_WETH_USDC_100_ADDRESS', '500': 'ARBITRUM_WETH_USDC_500_ADDRESS', '3000': 'ARBITRUM_WETH_USDC_3000_ADDRESS' } },
    { name: 'WBTC_WETH_V3', token0Symbol: 'WBTC', token1Symbol: 'WETH', feeTierToEnvMap: { '500': 'ARBITRUM_WBTC_WETH_500_ADDRESS' } },
    { name: 'WETH_USDT_V3', token0Symbol: 'WETH', token1Symbol: 'USDT', feeTierToEnvMap: { '500': 'ARBITRUM_WETH_USDT_500_ADDRESS' } },
    { name: 'USDC_USDT_V3', token0Symbol: 'USDC', token1Symbol: 'USDT', feeTierToEnvMap: { '100': 'ARBITRUM_USDC_USDT_100_ADDRESS' } },
    { name: 'USDC_DAI_V3', token0Symbol: 'USDC', token1Symbol: 'DAI', feeTierToEnvMap: { '100': 'ARBITRUM_USDC_DAI_100_ADDRESS' } },
    { name: 'FRAX_USDT_V3', token0Symbol: 'FRAX', token1Symbol: 'USDT', feeTierToEnvMap: { '500': 'ARBITRUM_FRAX_USDT_500_ADDRESS' } },
    { name: 'WETH_LINK_V3', token0Symbol: 'WETH', token1Symbol: 'LINK', feeTierToEnvMap: { '3000': 'ARBITRUM_WETH_LINK_3000_ADDRESS', '10000': 'ARBITRUM_WETH_LINK_10000_ADDRESS' } },
    { name: 'GMX_WETH_V3', token0Symbol: 'GMX', token1Symbol: 'WETH', feeTierToEnvMap: { '3000': 'ARBITRUM_GMX_WETH_3000_ADDRESS', '10000': 'ARBITRUM_GMX_WETH_10000_ADDRESS' } },
    { name: 'MAGIC_WETH_V3', token0Symbol: 'MAGIC', token1Symbol: 'WETH', feeTierToEnvMap: { '3000': 'ARBITRUM_MAGIC_WETH_3000_ADDRESS' } },
];

// --- Define SushiSwap Pools (Corrected Fees) ---
const SUSHISWAP_POOLS = [ /* ... unchanged V2 pool definitions with fee: 30 ... */
    { name: 'WETH_USDCe_SUSHI', token0Symbol: 'WETH', token1Symbol: 'USDC.e', fee: 30, poolAddressEnv: 'ARBITRUM_SUSHI_WETH_USDC_E_ADDRESS' },
    { name: 'WBTC_WETH_SUSHI', token0Symbol: 'WBTC', token1Symbol: 'WETH', fee: 30, poolAddressEnv: 'ARBITRUM_SUSHI_WBTC_WETH_ADDRESS' },
    { name: 'ARB_WETH_SUSHI', token0Symbol: 'ARB', token1Symbol: 'WETH', fee: 30, poolAddressEnv: 'ARBITRUM_SUSHI_ARB_WETH_ADDRESS' },
    { name: 'WETH_USDT_SUSHI', token0Symbol: 'WETH', token1Symbol: 'USDT', fee: 30, poolAddressEnv: 'ARBITRUM_SUSHI_WETH_USDT_ADDRESS' },
    { name: 'WETH_LINK_SUSHI', token0Symbol: 'WETH', token1Symbol: 'LINK', fee: 30, poolAddressEnv: 'ARBITRUM_SUSHI_WETH_LINK_ADDRESS' },
    { name: 'GMX_WETH_SUSHI', token0Symbol: 'GMX', token1Symbol: 'WETH', fee: 30, poolAddressEnv: 'ARBITRUM_SUSHI_GMX_WETH_ADDRESS' },
    { name: 'MAGIC_WETH_SUSHI', token0Symbol: 'MAGIC', token1Symbol: 'WETH', fee: 30, poolAddressEnv: 'ARBITRUM_SUSHI_MAGIC_WETH_ADDRESS' },
];

// --- Define DODO Pools (Corrected Fees) ---
const DODO_POOLS = [ /* ... unchanged DODO pool definitions with fee: 100 / 10 ... */
    { name: 'WETH_USDCE_DODO', token0Symbol: 'WETH', token1Symbol: 'USDC.e', baseTokenSymbol: 'WETH', poolAddressEnv: 'ARBITRUM_DODO_WETH_USDCE_ADDRESS', fee: 100 }, // 0.1%? Verify
    { name: 'USDT_USDCE_DODO', token0Symbol: 'USDT', token1Symbol: 'USDC.e', baseTokenSymbol: 'USDT', poolAddressEnv: 'ARBITRUM_DODO_USDT_USDCE_ADDRESS', fee: 10 }, // 0.01%? Verify
];

// --- Gas Cost Estimates ---
const GAS_COST_ESTIMATES = { /* ... unchanged ... */
    FLASH_SWAP_BASE: 350000n, UNISWAP_V3_SWAP: 180000n, SUSHISWAP_V2_SWAP: 120000n, DODO_SWAP: 200000n,
};

// --- Combine and Export ---
const ARBITRUM_CONFIG = {
    // *** Use the USD feed config ***
    CHAINLINK_FEEDS: CHAINLINK_FEEDS_USD,
    UNISWAP_V3_POOLS: UNISWAP_V3_POOLS,
    SUSHISWAP_POOLS: SUSHISWAP_POOLS,
    DODO_POOLS: DODO_POOLS,
    GAS_COST_ESTIMATES: GAS_COST_ESTIMATES,

    // Global Settings Defaults
    MIN_PROFIT_THRESHOLDS: { NATIVE: '0.001', DEFAULT: '0.0005', /* Add other tokens if profit measured in them */ },
    MAX_GAS_GWEI: 1,
    GAS_ESTIMATE_BUFFER_PERCENT: 25,
    FALLBACK_GAS_LIMIT: 3000000,
    PROFIT_BUFFER_PERCENT: 10,
    SUSHISWAP_ROUTER_ADDRESS: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
};

module.exports = ARBITRUM_CONFIG;
