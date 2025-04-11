// bot.js - Multi-Chain Entry Point
const { ethers } = require('ethers');
const { getConfig } = require('./config'); // Import the getConfig function
const { initializeContracts } = require('./helpers/contracts');
const { monitorPools } = require('./helpers/monitor');

// --- Main Bot Function ---
async function startBot() {
    console.log(">>> Bot starting up...");

    // --- Determine Target Network ---
    const networkName = process.env.NETWORK; // e.g., 'polygon', 'base', 'arbitrum'
    if (!networkName) {
        console.error("[Init] Error: NETWORK environment variable not set.");
        console.error("Usage: cross-env NETWORK=arbitrum node bot.js");
        process.exit(1);
    }
    console.log(`[Init] Target Network: ${networkName}`);

    // --- Load Network-Specific Config ---
    let config;
    try {
        config = getConfig(networkName);
        console.log(`[Init] Loaded configuration for ${config.CHAIN_ID}`);
    } catch (error) {
        console.error(`[Init] CRITICAL: Failed to load config for network "${networkName}".`, error);
        process.exit(1);
    }

    // --- Setup Provider & Signer ---
    let provider, signer;
    try {
        console.log("[Init] Setting up Provider and Signer...");
        provider = new ethers.JsonRpcProvider(config.RPC_URL); // Use RPC from config
        // Validate connection early
        const network = await provider.getNetwork();
        if (network.chainId !== BigInt(config.CHAIN_ID)) {
             console.warn(`[Init] Warning: Provider chain ID (${network.chainId}) does not match config chain ID (${config.CHAIN_ID}) for ${networkName}.`);
        } else {
             console.log(`[Init] Connected to ${networkName} (Chain ID: ${network.chainId}). Current block: ${await provider.getBlockNumber()}`);
        }
        // Use private key from .env (shared across networks in this setup)
        signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
        console.log(`[Init] Signer Address: ${signer.address}`);
    } catch (error) {
        console.error("[Init] CRITICAL: Failed to setup Provider/Signer or connect to network.", error);
        process.exit(1); // Stop execution if provider/signer fails
    }

    // --- Instantiate Contracts ---
    let contracts;
    try {
        // Pass the loaded network-specific config to initializeContracts
        contracts = initializeContracts(provider, signer, config); // Pass config
    } catch (error) {
         console.error("[Init] CRITICAL: Failed to initialize contracts.", error);
         process.exit(1); // Stop execution
    }

    // --- Create State Object ---
    const state = {
        networkName: networkName, // Add network name to state
        provider,
        signer,
        contracts,
        config, // The network-specific config
        opportunity: null
    };

    // --- Initial Logs & Checks ---
    console.log("[Init] Configuration Details:");
    console.log(` - Chain ID: ${config.CHAIN_ID}`);
    console.log(` - FlashSwap Contract: ${config.FLASH_SWAP_CONTRACT_ADDRESS || 'Not Deployed Yet'}`);
    console.log(` - Pool A (Fee ${config.POOL_A_FEE_BPS}bps): ${config.POOL_A_ADDRESS}`);
    console.log(` - Pool B (Fee ${config.POOL_B_FEE_BPS}bps): ${config.POOL_B_ADDRESS}`);
    console.log(` - QuoterV2: ${config.QUOTER_V2_ADDRESS}`);
    console.log(` - Borrow Amount: ${config.BORROW_AMOUNT_WETH_STR} WETH`);
    console.log(` - Min Net Profit: ${ethers.formatUnits(config.MIN_NET_PROFIT_WEI, config.WETH_DECIMALS)} WETH`);
    console.log(` - Polling Interval: ${config.POLLING_INTERVAL_MS / 1000} seconds`);

    console.log("[Init] Performing startup checks...");
    try {
        const balance = await provider.getBalance(signer.address);
        const nativeCurrency = networkName === 'polygon' ? 'MATIC' : 'ETH';
        console.log(`[Check] Signer Balance: ${ethers.formatEther(balance)} ${nativeCurrency}`);
        if (balance === 0n) {
            console.warn(`[Check] Warning: Signer balance is zero on ${networkName}.`);
        }

        // Check flash swap contract owner only if address is set
        if (config.FLASH_SWAP_CONTRACT_ADDRESS && config.FLASH_SWAP_CONTRACT_ADDRESS !== "") {
            if (contracts.flashSwapContract && typeof contracts.flashSwapContract.owner === 'function') {
                 const owner = await contracts.flashSwapContract.owner();
                 console.log(`[Check] FlashSwap Contract Owner: ${owner}`);
                 if (owner.toLowerCase() !== signer.address.toLowerCase()) {
                     console.warn("[Check] Warning: Signer address does not match the FlashSwap contract owner.");
                 }
            } else {
                 console.warn("[Check] Warning: Could not check FlashSwap contract owner (contract instance or function missing?).");
            }
        } else {
            console.log("[Check] Skipping FlashSwap owner check (contract address not set in config).");
        }
        console.log("[Init] Startup checks complete.");

    } catch (checkError) {
        console.error("[Init] Error during startup checks:", checkError);
    }

    // --- Start Monitoring Loop ---
    // Ensure FlashSwap contract is deployed before starting monitor if needed for execution
    if (!config.FLASH_SWAP_CONTRACT_ADDRESS || config.FLASH_SWAP_CONTRACT_ADDRESS === "") {
         console.error(`[Init] CRITICAL: FLASH_SWAP_CONTRACT_ADDRESS not set for network ${networkName} in config. Bot cannot execute swaps. Exiting.`);
         process.exit(1);
    }
    // Check Pool addresses aren't placeholders (unless Base, which we know failed)
    if (networkName !== 'base') {
        if (config.POOL_A_ADDRESS.includes("_ADDRESS") || config.POOL_B_ADDRESS.includes("_ADDRESS")) {
            console.error(`[Init] CRITICAL: Pool address placeholders detected for network ${networkName} in config. Please update. Exiting.`);
            process.exit(1);
        }
    }


    console.log(`\n>>> Starting Monitoring Loop for ${networkName.toUpperCase()} <<<`);
    // Pass the fully initialized state object to monitorPools
    await monitorPools(state); // Run once immediately

    setInterval(() => {
        try {
             monitorPools(state);
        } catch(monitorError) {
            console.error(`!!! Unhandled Error in monitorPools interval (${networkName}) !!!`, monitorError);
        }
    }, config.POLLING_INTERVAL_MS);

    console.log(`>>> Monitoring active on ${networkName}. Press Ctrl+C to stop.`);

} // End startBot function

// --- Execute Bot ---
startBot().catch(error => {
    console.error("\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    console.error("BOT FAILED TO INITIALIZE / CRITICAL ERROR:");
    console.error(error);
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    process.exit(1); // Exit with error code
});
