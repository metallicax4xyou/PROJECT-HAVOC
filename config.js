// config.js
require('dotenv').config();
const { ethers } = require('ethers');
const { Pool, computePoolAddress } = require('@uniswap/v3-sdk');
const { Token } = require('@uniswap/sdk-core');

// --- Helper Function to Create Pool Config Objects ---
function pool(address, feeBps) {
    // console.log(`[Debug Config Pool] feeBps: ${feeBps}, Input Address: '${address}' (Type: ${typeof address})`);
    if (!address || typeof address !== 'string' || address.trim() === '') {
        // console.warn(`[Debug Config Pool] Null/Empty/Invalid Address for fee ${feeBps}. Returning null.`);
        return null;
    }
    try {
        const checksummedAddress = ethers.getAddress(address.trim());
        // console.log(`[Debug Config Pool] Valid Address for fee ${feeBps}. Checksummed: ${checksummedAddress}`);
        return {
            address: checksummedAddress,
            feeBps: parseInt(feeBps, 10),
        };
    } catch (error) {
        // console.error(`[Debug Config Pool] Invalid Address Format for fee ${feeBps}: '${address}'. Error: ${error.message}. Returning null.`);
        return null;
    }
}

// --- Constants ---
const UNISWAP_V3_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const QUOTER_V2_ADDRESS = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e'; // Same across multiple chains

// Minimum profit threshold in WEI (e.g., 0.001 ETH for WETH pairs)
// Keyed by token SYMBOL
const MIN_NET_PROFIT_WEI = {
    WETH: ethers.parseUnits(process.env.MIN_PROFIT_WETH || '0.0005', 18), // Example: 0.0005 WETH (configurable via .env)
    USDC: ethers.parseUnits(process.env.MIN_PROFIT_USDC || '1', 6),      // Example: 1 USDC (configurable via .env)
    USDT: ethers.parseUnits(process.env.MIN_PROFIT_USDT || '1', 6),      // Example: 1 USDT (configurable via .env)
};

// Flash loan fee, usually 0.09% for Uniswap V3
const FLASH_LOAN_FEE_BPS = 9; // 0.09% in Basis Points

// Estimated Gas Limit (Read from .env, provide a default)
const GAS_LIMIT_ESTIMATE = BigInt(process.env.GAS_LIMIT_ESTIMATE || '1000000');

// Borrow Amounts (Read from .env, provide defaults)
// Keyed by token SYMBOL
const BORROW_AMOUNTS_WEI = {
    WETH: ethers.parseUnits(process.env.BORROW_AMOUNT_WETH_WEI || '100000000000000000', 18), // Default 0.1 WETH
    USDC: ethers.parseUnits(process.env.BORROW_AMOUNT_USDC_WEI || '100000000', 6),          // Default 100 USDC
    USDT: ethers.parseUnits(process.env.BORROW_AMOUNT_USDT_WEI || '100000000', 6),          // Default 100 USDT
};

// --- Network Specific Configurations ---

const ARBITRUM = {
    NAME: 'arbitrum',
    CHAIN_ID: 42161,
    NATIVE_SYMBOL: 'ETH', // Added for gas cost display
    RPC_URL: process.env.ARBITRUM_RPC_URL,
    FACTORY_ADDRESS: UNISWAP_V3_FACTORY,
    QUOTER_ADDRESS: QUOTER_V2_ADDRESS,
    FLASH_SWAP_CONTRACT_ADDRESS: process.env.ARBITRUM_FLASH_SWAP_ADDRESS ? ethers.getAddress(process.env.ARBITRUM_FLASH_SWAP_ADDRESS) : ethers.ZeroAddress,
    TOKENS: {
        WETH: { address: ethers.getAddress('0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'), decimals: 18, symbol: 'WETH' },
        USDC: { address: ethers.getAddress('0xaf88d065e77c8cC2239327C5EDb3A432268e5831'), decimals: 6, symbol: 'USDC' },
        USDT: { address: ethers.getAddress('0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9'), decimals: 6, symbol: 'USDT' },
    },
    POOL_GROUPS: {
        WETH_USDC: {
            token0Symbol: 'WETH',
            token1Symbol: 'USDC',
            borrowTokenSymbol: 'WETH', // Suggest borrowing WETH for this pair
            quoteTokenSymbol: 'USDC', // Used for MIN_NET_PROFIT_WEI lookup if needed, or profit reporting
            pools: [
                pool(process.env.ARBITRUM_WETH_USDC_100_ADDRESS, 100), // 0.01%
                pool(process.env.ARBITRUM_WETH_USDC_500_ADDRESS, 500), // 0.05%
                pool(process.env.ARBITRUM_WETH_USDC_3000_ADDRESS, 3000), // 0.3%
                pool(process.env.ARBITRUM_WETH_USDC_10000_ADDRESS, 10000), // 1%
            ].filter(p => p !== null),
        },
        USDC_USDT: { // Example stable pair
            token0Symbol: 'USDC',
            token1Symbol: 'USDT',
            borrowTokenSymbol: 'USDC', // Suggest borrowing USDC (often higher liquidity)
            quoteTokenSymbol: 'USDC', // Or USDT, define how you measure profit
            pools: [
                pool(process.env.ARBITRUM_USDC_USDT_100_ADDRESS, 100), // 0.01%
                pool(process.env.ARBITRUM_USDC_USDT_500_ADDRESS, 500), // 0.05%
            ].filter(p => p !== null),
        }
    },
    GAS_PRICE_MULTIPLIER: 1.2, // Optional: Increase estimated gas price by 20%
    BLOCK_TIME_MS: 1000, // Rough estimate
};

