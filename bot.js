// bot.js - Multi-Chain Entry Point
require('dotenv').config(); // Load environment variables first
const { ethers } = require('ethers');
// --- CORRECTED IMPORT ---
// Import the entire exported config object directly
const config = require('./config/index.js')
// --- Access constants from the imported config ---
const MIN_NET_PROFIT_WEI = config.MIN_NET_PROFIT_WEI;
const FLASH_LOAN_FEE_BPS = config.FLASH_LOAN_FEE_BPS;
// -------------------------

const { initializeContracts } = require('./helpers/contracts');
const { monitorPools } = require('./helpers/monitor');

// --- Main Bot Function ---
async function startBot() {
    console.log(">>> Bot starting up...");

    // The 'config' variable now holds the specific configuration for the network
    // determined by the NETWORK environment variable. config.js handles errors if invalid.
    const networkName = config.NAME; // Get network name from the loaded config (This should work now)
    console.log(`[Init] Target Network: ${networkName}`);
    console.log(`[Init] Loaded configuration for Chain ID: ${config.CHAIN_ID}`);

    // --- Setup Provider & Signer ---
    let provider, signer;
    try {
        console.log("[Init] Setting up Provider and Signer...");
        if (!config.RPC_URL) {
             throw new Error(`RPC_URL is missing in configuration for network ${networkName}. Check .env and config.js.`);
        }
        provider = new ethers.JsonRpcProvider(config.RPC_URL); // Use RPC from config

        // Validate connection early
        const networkInfo = await provider.getNetwork();
        if (networkInfo.chainId !== BigInt(config.CHAIN_ID)) {
             // Allow mismatch but warn, as some testnets/forks might report different IDs initially
             console.warn(`[Init] WARNING: Provider chain ID (${networkInfo.chainId}) does not strictly match config chain ID (${config.CHAIN_ID}) for ${networkName}. Ensure provider is correct.`);
        } else {
             console.log(`[Init] Connected to ${networkName} (Chain ID: ${networkInfo.chainId}). Current block: ${await provider.getBlockNumber()}`);
        }

        // Use private key from .env
        const privateKey = process.env.PRIVATE_KEY;
        if (!privateKey || !privateKey.startsWith('0x')) { // Basic validation
            throw new Error("PRIVATE_KEY environment variable not set or invalid format (must start with 0x).");
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
        contracts = initializeContracts(provider, signer, config); // Pass the loaded config
        if (!contracts.flashSwapContract) {
             console.warn("[Init] Warning: FlashSwap contract instance was not created. Check address in .env and initializeContracts logic.");
             // Decide if this is critical - likely yes for flash swaps
             if (config.FLASH_SWAP_CONTRACT_ADDRESS === ethers.ZeroAddress) {
                throw new Error(`FLASH_SWAP_CONTRACT_ADDRESS is not set for network ${networkName} in .env`);
             }
        }
        if (!contracts.quoterContract) {
             console.warn("[Init] Warning: Quoter contract instance was not created.");
             // Can potentially proceed without quoter if simulation is purely SDK based, but better to have it.
        }

    } catch (error) {
         console.error("[Init] CRITICAL: Failed to initialize contracts.", error);
         process.exit(1); // Stop execution
    }

    // --- Create State Object ---
    const state = {
        provider,
        signer,
        contracts,
        config, // Pass the fully loaded, network-specific config
        networkName: networkName, // Keep network name for logging clarity
        // MIN_NET_PROFIT_WEI and FLASH_LOAN_FEE_BPS are already inside config now
        opportunity: null // Placeholder for found opportunities
    };

    // --- Initial Logs & Checks ---
    console.log("[Init] Configuration Details:");
    console.log(` - FlashSwap Contract: ${config.FLASH_SWAP_CONTRACT_ADDRESS}`);
    console.log(` - QuoterV2: ${config.QUOTER_ADDRESS}`);
    console.log(` - Configured Pool Groups: ${Object.keys(config.POOL_GROUPS).join(', ')}`);
    let totalPools = 0;
    for (const groupName in config.POOL_GROUPS) {
        const group = config.POOL_GROUPS[groupName];
        // Tokens are now objects within the group in the new config
        if (!group.token0 || !group.token1 || !group.borrowToken || !group.quoteToken || !group.pools) {
             console.error(`[Init] ERROR: Incomplete POOL_GROUP configuration for "${groupName}"`);
             process.exit(1);
        }
        console.log(`   - Group [${groupName}]: ${group.token0.symbol}/${group.token1.symbol}`);
        console.log(`     - Borrow Token: ${group.borrowToken.symbol} (${ethers.formatUnits(group.borrowAmount, group.borrowToken.decimals)})`);
        group.pools.forEach(p => console.log(`     - Pool Fee: ${p.feeBps/100}%, Address: ${p.address}`));
        totalPools += group.pools.length;
        console.log(`     - Min Net Profit: ${ethers.formatUnits(group.minNetProfit, group.quoteToken.decimals)} ${group.quoteToken.symbol}`);
    }

    console.log("[Init] Performing startup checks...");
    try {
        const balance = await provider.getBalance(signer.address);
        const nativeCurrency = config.NATIVE_SYMBOL || 'ETH'; // Use from config

        console.log(`[Check] Signer Balance: ${ethers.formatEther(balance)} ${nativeCurrency}`);
        if (balance === 0n) {
            console.warn(`[Check] Warning: Signer balance is zero on ${networkName}. Execution will fail.`);
        }

        // Check flash swap contract owner - ensure contract instance exists
        if (contracts.flashSwapContract && typeof contracts.flashSwapContract.owner === 'function') {
             const owner = await contracts.flashSwapContract.owner();
             console.log(`[Check] FlashSwap Contract Owner: ${owner}`);
             if (owner.toLowerCase() !== signer.address.toLowerCase()) {
                 console.warn("[Check] Warning: Signer address does not match the FlashSwap contract owner.");
             }
        } else if (config.FLASH_SWAP_CONTRACT_ADDRESS !== ethers.ZeroAddress) {
             console.warn("[Check] Warning: Could not check FlashSwap contract owner (contract instance missing or owner function not available?).");
        } else {
            console.log("[Check] FlashSwap Contract address not configured, skipping owner check.");
        }

        // Check if any pools are configured at all
        if (totalPools === 0) {
            console.error(`[Init] CRITICAL: No valid pool addresses found in config for network ${networkName}. Check .env variables and config.js POOL_GROUPS. Exiting.`);
            process.exit(1);
        } else {
            console.log(`[Check] Found ${totalPools} pool addresses across all configured groups.`);
        }

        console.log("[Init] Startup checks complete.");

    } catch (checkError) {
        console.error("[Init] Error during startup checks:", checkError);
        // Decide if startup check errors are critical
        // process.exit(1); // Consider exiting if checks fail critically
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
                // Create a fresh feeData object for each cycle if needed by monitor/arbitrage
                // state.feeData = await provider.getFeeData(); // Option to refresh feeData per cycle
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
    console.error(error); // Log the actual error object
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    process.exit(1); // Exit with error code
});
