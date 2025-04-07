// bot.js - Arbitrum Uniswap V3 Flash Swap Bot with Debugging (v6 - Checksum Fixed)

const { ethers } = require("ethers");
require('dotenv').config();

// --- Configuration ---
const RPC_URL = process.env.ARBITRUM_RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// --- Apply ethers.getAddress() to all address constants ---
const FLASH_SWAP_CONTRACT_ADDRESS = ethers.getAddress("0x7a00Ec5b64e662425Bbaa0dD78972570C326210f");
const WETH_ADDRESS = ethers.getAddress("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1");
const USDC_ADDRESS = ethers.getAddress("0xaf88d065e77c8cC2239327C5EDb3A432268e5831"); // Native USDC

// Pool Configuration (VERIFY ADDRESSES AND APPLY getAddress)
const POOL_A_ADDRESS = ethers.getAddress("0xC696D20fd7ac47C89Ea8b8C51065A67B6FFa2067"); // WETH/USDC 0.05%
const POOL_A_FEE_BPS = 500;
const POOL_A_FEE_PERCENT = 0.05;

const POOL_B_ADDRESS = ethers.getAddress("0xc31E54c7a869B9FcBEcc14363CF510d1c41fa441"); // WETH/USDC 0.30%
const POOL_B_FEE_BPS = 3000;
const POOL_B_FEE_PERCENT = 0.30;

// Uniswap V3 Quoter V2 Address on Arbitrum
const QUOTER_V2_ADDRESS = ethers.getAddress("0x61fFE014bA17989E743c5F6d790181C0603C3996");

const WETH_DECIMALS = 18;
const USDC_DECIMALS = 6;

// --- ABIs ---
// Minimal ABI for FlashSwap contract (Use your actual full ABI)
const FlashSwapABI = [
    "function owner() view returns (address)",
    "function initiateFlashSwap(address _poolAddress, uint256 _amount0, uint256 _amount1, bytes calldata _params) external",
    // Add events if needed for parsing receipts later
];

// Minimal ABI for Uniswap V3 Pool
const IUniswapV3PoolABI = [
    "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
    "function liquidity() external view returns (uint128 liquidity)",
    "function token0() external view returns (address)",
    "function token1() external view returns (address)",
    "function fee() external view returns (uint24)"
];

// Minimal ABI for QuoterV2
const IQuoterV2ABI = [
    "function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceNextX96, uint32 ticksCrossed, uint256 gasEstimate)"
];

// --- Bot Settings ---
const POLLING_INTERVAL_MS = 10000;
const PROFIT_THRESHOLD_USD = 0.05; // Low for debugging
let BORROW_AMOUNT_WETH_WEI = ethers.parseUnits("0.00005", WETH_DECIMALS);

// --- Initialization ---
if (!RPC_URL || !PRIVATE_KEY) {
    console.error("Error: ARBITRUM_RPC_URL and PRIVATE_KEY must be set in .env file.");
    process.exit(1);
}
const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);
// Contract instances will now use checksummed addresses
const flashSwapContract = new ethers.Contract(FLASH_SWAP_CONTRACT_ADDRESS, FlashSwapABI, signer);
const quoterContract = new ethers.Contract(QUOTER_V2_ADDRESS, IQuoterV2ABI, provider);
const poolAContract = new ethers.Contract(POOL_A_ADDRESS, IUniswapV3PoolABI, provider);
const poolBContract = new ethers.Contract(POOL_B_ADDRESS, IUniswapV3PoolABI, provider);

console.log(`Bot starting...`);
console.log(` - Signer Address: ${signer.address}`);
console.log(` - FlashSwap Contract: ${FLASH_SWAP_CONTRACT_ADDRESS}`); // Will log checksummed
console.log(` - Monitoring Pools:`);
console.log(`   - Pool A (WETH/USDC ${POOL_A_FEE_PERCENT}%): ${POOL_A_ADDRESS}`); // Will log checksummed
console.log(`   - Pool B (WETH/USDC ${POOL_B_FEE_PERCENT}%): ${POOL_B_ADDRESS}`); // Will log checksummed
console.log(` - Debug Borrow Amount: ${ethers.formatUnits(BORROW_AMOUNT_WETH_WEI, WETH_DECIMALS)} WETH`);
console.log(` - Polling Interval: ${POLLING_INTERVAL_MS / 1000} seconds`);
console.log(` - Profit Threshold: $${PROFIT_THRESHOLD_USD} USD (approx, before gas)`);

// --- Helper Functions ---
// (Keep existing calculatePriceFromSqrt - though not used in main loop currently)

