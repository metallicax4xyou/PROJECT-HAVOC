require('dotenv').config();
const { ethers } = require('ethers');
const { Pool, computePoolAddress } = require('@uniswap/v3-sdk');
const { Token } = require('@uniswap/sdk-core');

// Helper function to create pool config objects
// Ensures address checksum and converts fee to integer
function pool(address, feeBps) {
  // --- DEBUG LOGGING START ---
  console.log(`[Debug Config Pool] feeBps: ${feeBps}, Input Address: '${address}' (Type: ${typeof address})`);
  if (!address || typeof address !== 'string' || address.trim() === '') {
    console.warn(`[Debug Config Pool] Null/Empty/Invalid Address for fee ${feeBps}. Returning null.`);
    return null; // Return null if address is missing or empty string
  }
  // --- DEBUG LOGGING END ---
  try {
    const checksummedAddress = ethers.getAddress(address.trim()); // Validate and checksum address (added trim)
    // --- DEBUG LOGGING START ---
    console.log(`[Debug Config Pool] Valid Address for fee ${feeBps}. Checksummed: ${checksummedAddress}`);
    // --- DEBUG LOGGING END ---
    return {
      address: checksummedAddress,
      feeBps: parseInt(feeBps, 10), // Store fee tier in basis points
    };
  } catch (error) {
    // --- DEBUG LOGGING START ---
    console.error(`[Debug Config Pool] Invalid Address Format for fee ${feeBps}: '${address}'. Error: ${error.message}. Returning null.`);
    // --- DEBUG LOGGING END ---
    return null; // Return null for invalid addresses
  }
}


// --- Constants ---
const UNISWAP_V3_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const QUOTER_V2_ADDRESS = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e'; // Same across Optimism, Arbitrum, Polygon, Base

// Minimum profit threshold in WEI (e.g., 0.001 ETH for WETH pairs)
// Adjust this based on the quote token decimals
const MIN_NET_PROFIT_WEI = {
  WETH: ethers.parseUnits('0.0005', 18), // Example: 0.0005 WETH
  USDC: ethers.parseUnits('1', 6), // Example: 1 USDC
  USDT: ethers.parseUnits('1', 6), // Example: 1 USDT
};

// Flash loan fee, usually 0.09% for Uniswap V3 (check specific pools if different)
const FLASH_LOAN_FEE_BPS = 9; // 0.09% in Basis Points

// --- Network Specific Configurations ---

const ARBITRUM = {
  NAME: 'arbitrum',
  CHAIN_ID: 42161,
  RPC_URL: process.env.ARBITRUM_RPC_URL,
  FACTORY_ADDRESS: UNISWAP_V3_FACTORY,
  QUOTER_ADDRESS: QUOTER_V2_ADDRESS, // Use QUOTER_ADDRESS consistently
  FLASH_SWAP_CONTRACT_ADDRESS: ethers.getAddress(process.env.ARBITRUM_FLASH_SWAP_CONTRACT || ethers.ZeroAddress), // Use ZeroAddress as default
  TOKENS: {
    WETH: { address: ethers.getAddress('0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'), decimals: 18, symbol: 'WETH' },
    USDC: { address: ethers.getAddress('0xaf88d065e77c8cC2239327C5EDb3A432268e5831'), decimals: 6, symbol: 'USDC' },
    // USDT: { address: ethers.getAddress('0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9'), decimals: 6, symbol: 'USDT' }, // Arbitrum USDT has proxy, use implementation? Check usage.
  },
  POOL_GROUPS: {
    WETH_USDC: {
      token0: 'WETH', // Symbol for lookup in TOKENS
      token1: 'USDC', // Symbol for lookup in TOKENS
      pools: [
        pool(process.env.ARBITRUM_WETH_USDC_100_ADDRESS, 100), // 0.01%
        pool(process.env.ARBITRUM_WETH_USDC_500_ADDRESS, 500), // 0.05%
        pool(process.env.ARBITRUM_WETH_USDC_3000_ADDRESS, 3000), // 0.3%
        // pool(process.env.ARBITRUM_WETH_USDC_10000_ADDRESS, 10000), // 1% - if exists
      ].filter(p => p !== null), // Remove null entries from missing env vars or invalid addresses
      quoteTokenSymbol: 'USDC', // Used for MIN_NET_PROFIT_WEI lookup
    },
    // Add USDC_USDT group for Arbitrum if needed
    // USDC_USDT: { ... }
  },
  GAS_PRICE_MULTIPLIER: 1.2, // Optional: Increase estimated gas price by 20%
  BLOCK_TIME_MS: 1000, // Rough estimate
};

