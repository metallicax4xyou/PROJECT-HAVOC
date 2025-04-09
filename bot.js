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

// --- Helper Functions --- MUST BE DEFINED BEFORE STARTUP IIFE USES THEM IN monitorPools

// Simulates Quoter call via estimateGas
async function simulateSwap(poolDesc, tokenIn, tokenOut, amountInWei, feeBps, quoterContract) { // Needs quoterContract passed
    if (!quoterContract) { console.error(`[SimulateSwap] Quoter contract instance not available!`); return false; }

    const params = { tokenIn, tokenOut, amountIn: amountInWei, fee: feeBps, sqrtPriceLimitX96: 0n };
    console.log(`  [Quoter Sim using estimateGas - ${poolDesc}] Params:`, {
        tokenIn: params.tokenIn, tokenOut: params.tokenOut, amountIn: params.amountIn.toString(),
        fee: params.fee, sqrtPriceLimitX96: params.sqrtPriceLimitX96.toString()
     });
    try {
        await quoterContract.quoteExactInputSingle.estimateGas(params); // Use passed contract
        console.log(`  [Quoter Sim using estimateGas - ${poolDesc}] SUCCESS (Simulation likely ok)`);
        return true; // Indicate simulation didn't revert
    } catch (error) {
        console.warn(`  [Quoter Sim using estimateGas - ${poolDesc}] FAILED: ${error.reason || error.message || error}`);
        if (error.data && error.data !== '0x') console.warn(`     Raw Revert Data: ${error.data}`);
        return false; // Indicate simulation failed
    }
}


