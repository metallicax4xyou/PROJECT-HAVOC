// bot.js - Arbitrum Uniswap V3 Flash Swap Bot with Debugging (v22.5 - Basic Profit Check)

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
const IUniswapV3PoolABI = [
    "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
    "function liquidity() external view returns (uint128)"
];
const IQuoterV2ABI = [ // Minimal ABI containing only quoteExactInputSingle
    {
        "inputs": [
            {
                "components": [
                    { "internalType": "address", "name": "tokenIn", "type": "address" },
                    { "internalType": "address", "name": "tokenOut", "type": "address" },
                    { "internalType": "uint256", "name": "amountIn", "type": "uint256" },
                    { "internalType": "uint24", "name": "fee", "type": "uint24" },
                    { "internalType": "uint160", "name": "sqrtPriceLimitX96", "type": "uint160" }
                ],
                "internalType": "struct IQuoterV2.QuoteExactInputSingleParams",
                "name": "params",
                "type": "tuple"
            }
        ],
        "name": "quoteExactInputSingle",
        "outputs": [
            { "internalType": "uint256", "name": "amountOut", "type": "uint256" },
            { "internalType": "uint160", "name": "sqrtPriceX96After", "type": "uint160" },
            { "internalType": "uint32", "name": "initializedTicksCrossed", "type": "uint32" },
            { "internalType": "uint256", "name": "gasEstimate", "type": "uint256" }
        ],
        "stateMutability": "nonpayable", // Needs to be nonpayable or nonpayable for estimateGas
        "type": "function"
    }
];

// --- Bot Settings ---
const POLLING_INTERVAL_MS = 10000;
// const PROFIT_THRESHOLD_USD = 0.05; // We'll use the WETH threshold now
let BORROW_AMOUNT_WETH_WEI = ethers.parseUnits("0.1", WETH_DECIMALS); // Increased to 0.1 WETH

// Threshold for potential gross profit (in WETH Wei) BEFORE fees/slippage.
// This is VERY ROUGH and needs TUNING based on typical gas/fees.
// Start with a small value, observe logs, and increase if too many unprofitable sims are attempted.
const MIN_POTENTIAL_GROSS_PROFIT_WETH_WEI = ethers.parseUnits("0.00005", WETH_DECIMALS); // Example: ~0.1 USD if WETH is $2000

// --- Helper Functions ---

async function fetchABIFromArbiscan(contractAddress) {
    console.log(`[ABI Fetch] Attempting to fetch ABI for ${contractAddress}...`);
    if (!ARBISCAN_API_KEY) {
        console.error("[ABI Fetch] ARBISCAN_API_KEY not found in .env file.");
        throw new Error("ARBISCAN_API_KEY not found in .env file.");
    }
    const url = `https://api.arbiscan.io/api?module=contract&action=getabi&address=${contractAddress}&apikey=${ARBISCAN_API_KEY}`;
    let responseDataResult = null; // Variable to store the result field

    try {
        const response = await axios.get(url);
        responseDataResult = response.data.result; // Store result before parsing

        if (response.data.status !== "1") {
            console.error(`[ABI Fetch] Arbiscan API Error for ${contractAddress}: Status=${response.data.status}, Message=${response.data.message}, Result=${response.data.result}`);
            throw new Error(`Arbiscan API Error: ${response.data.message} - ${response.data.result}`);
        }

        if (!responseDataResult || typeof responseDataResult !== 'string') {
             console.error(`[ABI Fetch] Arbiscan returned status 1 but result is not a string or is empty for ${contractAddress}. Result:`, responseDataResult);
             throw new Error(`Arbiscan returned status 1 but result is not a valid string for ${contractAddress}.`);
        }

        // Attempt to parse the ABI JSON string
        const parsedABI = JSON.parse(responseDataResult);
        console.log(`[ABI Fetch] Successfully fetched and parsed ABI for ${contractAddress}.`);
        return parsedABI; // Return the parsed ABI object/array

    } catch (err) {
        console.error(`[ABI Fetch] Failed to fetch or parse ABI for ${contractAddress}.`);
        // Log specific errors
        if (err instanceof SyntaxError) {
             console.error(`[ABI Fetch] JSON Parsing Error: ${err.message}`);
             console.error(`[ABI Fetch] Raw Result from Arbiscan that failed parsing: ${responseDataResult}`); // Log the raw string
        } else if (axios.isAxiosError(err)) {
             console.error(`[ABI Fetch] Axios Error: ${err.message}`);
             console.error(`[ABI Fetch] Axios Response Status: ${err.response?.status}`);
             console.error(`[ABI Fetch] Axios Response Data:`, err.response?.data);
        } else {
             console.error(`[ABI Fetch] Unknown Error during fetch/parse: ${err.message}`);
             if(err.stack) console.error(err.stack);
        }
        // Re-throw a consistent error message AFTER logging details
        throw new Error(`Failed to get valid ABI for ${contractAddress}. Check logs above for details.`);
    }
}

