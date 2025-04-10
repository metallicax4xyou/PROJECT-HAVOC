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
const QUOTER_V2_ADDRESS = ethers.getAddress("0x61ffe014ba17989e743c5f6d790181c0603c3996");

// <<< REVERT TO ORIGINAL POOLS >>>
const POOL_A_ADDRESS = ethers.getAddress("0xc6962004f452be9203591991d15f6b388e09e8d0"); // 0.05%
const POOL_B_ADDRESS = ethers.getAddress("0x17c14d2c404d167802b16c450d3c99f88f2c4f4d"); // 0.30%

// <<< REVERT FEES >>>
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

// Rough profit threshold based on ticks (can be removed or refined)
const MIN_POTENTIAL_GROSS_PROFIT_WETH_STR = "0.00005";
const MIN_POTENTIAL_GROSS_PROFIT_WETH_WEI = ethers.parseUnits(MIN_POTENTIAL_GROSS_PROFIT_WETH_STR, WETH_DECIMALS);

// Simulation amount for basic Quoter health check (used in simulateSwap helper)
const QUOTER_SIM_AMOUNT_WETH_STR = "0.001";
const QUOTER_SIM_AMOUNT_WETH_WEI = ethers.parseUnits(QUOTER_SIM_AMOUNT_WETH_STR, WETH_DECIMALS);

// <<< NEW: Amount for Multi-Quote Static Call Simulation in monitor.js >>>
// Use a small amount unlikely to cause liquidity issues during quote simulation
const MULTI_QUOTE_SIM_AMOUNT_WETH_STR = "0.0001";
const MULTI_QUOTE_SIM_AMOUNT_WETH_WEI = ethers.parseUnits(MULTI_QUOTE_SIM_AMOUNT_WETH_STR, WETH_DECIMALS);


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
    POOL_B_ADDRESS,
    POOL_A_FEE_BPS,
    POOL_A_FEE_PERCENT,
    POOL_B_FEE_BPS,
    POOL_B_FEE_PERCENT,
    WETH_DECIMALS,
    USDC_DECIMALS,
    POLLING_INTERVAL_MS,
    BORROW_AMOUNT_WETH_STR,
    BORROW_AMOUNT_WETH_WEI,
    MIN_POTENTIAL_GROSS_PROFIT_WETH_STR, // Keep or remove if unused
    MIN_POTENTIAL_GROSS_PROFIT_WETH_WEI, // Keep or remove if unused
    QUOTER_SIM_AMOUNT_WETH_WEI, // Keep for basic health check if needed
    QUOTER_SIM_AMOUNT_WETH_STR, // Keep for basic health check if needed
    MULTI_QUOTE_SIM_AMOUNT_WETH_WEI, // <<< Add new export
    MULTI_QUOTE_SIM_AMOUNT_WETH_STR, // <<< Add new export
};
