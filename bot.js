// bot.js - Arbitrum Uniswap V3 Flash Swap Bot with Debugging (v22.1 - Passing State)

const { ethers } = require("ethers");
const axios = require("axios");
require('dotenv').config();

// --- Configuration ---
// ... (Keep all configuration constants) ...
const RPC_URL = process.env.ARBITRUM_RPC_URL;
// ... etc ...
const POOL_A_ADDRESS = "0xc6962004f452be9203591991d15f6b388e09e8d0";
const POOL_B_ADDRESS = "0x17c14d2c404d167802b16c450d3c99f88f2c4f4d";


// --- ABIs ---
// Keep minimal standard ABIs for Pool & Quoter
const IUniswapV3PoolABI = [ /* ... */ ];
const IQuoterV2ABI = [ /* ... full ABI with nonpayable ... */ ];


// --- Bot Settings ---
// ... (Keep settings) ...

// --- ABI Fetching Function ---
async function fetchABIFromArbiscan(contractAddress) { /* ... (Keep this function) ... */ }


// --- Helper Functions ---

// MODIFIED: Accept contracts/config from state object
async function simulateSwap(poolDesc, tokenIn, tokenOut, amountInWei, feeBps, quoterContract) { // Pass quoter directly
    // Check if quoterContract was passed and initialized
    if (!quoterContract) { console.error(`[SimulateSwap] Quoter contract instance not provided!`); return false; }

    const params = { tokenIn, tokenOut, amountIn: amountInWei, fee: feeBps, sqrtPriceLimitX96: 0n };
    console.log(`  [Quoter Sim using estimateGas - ${poolDesc}] Params:`, { /* ... */ });
    try {
        await quoterContract.quoteExactInputSingle.estimateGas(params); // Use passed contract
        console.log(`  [Quoter Sim using estimateGas - ${poolDesc}] SUCCESS (Simulation likely ok)`);
        return true;
    } catch (error) { /* ... error handling ... */ return false; }
}

// MODIFIED: Accept contracts/config from state object
async function attemptArbitrage(state) { // Accept full state
     console.log("\n========= Arbitrage Opportunity Detected (Simplified Test) =========");
     console.log(">>> Entering attemptArbitrage (Simplified)...");

     // Destructure needed items from state
     const { flashSwapContract, poolAContract, poolBContract } = state.contracts;
     const { config } = state; // Assuming config is part of state if needed, or access globals

     // Check if necessary contracts are initialized
     if (!flashSwapContract || !poolAContract || !poolBContract) {
         console.error("  [Attempt] One or more contract instances not available in state. Aborting.");
         return;
     }

     // --- Use state.config or global config constants ---
     const BORROW_AMOUNT_WETH_WEI = ethers.parseUnits("0.00005", WETH_DECIMALS); // Example using global

    // Minimal setup just for the call
    let flashLoanPoolAddress; let borrowAmount0 = 0n; let borrowAmount1 = 0n;
    let encodedParams = "0x";
    let tokenBorrowedAddress, tokenIntermediateAddress, poolAForSwap, poolBForSwap, feeAForSwap, feeBForSwap, amountToBorrowWei;

    try {
        console.log(">>> Setting up simplified params...");
        // Use global config addresses directly
        flashLoanPoolAddress = POOL_A_ADDRESS;
        amountToBorrowWei = BORROW_AMOUNT_WETH_WEI;
        borrowAmount0 = amountToBorrowWei; borrowAmount1 = 0n;
        tokenBorrowedAddress = WETH_ADDRESS; tokenIntermediateAddress = USDC_ADDRESS;
        poolAForSwap = POOL_A_ADDRESS; feeAForSwap = POOL_A_FEE_BPS;
        poolBForSwap = POOL_B_ADDRESS; feeBForSwap = POOL_B_FEE_BPS;

        const arbitrageParams = { /* ... */ };
        encodedParams = ethers.AbiCoder.defaultAbiCoder().encode( /* ... */ );
        console.log(">>> Simplified Params Set. Encoded:", encodedParams.substring(0, 100) + "...");

        const initiateFlashSwapArgs = [ flashLoanPoolAddress, borrowAmount0, borrowAmount1, encodedParams ];

        console.log(">>> Entering TRY block for staticCall...");
        if (!flashSwapContract.initiateFlashSwap) { throw new Error("Fetched FlashSwap ABI does not contain 'initiateFlashSwap' function."); }
        await flashSwapContract.initiateFlashSwap.staticCall( ...initiateFlashSwapArgs, { gasLimit: 3_000_000 });
        console.log(">>> STATIC CALL SUCCEEDED (Simplified Test) <<<");

    } catch (error) {
        console.error(">>> STATIC CALL FAILED (Simplified Test) <<<");
        // ... (keep detailed error logging) ...
    }
    console.log("========= Arbitrage Attempt Complete (Simplified) =========");
}


