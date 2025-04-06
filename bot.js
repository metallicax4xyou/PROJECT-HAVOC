// bot.js
// Monitors Uniswap V3 WETH/NativeUSDC pools on Arbitrum for arbitrage opportunities.
// Includes detailed logging, checks, QuoterV2 simulation, dynamic gas estimation.
// WARNING: Experimental. Review thresholds, slippage, and execution logic carefully.

require("dotenv").config();
const { ethers } = require("ethers");

// =========================================================================
// == Configuration & Constants ==
// =========================================================================
const RPC_URL = process.env.ARBITRUM_RPC_URL; // Ensure this points to your primary (e.g., Alchemy) endpoint
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

// --- ABIs (Minimal for initial checks, expanded where needed later) ---
const UNISWAP_V3_POOL_ABI = [ "function token0() external view returns (address)", "function token1() external view returns (address)", "function fee() external view returns (uint24)", "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)" ];
const FLASH_SWAP_ABI = [ "function initiateFlashSwap(address,uint256,uint256,bytes) external", /* events */ ];
const QUOTER_V2_ABI = [ "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)" ];

// =========================================================================
// == Ethers Setup & Initial Checks ==
// =========================================================================
let provider, signer, flashSwapContract, pool005, pool030, quoterContract;
let isInitialized = false; // Flag to track successful initialization

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
        const [codeFlash, codePool005, codePool030, codeQuoter] = await Promise.all([
            provider.getCode(FLASH_SWAP_CONTRACT_ADDRESS),
            provider.getCode(POOL_WETH_USDC_005),
            provider.getCode(POOL_WETH_USDC_030),
            provider.getCode(QUOTER_V2_ADDRESS),
        ]);

        if (codeFlash === "0x") throw new Error(`FlashSwap contract not deployed at ${FLASH_SWAP_CONTRACT_ADDRESS}`);
        if (codePool005 === "0x") throw new Error(`Pool005 address ${POOL_WETH_USDC_005} is not a contract.`);
        if (codePool030 === "0x") throw new Error(`Pool030 address ${POOL_WETH_USDC_030} is not a contract.`);
        if (codeQuoter === "0x") throw new Error(`Quoter address ${QUOTER_V2_ADDRESS} is not a contract.`);
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
        isInitialized = true; // Mark as initialized

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
    if (!isInitialized) {
        console.log("Bot not initialized, skipping check.");
        return;
    }
    console.log(`\n[${new Date().toISOString()}] Checking: ${POOL_WETH_USDC_005.slice(0,6)} vs ${POOL_WETH_USDC_030.slice(0,6)} (Native USDC)`);
    try {
        // 1. Get Pool Data & Determine Order
        let slot0_005, slot0_030, token0_pool005, token1_pool005;
        try {
             // console.log("   Fetching pool data sequentially..."); // Keep commented unless debugging fetch timing
             slot0_005 = await pool005.slot0(); await delay(50);
             slot0_030 = await pool030.slot0(); await delay(50);
             token0_pool005 = await pool005.token0(); await delay(50);
             token1_pool005 = await pool005.token1();
             // console.log("   ...Fetch complete.");
        } catch (fetchError) {
            // --- ADDED DETAILED FETCH ERROR LOGGING ---
            console.error(`   ❌ Fetch Error during sequential fetch: ${fetchError.message}`);
            if (fetchError.stack) console.error("      ", fetchError.stack.split('\n').slice(1, 3).join('\n       ')); // Log first lines of stack
            return; // Stop this cycle if any fetch fails
        }

        // Validity Checks
        // console.log("   Checking fetched data validity..."); // Reduce noise
        if (!slot0_005 || !slot0_030 || !token0_pool005 || !token1_pool005) { console.error(`   ❌ Incomplete data after fetch.`); return; }
        // console.log(`   Raw sqrtPriceX96_005: ${slot0_005.sqrtPriceX96?.toString()}`);
        // console.log(`   Raw sqrtPriceX96_030: ${slot0_030.sqrtPriceX96?.toString()}`);
        if (slot0_005.sqrtPriceX96 === 0n || slot0_030.sqrtPriceX96 === 0n) { console.error(`   ❌ sqrtPriceX96 is zero.`); return; }
        // console.log("   Fetched data looks valid."); // Reduce noise

        // Determine Token Order
        // console.log("   Determining token order..."); // Reduce noise
        // console.log(`   Pool 005 reported: T0=${token0_pool005}, T1=${token1_pool005}`); // Keep commented unless debugging order
        // console.log(`   Expecting        : T0=${WETH_ADDRESS}, T1=${USDC_ADDRESS}`);
        let token0Address, token1Address, decimals0, decimals1;
        // ... (Token order logic - WETH=T0, Native USDC=T1 assumption) ...
        token0Address = WETH_ADDRESS; decimals0 = WETH_DECIMALS; token1Address = USDC_ADDRESS; decimals1 = USDC_DECIMALS;
        if (token0_pool005.toLowerCase() !== token0Address.toLowerCase() || token1_pool005.toLowerCase() !== token1Address.toLowerCase()) {
            console.error(`❌ Pool T0/T1 mismatch.`); return;
        }
        // console.log("   Token order determined."); // Reduce noise

        // 2. Calculate Prices
        // console.log("   Calculating prices..."); // Reduce noise
        const price_005 = sqrtPriceX96ToPrice(slot0_005.sqrtPriceX96, decimals0, decimals1);
        const price_030 = sqrtPriceX96ToPrice(slot0_030.sqrtPriceX96, decimals0, decimals1);
        if (isNaN(price_005) || isNaN(price_030)) { console.error(`   ❌ Price calc NaN.`); return; }
        console.log(`   P_0.05: ${price_005.toFixed(decimals1)} | P_0.30: ${price_030.toFixed(decimals1)} (T1/T0)`);
        const priceDiffPercent = Math.abs(price_005 - price_030) / Math.min(price_005, price_030) * 100;

        // 3. Identify Direction
        // console.log("   Identifying direction..."); // Reduce noise
        const BORROW_TOKEN = WETH_ADDRESS; const INTERMEDIATE_TOKEN = USDC_ADDRESS;
        let poolA, feeA, poolB, feeB, loanPool;
        // ... (Direction logic) ...
        if (price_030 > price_005) { /* Assign */ } else if (price_005 > price_030) { /* Assign */ }
        else { console.log("   Prices equal or too close."); return; } // Log price equality
        // console.log(`   Selected Path: PoolA=${poolA.slice(0,6)}, PoolB=${poolB.slice(0,6)}`); // Reduce noise

        // 4. SIMULATE SWAPS
        // console.log("   Simulating swaps..."); // Reduce noise
        const amountToBorrow = BORROW_AMOUNT_WETH;
        let simulatedIntermediateFromSwap1, simulatedFinalFromSwap2;
        try { /* ... Quoter calls ... */ }
        catch (quoteError) { console.error(`   ❌ Quote Error: ${quoteError.message}`); return; }

        // Calculate Potential Profit
        // ... (Profit calculation logic) ...
        console.log(`   Sim Swap1: ... | Sim Swap2: ...`);
        console.log(`   Repay: ... | Pot. Profit: ...`);

        // --- 5. ESTIMATE GAS COST ---
        // console.log("   Estimating gas..."); // Reduce noise
        let estimatedGasUnits = 0n; let gasPrice = 0n; let estimatedGasCostWeth = 0n;
        const gasEstimateAmountOutMinimum1 = 0n; const gasEstimateAmountOutMinimum2 = 0n;
        const gasEstimateParams = /*...*/; let amount0 = 0n; let amount1 = 0n;
        if (BORROW_TOKEN.toLowerCase() === token0Address.toLowerCase()) { amount0 = amountToBorrow; } else { return; }

        try { /* ... Gas estimation logic ... */ }
        catch (gasEstimateError) { console.error(`   ❌ Gas Estimation Failed: ${gasEstimateError.message}`); /* Decode? */ return; }
        console.log(`   Est. Gas: ... | Est. Cost: ...`);

        // 6. Check Profitability
        const netProfitWeth = potentialProfitWeth - estimatedGasCostWeth;
        console.log(`   Net Profit (WETH, after estimated gas): ${ethers.formatUnits(netProfitWeth, WETH_DECIMALS)}`);

        if (netProfitWeth > MIN_PROFIT_THRESHOLD_WETH) {
            console.log(`✅ PROFITABLE OPPORTUNITY!`);
            // --- Construct ACTUAL TX Params ---
            const actualAmountOutMinimum1 = /*...*/; const actualAmountOutMinimum2 = /*...*/;
            const actualArbitrageParams = /*...*/;
            console.log(`   Params: MinOut1=..., MinOut2=...`);
            // 7. Execute Transaction
            console.log(`   Executing initiateFlashSwap...`);
            try { /* ... Execute Tx ... */ }
            catch (executionError) { /* ... Handle execution error ... */ }
        } else {
             if (priceDiffPercent > 0.01) { console.log(`   Opportunity found but below profit threshold.`); }
        }
    } catch (error) {
        console.error(`❌ Error during arbitrage check cycle: ${error.message}`);
        if (error.stack) console.error("   ", error.stack.split('\n').slice(1, 3).join('\n    '));
    }
}

// =========================================================================
// == Bot Execution ==
// =========================================================================
async function run() {
    // Initialize first, then start interval
    await initializeBot();
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

// --- Global Error Handlers ---
process.on('unhandledRejection', (reason, promise) => { console.error('🚨 Unhandled Rejection at:', promise, 'reason:', reason); });
process.on('uncaughtException', (error) => { console.error('🚨 Uncaught Exception:', error); process.exit(1); }); // Exit on uncaught exceptions

run(); // Start the bot
