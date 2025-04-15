// scripts/getPoolAddress.js
const { ethers } = require('ethers');
require('dotenv').config(); // Load .env for RPC_URL

// --- Configuration ---
const FACTORY_ADDRESS = '0x1F98431c8aD98523631AE4a59f267346ea31F984'; // Standard V3 Factory
const ARBITRUM_RPC_URL = process.env.ARBITRUM_RPC_URL;

// Define the tokens and fees we want to find pools for
const TOKEN_PAIRS = [
    {
        name: 'WETH/USDC',
        tokenA: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // WETH
        tokenB: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // USDC
        fees: [100, 500, 3000, 10000] // 0.01%, 0.05%, 0.3%, 1%
    },
    {
        name: 'USDC/USDT',
        tokenA: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // USDC
        tokenB: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', // USDT
        fees: [100, 500] // 0.01%, 0.05%
    }
    // Add other pairs if needed
];

const FACTORY_ABI = [
    // Minimal ABI with getPool function
    "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)"
];
// --- End Configuration ---

async function findPoolAddresses() {
    if (!ARBITRUM_RPC_URL) {
        console.error("Error: ARBITRUM_RPC_URL not found in .env file.");
        return;
    }

    console.log("Connecting to Arbitrum RPC...");
    const provider = new ethers.JsonRpcProvider(ARBITRUM_RPC_URL);

    try {
        await provider.getBlockNumber(); // Test connection
        console.log("RPC Connection successful.");
    } catch (e) {
        console.error(`Error connecting to RPC: ${e.message}`);
        return;
    }

    const factoryContract = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, provider);
    console.log(`Querying Factory: ${FACTORY_ADDRESS}\n`);

    console.log("=== Calculated Pool Addresses (from Factory) ===");

    for (const pair of TOKEN_PAIRS) {
        console.log(`--- Pair: ${pair.name} ---`);
        for (const fee of pair.fees) {
            try {
                const poolAddress = await factoryContract.getPool(pair.tokenA, pair.tokenB, fee);

                // Generate the expected .env variable name
                const tokenASymbol = pair.tokenA.slice(-6); // Just for indicative naming
                const tokenBSymbol = pair.tokenB.slice(-6); // Just for indicative naming
                // Construct a representative name (adapt if needed based on actual config keys)
                const envVarName = `ARBITRUM_${pair.name.replace('/', '_')}_${fee}_ADDRESS`; // e.g., ARBITRUM_WETH_USDC_500_ADDRESS

                if (poolAddress !== ethers.ZeroAddress) {
                    console.log(`${envVarName}=${poolAddress}  # Fee: ${fee/10000}%`);
                } else {
                    console.log(`# ${envVarName}= NO POOL FOUND for Fee ${fee}`);
                }
            } catch (error) {
                console.error(`Error querying pool for ${pair.name} Fee ${fee}: ${error.message}`);
            }
        }
        console.log(""); // Newline for readability
    }
    console.log("==============================================");
    console.log("Copy the lines above (starting with ARBITRUM_) and paste them into your .env file, replacing existing pool address lines.");
}

findPoolAddresses().catch(console.error);
