// bot.js - Multi-Chain Entry Point
require('dotenv').config(); // Load environment variables first
const { ethers } = require('ethers');
const { config, MIN_NET_PROFIT_WEI, FLASH_LOAN_FEE_BPS } = require('./config'); // Directly import selected config and constants
const { initializeContracts } = require('./helpers/contracts');
const { monitorPools } = require('./helpers/monitor');

// --- Main Bot Function ---
async function startBot() {
    console.log(">>> Bot starting up...");

    // --- Network Config is Already Loaded by require('./config') ---
    // The 'config' variable now holds the specific configuration for the network
    // determined by the NETWORK environment variable. config.js handles errors if invalid.
    const networkName = config.NAME; // Get network name from the loaded config
    console.log(`[Init] Target Network: ${networkName}`);
    console.log(`[Init] Loaded configuration for Chain ID: ${config.CHAIN_ID}`);

    // --- Setup Provider & Signer ---
    let provider, signer;
    try {
        console.log("[Init] Setting up Provider and Signer...");
        provider = new ethers.JsonRpcProvider(config.RPC_URL); // Use RPC from config

        // Validate connection early
        const networkInfo = await provider.getNetwork();
        if (networkInfo.chainId !== BigInt(config.CHAIN_ID)) {
             console.warn(`[Init] Warning: Provider chain ID (${networkInfo.chainId}) does not match config chain ID (${config.CHAIN_ID}) for ${networkName}.`);
        } else {
             console.log(`[Init] Connected to ${networkName} (Chain ID: ${networkInfo.chainId}). Current block: ${await provider.getBlockNumber()}`);
        }

        // Use private key from .env
        const privateKey = process.env.PRIVATE_KEY;
        if (!privateKey) {
            throw new Error("PRIVATE_KEY environment variable not set.");
        }
        signer = new ethers.Wallet(privateKey, provider);
        console.log(`[Init] Signer Address: ${signer.address}`);

    } catch (error) {
        console.error("[Init] CRITICAL: Failed to setup Provider/Signer or connect to network.", error);
        process.exit(1); // Stop execution if provider/signer fails
    }

    // --- Instantiate Contracts ---
    let contracts;
    try {
        // Pass the loaded network-specific config to initializeContracts
        contracts = initializeContracts(provider, signer, config); // Pass the already loaded config
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
        minNetProfitWei: MIN_NET_PROFIT_WEI, // Pass thresholds too
        flashLoanFeeBps: FLASH_LOAN_FEE_BPS,
        opportunity: null
    };

    // --- Initial Logs & Checks ---
    console.log("[Init] Configuration Details:");
    console.log(` - FlashSwap Contract: ${config.FLASH_SWAP_CONTRACT_ADDRESS}`);
    console.log(` - QuoterV2: ${config.QUOTER_ADDRESS}`); // Use correct QUOTER_ADDRESS key
    // Log configured pool groups
    console.log(` - Configured Pool Groups: ${Object.keys(config.POOL_GROUPS).join(', ')}`);
    for (const groupName in config.POOL_GROUPS) {
        const group = config.POOL_GROUPS[groupName];
        const token0 = config.TOKENS[group.token0];
        const token1 = config.TOKENS[group.token1];
        const quoteToken = config.TOKENS[group.quoteTokenSymbol];
        if (!token0 || !token1 || !quoteToken) {
             console.error(`[Init] ERROR: Invalid token symbols (${group.token0}, ${group.token1}, ${group.quoteTokenSymbol}) in POOL_GROUP "${groupName}"`);
             process.exit(1);
        }
        console.log(`   - Group [${groupName}]: ${token0.symbol}/${token1.symbol}`);
        group.pools.forEach(p => console.log(`     - Fee: ${p.feeBps/100}%, Address: ${p.address}`));
        // Log min profit based on the group's quote token
        if (MIN_NET_PROFIT_WEI[group.quoteTokenSymbol]) {
            console.log(`     - Min Net Profit: ${ethers.formatUnits(MIN_NET_PROFIT_WEI[group.quoteTokenSymbol], quoteToken.decimals)} ${group.quoteTokenSymbol}`);
        } else {
            console.warn(`     - Warning: MIN_NET_PROFIT_WEI not defined for quote token ${group.quoteTokenSymbol}`);
        }
    }
    // Removed BORROW_AMOUNT log as it's not fixed anymore
    // Removed POLLING_INTERVAL log as it's not in the shared config part anymore, implicitly handled by setInterval

    console.log("[Init] Performing startup checks...");
    try {
        const balance = await provider.getBalance(signer.address);
        // Determine native currency symbol based on network
        let nativeCurrency = 'ETH'; // Default
        if (networkName === 'polygon') nativeCurrency = 'MATIC';
        // Add others if needed (e.g., BNB for BSC)

        console.log(`[Check] Signer Balance: ${ethers.formatEther(balance)} ${nativeCurrency}`);
        if (balance === 0n) {
            console.warn(`[Check] Warning: Signer balance is zero on ${networkName}. Execution will fail.`);
        }

        // Check flash swap contract owner
        if (contracts.flashSwapContract && typeof contracts.flashSwapContract.owner === 'function') {
             const owner = await contracts.flashSwapContract.owner();
             console.log(`[Check] FlashSwap Contract Owner: ${owner}`);
             if (owner.toLowerCase() !== signer.address.toLowerCase()) {
                 console.warn("[Check] Warning: Signer address does not match the FlashSwap contract owner.");
             }
        } else {
             console.warn("[Check] Warning: Could not check FlashSwap contract owner (contract instance or function missing?).");
        }

        // Check if any pools are configured at all
        let totalPools = 0;
        for (const groupName in config.POOL_GROUPS) {
            totalPools += config.POOL_GROUPS[groupName].pools.length;
        }
        if (totalPools === 0) {
            console.error(`[Init] CRITICAL: No valid pool addresses found in config for network ${networkName}. Check .env variables and config.js. Exiting.`);
            process.exit(1);
        } else {
            console.log(`[Check] Found ${totalPools} pool addresses across all configured groups.`);
        }

        console.log("[Init] Startup checks complete.");

    } catch (checkError) {
        console.error("[Init] Error during startup checks:", checkError);
        // Decide if startup check errors are critical
        // process.exit(1);
    }

    // --- Start Monitoring Loop ---
    const pollingIntervalMs = config.BLOCK_TIME_MS || 5000; // Use block time or default
    console.log(`[Init] Polling Interval: ${pollingIntervalMs / 1000} seconds (based on approx block time)`);


    console.log(`\n>>> Starting Monitoring Loop for ${networkName.toUpperCase()} <<<`);
    // Pass the fully initialized state object to monitorPools
    await monitorPools(state); // Run once immediately

    setInterval(() => {
        // Wrap monitorPools call in a try-catch to prevent interval from stopping on error
        (async () => {
            try {
                await monitorPools(state);
            } catch (monitorError) {
                console.error(`!!! Unhandled Error in monitorPools interval (${networkName}) !!!`, monitorError);
                // Consider adding more robust error handling here, e.g., exponential backoff, circuit breaker
            }
        })(); // IIAFE: Immediately Invoked Async Function Expression
    }, pollingIntervalMs); // Use polling interval from config

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
