// config/localfork.js
// --- VERSION v1.3 --- Moved MIN_PROFIT_THRESHOLDS inside the export object and added entries for all tokens.
// Configuration for the local Hardhat Fork of Arbitrum.
// Mostly mirrors arbitrum.js, but explicitly sets the FlashSwap contract address.

const { ethers } = require('ethers'); // Required for FINDER_SETTINGS

// --- Chainlink Feed Addresses (Arbitrum Mainnet - used on fork) ---
// Copying from arbitrum.js
const CHAINLINK_FEEDS_CONFIG = {
    'ETH/USD': '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612', // Verified Arbitrum ETH/USD
};

// --- Define Uniswap V3 Pool Groups (Arbitrum - used on fork) ---
// Copying from arbitrum.js
const UNISWAP_V3_POOLS = [
    { name: 'WETH_USDC_V3', token0Symbol: 'WETH', token1Symbol: 'USDC', borrowTokenSymbol: 'WETH', feeTierToEnvMap: { '100': 'ARBITRUM_WETH_USDC_100_ADDRESS', '500': 'ARBITRUM_WETH_USDC_500_ADDRESS', '3000': 'ARBITRUM_WETH_USDC_3000_ADDRESS' } },
    { name: 'WBTC_WETH_V3', token0Symbol: 'WBTC', token1Symbol: 'WETH', borrowTokenSymbol: 'WETH', feeTierToEnvMap: { '500': 'ARBITRUM_WBTC_WETH_500_ADDRESS' } },
    { name: 'WETH_USDT_V3', token0Symbol: 'WETH', token1Symbol: 'USDT', borrowTokenSymbol: 'WETH', feeTierToEnvMap: { '500': 'ARBITRUM_WETH_USDT_500_ADDRESS' } },
    { name: 'USDC_USDT_V3', token0Symbol: 'USDC', token1Symbol: 'USDT', borrowTokenSymbol: 'USDC', feeTierToEnvMap: { '100': 'ARBITRUM_USDC_USDT_100_ADDRESS' } },
    { name: 'USDC_DAI_V3', token0Symbol: 'USDC', token1Symbol: 'DAI', borrowTokenSymbol: 'USDC', feeTierToEnvMap: { '100': 'ARBITRUM_USDC_DAI_100_ADDRESS' } },
];

// --- Define SushiSwap Pools (Arbitrum - used on fork) ---
// Copying from arbitrum.js
const SUSHISWAP_POOLS = [
    { name: 'WETH_USDCe_SUSHI', token0Symbol: 'WETH', token1Symbol: 'USDC.e', fee: 30, poolAddressEnv: 'ARBITRUM_SUSHI_WETH_USDC_E_ADDRESS' },
    { name: 'WBTC_WETH_SUSHI', token0Symbol: 'WBTC', token1Symbol: 'WETH', fee: 30, poolAddressEnv: 'ARBITRUM_SUSHI_WBTC_WETH_ADDRESS' },
    { name: 'WETH_USDT_SUSHI', token0Symbol: 'WETH', token1Symbol: 'USDT', fee: 30, poolAddressEnv: 'ARBITRUM_SUSHI_WETH_USDT_ADDRESS' },
];

// --- Define DODO Pools (Arbitrum - used on fork) ---
// Copying from arbitrum.js
const DODO_POOLS = [
    { name: 'WETH_USDCE_DODO', token0Symbol: 'WETH', token1Symbol: 'USDC.e', baseTokenSymbol: 'WETH', poolAddressEnv: 'ARBITRUM_DODO_WETH_USDCE_ADDRESS', fee: 100 },
    { name: 'USDT_USDCE_DODO', token0Symbol: 'USDT', token1Symbol: 'USDC.e', baseTokenSymbol: 'USDT', poolAddressEnv: 'ARBITRUM_DODO_USDT_USDCE_ADDRESS', fee: 10 },
];

// --- Gas Cost Estimates (Arbitrum - used on fork) ---
// Copying from arbitrum.js
const GAS_COST_ESTIMATES = {
    FLASH_SWAP_BASE: 350000n, // Might need separate base costs for UniV3 vs Aave later
    UNISWAP_V3_SWAP: 180000n,
    SUSHISWAP_V2_SWAP: 120000n,
    DODO_SWAP: 200000n,
};

