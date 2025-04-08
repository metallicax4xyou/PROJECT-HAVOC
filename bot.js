// bot.js - Arbitrum Uniswap V3 Flash Swap Bot with Debugging (v22 - Dynamic ABI Fetching)

const { ethers } = require("ethers");
const axios = require("axios"); // Import axios
require('dotenv').config();

// --- Configuration ---
const RPC_URL = process.env.ARBITRUM_RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const ARBISCAN_API_KEY = process.env.ARBISCAN_API_KEY; // Get API Key from .env

// Use getAddress for verified/standard addresses
const FLASH_SWAP_CONTRACT_ADDRESS = ethers.getAddress("0x7a00Ec5b64e662425Bbaa0dD78972570C326210f");
const WETH_ADDRESS = ethers.getAddress("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1");
const USDC_ADDRESS = ethers.getAddress("0xaf88d065e77c8cC2239327C5EDb3A432268e5831"); // Native USDC

// Use lowercase for potentially problematic addresses
const QUOTER_V2_ADDRESS = "0x61ffe014ba17989e743c5f6d790181c0603c3996"; // Lowercase
const POOL_A_ADDRESS = "0xc6962004f452be9203591991d15f6b388e09e8d0"; // Lowercase CORRECT Address (0.05%)
const POOL_B_ADDRESS = "0x17c14d2c404d167802b16c450d3c99f88f2c4f4d"; // Lowercase CORRECT Address (0.30%)

const POOL_A_FEE_BPS = 500; const POOL_A_FEE_PERCENT = 0.05;
const POOL_B_FEE_BPS = 3000; const POOL_B_FEE_PERCENT = 0.30;
const WETH_DECIMALS = 18; const USDC_DECIMALS = 6;

// --- ABIs ---
// --- FlashSwapABI will be fetched dynamically ---
// Keep minimal standard ABIs
const IUniswapV3PoolABI = [
    "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
    "function liquidity() external view returns (uint128)"
];
const IQuoterV2ABI = [ // Using the full ABI for estimateGas approach
    { "type": "constructor", "inputs": [ { "name": "_factory", "type": "address", "internalType": "address" }, { "name": "_WETH9", "type": "address", "internalType": "address" } ], "stateMutability": "nonpayable" }, { "name": "WETH9", "type": "function", "inputs": [], "outputs": [ { "name": "", "type": "address", "internalType": "address" } ], "stateMutability": "view" }, { "name": "factory", "type": "function", "inputs": [], "outputs": [ { "name": "", "type": "address", "internalType": "address" } ], "stateMutability": "view" }, { "name": "quoteExactInput", "type": "function", "inputs": [ { "name": "path", "type": "bytes", "internalType": "bytes" }, { "name": "amountIn", "type": "uint256", "internalType": "uint256" } ], "outputs": [ { "name": "amountOut", "type": "uint256", "internalType": "uint256" }, { "name": "sqrtPriceX96AfterList", "type": "uint160[]", "internalType": "uint160[]" }, { "name": "initializedTicksCrossedList", "type": "uint32[]", "internalType": "uint32[]" }, { "name": "gasEstimate", "type": "uint256", "internalType": "uint256" } ], "stateMutability": "nonpayable" }, { "name": "quoteExactInputSingle", "type": "function", "inputs": [ { "name": "params", "type": "tuple", "components": [ { "name": "tokenIn", "type": "address", "internalType": "address" }, { "name": "tokenOut", "type": "address", "internalType": "address" }, { "name": "amountIn", "type": "uint256", "internalType": "uint256" }, { "name": "fee", "type": "uint24", "internalType": "uint24" }, { "name": "sqrtPriceLimitX96", "type": "uint160", "internalType": "uint160" } ], "internalType": "struct IQuoterV2.QuoteExactInputSingleParams" } ], "outputs": [ { "name": "amountOut", "type": "uint256", "internalType": "uint256" }, { "name": "sqrtPriceX96After", "type": "uint160", "internalType": "uint160" }, { "name": "initializedTicksCrossed", "type": "uint32", "internalType": "uint32" }, { "name": "gasEstimate", "type": "uint256", "internalType": "uint256" } ], "stateMutability": "nonpayable" }, { "name": "quoteExactOutput", "type": "function", "inputs": [ { "name": "path", "type": "bytes", "internalType": "bytes" }, { "name": "amountOut", "type": "uint256", "internalType": "uint256" } ], "outputs": [ { "name": "amountIn", "type": "uint256", "internalType": "uint256" }, { "name": "sqrtPriceX96AfterList", "type": "uint160[]", "internalType": "uint160[]" }, { "name": "initializedTicksCrossedList", "type": "uint32[]", "internalType": "uint32[]" }, { "name": "gasEstimate", "type": "uint256", "internalType": "uint256" } ], "stateMutability": "nonpayable" }, { "name": "quoteExactOutputSingle", "type": "function", "inputs": [ { "name": "params", "type": "tuple", "components": [ { "name": "tokenIn", "type": "address", "internalType": "address" }, { "name": "tokenOut", "type": "address", "internalType": "address" }, { "name": "amount", "type": "uint256", "internalType": "uint256" }, { "name": "fee", "type": "uint24", "internalType": "uint24" }, { "name": "sqrtPriceLimitX96", "type": "uint160", "internalType": "uint160" } ], "internalType": "struct IQuoterV2.QuoteExactOutputSingleParams" } ], "outputs": [ { "name": "amountIn", "type": "uint256", "internalType": "uint256" }, { "name": "sqrtPriceX96After", "type": "uint160", "internalType": "uint160" }, { "name": "initializedTicksCrossed", "type": "uint32", "internalType": "uint32" }, { "name": "gasEstimate", "type": "uint256", "internalType": "uint256" } ], "stateMutability": "nonpayable" }, { "name": "uniswapV3SwapCallback", "type": "function", "inputs": [ { "name": "amount0Delta", "type": "int256", "internalType": "int256" }, { "name": "amount1Delta", "type": "int256", "internalType": "int256" }, { "name": "path", "type": "bytes", "internalType": "bytes" } ], "outputs": [], "stateMutability": "view" }
];

