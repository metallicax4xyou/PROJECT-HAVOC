// findPool.js
const { ethers } = require("ethers");
require('dotenv').config();

// Configuration
const RPC_URL = process.env.ARBITRUM_RPC_URL;
if (!RPC_URL) {
    console.error("ARBITRUM_RPC_URL must be set in .env file.");
    process.exit(1);
}

const FACTORY_ADDRESS = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const WETH_ADDRESS = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
// --- Use the NATIVE USDC address ---
const USDC_NATIVE_ADDRESS = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const FEE_TIER = 500; // For 0.05%

const FactoryABI = [
    "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)"
];

async function findPool() {
    console.log("Connecting to provider...");
    const provider = new ethers.JsonRpcProvider(RPC_URL);

    console.log(`Using Factory: ${FACTORY_ADDRESS}`);
    const factoryContract = new ethers.Contract(FACTORY_ADDRESS, FactoryABI, provider);

    console.log(`Querying for pool:`);
    console.log(`  Token A (WETH): ${WETH_ADDRESS}`);
    console.log(`  Token B (Native USDC): ${USDC_NATIVE_ADDRESS}`);
    console.log(`  Fee Tier: ${FEE_TIER} (0.05%)`);

    try {
        // Uniswap factory requires tokens sorted by address value
        const [token0, token1] = WETH_ADDRESS.toLowerCase() < USDC_NATIVE_ADDRESS.toLowerCase()
            ? [WETH_ADDRESS, USDC_NATIVE_ADDRESS]
            : [USDC_NATIVE_ADDRESS, WETH_ADDRESS];

        console.log(`\nCalling factory.getPool(${token0}, ${token1}, ${FEE_TIER})...`);

        const poolAddress = await factoryContract.getPool(token0, token1, FEE_TIER);

        console.log("\n==============================================");
        if (poolAddress && poolAddress !== ethers.ZeroAddress) {
            console.log(`✅ Found Pool Address (WETH/Native USDC 0.05%):`);
            console.log(`   ${poolAddress}`);
            console.log(`   (Use this address (lowercase) for POOL_A_ADDRESS in bot.js)`);
        } else {
            console.log(`❌ Pool not found or not deployed for this pair/fee tier.`);
            console.log(`   Returned Address: ${poolAddress}`);
        }
        console.log("==============================================");

    } catch (error) {
        console.error("\nError querying factory:", error);
    }
}

findPool();
