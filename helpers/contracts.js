// helpers/contracts.js
const { ethers } = require('ethers');
// Removed direct require of '../config'

// Load static ABIs from the /abis directory
const IUniswapV3PoolABI = require('../abis/IUniswapV3Pool.json');
const IQuoterV2ABI = require('../abis/IQuoterV2.json');
const FlashSwapABI = require('../abis/FlashSwap.json'); // Load local FlashSwap ABI

/**
 * Initializes and returns ethers.js contract instances based on network config.
 * @param {ethers.Provider} provider - The ethers provider instance.
 * @param {ethers.Signer} signer - The ethers signer instance (for sending transactions).
 * @param {object} config - The network-specific configuration object from getConfig.
 * @returns {object} An object containing the initialized contract instances.
 * @throws {Error} If required inputs are missing or invalid.
 */
function initializeContracts(provider, signer, config) { // Accept config object
    console.log(`[Contracts] Initializing contract instances for network ${config.CHAIN_ID}...`);

    // Input validation
    if (!provider) throw new Error("[Contracts] Provider is required.");
    if (!signer) throw new Error("[Contracts] Signer is required.");
    if (!config) throw new Error("[Contracts] Network config is required."); // Check for config object
    if (!FlashSwapABI || !IUniswapV3PoolABI || !IQuoterV2ABI) {
        throw new Error("[Contracts] Failed to load required static ABIs.");
    }
    // Validate addresses needed from config
    if (!config.FLASH_SWAP_CONTRACT_ADDRESS) console.warn("[Contracts] FLASH_SWAP_CONTRACT_ADDRESS missing in config."); // Warn instead of throw if deploying
    if (!config.QUOTER_V2_ADDRESS) throw new Error("[Contracts] QUOTER_V2_ADDRESS missing in config.");
    if (!config.POOL_A_ADDRESS) throw new Error("[Contracts] POOL_A_ADDRESS missing in config.");
    if (!config.POOL_B_ADDRESS) throw new Error("[Contracts] POOL_B_ADDRESS missing in config.");


    try {
        // Instantiate contracts using addresses from the passed config object
        const contracts = {};

        // Only instantiate FlashSwap if the address is provided (allows deployment first)
        if (config.FLASH_SWAP_CONTRACT_ADDRESS && config.FLASH_SWAP_CONTRACT_ADDRESS !== "") {
             contracts.flashSwapContract = new ethers.Contract(config.FLASH_SWAP_CONTRACT_ADDRESS, FlashSwapABI, signer);
        } else {
             contracts.flashSwapContract = null; // Set to null if address is missing
             console.log("[Contracts] FlashSwap contract instance skipped (address not configured).");
        }


        // Quoter and Pools are read-only, use provider
        // Ensure pool addresses are not placeholders before creating instances (unless it's Base)
         if (config.POOL_A_ADDRESS && !config.POOL_A_ADDRESS.includes("_ADDRESS")) {
             contracts.poolAContract = new ethers.Contract(config.POOL_A_ADDRESS, IUniswapV3PoolABI, provider);
         } else {
             console.warn(`[Contracts] Skipping Pool A instance (placeholder or missing address in config for ${config.CHAIN_ID})`);
             contracts.poolAContract = null;
         }

         if (config.POOL_B_ADDRESS && !config.POOL_B_ADDRESS.includes("_ADDRESS")) {
              contracts.poolBContract = new ethers.Contract(config.POOL_B_ADDRESS, IUniswapV3PoolABI, provider);
         } else {
              console.warn(`[Contracts] Skipping Pool B instance (placeholder or missing address in config for ${config.CHAIN_ID})`);
              contracts.poolBContract = null;
         }

         // Always instantiate Quoter
         contracts.quoterContract = new ethers.Contract(config.QUOTER_V2_ADDRESS, IQuoterV2ABI, provider);


        console.log("[Contracts] Contract instances created (some may be null if addresses were missing).");

        return contracts;

    } catch (error) {
        console.error("[Contracts] Error during contract instantiation:", error);
        throw new Error(`Failed to initialize contracts: ${error.message}`);
    }
}

module.exports = { initializeContracts };