// Helper function for tick-to-price (rough estimation)
// Price of token0 (WETH) in terms of token1 (USDC)
function tickToPrice(tick, token0Decimals, token1Decimals) {
    // price = 1.0001 ^ tick * (10**(token0Decimals) / 10**(token1Decimals))
    // Using floating point math here - BEWARE of precision issues for real trading! Good enough for a basic filter.
    try {
        const priceRatio = Math.pow(1.0001, Number(tick)); // Ensure tick is a number
        const decimalAdjustment = Math.pow(10, token0Decimals - token1Decimals);
        return priceRatio * decimalAdjustment;
    } catch (e) {
        console.warn(`[Helper] Error calculating tickToPrice for tick ${tick}: ${e.message}`);
        return 0; // Return 0 on error
    }
}

// Simulates Quoter call via estimateGas (keep existing)
async function simulateSwap(poolDesc, tokenIn, tokenOut, amountInWei, feeBps, quoterContract) { /* ... (keep existing code) ... */ }


// --- Initialization State Variables ---
let provider, signer;
let contracts = {};
let config = {
    FLASH_SWAP_CONTRACT_ADDRESS, WETH_ADDRESS, USDC_ADDRESS, QUOTER_V2_ADDRESS,
    POOL_A_ADDRESS, POOL_B_ADDRESS, POOL_A_FEE_BPS, POOL_B_FEE_BPS, POOL_A_FEE_PERCENT, POOL_B_FEE_PERCENT,
    WETH_DECIMALS, USDC_DECIMALS, BORROW_AMOUNT_WETH_WEI, POLLING_INTERVAL_MS,
    RPC_URL, PRIVATE_KEY, ARBISCAN_API_KEY,
    // PROFIT_THRESHOLD_USD, // Removed, using WETH threshold
    MIN_POTENTIAL_GROSS_PROFIT_WETH_WEI // Added
};

// --- Arbitrage Attempt Function --- (Keep existing attemptArbitrage function)
async function attemptArbitrage(state) { /* ... (keep existing code ... */ }