const POLYGON = {
  NAME: 'polygon',
  CHAIN_ID: 137,
  RPC_URL: process.env.POLYGON_RPC_URL,
  FACTORY_ADDRESS: UNISWAP_V3_FACTORY,
  QUOTER_ADDRESS: QUOTER_V2_ADDRESS, // Use QUOTER_ADDRESS consistently
  FLASH_SWAP_CONTRACT_ADDRESS: ethers.getAddress(process.env.POLYGON_FLASH_SWAP_CONTRACT || ethers.ZeroAddress), // Use ZeroAddress as default
  TOKENS: {
    WETH: { address: ethers.getAddress('0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619'), decimals: 18, symbol: 'WETH' },
    USDC: { address: ethers.getAddress('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'), decimals: 6, symbol: 'USDC' }, // USDC.e (Bridged) on Polygon PoS - common one
    // USDC_NATIVE: { address: ethers.getAddress('0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'), decimals: 6, symbol: 'USDC' }, // Native USDC on Polygon PoS - less common in pools? Check V3 info
    USDT: { address: ethers.getAddress('0xc2132D05D31c914a87C6611C10748AEb04B58e8F'), decimals: 6, symbol: 'USDT' },
  },
  POOL_GROUPS: {
    WETH_USDC: {
      token0: 'WETH',
      token1: 'USDC', // Assumes the bridged USDC above is used in pools
      pools: [
        pool(process.env.POLYGON_WETH_USDC_100_ADDRESS, 100), // 0.01% - Less common for WETH/USDC
        pool(process.env.POLYGON_WETH_USDC_500_ADDRESS, 500), // 0.05%
        pool(process.env.POLYGON_WETH_USDC_3000_ADDRESS, 3000), // 0.3%
        // pool(process.env.POLYGON_WETH_USDC_10000_ADDRESS, 10000), // 1% - if exists
      ].filter(p => p !== null),
      quoteTokenSymbol: 'USDC',
    },
    USDC_USDT: {
      token0: 'USDC', // Assumes the bridged USDC above is used in pools
      token1: 'USDT',
      pools: [
        pool(process.env.POLYGON_USDC_USDT_100_ADDRESS, 100), // 0.01%
        pool(process.env.POLYGON_USDC_USDT_500_ADDRESS, 500), // 0.05%
      ].filter(p => p !== null),
      quoteTokenSymbol: 'USDT', // Or USDC, depending on how you measure profit
    }
  },
  GAS_PRICE_MULTIPLIER: 1.5, // Optional: Polygon gas can spike
  BLOCK_TIME_MS: 2500,
};

