// bot.js
// Monitors Uniswap V3 WETH/NativeUSDC pools on Arbitrum for arbitrage opportunities.
// Uses QuoterV2 for swap simulation. Includes dynamic gas estimation using actual TX params.
// WARNING: Experimental. Review thresholds, slippage, and execution logic carefully.

require("dotenv").config();
const { ethers } = require("ethers");

// =========================================================================
// == Configuration & Constants ==
// =========================================================================
const RPC_URL = process.env.ARBITRUM_RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!RPC_URL || !PRIVATE_KEY) { console.error("❌ Missing RPC_URL or PRIVATE_KEY in .env file."); process.exit(1); }

const FLASH_SWAP_CONTRACT_ADDRESS = ethers.getAddress("0x7a00Ec5b64e662425Bbaa0dD78972570C326210f");
const WETH_ADDRESS = ethers.getAddress("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1");
const USDC_ADDRESS = ethers.getAddress("0xaf88d065e77c8cC2239327C5EDb3A432268e5831"); // Native USDC
const POOL_WETH_USDC_005 = ethers.getAddress("0xC6962004f452bE9203591991D15f6b388e09E8D0"); // 0.05% WETH/NativeUSDC
const POOL_WETH_USDC_030 = ethers.getAddress("0xc473e2aEE3441BF9240Be85eb122aBB059A3B57c"); // 0.30% WETH/NativeUSDC
const QUOTER_V2_ADDRESS = ethers.getAddress("0x61fFE014bA17989E743c5F6cB21bF9697530B21e");

const WETH_DECIMALS = 18; const USDC_DECIMALS = 6;
const CHECK_INTERVAL_MS = 15000;
const MIN_PROFIT_THRESHOLD_WETH = ethers.parseUnits("0.00001", WETH_DECIMALS);
const SLIPPAGE_TOLERANCE = 0.005; // 0.5%
const BORROW_AMOUNT_WETH = ethers.parseUnits("0.001", WETH_DECIMALS);
const GAS_ESTIMATE_BUFFER = 1.2;
const ESTIMATE_GAS_WITH_ZERO_SLIPPAGE = false; // Default: Estimate with actual slippage params

// --- ABIs ---
const UNISWAP_V3_POOL_ABI = [ /* Pool ABI */ ]; const FLASH_SWAP_ABI = [ /* FlashSwap ABI */ ]; const QUOTER_V2_ABI = [ /* Quoter ABI */ ];

// =========================================================================
// == Ethers Setup & Initial Checks ==
// =========================================================================
let provider, signer, flashSwapContract, pool005, pool030, quoterContract; let isInitialized = false;
async function initializeBot() { /* ... Keep initialization logic from previous version ... */ }

