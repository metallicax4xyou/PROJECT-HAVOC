// bot.js - Arbitrum Uniswap V3 Flash Swap Bot with Debugging (v9 - Added Startup Logging)

const { ethers } = require("ethers");
require('dotenv').config();

// --- Configuration ---
// ... (Keep all configuration constants as they were in v8 - lowercase pools/quoter, checksummed others) ...
const RPC_URL = process.env.ARBITRUM_RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const FLASH_SWAP_CONTRACT_ADDRESS = ethers.getAddress("0x7a00Ec5b64e662425Bbaa0dD78972570C326210f");
const WETH_ADDRESS = ethers.getAddress("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1");
const USDC_ADDRESS = ethers.getAddress("0xaf88d065e77c8cC2239327C5EDb3A432268e5831");
const QUOTER_V2_ADDRESS = "0x61ffe014ba17989e743c5f6d790181c0603c3996"; // Lowercase
const POOL_A_ADDRESS = "0xc696d20fd7ac47c89ea8b8c51065a67b6ffa2067"; // Lowercase - VERIFY
const POOL_A_FEE_BPS = 500;
const POOL_B_ADDRESS = "0xc31e54c7a869b9fcbecc14363cf510d1c41fa441"; // Lowercase - VERIFY
const POOL_B_FEE_BPS = 3000;
const WETH_DECIMALS = 18;
const USDC_DECIMALS = 6;

// --- ABIs ---
// --- IMPORTANT: Ensure your ABIs here are complete and correct ---
const FlashSwapABI = [
    // --- Make sure this entry exists and is correct ---
    "function owner() view returns (address)",
    "function initiateFlashSwap(address _poolAddress, uint256 _amount0, uint256 _amount1, bytes calldata _params) external",
    // Add events if needed
];
const IUniswapV3PoolABI = [
    "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
    "function liquidity() external view returns (uint128 liquidity)",
    "function token0() external view returns (address)",
    "function token1() external view returns (address)",
    "function fee() external view returns (uint24)"
];
const IQuoterV2ABI = [
    "function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceNextX96, uint32 ticksCrossed, uint256 gasEstimate)"
];


// --- Bot Settings ---
const POLLING_INTERVAL_MS = 10000;
const PROFIT_THRESHOLD_USD = 0.05;
let BORROW_AMOUNT_WETH_WEI = ethers.parseUnits("0.00005", WETH_DECIMALS);

// --- Initialization ---
if (!RPC_URL || !PRIVATE_KEY) { /* ... error handling ... */ }
const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);
const flashSwapContract = new ethers.Contract(FLASH_SWAP_CONTRACT_ADDRESS, FlashSwapABI, signer);
const quoterContract = new ethers.Contract(QUOTER_V2_ADDRESS, IQuoterV2ABI, provider);
const poolAContract = new ethers.Contract(POOL_A_ADDRESS, IUniswapV3PoolABI, provider);
const poolBContract = new ethers.Contract(POOL_B_ADDRESS, IUniswapV3PoolABI, provider);

// --- Initial Logs (These worked before) ---
console.log(`Bot starting...`);
console.log(` - Signer Address: ${signer.address}`);
console.log(` - FlashSwap Contract: ${FLASH_SWAP_CONTRACT_ADDRESS}`);
console.log(` - Quoter V2 Contract: ${QUOTER_V2_ADDRESS}`);
console.log(` - Monitoring Pools:`);
console.log(`   - Pool A ...: ${POOL_A_ADDRESS}`);
console.log(`   - Pool B ...: ${POOL_B_ADDRESS}`);
console.log(` - Debug Borrow Amount: ...`);
console.log(` - Polling Interval: ...`);
console.log(` - Profit Threshold: ...`);

// --- Helper Functions ---
// (Keep existing simulateSwap function)
async function simulateSwap(poolDesc, tokenIn, tokenOut, amountInWei, feeBps, quoter) { /* ... */ }
// (Keep existing attemptArbitrage function)
async function attemptArbitrage(opportunity) { /* ... */ }
// (Keep existing monitorPools function)
async function monitorPools() { /* ... */ }

// --- Start the Bot ---
(async () => {
    // --- ADDED LOGGING ---
    console.log("\n>>> Entering startup async IIFE...");
    try {
        console.log(">>> Checking signer balance (as connectivity test)...");
        const balance = await provider.getBalance(signer.address);
        console.log(`>>> Signer balance: ${ethers.formatEther(balance)} ETH`);

        console.log(">>> Attempting to fetch contract owner...");
        // This is the likely point of failure if ABI or RPC is wrong
        const contractOwner = await flashSwapContract.owner();
        console.log(`>>> Successfully fetched owner: ${contractOwner}`);

        if (contractOwner.toLowerCase() !== signer.address.toLowerCase()) {
            console.warn(`\nWarning: Signer address (${signer.address}) does not match FlashSwap owner (${contractOwner}). 'onlyOwner' calls will fail.\n`);
        } else {
            console.log(`Signer matches contract owner. 'onlyOwner' calls should succeed.\n`);
        }

        console.log(">>> Attempting first monitorPools() run...");
        await monitorPools(); // First run
        console.log(">>> First monitorPools() run complete.");

        console.log(">>> Setting up setInterval...");
        setInterval(monitorPools, POLLING_INTERVAL_MS); // Subsequent runs
        console.log(`\nMonitoring started. Will check every ${POLLING_INTERVAL_MS / 1000} seconds.`);

    } catch (initError) {
        // Catch errors during initialization OR the startup checks inside the IIFE
        console.error("\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        console.error("Initialization Error / Startup Error:");
        console.error(initError);
        console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        process.exit(1);
    }
})();
