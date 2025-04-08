// bot.js - Arbitrum Uniswap V3 Flash Swap Bot with Debugging (v22.2 - Dynamic ABI, State Passing, Fixed Config)

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

// Keep minimal standard ABIs for Pool
const IUniswapV3PoolABI = [
    "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
    "function liquidity() external view returns (uint128)"
];
// Full Quoter ABI needed for estimateGas approach
const IQuoterV2ABI = [
    { "type": "constructor", "inputs": [ { "name": "_factory", "type": "address", "internalType": "address" }, { "name": "_WETH9", "type": "address", "internalType": "address" } ], "stateMutability": "nonpayable" }, { "name": "WETH9", "type": "function", "inputs": [], "outputs": [ { "name": "", "type": "address", "internalType": "address" } ], "stateMutability": "view" }, { "name": "factory", "type": "function", "inputs": [], "outputs": [ { "name": "", "type": "address", "internalType": "address" } ], "stateMutability": "view" }, { "name": "quoteExactInput", "type": "function", "inputs": [ { "name": "path", "type": "bytes", "internalType": "bytes" }, { "name": "amountIn", "type": "uint256", "internalType": "uint256" } ], "outputs": [ { "name": "amountOut", "type": "uint256", "internalType": "uint256" }, { "name": "sqrtPriceX96AfterList", "type": "uint160[]", "internalType": "uint160[]" }, { "name": "initializedTicksCrossedList", "type": "uint32[]", "internalType": "uint32[]" }, { "name": "gasEstimate", "type": "uint256", "internalType": "uint256" } ], "stateMutability": "nonpayable" }, { "name": "quoteExactInputSingle", "type": "function", "inputs": [ { "name": "params", "type": "tuple", "components": [ { "name": "tokenIn", "type": "address", "internalType": "address" }, { "name": "tokenOut", "type": "address", "internalType": "address" }, { "name": "amountIn", "type": "uint256", "internalType": "uint256" }, { "name": "fee", "type": "uint24", "internalType": "uint24" }, { "name": "sqrtPriceLimitX96", "type": "uint160", "internalType": "uint160" } ], "internalType": "struct IQuoterV2.QuoteExactInputSingleParams" } ], "outputs": [ { "name": "amountOut", "type": "uint256", "internalType": "uint256" }, { "name": "sqrtPriceX96After", "type": "uint160", "internalType": "uint160" }, { "name": "initializedTicksCrossed", "type": "uint32", "internalType": "uint32" }, { "name": "gasEstimate", "type": "uint256", "internalType": "uint256" } ], "stateMutability": "nonpayable" }, { "name": "quoteExactOutput", "type": "function", "inputs": [ { "name": "path", "type": "bytes", "internalType": "bytes" }, { "name": "amountOut", "type": "uint256", "internalType": "uint256" } ], "outputs": [ { "name": "amountIn", "type": "uint256", "internalType": "uint256" }, { "name": "sqrtPriceX96AfterList", "type": "uint160[]", "internalType": "uint160[]" }, { "name": "initializedTicksCrossedList", "type": "uint32[]", "internalType": "uint32[]" }, { "name": "gasEstimate", "type": "uint256", "internalType": "uint256" } ], "stateMutability": "nonpayable" }, { "name": "quoteExactOutputSingle", "type": "function", "inputs": [ { "name": "params", "type": "tuple", "components": [ { "name": "tokenIn", "type": "address", "internalType": "address" }, { "name": "tokenOut", "type": "address", "internalType": "address" }, { "name": "amount", "type": "uint256", "internalType": "uint256" }, { "name": "fee", "type": "uint24", "internalType": "uint24" }, { "name": "sqrtPriceLimitX96", "type": "uint160", "internalType": "uint160" } ], "internalType": "struct IQuoterV2.QuoteExactOutputSingleParams" } ], "outputs": [ { "name": "amountIn", "type": "uint256", "internalType": "uint256" }, { "name": "sqrtPriceX96After", "type": "uint160", "internalType": "uint160" }, { "name": "initializedTicksCrossed", "type": "uint32", "internalType": "uint32" }, { "name": "gasEstimate", "type": "uint256", "internalType": "uint256" } ], "stateMutability": "nonpayable" }, { "name": "uniswapV3SwapCallback", "type": "function", "inputs": [ { "name": "amount0Delta", "type": "int256", "internalType": "int256" }, { "name": "amount1Delta", "type": "int256", "internalType": "int256" }, { "name": "path", "type": "bytes", "internalType": "bytes" } ], "outputs": [], "stateMutability": "view" }
];


