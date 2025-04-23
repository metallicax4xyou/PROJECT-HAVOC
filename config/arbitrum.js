// config/arbitrum.js
// --- Contains network-specific pool definitions and settings ---

// --- Chainlink Feed Addresses ---
// Keys should be BASE/QUOTE (e.g., USDC/ETH means price is ETH per 1 USDC)
// Need feeds vs Native Currency (ETH for Arbitrum) for ProfitCalculator conversion
const CHAINLINK_FEEDS = {
    'USDC/ETH': '0x50834F3163758fcC1Df9973b6e91f0F0F0434AD3', // Check if this is USDC/USD or USDC/ETH - Needs to be vs ETH
    'USDT/ETH': '0x0A599A8555303467150f2aA046764Fa435551F76', // Check if this is USDT/USD or USDT/ETH - Needs to be vs ETH
    'ARB/ETH': '0xb2A824043730FE05F3DA2efaFa1CBbe83fa548D6',  // Assumed correct
    'DAI/ETH': '0xcAE0036F347a9459510A411DA0937A21f5571D35',  // Check if this is DAI/USD or DAI/ETH - Needs to be vs ETH
    'WBTC/ETH': '0x11A839134e1A4039F852F63D46475F1D5c049394', // Assumed correct
    'LINK/ETH': '0xb5e424679B669A4B547291B079A3541783C57b86', // Assumed correct
    'GMX/ETH': '0x0fB2C88fAcC5F30508E8F7506033654FdB4468aF',  // Assumed correct
    // Add feeds for FRAX/ETH, MAGIC/ETH if needed for conversion
    // If only USD feeds are available, need multi-step conversion (Token -> USD -> ETH) in priceFeed.js
};

// --- Define Uniswap V3 Pool Groups to monitor ---
// token0Symbol/token1Symbol should match keys in constants/tokens.js
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
    // Add ARB pairs back if needed, ensure env vars exist
    // { name: 'ARB_USDC_V3', token0Symbol: 'ARB', token1Symbol: 'USDC', feeTierToEnvMap: { '500': 'ARBITRUM_ARB_USDC_500_ADDRESS'} },
    // { name: 'ARB_WETH_V3', token0Symbol: 'ARB', token1Symbol: 'WETH', feeTierToEnvMap: { '500': 'ARBITRUM_ARB_WETH_500_ADDRESS'} },
];

// --- Define SushiSwap (V2 Style) Pools ---
// Ensure fee is defined correctly (Sushi V2 is typically 3000 bps = 0.3%)
const SUSHISWAP_POOLS = [
    { name: 'WETH_USDCe_SUSHI', token0Symbol: 'WETH', token1Symbol: 'USDC.e', fee: 3000, poolAddressEnv: 'ARBITRUM_SUSHI_WETH_USDC_E_ADDRESS' },
    { name: 'WBTC_WETH_SUSHI', token0Symbol: 'WBTC', token1Symbol: 'WETH', fee: 3000, poolAddressEnv: 'ARBITRUM_SUSHI_WBTC_WETH_ADDRESS' },
    { name: 'ARB_WETH_SUSHI', token0Symbol: 'ARB', token1Symbol: 'WETH', fee: 3000, poolAddressEnv: 'ARBITRUM_SUSHI_ARB_WETH_ADDRESS' },
    { name: 'WETH_USDT_SUSHI', token0Symbol: 'WETH', token1Symbol: 'USDT', fee: 3000, poolAddressEnv: 'ARBITRUM_SUSHI_WETH_USDT_ADDRESS' },
    { name: 'WETH_LINK_SUSHI', token0Symbol: 'WETH', token1Symbol: 'LINK', fee: 3000, poolAddressEnv: 'ARBITRUM_SUSHI_WETH_LINK_ADDRESS' },
    { name: 'GMX_WETH_SUSHI', token0Symbol: 'GMX', token1Symbol: 'WETH', fee: 3000, poolAddressEnv: 'ARBITRUM_SUSHI_GMX_WETH_ADDRESS' },
    { name: 'MAGIC_WETH_SUSHI', token0Symbol: 'MAGIC', token1Symbol: 'WETH', fee: 3000, poolAddressEnv: 'ARBITRUM_SUSHI_MAGIC_WETH_ADDRESS' },
];

// --- Define Camelot Pools (Currently Empty) ---
const CAMELOT_POOLS = [
    // Define Camelot pools here if added
];

// --- Define DODO Pools ---
// Ensure fee is defined correctly based on pool type (check DODO docs/UI)
const DODO_POOLS = [
    { name: 'WETH_USDCE_DODO', token0Symbol: 'WETH', token1Symbol: 'USDC.e', baseTokenSymbol: 'WETH', poolAddressEnv: 'ARBITRUM_DODO_WETH_USDCE_ADDRESS', fee: 1000 }, // 0.1%
    { name: 'USDT_USDCE_DODO', token0Symbol: 'USDT', token1Symbol: 'USDC.e', baseTokenSymbol: 'USDT', poolAddressEnv: 'ARBITRUM_DODO_USDT_USDCE_ADDRESS', fee: 100 }, // 0.01%
];

// --- Gas Cost Estimates ---
// Rough gas cost estimates per operation on Arbitrum (TUNE THESE LATER!)
// Use BigInt suffix 'n' for clarity and compatibility
const GAS_COST_ESTIMATES = {
    FLASH_SWAP_BASE: 350000n,     // Base cost for calling the FlashSwap contract, callbacks etc.
    UNISWAP_V3_SWAP: 180000n,    // Approx gas for a single V3 swap step
    SUSHISWAP_V2_SWAP: 120000n,   // Approx gas for a single V2 swap step
    DODO_SWAP: 200000n,          // Approx gas for a single DODO swap step (can vary)
    // Add estimates for other DEXs if integrated later
};

// --- Combine and Export ---
const ARBITRUM_CONFIG = {
    CHAINLINK_FEEDS: CHAINLINK_FEEDS,
    UNISWAP_V3_POOLS: UNISWAP_V3_POOLS,
    SUSHISWAP_POOLS: SUSHISWAP_POOLS,
    CAMELOT_POOLS: CAMELOT_POOLS,
    DODO_POOLS: DODO_POOLS,
    GAS_COST_ESTIMATES: GAS_COST_ESTIMATES, // *** Export Gas Estimates ***

    // --- Global Settings (Defaults if not set in .env) ---
    MIN_PROFIT_THRESHOLDS: {
        NATIVE: '0.001', // Minimum profit in ETH required
        USDC: '5.0',    // Minimum profit if denominated in USDC
        USDT: '5.0',
        DAI: '5.0',
        WBTC: '0.0001',
        ARB: '5.0',
        LINK: '0.5',
        GMX: '0.2',
        MAGIC: '10.0',
        // Add other potential profit tokens here if needed
        DEFAULT: '0.0005' // Default minimum profit in ETH if specific token threshold is missing
    },
    // These will be OVERRIDDEN by .env vars if present
    MAX_GAS_GWEI: 1,                       // Default max Gwei (e.g., 1 Gwei) - Tune this carefully!
    GAS_ESTIMATE_BUFFER_PERCENT: 25,         // Add 25% buffer to gas estimates
    FALLBACK_GAS_LIMIT: 3000000,           // Default gas limit if estimation fails
    PROFIT_BUFFER_PERCENT: 10,              // Reduce calculated net profit by 10% for safety
    // --- ---

    SUSHISWAP_ROUTER_ADDRESS: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506', // Sushi Router on Arbitrum
    // Add DODO Router/Proxy if needed for execution later
};

module.exports = ARBITRUM_CONFIG;
