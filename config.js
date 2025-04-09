// config.js
require('dotenv').config();
const { ethers } = require("ethers");

// --- Network & Keys ---
const RPC_URL = process.env.ARBITRUM_RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const ARBISCAN_API_KEY = process.env.ARBISCAN_API_KEY;

if (!RPC_URL || !PRIVATE_KEY) {
    throw new Error("Missing RPC_URL or PRIVATE_KEY in .env file");
}

// --- Contract Addresses ---
// Use ethers.getAddress to ensure checksum format
const FLASH_SWAP_CONTRACT_ADDRESS = ethers.getAddress("0x7a00Ec5b64e662425Bbaa0dD78972570C326210f");
const WETH_ADDRESS = ethers.getAddress("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1");
const USDC_ADDRESS = ethers.getAddress("0xaf88d065e77c8cC2239327C5EDb3A432268e5831"); // Native USDC
const QUOTER_V2_ADDRESS = ethers.getAddress("0x61ffe014ba17989e743c5f6d790181c0603c3996");
const POOL_A_ADDRESS = ethers.getAddress("0xc6962004f452be9203591991d15f6b388e09e8d0"); // 0.05%
const POOL_B_ADDRESS = ethers.getAddress("0x17c14d2c404d167802b16c450d3c99f88f2c4f4d"); // 0.30%

// --- Pool Fees ---
const POOL_A_FEE_BPS = 500;
const POOL_A_FEE_PERCENT = POOL_A_FEE_BPS / 10000;
const POOL_B_FEE_BPS = 3000;
const POOL_B_FEE_PERCENT = POOL_B_FEE_BPS / 10000;

// --- Token Decimals ---
const WETH_DECIMALS = 18;
const USDC_DECIMALS = 6;

// --- Bot Settings ---
const POLLING_INTERVAL_MS = 10000; // 10 seconds
const BORROW_AMOUNT_WETH_STR = "0.01"; // Borrow amount as string
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
    MIN_POTENTIAL_GROSS_PROFIT_WETH_STR,
    MIN_POTENTIAL_GROSS_PROFIT_WETH_WEI,
    QUOTER_SIM_AMOUNT_WETH_WEI,
    QUOTER_SIM_AMOUNT_WETH_STR
};
