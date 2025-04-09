// bot.js - Entry Point
const { ethers } = require('ethers');
const config = require('./config');
const { fetchABIWithCache } = require('./helpers/abiFetcher');
const { initializeContracts } = require('./helpers/contracts');
const { monitorPools } = require('./helpers/monitor');

// --- Main Bot Function ---
async function startBot() {
    console.log(">>> Bot starting up...");

    // --- Setup Provider & Signer ---
    let provider, signer;
    try {
        console.log("[Init] Setting up Provider and Signer...");
        provider = new ethers.JsonRpcProvider(config.RPC_URL);
        signer = new ethers.Wallet(config.PRIVATE_KEY, provider);
        console.log(`[Init] Signer Address: ${signer.address}`);
        // Test connection early
        const blockNumber = await provider.getBlockNumber();
        console.log(`[Init] Connected to network. Current block: ${blockNumber}`);
    } catch (error) {
        console.error("[Init] CRITICAL: Failed to setup Provider/Signer or connect to network.", error);
        throw error; // Stop execution if provider/signer fails
    }

    // --- Fetch Dynamic ABI ---
    let flashSwapABI;
    try {
        console.log("[Init] Fetching FlashSwap Contract ABI...");
        flashSwapABI = await fetchABIWithCache(config.FLASH_SWAP_CONTRACT_ADDRESS);
        if (!flashSwapABI || !Array.isArray(flashSwapABI) || flashSwapABI.length === 0) {
             throw new Error(`Invalid ABI received for FlashSwap contract (${config.FLASH_SWAP_CONTRACT_ADDRESS}).`);
        }
         console.log("[Init] FlashSwap ABI obtained successfully.");
    } catch (error) {
        console.error("[Init] CRITICAL: Failed to fetch FlashSwap ABI.", error);
        throw error; // Stop execution
    }

    // --- Instantiate Contracts ---
    let contracts;
    try {
        contracts = initializeContracts(provider, signer, flashSwapABI);
    } catch (error) {
         console.error("[Init] CRITICAL: Failed to initialize contracts.", error);
         throw error; // Stop execution
    }

    // --- Create State Object ---
    // This object will be passed around, holding shared resources
    const state = {
        provider,
        signer,
        contracts,
        config,
        opportunity: null // Placeholder for detected opportunities
    };

    // --- Initial Logs & Checks ---
    console.log("[Init] Configuration Loaded:");
    console.log(` - Monitoring Pools: A=(${config.POOL_A_ADDRESS}), B=(${config.POOL_B_ADDRESS})`);
    console.log(` - Fees: A=${config.POOL_A_FEE_PERCENT}%, B=${config.POOL_B_FEE_PERCENT}%`);
    console.log(` - Borrow Amount: ${config.BORROW_AMOUNT_WETH_STR} WETH`);
    console.log(` - Min Gross Profit Threshold: ${config.MIN_POTENTIAL_GROSS_PROFIT_WETH_STR} WETH (Pre-fees)`);
    console.log(` - Polling Interval: ${config.POLLING_INTERVAL_MS / 1000} seconds`);

    console.log("[Init] Performing startup checks...");
    try {
        const balance = await provider.getBalance(signer.address);
        console.log(`[Check] Signer Balance: ${ethers.formatEther(balance)} ETH`);
        if (balance === 0n) {
            console.warn("[Check] Warning: Signer balance is zero.");
        }

        // Check if flash swap contract has an owner function (basic ABI check)
        if (contracts.flashSwapContract.owner && typeof contracts.flashSwapContract.owner === 'function') {
             const owner = await contracts.flashSwapContract.owner();
             console.log(`[Check] FlashSwap Contract Owner: ${owner}`);
             if (owner.toLowerCase() !== signer.address.toLowerCase()) {
                 console.warn("[Check] Warning: Signer address does not match the FlashSwap contract owner.");
             }
        } else {
             console.warn("[Check] Warning: Could not check FlashSwap contract owner (function missing in ABI?).");
        }
        console.log("[Init] Startup checks complete.");

    } catch (checkError) {
        console.error("[Init] Error during startup checks:", checkError);
        // Decide if this is critical enough to stop
        // throw checkError;
    }

    // --- Start Monitoring Loop ---
    console.log("\n>>> Starting Monitoring Loop <<<");
    await monitorPools(state); // Run once immediately

    setInterval(() => {
        // Wrap the monitorPools call in a try-catch to prevent unhandled errors
        // from stopping the interval timer.
        try {
             monitorPools(state);
        } catch(monitorError) {
            console.error("!!! Unhandled Error in monitorPools interval !!!", monitorError);
            // Consider adding more robust error handling here, like restarting parts?
        }
    }, config.POLLING_INTERVAL_MS);

    console.log(`>>> Monitoring active. Press Ctrl+C to stop.`);

} // End startBot function

// --- Execute Bot ---
startBot().catch(error => {
    console.error("\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    console.error("BOT FAILED TO INITIALIZE / CRITICAL ERROR:");
    console.error(error);
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    process.exit(1); // Exit with error code
});
