// hardhat.config.js
require("@nomicfoundation/hardhat-toolbox");
require("@nomicfoundation/hardhat-ethers"); // Often included via toolbox, but explicit doesn't hurt
require('dotenv').config(); // Make .env variables available

// --- Environment Variable Loading and Validation ---
// Load RPC URL: Use the first URL if multiple are comma-separated
const ARBITRUM_RPC_URL = process.env.ARBITRUM_RPC_URLS ? process.env.ARBITRUM_RPC_URLS.split(',')[0] : undefined;
// Load Private Key: Remove '0x' prefix if it exists, as Hardhat expects it without
const RAW_PRIVATE_KEY = process.env.PRIVATE_KEY;

// Prepare accounts array for Hardhat config
const ACCOUNTS = [];
if (RAW_PRIVATE_KEY) {
    // Add '0x' prefix as required by Hardhat accounts array
    ACCOUNTS.push(`0x${RAW_PRIVATE_KEY}`);
} else {
    console.warn("⚠️ WARNING: PRIVATE_KEY not found in .env file. Deployment and transactions requiring a signer will fail.");
}

// Check RPC URL
if (!ARBITRUM_RPC_URL) {
    console.warn("⚠️ WARNING: ARBITRUM_RPC_URLS not found in .env file. Deployment to Arbitrum will fail.");
}

// Load Arbiscan API Key
const ARBISCAN_API_KEY = process.env.ARBISCAN_API_KEY || "";
if (!ARBISCAN_API_KEY) {
     console.warn("⚠️ WARNING: ARBISCAN_API_KEY not found in .env file. Contract verification will fail.");
}
// --- End Environment Variable Loading ---


/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.7.6", // Match your contract's pragma exactly
    settings: {
      optimizer: {
        enabled: true,
        runs: 200, // Standard setting, adjust if needed
      },
      // Specify EVM version compatible with Solidity 0.7.6 and Arbitrum
      // Istanbul is generally safe, Berlin might also work.
      evmVersion: "istanbul"
    }
  },
  networks: {
    // Local development network
    hardhat: {
      // You can configure forking here for testing against mainnet state
      // forking: {
      //   url: ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc", // Use loaded URL or a default public one
      //   blockNumber: undefined // Pins the fork to a specific block (optional)
      // }
    },
    // Arbitrum Mainnet Configuration
    arbitrum: {
      url: ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc", // Fallback to public RPC if .env fails
      accounts: ACCOUNTS, // Use the accounts array prepared above
      chainId: 42161, // Arbitrum One chain ID
      // Optional: Specify gas price strategy if needed, otherwise Hardhat uses provider's default
      // gasPrice: "auto", // or specific value like ethers.utils.parseUnits("0.1", "gwei")
    },
    // Example: Arbitrum Goerli Testnet (uncomment and configure if needed)
    // arbitrumGoerli: {
    //   url: process.env.ARBITRUM_GOERLI_RPC_URL || "", // Add this to .env if using testnet
    //   accounts: ACCOUNTS,
    //   chainId: 421613,
    // },
  },
  etherscan: {
    // Your API key for Arbiscan (needed for contract verification)
    // Hardhat automatically uses block explorers based on chainId,
    // but explicitly defining helps.
    apiKey: {
      arbitrumOne: ARBISCAN_API_KEY,
      // arbitrumGoerli: ARBISCAN_API_KEY, // Use the same key if applicable
    }
  },
  // Optional: Specify paths if your project structure is non-standard
  // paths: {
  //   sources: "./contracts",
  //   tests: "./test",
  //   cache: "./cache",
  //   artifacts: "./artifacts"
  // },
  // Optional: Gas reporter configuration
  // gasReporter: {
  //   enabled: (process.env.REPORT_GAS) ? true : false,
  //   currency: 'USD',
  //   coinmarketcap: process.env.COINMARKETCAP_API_KEY, // Optional: For USD conversion
  // },
};
