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
let BORROW_AMOUNT_WETH_WEI = ethers.parseUnits("0.00005", WETH_DECIMALS);

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

// --- SIMPLIFIED attemptArbitrage function for logging ---
async function attemptArbitrage(state) {
    console.log("\n========= Arbitrage Opportunity Detected (Simplified Test) =========");
    console.log(">>> Entering attemptArbitrage (Simplified)...");

     const { flashSwapContract, poolAContract, poolBContract } = state.contracts;
     const { config } = state;
     const opportunity = state.opportunity; // Get opportunity from state

     if (!flashSwapContract || !poolAContract || !poolBContract || !opportunity) { console.error("... Instances or opportunity missing ..."); return; }

     const startPool = opportunity.startPool; // Use start pool from opportunity
     console.log(`  [Attempt] Using Start Pool: ${startPool}`);

    // Minimal setup just for the call
    let flashLoanPoolAddress; let borrowAmount0 = 0n; let borrowAmount1 = 0n;
    let encodedParams = "0x";
    let tokenBorrowedAddress, tokenIntermediateAddress, poolAForSwap, poolBForSwap, feeAForSwap, feeBForSwap, amountToBorrowWei;

    try {
        console.log(">>> Setting up simplified params based on startPool:", startPool);
        amountToBorrowWei = config.BORROW_AMOUNT_WETH_WEI;
        tokenBorrowedAddress = config.WETH_ADDRESS;
        tokenIntermediateAddress = config.USDC_ADDRESS;
        borrowAmount0 = amountToBorrowWei; // Assuming WETH is always token0 based on our pair
        borrowAmount1 = 0n;

        // Configure path based on the determined startPool
         if (startPool === 'A') {
            flashLoanPoolAddress = config.POOL_A_ADDRESS; poolAForSwap = config.POOL_A_ADDRESS;
            feeAForSwap = config.POOL_A_FEE_BPS; poolBForSwap = config.POOL_B_ADDRESS;
            feeBForSwap = config.POOL_B_FEE_BPS;
        } else { // Start Pool B
            flashLoanPoolAddress = config.POOL_B_ADDRESS; poolAForSwap = config.POOL_B_ADDRESS;
            feeAForSwap = config.POOL_B_FEE_BPS; poolBForSwap = config.POOL_A_ADDRESS;
            feeBForSwap = config.POOL_A_FEE_BPS;
        }

        const arbitrageParams = { tokenIntermediate: tokenIntermediateAddress, poolA: poolAForSwap, poolB: poolBForSwap, feeA: feeAForSwap, feeB: feeBForSwap, amountOutMinimum1: 0n, amountOutMinimum2: 0n };
        encodedParams = ethers.AbiCoder.defaultAbiCoder().encode(
            ['tuple(address tokenIntermediate, address poolA, address poolB, uint24 feeA, uint24 feeB, uint amountOutMinimum1, uint amountOutMinimum2)'],
            [arbitrageParams]
        );
        console.log(">>> Simplified Params Set. Flash Pool:", flashLoanPoolAddress, "Encoded:", encodedParams.substring(0, 100) + "...");

        const initiateFlashSwapArgs = [ flashLoanPoolAddress, borrowAmount0, borrowAmount1, encodedParams ];

        console.log(">>> Entering TRY block for staticCall...");
        if (!flashSwapContract.initiateFlashSwap) { throw new Error("Fetched FlashSwap ABI does not contain 'initiateFlashSwap' function."); }

        await flashSwapContract.initiateFlashSwap.staticCall( ...initiateFlashSwapArgs, { gasLimit: 3_000_000 });
        console.log(">>> STATIC CALL SUCCEEDED (Simplified Test) <<<");

    } catch (error) {
        console.error(">>> STATIC CALL FAILED (Simplified Test) <<<");
        console.error("Error Reason:", error.reason || error.message || error);
        if (error.data && error.data !== '0x') console.error("Revert Data:", error.data);
        if (error.stack) { console.error("Stack Trace:", error.stack); }
        else { console.error("Full Error Obj:", JSON.stringify(error, Object.getOwnPropertyNames(error))); }
    }
    console.log("========= Arbitrage Attempt Complete (Simplified) =========");
}


// --- Main Monitoring Loop ---
async function monitorPools(state) {
    console.log(`\n[Monitor] START - ${new Date().toISOString()}`);
    const { poolAContract, poolBContract, quoterContract } = state.contracts;
    const { config } = state;
     if (!poolAContract || !poolBContract || !quoterContract) { /* ... check ... */ return; }
    try {
        console.log("  [Monitor] Fetching pool states...");
        const poolStatePromises = [ /* ... */ ]; // Fetch states
        const [slotA, liqA, slotB, liqB] = await Promise.all(poolStatePromises);
        console.log("  [Monitor] Promise.all for pool states resolved.");

        let poolAStateFetched = slotA && liqA !== null; let poolBStateFetched = slotB && liqB !== null;
        if (slotA && liqA !== null) { /* log state A */ } else { /* log fail A */ }
        if (slotB && liqB !== null) { /* log state B */ } else { /* log fail B */ }
        if (!poolAStateFetched || !poolBStateFetched) { /* ... handle failure ... */ return; }

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
             const TICK_DIFF_THRESHOLD = 1; // Require > 1 tick difference

             console.log(`  [Monitor] Pool A Tick: ${tickA}, Pool B Tick: ${tickB}`);

             if (tickA > tickB + TICK_DIFF_THRESHOLD) {
                 console.log(`  [Monitor] Potential Opportunity: Pool A tick higher.`);
                 opportunity = { startPool: "A", borrowTokenSymbol: "WETH", estimatedProfitUsd: 999 }; // Simplified
             } else if (tickB > tickA + TICK_DIFF_THRESHOLD) {
                  console.log(`  [Monitor] Potential Opportunity: Pool B tick higher.`);
                  opportunity = { startPool: "B", borrowTokenSymbol: "WETH", estimatedProfitUsd: 999 }; // Simplified
             }

             if (opportunity) {
                 // Check threshold (always passes with forced profit)
                 if (opportunity.estimatedProfitUsd > config.PROFIT_THRESHOLD_USD) {
                      console.log(`  [Monitor] Triggering attemptArbitrage with startPool: ${opportunity.startPool}`);
                      state.opportunity = opportunity; // Add opportunity data to state
                      await attemptArbitrage(state); // Pass updated state
                 } else {
                      // Should not be hit with current logic
                      console.log(`  [Monitor] Price difference detected (by tick), but profit below threshold.`);
                 }
             } else {
                 console.log("  [Monitor] No significant price difference detected (by tick).");
             }
        } else {
             console.log("  [Monitor] One or both Quoter simulations failed. Skipping arbitrage attempt.");
             console.log("[Monitor] END (Early exit due to quote simulation failure)");
        }

    } catch (error) {
        console.error(`[Monitor] Error in monitoring loop:`, error);
    } finally {
        console.log(`[Monitor] END - ${new Date().toISOString()}`);
    }
}

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
