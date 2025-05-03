// hardhat.config.js
require("@nomicfoundation/hardhat-toolbox");
require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-verify");
require("hardhat-gas-reporter");
require("dotenv").config();

// --- Environment Variables ---
// Strip 0x prefix if present, as Hardhat expects the raw hex string for accounts
const PRIVATE_KEY_STR = process.env.PRIVATE_KEY?.replace(/^0x/, "");
const ARBISCAN_API_KEY = process.env.ARBISCAN_API_KEY || "";
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "";
const COINMARKETCAP_API_KEY = process.env.COINMARKETCAP_API_KEY || "";

// --- RPC URLs (with fallbacks) ---
const RPC_URLS = {
  arbitrum: process.env.ARBITRUM_RPC_URLS?.split(',')[0] || "https://arb1.arbitrum.io/rpc",
  goerli: process.env.GOERLI_RPC_URL || "https://eth-goerli.g.alchemy.com/v2/demo", // Note: Goerli is deprecated
  arbitrumGoerli: process.env.ARBITRUM_GOERLI_RPC_URL || "https://goerli-rollup.arbitrum.io/rpc" // Note: Arbitrum Goerli is deprecated
};

// --- Account Setup for Live Networks (if PRIVATE_KEY_STR is set) ---
// Hardhat expects the raw hex string (64 characters) WITHOUT the 0x prefix in the accounts array
const accounts = PRIVATE_KEY_STR ? [PRIVATE_KEY_STR] : [];

// --- Network Validation ---
// Update validation to check PRIVATE_KEY_STR length (64 chars) if accounts is not empty
if (accounts.length > 0 && PRIVATE_KEY_STR.length !== 64) {
    console.error("❌ CRITICAL: PRIVATE_KEY in .env is not the correct length (should be 64 hex characters after stripping 0x). Transactions will fail.");
    // Throwing here would stop Hardhat startup if validation is strict,
    // but Hardhat itself is already validating and throwing HH8.
} else if (accounts.length === 0) {
    console.warn("⚠️ PRIVATE_KEY missing or empty in .env - transactions will fail on live networks (unless using Hardhat default accounts or deploying to local hardhat node)");
}


if (!ARBISCAN_API_KEY) console.warn("⚠️ ARBISCAN_API_KEY missing - contract verification disabled for Arbitrum");
if (!ETHERSCAN_API_KEY) console.warn("⚠️ ETHERSCAN_API_KEY missing - contract verification disabled for Goerli");


// --- Hardhat Config ---
module.exports = {
  defaultNetwork: NETWORK, // This determines the default network if not specified on the command line
  solidity: {
    version: "0.7.6", // Ensure this matches your FlashSwap.sol version
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      },
      evmVersion: "istanbul" // Or 'london' depending on target chain/block
    }
  },
  networks: {
    // Mainnets
    arbitrum: {
      url: RPC_URLS.arbitrum,
      accounts, // Uses the accounts derived from PRIVATE_KEY_STR (should be raw hex)
      chainId: 42161,
      // Gas price settings might need adjustment based on live network conditions
      gasPrice: parseInt(process.env.MAX_GAS_GWEI || "1") * 1e9, // Using MAX_GAS_GWEI from env
      gasMultiplier: 1.25 // Matches GAS_ESTIMATE_BUFFER_PERCENT=25
    },

    // Testnets
    goerli: { // Note: Goerli is deprecated, consider Sepolia
      url: RPC_URLS.goerli,
      accounts, // Uses the accounts derived from PRIVATE_KEY_STR (should be raw hex)
      chainId: 5,
      gasPrice: parseInt(process.env.MAX_GAS_GWEI || "1") * 1e9
    },
    arbitrumGoerli: { // Note: Arbitrum Goerli is also deprecated, consider Arbitrum Sepolia
      url: RPC_URLS.arbitrumGoerli,
      accounts, // Uses the accounts derived from PRIVATE_KEY_STR (should be raw hex)
      chainId: 421613,
      gasPrice: parseInt(process.env.MAX_GAS_GWEI || "1") * 1e9
    },

    // Local Hardhat Network (used for 'npx hardhat test' by default, can be forked)
    // When running `npx hardhat node`, this configuration starts the node.
    // The accounts config here affects `npx hardhat test` or `npx hardhat run` targeting `--network hardhat`.
    // `npx hardhat node` generates its own default accounts UNLESS accounts are defined here.
    hardhat: {
      chainId: 31337, // Default Hardhat chain ID
      forking: {
        url: RPC_URLS.arbitrum, // Forks Arbitrum mainnet
        enabled: process.env.FORKING === "true", // Only enable if FORKING=true in .env
        // blockNumber: 1234567 // Optional: Fork from a specific block number for stable testing
      },
       // Use empty array [] here for Hardhat to generate its own default accounts when running `npx hardhat node`
       // If you want to *override* Hardhat's default accounts, you could put a list of raw private keys here.
       accounts: [], // Recommended to use default Hardhat accounts for simplicity
    },

    // --- Local Forked Network (explicitly connects to the running 'hardhat node --fork' instance) ---
    // Use this network when running scripts/tests against the node started with `npx hardhat node --fork ...`
    // *** HARDCODING Hardhat's Default Account #0 Private Key (RAW HEX) for reliable testing ***
    localFork: {
      url: "http://127.0.0.1:8545", // Default RPC address for npx hardhat node
      // Use the raw hex private key (64 chars) for Hardhat's default Account #0
      accounts: ["ac0974de85431e2a29a1bcedf3cfb9226611458f"], // Use specific PK (RAW HEX)
      // chainId will be automatically detected from the running node (should be 42161 when forking Arbitrum)
      // Gas price/limit settings can be inherited or set here if needed,
      // but the running node often handles this well.
    },
  },
  etherscan: {
    apiKey: {
      arbitrumOne: ARBISCAN_API_KEY,
      arbitrumGoerli: ARBISCAN_API_KEY, // May need to change to arbitrumSepolia
      goerli: ETHERSCAN_API_KEY, // May need to change to sepolia
      mainnet: ETHERSCAN_API_KEY // Add mainnet if deploying/verifying there
    },
    customChains: [
        // Add custom chains here if needed for verification, e.g., Arbitrum Sepolia
        // {
        //   network: "arbitrumSepolia",
        //   chainId: 421614,
        //   urls: {
        //     apiURL: "https://api-sepolia.arbiscan.io/api",
        //     browserURL: "https://sepolia.arbiscan.io/"
        //   }
        // }
    ]
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    coinmarketcap: COINMARKETCAP_API_KEY,
    token: "ETH", // Or 'MATIC', 'ARB', etc. depending on network
    gasPrice: parseInt(process.env.MAX_GAS_GWEI || "1"), // Use MAX_GAS_GWEI from env
    outputFile: process.env.GAS_REPORT_FILE, // Optional: Specify output file
    noColors: process.env.NO_COLORS === "true" // Optional: Disable colors for CI
  },
  mocha: {
    timeout: 300000 // Increased timeout to 5 minutes (300s) for potential network delays even on local fork
  }
};