// --- FULL attemptArbitrage Function - NORMAL Logic (v20 restored, uses state) ---
async function attemptArbitrage(state) { // Accept state object
    const { flashSwapContract, poolAContract, poolBContract } = state.contracts; // Destructure contracts from state
    const { config } = state; // Destructure config from state
    // Get opportunity from state, added by monitorPools
    const opportunity = state.opportunity;

    // Check if opportunity exists in state
    if (!opportunity) {
        console.error("  [Attempt] Opportunity data missing in state. Aborting.");
        return;
    }

    // Use the startPool from the opportunity object
    const startPool = opportunity.startPool;

    console.log(`\n========= Arbitrage Opportunity Detected (Using Detected Start Pool: ${startPool}) =========`); // Updated Log

    // Check required contracts
    if (!flashSwapContract || !poolAContract || !poolBContract) {
        console.error("  [Attempt] Contract instances missing in state. Aborting.");
        return;
    }
    // Check required opportunity data
     if (!opportunity.borrowTokenSymbol || !opportunity.startPool) {
         console.error("  [Attempt] Missing borrowTokenSymbol or startPool in opportunity data.");
         return;
     }

    // Basic logging using config from state
    console.log(`  Pool A Addr: ${config.POOL_A_ADDRESS}, Fee: ${config.POOL_A_FEE_BPS}bps`);
    console.log(`  Pool B Addr: ${config.POOL_B_ADDRESS}, Fee: ${config.POOL_B_FEE_BPS}bps`);
    console.log(`  Using Start Pool: ${startPool}`);
    const borrowTokenSymbol = opportunity.borrowTokenSymbol;
    console.log(`  Borrow Token: ${borrowTokenSymbol}`);


    // Determine parameters
    let flashLoanPoolAddress;
    let borrowAmount0 = 0n; let borrowAmount1 = 0n;
    let tokenBorrowedAddress; let tokenIntermediateAddress;
    let poolAForSwap; let poolBForSwap;
    let feeAForSwap; let feeBForSwap;
    let amountToBorrowWei;

    if (borrowTokenSymbol === 'WETH') {
        tokenBorrowedAddress = config.WETH_ADDRESS; tokenIntermediateAddress = config.USDC_ADDRESS;
        amountToBorrowWei = config.BORROW_AMOUNT_WETH_WEI; // Use config value
        borrowAmount0 = amountToBorrowWei; borrowAmount1 = 0n;

        // Use the startPool variable determined above
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

     // Basic validation
     if (!flashLoanPoolAddress || !tokenBorrowedAddress || !tokenIntermediateAddress || !poolAForSwap || !poolBForSwap || feeAForSwap === undefined || feeBForSwap === undefined || amountToBorrowWei === undefined) {
         console.error("  [Attempt] Failed to determine all necessary parameters.");
         return;
     }

    console.log(`  Executing Path: Borrow ${ethers.formatUnits(amountToBorrowWei, config.WETH_DECIMALS)} ${borrowTokenSymbol} from ${flashLoanPoolAddress}`);
    console.log(`    -> Swap 1 on ${poolAForSwap} (Fee: ${feeAForSwap}bps)`);
    console.log(`    -> Swap 2 on ${poolBForSwap} (Fee: ${feeBForSwap}bps)`);


    // --- Check Flash Loan Pool State ---
    try {
        // Select contract instance based on determined flashLoanPoolAddress using contracts from state
        const flashLoanPoolContract = flashLoanPoolAddress.toLowerCase() === config.POOL_A_ADDRESS.toLowerCase() ? poolAContract : poolBContract;
         if (!flashLoanPoolContract) { throw new Error(`Could not get flash loan pool contract instance for ${flashLoanPoolAddress}.`); }
        const [slot0, liquidity] = await Promise.all([
             flashLoanPoolContract.slot0().catch(e => {console.error(`[Attempt] Error reading flash loan pool ${flashLoanPoolAddress} slot0: ${e.message}`); return null;}),
             flashLoanPoolContract.liquidity().catch(e => {console.error(`[Attempt] Error reading flash loan pool ${flashLoanPoolAddress} liquidity: ${e.message}`); return null;})
        ]);
        if (slot0 === null || liquidity === null) { throw new Error(`Failed to fetch flash loan pool ${flashLoanPoolAddress} state.`); }
        console.log(`  Flash Loan Pool Status (${flashLoanPoolAddress}): Tick=${slot0.tick}, Liquidity=${liquidity.toString()}`);
        if (liquidity === 0n) console.warn(`    WARNING: Flash loan pool ${flashLoanPoolAddress} has ZERO active liquidity!`);
    } catch (err) { console.error(`  Error checking flash loan pool state: ${err.message}`); return; }


    // --- Construct Callback Params ---
    const arbitrageParams = {
        tokenIntermediate: tokenIntermediateAddress, poolA: poolAForSwap, poolB: poolBForSwap,
        feeA: feeAForSwap, feeB: feeBForSwap,
        amountOutMinimum1: 0n, amountOutMinimum2: 0n
    };
    let encodedParams;
     try {
        encodedParams = ethers.AbiCoder.defaultAbiCoder().encode(
            ['tuple(address tokenIntermediate, address poolA, address poolB, uint24 feeA, uint24 feeB, uint amountOutMinimum1, uint amountOutMinimum2)'],
            [arbitrageParams]
        );
        console.log("  Callback Parameters (Decoded):", {
             tokenIntermediate: arbitrageParams.tokenIntermediate, poolA: arbitrageParams.poolA, poolB: arbitrageParams.poolB,
             feeA: arbitrageParams.feeA, feeB: arbitrageParams.feeB,
             amountOutMinimum1: '0', amountOutMinimum2: '0'
        });
        console.log("  Callback Parameters (Encoded):", encodedParams.substring(0,100)+"...");
    } catch (encodeError) { console.error("  [Attempt] Error encoding params:", encodeError); return; }


    // --- initiateFlashSwap Args ---
    const initiateFlashSwapArgs = [ flashLoanPoolAddress, borrowAmount0, borrowAmount1, encodedParams ];

    // --- Simulation & Estimation ---
    console.log("  >>> Entering Simulation & Estimation block <<<");
    try {
        // Use flashSwapContract from state
        if (!flashSwapContract.initiateFlashSwap) { throw new Error("FlashSwap ABI missing 'initiateFlashSwap'"); }
        console.log("  >>> Before staticCall <<<");
        console.log("  [1/3] Attempting staticCall simulation...");
        await flashSwapContract.initiateFlashSwap.staticCall( ...initiateFlashSwapArgs, { gasLimit: 3_000_000 });
        console.log("  >>> After staticCall (Success) <<<");
        console.log("  ✅ [1/3] staticCall successful.");

        console.log("  >>> Before estimateGas <<<");
        console.log("  [2/3] Attempting estimateGas...");
        try { // Inner try for estimateGas
            const estimatedGas = await flashSwapContract.initiateFlashSwap.estimateGas(...initiateFlashSwapArgs);
            console.log("  >>> After estimateGas (Success) <<<");
            console.log(`  ✅ [2/3] estimateGas successful. Estimated Gas: ${Number(estimatedGas)}`);
            console.log("  [3/3] Conditions met for sending transaction (Execution Disabled).");
             // --- ADD ACTUAL TRANSACTION SENDING LOGIC HERE ---
             // e.g., check calculated profit vs gas cost, then send if viable

        } catch (gasError) { // Catch estimateGas specific error
            console.log("  >>> Inside estimateGas CATCH block <<<");
            console.error(`  ❌ [2/3] estimateGas failed:`, gasError.reason || gasError.message || gasError);
            if (gasError.stack) { console.error("     Stack Trace:", gasError.stack); }
            else { console.error("     Full Error Obj:", JSON.stringify(gasError, Object.getOwnPropertyNames(gasError))); }
        } // End inner try/catch
    } catch (staticCallError) { // Catch staticCall specific error
        console.log("  >>> Inside staticCall CATCH block <<<");
        console.error(`  ❌ [1/3] staticCall failed:`, staticCallError.reason || staticCallError.message || staticCallError);
         if (staticCallError.data && staticCallError.data !== '0x') console.error(`     Revert Data: ${staticCallError.data}`);
         if (staticCallError.stack) { console.error("     Stack Trace:", staticCallError.stack); }
         else { console.error("     Full Error Obj:", JSON.stringify(staticCallError, Object.getOwnPropertyNames(staticCallError))); }
    } // End outer try/catch
    console.log("  >>> Exiting Simulation & Estimation block <<<");
    console.log("========= Arbitrage Attempt Complete =========");
 } // <<< Closing brace for attemptArbitrage function


// --- Main Monitoring Loop ---
// MODIFIED: Re-added opportunity detection using ticks
async function monitorPools(state) { // Accept state
    console.log(`\n[Monitor] START - ${new Date().toISOString()}`);

    // Destructure needed items from state
    const { poolAContract, poolBContract, quoterContract } = state.contracts;
    const { config } = state; // Destructure config

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

        let poolAStateFetched = false; let poolBStateFetched = false;
        if (slotA && liqA !== null) {
             console.log(`  [Monitor] Pool A State: Tick=${slotA.tick}, Liquidity=${liqA.toString()}`);
             if (liqA === 0n) console.warn("    [Monitor] WARNING: Pool A has ZERO active liquidity!");
             poolAStateFetched = true;
        } else { console.log(`  [Monitor] Pool A State: Failed to fetch.`); }
        if (slotB && liqB !== null) {
             console.log(`  [Monitor] Pool B State: Tick=${slotB.tick}, Liquidity=${liqB.toString()}`);
              if (liqB === 0n) console.warn("    [Monitor] WARNING: Pool B has ZERO active liquidity!");
              poolBStateFetched = true;
        } else { console.log(`  [Monitor] Pool B State: Failed to fetch.`); }

        if (!poolAStateFetched || !poolBStateFetched) {
            console.log("  [Monitor] Could not fetch state for both pools. Skipping simulation cycle.");
            console.log("[Monitor] END (Early exit due to fetch failure)");
            return;
        }

        // Simulate using estimateGas
        const simulateAmountWeth = ethers.parseUnits("0.001", config.WETH_DECIMALS);
        console.log(`  [Monitor] Simulating Quoter calls via estimateGas using ${ethers.formatUnits(simulateAmountWeth, config.WETH_DECIMALS)} WETH...`);
        // Pass quoterContract from state to simulateSwap
        const [simASuccess, simBSuccess] = await Promise.all([
             simulateSwap("Pool A", config.WETH_ADDRESS, config.USDC_ADDRESS, simulateAmountWeth, config.POOL_A_FEE_BPS, quoterContract),
             simulateSwap("Pool B", config.WETH_ADDRESS, config.USDC_ADDRESS, simulateAmountWeth, config.POOL_B_FEE_BPS, quoterContract)
        ]);
        console.log(`  [Monitor] Quoter simulations results. Sim A Success: ${simASuccess}, Sim B Success: ${simBSuccess}`);

        // Only proceed if BOTH simulations succeed
        if (simASuccess && simBSuccess) {
             console.log("  [Monitor] Both Quoter simulations succeeded via estimateGas.");

             // --- Calculate pseudo prices/profit for opportunity detection using ticks ---
             const tickA = Number(slotA.tick); // Convert BigInt tick to Number for comparison
             const tickB = Number(slotB.tick);
             let opportunity = null;
             // Rough profit estimate isn't really useful without quote amounts, use fixed value for threshold check
             let estimatedProfitUsd = 0; // Placeholder
             const TICK_DIFF_THRESHOLD = 1; // Example: require at least 1 tick difference

            console.log(`  [Monitor] Pool A Tick: ${tickA}, Pool B Tick: ${tickB}`);

             // If Pool A tick > Pool B tick, WETH is pricier on A. Strategy: Sell WETH on A. Path: Borrow A, Swap A -> B
             if (tickA > tickB + TICK_DIFF_THRESHOLD) { // Add threshold
                 console.log(`  [Monitor] Potential Opportunity: Pool A tick higher.`);
                 estimatedProfitUsd = 999; // Force trigger for debug
                 opportunity = {
                     startPool: "A", // Start on higher priced pool
                     borrowTokenSymbol: "WETH",
                     estimatedProfitUsd: estimatedProfitUsd, // Store forced profit
                     // Include pool info if needed by attemptArbitrage, though config has it
                     poolA: { address: config.POOL_A_ADDRESS, feeBps: config.POOL_A_FEE_BPS },
                     poolB: { address: config.POOL_B_ADDRESS, feeBps: config.POOL_B_FEE_BPS }
                 };
             }
             // If Pool B tick > Pool A tick, WETH is pricier on B. Strategy: Sell WETH on B. Path: Borrow B, Swap B -> A
             else if (tickB > tickA + TICK_DIFF_THRESHOLD) { // Add threshold
                  console.log(`  [Monitor] Potential Opportunity: Pool B tick higher.`);
                  estimatedProfitUsd = 999; // Force trigger for debug
                  opportunity = {
                     startPool: "B", // Start on higher priced pool
                     borrowTokenSymbol: "WETH",
                     estimatedProfitUsd: estimatedProfitUsd,
                     poolA: { address: config.POOL_A_ADDRESS, feeBps: config.POOL_A_FEE_BPS },
                     poolB: { address: config.POOL_B_ADDRESS, feeBps: config.POOL_B_FEE_BPS }
                 };
             }

             if (opportunity) {
                 // Check threshold (using forced profit for debug)
                 if (opportunity.estimatedProfitUsd > config.PROFIT_THRESHOLD_USD) {
                      console.log(`  [Monitor] Triggering attemptArbitrage with startPool: ${opportunity.startPool}`);
                      // Add the created opportunity to the state object before calling
                      state.opportunity = opportunity; // Add opportunity data to state
                      await attemptArbitrage(state); // Pass updated state
                 } else {
                      // This branch won't be hit with forced profit = 999
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
} // <<< Closing brace for monitorPools function


// --- Start the Bot ---
(async () => {
    console.log("\n>>> Entering startup async IIFE...");
    try {
        // ... Setup Provider/Signer (as before) ...
        console.log("[Init] Setting up Provider...");
        provider = new ethers.JsonRpcProvider(config.RPC_URL); // Use config
        console.log("[Init] Setting up Signer...");
        signer = new ethers.Wallet(config.PRIVATE_KEY, provider); // Use config
        console.log(`[Init] Signer Address: ${signer.address}`);

        // --- Fetch FlashSwap ABI Dynamically ---
        const flashSwapABI_dynamic = await fetchABIFromArbiscan(config.FLASH_SWAP_CONTRACT_ADDRESS); // Use config

        // --- Instantiate Contracts ---
        console.log("[Init] Instantiating Contracts...");
        contracts.flashSwapContract = new ethers.Contract(config.FLASH_SWAP_CONTRACT_ADDRESS, flashSwapABI_dynamic, signer);
        contracts.quoterContract = new ethers.Contract(config.QUOTER_V2_ADDRESS, IQuoterV2ABI, provider);
        contracts.poolAContract = new ethers.Contract(config.POOL_A_ADDRESS, IUniswapV3PoolABI, provider);
        contracts.poolBContract = new ethers.Contract(config.POOL_B_ADDRESS, IUniswapV3PoolABI, provider);
        console.log("[Init] All Contract instances created successfully.");

        // --- Create the state object ---
        const state = { provider, signer, contracts, config }; // Config included

        // --- Initial Logs ---
        console.log(`Bot starting...`);
        // ... (rest of initial logs using state.config) ...
        console.log(` - FlashSwap Contract: ${state.config.FLASH_SWAP_CONTRACT_ADDRESS}`);
        console.log(` - Quoter V2 Contract: ${state.config.QUOTER_V2_ADDRESS}`);
        console.log(` - Monitoring Pools:`);
        console.log(`   - Pool A (WETH/USDC ${state.config.POOL_A_FEE_PERCENT}%): ${state.config.POOL_A_ADDRESS}`);
        console.log(`   - Pool B (WETH/USDC ${state.config.POOL_B_FEE_PERCENT}%): ${state.config.POOL_B_ADDRESS}`);
        console.log(` - Debug Borrow Amount: ${ethers.formatUnits(state.config.BORROW_AMOUNT_WETH_WEI, state.config.WETH_DECIMALS)} WETH`);
        console.log(` - Polling Interval: ${state.config.POLLING_INTERVAL_MS / 1000} seconds`);
        console.log(` - Profit Threshold: $${PROFIT_THRESHOLD_USD} USD (approx, before gas)`);


        // --- Startup Checks ---
        console.log(">>> Checking signer b