// =========================================================================
// == Helper Functions ==
// =========================================================================
function sqrtPriceX96ToPrice(sqrtPriceX96, decimals0, decimals1) { /* ... BigInt math ... */ }
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// =========================================================================
// == Main Arbitrage Logic ==
// =========================================================================
async function checkArbitrage() {
    if (!isInitialized) { return; }
    console.log(`\n[${new Date().toISOString()}] Checking: ${POOL_WETH_USDC_005.slice(0,6)} vs ${POOL_WETH_USDC_030.slice(0,6)} (Native USDC)`);
    try {
        // 1. Get Pool Data & Determine Order
        let slot0_005, slot0_030, token0_pool005, token1_pool005;
        try { /* Sequential Fetch */ } catch (fetchError) { /* Handle */ return; }
        // ... (Validity & Token Order Checks) ...
        let token0Address, token1Address, decimals0, decimals1;
        token0Address = WETH_ADDRESS; decimals0 = WETH_DECIMALS; token1Address = USDC_ADDRESS; decimals1 = USDC_DECIMALS;
        // ...

        // 2. Calculate Prices
        const price_005 = sqrtPriceX96ToPrice(/* ... */); const price_030 = sqrtPriceX96ToPrice(/* ... */);
        if (isNaN(price_005) || isNaN(price_030)) { /* Handle */ return; }
        console.log(`   P_0.05: ... | P_0.30: ...`);
        const priceDiffPercent = /* ... */;

        // 3. Identify Direction
        const BORROW_TOKEN = WETH_ADDRESS; const INTERMEDIATE_TOKEN = USDC_ADDRESS;
        let poolA, feeA, poolB, feeB, loanPool;
        if (token0Address !== WETH_ADDRESS) { /* Handle */ return; }
        if (price_030 > price_005) { /* Assign */ } else if (price_005 > price_030) { /* Assign */ } else { return; }

        // 4. SIMULATE SWAPS
        const amountToBorrow = BORROW_AMOUNT_WETH;
        let simulatedIntermediateFromSwap1, simulatedFinalFromSwap2;
        try { /* ... Quoter calls ... */ } catch (quoteError) { /* Handle */ return; }

        // Calculate Potential Profit
        const loanPoolFeeTier = feeA; const flashLoanFee = /* ... */; const totalAmountToRepay = /* ... */;
        const potentialProfitWeth = simulatedFinalFromSwap2 - totalAmountToRepay;
        console.log(`   Sim Swap1: ... | Sim Swap2: ...`);
        console.log(`   Repay: ... | Pot. Profit: ${ethers.formatUnits(potentialProfitWeth, WETH_DECIMALS)}`);

        // --- 5. ESTIMATE GAS COST ---
        let estimatedGasUnits = 0n; let gasPrice = 0n; let estimatedGasCostWeth = 0n;
        const actualAmountOutMinimum1 = /* ... */; const actualAmountOutMinimum2 = /* ... */;
        const actualArbitrageParams = ethers.AbiCoder.defaultAbiCoder().encode( /* ... using actual mins ... */ );
        const estimationParams = ESTIMATE_GAS_WITH_ZERO_SLIPPAGE ? ethers.AbiCoder.defaultAbiCoder().encode( /* ... using zero mins ... */ ) : actualArbitrageParams;
        let amount0 = 0n; let amount1 = 0n;
        if (BORROW_TOKEN.toLowerCase() === token0Address.toLowerCase()) { amount0 = amountToBorrow; } else { return; }

        try {
            const feeData = await provider.getFeeData(); /* ... */ gasPrice = feeData.gasPrice; /* ... */
            console.log(`   Estimating gas using ${ESTIMATE_GAS_WITH_ZERO_SLIPPAGE ? 'minAmount=0' : 'actual minAmounts'}...`);
            estimatedGasUnits = await flashSwapContract.initiateFlashSwap.estimateGas( loanPool, amount0, amount1, estimationParams );
            const gasUnitsWithBuffer = /* ... */; estimatedGasCostWeth = /* ... */;
            console.log(`   Est. Gas: ... | Est. Cost: ${ethers.formatUnits(estimatedGasCostWeth, WETH_DECIMALS)} WETH`);
        } catch (gasEstimateError) { /* ... Handle error ... */ return; }

        // 6. Check Profitability
        const netProfitWeth = potentialProfitWeth - estimatedGasCostWeth;
        console.log(`   Net Profit (WETH, after estimated gas): ${ethers.formatUnits(netProfitWeth, WETH_DECIMALS)}`);

        if (netProfitWeth > MIN_PROFIT_THRESHOLD_WETH) {
            console.log(`✅ PROFITABLE OPPORTUNITY!`);
            console.log(`   Params: MinOut1=..., MinOut2=...`);
            // 7. Execute Transaction
            console.log(`   Executing initiateFlashSwap...`);
            try { /* ... Execute Tx using actualArbitrageParams ... */ }
            catch (executionError) { /* ... Handle execution error ... */ }
        } else { /* ... Log below threshold ... */ }

    } catch (error) {
        console.error(`❌ Error during arbitrage check cycle: ${error.message}`);
    }
}

// =========================================================================
// == Bot Execution ==
// =========================================================================
// --- RESTORE run() FUNCTION DEFINITION ---
async function run() {
    await initializeBot(); // Wait for initialization to complete
    if (isInitialized) {
        console.log(`Starting arbitrage check loop: Checking every ${CHECK_INTERVAL_MS / 1000} seconds.`);
        checkArbitrage(); // Run once immediately
        const intervalId = setInterval(checkArbitrage, CHECK_INTERVAL_MS);

        // Shutdown handlers
        process.on('SIGINT', () => { console.log("\n🛑 Shutting down..."); clearInterval(intervalId); process.exit(0); });
    } else {
         console.error("🚨 Bot initialization failed. Exiting.");
         process.exit(1);
    }
}
// --- END RESTORE ---

// --- Global Error Handlers ---
process.on('unhandledRejection', (reason, promise) => { console.error('🚨 Unhandled Rejection at:', promise, 'reason:', reason); });
process.on('uncaughtException', (error) => { console.error('🚨 Uncaught Exception:', error); process.exit(1); });

run(); // Start the bot by calling the run function
