// hardhat.config.js
// Hardhat Configuration File
// --- VERSION v1.2 --- Corrected environment variable loading and private key format handling.

require("@nomicfoundation/hardhat-toolbox");
require("@nomicfoundation/hardhat-ethers");
require("hardhat-gas-reporter");
require("dotenv").config(); // Ensure .env variables are loaded at the very top

// Environment Variables - Access them here
const INFURA_API_KEY = process.env.INFURA_API_KEY || "";
const ALCHEMY_API_KEY_ARBITRUM = process.env.ARBITRUM_RPC_URLS?.split(',')[0]?.replace(/.*alchemy.com\/v2\//, "") || ""; // Extract key from Alchemy URL if used
// IMPORTANT: Hardhat network accounts typically expect the raw 64-char hex string *without* the 0x prefix.
// Ensure your PRIVATE_KEY in .env is the raw hex string (64 chars).
// If your .env PRIVATE_KEY includes "0x", we will strip it here.
const PRIVATE_KEY_RAW = process.env.PRIVATE_KEY?.replace(/^0x/, "") || "";


// Define the default accounts array for networks other than localFork.
// Only include accounts if a valid private key is provided in .env.
// Hardhat expects the 0x prefix for keys listed directly in the accounts array.
const accounts = PRIVATE_KEY_RAW ? [`0x${PRIVATE_KEY_RAW}`] : [];

// Access specific RPC URLs from .env
const ARBITRUM_RPC_URL = process.env.ARBITRUM_RPC_URLS?.split(',')[0] || `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY_ARBITRUM}`;
const GOERLI_RPC_URL = process.env.GOERLI_RPC_URL || `https://eth-goerli.g.alchemy.com/v2/${INFURA_API_KEY}`; // Using Infura as fallback example
const ARBITRUM_GOERLI_RPC_URL = process.env.ARBITRUM_GOERLI_RPC_URL || "https://goerli-rollup.arbitrum.io/rpc";


/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24", // Use a recent Solidity version
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      evmVersion: "paris" // Or appropriate version for Arbitrum
    }
  },
  networks: {
    // Hardhat Network (Used by default if no --network specified)
    // This will NOT fork Arbitrum Mainnet by default unless configured below.
    // For local testing without forking, you don't need complex accounts here.
    hardhat: {
       // accounts: accounts.length > 0 ? accounts : undefined, // Optionally use the same accounts if PK is set
       // chainId: 31337 // Default Hardhat chainId
    },
    // Local Fork Network (Used with --network localFork)
    // Configured to fork Arbitrum Mainnet at a specific block.
    localFork: {
      url: "http://127.0.0.1:8545", // Hardhat node RPC endpoint
      // Use a hardcoded standard Hardhat account key for the local fork environment
      // This key is known to work with Hardhat's default node setup and has funds (10000 ETH)
      accounts: ["0xac0974de85431e2a29a1bcedf3cfb9226611458f"],
      // Forking Configuration (Enabled when using this network)
      forking: {
        url: ARBITRUM_RPC_URL, // Use the Arbitrum Mainnet RPC URL from .env
        // blockNumber: 123456789 // Optional: Specify a block number for consistent fork state
      },
      chainId: 42161, // Match Arbitrum Mainnet chain ID
    },
    // Arbitrum Mainnet (Used with --network arbitrum)
    arbitrum: {
      url: ARBITRUM_RPC_URL,
      accounts: accounts, // Use the account derived from PRIVATE_KEY_RAW
      chainId: 42161
    },
    // Goerli Testnet (Used with --network goerli)
    goerli: {
      url: GOERLI_RPC_URL,
      accounts: accounts, // Use the account derived from PRIVATE_KEY_RAW
      chainId: 5
    },
    // Arbitrum Goerli Testnet (Used with --network arbitrumGoerli)
    arbitrumGoerli: {
      url: ARBITRUM_GOERLI_RPC_URL,
      accounts: accounts, // Use the account derived from PRIVATE_KEY_RAW
      chainId: 421613
    },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS !== undefined,
    currency: "USD",
  },
  etherscan: {
    apiKey: {
      arbitrumOne: process.env.ARBISCAN_API_KEY || "",
      goerli: process.env.ETHERSCAN_API_KEY || "",
      arbitrumGoerli: process.env.ARBISCAN_API_KEY || "", // Arb Goerli uses Arbiscan key
    },
  },
};

// Add a check to prevent running on live networks with no private key set if accounts is empty
if (process.env.NODE_ENV !== 'development' && accounts.length === 0 && process.env.NETWORK !== 'localFork' && process.env.NETWORK !== 'hardhat') {
    console.error("CRITICAL: No PRIVATE_KEY set in .env for live network!");
    // process.exit(1); // Optionally exit here if PK is mandatory for all but localFork
}