const OPTIMISM = {
  NAME: 'optimism',
  CHAIN_ID: 10,
  RPC_URL: process.env.OPTIMISM_RPC_URL,
  FACTORY_ADDRESS: UNISWAP_V3_FACTORY,
  QUOTER_ADDRESS: QUOTER_V2_ADDRESS, // Use QUOTER_ADDRESS consistently
  FLASH_SWAP_CONTRACT_ADDRESS: ethers.getAddress(process.env.OPTIMISM_FLASH_SWAP_CONTRACT || ethers.ZeroAddress), // Use ZeroAddress as default
  TOKENS: {
    WETH: { address: ethers.getAddress('0x4200000000000000000000000000000000000006'), decimals: 18, symbol: 'WETH' },
    USDC: { address: ethers.getAddress('0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'), decimals: 6, symbol: 'USDC' }, // Native USDC on Optimism
    // USDC_LEGACY: { address: ethers.getAddress('0x7F5c764cBc14f9669B88837ca1490cCa17c31607'), decimals: 6, symbol: 'USDC.e' }, // Bridged USDC.e - check which one pools use
    USDT: { address: ethers.getAddress('0x94b008aA00579c1307B0EF2c499aD98a8ce58e58'), decimals: 6, symbol: 'USDT' },
  },
  POOL_GROUPS: {
    WETH_USDC: {
      token0: 'WETH',
      token1: 'USDC', // Assumes Native USDC above
      pools: [
        pool(process.env.OPTIMISM_WETH_USDC_100_ADDRESS, 100), // 0.01%
        pool(process.env.OPTIMISM_WETH_USDC_500_ADDRESS, 500), // 0.05%
        pool(process.env.OPTIMISM_WETH_USDC_3000_ADDRESS, 3000), // 0.3%
        // pool(process.env.OPTIMISM_WETH_USDC_10000_ADDRESS, 10000), // 1% - if exists
      ].filter(p => p !== null),
      quoteTokenSymbol: 'USDC',
    },
     USDC_USDT: {
       token0: 'USDC', // Assumes Native USDC above
       token1: 'USDT',
       pools: [
         pool(process.env.OPTIMISM_USDC_USDT_100_ADDRESS, 100), // 0.01%
         pool(process.env.OPTIMISM_USDC_USDT_500_ADDRESS, 500), // 0.05%
       ].filter(p => p !== null),
       quoteTokenSymbol: 'USDT', // Or USDC
     }
  },
  GAS_PRICE_MULTIPLIER: 1.1, // Optional: Optimism gas is usually stable but has L1 component
  BLOCK_TIME_MS: 2000,
};

const BASE = {
  NAME: 'base',
  CHAIN_ID: 8453,
  RPC_URL: process.env.BASE_RPC_URL,
  FACTORY_ADDRESS: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD', // Uniswap V3 Factory on Base
  QUOTER_ADDRESS: QUOTER_V2_ADDRESS, // Use QUOTER_ADDRESS consistently
  FLASH_SWAP_CONTRACT_ADDRESS: ethers.getAddress(process.env.BASE_FLASH_SWAP_CONTRACT || ethers.ZeroAddress), // Use ZeroAddress as default
  TOKENS: {
    WETH: { address: ethers.getAddress('0x4200000000000000000000000000000000000006'), decimals: 18, symbol: 'WETH' },
    USDC: { address: ethers.getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'), decimals: 6, symbol: 'USDC' }, // Native USDC on Base
    // USDT not officially bridged at time of writing, add later if available and pools exist
  },
  POOL_GROUPS: {
    WETH_USDC: {
      token0: 'WETH',
      token1: 'USDC',
      pools: [
        pool(process.env.BASE_WETH_USDC_100_ADDRESS, 100), // 0.01%
        pool(process.env.BASE_WETH_USDC_500_ADDRESS, 500), // 0.05%
        pool(process.env.BASE_WETH_USDC_3000_ADDRESS, 3000), // 0.3%
        // pool(process.env.BASE_WETH_USDC_10000_ADDRESS, 10000), // 1% - if exists
      ].filter(p => p !== null),
      quoteTokenSymbol: 'USDC',
    },
    // Add USDC_USDT group for Base if needed and pools exist
  },
  GAS_PRICE_MULTIPLIER: 1.1, // Optional
  BLOCK_TIME_MS: 2000,
};

// --- Active Configuration Selection ---

const ACTIVE_CONFIGS = {
  arbitrum: ARBITRUM,
  polygon: POLYGON,
  optimism: OPTIMISM,
  base: BASE,
};

const network = process.env.NETWORK?.toLowerCase();

if (!network || !ACTIVE_CONFIGS[network]) {
  throw new Error(
    `Invalid or missing NETWORK environment variable. Choose from: ${Object.keys(
      ACTIVE_CONFIGS
    ).join(', ')}`
  );
}

const config = ACTIVE_CONFIGS[network];
console.log(`Loaded configuration for network: ${config.NAME}`);

// --- Exports ---

module.exports = {
  config,
  MIN_NET_PROFIT_WEI,
  FLASH_LOAN_FEE_BPS,
  Token, // Export Token class for convenience
  Pool, // Export Pool class
  computePoolAddress, // Export computePoolAddress util
};
