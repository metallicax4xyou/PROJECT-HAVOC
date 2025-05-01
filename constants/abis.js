// constants/abis.js
// Using CommonJS - Updated FlashSwap ABI path to use compiled artifact

const logger = require('../utils/logger'); // Use logger for safe loading
const path = require('path'); // Import Node.js path module

/**
 * Safely requires a module (like a JSON ABI file).
 * Handles potential errors and returns null if the module cannot be loaded.
 * Automatically checks for a nested 'abi' property (common in Hardhat artifacts).
 * @param {string} absoluteOrRelativePath - The path to the module.
 * @returns {any | null} The required module content (or its 'abi' property), or null on failure.
 */
function safeRequire(absoluteOrRelativePath) {
  try {
    const mod = require(absoluteOrRelativePath);
    // If the required object has an 'abi' property, return that (common for compiled contracts)
    // Otherwise, return the entire required object (for simple ABI files like interfaces)
    return mod.abi || mod;
  } catch (e) {
    // Log the error if the module cannot be found or loaded
    logger.error(`[ABI Load] Failed to load ABI from ${absoluteOrRelativePath}: ${e.message}`);
    return null; // Return null on failure
  }
}

// --- Load ABIs from compiled artifacts (for contracts you deployed) ---
// Construct the absolute path to the FlashSwap contract artifact relative to the constants/ directory.
// __dirname here is the directory of the current script (constants/).
// We go up one level (..), then navigate into artifacts/contracts/FlashSwap.sol/FlashSwap.json
const flashSwapArtifactPath = path.resolve(__dirname, '..', 'artifacts', 'contracts', 'FlashSwap.sol', 'FlashSwap.json');
const FlashSwapABI = safeRequire(flashSwapArtifactPath);

// --- Load ABIs from manually managed abi/ directory (for external contracts like interfaces, routers) ---
// These are typically ABI files you obtain manually and place in the abis/ directory.
// Paths relative to the constants/ directory: go up one level (..), then into abis/...
const IUniswapV3PoolABI = safeRequire(path.resolve(__dirname, '..', 'abis', 'IUniswapV3Pool.json'));
const IQuoterV2ABI = safeRequire(path.resolve(__dirname, '..', 'abis', 'IQuoterV2.json'));
const TickLensABI = safeRequire(path.resolve(__dirname, '..', 'abis', 'TickLens.json'));
const DODOZooABI = safeRequire(path.resolve(__dirname, '..', 'abis', 'DODOZoo.json'));
const DODOV1V2PoolABI = safeRequire(path.resolve(__dirname, '..', 'abis', 'IDODOV1V2Pool.json')); // Assuming your DODO interface ABI is named IDODOV1V2Pool.json


// --- Central ABIS Object ---
// Map logical names to the loaded ABI objects.
const ABIS = {
  FlashSwap: FlashSwapABI, // Use the ABI loaded from artifacts
  // Include other ABIs needed by various parts of the bot
  UniswapV3Pool: IUniswapV3PoolABI,
  IUniswapV3Pool: IUniswapV3PoolABI, // Include both logical and interface names if needed
  IQuoterV2: IQuoterV2ABI,
  TickLens: TickLensABI,
  DODOZoo: DODOZooABI,
  DODOV1V2Pool: DODOV1V2PoolABI,
};

// Optional: Log loaded ABIs for verification (only logs keys that loaded successfully)
const loadedAbiKeys = Object.keys(ABIS).filter(k => ABIS[k] !== null);
logger.debug(`[ABI Load] Loaded ABIs: ${loadedAbiKeys.join(', ')}`);

// Check for any failed loads and log a warning (useful during development)
Object.keys(ABIS).forEach(key => {
    if (!ABIS[key]) {
        // Log a warning if an expected ABI failed to load
        logger.warn(`[ABI Load] WARNING: ABI for "${key}" failed to load.`);
    }
});


// Export the central ABIS object
module.exports = {
  ABIS,
};
