// config/arbitrum.js
// --- VERSION v3.2 ---
// Adds FINDER_SETTINGS for SpatialFinder configuration.

const { ethers } = require('ethers'); // <<< ADDED IMPORT

// --- Chainlink Feed Addresses (Arbitrum Mainnet) ---
const CHAINLINK_FEEDS_CONFIG = {
    'ETH/USD': '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612', // Verified Arbitrum ETH/USD
};

// --- Define Uniswap V3 Pool Groups ---
const UNISWAP_V3_POOLS = [
    { name: 'WETH_USDC_V3', token0Symbol: 'WETH', token1Symbol: 'USDC', borrowTokenSymbol: 'WETH', feeTierToEnvMap: { '100': 'ARBITRUM_WETH_USDC_100_ADDRESS', '500': 'ARBITRUM_WETH_USDC_500_ADDRESS', '3000': 'ARBITRUM_WETH_USDC_3000_ADDRESS' } },
    { name: 'WBTC_WETH_V3', token0Symbol: 'WBTC', token1Symbol: 'WETH', borrowTokenSymbol: 'WETH', feeTierToEnvMap: { '500': 'ARBITRUM_WBTC_WETH_500_ADDRESS' } },
    { name: 'WETH_USDT_V3', token0Symbol: 'WETH', token1Symbol: 'USDT', borrowTokenSymbol: 'WETH', feeTierToEnvMap: { '500': 'ARBITRUM_WETH_USDT_500_ADDRESS' } },
    { name: 'USDC_USDT_V3', token0Symbol: 'USDC', token1Symbol: 'USDT', borrowTokenSymbol: 'USDC', feeTierToEnvMap: { '100': 'ARBITRUM_USDC_USDT_100_ADDRESS' } },
    { name: 'USDC_DAI_V3', token0Symbol: 'USDC', token1Symbol: 'DAI', borrowTokenSymbol: 'USDC', feeTierToEnvMap: { '100': 'ARBITRUM_USDC_DAI_100_ADDRESS' } },
    // { name: 'FRAX_USDT_V3', token0Symbol: 'FRAX', token1Symbol: 'USDT', borrowTokenSymbol: 'USDT', feeTierToEnvMap: { '500': 'ARBITRUM_FRAX_USDT_500_ADDRESS' } }, // Example if FRAX is defined in TOKENS
    // { name: 'WETH_LINK_V3', token0Symbol: 'WETH', token1Symbol: 'LINK', borrowTokenSymbol: 'WETH', feeTierToEnvMap: { '3000': 'ARBITRUM_WETH_LINK_3000_ADDRESS', '10000': 'ARBITRUM_WETH_LINK_10000_ADDRESS' } }, // Example if LINK is defined
    // { name: 'GMX_WETH_V3', token0Symbol: 'GMX', token1Symbol: 'WETH', borrowTokenSymbol: 'WETH', feeTierToEnvMap: { '3000': 'ARBITRUM_GMX_WETH_3000_ADDRESS', '10000': 'ARBITRUM_GMX_WETH_10000_ADDRESS' } }, // Example if GMX is defined
    // { name: 'MAGIC_WETH_V3', token0Symbol: 'MAGIC', token1Symbol: 'WETH', borrowTokenSymbol: 'WETH', feeTierToEnvMap: { '3000': 'ARBITRUM_MAGIC_WETH_3000_ADDRESS' } }, // Example if MAGIC is defined
];

// --- Define SushiSwap Pools (Corrected Fees: 30 bps) ---
const SUSHISWAP_POOLS = [
    { name: 'WETH_USDCe_SUSHI', token0Symbol: 'WETH', token1Symbol: 'USDC.e', fee: 30, poolAddressEnv: 'ARBITRUM_SUSHI_WETH_USDC_E_ADDRESS' },
    { name: 'WBTC_WETH_SUSHI', token0Symbol: 'WBTC', token1Symbol: 'WETH', fee: 30, poolAddressEnv: 'ARBITRUM_SUSHI_WBTC_WETH_ADDRESS' },
    // { name: 'ARB_WETH_SUSHI', token0Symbol: 'ARB', token1Symbol: 'WETH', fee: 30, poolAddressEnv: 'ARBITRUM_SUSHI_ARB_WETH_ADDRESS' }, // Example if ARB defined
    { name: 'WETH_USDT_SUSHI', token0Symbol: 'WETH', token1Symbol: 'USDT', fee: 30, poolAddressEnv: 'ARBITRUM_SUSHI_WETH_USDT_ADDRESS' },
    // { name: 'WETH_LINK_SUSHI', token0Symbol: 'WETH', token1Symbol: 'LINK', fee: 30, poolAddressEnv: 'ARBITRUM_SUSHI_WETH_LINK_ADDRESS' }, // Example if LINK defined
    // { name: 'GMX_WETH_SUSHI', token0Symbol: 'GMX', token1Symbol: 'WETH', fee: 30, poolAddressEnv: 'ARBITRUM_SUSHI_GMX_WETH_ADDRESS' }, // Example if GMX defined
    // { name: 'MAGIC_WETH_SUSHI', token0Symbol: 'MAGIC', token1Symbol: 'WETH', fee: 30, poolAddressEnv: 'ARBITRUM_SUSHI_MAGIC_WETH_ADDRESS' },// Example if MAGIC defined
];

