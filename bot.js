// bot.js - Arbitrum Uniswap V3 Flash Swap Bot with Debugging (v22.4 - Cleanup & Logic Fix)

const { ethers } = require("ethers");
const axios = require("axios");
require('dotenv').config();

// --- Configuration ---
const RPC_URL = process.env.ARBITRUM_RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const ARBISCAN_API_KEY = process.env.ARBISCAN_API_KEY;

const FLASH_SWAP_CONTRACT_ADDRESS = ethers.getAddress("0x7a00Ec5b64e662425Bbaa0dD78972570C326210f");
const WETH_ADDRESS = ethers.getAddress("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1");
const USDC_ADDRESS = ethers.getAddress("0xaf88d065e77c8cC2239327C5EDb3A432268e5831"); // Native USDC
const QUOTER_V2_ADDRESS = "0x61ffe014ba17989e743c5f6d790181c0603c3996"; // Lowercase
const POOL_A_ADDRESS = "0xc6962004f452be9203591991d15f6b388e09e8d0"; // Lowercase CORRECT Address (0.05%)
const POOL_B_ADDRESS = "0x17c14d2c404d167802b16c450d3c99f88f2c4f4d"; // Lowercase CORRECT Address (0.30%)
const POOL_A_FEE_BPS = 500; const POOL_A_FEE_PERCENT = 0.05;
const POOL_B_FEE_BPS = 3000; const POOL_B_FEE_PERCENT = 0.30;
const WETH_DECIMALS = 18; const USDC_DECIMALS = 6;

// --- ABIs ---
// FlashSwapABI will be fetched dynamically
const IUniswapV3PoolABI = [
    "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
    "function liquidity() external view returns (uint128)"
];
const IQuoterV2ABI = [ // Full ABI for estimateGas approach
    { "type": "constructor", "inputs": [ /* ... */ ], "stateMutability": "nonpayable" }, { "name": "WETH9", "type": "function", /* ... */ }, { "name": "factory", "type": "function", /* ... */ }, { "name": "quoteExactInput", "type": "function", /* ... */ }, { "name": "quoteExactInputSingle", "type": "function", "inputs": [ { "name": "params", "type": "tuple", "components": [ { "name": "tokenIn", "type": "address", /*...*/ }, { "name": "tokenOut", "type": "address", /*...*/ }, { "name": "amountIn", "type": "uint256", /*...*/ }, { "name": "fee", "type": "uint24", /*...*/ }, { "name": "sqrtPriceLimitX96", "type": "uint160", /*...*/ } ], "internalType": "struct IQuoterV2.QuoteExactInputSingleParams" } ], "outputs": [ { "name": "amountOut", "type": "uint256", /*...*/ }, { "name": "sqrtPriceX96After", "type": "uint160", /*...*/ }, { "name": "initializedTicksCrossed", "type": "uint32", /*...*/ }, { "name": "gasEstimate", "type": "uint256", /*...*/ } ], "stateMutability": "nonpayable" }, { "name": "quoteExactOutput", "type": "function", /* ... */ }, { "name": "quoteExactOutputSingle", "type": "function", /* ... */ }, { "name": "uniswapV3SwapCallback", "type": "function", /* ... */ }
];

// --- Bot Settings ---
const POLLING_INTERVAL_MS = 10000;
const PROFIT_THRESHOLD_USD = 0.05;
let BORROW_AMOUNT_WETH_WEI = ethers.parseUnits("0.1", WETH_DECIMALS); // Increased to 0.1 WETH
// --- ABI Fetching Function ---
async function fetchABIFromArbiscan(contractAddress) {
    console.log(`[ABI Fetch] Attempting to fetch ABI for ${contractAddress}...`);
    if (!ARBISCAN_API_KEY) { throw new Error("ARBISCAN_API_KEY not found in .env file."); }
    const url = `https://api.arbiscan.io/api?module=contract&action=getabi&address=${contractAddress}&apikey=${ARBISCAN_API_KEY}`;
    try {
        const response = await axios.get(url);
        if (response.data.status !== "1") { throw new Error(`Arbiscan API Error: ${response.data.message} - ${response.data.result}`); }
        console.log(`[ABI Fetch] Successfully fetched ABI for ${contractAddress}.`);
        return JSON.parse(response.data.result);
    } catch (err) {
        // ... (keep error logging) ...
        throw new Error(`Failed to fetch ABI for ${contractAddress}. Cause: ${err.message}`);
    }
}

