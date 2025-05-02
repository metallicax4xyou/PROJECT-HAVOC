// config/pools/arbitrum/uniswapV3.js
// Uniswap V3 Pool Definitions for Arbitrum

// Note: Requires corresponding address variables (e.g., ARBITRUM_WETH_USDC_100_ADDRESS)
// to be defined in the .env file for the poolLoader to find them.

const UNISWAP_V3_POOLS = [
    // Group Name helps identify the pair logic, borrowTokenSymbol was used by old poolProcessor, maybe useful context?
    { name: 'WETH_USDC_V3', token0Symbol: 'WETH', token1Symbol: 'USDC', borrowTokenSymbol: 'WETH', feeTierToEnvMap: { '100': 'ARBITRUM_WETH_USDC_100_ADDRESS', '500': 'ARBITRUM_WETH_USDC_500_ADDRESS', '3000': 'ARBITRUM_WETH_USDC_3000_ADDRESS' } },
    { name: 'WBTC_WETH_V3', token0Symbol: 'WBTC', token1Symbol: 'WETH', borrowTokenSymbol: 'WETH', feeTierToEnvMap: { '500': 'ARBITRUM_WBTC_WETH_500_ADDRESS' } },
    { name: 'WETH_USDT_V3', token0Symbol: 'WETH', token1Symbol: 'USDT', borrowTokenSymbol: 'WETH', feeTierToEnvMap: { '500': 'ARBITRUM_WETH_USDT_500_ADDRESS' } },
    { name: 'USDC_USDT_V3', token0Symbol: 'USDC', token1Symbol: 'USDT', borrowTokenSymbol: 'USDC', feeTierToEnvMap: { '100': 'ARBITRUM_USDC_USDT_100_ADDRESS' } },
    { name: 'USDC_DAI_V3', token0Symbol: 'USDC', token1Symbol: 'DAI', borrowTokenSymbol: 'USDC', feeTierToEnvMap: { '100': 'ARBITRUM_USDC_DAI_100_ADDRESS' } },
    // Add back other V3 pools as needed, ensuring corresponding .env entries exist
    // { name: 'FRAX_USDT_V3', token0Symbol: 'FRAX', token1Symbol: 'USDT', borrowTokenSymbol: 'USDT', feeTierToEnvMap: { '500': 'ARBITRUM_FRAX_USDT_500_ADDRESS' } },
    // { name: 'WETH_LINK_V3', token0Symbol: 'WETH', token1Symbol: 'LINK', borrowTokenSymbol: 'WETH', feeTierToEnvMap: { '3000': 'ARBITRUM_WETH_LINK_3000_ADDRESS', '10000': 'ARBITRUM_WETH_LINK_10000_ADDRESS' } },
    // { name: 'GMX_WETH_V3', token0Symbol: 'GMX', token1Symbol: 'WETH', borrowTokenSymbol: 'WETH', feeTierToEnvMap: { '3000': 'ARBITRUM_GMX_WETH_3000_ADDRESS', '10000': 'ARBITRUM_GMX_WETH_10000_ADDRESS' } },
    // { name: 'MAGIC_WETH_V3', token0Symbol: 'MAGIC', token1Symbol: 'WETH', borrowTokenSymbol: 'WETH', feeTierToEnvMap: { '3000': 'ARBITRUM_MAGIC_WETH_3000_ADDRESS' } },
];

module.exports = {
    UNISWAP_V3_POOLS,
};
