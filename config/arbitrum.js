// config/arbitrum.js
// --- VERSION v3.4 ---
// Adds AAVE V3 Pool Address and Fee BPS.

const { ethers } = require('ethers'); // Required for FINDER_SETTINGS

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
];

// --- Define SushiSwap Pools ---
const SUSHISWAP_POOLS = [
    { name: 'WETH_USDCe_SUSHI', token0Symbol: 'WETH', token1Symbol: 'USDC.e', fee: 30, poolAddressEnv: 'ARBITRUM_SUSHI_WETH_USDC_E_ADDRESS' },
    { name: 'WBTC_WETH_SUSHI', token0Symbol: 'WBTC', token1Symbol: 'WETH', fee: 30, poolAddressEnv: 'ARBITRUM_SUSHI_WBTC_WETH_ADDRESS' },
    { name: 'WETH_USDT_SUSHI', token0Symbol: 'WETH', token1Symbol: 'USDT', fee: 30, poolAddressEnv: 'ARBITRUM_SUSHI_WETH_USDT_ADDRESS' },
];

// --- Define DODO Pools ---
const DODO_POOLS = [
    { name: 'WETH_USDCE_DODO', token0Symbol: 'WETH', token1Symbol: 'USDC.e', baseTokenSymbol: 'WETH', poolAddressEnv: 'ARBITRUM_DODO_WETH_USDCE_ADDRESS', fee: 100 },
    { name: 'USDT_USDCE_DODO', token0Symbol: 'USDT', token1Symbol: 'USDC.e', baseTokenSymbol: 'USDT', poolAddressEnv: 'ARBITRUM_DODO_USDT_USDCE_ADDRESS', fee: 10 },
];

// --- Gas Cost Estimates ---
const GAS_COST_ESTIMATES = {
    FLASH_SWAP_BASE: 350000n, // Might need separate base costs for UniV3 vs Aave later
    UNISWAP_V3_SWAP: 180000n,
    SUSHISWAP_V2_SWAP: 120000n,
    DODO_SWAP: 200000n,
};

// --- Combine and Export ---
const ARBITRUM_CONFIG = {
    // Network Specific Contracts & Feeds
    CHAINLINK_FEEDS: CHAINLINK_FEEDS_CONFIG,
    AAVE_POOL_ADDRESS: process.env.ARBITRUM_AAVE_POOL_ADDRESS || "0x794a61358D6845594F94dc1DB02A252b5b4814aD", // Load Aave Pool address from env, fallback to known value
    SUSHISWAP_ROUTER_ADDRESS: process.env.ARBITRUM_SUSHISWAP_ROUTER_ADDRESS || '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506', // Load Sushi Router address from env

    // Pool Definitions
    UNISWAP_V3_POOLS: UNISWAP_V3_POOLS,
    SUSHISWAP_POOLS: SUSHISWAP_POOLS,
    DODO_POOLS: DODO_POOLS,

    // Gas & Profitability Settings
    GAS_COST_ESTIMATES: GAS_COST_ESTIMATES,
    MIN_PROFIT_THRESHOLDS: { NATIVE: 0.00005, DEFAULT: 0.00005 }, // Use numbers
    MAX_GAS_GWEI: 1, // Max gas price in Gwei
    GAS_ESTIMATE_BUFFER_PERCENT: 25, // % buffer added to path-based gas limit
    FALLBACK_GAS_LIMIT: 5000000, // Default gas limit if base estimate missing
    PROFIT_BUFFER_PERCENT: 10, // % buffer applied to net profit before comparing vs threshold

    // Finder Specific Settings
    FINDER_SETTINGS: {
        SPATIAL_MIN_NET_PRICE_DIFFERENCE_BIPS: 0n,
        SPATIAL_MAX_REASONABLE_PRICE_DIFF_BIPS: 5000n,
        SPATIAL_SIMULATION_INPUT_AMOUNTS: {
            'USDC':   ethers.parseUnits('100', 6),
            'USDC.e': ethers.parseUnits('100', 6),
            'USDT':   ethers.parseUnits('100', 6),
            'DAI':    ethers.parseUnits('100', 18),
            'WETH':   ethers.parseUnits('0.1', 18),
            'WBTC':   ethers.parseUnits('0.005', 8),
            'DEFAULT': ethers.parseUnits('0.1', 18)
        },
    },

    // Flash Loan Fees
    AAVE_FLASH_LOAN_FEE_BPS: 9n, // 0.09% as BigInt BPS
    UNIV3_FLASH_LOAN_FEE_BPS: 0n, // Uniswap V3 flash fee is paid via gas/swap fees

};

module.exports = ARBITRUM_CONFIG;
