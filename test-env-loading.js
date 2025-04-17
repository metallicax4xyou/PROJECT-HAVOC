require('dotenv').config({path: '.env'});
console.log("Environment Variables Loaded:", {
  privateKeySet: !!process.env.PRIVATE_KEY,
  rpcUrlSet: !!process.env.ARBITRUM_RPC_URLS,
  poolsLoaded: {
    weth: process.env.WETH_USDC_POOLS?.split(',').length || 0,
    usdt: process.env.USDC_USDT_POOLS?.split(',').length || 0
  }
});
