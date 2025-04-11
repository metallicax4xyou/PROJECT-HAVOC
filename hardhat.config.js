// hardhat.config.js

// --- Imports ---
require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config(); // Load .env file
const { task } = require("hardhat/config"); // Import task function

// --- Environment Variable Checks ---
// Load all potential variables
const ARBITRUM_RPC_URL = process.env.ARBITRUM_RPC_URL;
const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL;
const BASE_RPC_URL = process.env.BASE_RPC_URL;
const OPTIMISM_RPC_URL = process.env.OPTIMISM_RPC_URL;

const PRIVATE_KEY = process.env.PRIVATE_KEY; // Shared private key for all networks

const ARBISCAN_API_KEY = process.env.ARBISCAN_API_KEY;
const POLYGONSCAN_API_KEY = process.env.POLYGONSCAN_API_KEY;
const BASESCAN_API_KEY = process.env.BASESCAN_API_KEY;
const OPTIMISMSCAN_API_KEY = process.env.OPTIMISMSCAN_API_KEY;

const MAINNET_FORK_URL = process.env.MAINNET_FORK_URL; // Optional

// --- Custom Hardhat Tasks ---
// Keep existing tasks: checkBalance, testQuote, checkPools, debugQuote, findBestQuote
// ... (Paste your existing task definitions here) ...
task("checkBalance", "Prints the ETH balance of the deployer account configured for the specified network")
  .setAction(async (taskArgs, hre) => { /* ...task code... */ });
task("testQuote", "Tests QuoterV2 quote for a specific hardcoded scenario using quoteExactInputSingle")
  .setAction(async (taskArgs, hre) => { /* ...task code... */ });
task("checkPools", "Checks if specific WETH/USDC pools exist on the network")
  .setAction(async (taskArgs, hre) => { /* ...task code... */ });
task("debugQuote", "Debug quotes using Arbitrum Quoter V2 and quoteExactInput")
  .addParam("tokenIn", "Input token address")
  .addParam("tokenOut", "Output token address")
  .addParam("amount", "Amount in smallest units (wei)")
  .setAction(async (taskArgs, hre) => { /* ...task code... */ });
task("findBestQuote", "Finds the best quote across common fee tiers using Quoter V2")
  .addParam("tokenIn", "Input token address")
  .addParam("tokenOut", "Output token address")
  .addParam("amount", "Amount in smallest units (wei)")
  .addOptionalParam("decimalsOut", "Decimals of the output token", "6")
  .setAction(async (taskArgs, hre) => { /* ...task code... */ });


// --- Hardhat Configuration ---

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: { // Keep solidity config
    compilers: [ { version: "0.7.6", settings: { optimizer: { enabled: true, runs: 9999 } } } ],
  },
  defaultNetwork: "hardhat", // Optional: Set a default network
  networks: {
    hardhat: { // Keep hardhat config
       ...(MAINNET_FORK_URL && { forking: { url: MAINNET_FORK_URL } }),
    },
    // --- Arbitrum ---
    arbitrum: {
      url: ARBITRUM_RPC_URL || "",
      accounts: PRIVATE_KEY ? [`0x${PRIVATE_KEY}`] : [],
      chainId: 42161,
      timeout: 120000,
    },
    // --- Polygon ---
    polygon: {
      url: POLYGON_RPC_URL || "",
      accounts: PRIVATE_KEY ? [`0x${PRIVATE_KEY}`] : [],
      chainId: 137,
      // gasPrice: 80000000000, // Optional: Set gas price if needed for Polygon legacy txns
      timeout: 120000,
    },
    // --- Base ---
    base: {
      url: BASE_RPC_URL || "",
      accounts: PRIVATE_KEY ? [`0x${PRIVATE_KEY}`] : [],
      chainId: 8453,
      timeout: 120000,
    },
     // --- Optimism ---
    optimism: {
      url: OPTIMISM_RPC_URL || "",
      accounts: PRIVATE_KEY ? [`0x${PRIVATE_KEY}`] : [],
      chainId: 10,
      // gasPrice: 1000000, // Optional: Optimism gas price setting if needed
      timeout: 120000,
    },
  },
  paths: { // Keep paths config
    sources: "./contracts", tests: "./test", cache: "./cache", artifacts: "./artifacts",
  },
  etherscan: {
    apiKey: { // Add API keys for all networks
       arbitrumOne: ARBISCAN_API_KEY || "",
       polygon: POLYGONSCAN_API_KEY || "",
       base: BASESCAN_API_KEY || "", // Use 'base' as the key
       optimisticEthereum: OPTIMISMSCAN_API_KEY || "",
    },
     // Add custom chain definition for Base verification
     customChains: [
        {
          network: "base",
          chainId: 8453,
          urls: {
            apiURL: "https://api.basescan.org/api",
            browserURL: "https://basescan.org"
          }
        }
      ]
  },
  gasReporter: { // Keep gas reporter config
    enabled: process.env.REPORT_GAS === "true", currency: "USD", coinmarketcap: process.env.COINMARKETCAP_API_KEY, token: 'ETH',
  },
};
