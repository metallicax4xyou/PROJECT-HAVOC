// config/pools/arbitrum/dodo.js
// DODO Pool Definitions for Arbitrum

// Note: Requires corresponding address variables (e.g., ARBITRUM_DODO_WETH_USDCE_ADDRESS)
// to be defined in the .env file for the poolLoader to find them.

const DODO_POOLS = [
    // Ensure baseTokenSymbol is correctly set for DODO logic
    { name: 'WETH_USDCE_DODO', token0Symbol: 'WETH', token1Symbol: 'USDC.e', baseTokenSymbol: 'WETH', poolAddressEnv: 'ARBITRUM_DODO_WETH_USDCE_ADDRESS', fee: 100 }, // Assuming 0.1% = 100 bps
    { name: 'USDT_USDCE_DODO', token0Symbol: 'USDT', token1Symbol: 'USDC.e', baseTokenSymbol: 'USDT', poolAddressEnv: 'ARBITRUM_DODO_USDT_USDCE_ADDRESS', fee: 10 }, // Assuming 0.01% = 10 bps
    // Add other DODO pools as needed
];

module.exports = {
    DODO_POOLS,
};
