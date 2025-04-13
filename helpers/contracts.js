// helpers/contracts.js
const { ethers } = require('ethers');

// Load static ABIs
const IUniswapV3PoolABI = require('../abis/IUniswapV3Pool.json');
const IQuoterV2ABI = require('../abis/IQuoterV2.json');
const FlashSwapABI = require('../abis/FlashSwap.json');

/**
 * Initializes contract instances based on network config, including all defined pools.
 */
function initializeContracts(provider, signer, config) {
    console.log(`[Contracts] Initializing contract instances for network ${config.CHAIN_ID}...`);

    if (!provider || !signer || !config) throw new Error("[Contracts] Provider, Signer, and Config required.");
    if (!FlashSwapABI || !IUniswapV3PoolABI || !IQuoterV2ABI) throw new Error("[Contracts] Failed to load required static ABIs.");
    // --- CORRECTED LINE HERE (check) ---
    if (!config.QUOTER_ADDRESS) throw new Error("[Contracts] QUOTER_ADDRESS missing in config.");

    try {
        const contracts = {
            poolContracts: {}, // Store pool contracts keyed by address
            quoterContract: null,
            flashSwapContract: null,
        };

        // Instantiate FlashSwap contract (if address provided)
        if (config.FLASH_SWAP_CONTRACT_ADDRESS && config.FLASH_SWAP_CONTRACT_ADDRESS !== ethers.ZeroAddress) { // Check against ZeroAddress
             contracts.flashSwapContract = new ethers.Contract(config.FLASH_SWAP_CONTRACT_ADDRESS, FlashSwapABI, signer);
        } else { console.log("[Contracts] FlashSwap contract instance skipped (address not configured or is ZeroAddress)."); }

        // Instantiate Quoter V2
        // --- CORRECTED LINE HERE (instantiation) ---
        contracts.quoterContract = new ethers.Contract(config.QUOTER_ADDRESS, IQuoterV2ABI, provider);

        // Instantiate ALL defined pools from ALL groups
        console.log("[Contracts] Initializing pool contracts...");
        let poolCount = 0;
        for (const groupKey in config.POOL_GROUPS) {
            const group = config.POOL_GROUPS[groupKey];
            console.log(`  [Group: ${groupKey}]`);
            if (!group || !Array.isArray(group.pools)) {
                console.warn(`    Skipping invalid pool group: ${groupKey}`);
                continue;
            }
            for (const poolInfo of group.pools) {
                const address = poolInfo.address;
                // Skip if already instantiated or if address is invalid/zero
                if (!address || address === ethers.ZeroAddress || contracts.poolContracts[address]) {
                    if (address === ethers.ZeroAddress) console.log(`    Skipping pool with ZeroAddress.`);
                    continue;
                }
                try {
                    contracts.poolContracts[address] = new ethers.Contract(address, IUniswapV3PoolABI, provider);
                    console.log(`    Instantiated Pool: ${address} (Fee: ${poolInfo.feeBps})`);
                    poolCount++;
                } catch (poolError) {
                     console.error(`    ERROR Instantiating Pool ${address}: ${poolError.message}`);
                }
            }
        }
        console.log(`[Contracts] Initialized ${poolCount} unique pool contracts.`);
        console.log("[Contracts] All contract instances created.");

        return contracts;

    } catch (error) {
        console.error("[Contracts] Error during contract instantiation:", error);
        throw new Error(`Failed to initialize contracts: ${error.message}`);
    }
}

module.exports = { initializeContracts };
