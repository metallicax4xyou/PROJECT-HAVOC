// config.js
require('dotenv').config(); // Loads variables from .env into process.env
const { ethers } = require("ethers");

// --- Network & Keys ---
const RPC_URL = process.env.ARBITRUM_RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const ARBISCAN_API_KEY = process.env.ARBISCAN_API_KEY;

if (!RPC_URL || !PRIVATE_KEY) {
    throw new Error("Missing RPC_URL or PRIVATE_KEY in .env file");
}

// --- Contract Addresses ---

// ** Read Flash Swap address from .env **
const FLASH_SWAP_CONTRACT_ADDRESS_FROM_ENV = process.env.FLASH_SWAP_CONTRACT_ADDRESS;
if (!FLASH_SWAP_CONTRACT_ADDRESS_FROM_ENV) {
    throw new Error("FLASH_SWAP_CONTRACT_ADDRESS missing in .env file. Please add it.");
}
const FLASH_SWAP_CONTRACT_ADDRESS = ethers.getAddress(FLASH_SWAP_CONTRACT_ADDRESS_FROM_ENV);


// Other addresses
const WETH_ADDRESS = ethers.getAddress("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1");
const USDC_ADDRESS = ethers.getAddress("0xaf88d065e77c8cC2239327C5EDb3A432268e5831"); // Native USDC
const QUOTER_V2_ADDRESS = ethers.getAddress("0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6"); // Uniswap V3 Quoter V2

// Current Pools (0.05% and 0.30%)
const POOL_A_ADDRESS = ethers.getAddress("0xC6962004f452bE9203591991D15f6b388e09E8D0"); // 0.05% (Correct)

// <<< UPDATED POOL B ADDRESS TO MATCH FACTORY RESULT FOR 3000 FEE >>>
const POOL_B_ADDRESS = ethers.getAddress("0xc473e2aEE3441BF9240Be85eb122aBB059A3B57c"); // 0.30% (Corrected)

// --- Pool Fees --- (Matching the pools above)
const POOL_A_FEE_BPS = 500; // 0.05%
const POOL_A_FEE_PERCENT = POOL_A_FEE_BPS / 10000;
const POOL_B_FEE_BPS = 3000; // 0.30%
const POOL_B_FEE_PERCENT = POOL_B_FEE_BPS / 10000;

// --- Token Decimals ---
const WETH_DECIMALS = 18;
const USDC_DECIMALS = 6;

// --- Bot Settings ---
const POLLING_INTERVAL_MS = 10000; // 10 seconds

// Intended borrow amount for arbitrage execution
const BORROW_AMOUNT_WETH_STR = "0.1";
const BORROW_AMOUNT_WETH_WEI = ethers.parseUnits(BORROW_AMOUNT_WETH_STR, WETH_DECIMALS);

// Rough profit threshold based on ticks (optional, currently not primary filter)
// const MIN_POTENTIAL_GROSS_PROFIT_WETH_STR = "0.00005"; // Commented out as unused
// const MIN_POTENTIAL_GROSS_PROFIT_WETH_WEI = ethers.parseUnits(MIN_POTENTIAL_GROSS_PROFIT_WETH_STR, WETH_DECIMALS);

// Amount for Multi-Quote Static Call Simulation in monitor.js
const MULTI_QUOTE_SIM_AMOUNT_WETH_STR = "0.0001";
const MULTI_QUOTE_SIM_AMOUNT_WETH_WEI = ethers.parseUnits(MULTI_QUOTE_SIM_AMOUNT_WETH_STR, WETH_DECIMALS);

const TICK_DELTA_WARNING_THRESHOLD = 20; // Log if absolute tick difference is less than or equal to this value

// Minimum Net Profit Required (in WETH Wei) AFTER estimated gas cost
const MIN_NET_PROFIT_WEI = ethers.parseUnits("0.0001", WETH_DECIMALS); // Example: ~0.20 USD if WETH=$2k. TUNABLE.

// Gas Limit Estimate for initiateFlashSwap
const GAS_LIMIT_ESTIMATE = 1_000_000n; // Use BigInt. TUNABLE placeholder.


// --- Export Config Object ---
module.exports = {
    RPC_URL,
    PRIVATE_KEY,
    ARBISCAN_API_KEY,
    FLASH_SWAP_CONTRACT_ADDRESS,
    WETH_ADDRESS,
    USDC_ADDRESS,
    QUOTER_V2_ADDRESS,
    POOL_A_ADDRESS,
    POOL_B_ADDRESS, // Ensure this uses the updated value
    POOL_A_FEE_BPS,
    POOL_A_FEE_PERCENT,
    POOL_B_FEE_BPS,
    POOL_B_FEE_PERCENT,
    WETH_DECIMALS,
    USDC_DECIMALS,
    POLLING_INTERVAL_MS,
    BORROW_AMOUNT_WETH_STR,
    BORROW_AMOUNT_WETH_WEI,
    // MIN_POTENTIAL_GROSS_PROFIT_WETH_WEI, // Commented out as unused
    MULTI_QUOTE_SIM_AMOUNT_WETH_WEI,
    MULTI_QUOTE_SIM_AMOUNT_WETH_STR,
    TICK_DELTA_WARNING_THRESHOLD,
    MIN_NET_PROFIT_WEI,
    GAS_LIMIT_ESTIMATE,
};
