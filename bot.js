// bot.js - Arbitrum Uniswap V3 Flash Swap Bot with Debugging (v5 - Added Tick/Liquidity Logging)

const { ethers } = require("ethers");
require('dotenv').config(); // Make sure to install dotenv: npm install dotenv

// --- Configuration ---
const RPC_URL = process.env.ARBITRUM_RPC_URL; // Your Arbitrum RPC URL (e.g., from Alchemy, Infura)
const PRIVATE_KEY = process.env.PRIVATE_KEY;   // Your deployer/owner private key
const FLASH_SWAP_CONTRACT_ADDRESS = "0x7a00Ec5b64e662425Bbaa0dD78972570C326210f"; // Your deployed FlashSwap contract

// Arbitrum Native USDC / WETH Pools & Tokens
const WETH_ADDRESS = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const USDC_ADDRESS = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"; // Native USDC
const WETH_DECIMALS = 18;
const USDC_DECIMALS = 6;

// Pool Configuration (WETH/USDC - Replace with your actual target pools)
// Pool A: WETH/USDC 0.05% (Example address - VERIFY YOURS)
const POOL_A_ADDRESS = "0xC696D20fd7ac47C89Ea8b8C51065A67B6FFa2067"; // VERIFY THIS - WETH/USDC 0.05%
const POOL_A_FEE_BPS = 500; // 0.05% in basis points
const POOL_A_FEE_PERCENT = 0.05;

// Pool B: WETH/USDC 0.30% (Example address - VERIFY YOURS)
const POOL_B_ADDRESS = "0xc31E54c7a869B9FcBEcc14363CF510d1c41fa441"; // VERIFY THIS - WETH/USDC 0.30%
const POOL_B_FEE_BPS = 3000; // 0.30% in basis points
const POOL_B_FEE_PERCENT = 0.30;

// Uniswap V3 Quoter V2 Address on Arbitrum
const QUOTER_V2_ADDRESS = "0x61fFE014bA17989E743c5F6d790181C0603C3996"; // Common Arbitrum QuoterV2 address

// --- ABIs ---
const FlashSwapABI = [ /* ... ABI ... */ ]; // Keep your existing ABI here
const IUniswapV3PoolABI = [
    "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
    "function liquidity() external view returns (uint128 liquidity)",
    "function token0() external view returns (address)",
    "function token1() external view returns (address)",
    "function fee() external view returns (uint24)"
];
const IQuoterV2ABI = [ /* ... ABI ... */ ]; // Keep your existing ABI here

// --- Bot Settings ---
const POLLING_INTERVAL_MS = 10000; // Check prices every 10 seconds
const PROFIT_THRESHOLD_USD = 0.05; // Very low for debugging
let BORROW_AMOUNT_WETH_WEI = ethers.parseUnits("0.00005", WETH_DECIMALS); // DEBUG amount

// --- Initialization ---
if (!RPC_URL || !PRIVATE_KEY) {
    console.error("Error: ARBITRUM_RPC_URL and PRIVATE_KEY must be set in .env file.");
    process.exit(1);
}
const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);
const flashSwapContract = new ethers.Contract(FLASH_SWAP_CONTRACT_ADDRESS, FlashSwapABI, signer);
const quoterContract = new ethers.Contract(QUOTER_V2_ADDRESS, IQuoterV2ABI, provider);
const poolAContract = new ethers.Contract(POOL_A_ADDRESS, IUniswapV3PoolABI, provider);
const poolBContract = new ethers.Contract(POOL_B_ADDRESS, IUniswapV3PoolABI, provider);

// (Keep existing console.log startup messages)
console.log(`Bot starting...`);
// ... other startup logs ...

// --- Helper Functions ---
// (Keep existing calculatePriceFromSqrt)

// Simulate swap using QuoterV2 - with error logging enabled
async function simulateSwap(poolDesc, tokenIn, tokenOut, amountInWei, feeBps, quoter) { // Added poolDesc for logging
    try {
        const params = {
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountInWei,
            fee: feeBps,
            sqrtPriceLimitX96: 0n
        };
        const quoteResult = await quoter.quoteExactInputSingle.staticCall(params);
        return quoteResult[0];
    } catch (error) {
        // Log the reason for quote failure
        console.warn(`Quoter simulation failed for ${poolDesc} (Fee: ${feeBps}bps): ${error.reason || error.message || error}`);
        return 0n;
    }
}

// (Keep existing attemptArbitrage function - no changes needed there for now)
async function attemptArbitrage(opportunity) {
    // ... function body remains the same ...
    console.log("\n========= Arbitrage Opportunity Detected =========");
    // ... all the logic inside attemptArbitrage ...
    console.log("========= Arbitrage Attempt Complete =========");
}