// --- Bot Settings ---
const POLLING_INTERVAL_MS = 10000;
const PROFIT_THRESHOLD_USD = 0.05;
let BORROW_AMOUNT_WETH_WEI = ethers.parseUnits("0.00005", WETH_DECIMALS);

// --- ABI Fetching Function ---
async function fetchABIFromArbiscan(contractAddress) {
    console.log(`[ABI Fetch] Attempting to fetch ABI for ${contractAddress}...`);
    if (!ARBISCAN_API_KEY) {
        throw new Error("ARBISCAN_API_KEY not found in .env file.");
    }
    const url = `https://api.arbiscan.io/api?module=contract&action=getabi&address=${contractAddress}&apikey=${ARBISCAN_API_KEY}`;
    try {
        const response = await axios.get(url);
        if (response.data.status !== "1") {
            throw new Error(`Arbiscan API Error: ${response.data.message} - ${response.data.result}`);
        }
        console.log(`[ABI Fetch] Successfully fetched ABI for ${contractAddress}.`);
        return JSON.parse(response.data.result); // Parse the JSON string containing the ABI
    } catch (err) {
        // Log specific axios errors if possible
        if (err.response) {
             console.error(`[ABI Fetch] Arbiscan request failed: Status ${err.response.status}`, err.response.data);
        } else if (err.request) {
             console.error("[ABI Fetch] Arbiscan request failed: No response received.", err.request);
        } else {
             console.error("[ABI Fetch] Error setting up Arbiscan request:", err.message);
        }
        // Re-throw a generic error to be caught by the main startup block
        throw new Error(`Failed to fetch ABI for ${contractAddress}. Cause: ${err.message}`);
    }
}