// --- Main Monitoring Loop --- UPDATED with Profit Check ---
async function monitorPools(state) { // Accept state
    console.log(`\n[Monitor] START - ${new Date().toISOString()}`);

    const { poolAContract, poolBContract, quoterContract } = state.contracts;
    const { config } = state; // Destructure config from state

    if (!poolAContract || !poolBContract || !quoterContract) {
        console.error("[Monitor] Contract instances not available in state. Skipping cycle.");
        console.log(`[Monitor] END (Early exit due to uninitialized contracts) - ${new Date().toISOString()}`);
        return;
     }

    try {
        console.log("  [Monitor] Fetching pool states...");
        console.log(`  [Monitor] Calling Promise.allSettled for pool states... (A: ${config.POOL_A_ADDRESS}, B: ${config.POOL_B_ADDRESS})`);

        const results = await Promise.allSettled([
            poolAContract.slot0(),
            poolAContract.liquidity(),
            poolBContract.slot0(),
            poolBContract.liquidity()
        ]);
        console.log("  [Monitor] Promise.allSettled for pool states finished.");

        // ... (Keep existing result processing and logging logic for slotA, liqA, slotB, liqB) ...
        const slotAResult = results[0]; const liqAResult = results[1];
        const slotBResult = results[2]; const liqBResult = results[3];
        let slotA = null, liqA = null, slotB = null, liqB = null;
        let poolAStateFetched = false, poolBStateFetched = false;
        if (slotAResult.status === 'fulfilled') slotA = slotAResult.value; else console.error(/*...*/);
        if (liqAResult.status === 'fulfilled') liqA = liqAResult.value; else console.error(/*...*/);
        if (slotBResult.status === 'fulfilled') slotB = slotBResult.value; else console.error(/*...*/);
        if (liqBResult.status === 'fulfilled') liqB = liqBResult.value; else console.error(/*...*/);
        if (slotA && liqA !== null) { console.log(/*...*/); poolAStateFetched = true; } else console.log(/*...*/);
        if (slotB && liqB !== null) { console.log(/*...*/); poolBStateFetched = true; } else console.log(/*...*/);


        // --- EXIT IF STATES NOT FETCHED ---
        if (!poolAStateFetched || !poolBStateFetched) {
            console.log("  [Monitor] Could not fetch complete state for both pools. Skipping simulation cycle.");
            console.log("[Monitor] END (Early exit due to fetch failure)");
            return; // Exit the function
        }

        // --- *** START: NEW Profit Check Logic *** ---
        console.log("  [Monitor] Checking for arbitrage opportunity based on ticks...");

        const tickA = Number(slotA.tick);
        const tickB = Number(slotB.tick);
        const TICK_DIFF_THRESHOLD = 1; // Minimum tick difference to consider

        let potentialGrossProfitWei = ethers.toBigInt(0); // Use BigInt
        let startPoolId = null; // 'A' or 'B'
        let attemptSim = false; // Flag to proceed to attemptArbitrage

        // Calculate approximate prices (optional, mainly for logging/understanding)
        const priceA = tickToPrice(tickA, config.WETH_DECIMALS, config.USDC_DECIMALS);
        const priceB = tickToPrice(tickB, config.WETH_DECIMALS, config.USDC_DECIMALS);
        console.log(`  [Monitor] Approx Price A (WETH/USDC): ${priceA.toFixed(config.USDC_DECIMALS)}`);
        console.log(`  [Monitor] Approx Price B (WETH/USDC): ${priceB.toFixed(config.USDC_DECIMALS)}`);

        // If WETH is cheaper on Pool A (lower tick) and more expensive on Pool B (higher tick)
        // Opportunity: Borrow WETH from A, Sell on B, Buy back on A, Repay A
        if (tickB > tickA + TICK_DIFF_THRESHOLD && priceA > 0 && priceB > 0) { // Check price > 0
            console.log("  [Monitor] Potential Opportunity: WETH cheaper on Pool A (Tick B > Tick A). Start Pool A.");
            startPoolId = 'A';
            // Rough profit = (PriceB - PriceA) * AmountBorrowed (in WETH)
            // Calculate profit in USDC first for precision with USDC decimals
            try {
                const priceDiffUSDC_PerWETH = priceB - priceA;
                const priceDiffUSDC_Wei = ethers.parseUnits(priceDiffUSDC_PerWETH.toFixed(config.USDC_DECIMALS), config.USDC_DECIMALS);

                // Potential Gross Profit (USDC Wei) = priceDiffUSDC_Wei * BORROW_AMOUNT_WETH (adjusting for WETH decimals)
                const potentialGrossProfitUSDC_Wei = (priceDiffUSDC_Wei * config.BORROW_AMOUNT_WETH_WEI) / ethers.parseUnits("1", config.WETH_DECIMALS);

                // Convert rough USDC profit back to WETH using average price for threshold check
                const avgPrice = (priceA + priceB) / 2;
                const avgPrice_USDC_Wei = ethers.parseUnits(avgPrice.toFixed(config.USDC_DECIMALS), config.USDC_DECIMALS);

                if (avgPrice_USDC_Wei > 0n) {
                    potentialGrossProfitWei = (potentialGrossProfitUSDC_Wei * ethers.parseUnits("1", config.WETH_DECIMALS)) / avgPrice_USDC_Wei;
                }
            } catch (calcError) {
                console.warn(`  [Monitor] Warning during profit calculation (A->B): ${calcError.message}`);
                potentialGrossProfitWei = ethers.toBigInt(0);
            }
        }
        // If WETH is cheaper on Pool B (lower tick) and more expensive on Pool A (higher tick)
        // Opportunity: Borrow WETH from B, Sell on A, Buy back on B, Repay B
        else if (tickA > tickB + TICK_DIFF_THRESHOLD && priceA > 0 && priceB > 0) { // Check price > 0
            console.log("  [Monitor] Potential Opportunity: WETH cheaper on Pool B (Tick A > Tick B). Start Pool B.");
            startPoolId = 'B';
            // Rough profit = (PriceA - PriceB) * AmountBorrowed (in WETH)
             try {
                const priceDiffUSDC_PerWETH = priceA - priceB;
                const priceDiffUSDC_Wei = ethers.parseUnits(priceDiffUSDC_PerWETH.toFixed(config.USDC_DECIMALS), config.USDC_DECIMALS);

                const potentialGrossProfitUSDC_Wei = (priceDiffUSDC_Wei * config.BORROW_AMOUNT_WETH_WEI) / ethers.parseUnits("1", config.WETH_DECIMALS);

                const avgPrice = (priceA + priceB) / 2;
                 const avgPrice_USDC_Wei = ethers.parseUnits(avgPrice.toFixed(config.USDC_DECIMALS), config.USDC_DECIMALS);

                if (avgPrice_USDC_Wei > 0n) {
                    potentialGrossProfitWei = (potentialGrossProfitUSDC_Wei * ethers.parseUnits("1", config.WETH_DECIMALS)) / avgPrice_USDC_Wei;
                }
             } catch (calcError) {
                console.warn(`  [Monitor] Warning during profit calculation (B->A): ${calcError.message}`);
                potentialGrossProfitWei = ethers.toBigInt(0);
             }
        } else {
            console.log(`  [Monitor] No significant price difference detected (Ticks: A=${tickA}, B=${tickB}).`);
        }

        // Check if potential profit exceeds threshold
        if (startPoolId) { // Only proceed if a potential direction was found
            console.log(`  [Monitor] Potential Gross Profit (WETH Wei, pre-fees): ${potentialGrossProfitWei.toString()}`);
            console.log(`  [Monitor] Profit Threshold (WETH Wei):                 ${config.MIN_POTENTIAL_GROSS_PROFIT_WETH_WEI.toString()}`);

            if (potentialGrossProfitWei > config.MIN_POTENTIAL_GROSS_PROFIT_WETH_WEI) {
                console.log("  [Monitor] ✅ Potential profit exceeds threshold. Proceeding to attemptArbitrage simulation.");
                attemptSim = true;
            } else {
                console.log("  [Monitor] ❌ Potential profit below threshold or zero. Skipping simulation.");
                attemptSim = false;
            }
        } else {
             attemptSim = false; // Ensure flag is false if no startPoolId was set
        }

        // --- Call attemptArbitrage IF the basic check passed ---
        if (attemptSim && startPoolId) {
            // We still need Quoter simulations (optional but good practice)
            // You can keep the simulateSwap logic here or remove it if the basic check is deemed sufficient filter
            console.log(`  [Monitor] Performing final Quoter check before attemptArbitrage...`);
            const simulateAmountWeth = ethers.parseUnits("0.001", config.WETH_DECIMALS); // Small amount for sim
            const [simASuccess, simBSuccess] = await Promise.all([
                 simulateSwap("Pool A", config.WETH_ADDRESS, config.USDC_ADDRESS, simulateAmountWeth, config.POOL_A_FEE_BPS, quoterContract),
                 simulateSwap("Pool B", config.WETH_ADDRESS, config.USDC_ADDRESS, simulateAmountWeth, config.POOL_B_FEE_BPS, quoterContract)
            ]);
            console.log(`  [Monitor] Quoter simulations results. Sim A Success: ${simASuccess}, Sim B Success: ${simBSuccess}`);

            if (simASuccess && simBSuccess) {
                 console.log("  [Monitor] Both Quoter simulations succeeded. Triggering attemptArbitrage.");
                // Construct the opportunity object for attemptArbitrage
                state.opportunity = {
                    startPool: startPoolId, // 'A' or 'B'
                    borrowTokenSymbol: "WETH", // Still assuming WETH borrow
                    // We don't have a real profit estimate here, attemptArbitrage will find out
                };
                await attemptArbitrage(state); // Call the main simulation function
            } else {
                 console.log("  [Monitor] Quoter simulation failed post-profit check. Skipping arbitrage attempt.");
            }
        } else {
             // Logged reason above (no difference or below threshold)
             console.log("  [Monitor] Conditions not met to attempt arbitrage simulation.");
        }
        // --- *** END: NEW Profit Check Logic *** ---


    } catch (error) {
        console.error(`[Monitor] Error in monitoring loop:`, error);
    } finally {
        console.log(`[Monitor] END - ${new Date().toISOString()}`);
    }
} // <<< Closing brace for monitorPools function


