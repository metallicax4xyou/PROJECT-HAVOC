// bot.js - Arbitrum Uniswap V3 Flash Swap Bot with Debugging (v11 - Updated Pool ABI)

const { ethers } = require("ethers");
require('dotenv').config();

// --- Configuration ---
const RPC_URL = process.env.ARBITRUM_RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const FLASH_SWAP_CONTRACT_ADDRESS = ethers.getAddress("0x7a00Ec5b64e662425Bbaa0dD78972570C326210f");
const WETH_ADDRESS = ethers.getAddress("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1");
const USDC_ADDRESS = ethers.getAddress("0xaf88d065e77c8cC2239327C5EDb3A432268e5831");
const QUOTER_V2_ADDRESS = "0x61ffe014ba17989e743c5f6d790181c0603c3996"; // Lowercase

// Pool Addresses (Lowercase)
const POOL_A_ADDRESS = "0xc31e54c7a869b9fcbecc14363cf510d1c41fa441"; // WETH/USDC 0.05%
const POOL_A_FEE_BPS = 500;
const POOL_A_FEE_PERCENT = 0.05;
const POOL_B_ADDRESS = "0x17c14d2c404d167802b16c450d3c99f88f2c4f4d"; // WETH/USDC 0.30%
const POOL_B_FEE_BPS = 3000;
const POOL_B_FEE_PERCENT = 0.30;

const WETH_DECIMALS = 18;
const USDC_DECIMALS = 6;

// --- ABIs ---
// --- IMPORTANT: Ensure FlashSwapABI is complete and correct ---
const FlashSwapABI = [
    "function owner() view returns (address)",
    "function initiateFlashSwap(address _poolAddress, uint256 _amount0, uint256 _amount1, bytes calldata _params) external",
    "event ProfitTransferred(address indexed token, address indexed recipient, uint amount)"
];

// --- Using More Comprehensive IUniswapV3Pool ABI ---
const IUniswapV3PoolABI = [
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "function fee() external view returns (uint24)",
  "function tickSpacing() external view returns (int24)",
  "function maxLiquidityPerTick() external view returns (uint128)",
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() external view returns (uint128)",
  "function ticks(int24 tick) external view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)",
  "function observations(uint256 index) external view returns (uint32 blockTimestamp, int56 tickCumulative, uint160 secondsPerLiquidityCumulativeX128, bool initialized)",
  "function positions(bytes32 key) external view returns (uint128 _liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)"
];

// --- IMPORTANT: Ensure IQuoterV2ABI is complete and correct ---
const IQuoterV2ABI = [
    "function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceNextX96, uint32 ticksCrossed, uint256 gasEstimate)"
];


// --- Bot Settings ---
const POLLING_INTERVAL_MS = 10000;
const PROFIT_THRESHOLD_USD = 0.05;
let BORROW_AMOUNT_WETH_WEI = ethers.parseUnits("0.00005", WETH_DECIMALS);

// --- Initialization ---
if (!RPC_URL || !PRIVATE_KEY) { console.error("ENV VAR MISSING"); process.exit(1); }
const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);
const flashSwapContract = new ethers.Contract(FLASH_SWAP_CONTRACT_ADDRESS, FlashSwapABI, signer);
const quoterContract = new ethers.Contract(QUOTER_V2_ADDRESS, IQuoterV2ABI, provider);
const poolAContract = new ethers.Contract(POOL_A_ADDRESS, IUniswapV3PoolABI, provider);
const poolBContract = new ethers.Contract(POOL_B_ADDRESS, IUniswapV3PoolABI, provider);

// --- Initial Logs ---
console.log(`Bot starting...`);
// ... other startup logs ...

// --- Helper Functions ---
// (Keep existing simulateSwap function)
async function simulateSwap(poolDesc, tokenIn, tokenOut, amountInWei, feeBps, quoter) { /* ... */ }
// (Keep existing attemptArbitrage function)
async function attemptArbitrage(opportunity) { /* ... */ }

// --- Main Monitoring Loop ---
// (Keep existing monitorPools function - includes detailed logging)
async function monitorPools() { /* ... */ }

// --- Start the Bot ---
// (Keep existing startup IIFE - includes detailed logging)
(async () => { /* ... */ })();
