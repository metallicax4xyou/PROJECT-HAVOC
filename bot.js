// bot.js - Arbitrum Uniswap V3 Flash Swap Bot with Debugging (v20 - Force Borrow B)

const { ethers } = require("ethers");
require('dotenv').config();

// --- Configuration ---
// ... (Keep all configuration constants: RPC_URL, PRIVATE_KEY, addresses, fees, decimals) ...
const RPC_URL = process.env.ARBITRUM_RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
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
// --- CRITICAL: Ensure your Full FlashSwapABI is pasted here ---
const FlashSwapABI = [{"inputs":[{"internalType":"address","name":"_swapRouter","type":"address"}],"stateMutability":"nonpayable","type":"constructor"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"poolA","type":"address"},{"indexed":true,"internalType":"address","name":"poolB","type":"address"},{"indexed":false,"internalType":"address","name":"tokenBorrowed","type":"address"},{"indexed":false,"internalType":"uint256","name":"amountBorrowed","type":"uint256"}],"name":"ArbitrageAttempt","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"token","type":"address"},{"indexed":true,"internalType":"address","name":"recipient","type":"address"},{"indexed":false,"internalType":"uint256","name":"amount","type":"uint256"}],"name":"EmergencyWithdrawal","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"caller","type":"address"},{"indexed":true,"internalType":"address","name":"pool","type":"address"},{"indexed":false,"internalType":"uint256","name":"amount0","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"amount1","type":"uint256"}],"name":"FlashSwapInitiated","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"token","type":"address"},{"indexed":false,"internalType":"uint256","name":"amountRepaid","type":"uint256"}],"name":"RepaymentSuccess","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"swapNumber","type":"uint256"},{"indexed":true,"internalType":"address","name":"tokenIn","type":"address"},{"indexed":true,"internalType":"address","name":"tokenOut","type":"address"},{"indexed":false,"internalType":"uint256","name":"amountIn","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"amountOut","type":"uint256"}],"name":"SwapExecuted","type":"event"},{"inputs":[],"name":"SWAP_ROUTER","outputs":[{"internalType":"contract ISwapRouter","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"V3_FACTORY","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"_poolAddress","type":"address"},{"internalType":"uint256","name":"_amount0","type":"uint256"},{"internalType":"uint256","name":"_amount1","type":"uint256"},{"internalType":"bytes","name":"_params","type":"bytes"}],"name":"initiateFlashSwap","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"owner","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"fee0","type":"uint256"},{"internalType":"uint256","name":"fee1","type":"uint256"},{"internalType":"bytes","name":"data","type":"bytes"}],"name":"uniswapV3FlashCallback","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"withdrawEther","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"tokenAddress","type":"address"}],"name":"withdrawToken","outputs":[],"stateMutability":"nonpayable","type":"function"},{"stateMutability":"payable","type":"receive"}];
if (!FlashSwapABI || FlashSwapABI.length === 0 || (typeof FlashSwapABI[0] === 'string' && FlashSwapABI[0].includes('PASTE YOUR FULL FlashSwap ABI HERE'))) { /* ... error check ... */ }