// --- Initialization ---
// Declare contract variables outside the async block so they are accessible later
let flashSwapContract, quoterContract, poolAContract, poolBContract;
let provider, signer; // Also declare provider/signer here

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
        flashSwapContract = new ethers.Contract(FLASH_SWAP_CONTRACT_ADDRESS, flashSwapABI_dynamic, signer);
        quoterContract = new ethers.Contract(QUOTER_V2_ADDRESS, IQuoterV2ABI, provider);
        poolAContract = new ethers.Contract(POOL_A_ADDRESS, IUniswapV3PoolABI, provider);
        poolBContract = new ethers.Contract(POOL_B_ADDRESS, IUniswapV3PoolABI, provider);
        console.log("[Init] All Contract instances created successfully.");

        // --- Initial Logs ---
        console.log(`Bot starting...`); // Moved after instantiation
        // ... other startup logs (FlashSwap Address, Quoter Address, Pools etc.) ...

        // --- Startup Checks ---
        console.log(">>> Checking signer balance (as connectivity test)...");
        const balance = await provider.getBalance(signer.address);
        console.log(`>>> Signer balance: ${ethers.formatEther(balance)} ETH`);

        console.log(">>> Attempting to fetch contract owner...");
        // Ensure owner function exists in fetched ABI before calling
        if (!flashSwapContract.owner) {
             throw new Error("Fetched FlashSwap ABI does not contain 'owner' function.");
        }
        const contractOwner = await flashSwapContract.owner();
        console.log(`>>> Successfully fetched owner: ${contractOwner}`);
        if (contractOwner.toLowerCase() === signer.address.toLowerCase()) {
             console.log(`Signer matches contract owner. 'onlyOwner' calls should succeed.\n`);
        } else { console.warn("Warning: Signer does not match owner!") }

        // --- Start Monitoring ---
        console.log(">>> Attempting first monitorPools() run...");
        await monitorPools(); // Pass necessary contracts if they aren't global
        console.log(">>> First monitorPools() run complete.");

        console.log(">>> Setting up setInterval...");
        setInterval(monitorPools, POLLING_INTERVAL_MS);
        console.log(`\nMonitoring started. Will check every ${POLLING_INTERVAL_MS / 1000} seconds.`);

    } catch (initError) {
        console.error("\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        console.error("Initialization Error / Startup Error:");
        console.error("Check RPC, .env vars (API Key?), fetched ABI, Contract Calls.");
        console.error(initError.stack || initError); // Log stack trace if available
        console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        process.exit(1);
    }
})(); // <<< End of startup IIFE


// --- Helper Functions ---
// Simulates Quoter call via estimateGas
async function simulateSwap(poolDesc, tokenIn, tokenOut, amountInWei, feeBps, quoter) {
    // Check if quoterContract was initialized
    if (!quoter) { console.error(`[SimulateSwap] Quoter contract instance not available!`); return false; }

    const params = { tokenIn, tokenOut, amountIn: amountInWei, fee: feeBps, sqrtPriceLimitX96: 0n };
    console.log(`  [Quoter Sim using estimateGas - ${poolDesc}] Params:`, { /* ... */ });
    try {
        await quoter.quoteExactInputSingle.estimateGas(params);
        console.log(`  [Quoter Sim using estimateGas - ${poolDesc}] SUCCESS (Simulation likely ok)`);
        return true;
    } catch (error) {
        console.warn(`  [Quoter Sim using estimateGas - ${poolDesc}] FAILED: ${error.reason || error.message || error}`);
        if (error.data && error.data !== '0x') console.warn(`     Raw Revert Data: ${error.data}`);
        return false;
    }
}


