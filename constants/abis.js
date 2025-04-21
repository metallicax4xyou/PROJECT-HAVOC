// constants/abis.js
// Using CommonJS - Updated to include DODO ABIs

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
const TickLensABI = safeRequire('../abis/TickLens.json');

// --- NEW DODO ABIs ---
const DODOZooABI = safeRequire('../abis/DODOZoo.json');
const DODOV1V2PoolABI = safeRequire('../abis/DODOV1V2Pool.json');
// --- --------------- ---


const ABIS = {
  FlashSwap: FlashSwapABI,
  UniswapV3Pool: IUniswapV3PoolABI, // Keep consistent name if used elsewhere
  IUniswapV3Pool: IUniswapV3PoolABI, // Explicitly add interface name if needed
  IQuoterV2: IQuoterV2ABI,
  TickLens: TickLensABI,
  // --- NEW DODO ABIs ---
  DODOZoo: DODOZooABI,
  DODOV1V2Pool: DODOV1V2PoolABI,
  // --- --------------- ---
};

// Optional: Log loaded ABIs for verification
// Filter out nulls before joining
const loadedAbiKeys = Object.keys(ABIS).filter(k => ABIS[k] !== null);
logger.debug(`[ABI Load] Loaded ABIs: ${loadedAbiKeys.join(', ')}`);

// Check for any failed loads
Object.keys(ABIS).forEach(key => {
    if (!ABIS[key]) {
        logger.warn(`[ABI Load] WARNING: ABI for "${key}" failed to load.`);
    }
});


module.exports = {
  ABIS,
};
