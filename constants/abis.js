// constants/abis.js
// Using CommonJS
// --- VERSION v1.1 --- Re-added FlashSwap ABI loading to fix TxEncoder dependency.

const logger = require('../utils/logger'); // Use logger for safe loading
const path = require('path'); // Import Node.js path module
const fs = require('fs'); // Import Node.js file system module

/**
 * Safely requires a module (like a JSON ABI file) using fs.readFileSync and JSON.parse.
 * Handles potential errors and returns null if the module cannot be loaded.
 * Automatically checks for a nested 'abi' property (common in Hardhat artifacts),
 * but can also handle flat ABI JSON files from abi/ directory.
 * @param {string} relativePath - The path to the module, relative from the constants/ directory.
 * @returns {any | null} The required module content (or its 'abi' property if present), or null on failure.
 */
function safeLoadJson(relativePath) {
  // Construct the absolute path relative to the current script's directory (__dirname)
  const filePath = path.resolve(__dirname, relativePath);
  try {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(fileContent);

    // Prioritize a nested 'abi' property if present and an array
    if (parsed.abi && Array.isArray(parsed.abi)) {
        // If the file is a Hardhat artifact with a nested ABI property
        return parsed.abi;
    } else if (Array.isArray(parsed)) {
        // If the file is a plain ABI array JSON
        return parsed;
    } else {
        // If neither is a valid ABI array structure, log a warning.
         logger.warn(`[ABI Load] Loaded JSON from ${relativePath} does not appear to be a standard ABI array or nested artifact JSON.`);
        return null; // Not a valid ABI structure
    }
  } catch (e) {
    logger.error(`[ABI Load] Failed to load or parse ABI from ${relativePath}: ${e.message}`);
    return null;
  }
}

// --- Re-added FlashSwap ABI Loading from artifacts ---
const flashSwapArtifactPath = path.join('..', 'artifacts', 'contracts', 'FlashSwap.sol', 'FlashSwap.json');
const FlashSwapABI = safeLoadJson(flashSwapArtifactPath); // Load the ABI from the compiled artifact
// --- End Re-added FlashSwap ABI Loading ---


// --- Load ABIs from manually managed abi/ directory ---
// Paths relative from constants/: go up one level (..), then into abis/...
const IUniswapV3PoolABI = safeLoadJson(path.join('..', 'abis', 'IUniswapV3Pool.json'));
const IQuoterV2ABI = safeLoadJson(path.join('..', 'abis', 'IQuoterV2.json'));
const TickLensABI = safeLoadJson(path.join('..', 'abis', 'TickLens.json'));
const DODOZooABI = safeLoadJson(path.join('..', 'abis', 'DODOZoo.json'));

// --- Corrected ABI filename and path ---
const DODOV1V2PoolABI = safeLoadJson(path.join('..', 'abis', 'DODOPoolArbitrumV2_FE17.json')); // Pointing to the correct filename
// --- END CORRECTED FILENAME ---

// --- Optional standard ABIs ---
const ERC20ABI = safeLoadJson(path.join('..', 'abis', 'ERC20.json'));


// --- Central ABIS Object ---
// Map logical names to the loaded ABI objects.
const ABIS = {
  // --- Re-added FlashSwap ABI to export ---
  FlashSwap: FlashSwapABI, // Include FlashSwap ABI for modules that need it
  // --- End Re-added ---

  // Include other ABIs needed by various parts of the bot
  UniswapV3Pool: IUniswapV3PoolABI, // Common name for V3 pools
  IUniswapV3Pool: IUniswapV3PoolABI, // Interface name for V3 pools
  IQuoterV2: IQuoterV2ABI,
  TickLens: TickLensABI,
  DODOZoo: DODOZooABI,
  DODOV1V2Pool: DODOV1V2PoolABI, // ABI for DODO V1/V2 pools
  ERC20: ERC20ABI, // Standard ERC20 ABI
};

// Log loaded ABIs for verification (only logs keys that loaded successfully)
const loadedAbiKeys = Object.keys(ABIS).filter(key => ABIS[key] !== null);
logger.debug(`[ABI Load] Loaded ABIs: ${loadedAbiKeys.join(', ')}`);

// Check for any failed loads and log a warning
Object.keys(ABIS).forEach(key => {
    if (!ABIS[key]) {
         logger.warn(`[ABI Load] WARNING: ABI for "${key}" failed to load. Check file path and name, and ensure the file contains valid JSON.`);
    }
});


// Export the central ABIS object
module.exports = {
  ABIS,
};
