// hardhat.config.js
// Hardhat Configuration File
// --- VERSION v1.7 --- Adjusted localFork network accounts format (removed 0x prefix in array) based on persistent HH8 error.

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

// Hardhat's standard default test account private key (raw, 64 hex chars) used by `hardhat node` default account #0
// This is used for the `localFork` network accounts directly.
const HARDHAT_DEFAULT_PRIVATE_KEY_RAW = "ac0974de85431e2a29a1bcedf3cfb9226611458f";


// Determine the account object for the Hardhat network if a valid private key is provided.
// The Hardhat network (`--network hardhat`, the in-memory test network) expects an array of objects { privateKey: "0x...", balance: "..." }
const hardhatAccountsConfig = (PRIVATE_KEY_RAW_ENV.length === 64) ?
  [{
    privateKey: `0x${PRIVATE_KEY_RAW_ENV}`, // Hardhat network expects 0x prefix here
    balance: "10000000000000000000000" // Optional: Set a large default balance (10000 ETH)
  }] : []; // Default to empty array; Hardhat will generate default accounts if 'accounts' is empty or undefined


// Determine the accounts array for JSON-RPC based networks (arbitrum, goerli, etc.).
// These typically expect an array of 0x-prefixed private key strings.
const accountsForLiveNetworks = (PRIVATE_KEY_RAW_ENV.length === 64) ? [`0x${PRIVATE_KEY_RAW_ENV}`] : [];


// Access specific RPC URLs from .env
const ARBITRUM_RPC_URL = process.env.ARBITRUM_RPC_URLS?.split(',')[0] || `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY_ARBITRUM}`;
const GOERLI_RPC_URL = process.env.GOERLI_RPC_URL || `https://eth-goerli.g.alchemy.com/v2/${INFURA_API_KEY}`; // Using Infura as fallback example
const ARBITRUM_GOERLI_RPC_URL = process.env.ARBITRUM_GOERLI_RPC_URL || "https://goerli-rollup.arbitrum.io/rpc";


/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  // --- ADDED MULTIPLE COMPILER VERSIONS ---
  solidity: {
    compilers: [
      {
        version: "0.8.24", // Keep the latest version for new contracts if needed
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          // Use a recent EVM version compatible with Arbitrum
          evmVersion: "paris" // Or "london", "berlin", etc.
        }
      },
      {
        version: "0.7.6", // Required by FlashSwap.sol and some imported libraries (like UniV3)
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
           // Use an appropriate EVM version for contracts compiled with 0.7.x
           evmVersion: "istanbul" // Common for this version
        }
      },
       {
         version: "0.6.8", // Required by some OpenZeppelin contracts (covers >=0.6.0 <0.8.0 range)
         settings: {
           optimizer: {
             enabled: true,
             runs: 200,
           },
            evmVersion: "istanbul" // Common for this version
         }
       }
      // Add other compiler versions here if needed for other contracts
    ],
    overrides: {
      // Use overrides if specific contracts need different settings than the defaults for their version
      // Example: if FlashSwap needed a specific optimizer run count
      // "contracts/FlashSwap.sol": {
      //   version: "0.7.6",
      //   settings: {
      //     optimizer: {
      //       enabled: true,
      //       runs: 1000
      //     }
      //   }
      // }
    }
  }, // --- END MULTIPLE COMPILER VERSIONS ---
  networks: {
    // Hardhat Network (Used by default if no --network specified)
    // This is the in-memory network, typically does not fork unless configured explicitly here.
    hardhat: {
       // Use the environment variable private key if valid, in the correct object format.
       // If not valid, hardhatAccountsConfig is empty array, Hardhat will generate defaults.
       accounts: hardhatAccountsConfig,
       // chainId: 31337 // Default Hardhat chainId - leave commented unless needed
    },
    // Local Fork Network (Used with --network localFork)
    // Configured to fork Arbitrum Mainnet at a specific block.
    localFork: {
      url: "http://127.0.0.1:8545", // Hardhat node RPC endpoint
      // Use the standard Hardhat default private key for this local fork network,
      // formatted as the raw 64-char hex string WITHOUT the 0x prefix in the array,
      // to see if that resolves the HH8 error. This is unusual but worth testing.
      accounts: [HARDHAT_DEFAULT_PRIVATE_KEY_RAW], // <--- MODIFIED LINE
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
// This warning is specifically for the PRIVATE_KEY variable used for non-localFork networks
if (process.env.PRIVATE_KEY && process.env.PRIVATE_KEY.replace(/^0x/, "").length !== 64 && process.env.NETWORK !== 'localFork' && process.env.NETWORK !== 'hardhat') {
     console.warn(`[Hardhat Config] WARNING: PRIVATE_KEY environment variable has unexpected length (${process.env.PRIVATE_KEY.replace(/^0x/, "").length} after stripping 0x). Expected 64 for live networks.`);
}