// --- Bot Settings ---
const POLLING_INTERVAL_MS = 10000;
const PROFIT_THRESHOLD_USD = 0.05;
// Define BORROW_AMOUNT_WETH_WEI globally BEFORE the config object uses it
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
        if (err.response) { console.error(`[ABI Fetch] Arbiscan request failed: Status ${err.response.status}`, err.response.data); }
        else if (err.request) { console.error("[ABI Fetch] Arbiscan request failed: No response received.", err.request); }
        else { console.error("[ABI Fetch] Error setting up Arbiscan request:", err.message); }
        throw new Error(`Failed to fetch ABI for ${contractAddress}. Cause: ${err.message}`);
    }
}

// --- Initialization & Startup ---
// Declare state variables in outer scope
let provider, signer;
let contracts = {};
// Correctly define config object using globally defined constants
let config = {
    FLASH_SWAP_CONTRACT_ADDRESS: FLASH_SWAP_CONTRACT_ADDRESS,
    WETH_ADDRESS: WETH_ADDRESS,
    USDC_ADDRESS: USDC_ADDRESS,
    QUOTER_V2_ADDRESS: QUOTER_V2_ADDRESS,
    POOL_A_ADDRESS: POOL_A_ADDRESS,
    POOL_B_ADDRESS: POOL_B_ADDRESS,
    POOL_A_FEE_BPS: POOL_A_FEE_BPS,
    POOL_B_FEE_BPS: POOL_B_FEE_BPS,
    WETH_DECIMALS: WETH_DECIMALS,
    USDC_DECIMALS: USDC_DECIMALS,
    BORROW_AMOUNT_WETH_WEI: BORROW_AMOUNT_WETH_WEI,
    POLLING_INTERVAL_MS: POLLING_INTERVAL_MS,
    // Add other config if needed later
    RPC_URL: RPC_URL,
    PRIVATE_KEY: PRIVATE_KEY,
    ARBISCAN_API_KEY: ARBISCAN_API_KEY
};

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
        const state = { provider, signer, contracts, config }; // Pass config into state

        // --- Initial Logs ---
        console.log(`Bot starting...`);
        console.log(` - FlashSwap Contract: ${config.FLASH_SWAP_CONTRACT_ADDRESS}`);
        console.log(` - Quoter V2 Contract: ${config.QUOTER_V2_ADDRESS}`);
        console.log(` - Monitoring Pools:`);
        console.log(`   - Pool A (WETH/USDC ${POOL_A_FEE_PERCENT}%): ${config.POOL_A_ADDRESS}`);
        console.log(`   - Pool B (WETH/USDC ${POOL_B_FEE_PERCENT}%): ${config.POOL_B_ADDRESS}`);
        console.log(` - Debug Borrow Amount: ${ethers.formatUnits(config.BORROW_AMOUNT_WETH_WEI, config.WETH_DECIMALS)} WETH`);
        console.log(` - Polling Interval: ${config.POLLING_INTERVAL_MS / 1000} seconds`);
        console.log(` - Profit Threshold: $${PROFIT_THRESHOLD_USD} USD (approx, before gas)`);


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
        setInterval(() => monitorPools(state), config.POLLING_INTERVAL_MS); // Pass state
        console.log(`\nMonitoring started. Will check every ${config.POLLING_INTERVAL_MS / 1000} seconds.`);

    } catch (initError) {
        console.error("\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        console.error("Initialization Error / Startup Error:");
        console.error("Check RPC, .env vars (API Key?), fetched ABI, Contract Calls.");
        console.error(initError.stack || initError);
        console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        process.exit(1);
    }
})();


