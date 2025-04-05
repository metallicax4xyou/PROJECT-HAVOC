require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config(); // Load .env file

// --- Environment Variable Checks ---
const ARBITRUM_RPC_URL = process.env.ARBITRUM_RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const ARBISCAN_API_KEY = process.env.ARBISCAN_API_KEY;

// Optional: Mainnet fork URL for testing specific contract logic if needed
const MAINNET_FORK_URL = process.env.MAINNET_FORK_URL;
// if (!ARBITRUM_RPC_URL) { console.warn("WARNING: ARBITRUM_RPC_URL not found in .env file."); }
// if (!PRIVATE_KEY) { console.warn("WARNING: PRIVATE_KEY not found in .env file. Deployment/Execution will fail."); }
// if (!ARBISCAN_API_KEY) { console.warn("WARNING: ARBISCAN_API_KEY not found in .env file. Verification will fail."); }


/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    compilers: [
      {
        version: "0.8.19", // For FlashSwap.sol
        settings: {
          optimizer: { enabled: true, runs: 200 },
        },
      },
      // Keep 0.7.6 if directly importing V3 Periphery contracts that need it
      // If only using interfaces, 0.8.19 might suffice, but safer to keep both
      {
        version: "0.7.6", // For Uniswap V3 Periphery interface compatibility (safe)
        settings: {
          optimizer: { enabled: true, runs: 200 },
        },
      },
    ],
  },
  networks: {
    hardhat: {
       // Configuration for `npx hardhat node` or `npx hardhat test --network hardhat`
       // Optional: Forking mainnet for testing contract logic in isolation
       ...(MAINNET_FORK_URL && { // Only include forking if MAINNET_FORK_URL is set
          forking: {
              url: MAINNET_FORK_URL,
              // blockNumber: 19XXXXXX // Optional: Pin block number
           },
       }),
       // Allow unlimited contract size for local testing if needed (e.g. complex mocks)
       // allowUnlimitedContractSize: true
    },
    arbitrum: {
      url: ARBITRUM_RPC_URL || "", // Use empty string if undefined to avoid errors, but operations will fail
      accounts: PRIVATE_KEY ? [`0x${PRIVATE_KEY}`] : [], // Ensure private key has 0x prefix
      chainId: 42161, // Arbitrum One Chain ID
      // You might need to increase the timeout for deployments/transactions on L2s
      // timeout: 60000, // 60 seconds
    },
    // Add other networks like 'arbitrumGoerli' (Testnet ID: 421613) later if needed
    // arbitrumGoerli: {
    //   url: process.env.ARBITRUM_GOERLI_RPC_URL || "",
    //   accounts: PRIVATE_KEY ? [`0x${PRIVATE_KEY}`] : [],
    //   chainId: 421613,
    // },
  },
  paths: {
    sources: "./contracts",
    tests: "./test", // We will replace the sample test later
    cache: "./cache",
    artifacts: "./artifacts",
  },
  etherscan: {
    // API key for verifying contracts on Arbiscan
    apiKey: {
       arbitrumOne: ARBISCAN_API_KEY || "", // Arbiscan requires a specific key format/name
       // arbitrumGoerli: ARBISCAN_API_KEY || "", // Use the same key for testnet
       // Add other network keys if needed (e.g., mainnet: process.env.ETHERSCAN_API_KEY)
    },
     // Required for some networks like Optimism, Base, etc. Add custom chains if needed.
     customChains: []
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true", // Enable with env var REPORT_GAS=true
    currency: "USD",
    coinmarketcap: process.env.COINMARKETCAP_API_KEY, // Optional: For USD conversion
    // Specify gas price for networks if needed (e.g., Arbitrum)
    // gasPriceApi: "https://api.arbiscan.io/api?module=proxy&action=eth_gasPrice",
    // token: 'ETH', // or 'MATIC' for Polygon etc.
  },
};
