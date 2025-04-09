// helpers/contracts.js
const { ethers } = require('ethers');
const config = require('../config'); // Adjust path as needed

// Load static ABIs
const IUniswapV3PoolABI = require('../abis/IUniswapV3Pool.json');
const IQuoterV2ABI = require('../abis/IQuoterV2.json');

function initializeContracts(provider, signer, flashSwapABI) {
    console.log("[Contracts] Initializing contract instances...");

    if (!provider) throw new Error("Provider is required for contract initialization");
    if (!signer) throw new Error("Signer is required for FlashSwap contract initialization");
    if (!flashSwapABI || !Array.isArray(flashSwapABI) || flashSwapABI.length === 0) {
        throw new Error("Valid FlashSwap ABI is required for contract initialization");
    }

    try {
        const contracts = {
            flashSwapContract: new ethers.Contract(config.FLASH_SWAP_CONTRACT_ADDRESS, flashSwapABI, signer),
            quoterContract: new ethers.Contract(config.QUOTER_V2_ADDRESS, IQuoterV2ABI, provider),
            poolAContract: new ethers.Contract(config.POOL_A_ADDRESS, IUniswapV3PoolABI, provider),
            poolBContract: new ethers.Contract(config.POOL_B_ADDRESS, IUniswapV3PoolABI, provider),
        };
        console.log("[Contracts] All contract instances created successfully.");
        return contracts;
    } catch (error) {
        console.error("[Contracts] Error initializing contracts:", error);
        throw new Error(`Failed to initialize contracts: ${error.message}`);
    }
}

module.exports = { initializeContracts };