const POLYGON = {
    NAME: 'polygon',
    CHAIN_ID: 137,
    NATIVE_SYMBOL: 'MATIC', // Added for gas cost display
    RPC_URL: process.env.POLYGON_RPC_URL,
    FACTORY_ADDRESS: UNISWAP_V3_FACTORY,
    QUOTER_ADDRESS: QUOTER_V2_ADDRESS,
    FLASH_SWAP_CONTRACT_ADDRESS: process.env.POLYGON_FLASH_SWAP_ADDRESS ? ethers.getAddress(process.env.POLYGON_FLASH_SWAP_ADDRESS) : ethers.ZeroAddress,
    TOKENS: {
        WETH: { address: ethers.getAddress('0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619'), decimals: 18, symbol: 'WETH' },
        USDC: { address: ethers.getAddress('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'), decimals: 6, symbol: 'USDC' }, // USDC.e (Bridged) common
        USDT: { address: ethers.getAddress('0xc2132D05D31c914a87C6611C10748AEb04B58e8F'), decimals: 6, symbol: 'USDT' },
    },
    POOL_GROUPS: {
        WETH_USDC: {
            token0Symbol: 'WETH',
            token1Symbol: 'USDC',
            borrowTokenSymbol: 'WETH',
            quoteTokenSymbol: 'USDC',
            pools: [
                pool(process.env.POLYGON_WETH_USDC_500_ADDRESS, 500), // 0.05%
                pool(process.env.POLYGON_WETH_USDC_3000_ADDRESS, 3000), // 0.3%
            ].filter(p => p !== null),
        },
        USDC_USDT: {
            token0Symbol: 'USDC',
            token1Symbol: 'USDT',
            borrowTokenSymbol: 'USDC',
            quoteTokenSymbol: 'USDT',
            pools: [
                pool(process.env.POLYGON_USDC_USDT_100_ADDRESS, 100), // 0.01%
                pool(process.env.POLYGON_USDC_USDT_500_ADDRESS, 500), // 0.05%
            ].filter(p => p !== null),
        }
    },
    GAS_PRICE_MULTIPLIER: 1.5, // Optional: Polygon gas can spike
    BLOCK_TIME_MS: 2500,
};

const OPTIMISM = {
    NAME: 'optimism',
    CHAIN_ID: 10,
    NATIVE_SYMBOL: 'ETH', // Added for gas cost display
    RPC_URL: process.env.OPTIMISM_RPC_URL,
    FACTORY_ADDRESS: UNISWAP_V3_FACTORY,
    QUOTER_ADDRESS: QUOTER_V2_ADDRESS,
    FLASH_SWAP_CONTRACT_ADDRESS: process.env.OPTIMISM_FLASH_SWAP_ADDRESS ? ethers.getAddress(process.env.OPTIMISM_FLASH_SWAP_ADDRESS) : ethers.ZeroAddress,
    TOKENS: {
        WETH: { address: ethers.getAddress('0x4200000000000000000000000000000000000006'), decimals: 18, symbol: 'WETH' },
        USDC: { address: ethers.getAddress('0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'), decimals: 6, symbol: 'USDC' }, // Native USDC on Optimism
        USDT: { address: ethers.getAddress('0x94b008aA00579c1307B0EF2c499aD98a8ce58e58'), decimals: 6, symbol: 'USDT' },
    },
    POOL_GROUPS: {
        WETH_USDC: {
            token0Symbol: 'WETH',
            token1Symbol: 'USDC',
            borrowTokenSymbol: 'WETH',
            quoteTokenSymbol: 'USDC',
            pools: [
                pool(process.env.OPTIMISM_WETH_USDC_500_ADDRESS, 500), // 0.05%
                pool(process.env.OPTIMISM_WETH_USDC_3000_ADDRESS, 3000), // 0.3%
            ].filter(p => p !== null),
        },
         USDC_USDT: {
           token0Symbol: 'USDC',
           token1Symbol: 'USDT',
           borrowTokenSymbol: 'USDC',
           quoteTokenSymbol: 'USDT',
           pools: [
             pool(process.env.OPTIMISM_USDC_USDT_100_ADDRESS, 100), // 0.01%
             pool(process.env.OPTIMISM_USDC_USDT_500_ADDRESS, 500), // 0.05%
           ].filter(p => p !== null),
         }
    },
    GAS_PRICE_MULTIPLIER: 1.1, // Optional
    BLOCK_TIME_MS: 2000,
};

