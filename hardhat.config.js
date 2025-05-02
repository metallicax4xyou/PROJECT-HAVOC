// hardhat.config.js
require("@nomicfoundation/hardhat-toolbox");
require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-verify");
require("hardhat-gas-reporter");
require("dotenv").config();

// --- Environment Variables ---
const NETWORK = process.env.NETWORK || "arbitrum";
const PRIVATE_KEY = process.env.PRIVATE_KEY?.replace(/^0x/, ""); // Strip 0x prefix if present
const ARBISCAN_API_KEY = process.env.ARBISCAN_API_KEY || "";
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "";
const COINMARKETCAP_API_KEY = process.env.COINMARKAP_API_KEY || ""; // Corrected typo Coinmarketcap

// --- RPC URLs (with fallbacks) ---
const RPC_URLS = {
  arbitrum: process.env.ARBITRUM_RPC_URLS?.split(',')[0] || "https://arb1.arbitrum.io/rpc",
  goerli: process.env.GOERLI_RPC_URL || "https://eth-goerli.g.alchemy.com/v2/demo",
  arbitrumGoerli: process.env.ARBITRUM_GOERLI_RPC_URL || "https://goerli-rollup.arbitrum.io/rpc"
};

// --- Account Setup ---
const accounts = PRIVATE_KEY ? [`0x${PRIVATE_KEY}`] : [];

// --- Network Validation ---
if (!PRIVATE_KEY) console.warn("⚠️ PRIVATE_KEY missing - transactions will fail (unless using Hardhat accounts)");
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
      accounts,
      chainId: 42161,
      // Gas price settings might need adjustment based on live network conditions
      gasPrice: parseInt(process.env.MAX_GAS_GWEI || "1") * 1e9, // Using MAX_GAS_GWEI from env
      gasMultiplier: 1.25 // Matches GAS_ESTIMATE_BUFFER_PERCENT=25
    },

    // Testnets
    goerli: { // Note: Goerli is deprecated, consider Sepolia
      url: RPC_URLS.goerli,
      accounts,
      chainId: 5,
      gasPrice: parseInt(process.env.MAX_GAS_GWEI || "1") * 1e9
    },
    arbitrumGoerli: { // Note: Arbitrum Goerli is also deprecated, consider Arbitrum Sepolia
      url: RPC_URLS.arbitrumGoerli,
      accounts,
      chainId: 421613,
      gasPrice: parseInt(process.env.MAX_GAS_GWEI || "1") * 1e9
    },

    // Local Hardhat Network (used for 'npx hardhat test' by default, can be forked)
    hardhat: {
      chainId: 31337, // Default Hardhat chain ID
      forking: {
        url: RPC_URLS.arbitrum, // Forks Arbitrum mainnet
        enabled: process.env.FORKING === "true", // Only enable if FORKING=true in .env
        // blockNumber: 1234567 // Optional: Fork from a specific block number for stable testing
      },
       // Use Hardhat's default accounts by default unless PRIVATE_KEY is set
      accounts: accounts.length > 0 ? accounts : undefined, // Use provided PK if available, else default
    },

    // --- NEW: Local Forked Network (explicitly connects to the running 'hardhat node --fork' instance) ---
    // Use this network when running scripts/tests against the node started with `npx hardhat node --fork ...`
    localFork: {
      url: "http://127.0.0.1:8545", // Default RPC address for npx hardhat node
      accounts: accounts.length > 0 ? accounts : "remote", // Use provided PK if available, else use accounts from the running node ("remote")
      // chainId will be automatically detected from the running node (should be 42161 when forking Arbitrum)
      // Gas price/limit settings can be inherited or set here if needed,
      // but the running node often handles this well.
    },
    // --- END NEW NETWORK ---

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
