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
const COINMARKETCAP_API_KEY = process.env.COINMARKETCAP_API_KEY || "";

// --- RPC URLs (with fallbacks) ---
const RPC_URLS = {
  arbitrum: process.env.ARBITRUM_RPC_URLS?.split(',')[0] || "https://arb1.arbitrum.io/rpc",
  goerli: process.env.GOERLI_RPC_URL || "https://eth-goerli.g.alchemy.com/v2/demo", // Note: Goerli is deprecated
  arbitrumGoerli: process.env.ARBITRUM_GOERLI_RPC_URL || "https://goerli-rollup.arbitrum.io/rpc" // Note: Arbitrum Goerli is deprecated
};

// --- Account Setup for Live Networks (if PRIVATE_KEY is set) ---
const liveNetworkAccounts = PRIVATE_KEY ? [`0x${PRIVATE_KEY}`] : [];

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
      accounts: liveNetworkAccounts, // Uses the accounts derived from PRIVATE_KEY
      chainId: 42161,
      // Gas price settings might need adjustment based on live network conditions
      gasPrice: parseInt(process.env.MAX_GAS_GWEI || "1") * 1e9, // Using MAX_GAS_GWEI from env
      gasMultiplier: 1.25 // Matches GAS_ESTIMATE_BUFFER_PERCENT=25
    },

    // Testnets
    goerli: { // Note: Goerli is deprecated, consider Sepolia
      url: RPC_URLS.goerli,
      accounts: liveNetworkAccounts, // Uses the accounts derived from PRIVATE_KEY
      chainId: 5,
      gasPrice: parseInt(process.env.MAX_GAS_GWEI || "1") * 1e9
    },
    arbitrumGoerli: { // Note: Arbitrum Goerli is also deprecated, consider Arbitrum Sepolia
      url: RPC_URLS.arbitrumGoerli,
      accounts: liveNetworkAccounts, // Uses the accounts derived from PRIVATE_KEY
      chainId: 421613,
      gasPrice: parseInt(process.env.MAX_GAS_GWEI || "1") * 1e9
    },

    // Local Hardhat Network (used for 'npx hardhat test' by default, can be forked)
    // When running `npx hardhat node`, this configuration starts the node.
    // The accounts config here primarily affects `npx hardhat test` or `npx hardhat run` targeting `--network hardhat`.
    // `npx hardhat node` generates its own accounts regardless, but this config needs to be valid.
    hardhat: {
      chainId: 31337, // Default Hardhat chain ID
      forking: {
        url: RPC_URLS.arbitrum, // Forks Arbitrum mainnet
        enabled: process.env.FORKING === "true", // Only enable if FORKING=true in .env
        // blockNumber: 1234567 // Optional: Fork from a specific block number for stable testing
      },
       // Use empty array for default generated accounts when starting the node with `npx hardhat node`.
       // This should ensure the 20 default accounts are generated and listed.
       accounts: [],
    },

    // --- Local Forked Network (explicitly connects to the running 'hardhat node --fork' instance) ---
    // Use this network when running scripts/tests against the node started with `npx hardhat node --fork ...`
    // *** HARDCODING Hardhat's Default Account #0 Private Key for reliable testing ***
    localFork: {
      url: "http://127.0.0.1:8545", // Default RPC address for npx hardhat node
      // This private key is for Hardhat's default Account #0 (0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266)
      // It is safe to hardcode as it only works on the local Hardhat node.
      accounts: ["0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"], // Use specific PK
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