const IUniswapV3PoolABI = [
    "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
    "function liquidity() external view returns (uint128)"
];
const IQuoterV2ABI = [ // Full ABI - using estimateGas for simulation
    { "type": "constructor", "inputs": [ { "name": "_factory", "type": "address", "internalType": "address" }, { "name": "_WETH9", "type": "address", "internalType": "address" } ], "stateMutability": "nonpayable" },
    { "name": "WETH9", "type": "function", "inputs": [], "outputs": [ { "name": "", "type": "address", "internalType": "address" } ], "stateMutability": "view" },
    { "name": "factory", "type": "function", "inputs": [], "outputs": [ { "name": "", "type": "address", "internalType": "address" } ], "stateMutability": "view" },
    { "name": "quoteExactInput", "type": "function", "inputs": [ { "name": "path", "type": "bytes", "internalType": "bytes" }, { "name": "amountIn", "type": "uint256", "internalType": "uint256" } ], "outputs": [ { "name": "amountOut", "type": "uint256", "internalType": "uint256" }, { "name": "sqrtPriceX96AfterList", "type": "uint160[]", "internalType": "uint160[]" }, { "name": "initializedTicksCrossedList", "type": "uint32[]", "internalType": "uint32[]" }, { "name": "gasEstimate", "type": "uint256", "internalType": "uint256" } ], "stateMutability": "nonpayable" },
    { "name": "quoteExactInputSingle", "type": "function", "inputs": [ { "name": "params", "type": "tuple", "components": [ { "name": "tokenIn", "type": "address", "internalType": "address" }, { "name": "tokenOut", "type": "address", "internalType": "address" }, { "name": "amountIn", "type": "uint256", "internalType": "uint256" }, { "name": "fee", "type": "uint24", "internalType": "uint24" }, { "name": "sqrtPriceLimitX96", "type": "uint160", "internalType": "uint160" } ], "internalType": "struct IQuoterV2.QuoteExactInputSingleParams" } ], "outputs": [ { "name": "amountOut", "type": "uint256", "internalType": "uint256" }, { "name": "sqrtPriceX96After", "type": "uint160", "internalType": "uint160" }, { "name": "initializedTicksCrossed", "type": "uint32", "internalType": "uint32" }, { "name": "gasEstimate", "type": "uint256", "internalType": "uint256" } ], "stateMutability": "nonpayable" },
    { "name": "quoteExactOutput", "type": "function", "inputs": [ { "name": "path", "type": "bytes", "internalType": "bytes" }, { "name": "amountOut", "type": "uint256", "internalType": "uint256" } ], "outputs": [ { "name": "amountIn", "type": "uint256", "internalType": "uint256" }, { "name": "sqrtPriceX96AfterList", "type": "uint160[]", "internalType": "uint160[]" }, { "name": "initializedTicksCrossedList", "type": "uint32[]", "internalType": "uint32[]" }, { "name": "gasEstimate", "type": "uint256", "internalType": "uint256" } ], "stateMutability": "nonpayable" },
    { "name": "quoteExactOutputSingle", "type": "function", "inputs": [ { "name": "params", "type": "tuple", "components": [ { "name": "tokenIn", "type": "address", "internalType": "address" }, { "name": "tokenOut", "type": "address", "internalType": "address" }, { "name": "amount", "type": "uint256", "internalType": "uint256" }, { "name": "fee", "type": "uint24", "internalType": "uint24" }, { "name": "sqrtPriceLimitX96", "type": "uint160", "internalType": "uint160" } ], "internalType": "struct IQuoterV2.QuoteExactOutputSingleParams" } ], "outputs": [ { "name": "amountIn", "type": "uint256", "internalType": "uint256" }, { "name": "sqrtPriceX96After", "type": "uint160", "internalType": "uint160" }, { "name": "initializedTicksCrossed", "type": "uint32", "internalType": "uint32" }, { "name": "gasEstimate", "type": "uint256", "internalType": "uint256" } ], "stateMutability": "nonpayable" },
    { "name": "uniswapV3SwapCallback", "type": "function", "inputs": [ { "name": "amount0Delta", "type": "int256", "internalType": "int256" }, { "name": "amount1Delta", "type": "int256", "internalType": "int256" }, { "name": "path", "type": "bytes", "internalType": "bytes" } ], "outputs": [], "stateMutability": "view" }
];

// --- Bot Settings ---
const POLLING_INTERVAL_MS = 10000;
const PROFIT_THRESHOLD_USD = 0.05;
let BORROW_AMOUNT_WETH_WEI = ethers.parseUnits("0.00005", WETH_DECIMALS); // Small amount for FLASH SWAP

// --- Initialization ---
// ... (Keep initialization block - provider, signer, contracts) ...
if (!RPC_URL || !PRIVATE_KEY) { console.error("ENV VAR MISSING"); process.exit(1); }
console.log("[Init] Setting up Provider...");
const provider = new ethers.JsonRpcProvider(RPC_URL);
console.log("[Init] Setting up Signer...");
const signer = new ethers.Wallet(PRIVATE_KEY, provider);
console.log("[Init] Instantiating Contracts...");
let flashSwapContract, quoterContract, poolAContract, poolBContract;
try {
    flashSwapContract = new ethers.Contract(FLASH_SWAP_CONTRACT_ADDRESS, FlashSwapABI, signer);
    quoterContract = new ethers.Contract(QUOTER_V2_ADDRESS, IQuoterV2ABI, provider);
    poolAContract = new ethers.Contract(POOL_A_ADDRESS, IUniswapV3PoolABI, provider);
    poolBContract = new ethers.Contract(POOL_B_ADDRESS, IUniswapV3PoolABI, provider);
    console.log("[Init] All Contract instances created successfully.");
} catch (contractError) { /* Error handling */ }

// --- Initial Logs ---
console.log(`Bot starting...`);
// ... other startup logs ...

