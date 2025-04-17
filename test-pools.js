require('dotenv').config();
console.log("ENV Variables:", {
  RPC: process.env.ARBITRUM_RPC_URLS,
  WETH_POOLS: process.env.WETH_USDC_POOLS,
  USDT_POOLS: process.env.USDC_USDT_POOLS
});