// Simulate swap using QuoterV2 - with error logging enabled
async function simulateSwap(poolDesc, tokenIn, tokenOut, amountInWei, feeBps, quoter) {
    try {
        const params = {
            tokenIn: tokenIn, // Already checksummed from constants
            tokenOut: tokenOut, // Already checksummed from constants
            amountIn: amountInWei,
            fee: feeBps,
            sqrtPriceLimitX96: 0n
        };
        const quoteResult = await quoter.quoteExactInputSingle.staticCall(params);
        return quoteResult[0];
    } catch (error) {
        console.warn(`Quoter simulation failed for ${poolDesc} (Fee: ${feeBps}bps): ${error.reason || error.message || error}`);
        // If error.data exists, we might decode it here later if needed
        // if (error.data) console.warn(`   Raw Revert Data: ${error.data}`);
        return 0n;
    }
}

// (Keep existing attemptArbitrage function - no changes needed there)
async function attemptArbitrage(opportunity) {
    console.log("\n========= Arbitrage Opportunity Detected =========");
    // ... all the logic inside attemptArbitrage ...
    console.log("========= Arbitrage Attempt Complete =========");
}


// --- Main Monitoring Loop ---
async function monitorPools() {
    console.log(`\n${new Date().toISOString()} - Checking for opportunities...`);

    try {
        // Fetch pool states - should succeed now with correct addresses
        console.log("  Fetching pool states...");
        const [slotA, liqA, slotB, liqB] = await Promise.all([
            poolAContract.slot0().catch(e => { console.error(`Error fetching slot0 for Pool A: ${e.message}`); return null; }),
            poolAContract.liquidity().catch(e => { console.error(`Error fetching liquidity for Pool A: ${e.message}`); return null; }),
            poolBContract.slot0().catch(e => { console.error(`Error fetching slot0 for Pool B: ${e.message}`); return null; }),
            poolBContract.liquidity().catch(e => { console.error(`Error fetching liquidity for Pool B: ${e.message}`); return null; })
        ]);

        // Log pool states
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
        // Exit early if we couldn't get state for both pools
        if (!slotA || liqA === null || !slotB || liqB === null) {
            console.log("  Could not fetch state for both pools. Skipping simulation cycle.");
            return;
        }

        // Simulate swaps - should have better chance of succeeding now
        const simulateAmountWeth = ethers.parseUnits("0.1", WETH_DECIMALS);
        console.log("  Simulating swaps with QuoterV2...");
        const [amountOutA, amountOutB] = await Promise.all([
            simulateSwap("Pool A", WETH_ADDRESS, USDC_ADDRESS, simulateAmountWeth, POOL_A_FEE_BPS, quoterContract),
            simulateSwap("Pool B", WETH_ADDRESS, USDC_ADDRESS, simulateAmountWeth, POOL_B_FEE_BPS, quoterContract)
        ]);

        // Check if quotes still failed (now likely due to actual liquidity issues if addresses are correct)
        if (amountOutA === 0n || amountOutB === 0n) {
             console.log("  Failed to get valid quotes for one or both pools (see warnings above - likely liquidity issue now). Skipping cycle.");
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
             // ... (opportunity detection logic) ...
             if (priceA > priceB) { /* setup opportunity A>B */ } else { /* setup opportunity B>=A */ }
             // ... (profit check and call attemptArbitrage) ...
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
        // Checksum validation happens during initialization now
        console.log(`Signer Address: ${signer.address}`); // Log signer address early
        const contractOwner = await flashSwapContract.owner();
        if (contractOwner.toLowerCase() !== signer.address.toLowerCase()) {
            console.warn(`\nWarning: Signer address (${signer.address}) does not match FlashSwap owner (${contractOwner}). 'onlyOwner' calls will fail.\n`);
        } else {
            console.log(`Signer matches contract owner. 'onlyOwner' calls should succeed.\n`);
        }

        await monitorPools(); // First run
        setInterval(monitorPools, POLLING_INTERVAL_MS); // Subsequent runs
        console.log(`\nMonitoring started. Will check every ${POLLING_INTERVAL_MS / 1000} seconds.`);

    } catch (initError) {
        // Catch errors during initialization (e.g., invalid RPC, invalid private key, checksum error on contract addresses)
        console.error("Initialization Error:", initError);
        if (initError.code === 'INVALID_ARGUMENT' && initError.message.includes('checksum')) {
            console.error(">>> Ensure ALL addresses in the script have the correct format/checksum or wrap them in ethers.getAddress() <<<");
        }
        process.exit(1);
    }
})();