// --- Helper Functions ---
// Simulates Quoter call via estimateGas
async function simulateSwap(poolDesc, tokenIn, tokenOut, amountInWei, feeBps, quoter) {
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


// --- FULL attemptArbitrage Function - FORCING START POOL B ---
async function attemptArbitrage(opportunity) {
    // --- FORCE BORROW FROM POOL B for this test ---
    const FORCE_START_POOL = 'B'; // Set to 'B' to test; set to null or remove line for normal logic
    console.log(`\n========= Arbitrage Opportunity Detected (FORCING Start Pool: ${FORCE_START_POOL}) =========`);
    // ---

    // Use the forced start pool if set, otherwise use detected opportunity start pool
    const startPool = FORCE_START_POOL; // Using the forced pool

    // --- Basic logging ---
    // We still need the opportunity object passed in, even if we override startPool
    if (!opportunity || !opportunity.poolA || !opportunity.poolB || !opportunity.borrowTokenSymbol) {
        console.error("  [Attempt] Invalid or incomplete opportunity structure received.");
        return;
    }
    console.log(`  Pool A Addr: ${opportunity.poolA.address}, Fee: ${opportunity.poolA.feeBps}bps`);
    console.log(`  Pool B Addr: ${opportunity.poolB.address}, Fee: ${opportunity.poolB.feeBps}bps`);
    console.log(`  Using Forced Start Pool: ${startPool}`);
    console.log(`  Borrow Token: ${opportunity.borrowTokenSymbol}`);

    // Determine parameters
    let flashLoanPoolAddress;
    let borrowAmount0 = 0n; let borrowAmount1 = 0n;
    let tokenBorrowedAddress; let tokenIntermediateAddress;
    let poolAForSwap; let poolBForSwap;
    let feeAForSwap; let feeBForSwap;
    let amountToBorrowWei;

    if (opportunity.borrowTokenSymbol === 'WETH') {
        tokenBorrowedAddress = WETH_ADDRESS; tokenIntermediateAddress = USDC_ADDRESS;
        amountToBorrowWei = BORROW_AMOUNT_WETH_WEI; // Using the small debug amount
        borrowAmount0 = amountToBorrowWei; borrowAmount1 = 0n;

        // Use the potentially overridden startPool variable here
        if (startPool === 'A') { // This path won't be hit due to FORCE_START_POOL = 'B'
            console.log("  Configuring path: Borrow from A, Swap A -> B");
            flashLoanPoolAddress = opportunity.poolA.address; poolAForSwap = opportunity.poolA.address;
            feeAForSwap = opportunity.poolA.feeBps; poolBForSwap = opportunity.poolB.address;
            feeBForSwap = opportunity.poolB.feeBps;
        } else { // Start Pool B (Forced)
            console.log("  Configuring path: Borrow from B, Swap B -> A");
            flashLoanPoolAddress = opportunity.poolB.address; // Borrow from 0.30%
            poolAForSwap = opportunity.poolB.address; // Swap 1 is on Pool B (0.30%)
            feeAForSwap = opportunity.poolB.feeBps;
            poolBForSwap = opportunity.poolA.address; // Swap 2 is on Pool A (0.05%)
            feeBForSwap = opportunity.poolA.feeBps;
        }
    } else { console.error("  [Attempt] USDC Borrow NYI"); return; }

     // Basic validation
     if (!flashLoanPoolAddress || !tokenBorrowedAddress || !tokenIntermediateAddress || !poolAForSwap || !poolBForSwap || feeAForSwap === undefined || feeBForSwap === undefined || amountToBorrowWei === undefined) {
         console.error("  [Attempt] Failed to determine all necessary parameters.");
         return;
     }

    console.log(`  Executing Path: Borrow ${ethers.formatUnits(amountToBorrowWei, WETH_DECIMALS)} ${opportunity.borrowTokenSymbol} from ${flashLoanPoolAddress}`);
    console.log(`    -> Swap 1 on ${poolAForSwap} (Fee: ${feeAForSwap}bps)`); // This is POOL B (0.30%) now
    console.log(`    -> Swap 2 on ${poolBForSwap} (Fee: ${feeBForSwap}bps)`); // This is POOL A (0.05%) now


    // --- Check Flash Loan Pool State (Pool B) ---
    try {
        const flashLoanPoolContract = poolBContract; // Directly use Pool B contract instance
         if (!flashLoanPoolContract) { throw new Error("Could not get flash loan pool contract instance for Pool B."); }
        const [slot0, liquidity] = await Promise.all([
             flashLoanPoolContract.slot0().catch(e => {console.error(`[Attempt] Error reading flash loan pool B slot0: ${e.message}`); return null;}),
             flashLoanPoolContract.liquidity().catch(e => {console.error(`[Attempt] Error reading flash loan pool B liquidity: ${e.message}`); return null;})
        ]);
        if (slot0 === null || liquidity === null) { throw new Error("Failed to fetch flash loan pool B state."); }
        console.log(`  Flash Loan Pool Status (${flashLoanPoolAddress}): Tick=${slot0.tick}, Liquidity=${liquidity.toString()}`);
        if (liquidity === 0n) console.warn(`    WARNING: Flash loan pool B has ZERO active liquidity!`);
    } catch (err) { console.error(`  Error checking flash loan pool B state: ${err.message}`); return; }


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
        console.log("  Callback Parameters (Decoded):", { /* Minimal logging */ });
        console.log("  Callback Parameters (Encoded):", encodedParams);
    } catch (encodeError) { console.error("  [Attempt] Error encoding params:", encodeError); return; }


    // --- initiateFlashSwap Args ---
    const initiateFlashSwapArgs = [ flashLoanPoolAddress, borrowAmount0, borrowAmount1, encodedParams ];

    // --- Simulation & Estimation ---
    console.log("  >>> Entering Simulation & Estimation block <<<");
    try {
        if (!flashSwapContract) { throw new Error("FlashSwap contract instance missing"); }
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
        } catch (gasError) { // Catch estimateGas specific error
            console.log("  >>> Inside estimateGas CATCH block <<<");
            console.error(`  ❌ [2/3] estimateGas failed:`, gasError.reason || gasError.message || gasError);
        } // End inner try/catch
    } catch (staticCallError) { // Catch staticCall specific error
        console.log("  >>> Inside staticCall CATCH block <<<");
        console.error(`  ❌ [1/3] staticCall failed:`, staticCallError.reason || staticCallError.message || staticCallError);
         if (staticCallError.data && staticCallError.data !== '0x') console.error(`     Revert Data: ${staticCallError.data}`);
    } // End outer try/catch
    console.log("  >>> Exiting Simulation & Estimation block <<<");
    console.log("========= Arbitrage Attempt Complete =========");
 } // <<< Closing brace for attemptArbitrage function