// --- Define DODO Pools (Corrected Fees - Verify!) ---
const DODO_POOLS = [
    { name: 'WETH_USDCE_DODO', token0Symbol: 'WETH', token1Symbol: 'USDC.e', baseTokenSymbol: 'WETH', poolAddressEnv: 'ARBITRUM_DODO_WETH_USDCE_ADDRESS', fee: 100 }, // Assuming 0.1% = 100 bps
    { name: 'USDT_USDCE_DODO', token0Symbol: 'USDT', token1Symbol: 'USDC.e', baseTokenSymbol: 'USDT', poolAddressEnv: 'ARBITRUM_DODO_USDT_USDCE_ADDRESS', fee: 10 }, // Assuming 0.01% = 10 bps
];

// --- Gas Cost Estimates (Tune these based on observation!) ---
const GAS_COST_ESTIMATES = {
    FLASH_SWAP_BASE: 350000n,     // Base cost for flash loan callback, internal logic, repayment
    UNISWAP_V3_SWAP: 180000n,     // Estimated gas for a single V3 swap hop within the contract
    SUSHISWAP_V2_SWAP: 120000n,   // Estimated gas for a single V2 swap hop (TBD if used)
    DODO_SWAP: 200000n,          // Estimated gas for a single DODO swap hop (TBD if used)
};

// --- Combine and Export ---
const ARBITRUM_CONFIG = {
    CHAINLINK_FEEDS: CHAINLINK_FEEDS_CONFIG,
    UNISWAP_V3_POOLS: UNISWAP_V3_POOLS,
    SUSHISWAP_POOLS: SUSHISWAP_POOLS,
    DODO_POOLS: DODO_POOLS,
    GAS_COST_ESTIMATES: GAS_COST_ESTIMATES,

    // --- Added FINDER_SETTINGS ---
    FINDER_SETTINGS: {
        SPATIAL_MIN_NET_PRICE_DIFFERENCE_BIPS: 5n, // 0.05% threshold (BigInt) - Minimum profit margin BEFORE gas
        SPATIAL_MAX_REASONABLE_PRICE_DIFF_BIPS: 5000n, // 50% sanity check (BigInt)
        // Define simulation amounts using ethers.parseUnits
        SPATIAL_SIMULATION_INPUT_AMOUNTS: {
            'USDC':   ethers.parseUnits('100', 6),
            'USDC.e': ethers.parseUnits('100', 6),
            'USDT':   ethers.parseUnits('100', 6),
            'DAI':    ethers.parseUnits('100', 18),
            'WETH':   ethers.parseUnits('0.1', 18), // Base amounts for simulation
            'WBTC':   ethers.parseUnits('0.005', 8),
            // Add other relevant tokens you expect to borrow for spatial trades
            'DEFAULT': ethers.parseUnits('0.1', 18) // Fallback amount (0.1 WETH) if borrow token not specified above
        },
    },
    // --- End FINDER_SETTINGS ---

    // Global Settings (Defaults if not set in .env)
    MIN_PROFIT_THRESHOLDS: {
         NATIVE: '0.001', // Minimum profit in ETH after gas and buffers
         DEFAULT: '0.0005', // Default threshold if NATIVE not specified (also ETH)
         // Add token-specific thresholds if needed, e.g., 'USDC': '1.0' (minimum 1 USDC profit)
    },
    MAX_GAS_GWEI: 1, // Max gas price in Gwei the bot will tolerate submitting a TX with
    GAS_ESTIMATE_BUFFER_PERCENT: 25, // % buffer added to path-based gas limit estimate
    FALLBACK_GAS_LIMIT: 3000000, // Default gas limit if base estimate missing (should not happen ideally)
    PROFIT_BUFFER_PERCENT: 10, // % buffer applied to net profit before comparing vs threshold (accounts for slight price moves)
    SUSHISWAP_ROUTER_ADDRESS: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506', // Arbitrum Sushi Router
};

module.exports = ARBITRUM_CONFIG;
