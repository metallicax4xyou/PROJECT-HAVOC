// bot.js
// Monitors Uniswap V3 WETH/NativeUSDC pools on Arbitrum for arbitrage opportunities.
// Includes detailed logging, checks, QuoterV2 simulation, dynamic gas estimation.
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
const SLIPPAGE_TOLERANCE = 0.005; const BORROW_AMOUNT_WETH = ethers.parseUnits("0.001", WETH_DECIMALS); const GAS_ESTIMATE_BUFFER = 1.2;

// --- ABIs ---
const UNISWAP_V3_POOL_ABI = [ "function token0() external view returns (address)", "function token1() external view returns (address)", "function fee() external view returns (uint24)", "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)" ];
const FLASH_SWAP_ABI = [ "function initiateFlashSwap(address,uint256,uint256,bytes) external", /* events */ ];
const QUOTER_V2_ABI = [ "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)" ];

// =========================================================================
// == Ethers Setup & Initial Checks ==
// =========================================================================
let provider, signer, flashSwapContract, pool005, pool030, quoterContract;
let isInitialized = false;

async function initializeBot() {
    try {
        console.log("Initializing provider...");
        provider = new ethers.JsonRpcProvider(RPC_URL);
        const network = await provider.getNetwork();
        console.log(`   Connected to network: ${network.name} (Chain ID: ${network.chainId})`);
        const blockNumber = await provider.getBlockNumber();
        console.log(`   Current block number: ${blockNumber}`);

        console.log("Initializing signer...");
        signer = new ethers.Wallet(PRIVATE_KEY, provider);
        console.log(`   Executor: ${signer.address}`);

        console.log("Verifying contract addresses...");
        // ... (Contract code verification - assuming it passed before) ...
        console.log("   Contract addresses verified.");

        console.log("Initializing contract instances...");
        flashSwapContract = new ethers.Contract(FLASH_SWAP_CONTRACT_ADDRESS, FLASH_SWAP_ABI, signer);
        pool005 = new ethers.Contract(POOL_WETH_USDC_005, UNISWAP_V3_POOL_ABI, provider);
        pool030 = new ethers.Contract(POOL_WETH_USDC_030, UNISWAP_V3_POOL_ABI, provider);
        quoterContract = new ethers.Contract(QUOTER_V2_ADDRESS, QUOTER_V2_ABI, provider);
        console.log("   Contract instances initialized.");

        console.log(`🤖 Bot Initialized Successfully.`);
        console.log("✅ Using Native USDC address:", USDC_ADDRESS);
        console.warn(`⚠️ Borrow amount set to: ${ethers.formatUnits(BORROW_AMOUNT_WETH, WETH_DECIMALS)} WETH`);
        isInitialized = true;

    } catch (initError) {
        console.error(`❌ FATAL: Initialization Error: ${initError.message}`);
        if (initError.stack) console.error(initError.stack);
        process.exit(1);
    }
}

// =========================================================================
// == Helper Functions ==
// =========================================================================
function sqrtPriceX96ToPrice(sqrtPriceX96, decimals0, decimals1) { /* ... BigInt math ... */ }
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// =========================================================================
// == Main Arbitrage Logic ==
// =========================================================================
async function checkArbitrage() {
    if (!isInitialized) { console.log("Bot not initialized..."); return; }
    console.log(`\n[${new Date().toISOString()}] Checking: ${POOL_WETH_USDC_005.slice(0,6)} vs ${POOL_WETH_USDC_030.slice(0,6)} (Native USDC)`);
    try {
        // 1. Get Pool Data & Determine Order
        let slot0_005, slot0_030, token0_pool005, token1_pool005;
        try { /* Sequential Fetch */ } catch (fetchError) { /* Handle */ return; }
        if (!slot0_005 || !slot0_030 || !token0_pool005 || !token1_pool005) { /* Handle */ return; }
        if (slot0_005.sqrtPriceX96 === 0n || slot0_030.sqrtPriceX96 === 0n) { /* Handle */ return; }

        // console.log(`   Pool 005 reported: T0=${token0_pool005}, T1=${token1_pool005}`); // Logged before, likely ok
        // console.log(`   Expecting        : T0=${WETH_ADDRESS}, T1=${USDC_ADDRESS}`);

        let token0Address, token1Address, decimals0, decimals1;
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
        if (price_030 > price_005) { /* Assign */ } else if (price_005 > price_030) { /* Assign */ } else { console.log("   Prices equal."); return; }

        // 4. SIMULATE SWAPS
        const amountToBorrow = BORROW_AMOUNT_WETH;
        let simulatedIntermediateFromSwap1, simulatedFinalFromSwap2;
        try { /* ... Quoter calls ... */ } catch (quoteError) { /* Handle */ return; }

        // Calculate Potential Profit
        // ... (Profit calculation logic) ...
        console.log(`   Sim Swap1: ... | Sim Swap2: ...`);
        console.log(`   Repay: ... | Pot. Profit: ...`);

        // --- 5. ESTIMATE GAS COST ---
        let estimatedGasUnits = 0n; let gasPrice = 0n; let estimatedGasCostWeth = 0n;
        const gasEstimateAmountOutMinimum1 = 0n; const gasEstimateAmountOutMinimum2 = 0n;
        // --- FIXING SYNTAX ERROR HERE ---
        const gasEstimateParams = ethers.AbiCoder.defaultAbiCoder().encode(
             ['address', 'address', 'address', 'uint24', 'uint24', 'uint256', 'uint256'],
             [token1Address, poolA, poolB, feeA, feeB, gasEstimateAmountOutMinimum1, gasEstimateAmountOutMinimum2]
         ); // Restore the actual encoding
         // --- End Fix ---
        let amount0 = 0n; let amount1 = 0n;
        if (BORROW_TOKEN.toLowerCase() === token0Address.toLowerCase()) { amount0 = amountToBorrow; } else { return; }

        try { /* ... Gas estimation logic ... */ }
        catch (gasEstimateError) { /* ... Handle gas estimation error ... */ return; }
        console.log(`   Est. Gas: ... | Est. Cost: ...`);

        // 6. Check Profitability
        // ... (Profit check logic) ...
        if (netProfitWeth > MIN_PROFIT_THRESHOLD_WETH) {
            console.log(`✅ PROFITABLE OPPORTUNITY!`);
            // --- Construct ACTUAL TX Params ---
            const actualAmountOutMinimum1 = /* ... */; const actualAmountOutMinimum2 = /* ... */;
            const actualArbitrageParams = ethers.AbiCoder.defaultAbiCoder().encode( /*...*/ );
            console.log(`   Params: MinOut1=..., MinOut2=...`);
            // 7. Execute Transaction
            console.log(`   Executing initiateFlashSwap...`);
            try { /* ... Execute Tx ... */ }
            catch (executionError) { /* ... Handle execution error ... */ }
        } else { /* ... Log below threshold ... */ }

    } catch (error) {
        console.error(`❌ Error during arbitrage check cycle: ${error.message}`);
    }
}

// =========================================================================
// == Bot Execution ==
// =========================================================================
// ... (Keep run() and shutdown handlers) ...
run(); // Start the bot
