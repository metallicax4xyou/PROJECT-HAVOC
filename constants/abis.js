// constants/abis.js
// Using CommonJS - Removed FlashSwap ABI loading (now sourced from FlashSwapManager)
// Corrected DODOV1V2Pool ABI filename to point to newly fetched ABI
// Added ERC20 ABI loading

const logger = require('../utils/logger'); // Use logger for safe loading
const path = require('path'); // Import Node.js path module
const fs = require('fs'); // Import Node.js file system module

/**
 * Safely requires a module (like a JSON ABI file) using fs.readFileSync and JSON.parse.
 * Handles potential errors and returns null if the module cannot be loaded.
 * Automatically checks for a nested 'abi' property (common in Hardhat artifacts),
 * but is primarily intended here for flat ABI JSON files from abi/ directory.
 * @param {string} relativePath - The path to the module, relative from the constants/ directory.
 * @returns {any | null} The required module content (or its 'abi' property if present), or null on failure.
 */
function safeLoadJson(relativePath) {
  // Construct the absolute path relative to the current script's directory (__dirname)
  const filePath = path.resolve(__dirname, relativePath);
  try {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(fileContent);

    // For ABIs in the abi/ directory, we expect the top level to be the ABI array.
    // If it happens to have an 'abi' property (e.g., if you accidentally put an artifact here),
    // still prioritize the top level unless it's empty and 'abi' exists.
    if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed; // Return the ABI array directly
    } else if (parsed.abi && Array.isArray(parsed.abi) && parsed.abi.length > 0) {
        return parsed.abi; // Return the nested ABI array if the top level wasn't the array
    } else {
        // If neither is a valid ABI array, log a warning.
         logger.warn(`[ABI Load] Loaded JSON from ${relativePath} does not appear to be a standard ABI array or nested artifact JSON.`);
        return null; // Not a valid ABI structure
    }
  } catch (e) {
    logger.error(`[ABI Load] Failed to load or parse ABI from ${relativePath}: ${e.message}`);
    return null;
  }
}

// --- REMOVED FlashSwap ABI Loading from here ---
// const flashSwapArtifactPath = path.join('..', 'artifacts', 'contracts', 'FlashSwap.sol', 'FlashSwap.json');
// const FlashSwapABI = safeLoadJson(flashSwapArtifactPath); // This line is removed


// --- Load ABIs from manually managed abi/ directory ---
// Paths relative from constants/: go up one level (..), then into abis/...
const IUniswapV3PoolABI = safeLoadJson(path.join('..', 'abis', 'IUniswapV3Pool.json'));
const IQuoterV2ABI = safeLoadJson(path.join('..', 'abis', 'IQuoterV2.json'));
const TickLensABI = safeLoadJson(path.join('..', 'abis', 'TickLens.json'));
const DODOZooABI = safeLoadJson(path.join('..', 'abis', 'DODOZoo.json'));

// --- Corrected ABI filename and path ---
const DODOV1V2PoolABI = safeLoadJson(path.join('..', 'abis', 'DODOPoolArbitrumV2_FE17.json'));
// --- END CORRECTED FILENAME ---

// --- Optional standard ABIs ---
const ERC20ABI = safeLoadJson(path.join('..', 'abis', 'ERC20.json'));


// --- Central ABIS Object ---
// Map logical names to the loaded ABI objects.
const ABIS = {
  // --- REMOVED FlashSwap from here ---
  // FlashSwap: FlashSwapABI, // This key is removed

  // Include other ABIs needed by various parts of the bot
  UniswapV3Pool: IUniswapV3PoolABI,
  IUniswapV3Pool: IUniswapV3PoolABI,
  IQuoterV2: IQuoterV2ABI,
  TickLens: TickLensABI,
  DODOZoo: DODOZooABI,
  DODOV1V2Pool: DODOV1V2PoolABI,
  ERC20: ERC20ABI,
};

// Log loaded ABIs for verification (only logs keys that loaded successfully)
// Filter out nulls before joining, exclude keys with null values from the log
const loadedAbiKeys = Object.keys(ABIS).filter(key => ABIS[key] !== null);
// Filter out the FlashSwap key explicitly from this log since it's no longer loaded here
const loadedAbiKeysForLog = loadedAbiKeys.filter(key => key !== 'FlashSwap');
logger.debug(`[ABI Load] Loaded ABIs: ${loadedAbiKeysForLog.join(', ')}`);

// Check for any failed loads and log a warning (excluding FlashSwap)
Object.keys(ABIS).forEach(key => {
    if (!ABIS[key]) { // This check will still correctly identify failed loads for other ABIs
         logger.warn(`[ABI Load] WARNING: ABI for "${key}" failed to load. Check file path and name, and ensure the file contains valid JSON.`);
    }
});


// Export the central ABIS object
module.exports = {
  ABIS,
};