// --- Helper Functions ---
// Simulates Quoter call via estimateGas
async function simulateSwap(poolDesc, tokenIn, tokenOut, amountInWei, feeBps, quoterContract) { // Needs quoterContract passed
    if (!quoterContract) { console.error(`[SimulateSwap] Quoter contract instance not available!`); return false; }
    const params = { tokenIn, tokenOut, amountIn: amountInWei, fee: feeBps, sqrtPriceLimitX96: 0n };
    console.log(`  [Quoter Sim using estimateGas - ${poolDesc}] Params:`, { /* Logging */ });
    try {
        await quoterContract.quoteExactInputSingle.estimateGas(params); // Use passed contract
        console.log(`  [Quoter Sim using estimateGas - ${poolDesc}] SUCCESS (Simulation likely ok)`);
        return true;
    } catch (error) {
        console.warn(`  [Quoter Sim using estimateGas - ${poolDesc}] FAILED: ${error.reason || error.message || error}`);
        if (error.data && error.data !== '0x') console.warn(`     Raw Revert Data: ${error.data}`);
        return false;
    }
}


// --- Main Monitoring Loop ---
async function monitorPools(state) { // Accept state
    console.log(`\n[Monitor] START - ${new Date().toISOString()}`);

    const { poolAContract, poolBContract, quoterContract, flashSwapContract } = state.contracts; // Destructure from state
    const { config } = state; // Destructure config

     if (!poolAContract || !poolBContract || !quoterContract) { /* ... */ return; }
    try {
        console.log("  [Monitor] Fetching pool states...");
        // Use contracts from state
        const poolStatePromises = [
            poolAContract.slot0().catch(e => { /* ... */ return null; }),
            poolAContract.liquidity().catch(e => { /* ... */ return null; }),
            poolBContract.slot0().catch(e => { /* ... */ return null; }),
            poolBContract.liquidity().catch(e => { /* ... */ return null; })
        ];
        const [slotA, liqA, slotB, liqB] = await Promise.all(poolStatePromises);
        console.log("  [Monitor] Promise.all for pool states resolved.");

        let poolAStateFetched = slotA && liqA !== null; let poolBStateFetched = slotB && liqB !== null;
        if (slotA && liqA !== null) { /* log state A */ } else { /* log fail A */ }
        if (slotB && liqB !== null) { /* log state B */ } else { /* log fail B */ }
        if (!poolAStateFetched || !poolBStateFetched) { /* ... */ return; }

        // Simulate using estimateGas
        const simulateAmountWeth = ethers.parseUnits("0.001", config.WETH_DECIMALS); // Use config
        console.log(`  [Monitor] Simulating Quoter calls via estimateGas using ${ethers.formatUnits(simulateAmountWeth, config.WETH_DECIMALS)} WETH...`);
        // Pass quoterContract from state to simulateSwap
        const [simASuccess, simBSuccess] = await Promise.all([
             simulateSwap("Pool A", config.WETH_ADDRESS, config.USDC_ADDRESS, simulateAmountWeth, config.POOL_A_FEE_BPS, quoterContract),
             simulateSwap("Pool B", config.WETH_ADDRESS, config.USDC_ADDRESS, simulateAmountWeth, config.POOL_B_FEE_BPS, quoterContract)
        ]);
        console.log(`  [Monitor] Quoter simulations results. Sim A Success: ${simASuccess}, Sim B Success: ${simBSuccess}`);

        if (simASuccess && simBSuccess) {
             console.log("  [Monitor] Both Quoter simulations succeeded via estimateGas. Proceeding to attemptArbitrage.");
             const pseudoOpportunity = {
                 poolA: { address: config.POOL_A_ADDRESS, feeBps: config.POOL_A_FEE_BPS, price: 0 },
                 poolB: { address: config.POOL_B_ADDRESS, feeBps: config.POOL_B_FEE_BPS, price: 0 },
                 startPool: "A", // Still using placeholder logic
                 borrowTokenSymbol: "WETH",
                 estimatedProfitUsd: 999
             };
             await attemptArbitrage(state); // Pass state to attemptArbitrage

        } else { /* ... log failure ... */ }

    } catch (error) {
        console.error(`[Monitor] Error in monitoring loop:`, error);
    } finally {
        console.log(`[Monitor] END - ${new Date().toISOString()}`);
    }
} // <<< Closing brace for monitorPools function
