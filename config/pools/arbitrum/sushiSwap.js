// config/pools/arbitrum/sushiSwap.js
// SushiSwap Pool Definitions for Arbitrum

// Note: Requires corresponding address variables (e.g., ARBITRUM_SUSHI_WETH_USDC_E_ADDRESS)
// to be defined in the .env file for the poolLoader to find them.

const SUSHISWAP_POOLS = [
    { name: 'WETH_USDCe_SUSHI', token0Symbol: 'WETH', token1Symbol: 'USDC.e', fee: 30, poolAddressEnv: 'ARBITRUM_SUSHI_WETH_USDC_E_ADDRESS' },
    { name: 'WBTC_WETH_SUSHI', token0Symbol: 'WBTC', token1Symbol: 'WETH', fee: 30, poolAddressEnv: 'ARBITRUM_SUSHI_WBTC_WETH_ADDRESS' },
    { name: 'WETH_USDT_SUSHI', token0Symbol: 'WETH', token1Symbol: 'USDT', fee: 30, poolAddressEnv: 'ARBITRUM_SUSHI_WETH_USDT_ADDRESS' },
    // Add back other Sushi pools as needed, ensuring corresponding .env entries exist
    // { name: 'ARB_WETH_SUSHI', token0Symbol: 'ARB', token1Symbol: 'WETH', fee: 30, poolAddressEnv: 'ARBITRUM_SUSHI_ARB_WETH_ADDRESS' },
    // { name: 'WETH_LINK_SUSHI', token0Symbol: 'WETH', token1Symbol: 'LINK', fee: 30, poolAddressEnv: 'ARBITRUM_SUSHI_WETH_LINK_ADDRESS' },
    // { name: 'GMX_WETH_SUSHI', token0Symbol: 'GMX', token1Symbol: 'WETH', fee: 30, poolAddressEnv: 'ARBITRUM_SUSHI_GMX_WETH_ADDRESS' },
    // { name: 'MAGIC_WETH_SUSHI', token0Symbol: 'MAGIC', token1Symbol: 'WETH', fee: 30, poolAddressEnv: 'ARBITRUM_SUSHI_MAGIC_WETH_ADDRESS' },
];

module.exports = {
    SUSHISWAP_POOLS,
};
