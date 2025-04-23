// config/arbitrum.js
// --- VERSION v3.1 ---
// Uses only ETH/USD feed for Chainlink configuration.
// Corrected Sushi/DODO fees. Includes Gas Estimates.

// --- Chainlink Feed Addresses (Arbitrum Mainnet) ---
// Define only the ETH/USD feed. PriceFeed utility will derive others.
const CHAINLINK_FEEDS_CONFIG = {
    'ETH/USD': '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612', // Verified Arbitrum ETH/USD
    // Add other /USD feeds here ONLY IF priceFeed logic is updated to use them for non-stables
    // 'WBTC/USD': '0x6ce185860a4963106506C203335A2910413708e9',
    // 'LINK/USD': '0x86E53CF1B870786351Da77A57575e79CB55812CB',
    // etc.
};

// --- Define Uniswap V3 Pool Groups ---
const UNISWAP_V3_POOLS = [
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

// --- Define SushiSwap Pools (Corrected Fees: 30 bps) ---
const SUSHISWAP_POOLS = [
    { name: 'WETH_USDCe_SUSHI', token0Symbol: 'WETH', token1Symbol: 'USDC.e', fee: 30, poolAddressEnv: 'ARBITRUM_SUSHI_WETH_USDC_E_ADDRESS' },
    { name: 'WBTC_WETH_SUSHI', token0Symbol: 'WBTC', token1Symbol: 'WETH', fee: 30, poolAddressEnv: 'ARBITRUM_SUSHI_WBTC_WETH_ADDRESS' },
    { name: 'ARB_WETH_SUSHI', token0Symbol: 'ARB', token1Symbol: 'WETH', fee: 30, poolAddressEnv: 'ARBITRUM_SUSHI_ARB_WETH_ADDRESS' },
    { name: 'WETH_USDT_SUSHI', token0Symbol: 'WETH', token1Symbol: 'USDT', fee: 30, poolAddressEnv: 'ARBITRUM_SUSHI_WETH_USDT_ADDRESS' },
    { name: 'WETH_LINK_SUSHI', token0Symbol: 'WETH', token1Symbol: 'LINK', fee: 30, poolAddressEnv: 'ARBITRUM_SUSHI_WETH_LINK_ADDRESS' },
    { name: 'GMX_WETH_SUSHI', token0Symbol: 'GMX', token1Symbol: 'WETH', fee: 30, poolAddressEnv: 'ARBITRUM_SUSHI_GMX_WETH_ADDRESS' },
    { name: 'MAGIC_WETH_SUSHI', token0Symbol: 'MAGIC', token1Symbol: 'WETH', fee: 30, poolAddressEnv: 'ARBITRUM_SUSHI_MAGIC_WETH_ADDRESS' },
];

// --- Define DODO Pools (Corrected Fees - Verify!) ---
const DODO_POOLS = [
    { name: 'WETH_USDCE_DODO', token0Symbol: 'WETH', token1Symbol: 'USDC.e', baseTokenSymbol: 'WETH', poolAddressEnv: 'ARBITRUM_DODO_WETH_USDCE_ADDRESS', fee: 100 }, // Assuming 0.1% = 100 bps
    { name: 'USDT_USDCE_DODO', token0Symbol: 'USDT', token1Symbol: 'USDC.e', baseTokenSymbol: 'USDT', poolAddressEnv: 'ARBITRUM_DODO_USDT_USDCE_ADDRESS', fee: 10 }, // Assuming 0.01% = 10 bps
];

// --- Gas Cost Estimates ---
const GAS_COST_ESTIMATES = {
    FLASH_SWAP_BASE: 350000n,
    UNISWAP_V3_SWAP: 180000n,
    SUSHISWAP_V2_SWAP: 120000n,
    DODO_SWAP: 200000n,
};

// --- Combine and Export ---
const ARBITRUM_CONFIG = {
    CHAINLINK_FEEDS: CHAINLINK_FEEDS_CONFIG, // Use the object containing only ETH/USD
    UNISWAP_V3_POOLS: UNISWAP_V3_POOLS,
    SUSHISWAP_POOLS: SUSHISWAP_POOLS,
    DODO_POOLS: DODO_POOLS,
    GAS_COST_ESTIMATES: GAS_COST_ESTIMATES,

    // Global Settings (Defaults if not set in .env)
    MIN_PROFIT_THRESHOLDS: { NATIVE: '0.001', DEFAULT: '0.0005', /* Add others if needed */ },
    MAX_GAS_GWEI: 1,
    GAS_ESTIMATE_BUFFER_PERCENT: 25,
    FALLBACK_GAS_LIMIT: 3000000,
    PROFIT_BUFFER_PERCENT: 10,
    SUSHISWAP_ROUTER_ADDRESS: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
};

module.exports = ARBITRUM_CONFIG;
