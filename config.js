// config.js
require('dotenv').config();
const { ethers } = require("ethers");

// --- Network & Keys ---
const RPC_URL = process.env.ARBITRUM_RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const ARBISCAN_API_KEY = process.env.ARBISCAN_API_KEY;
const FLASH_SWAP_CONTRACT_ADDRESS_FROM_ENV = process.env.FLASH_SWAP_CONTRACT_ADDRESS;
   if (!FLASH_SWAP_CONTRACT_ADDRESS_FROM_ENV) { throw new Error("FLASH_SWAP_CONTRACT_ADDRESS missing in .env file"); }
const FLASH_SWAP_CONTRACT_ADDRESS = ethers.getAddress(FLASH_SWAP_CONTRACT_ADDRESS_FROM_ENV);

// --- Contract Addresses ---
// Use ethers.getAddress to ensure checksum format
const FLASH_SWAP_CONTRACT_ADDRESS = ethers.getAddress("0x675BCDd612973C75cA682f9B8b0e27032A4B3FB6");
const WETH_ADDRESS = ethers.getAddress("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1");
const USDC_ADDRESS = ethers.getAddress("0xaf88d065e77c8cC2239327C5EDb3A432268e5831"); // Native USDC
const QUOTER_V2_ADDRESS = ethers.getAddress("0x61ffe014ba17989e743c5f6d790181c0603c3996");

// <<< UPDATED POOLS & FEES >>>
const POOL_A_ADDRESS = ethers.getAddress("0x6f38e884725a116C9C7fBF208e79FE8828a2595F"); // 0.01% (Verified)
const POOL_B_ADDRESS = ethers.getAddress("0xc473e2aEE3441BF9240Be85eb122aBB059A3B57c"); // 0.30% (Verified)

// <<< UPDATED FEES >>>
const POOL_A_FEE_BPS = 100; // Corresponds to 0.01% pool
const POOL_A_FEE_PERCENT = POOL_A_FEE_BPS / 10000;
const POOL_B_FEE_BPS = 3000; // Corresponds to 0.30% pool
const POOL_B_FEE_PERCENT = POOL_B_FEE_BPS / 10000;

// --- Token Decimals ---
const WETH_DECIMALS = 18;
const USDC_DECIMALS = 6;

// --- Bot Settings ---
const POLLING_INTERVAL_MS = 10000; // 10 seconds
const BORROW_AMOUNT_WETH_STR = "0.1"; // Borrow amount as string
const BORROW_AMOUNT_WETH_WEI = ethers.parseUnits(BORROW_AMOUNT_WETH_STR, WETH_DECIMALS);

// Threshold for potential gross profit (in WETH Wei) BEFORE fees/slippage. TUNABLE.
const MIN_POTENTIAL_GROSS_PROFIT_WETH_STR = "0.00005"; // Example: ~0.1 USD if WETH is $2000
const MIN_POTENTIAL_GROSS_PROFIT_WETH_WEI = ethers.parseUnits(MIN_POTENTIAL_GROSS_PROFIT_WETH_STR, WETH_DECIMALS);

// Simulation amount for Quoter checks
const QUOTER_SIM_AMOUNT_WETH_STR = "0.001";
const QUOTER_SIM_AMOUNT_WETH_WEI = ethers.parseUnits(QUOTER_SIM_AMOUNT_WETH_STR, WETH_DECIMALS);

// --- Export Config Object ---
module.exports = {
    RPC_URL,
    PRIVATE_KEY,
    ARBISCAN_API_KEY,
    FLASH_SWAP_CONTRACT_ADDRESS,
    WETH_ADDRESS,
    USDC_ADDRESS,
    QUOTER_V2_ADDRESS,
    POOL_A_ADDRESS, // Updated
    POOL_B_ADDRESS, // Updated
    POOL_A_FEE_BPS, // Updated
    POOL_A_FEE_PERCENT, // Updated (derived)
    POOL_B_FEE_BPS, // Updated
    POOL_B_FEE_PERCENT, // Updated (derived)
    WETH_DECIMALS,
    USDC_DECIMALS,
    POLLING_INTERVAL_MS,
    BORROW_AMOUNT_WETH_STR,
    BORROW_AMOUNT_WETH_WEI,
    MIN_POTENTIAL_GROSS_PROFIT_WETH_STR,
    MIN_POTENTIAL_GROSS_PROFIT_WETH_WEI,
    QUOTER_SIM_AMOUNT_WETH_WEI,
    QUOTER_SIM_AMOUNT_WETH_STR
};
