// config/arbitrum.js
// --- DODO POOLS TEMPORARILY COMMENTED OUT FOR DEBUGGING ---

// --- Chainlink Feed Addresses ---
const CHAINLINK_FEEDS = { // Verify these if used
    'USDC/ETH': '0x50834F3163758fcC1Df9973b6e91f0F0F0434AD3',
    'USDT/ETH': '0x0A599A8555303467150f2aA046764Fa435551F76',
    'ARB/ETH': '0xb2A824043730FE05F3DA2efaFa1CBbe83fa548D6',
    'DAI/ETH': '0xcAE0036F347a9459510A411DA0937A21f5571D35',
    'WBTC/ETH': '0x11A839134e1A4039F852F63D46475F1D5c049394',
    'LINK/ETH': '0xb5e424679B669A4B547291B079A3541783C57b86',
    'GMX/ETH': '0x0fB2C88fAcC5F30508E8F7506033654FdB4468aF',
};

// --- Define Uniswap V3 Pool Groups to monitor ---
const UNISWAP_V3_POOLS = [
    { name: 'WETH_USDC_V3', token0Symbol: 'WETH', token1Symbol: 'USDC', borrowTokenSymbol: 'WETH', feeTiers: [100, 500, 3000], feeTierToEnvMap: { '100': 'ARBITRUM_WETH_USDC_100_ADDRESS', '500': 'ARBITRUM_WETH_USDC_500_ADDRESS', '3000': 'ARBITRUM_WETH_USDC_3000_ADDRESS' } },
    { name: 'WBTC_WETH_V3', token0Symbol: 'WBTC', token1Symbol: 'WETH', borrowTokenSymbol: 'WETH', feeTiers: [500], feeTierToEnvMap: { '500': 'ARBITRUM_WBTC_WETH_500_ADDRESS' } },
    { name: 'WETH_USDT_V3', token0Symbol: 'WETH', token1Symbol: 'USDT', borrowTokenSymbol: 'WETH', feeTiers: [500], feeTierToEnvMap: { '500': 'ARBITRUM_WETH_USDT_500_ADDRESS' } },
    { name: 'USDC_USDT_V3', token0Symbol: 'USDC', token1Symbol: 'USDT', borrowTokenSymbol: 'USDC', feeTiers: [100], feeTierToEnvMap: { '100': 'ARBITRUM_USDC_USDT_100_ADDRESS' } },
    { name: 'USDC_DAI_V3', token0Symbol: 'USDC', token1Symbol: 'DAI', borrowTokenSymbol: 'USDC', feeTiers: [100], feeTierToEnvMap: { '100': 'ARBITRUM_USDC_DAI_100_ADDRESS' } },
    { name: 'FRAX_USDT_V3', token0Symbol: 'FRAX', token1Symbol: 'USDT', borrowTokenSymbol: 'USDT', feeTiers: [500], feeTierToEnvMap: { '500': 'ARBITRUM_FRAX_USDT_500_ADDRESS' } },
    { name: 'WETH_LINK_V3', token0Symbol: 'WETH', token1Symbol: 'LINK', borrowTokenSymbol: 'WETH', feeTiers: [3000, 10000], feeTierToEnvMap: { '3000': 'ARBITRUM_WETH_LINK_3000_ADDRESS', '10000': 'ARBITRUM_WETH_LINK_10000_ADDRESS' } },
    { name: 'GMX_WETH_V3', token0Symbol: 'GMX', token1Symbol: 'WETH', borrowTokenSymbol: 'WETH', feeTiers: [3000, 10000], feeTierToEnvMap: { '3000': 'ARBITRUM_GMX_WETH_3000_ADDRESS', '10000': 'ARBITRUM_GMX_WETH_10000_ADDRESS' } },
    { name: 'MAGIC_WETH_V3', token0Symbol: 'MAGIC', token1Symbol: 'WETH', borrowTokenSymbol: 'WETH', feeTiers: [3000], feeTierToEnvMap: { '3000': 'ARBITRUM_MAGIC_WETH_3000_ADDRESS' } },
];

// --- Define SushiSwap (V2 Style) Pools ---
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
    // { name: 'GMX_WETH_CAMELOT', token0Symbol: 'GMX', token1Symbol: 'WETH', dexType: 'camelot', fee: 3000, poolAddressEnv: 'ARBITRUM_CAMELOT_GMX_WETH_ADDRESS' }, // Example
];

// --- *** Define DODO Pools - COMMENTED OUT FOR DEBUGGING *** ---
const DODO_POOLS = [
    // { // Temporarily commented out
    //     name: 'WETH_USDCE_DODO',     // Use USDC.e based on our findings
    //     token0Symbol: 'WETH',       // Must match a key in constants/tokens.js
    //     token1Symbol: 'USDC.e',     // Must match a key in constants/tokens.js
    //     baseTokenSymbol: 'WETH',    // IMPORTANT: Tell fetcher which token is BASE for queries
    //     poolAddressEnv: 'ARBITRUM_DODO_WETH_USDCE_ADDRESS', // Matches your .env file
    //     dexType: 'dodo',            // Identifier for PoolScanner
    //     fee: 1000                   // Example: DODO V1 WETH/USDC uses 0.1% fee = 1000 bps (Verify!)
    // },
    // { // Temporarily commented out
    //     name: 'USDT_USDCE_DODO',     // Use USDC.e based on our findings
    //     token0Symbol: 'USDT',       // Must match a key in constants/tokens.js
    //     token1Symbol: 'USDC.e',     // Must match a key in constants/tokens.js
    //     baseTokenSymbol: 'USDT',    // IMPORTANT: Tell fetcher which token is BASE for queries
    //     poolAddressEnv: 'ARBITRUM_DODO_USDT_USDCE_ADDRESS', // Matches your .env file
    //     dexType: 'dodo',            // Identifier for PoolScanner
    //     fee: 100                    // Example: DODO V1 Stable pools often use 0.01% = 100 bps (Verify!)
    // },
];
// --- *** ---

// --- Combine and Export ---
const ARBITRUM_CONFIG = {
    CHAINLINK_FEEDS: CHAINLINK_FEEDS,
    UNISWAP_V3_POOLS: UNISWAP_V3_POOLS,
    SUSHISWAP_POOLS: SUSHISWAP_POOLS,
    CAMELOT_POOLS: CAMELOT_POOLS,
    DODO_POOLS: DODO_POOLS, // Keep the empty array definition

    // --- Global Settings ---
    MIN_PROFIT_THRESHOLDS: { NATIVE: '0.001', USDC: '10.0', USDT: '10.0', DAI: '10.0', WBTC: '0.0002', ARB: '10.0', DEFAULT: '0.0005' },
    MAX_GAS_GWEI: '0.5',
    GAS_ESTIMATE_BUFFER_PERCENT: 20,
    FALLBACK_GAS_LIMIT: '3000000',
    PROFIT_BUFFER_PERCENT: 10,
    SUSHISWAP_ROUTER_ADDRESS: process.env.ARBITRUM_SUSHISWAP_ROUTER_ADDRESS || '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
};

module.exports = ARBITRUM_CONFIG;