// --- Initialization State Variables ---
// Declare state variables in outer scope
let provider, signer;
let contracts = {};
let config = { // Use constants defined above
    FLASH_SWAP_CONTRACT_ADDRESS, WETH_ADDRESS, USDC_ADDRESS, QUOTER_V2_ADDRESS,
    POOL_A_ADDRESS, POOL_B_ADDRESS, POOL_A_FEE_BPS, POOL_B_FEE_BPS, POOL_A_FEE_PERCENT, POOL_B_FEE_PERCENT,
    WETH_DECIMALS, USDC_DECIMALS, BORROW_AMOUNT_WETH_WEI, POLLING_INTERVAL_MS,
    RPC_URL, PRIVATE_KEY, ARBISCAN_API_KEY, PROFIT_THRESHOLD_USD // Include others needed
};

// --- Helper Functions ---
// Simulates Quoter call via estimateGas
async function simulateSwap(poolDesc, tokenIn, tokenOut, amountInWei, feeBps, quoterContract) {
    if (!quoterContract) { /* ... error check ... */ return false; }
    const params = { tokenIn, tokenOut, amountIn: amountInWei, fee: feeBps, sqrtPriceLimitX96: 0n };
    console.log(`  [Quoter Sim using estimateGas - ${poolDesc}] Params:`, { /* ... logging ... */ });
    try {
        await quoterContract.quoteExactInputSingle.estimateGas(params);
        console.log(`  [Quoter Sim using estimateGas - ${poolDesc}] SUCCESS (Simulation likely ok)`);
        return true;
    } catch (error) { /* ... error handling ... */ return false; }
}

