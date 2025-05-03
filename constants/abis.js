// constants/abis.js
// Using CommonJS - Updated FlashSwap ABI path to use compiled artifact
// Corrected DODOV1V2Pool ABI filename to point to newly fetched ABI

const logger = require('../utils/logger'); // Use logger for safe loading
const path = require('path'); // Import Node.js path module
const fs = require('fs'); // Import Node.js file system module

/**
 * Safely requires a module (like a JSON ABI file) using fs.readFileSync and JSON.parse.
 * Handles potential errors and returns null if the module cannot be loaded.
 * Automatically checks for a nested 'abi' property (common in Hardhat artifacts).
 * @param {string} absoluteOrRelativePath - The absolute or relative path to the module.
 * @returns {any | null} The required module content (or its 'abi' property), or null on failure.
 */
function safeLoadJson(absoluteOrRelativePath) {
  try {
    // Resolve the path to be absolute or relative from process.cwd() if needed,
    // but path.resolve(__dirname, ...) is generally safer for loading files bundled with the script.
    const filePath = path.resolve(__dirname, absoluteOrRelativePath);
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(fileContent);

    // If the parsed object has an 'abi' property, return that (common for compiled contracts JSON)
    // Otherwise, return the entire parsed object (for simple ABI array files)
    return parsed.abi || parsed;
  } catch (e) {
    // Log the error if the file cannot be found, read, or parsed
    logger.error(`[ABI Load] Failed to load ABI from ${absoluteOrRelativePath}: ${e.message}`);
    return null; // Return null on failure
  }
}

// --- Load ABIs from compiled artifacts (for contracts you deployed) ---
// Construct the absolute path to the FlashSwap contract artifact relative to the constants/ directory.
// __dirname here is the directory of the current script (constants/).
// We go up one level (..), then navigate into artifacts/contracts/FlashSwap.sol/FlashSwap.json
const flashSwapArtifactPath = path.resolve(__dirname, '..', 'artifacts', 'contracts', 'FlashSwap.sol', 'FlashSwap.json');
// Use safeLoadJson instead of safeRequire for better control over paths and error handling
const FlashSwapABI = safeLoadJson(flashSwapArtifactPath);


// --- Load ABIs from manually managed abi/ directory (for external contracts like interfaces, routers) ---
// These are typically ABI files you obtain manually and place in the abis/ directory.
// Paths relative to the constants/ directory: go up one level (..), then into abis/...
const IUniswapV3PoolABI = safeLoadJson(path.resolve(__dirname, '..', 'abis', 'IUniswapV3Pool.json'));
const IQuoterV2ABI = safeLoadJson(path.resolve(__dirname, '..', 'abis', 'IQuoterV2.json'));
const TickLensABI = safeLoadJson(path.resolve(__dirname, '..', 'abis', 'TickLens.json'));
const DODOZooABI = safeLoadJson(path.resolve(__dirname, '..', 'abis', 'DODOZoo.json'));

// --- CORRECTED FILENAME HERE ---
// Point to one of the ABIs fetched from Arbiscan for your specific DODO pools
// Using the one from 0xFE176A2b1e1F67250d2903B8d25f56C0DaBcd6b2 as an example
const DODOV1V2PoolABI = safeLoadJson(path.resolve(__dirname, '..', 'abis', 'DODOPoolArbitrumV2_FE17.json'));
// --- END CORRECTED FILENAME ---

// --- Optional standard ABIs ---
// You might need a generic ERC20 ABI for token interactions (approve, balance, transfer)
const ERC20ABI = safeLoadJson(path.resolve(__dirname, '..', 'abis', 'ERC20.json'));


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
  // *** Use the updated ABI key and value for DODO V1/V2 Pools ***
  DODOV1V2Pool: DODOV1V2PoolABI, // Use the ABI loaded from the new file
  // Optional: Include ERC20 ABI if needed by other modules
  ERC20: ERC20ABI,
};

// Optional: Log loaded ABIs for verification (only logs keys that loaded successfully)
// Filter out nulls before joining, exclude keys with null values from the log
const loadedAbiKeys = Object.keys(ABIS).filter(key => ABIS[key] !== null);
logger.debug(`[ABI Load] Loaded ABIs: ${loadedAbiKeys.join(', ')}`);

// Check for any failed loads and log a warning (useful during development)
Object.keys(ABIS).forEach(key => {
    if (!ABIS[key]) {
        // Log a warning if an expected ABI failed to load
        logger.warn(`[ABI Load] WARNING: ABI for "${key}" failed to load. Check file path and name, and ensure the file contains valid JSON.`);
    }
});


// Export the central ABIS object
module.exports = {
  ABIS,
};
