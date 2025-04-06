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
// --- Suggestion #1: Config flag for gas estimation ---
const ESTIMATE_GAS_WITH_ZERO_SLIPPAGE = false; // Set to true to use amountOutMin=0 for estimation (for debugging reverts)

// --- ABIs ---
const UNISWAP_V3_POOL_ABI = [ /* Pool ABI */ ]; const FLASH_SWAP_ABI = [ /* FlashSwap ABI */ ]; const QUOTER_V2_ABI = [ /* Quoter ABI */ ];

// =========================================================================
// == Ethers Setup & Initial Checks ==
// =========================================================================
let provider, signer, flashSwapContract, pool005, pool030, quoterContract; let isInitialized = false;
async function initializeBot() { /* ... Keep initialization logic ... */ }

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
        if (!slot0_005 || !slot0_030 || !token0_pool005 || !token1_pool005) { /* Handle */ return; }
        if (slot0_005.sqrtPriceX96 === 0n || slot0_030.sqrtPriceX96 === 0n) { /* Handle */ return; }
        let token0Address, token1Address, decimals0, decimals1;
        // ... (Token order logic WETH=T0, Native USDC=T1) ...
        token0Address = WETH_ADDRESS; decimals0 = WETH_DECIMALS; token1Address = USDC_ADDRESS; decimals1 = USDC_DECIMALS;
        if (token0_pool005.toLowerCase() !== token0Address.toLowerCase() || token1_pool005.toLowerCase() !== token1Address.toLowerCase()) { /* Handle */ return; }

        // 2. Calculate Prices
        const price_005 = sqrtPriceX96ToPrice(slot0_005.sqrtPriceX96, decimals0, decimals1);
        const price_030 = sqrtPriceX96ToPrice(slot0_030.sqrtPriceX96, decimals0, decimals1);
        if (isNaN(price_005) || isNaN(price_030)) { /* Handle */ return; }
        console.log(`   P_0.05: ${price_005.toFixed(decimals1)} | P_0.30: ${price_030.toFixed(decimals1)} (T1/T0)`);
        const priceDiffPercent = Math.abs(price_005 - price_030) / Math.min(price_005, price_030) * 100;

        // 3. Identify Direction
        const BORROW_TOKEN = WETH_ADDRESS; const INTERMEDIATE_TOKEN = USDC_ADDRESS;
        let poolA, feeA, poolB, feeB, loanPool;
        if (token0Address !== WETH_ADDRESS) { /* Handle */ return; }
        if (price_030 > price_005) { poolA = POOL_WETH_USDC_030; feeA = 3000; poolB = POOL_WETH_USDC_005; feeB = 500; loanPool = poolA; }
        else if (price_005 > price_030) { poolA = POOL_WETH_USDC_005; feeA = 500; poolB = POOL_WETH_USDC_030; feeB = 3000; loanPool = poolA; }
        else { return; } // Prices equal

        // 4. SIMULATE SWAPS
        const amountToBorrow = BORROW_AMOUNT_WETH;
        let simulatedIntermediateFromSwap1, simulatedFinalFromSwap2;
        try { /* ... Quoter calls ... */ } catch (quoteError) { /* Handle */ return; }

        // Calculate Potential Profit
        // --- Suggestion #2: Fee Source Clarification ---
        const loanPoolFeeTier = feeA; // Assuming loanPool is always poolA, fee is feeA
        const flashLoanFee = (amountToBorrow * BigInt(loanPoolFeeTier)) / 1000000n;
        const totalAmountToRepay = amountToBorrow + flashLoanFee;
        const potentialProfitWeth = simulatedFinalFromSwap2 - totalAmountToRepay;
        console.log(`   Sim Swap1: ... | Sim Swap2: ...`);
        // --- Suggestion #3: Higher Precision Logging ---
        console.log(`   Repay: ${ethers.formatUnits(totalAmountToRepay, decimals0)} WETH | Pot. Profit: ${ethers.formatUnits(potentialProfitWeth, decimals0)} WETH`);


        // --- 5. ESTIMATE GAS COST ---
        let estimatedGasUnits = 0n; let gasPrice = 0n; let estimatedGasCostWeth = 0n;
        // --- Construct ACTUAL TX Params first (used for both estimate and execution) ---
        const actualAmountOutMinimum1 = simulatedIntermediateFromSwap1 * BigInt(Math.floor((1 - SLIPPAGE_TOLERANCE) * 10000)) / 10000n;
        const requiredRepaymentThreshold = totalAmountToRepay + MIN_PROFIT_THRESHOLD_WETH;
        const actualAmountOutMinimum2 = requiredRepaymentThreshold;
        const actualArbitrageParams = ethers.AbiCoder.defaultAbiCoder().encode( /* ... using actual mins ... */ );

        // --- Choose params for gas estimation based on flag (Suggestion #1) ---
        const estimationParams = ESTIMATE_GAS_WITH_ZERO_SLIPPAGE
            ? ethers.AbiCoder.defaultAbiCoder().encode(
                  ['address', 'address', 'address', 'uint24', 'uint24', 'uint256', 'uint256'],
                  [token1Address, poolA, poolB, feeA, feeB, 0n, 0n] // Use minAmount = 0 for estimation
              )
            : actualArbitrageParams; // Use actual params for estimation by default

        let amount0 = 0n; let amount1 = 0n;
        if (BORROW_TOKEN.toLowerCase() === token0Address.toLowerCase()) { amount0 = amountToBorrow; } else { return; }

        try {
            const feeData = await provider.getFeeData();
            gasPrice = feeData.gasPrice;
            if (!gasPrice || gasPrice === 0n) { gasPrice = ethers.parseUnits("0.1", "gwei"); }

            console.log(`   Estimating gas using ${ESTIMATE_GAS_WITH_ZERO_SLIPPAGE ? 'minAmount=0' : 'actual minAmounts'}...`);
            estimatedGasUnits = await flashSwapContract.initiateFlashSwap.estimateGas(
                loanPool, amount0, amount1, estimationParams // Use chosen params
            );

            const gasUnitsWithBuffer = estimatedGasUnits * BigInt(Math.round(GAS_ESTIMATE_BUFFER * 100)) / 100n;
            estimatedGasCostWeth = gasUnitsWithBuffer * gasPrice;
            console.log(`   Est. Gas: ${estimatedGasUnits} units | Price: ${ethers.formatUnits(gasPrice, "gwei")} Gwei | Est. Cost: ${ethers.formatUnits(estimatedGasCostWeth, WETH_DECIMALS)} WETH`);

        } catch (gasEstimateError) { /* ... Handle error ... */ return; }

        // 6. Check Profitability
        const netProfitWeth = potentialProfitWeth - estimatedGasCostWeth;
        // --- Suggestion #3: Higher Precision Logging ---
        console.log(`   Net Profit (WETH, after estimated gas): ${ethers.formatUnits(netProfitWeth, WETH_DECIMALS)}`);

        if (netProfitWeth > MIN_PROFIT_THRESHOLD_WETH) {
            console.log(`✅ PROFITABLE OPPORTUNITY! Est. Net Profit: ${ethers.formatUnits(netProfitWeth, WETH_DECIMALS)} WETH`);
            console.log(`   Params: MinOut1=${ethers.formatUnits(actualAmountOutMinimum1, decimals1)}, MinOut2=${ethers.formatUnits(actualAmountOutMinimum2, decimals0)}`);
            // 7. Execute Transaction
            console.log(`   Executing initiateFlashSwap...`);
            try {
                const gasLimitWithBuffer = estimatedGasUnits * BigInt(/*...*/);
                const tx = await flashSwapContract.initiateFlashSwap(
                    loanPool, amount0, amount1, actualArbitrageParams, // Always use actual params for TX
                    { gasLimit: gasLimitWithBuffer, gasPrice: gasPrice }
                );
                /* ... Tx logging ... */
            } catch (executionError) { /* ... Handle execution error ... */ }
        } else {
             if (priceDiffPercent > 0.01) {
                  // --- Suggestion #3: Higher Precision Logging ---
                  console.log(`   Opportunity found but below profit threshold. Est. Net: ${ethers.formatUnits(netProfitWeth, WETH_DECIMALS)} WETH`);
             }
        }
    } catch (error) {
        console.error(`❌ Error during arbitrage check cycle: ${error.message}`);
    }
}

// =========================================================================
// == Bot Execution ==
// =========================================================================
// ... (Keep run() and shutdown handlers) ...
run(); // Start the bot
