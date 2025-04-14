// constants/abis.js
// Using CommonJS

// Adjust paths as needed based on your project structure
const FlashSwapABI = require('../abis/FlashSwap.json');
const IUniswapV3PoolABI = require('../abis/IUniswapV3Pool.json');
const IQuoterV2ABI = require('../abis/IQuoterV2.json');
// Potentially load Factory ABI if needed for dynamic discovery later
// const IUniswapV3FactoryABI = require('@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Factory.sol/IUniswapV3Factory.json').abi;

const ABIS = {
  FlashSwap: FlashSwapABI,
  UniswapV3Pool: IUniswapV3PoolABI,
  IQuoterV2: IQuoterV2ABI,
  // IUniswapV3Factory: IUniswapV3FactoryABI,
};

module.exports = {
  ABIS,
};
