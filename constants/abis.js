// constants/abis.js
// Using CommonJS

const logger = require('../utils/logger'); // Use logger for safe loading

function safeRequire(path) {
  try {
    const mod = require(path);
    // Handle cases where ABI is nested (e.g., Hardhat artifacts)
    return mod.abi || mod;
  } catch (e) {
    logger.error(`[ABI Load] Failed to load ABI from ${path}: ${e.message}`);
    return null; // Return null on failure
  }
}

// Adjust paths as needed based on your project structure
const FlashSwapABI = safeRequire('../abis/FlashSwap.json');
const IUniswapV3PoolABI = safeRequire('../abis/IUniswapV3Pool.json');
const IQuoterV2ABI = safeRequire('../abis/IQuoterV2.json');
const TickLensABI = safeRequire('../abis/TickLens.json'); // Load TickLens ABI

const ABIS = {
  FlashSwap: FlashSwapABI,
  UniswapV3Pool: IUniswapV3PoolABI,
  IQuoterV2: IQuoterV2ABI,
  TickLens: TickLensABI, // Add TickLens ABI
};

// Optional: Log loaded ABIs for verification
// logger.debug(`[ABI Load] Loaded ABIs: ${Object.keys(ABIS).filter(k => ABIS[k] !== null).join(', ')}`);
// Object.keys(ABIS).forEach(key => {
//     if (!ABIS[key]) {
//         logger.warn(`[ABI Load] WARNING: ABI for "${key}" failed to load.`);
//     }
// });


module.exports = {
  ABIS,
};