// --- Finder Specific Settings (Arbitrum - used on fork) ---
// Copying from arbitrum.js
const FINDER_SETTINGS = {
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
};

// --- Flash Loan Fees (Arbitrum - used on fork) ---
// Copying from arbitrum.js
const AAVE_FLASH_LOAN_FEE_BPS = 9n; // 0.09% as BigInt BPS
const UNIV3_FLASH_LOAN_FEE_BPS = 0n; // Uniswap V3 flash fee is paid via gas/swap fees


// --- Combine and Export ---
const LOCAL_FORK_CONFIG = {
    // Network Specific Contracts & Feeds
    CHAINLINK_FEEDS: CHAINLINK_FEEDS_CONFIG,
    // Aave Pool address is the same as mainnet on the fork
    AAVE_POOL_ADDRESS: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    // Sushi Router address is the same as mainnet on the fork
    SUSHISWAP_ROUTER_ADDRESS: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
    // TickLens address is the same as mainnet on the fork
    TICKLENS_ADDRESS: '0xbfd8137f7d1516D3ea5cA83523914859ec47F573', // Uniswap V3 TickLens address
    // CRITICAL: The address where WE deployed FlashSwap on the local fork
    FLASH_SWAP_CONTRACT_ADDRESS: '0x2BF866DA3A8eEb90b288e6D434d319624263a24b', // <-- Update this if you redeploy!

    // Pool Definitions (using the copied arrays)
    UNISWAP_V3_POOLS: UNISWAP_V3_POOLS,
    SUSHISWAP_POOLS: SUSHISWAP_POOLS,
    DODO_POOLS: DODO_POOLS,

    // Gas & Profitability Settings (using the copied estimates and defaults)
    GAS_COST_ESTIMATES: GAS_COST_ESTIMATES,

    // --- MOVED INSIDE THE OBJECT AND ADDED ALL TOKEN ENTRIES ---
    MIN_PROFIT_THRESHOLDS: {
        NATIVE: 0.00005, // Threshold in native currency (ETH)
        DEFAULT: 0.00005, // Default threshold for tokens without specific entry (in Native equivalent)
        // Add entries for ALL tokens defined in TOKENS constant
        'WETH': 0.00005,
        'USDC': 0.00005,
        'USDC.e': 0.00005, // Use quotes for keys with dots
        'USDT': 0.00005,
        'ARB': 0.00005,
        'DAI': 0.00005,
        'WBTC': 0.00005,
        'LINK': 0.00005,
        'FRAX': 0.00005,
        'GMX': 0.00005,
        'MAGIC': 0.00005,
        // Ensure all tokens from ../constants/tokens.js are listed here
    },
    // --- ---

    MAX_GAS_GWEI: 1, // Max gas price in Gwei - May need tuning for local fork simulation
    GAS_ESTIMATE_BUFFER_PERCENT: 25, // % buffer added to path-based gas limit
    FALLBACK_GAS_LIMIT: 5000000, // Default gas limit if base estimate missing
    PROFIT_BUFFER_PERCENT: 10, // % buffer applied to net profit before comparing vs threshold

    // Finder Specific Settings (using the copied object)
    FINDER_SETTINGS: FINDER_SETTINGS,

    // Flash Loan Fees (using the copied values)
    AAVE_FLASH_LOAN_FEE_BPS: AAVE_FLASH_LOAN_FEE_BPS,
    UNIV3_FLASH_LOAN_FEE_BPS: UNIV3_FLASH_LOAN_FEE_BPS,

    // Borrow Amounts - Use the same defaults as Arbitrum for consistency
    BORROW_AMOUNTS: {
        'USDC':   100,
        'USDC.e': 100,
        'USDT':   100,
        'DAI':    100,
        'WETH':   0.1,
        'WBTC':   0.01,
        'ARB':    100,
        'FRAX':   100,
        'LINK':   10,
        'GMX':    10,
        'MAGIC':  100,
        // Ensure all potential borrow tokens used in your pool configs are listed here
    },

    // Add other network-specific settings here if needed
    // ...

    // Note: RPC_URL, CHAIN_ID, NAME, NATIVE_SYMBOL, EXPLORER_URL are defined in networks.js for localFork
};

module.exports = LOCAL_FORK_CONFIG;
