// hardhat.config.js
// Hardhat Configuration File
// --- VERSION v1.5 --- Corrected hardhat network accounts format based on HH8 error.

require("@nomicfoundation/hardhat-toolbox");
require("@nomicfoundation/hardhat-ethers");
require("hardhat-gas-reporter");
require("dotenv").config(); // Ensure .env variables are loaded at the very top

// --- Environment Variables (Accessed within the config scope) ---
// Access these using process.env directly where needed, or assign to local consts *inside* the object
const INFURA_API_KEY = process.env.INFURA_API_KEY || "";
const ALCHEMY_API_KEY_ARBITRUM = process.env.ARBITRUM_RPC_URLS?.split(',')[0]?.replace(/.*alchemy.com\/v2\//, "") || ""; // Extract key from Alchemy URL if used

// Recommended format for private keys in Hardhat networks accounts array is often the raw 64-char hex string.
// Let's derive that from the environment variable, stripping any '0x'.
const PRIVATE_KEY_RAW_ENV = process.env.PRIVATE_KEY?.replace(/^0x/, "") || "";

// Hardhat's standard default test account private key (raw, 64 hex chars)
const HARDHAT_DEFAULT_PRIVATE_KEY_RAW = "ac0974de85431e2a29a1bcedf3cfb9226611458f";

// Determine the account object for the Hardhat network if a valid private key is provided.
// The Hardhat network expects an object { privateKey: "0x...", balance: "..." }
const hardhatAccount = (PRIVATE_KEY_RAW_ENV.length === 64) ?
  [{
    privateKey: `0x${PRIVATE_KEY_RAW_ENV}`, // Hardhat network expects 0x prefix here
    balance: "10000000000000000000000" // Optional: Set a large default balance (10000 ETH)
  }] : undefined; // undefined means Hardhat will generate default accounts

// Determine the accounts array for JSON-RPC based networks (arbitrum, goerli, etc.).
// These typically expect an array of 0x-prefixed private key strings.
const accountsForLiveNetworks = (PRIVATE_KEY_RAW_ENV.length === 64) ? [`0x${PRIVATE_KEY_RAW_ENV}`] : [];


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
    hardhat: {
       // Use the environment variable private key if valid, in the correct object format.
       // If not valid, hardhatAccount is undefined, letting Hardhat generate defaults.
       accounts: hardhatAccount,
       // chainId: 31337 // Default Hardhat chainId
    },
    // Local Fork Network (Used with --network localFork)
    // Configured to fork Arbitrum Mainnet at a specific block.
    localFork: {
      url: "http://127.0.0.1:8545", // Hardhat node RPC endpoint
      // Use the standard Hardhat default private key, format it with 0x prefix
      // This should bypass any environment variable issues for this specific network.
      accounts: [`0x${HARDHAT_DEFAULT_PRIVATE_KEY_RAW}`],
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
      accounts: accountsForLiveNetworks, // Use the accounts derived from PRIVATE_KEY_RAW_ENV
      chainId: 42161
    },
    // Goerli Testnet (Used with --network goerli)
    goerli: {
      url: GOERLI_RPC_URL,
      accounts: accountsForLiveNetworks, // Use the accounts derived from PRIVATE_KEY_RAW_ENV
      chainId: 5
    },
    // Arbitrum Goerli Testnet (Used with --network arbitrumGoerli)
    arbitrumGoerli: {
      url: ARBITRUM_GOERLI_RPC_URL,
      accounts: accountsForLiveNetworks, // Use the accounts derived from PRIVATE_KEY_RAW_ENV
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

// Optional: Add a check to warn if PRIVATE_KEY in .env is not the expected raw length for live networks
if (process.env.PRIVATE_KEY && process.env.PRIVATE_KEY.replace(/^0x/, "").length !== 64 && process.env.NETWORK !== 'localFork' && process.env.NETWORK !== 'hardhat') {
     console.warn(`[Hardhat Config] WARNING: PRIVATE_KEY environment variable has unexpected length (${process.env.PRIVATE_KEY.replace(/^0x/, "").length} after stripping 0x). Expected 64 for live networks.`);
    }