// MODIFIED: Accept state object
async function monitorPools(state) {
    console.log(`\n[Monitor] START - ${new Date().toISOString()}`);

    // Destructure needed items from state
    const { poolAContract, poolBContract, quoterContract } = state.contracts;
    const { config } = state; // Or use global config constants directly

     // Check if contracts are initialized before proceeding
     if (!poolAContract || !poolBContract || !quoterContract) {
         console.error("[Monitor] Contract instances not available in state. Skipping cycle.");
         console.log(`[Monitor] END (Early exit due to uninitialized contracts) - ${new Date().toISOString()}`);
         return;
     }
    try {
        console.log("  [Monitor] Fetching pool states...");
        // Use contracts from state
        const poolStatePromises = [
            poolAContract.slot0().catch(e => { console.error(`[Monitor] Error fetching slot0 for Pool A: ${e.message || e}`); return null; }),
            poolAContract.liquidity().catch(e => { console.error(`[Monitor] Error fetching liquidity for Pool A: ${e.message || e}`); return null; }),
            poolBContract.slot0().catch(e => { console.error(`[Monitor] Error fetching slot0 for Pool B: ${e.message || e}`); return null; }),
            poolBContract.liquidity().catch(e => { console.error(`[Monitor] Error fetching liquidity for Pool B: ${e.message || e}`); return null; })
        ];
        const [slotA, liqA, slotB, liqB] = await Promise.all(poolStatePromises);
        console.log("  [Monitor] Promise.all for pool states resolved.");

        // ... (Keep state logging & checks) ...
        let poolAStateFetched = slotA && liqA !== null; let poolBStateFetched = slotB && liqB !== null;
        if (!poolAStateFetched || !poolBStateFetched) { /* ... */ return; }

        // Simulate using estimateGas
        const simulateAmountWeth = ethers.parseUnits("0.001", WETH_DECIMALS);
        console.log(`  [Monitor] Simulating Quoter calls via estimateGas using ${ethers.formatUnits(simulateAmountWeth, WETH_DECIMALS)} WETH...`);
        // Pass quoterContract from state to simulateSwap
        const [simASuccess, simBSuccess] = await Promise.all([
             simulateSwap("Pool A", WETH_ADDRESS, USDC_ADDRESS, simulateAmountWeth, POOL_A_FEE_BPS, quoterContract),
             simulateSwap("Pool B", WETH_ADDRESS, USDC_ADDRESS, simulateAmountWeth, POOL_B_FEE_BPS, quoterContract)
        ]);
        console.log(`  [Monitor] Quoter simulations results. Sim A Success: ${simASuccess}, Sim B Success: ${simBSuccess}`);

        if (simASuccess && simBSuccess) {
             console.log("  [Monitor] Both Quoter simulations succeeded via estimateGas. Proceeding to attemptArbitrage.");
             const pseudoOpportunity = { /* ... placeholder ... */ };
             // Pass the whole state object to attemptArbitrage
             await attemptArbitrage(state);
        } else { /* ... log failure ... */ }

    } catch (error) { console.error(`[Monitor] Error in monitoring loop:`, error); }
      finally { console.log(`[Monitor] END - ${new Date().toISOString()}`); }
}