// --- Restore FULL attemptArbitrage Function - NORMAL Logic (uses state) ---
async function attemptArbitrage(state) { // Accept state object
    const { flashSwapContract, poolAContract, poolBContract } = state.contracts;
    const { config } = state;
    const opportunity = state.opportunity; // Get opportunity from state

    if (!opportunity) { console.error("  [Attempt] Opportunity data missing in state."); return; }

    const startPool = opportunity.startPool;
    console.log(`\n========= Arbitrage Opportunity Detected (Using Detected Start Pool: ${startPool}) =========`);

    if (!flashSwapContract || !poolAContract || !poolBContract) { console.error("  [Attempt] Contract instances missing in state."); return; }
    if (!opportunity.borrowTokenSymbol || !opportunity.startPool) { console.error("  [Attempt] Missing borrowTokenSymbol or startPool."); return; }

    console.log(`  Pool A Addr: ${config.POOL_A_ADDRESS}, Fee: ${config.POOL_A_FEE_BPS}bps`);
    console.log(`  Pool B Addr: ${config.POOL_B_ADDRESS}, Fee: ${config.POOL_B_FEE_BPS}bps`);
    console.log(`  Using Start Pool: ${startPool}`);
    const borrowTokenSymbol = opportunity.borrowTokenSymbol;
    console.log(`  Borrow Token: ${borrowTokenSymbol}`);

    // Determine parameters
    let flashLoanPoolAddress; let borrowAmount0 = 0n; let borrowAmount1 = 0n;
    let tokenBorrowedAddress; let tokenIntermediateAddress;
    let poolAForSwap; let poolBForSwap;
    let feeAForSwap; let feeBForSwap;
    let amountToBorrowWei;

    if (borrowTokenSymbol === 'WETH') {
        tokenBorrowedAddress = config.WETH_ADDRESS; tokenIntermediateAddress = config.USDC_ADDRESS;
        amountToBorrowWei = config.BORROW_AMOUNT_WETH_WEI; // Uses the UPDATED global value
        borrowAmount0 = amountToBorrowWei; borrowAmount1 = 0n;
        if (startPool === 'A') {
            console.log("  Configuring path: Borrow from A, Swap A -> B");
            flashLoanPoolAddress = config.POOL_A_ADDRESS; poolAForSwap = config.POOL_A_ADDRESS;
            feeAForSwap = config.POOL_A_FEE_BPS; poolBForSwap = config.POOL_B_ADDRESS;
            feeBForSwap = config.POOL_B_FEE_BPS;
        } else { // Start Pool B
            console.log("  Configuring path: Borrow from B, Swap B -> A");
            flashLoanPoolAddress = config.POOL_B_ADDRESS; poolAForSwap = config.POOL_B_ADDRESS;
            feeAForSwap = config.POOL_B_FEE_BPS; poolBForSwap = config.POOL_A_ADDRESS;
            feeBForSwap = config.POOL_A_FEE_BPS;
        }
    } else { console.error("  [Attempt] USDC Borrow NYI"); return; }

     if (!flashLoanPoolAddress || !tokenBorrowedAddress || !tokenIntermediateAddress || !poolAForSwap || !poolBForSwap || feeAForSwap === undefined || feeBForSwap === undefined || amountToBorrowWei === undefined) {
         console.error("  [Attempt] Failed to determine all necessary parameters."); return;
     }

    console.log(`  Executing Path: Borrow ${ethers.formatUnits(amountToBorrowWei, config.WETH_DECIMALS)} ${borrowTokenSymbol} from ${flashLoanPoolAddress}`);
    console.log(`    -> Swap 1 on ${poolAForSwap} (Fee: ${feeAForSwap}bps)`);
    console.log(`    -> Swap 2 on ${poolBForSwap} (Fee: ${feeBForSwap}bps)`);

    // --- Check Flash Loan Pool State ---
    try { /* ... Keep pool state check ... */ } catch (err) { /* ... */ return; }

    // --- Construct Callback Params ---
    const arbitrageParams = { tokenIntermediate: tokenIntermediateAddress, poolA: poolAForSwap, poolB: poolBForSwap, feeA: feeAForSwap, feeB: feeBForSwap, amountOutMinimum1: 0n, amountOutMinimum2: 0n };
    let encodedParams;
     try { /* ... Keep encoding logic ... */ } catch (encodeError) { /* ... */ return; }
    console.log("  Callback Parameters (Encoded):", encodedParams.substring(0,100)+"...");

    // --- initiateFlashSwap Args ---
    const initiateFlashSwapArgs = [ flashLoanPoolAddress, borrowAmount0, borrowAmount1, encodedParams ];

    // --- Simulation & Estimation ---
    console.log("  >>> Entering Simulation & Estimation block <<<");
    try {
        if (!flashSwapContract.initiateFlashSwap) { throw new Error("FlashSwap ABI missing 'initiateFlashSwap'"); }
        console.log("  >>> Before staticCall <<<");
        console.log("  [1/3] Attempting staticCall simulation...");
        await flashSwapContract.initiateFlashSwap.staticCall( ...initiateFlashSwapArgs, { gasLimit: 3_000_000 });
        console.log("  >>> After staticCall (Success) <<<");
        console.log("  ✅ [1/3] staticCall successful.");

        // --- If staticCall succeeded, THEN try estimating gas ---
        console.log("  >>> Before estimateGas <<<");
        console.log("  [2/3] Attempting estimateGas...");
        try { // Inner try for estimateGas
            const estimatedGas = await flashSwapContract.initiateFlashSwap.estimateGas(...initiateFlashSwapArgs);
            console.log("  >>> After estimateGas (Success) <<<");
            console.log(`  ✅ [2/3] estimateGas successful. Estimated Gas: ${Number(estimatedGas)}`);
            console.log("  [3/3] Conditions met for sending transaction (Execution Disabled).");
        } catch (gasError) { // Catch estimateGas specific error
            console.log("  >>> Inside estimateGas CATCH block <<<");
            console.error(`  ❌ [2/3] estimateGas failed:`, gasError.reason || gasError.message || gasError);
            if (gasError.stack) { console.error("     Stack Trace:", gasError.stack); }
        }
    } catch (staticCallError) { // Catch staticCall specific error
        console.log("  >>> Inside staticCall CATCH block <<<");
        console.error(`  ❌ [1/3] staticCall failed:`, staticCallError.reason || staticCallError.message || staticCallError);
         if (staticCallError.data && staticCallError.data !== '0x') console.error(`     Revert Data: ${staticCallError.data}`);
         if (staticCallError.stack) { console.error("     Stack Trace:", staticCallError.stack); }
    }
    console.log("  >>> Exiting Simulation & Estimation block <<<");
    console.log("========= Arbitrage Attempt Complete =========");
 } // <<< Closing brace for attemptArbitrage function