// --- Main Monitoring Loop ---
async function monitorPools() {
    console.log(`\n${new Date().toISOString()} - Checking for opportunities...`);

    try {
        // --- ADDED: Pool State Logging ---
        console.log("  Fetching pool states...");
        const [slotA, liqA, slotB, liqB] = await Promise.all([
            poolAContract.slot0().catch(e => { console.error(`Error fetching slot0 for Pool A: ${e.message}`); return null; }),
            poolAContract.liquidity().catch(e => { console.error(`Error fetching liquidity for Pool A: ${e.message}`); return null; }),
            poolBContract.slot0().catch(e => { console.error(`Error fetching slot0 for Pool B: ${e.message}`); return null; }),
            poolBContract.liquidity().catch(e => { console.error(`Error fetching liquidity for Pool B: ${e.message}`); return null; })
        ]);

        if (slotA && liqA !== null) {
             console.log(`  Pool A (${POOL_A_ADDRESS} - ${POOL_A_FEE_BPS}bps): Tick=${slotA.tick}, Liquidity=${liqA.toString()}`);
             if (liqA === 0n) console.warn("    WARNING: Pool A has ZERO active liquidity!");
        } else {
             console.log(`  Pool A (${POOL_A_ADDRESS} - ${POOL_A_FEE_BPS}bps): Failed to fetch state.`);
        }
        if (slotB && liqB !== null) {
             console.log(`  Pool B (${POOL_B_ADDRESS} - ${POOL_B_FEE_BPS}bps): Tick=${slotB.tick}, Liquidity=${liqB.toString()}`);
              if (liqB === 0n) console.warn("    WARNING: Pool B has ZERO active liquidity!");
        } else {
              console.log(`  Pool B (${POOL_B_ADDRESS} - ${POOL_B_FEE_BPS}bps): Failed to fetch state.`);
        }
        // --- End Added Pool State Logging ---

        const simulateAmountWeth = ethers.parseUnits("0.1", WETH_DECIMALS);

        console.log("  Simulating swaps with QuoterV2...");
        const [amountOutA, amountOutB] = await Promise.all([
            // Pass description for better logging in simulateSwap
            simulateSwap("Pool A", WETH_ADDRESS, USDC_ADDRESS, simulateAmountWeth, POOL_A_FEE_BPS, quoterContract),
            simulateSwap("Pool B", WETH_ADDRESS, USDC_ADDRESS, simulateAmountWeth, POOL_B_FEE_BPS, quoterContract)
        ]);

        // Check if quotes failed (simulateSwap returns 0n on failure)
        if (amountOutA === 0n || amountOutB === 0n) {
             console.log("  Failed to get valid quotes for one or both pools (see warnings above). Skipping cycle.");
             return;
        }

        // --- Rest of the loop logic remains the same ---
        const priceA = parseFloat(ethers.formatUnits(amountOutA, USDC_DECIMALS)) / 0.1;
        const priceB = parseFloat(ethers.formatUnits(amountOutB, USDC_DECIMALS)) / 0.1;

        console.log(`  Pool A Price (USDC/WETH): ${priceA.toFixed(6)}`);
        console.log(`  Pool B Price (USDC/WETH): ${priceB.toFixed(6)}`);

        let opportunity = null;
        let estimatedProfitUsd = 0;

        if (Math.abs(priceA - priceB) / Math.max(priceA, priceB) > 0.0001) {
            // ... (opportunity detection logic remains the same) ...
             if (priceA > priceB) {
                 estimatedProfitUsd = (priceA - priceB) * parseFloat(ethers.formatUnits(BORROW_AMOUNT_WETH_WEI, WETH_DECIMALS));
                 opportunity = { /* ... */ }; // Fill opportunity struct
                 console.log(`  Potential Opportunity: Sell WETH on A ($${priceA.toFixed(4)}), Buy on B ($${priceB.toFixed(4)})`);
             } else {
                 estimatedProfitUsd = (priceB - priceA) * parseFloat(ethers.formatUnits(BORROW_AMOUNT_WETH_WEI, WETH_DECIMALS));
                 opportunity = { /* ... */ }; // Fill opportunity struct
                 console.log(`  Potential Opportunity: Sell WETH on B ($${priceB.toFixed(4)}), Buy on A ($${priceA.toFixed(4)})`);
             }

            if (estimatedProfitUsd > PROFIT_THRESHOLD_USD) {
                await attemptArbitrage(opportunity);
            } else {
                console.log(`  Price difference detected, but estimated profit ($${estimatedProfitUsd.toFixed(4)}) below threshold ($${PROFIT_THRESHOLD_USD}).`);
            }
        } else {
            console.log("  No significant price difference detected.");
        }

    } catch (error) {
        console.error(`${new Date().toISOString()} - Error in monitoring loop:`, error);
    } finally {
        // setInterval handles next call
    }
} // End monitorPools function

// --- Start the Bot ---
(async () => {
    try {
        // ... (owner check remains the same) ...
        console.log(`Signer matches contract owner. 'onlyOwner' calls should succeed.\n`);

        // Perform the first check immediately
        await monitorPools();

        // Start the recurring checks using setInterval
        setInterval(monitorPools, POLLING_INTERVAL_MS);
        console.log(`\nMonitoring started. Will check every ${POLLING_INTERVAL_MS / 1000} seconds.`);

    } catch (initError) {
        console.error("Initialization Error:", initError);
        process.exit(1);
    }
})();
