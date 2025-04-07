// bot.js - Arbitrum Uniswap V3 Flash Swap Bot with Debugging (v8 - Lowercase Quoter Address)

const { ethers } = require("ethers");
require('dotenv').config();

// --- Configuration ---
const RPC_URL = process.env.ARBITRUM_RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// --- Use getAddress for verified/standard addresses ---
const FLASH_SWAP_CONTRACT_ADDRESS = ethers.getAddress("0x7a00Ec5b64e662425Bbaa0dD78972570C326210f");
const WETH_ADDRESS = ethers.getAddress("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1");
const USDC_ADDRESS = ethers.getAddress("0xaf88d065e77c8cC2239327C5EDb3A432268e5831"); // Native USDC

// --- Use lowercase for Quoter V2 address ---
const QUOTER_V2_ADDRESS = "0x61ffe014ba17989e743c5f6d790181c0603c3996"; // Lowercase

// --- Use lowercase for pool addresses ---
const POOL_A_ADDRESS = "0xc696d20fd7ac47c89ea8b8c51065a67b6ffa2067"; // WETH/USDC 0.05% (LOWERCASE) - VERIFY
const POOL_A_FEE_BPS = 500;
const POOL_A_FEE_PERCENT = 0.05;
const POOL_B_ADDRESS = "0xc31e54c7a869b9fcbecc14363cf510d1c41fa441"; // WETH/USDC 0.30% (LOWERCASE) - VERIFY
const POOL_B_FEE_BPS = 3000;
const POOL_B_FEE_PERCENT = 0.30;

const WETH_DECIMALS = 18;
const USDC_DECIMALS = 6;

// --- ABIs ---
// (Keep your existing ABIs: FlashSwapABI, IUniswapV3PoolABI, IQuoterV2ABI)
const FlashSwapABI = [ /* ... ABI ... */ ];
const IUniswapV3PoolABI = [ /* ... ABI ... */ ];
const IQuoterV2ABI = [ /* ... ABI ... */ ];


// --- Bot Settings ---
const POLLING_INTERVAL_MS = 10000;
const PROFIT_THRESHOLD_USD = 0.05;
let BORROW_AMOUNT_WETH_WEI = ethers.parseUnits("0.00005", WETH_DECIMALS);

// --- Initialization ---
if (!RPC_URL || !PRIVATE_KEY) {
    console.error("Error: ARBITRUM_RPC_URL and PRIVATE_KEY must be set in .env file.");
    process.exit(1);
}
const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);
// Use checksummed addresses where defined with getAddress
const flashSwapContract = new ethers.Contract(FLASH_SWAP_CONTRACT_ADDRESS, FlashSwapABI, signer);
// Use lowercase addresses directly where getAddress was removed
const quoterContract = new ethers.Contract(QUOTER_V2_ADDRESS, IQuoterV2ABI, provider); // Now uses lowercase
const poolAContract = new ethers.Contract(POOL_A_ADDRESS, IUniswapV3PoolABI, provider);
const poolBContract = new ethers.Contract(POOL_B_ADDRESS, IUniswapV3PoolABI, provider);

console.log(`Bot starting...`);
console.log(` - Signer Address: ${signer.address}`);
console.log(` - FlashSwap Contract: ${FLASH_SWAP_CONTRACT_ADDRESS}`); // Checksummed
console.log(` - Quoter V2 Contract: ${QUOTER_V2_ADDRESS}`); // Lowercase
console.log(` - Monitoring Pools:`);
console.log(`   - Pool A (WETH/USDC ${POOL_A_FEE_PERCENT}%): ${POOL_A_ADDRESS}`); // Lowercase
console.log(`   - Pool B (WETH/USDC ${POOL_B_FEE_PERCENT}%): ${POOL_B_ADDRESS}`); // Lowercase
console.log(` - Debug Borrow Amount: ${ethers.formatUnits(BORROW_AMOUNT_WETH_WEI, WETH_DECIMALS)} WETH`);
console.log(` - Polling Interval: ${POLLING_INTERVAL_MS / 1000} seconds`);
console.log(` - Profit Threshold: $${PROFIT_THRESHOLD_USD} USD (approx, before gas)`);

// --- Helper Functions ---
// (Keep existing simulateSwap function)
async function simulateSwap(poolDesc, tokenIn, tokenOut, amountInWei, feeBps, quoter) { /* ... */ }

// (Keep existing attemptArbitrage function)
async function attemptArbitrage(opportunity) { /* ... */ }

// --- Main Monitoring Loop ---
// (Keep existing monitorPools function - no changes needed inside)
async function monitorPools() { /* ... */ }

// --- Start the Bot ---
// (Keep existing startup IIFE)
(async () => { /* ... */ })();
