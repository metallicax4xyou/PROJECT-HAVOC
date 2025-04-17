// scripts/checkPoolReserves.js

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') }); // Load .env from root
const { ethers } = require('ethers');
const IUniswapV3PoolABI = require('@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json').abi;
const IERC20MinimalABI = require('@openzeppelin/contracts/build/contracts/ERC20Minimal.json').abi; // For fetching decimals/symbol (optional)
const { Token } = require('@uniswap/sdk-core');
const { TOKENS } = require('../constants/tokens'); // Load token definitions

// --- Configuration ---
// Manually list pool addresses to check (or load from config/env)
const POOL_ADDRESSES_TO_CHECK = [
    // WETH-USDC Pools from your .env
    "0x6f38e884725a116C9C7fBF208e79FE8828a2595F", // 100 bps
    "0xC6962004f452bE9203591991D15f6b388e09E8D0", // 500 bps
    "0xc473e2aEE3441BF9240Be85eb122aBB059A3B57c", // 3000 bps
    "0x42FC852A750BA93D5bf772ecdc857e87a86403a9", // 10000 bps
    // USDC-USDT Pools from your .env
    "0xbE3aD6a5669Dc0B8b12FeBC03608860C31E2eef6", // 100 bps
    "0xbcE73c2e5A623054B0e8e2428E956f4b9d0412a5", // 500 bps
];

const RPC_URL = process.env.ARBITRUM_RPC_URLS; // Use the plural version from .env
const CHAIN_ID = 42161; // Arbitrum
// --- End Configuration ---


if (!RPC_URL) {
    console.error("Error: ARBITRUM_RPC_URLS not found in environment variables.");
    process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);

// Helper to get token info (symbol/decimals) - caches results
const tokenInfoCache = {};
async function getTokenInfo(address) {
    address = ethers.getAddress(address); // Normalize address
    if (tokenInfoCache[address]) {
        return tokenInfoCache[address];
    }
    try {
        // First check our known TOKENS constant
        for (const symbol in TOKENS) {
            if (TOKENS[symbol].address.toLowerCase() === address.toLowerCase()) {
                 console.log(`Found ${symbol} in TOKENS constant for ${address}`);
                 tokenInfoCache[address] = { symbol: TOKENS[symbol].symbol, decimals: TOKENS[symbol].decimals };
                 return tokenInfoCache[address];
            }
        }
        // Fallback: Query contract if not in constants
        console.log(`Querying contract info for ${address}...`);
        const contract = new ethers.Contract(address, IERC20MinimalABI, provider);
        const [symbol, decimals] = await Promise.all([
            contract.symbol(),
            contract.decimals()
        ]);
        tokenInfoCache[address] = { symbol, decimals: Number(decimals) }; // Store decimals as number
        return tokenInfoCache[address];
    } catch (error) {
        console.warn(`Could not fetch token info for ${address}: ${error.message}. Using defaults.`);
        // Return defaults if fetch fails
        tokenInfoCache[address] = { symbol: address.substring(0, 6), decimals: 18 };
        return tokenInfoCache[address];
    }
}


async function checkPoolReserves() {
    console.log(`Checking reserves for ${POOL_ADDRESSES_TO_CHECK.length} pools on Arbitrum via ${RPC_URL}...\n`);

    for (const poolAddress of POOL_ADDRESSES_TO_CHECK) {
        if (!ethers.isAddress(poolAddress)) {
            console.log(`Skipping invalid address: ${poolAddress}`);
            continue;
        }
        console.log(`--- Pool: ${poolAddress} ---`);
        try {
            const poolContract = new ethers.Contract(poolAddress, IUniswapV3PoolABI, provider);

            // Fetch token addresses and fee concurrently
            const [token0Addr, token1Addr, fee] = await Promise.all([
                poolContract.token0(),
                poolContract.token1(),
                poolContract.fee()
            ]);

            console.log(`Fee Tier: ${fee.toString()} bps`);

            // Fetch token details (symbol/decimals) concurrently
            const [token0Info, token1Info] = await Promise.all([
                getTokenInfo(token0Addr),
                getTokenInfo(token1Addr)
            ]);

            console.log(`Token0: ${token0Info.symbol} (${token0Addr}, ${token0Info.decimals} decimals)`);
            console.log(`Token1: ${token1Info.symbol} (${token1Addr}, ${token1Info.decimals} decimals)`);

            // Fetch current liquidity (optional, as reserves are more direct for v2-style check)
            // const liquidity = await poolContract.liquidity();
            // console.log(`Current Liquidity (Uint128): ${liquidity.toString()}`);

            // Fetch reserves by checking token balances OF the pool contract
            const token0Contract = new ethers.Contract(token0Addr, IERC20MinimalABI, provider);
            const token1Contract = new ethers.Contract(token1Addr, IERC20MinimalABI, provider);

            const [reserve0, reserve1] = await Promise.all([
                token0Contract.balanceOf(poolAddress),
                token1Contract.balanceOf(poolAddress)
            ]);

            console.log(`Reserve ${token0Info.symbol}: ${ethers.formatUnits(reserve0, token0Info.decimals)}`);
            console.log(`Reserve ${token1Info.symbol}: ${ethers.formatUnits(reserve1, token1Info.decimals)}`);
            console.log(`-----------------------------------\n`);

        } catch (error) {
            console.error(`Error checking pool ${poolAddress}: ${error.message}`);
             if (error.code) console.error(`   Code: ${error.code}`);
             console.log(`-----------------------------------\n`);
        }
    }
}

checkPoolReserves().catch(err => {
    console.error("Script failed:", err);
    process.exit(1);
});