// --- Main Monitoring Loop --- CORRECTED using Promise.allSettled ---
async function monitorPools(state) { // Accept state
    console.log(`\n[Monitor] START - ${new Date().toISOString()}`);

    const { poolAContract, poolBContract, quoterContract } = state.contracts;
    const { config } = state;

    if (!poolAContract || !poolBContract || !quoterContract) {
        console.error("[Monitor] Contract instances not available in state. Skipping cycle.");
        console.log(`[Monitor] END (Early exit due to uninitialized contracts) - ${new Date().toISOString()}`);
        return;
     }

    try {
        console.log("  [Monitor] Fetching pool states...");
        console.log(`  [Monitor] Calling Promise.allSettled for pool states... (A: ${config.POOL_A_ADDRESS}, B: ${config.POOL_B_ADDRESS})`);

        // Use Promise.allSettled to handle potential errors gracefully
        const results = await Promise.allSettled([
            poolAContract.slot0(),
            poolAContract.liquidity(),
            poolBContract.slot0(),
            poolBContract.liquidity()
        ]);
        console.log("  [Monitor] Promise.allSettled for pool states finished.");

        // Process results - Check status of each promise
        const slotAResult = results[0];
        const liqAResult = results[1];
        const slotBResult = results[2];
        const liqBResult = results[3];

        let slotA = null, liqA = null, slotB = null, liqB = null;
        let poolAStateFetched = false, poolBStateFetched = false;

        if (slotAResult.status === 'fulfilled') {
            slotA = slotAResult.value;
        } else {
            console.error(`[Monitor] Error fetching slot0 for Pool A: ${slotAResult.reason?.message || slotAResult.reason}`);
        }
        if (liqAResult.status === 'fulfilled') {
            liqA = liqAResult.value;
        } else {
            console.error(`[Monitor] Error fetching liquidity for Pool A: ${liqAResult.reason?.message || liqAResult.reason}`);
        }
        if (slotBResult.status === 'fulfilled') {
            slotB = slotBResult.value;
        } else {
            console.error(`[Monitor] Error fetching slot0 for Pool B: ${slotBResult.reason?.message || slotBResult.reason}`);
        }
        if (liqBResult.status === 'fulfilled') {
            liqB = liqBResult.value;
        } else {
            console.error(`[Monitor] Error fetching liquidity for Pool B: ${liqBResult.reason?.message || liqBResult.reason}`);
        }

        // Log fetched states
        if (slotA && liqA !== null) {
             console.log(`  [Monitor] Pool A State: Tick=${slotA.tick}, Liquidity=${liqA.toString()}`);
             if (liqA === 0n) console.warn("    [Monitor] WARNING: Pool A has ZERO active liquidity!");
             poolAStateFetched = true;
        } else { console.log(`  [Monitor] Pool A State: Failed to fetch completely.`); }
        if (slotB && liqB !== null) {
             console.log(`  [Monitor] Pool B State: Tick=${slotB.tick}, Liquidity=${liqB.toString()}`);
              if (liqB === 0n) console.warn("    [Monitor] WARNING: Pool B has ZERO active liquidity!");
              poolBStateFetched = true;
        } else { console.log(`  [Monitor] Pool B State: Failed to fetch completely.`); }

        // --- EXIT IF STATES NOT FETCHED ---
        if (!poolAStateFetched || !poolBStateFetched) {
            console.log("  [Monitor] Could not fetch complete state for both pools. Skipping simulation cycle.");
            console.log("[Monitor] END (Early exit due to fetch failure)");
            return; // Exit the function
        }

        // --- CONTINUE IF STATES FETCHED ---
        // Simulate using estimateGas
        const simulateAmountWeth = ethers.parseUnits("0.001", config.WETH_DECIMALS);
        console.log(`  [Monitor] Simulating Quoter calls via estimateGas using ${ethers.formatUnits(simulateAmountWeth, config.WETH_DECIMALS)} WETH...`);
        const [simASuccess, simBSuccess] = await Promise.all([
             simulateSwap("Pool A", config.WETH_ADDRESS, config.USDC_ADDRESS, simulateAmountWeth, config.POOL_A_FEE_BPS, quoterContract),
             simulateSwap("Pool B", config.WETH_ADDRESS, config.USDC_ADDRESS, simulateAmountWeth, config.POOL_B_FEE_BPS, quoterContract)
        ]);
        console.log(`  [Monitor] Quoter simulations results. Sim A Success: ${simASuccess}, Sim B Success: ${simBSuccess}`);

        if (simASuccess && simBSuccess) {
             console.log("  [Monitor] Both Quoter simulations succeeded via estimateGas.");

             // --- Opportunity Detection Logic using Ticks ---
             const tickA = Number(slotA.tick);
             const tickB = Number(slotB.tick);
             let opportunity = null;
             const TICK_DIFF_THRESHOLD = 1;

             console.log(`  [Monitor] Pool A Tick: ${tickA}, Pool B Tick: ${tickB}`);

             if (tickA > tickB + TICK_DIFF_THRESHOLD) {
                 console.log(`  [Monitor] Potential Opportunity: Pool A tick higher.`);
                 opportunity = { startPool: "A", /* ... other fields ... */ };
             } else if (tickB > tickA + TICK_DIFF_THRESHOLD) {
                  console.log(`  [Monitor] Potential Opportunity: Pool B tick higher.`);
                  opportunity = { startPool: "B", /* ... other fields ... */ };
             }

             if (opportunity) {
                 // Add estimated profit logic later if needed
                 opportunity.borrowTokenSymbol = "WETH"; // Assuming WETH for now
                 opportunity.estimatedProfitUsd = 999; // Force trigger for debug

                 if (opportunity.estimatedProfitUsd > config.PROFIT_THRESHOLD_USD) {
                      console.log(`  [Monitor] Triggering attemptArbitrage with startPool: ${opportunity.startPool}`);
                      state.opportunity = opportunity;
                      await attemptArbitrage(state);
                 } else {
                      console.log(`  [Monitor] Price difference detected (by tick), but profit below threshold.`);
                 }
             } else {
                 console.log("  [Monitor] No significant price difference detected (by tick).");
             }
        } else {
             console.log("  [Monitor] One or both Quoter simulations failed. Skipping arbitrage attempt.");
             console.log("[Monitor] END (Early exit due to quote simulation failure)");
             // No return, let finally run
        }

    } catch (error) {
        console.error(`[Monitor] Error in monitoring loop:`, error);
    } finally {
        console.log(`[Monitor] END - ${new Date().toISOString()}`);
    }
} // <<< Closing brace for monitorPools function