// --- Initialization & Startup ---
// Declare state variables in outer scope
let provider, signer;
let contracts = {}; // Object to hold contract instances
let config = { // Load config here or pass later
    FLASH_SWAP_CONTRACT_ADDRESS, WETH_ADDRESS, USDC_ADDRESS, QUOTER_V2_ADDRESS,
    POOL_A_ADDRESS, POOL_B_ADDRESS, POOL_A_FEE_BPS, POOL_B_FEE_BPS,
    WETH_DECIMALS, USDC_DECIMALS, BORROW_AMOUNT_WETH_WEI, POLLING_INTERVAL_MS
};

(async () => {
    console.log("\n>>> Entering startup async IIFE...");
    try {
        // --- Setup Provider & Signer ---
        if (!RPC_URL || !PRIVATE_KEY) { throw new Error("RPC_URL or PRIVATE_KEY missing in .env"); }
        console.log("[Init] Setting up Provider...");
        provider = new ethers.JsonRpcProvider(RPC_URL);
        console.log("[Init] Setting up Signer...");
        signer = new ethers.Wallet(PRIVATE_KEY, provider);
        console.log(`[Init] Signer Address: ${signer.address}`);

        // --- Fetch FlashSwap ABI Dynamically ---
        const flashSwapABI_dynamic = await fetchABIFromArbiscan(FLASH_SWAP_CONTRACT_ADDRESS);

        // --- Instantiate Contracts ---
        console.log("[Init] Instantiating Contracts...");
        // Assign to the contracts object declared outside
        contracts.flashSwapContract = new ethers.Contract(FLASH_SWAP_CONTRACT_ADDRESS, flashSwapABI_dynamic, signer);
        contracts.quoterContract = new ethers.Contract(QUOTER_V2_ADDRESS, IQuoterV2ABI, provider);
        contracts.poolAContract = new ethers.Contract(POOL_A_ADDRESS, IUniswapV3PoolABI, provider);
        contracts.poolBContract = new ethers.Contract(POOL_B_ADDRESS, IUniswapV3PoolABI, provider);
        console.log("[Init] All Contract instances created successfully.");

        // --- Create the state object ---
        const state = { provider, signer, contracts, config };

        // --- Initial Logs ---
        console.log(`Bot starting...`);
        // ... other startup logs ...

        // --- Startup Checks ---
        console.log(">>> Checking signer balance (as connectivity test)...");
        const balance = await provider.getBalance(signer.address);
        console.log(`>>> Signer balance: ${ethers.formatEther(balance)} ETH`);

        console.log(">>> Attempting to fetch contract owner...");
        if (!contracts.flashSwapContract.owner) { throw new Error("Fetched FlashSwap ABI does not contain 'owner' function."); }
        const contractOwner = await contracts.flashSwapContract.owner();
        console.log(`>>> Successfully fetched owner: ${contractOwner}`);
        if (contractOwner.toLowerCase() === signer.address.toLowerCase()) { /* ... log success ... */ } else { /* warning */ }

        // --- Start Monitoring ---
        console.log(">>> Attempting first monitorPools() run...");
        await monitorPools(state); // Pass state
        console.log(">>> First monitorPools() run complete.");

        console.log(">>> Setting up setInterval...");
        // Use an arrow function to pass state to subsequent calls
        setInterval(() => monitorPools(state), POLLING_INTERVAL_MS);
        console.log(`\nMonitoring started. Will check every ${POLLING_INTERVAL_MS / 1000} seconds.`);

    } catch (initError) { /* ... error handling ... */ process.exit(1); }
})();