// --- Main Monitoring Loop ---
async function monitorPools() {
    console.log(`\n[Monitor] START - ${new Date().toISOString()}`);
    try {
        console.log("  [Monitor] Fetching pool states...");
        console.log(`  [Monitor] Calling Promise.all for pool states... (A: ${POOL_A_ADDRESS}, B: ${POOL_B_ADDRESS})`);
        const poolStatePromises = [ /* ... */ ]; // Keep this Promise.all
        const [slotA, liqA, slotB, liqB] = await Promise.all(poolStatePromises);
        console.log("  [Monitor] Promise.all for pool states resolved.");
        // ... (Keep state logging and checks) ...
        let poolAStateFetched = slotA && liqA !== null; let poolBStateFetched = slotB && liqB !== null;
        if (!poolAStateFetched || !poolBStateFetched) { /* ... */ return; }

        // Simulate using estimateGas
        const simulateAmountWeth = ethers.parseUnits("0.001", WETH_DECIMALS); // Keep small
        console.log(`  [Monitor] Simulating Quoter calls via estimateGas using ${ethers.formatUnits(simulateAmountWeth, WETH_DECIMALS)} WETH...`);
        const quotePromises = [ /* ... call simulateSwap ... */ ];
        const [simASuccess, simBSuccess] = await Promise.all(quotePromises);
        console.log(`  [Monitor] Quoter simulations results. Sim A Success: ${simASuccess}, Sim B Success: ${simBSuccess}`);

        // If BOTH simulations succeeded, proceed to attemptArbitrage
        if (simASuccess && simBSuccess) {
             console.log("  [Monitor] Both Quoter simulations succeeded via estimateGas. Proceeding to attemptArbitrage.");
             // Create placeholder opportunity (doesn't matter much as attemptArbitrage forces Pool B start)
             const pseudoOpportunity = {
                 poolA: { address: POOL_A_ADDRESS, feeBps: POOL_A_FEE_BPS, price: 0 },
                 poolB: { address: POOL_B_ADDRESS, feeBps: POOL_B_FEE_BPS, price: 0 },
                 startPool: "A", // Original detection doesn't matter here
                 borrowTokenSymbol: "WETH",
                 estimatedProfitUsd: 999
             };
            await attemptArbitrage(pseudoOpportunity); // Call attemptArbitrage (which will force Pool B start)

        } else { /* ... log failure and skip ... */ }

    } catch (error) { /* ... error handling ... */ }
      finally { /* ... end log ... */ }
} // <<< Closing brace for monitorPools function


// --- Start the Bot ---
(async () => {
    // ... (Keep startup IIFE) ...
})(); // <<< Closing characters for IIFE