// --- Start the Bot --- Only ONE of these IIFE blocks should exist ---
(async () => {
    console.log("\n>>> Entering startup async IIFE...");
    try {
        // --- Setup Provider & Signer ---
        if (!config.RPC_URL || !config.PRIVATE_KEY) { throw new Error("RPC_URL or PRIVATE_KEY missing"); }
        console.log("[Init] Setting up Provider...");
        provider = new ethers.JsonRpcProvider(config.RPC_URL);
        console.log("[Init] Setting up Signer...");
        signer = new ethers.Wallet(config.PRIVATE_KEY, provider);
        console.log(`[Init] Signer Address: ${signer.address}`);

        // --- Fetch FlashSwap ABI Dynamically ---
        const flashSwapABI_dynamic = await fetchABIFromArbiscan(config.FLASH_SWAP_CONTRACT_ADDRESS);

        // --- Instantiate Contracts ---
        console.log("[Init] Instantiating Contracts...");
        contracts.flashSwapContract = new ethers.Contract(config.FLASH_SWAP_CONTRACT_ADDRESS, flashSwapABI_dynamic, signer);
        contracts.quoterContract = new ethers.Contract(config.QUOTER_V2_ADDRESS, IQuoterV2ABI, provider);
        contracts.poolAContract = new ethers.Contract(config.POOL_A_ADDRESS, IUniswapV3PoolABI, provider);
        contracts.poolBContract = new ethers.Contract(config.POOL_B_ADDRESS, IUniswapV3PoolABI, provider);
        console.log("[Init] All Contract instances created successfully.");

        // --- Create the state object ---
        const state = { provider, signer, contracts, config };

        // --- Initial Logs --- Check constants exist in config object
        console.log(`Bot starting...`);
        console.log(` - FlashSwap Contract: ${state.config.FLASH_SWAP_CONTRACT_ADDRESS}`);
        console.log(` - Quoter V2 Contract: ${state.config.QUOTER_V2_ADDRESS}`);
        console.log(` - Monitoring Pools:`);
        console.log(`   - Pool A (WETH/USDC ${state.config.POOL_A_FEE_PERCENT}%): ${state.config.POOL_A_ADDRESS}`);
        console.log(`   - Pool B (WETH/USDC ${state.config.POOL_B_FEE_PERCENT}%): ${state.config.POOL_B_ADDRESS}`);
        console.log(` - Debug Borrow Amount: ${ethers.formatUnits(state.config.BORROW_AMOUNT_WETH_WEI, state.config.WETH_DECIMALS)} WETH`);
        console.log(` - Polling Interval: ${state.config.POLLING_INTERVAL_MS / 1000} seconds`);
        console.log(` - Profit Threshold: $${state.config.PROFIT_THRESHOLD_USD} USD (approx, before gas)`);


        // --- Startup Checks ---
        console.log(">>> Checking signer balance (as connectivity test)...");
        const balance = await provider.getBalance(signer.address);
        console.log(`>>> Signer balance: ${ethers.formatEther(balance)} ETH`);
        console.log(">>> Attempting to fetch contract owner...");
        if (!contracts.flashSwapContract.owner) { throw new Error("Fetched FlashSwap ABI does not contain 'owner' function."); }
        const contractOwner = await contracts.flashSwapContract.owner();
        console.log(`>>> Successfully fetched owner: ${contractOwner}`);
        if (contractOwner.toLowerCase() === signer.address.toLowerCase()) { console.log(`Signer matches contract owner...\n`); }
        else { console.warn("Warning: Signer does not match owner!") }

        // --- Start Monitoring ---
        console.log(">>> Attempting first monitorPools() run...");
        await monitorPools(state); // Pass state
        console.log(">>> First monitorPools() run complete.");
        console.log(">>> Setting up setInterval...");
        setInterval(() => monitorPools(state), state.config.POLLING_INTERVAL_MS); // Pass state & use config interval
        console.log(`\nMonitoring started...`);

    } catch (initError) {
        console.error("\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        console.error("Initialization Error / Startup Error:");
        console.error(initError.stack || initError);
        console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        process.exit(1);
    }
})();
