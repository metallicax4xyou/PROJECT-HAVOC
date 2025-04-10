// helpers/contracts.js
const { ethers } = require('ethers');
const config = require('../config'); // Adjust path if your structure differs

// Load static ABIs from the /abis directory
const IUniswapV3PoolABI = require('../abis/IUniswapV3Pool.json');
const IQuoterV2ABI = require('../abis/IQuoterV2.json'); // ABI includes quoteExactInputSingle and quoteExactInput

/**
 * Initializes and returns ethers.js contract instances.
 * @param {ethers.Provider} provider - The ethers provider instance.
 * @param {ethers.Signer} signer - The ethers signer instance (for sending transactions).
 * @param {Array} flashSwapABI - The ABI for the dynamically fetched FlashSwap contract.
 * @returns {object} An object containing the initialized contract instances.
 * @throws {Error} If required inputs are missing or invalid.
 */
function initializeContracts(provider, signer, flashSwapABI) {
    console.log("[Contracts] Initializing contract instances...");

    // Input validation
    if (!provider) {
        throw new Error("[Contracts] Provider is required for initialization.");
    }
    if (!signer) {
        // Signer is needed for the FlashSwap contract which executes transactions
        throw new Error("[Contracts] Signer is required for FlashSwap contract initialization.");
    }
    if (!flashSwapABI || !Array.isArray(flashSwapABI) || flashSwapABI.length === 0) {
        // FlashSwap ABI is fetched dynamically, need to ensure it's valid
        throw new Error("[Contracts] Valid FlashSwap ABI (flashSwapABI) is required for initialization.");
    }
    if (!IUniswapV3PoolABI || !IQuoterV2ABI) {
        // Check that static ABIs loaded correctly
        throw new Error("[Contracts] Failed to load static ABIs (Pool or Quoter).");
    }

    try {
        // Instantiate contracts
        const contracts = {
            // FlashSwap contract needs the signer to execute initiateFlashSwap
            flashSwapContract: new ethers.Contract(config.FLASH_SWAP_CONTRACT_ADDRESS, flashSwapABI, signer),

            // Quoter and Pools are read-only, use provider
            quoterContract: new ethers.Contract(config.QUOTER_V2_ADDRESS, IQuoterV2ABI, provider),
            poolAContract: new ethers.Contract(config.POOL_A_ADDRESS, IUniswapV3PoolABI, provider),
            poolBContract: new ethers.Contract(config.POOL_B_ADDRESS, IUniswapV3PoolABI, provider),
        };

        console.log("[Contracts] All contract instances created successfully.");
        // Optional: Add checks to ensure methods exist on instances if needed
        // if (typeof contracts.flashSwapContract.initiateFlashSwap !== 'function') { ... }

        return contracts;

    } catch (error) {
        console.error("[Contracts] Error during contract instantiation:", error);
        // Throw a more specific error to halt initialization if contracts fail
        throw new Error(`Failed to initialize contracts: ${error.message}`);
    }
}

// Export using the object pattern for require destructuring
module.exports = { initializeContracts };