const BASE = {
    NAME: 'base',
    CHAIN_ID: 8453,
    NATIVE_SYMBOL: 'ETH', // Added for gas cost display
    RPC_URL: process.env.BASE_RPC_URL,
    FACTORY_ADDRESS: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD', // Uniswap V3 Factory on Base
    QUOTER_ADDRESS: QUOTER_V2_ADDRESS,
    FLASH_SWAP_CONTRACT_ADDRESS: process.env.BASE_FLASH_SWAP_ADDRESS ? ethers.getAddress(process.env.BASE_FLASH_SWAP_ADDRESS) : ethers.ZeroAddress,
    TOKENS: {
        WETH: { address: ethers.getAddress('0x4200000000000000000000000000000000000006'), decimals: 18, symbol: 'WETH' },
        USDC: { address: ethers.getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'), decimals: 6, symbol: 'USDC' }, // Native USDC on Base
    },
    POOL_GROUPS: {
        WETH_USDC: {
            token0Symbol: 'WETH',
            token1Symbol: 'USDC',
            borrowTokenSymbol: 'WETH',
            quoteTokenSymbol: 'USDC',
            pools: [
                pool(process.env.BASE_WETH_USDC_500_ADDRESS, 500), // 0.05%
                pool(process.env.BASE_WETH_USDC_3000_ADDRESS, 3000), // 0.3%
            ].filter(p => p !== null),
        },
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

const activeConfig = { ...ACTIVE_CONFIGS[network] }; // Create a mutable copy

// --- Augment Active Config with Global Settings ---
activeConfig.GAS_LIMIT_ESTIMATE = GAS_LIMIT_ESTIMATE;
activeConfig.BORROW_AMOUNTS_WEI = BORROW_AMOUNTS_WEI; // Add borrow amounts map
activeConfig.MIN_NET_PROFIT_WEI = MIN_NET_PROFIT_WEI; // Add min profit map
activeConfig.FLASH_LOAN_FEE_BPS = FLASH_LOAN_FEE_BPS; // Add flash fee
activeConfig.Token = Token; // Add Token class
activeConfig.Pool = Pool; // Add Pool class
activeConfig.computePoolAddress = computePoolAddress; // Add util

// --- Add Token Objects to POOL_GROUPS for easier access ---
for (const groupKey in activeConfig.POOL_GROUPS) {
    const group = activeConfig.POOL_GROUPS[groupKey];
    group.token0 = activeConfig.TOKENS[group.token0Symbol];
    group.token1 = activeConfig.TOKENS[group.token1Symbol];
    group.borrowToken = activeConfig.TOKENS[group.borrowTokenSymbol];
    group.quoteToken = activeConfig.TOKENS[group.quoteTokenSymbol]; // Token object for profit reporting/checking

    // Validate that tokens exist
    if (!group.token0 || !group.token1 || !group.borrowToken || !group.quoteToken) {
         throw new Error(`Configuration Error: Invalid token symbols defined for POOL_GROUP "${groupKey}" on network ${activeConfig.NAME}. Check TOKENS definition and group symbols.`);
    }
    // Validate borrow amount exists for the designated borrow token
    if (!activeConfig.BORROW_AMOUNTS_WEI[group.borrowTokenSymbol]) {
         throw new Error(`Configuration Error: BORROW_AMOUNTS_WEI not defined for borrow token symbol "${group.borrowTokenSymbol}" in POOL_GROUP "${groupKey}". Add BORROW_AMOUNT_${group.borrowTokenSymbol}_WEI to .env`);
    }
    // Add borrow amount directly to group for convenience
    group.borrowAmount = activeConfig.BORROW_AMOUNTS_WEI[group.borrowTokenSymbol];

     // Add min profit for the specified quote token
    if (activeConfig.MIN_NET_PROFIT_WEI[group.quoteTokenSymbol]) {
        group.minNetProfit = activeConfig.MIN_NET_PROFIT_WEI[group.quoteTokenSymbol];
    } else {
        console.warn(`[Config] Warning: MIN_NET_PROFIT_WEI not configured for quote token ${group.quoteTokenSymbol} in group ${groupKey}. Net profit checks might be inaccurate.`);
        group.minNetProfit = 0n; // Default to 0 if not specified
    }
}

console.log(`Loaded configuration for network: ${activeConfig.NAME}`);
console.log(` - Gas Limit Estimate: ${activeConfig.GAS_LIMIT_ESTIMATE.toString()}`);
console.log(` - Flash Loan Fee: ${activeConfig.FLASH_LOAN_FEE_BPS / 100}%`);
console.log(` - Borrow Amounts (WEI):`);
for (const symbol in activeConfig.BORROW_AMOUNTS_WEI) {
    console.log(`   - ${symbol}: ${activeConfig.BORROW_AMOUNTS_WEI[symbol].toString()}`);
}
console.log(` - Min Net Profit (WEI):`);
 for (const symbol in activeConfig.MIN_NET_PROFIT_WEI) {
     console.log(`   - ${symbol}: ${activeConfig.MIN_NET_PROFIT_WEI[symbol].toString()}`);
 }

// --- Exports ---
// Export the fully augmented, active network configuration directly
module.exports = activeConfig;
