// helpers/contracts.js
const { ethers } = require('ethers');

// Load static ABIs
const IUniswapV3PoolABI = require('../abis/IUniswapV3Pool.json');
const IQuoterV2ABI = require('../abis/IQuoterV2.json');
const FlashSwapABI = require('../abis/FlashSwap.json');

/**
 * Initializes and returns ethers.js contract instances based on network config.
 */
function initializeContracts(provider, signer, config) {
    console.log(`[Contracts] Initializing contract instances for network ${config.CHAIN_ID}...`);

    if (!provider) throw new Error("[Contracts] Provider is required.");
    if (!signer) throw new Error("[Contracts] Signer is required.");
    if (!config) throw new Error("[Contracts] Network config is required.");
    if (!FlashSwapABI || !IUniswapV3PoolABI || !IQuoterV2ABI) {
        throw new Error("[Contracts] Failed to load required static ABIs.");
    }
    // Validate required addresses from config
    if (!config.QUOTER_V2_ADDRESS) throw new Error("[Contracts] QUOTER_V2_ADDRESS missing in config.");
    if (!config.POOL_A_ADDRESS) throw new Error("[Contracts] POOL_A_ADDRESS missing in config.");
    if (!config.POOL_B_ADDRESS) throw new Error("[Contracts] POOL_B_ADDRESS missing in config.");
    // Pool C is optional depending on network config
    // if (!config.POOL_C_ADDRESS) console.warn("[Contracts] POOL_C_ADDRESS missing in config.");

    try {
        const contracts = {};

        // Instantiate FlashSwap contract
        if (config.FLASH_SWAP_CONTRACT_ADDRESS && config.FLASH_SWAP_CONTRACT_ADDRESS !== "") {
             contracts.flashSwapContract = new ethers.Contract(config.FLASH_SWAP_CONTRACT_ADDRESS, FlashSwapABI, signer);
        } else {
             contracts.flashSwapContract = null;
             console.log("[Contracts] FlashSwap contract instance skipped (address not configured).");
        }

        // Instantiate Quoter V2
        contracts.quoterContract = new ethers.Contract(config.QUOTER_V2_ADDRESS, IQuoterV2ABI, provider);

        // Instantiate Pool A
         if (config.POOL_A_ADDRESS && config.POOL_A_ADDRESS !== ethers.ZeroAddress) {
             contracts.poolAContract = new ethers.Contract(config.POOL_A_ADDRESS, IUniswapV3PoolABI, provider);
         } else {
             console.warn(`[Contracts] Skipping Pool A instance (ZeroAddress in config for ${config.CHAIN_ID})`);
             contracts.poolAContract = null;
         }

        // Instantiate Pool B
         if (config.POOL_B_ADDRESS && config.POOL_B_ADDRESS !== ethers.ZeroAddress) {
              contracts.poolBContract = new ethers.Contract(config.POOL_B_ADDRESS, IUniswapV3PoolABI, provider);
         } else {
              console.warn(`[Contracts] Skipping Pool B instance (ZeroAddress in config for ${config.CHAIN_ID})`);
              contracts.poolBContract = null;
         }

         // <<< Instantiate Pool C (if address exists and is not ZeroAddress) >>>
         if (config.POOL_C_ADDRESS && config.POOL_C_ADDRESS !== ethers.ZeroAddress) {
              contracts.poolCContract = new ethers.Contract(config.POOL_C_ADDRESS, IUniswapV3PoolABI, provider);
              console.log("[Contracts] Pool C instance created.");
         } else {
              console.log(`[Contracts] Skipping Pool C instance (Not configured or ZeroAddress for ${config.CHAIN_ID})`);
              contracts.poolCContract = null; // Ensure it's null if not created
         }


        console.log("[Contracts] Contract instances created.");

        return contracts;

    } catch (error) {
        console.error("[Contracts] Error during contract instantiation:", error);
        throw new Error(`Failed to initialize contracts: ${error.message}`);
    }
}

module.exports = { initializeContracts };