// --- SIMPLIFIED attemptArbitrage function for logging ---
async function attemptArbitrage(opportunity) {
    console.log("\n========= Arbitrage Opportunity Detected (Simplified Test) =========");
    console.log(">>> Entering attemptArbitrage (Simplified)...");

     // Check if necessary contracts are initialized
     if (!flashSwapContract || !poolAContract || !poolBContract || !provider) {
         console.error("  [Attempt] One or more contract/provider instances not initialized. Aborting.");
         return;
     }

    // Minimal setup just for the call
    let flashLoanPoolAddress; let borrowAmount0 = 0n; let borrowAmount1 = 0n;
    let encodedParams = "0x";
    let tokenBorrowedAddress, tokenIntermediateAddress, poolAForSwap, poolBForSwap, feeAForSwap, feeBForSwap, amountToBorrowWei;

    try {
        console.log(">>> Setting up simplified params...");
        flashLoanPoolAddress = POOL_A_ADDRESS; // Borrow from 0.05% pool
        amountToBorrowWei = BORROW_AMOUNT_WETH_WEI;
        borrowAmount0 = amountToBorrowWei; borrowAmount1 = 0n;
        tokenBorrowedAddress = WETH_ADDRESS; tokenIntermediateAddress = USDC_ADDRESS;
        poolAForSwap = POOL_A_ADDRESS; feeAForSwap = POOL_A_FEE_BPS;
        poolBForSwap = POOL_B_ADDRESS; feeBForSwap = POOL_B_FEE_BPS;

        const arbitrageParams = { tokenIntermediate: tokenIntermediateAddress, poolA: poolAForSwap, poolB: poolBForSwap, feeA: feeAForSwap, feeB: feeBForSwap, amountOutMinimum1: 0n, amountOutMinimum2: 0n };
        encodedParams = ethers.AbiCoder.defaultAbiCoder().encode(
            ['tuple(address tokenIntermediate, address poolA, address poolB, uint24 feeA, uint24 feeB, uint amountOutMinimum1, uint amountOutMinimum2)'],
            [arbitrageParams]
        );
        console.log(">>> Simplified Params Set. Encoded:", encodedParams.substring(0, 100) + "..."); // Log shortened

        const initiateFlashSwapArgs = [ flashLoanPoolAddress, borrowAmount0, borrowAmount1, encodedParams ];

        console.log(">>> Entering TRY block for staticCall...");
        // Ensure initiateFlashSwap function exists in the fetched ABI
        if (!flashSwapContract.initiateFlashSwap) {
             throw new Error("Fetched FlashSwap ABI does not contain 'initiateFlashSwap' function.");
        }
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
} // <<< Closing brace for attemptArbitrage function


// --- Main Monitoring Loop ---
async function monitorPools() {
    console.log(`\n[Monitor] START - ${new Date().toISOString()}`);
     // Check if contracts are initialized before proceeding
     if (!poolAContract || !poolBContract || !quoterContract) {
         console.error("[Monitor] Contract instances not available. Skipping cycle.");
         console.log(`[Monitor] END (Early exit due to uninitialized contracts) - ${new Date().toISOString()}`);
         return;
     }
    try {
        console.log("  [Monitor] Fetching pool states...");
        // ... (Keep pool state fetching logic) ...
        const [slotA, liqA, slotB, liqB] = await Promise.all([ /* ... */ ]);
        // ... (Keep state logging & checks) ...
        let poolAStateFetched = slotA && liqA !== null; let poolBStateFetched = slotB && liqB !== null;
        if (!poolAStateFetched || !poolBStateFetched) { /* ... */ return; }

        // Simulate using estimateGas
        const simulateAmountWeth = ethers.parseUnits("0.001", WETH_DECIMALS);
        console.log(`  [Monitor] Simulating Quoter calls via estimateGas using ${ethers.formatUnits(simulateAmountWeth, WETH_DECIMALS)} WETH...`);
        const [simASuccess, simBSuccess] = await Promise.all([
             simulateSwap("Pool A", WETH_ADDRESS, USDC_ADDRESS, simulateAmountWeth, POOL_A_FEE_BPS, quoterContract),
             simulateSwap("Pool B", WETH_ADDRESS, USDC_ADDRESS, simulateAmountWeth, POOL_B_FEE_BPS, quoterContract)
        ]);
        console.log(`  [Monitor] Quoter simulations results. Sim A Success: ${simASuccess}, Sim B Success: ${simBSuccess}`);

        if (simASuccess && simBSuccess) {
             console.log("  [Monitor] Both Quoter simulations succeeded via estimateGas. Proceeding to attemptArbitrage.");
             const pseudoOpportunity = { /* ... create placeholder ... */ };
             await attemptArbitrage(pseudoOpportunity);
        } else { /* ... log failure ... */ }

    } catch (error) {
        console.error(`[Monitor] Error in monitoring loop:`, error);
    } finally {
        console.log(`[Monitor] END - ${new Date().toISOString()}`);
    }
} // <<< Closing brace for monitorPools function
