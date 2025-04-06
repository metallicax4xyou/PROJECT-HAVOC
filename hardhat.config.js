// hardhat.config.js

// --- Imports ---
require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config(); // Load .env file
const { task } = require("hardhat/config"); // Import task function

// --- Environment Variable Checks ---
const ARBITRUM_RPC_URL = process.env.ARBITRUM_RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const ARBISCAN_API_KEY = process.env.ARBISCAN_API_KEY;
const MAINNET_FORK_URL = process.env.MAINNET_FORK_URL; // Optional

// --- Custom Hardhat Tasks ---

task("checkBalance", "Prints the ETH balance of the deployer account configured for the specified network")
  .setAction(async (taskArgs, hre) => {
    const networkName = hre.network.name;
    console.log(`🔎 Checking balance on network: ${networkName}`);
    try {
      const [deployer] = await hre.ethers.getSigners();
      if (!deployer) {
        console.error("❌ Error: Could not get deployer account. Check .env PRIVATE_KEY."); return;
      }
      const address = deployer.address; console.log(`👤 Account Address: ${address}`);
      const balanceWei = await hre.ethers.provider.getBalance(address);
      const balanceEther = hre.ethers.formatEther(balanceWei);
      console.log(`💰 Balance: ${balanceEther} ETH`);
      // Optional balance check warning
      // const minimumBalance = hre.ethers.parseEther("0.001");
      // if (balanceWei < minimumBalance) { console.warn(`⚠️ Low balance warning.`); }
    } catch (error) {
      console.error("\n❌ Error fetching balance:", error.message); /* Add hints */
    }
  });


// --- Hardhat Configuration ---

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    compilers: [
      // --- REMOVED 0.8.19 Compiler to resolve import conflicts ---
      // {
      //   version: "0.8.19", // For FlashSwap.sol initially
      //   settings: {
      //     optimizer: { enabled: true, runs: 9999 },
      //   },
      // },
      // --- KEEPING ONLY 0.7.6 for compatibility ---
      {
        version: "0.7.6", // For Uniswap V3 Periphery interface/library compatibility
        settings: {
          optimizer: { enabled: true, runs: 9999 }, // Keep optimizer enabled
        },
      },
    ],
  },
  networks: {
    hardhat: {
       // Optional Forking Config
       ...(MAINNET_FORK_URL && {
          forking: { url: MAINNET_FORK_URL, /* blockNumber: ... */ },
       }),
    },
    arbitrum: {
      url: ARBITRUM_RPC_URL || "",
      accounts: PRIVATE_KEY ? [`0x${PRIVATE_KEY}`] : [],
      chainId: 42161,
      timeout: 120000, // 120 seconds
    },
    // Add other networks if needed later
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  etherscan: {
    apiKey: {
       arbitrumOne: ARBISCAN_API_KEY || "",
    },
     customChains: []
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    coinmarketcap: process.env.COINMARKETCAP_API_KEY,
    token: 'ETH',
  },
};