// --- Start the Bot --- (Keep existing IIFE startup logic)
(async () => {
    console.log("\n>>> Entering startup async IIFE...");
    try {
        // --- Setup Provider & Signer ---
        // ... (existing code) ...
        provider = new ethers.JsonRpcProvider(config.RPC_URL);
        signer = new ethers.Wallet(config.PRIVATE_KEY, provider);
        console.log(`[Init] Signer Address: ${signer.address}`);


        // --- Fetch FlashSwap ABI Dynamically ---
        let flashSwapABI_dynamic; // Declare variable
        try {
             flashSwapABI_dynamic = await fetchABIFromArbiscan(config.FLASH_SWAP_CONTRACT_ADDRESS);
             // *** ADDED CHECK ***
             if (!flashSwapABI_dynamic || !Array.isArray(flashSwapABI_dynamic)) {
                 console.error(`[Init] Fetched ABI for ${config.FLASH_SWAP_CONTRACT_ADDRESS} is invalid or not an array. ABI:`, flashSwapABI_dynamic);
                 throw new Error(`Invalid ABI received for FlashSwap contract.`);
             }
             console.log(`[Init] Dynamic ABI for FlashSwap contract seems valid.`);
        } catch (abiError) {
             console.error(`[Init] CRITICAL: Could not fetch or validate FlashSwap ABI. Error: ${abiError.message}`);
             throw abiError; // Re-throw to stop initialization
        }


        // --- Instantiate Contracts ---
        console.log("[Init] Instantiating Contracts...");
        // Now we are more confident flashSwapABI_dynamic is valid here
        contracts.flashSwapContract = new ethers.Contract(config.FLASH_SWAP_CONTRACT_ADDRESS, flashSwapABI_dynamic, signer);
        contracts.quoterContract = new ethers.Contract(config.QUOTER_V2_ADDRESS, IQuoterV2ABI, provider);
        contracts.poolAContract = new ethers.Contract(config.POOL_A_ADDRESS, IUniswapV3PoolABI, provider);
        contracts.poolBContract = new ethers.Contract(config.POOL_B_ADDRESS, IUniswapV3PoolABI, provider);
        console.log("[Init] All Contract instances created successfully.");

        // --- Create the state object ---
        // ... (rest of the IIFE as before) ...
        const state = { provider, signer, contracts, config };

        // --- Initial Logs ---
        // ... (existing code) ...

        // --- Startup Checks ---
        // ... (existing code) ...
        console.log(">>> Checking signer balance...");
        const balance = await provider.getBalance(signer.address); // Line ~289
        console.log(`>>> Signer balance: ${ethers.formatEther(balance)} ETH`);
        // ... (rest of startup checks and monitoring start) ...

    } catch (initError) {
        console.error("\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        console.error("Initialization Error / Startup Error:");
        // Error should be more specific now if it came from ABI fetch/validation
        console.error(initError.stack || initError);
        console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        process.exit(1);
    }
})();
