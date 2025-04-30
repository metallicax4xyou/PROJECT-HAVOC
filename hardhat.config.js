// hardhat.config.js
require("@nomicfoundation/hardhat-toolbox");
require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-verify"); // For contract verification
require("dotenv").config();

// --- Environment Variables ---
const ARBITRUM_RPC_URL = process.env.ARBITRUM_RPC_URLS?.split(',')[0];
const RAW_PRIVATE_KEY = process.env.PRIVATE_KEY?.replace(/^0x/, ""); // Remove 0x prefix if present
const ACCOUNTS = RAW_PRIVATE_KEY ? [`0x${RAW_PRIVATE_KEY}`] : [];
const ARBISCAN_API_KEY = process.env.ARBISCAN_API_KEY || "";
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "";

// --- Network Validation ---
if (!ARBITRUM_RPC_URL) console.warn("⚠️ ARBITRUM_RPC_URLS missing in .env");
if (!RAW_PRIVATE_KEY) console.warn("⚠️ PRIVATE_KEY missing in .env");
if (!ARBISCAN_API_KEY) console.warn("⚠️ ARBISCAN_API_KEY missing in .env");

// --- Hardhat Config ---
module.exports = {
  solidity: {
    version: "0.7.6",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      evmVersion: "istanbul"
    }
  },
  networks: {
    // Local
    hardhat: {
      // Optional: Forking config
      // forking: { url: ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc" }
    },
    
    // Mainnets
    arbitrum: {
      url: ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc",
      accounts: ACCOUNTS,
      chainId: 42161,
    },

    // Testnets
    goerli: {
      url: process.env.GOERLI_RPC_URL || "https://eth-goerli.g.alchemy.com/v2/demo",
      accounts: ACCOUNTS,
      chainId: 5,
    },
    arbitrumGoerli: {
      url: process.env.ARBITRUM_GOERLI_RPC_URL || "https://goerli-rollup.arbitrum.io/rpc",
      accounts: ACCOUNTS,
      chainId: 421613,
    }
  },
  etherscan: {
    apiKey: {
      arbitrumOne: ARBISCAN_API_KEY,
      arbitrumGoerli: ARBISCAN_API_KEY,
      goerli: ETHERSCAN_API_KEY,
    }
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    coinmarketcap: process.env.COINMARKETCAP_API_KEY || null,
  },
  mocha: {
    timeout: 60000 // 60 seconds for slow RPCs
  }
};
