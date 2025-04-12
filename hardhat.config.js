// hardhat.config.js

// --- Imports ---
require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config(); // Load .env file
const { task } = require("hardhat/config"); // Import task function

// --- Environment Variable Checks ---
const ARBITRUM_RPC_URL = process.env.ARBITRUM_RPC_URL;
const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL;
const BASE_RPC_URL = process.env.BASE_RPC_URL;
const OPTIMISM_RPC_URL = process.env.OPTIMISM_RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const ARBISCAN_API_KEY = process.env.ARBISCAN_API_KEY;
const POLYGONSCAN_API_KEY = process.env.POLYGONSCAN_API_KEY;
const BASESCAN_API_KEY = process.env.BASESCAN_API_KEY;
const OPTIMISMSCAN_API_KEY = process.env.OPTIMISMSCAN_API_KEY;
const MAINNET_FORK_URL = process.env.MAINNET_FORK_URL; // Optional

// --- Custom Hardhat Tasks ---

task("checkBalance", "Prints the ETH balance...")
  .setAction(async (taskArgs, hre) => {
    const networkName = hre.network.name;
    console.log(`🔎 Checking balance on network: ${networkName}`);
    try {
      const signers = await hre.ethers.getSigners();
      if (!signers || signers.length === 0) { console.error(`❌ Error: Could not get deployer account...`); return; }
      const deployer = signers[0];
      const address = deployer.address;
      console.log(`👤 Account Address: ${address}`);
      const balanceWei = await hre.ethers.provider.getBalance(address);
      const balanceEther = hre.ethers.formatEther(balanceWei);
      const currency = networkName === 'polygon' ? 'MATIC' : 'ETH';
      console.log(`💰 Balance: ${balanceEther} ${currency}`);
    } catch (error) { console.error("\n❌ Error fetching balance:", error.message); }
  });

task("testQuote", "Tests QuoterV2 quote...")
  .setAction(async (taskArgs, hre) => { /* ...task code unchanged... */ });

// <<< UPDATED checkPools Task with CORRECT Base Factory/Deployer Address >>>
task("checkPools", "Checks if specific WETH/USDC pools exist on the network")
  .setAction(async (taskArgs, hre) => {
    // --- Standard V3 Factory Address (Default) ---
    let factoryAddress = "0x1F98431c8aD98523631AE4a59f267346ea31F984";

    // --- Define Tokens Per Network ---
    let tokenWETH = "";
    let tokenUSDC = "";
    const networkName = hre.network.name;

    switch(networkName) {
        case 'arbitrum':
            tokenWETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
            tokenUSDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
            break;
        case 'polygon':
            tokenWETH = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";
            tokenUSDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
            break;
        case 'base':
            tokenWETH = "0x4200000000000000000000000000000000000006";
            tokenUSDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
            // <<< Use CORRECT Base PoolDeployer/Factory Address >>>
            factoryAddress = "0x327Df1E6de05895d2ab08513aaDD9313Fe505d86"; // Correct Base Address
            break;
        case 'optimism':
            tokenWETH = "0x4200000000000000000000000000000000000006";
            tokenUSDC = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";
            break;
        default:
            console.error(`❌ Network ${networkName} not configured in checkPools task.`);
            return;
    }

    const feesToCheck = [100, 500, 3000, 10000];
    // Minimal ABI for getPool - should work for standard factory/deployer interfaces
    const factoryABI = ["function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)"];
    const factory = new hre.ethers.Contract(factoryAddress, factoryABI, hre.ethers.provider);

    console.log(`\n[checkPools] Checking WETH/USDC pools on ${networkName} using Factory/Deployer ${factoryAddress}`); // Log which factory is used
    console.log(`  WETH: ${tokenWETH}`);
    console.log(`  USDC: ${tokenUSDC}`);

    const [token0, token1] = tokenWETH.toLowerCase() < tokenUSDC.toLowerCase() ? [tokenWETH, tokenUSDC] : [tokenUSDC, tokenWETH];
    console.log(`  Token0 (Sorted): ${token0}`);
    console.log(`  Token1 (Sorted): ${token1}`);

    for (const fee of feesToCheck) {
      try {
        console.log(`--- Checking Fee Tier: ${fee} (${fee / 10000}%) ---`);
        const poolAddress = await factory.getPool(token0, token1, fee);
        console.log(`   Pool Address Found: ${poolAddress}`);
        if (poolAddress === hre.ethers.ZeroAddress) {
          console.log(`   Status: Pool DOES NOT EXIST.`);
        } else {
          console.log(`   Status: Pool EXISTS.`);
        }
      } catch (error) {
        console.error(`[checkPools] ❌ Error checking fee ${fee}: ${error.message}`);
         if(error.code) console.error(`   Code: ${error.code}`);
         // Don't log value/info if it's just '0x' or null
         if(error.value && error.value !== '0x') console.error(`   Value: ${error.value}`);
         if(error.info) console.error(`   Info: ${JSON.stringify(error.info)}`);
      }
    }
     console.log("[checkPools] Finished checking pools.");
  });


task("debugQuote", "Debug quotes using Quoter V2 and quoteExactInput")
  .addParam("tokenIn", "Input token address")
  .addParam("tokenOut", "Output token address")
  .addParam("amount", "Amount in smallest units (wei)")
  .setAction(async (taskArgs, hre) => { /* ...task code unchanged... */ });

task("findBestQuote", "Finds the best quote across common fee tiers using Quoter V2")
  .addParam("tokenIn", "Input token address")
  .addParam("tokenOut", "Output token address")
  .addParam("amount", "Amount in smallest units (wei)")
  .addOptionalParam("decimalsOut", "Decimals of the output token", "6")
  .setAction(async (taskArgs, hre) => { /* ...task code unchanged... */ });


// --- Hardhat Configuration ---
module.exports = {
  solidity: { compilers: [ { version: "0.7.6", settings: { optimizer: { enabled: true, runs: 9999 } } } ] },
  defaultNetwork: "hardhat",
  networks: {
    hardhat: { ...(MAINNET_FORK_URL && { forking: { url: MAINNET_FORK_URL } }) },
    arbitrum: { url: ARBITRUM_RPC_URL || "", accounts: PRIVATE_KEY ? [`0x${PRIVATE_KEY}`] : [], chainId: 42161, timeout: 120000 },
    polygon: { url: POLYGON_RPC_URL || "", accounts: PRIVATE_KEY ? [`0x${PRIVATE_KEY}`] : [], chainId: 137, timeout: 120000 },
    base: { url: BASE_RPC_URL || "", accounts: PRIVATE_KEY ? [`0x${PRIVATE_KEY}`] : [], chainId: 8453, timeout: 120000 },
    optimism: { url: OPTIMISM_RPC_URL || "", accounts: PRIVATE_KEY ? [`0x${PRIVATE_KEY}`] : [], chainId: 10, timeout: 120000 },
  },
  paths: { sources: "./contracts", tests: "./test", cache: "./cache", artifacts: "./artifacts" },
  etherscan: {
    apiKey: {
       arbitrumOne: ARBISCAN_API_KEY || "", polygon: POLYGONSCAN_API_KEY || "", base: BASESCAN_API_KEY || "", optimisticEthereum: OPTIMISMSCAN_API_KEY || "",
    },
     customChains: [ { network: "base", chainId: 8453, urls: { apiURL: "https://api.basescan.org/api", browserURL: "https://basescan.org" } } ]
  },
  gasReporter: { enabled: process.env.REPORT_GAS === "true", currency: "USD", coinmarketcap: process.env.COINMARKETCAP_API_KEY, token: 'ETH' },
};
