// hardhat.config.js

// --- Imports ---
require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config(); // Load .env file
const { task } = require("hardhat/config"); // Import task function

// --- Environment Variable Checks ---
const ARBITRUM_RPC_URL = process.env.ARBITRUM_RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const ARBISCAN_API_KEY = process.env.ARBISCAN_API_KEY;

// Optional: Mainnet fork URL for testing specific contract logic if needed
const MAINNET_FORK_URL = process.env.MAINNET_FORK_URL;

// --- Custom Hardhat Tasks ---

task("checkBalance", "Prints the ETH balance of the deployer account configured for the specified network")
  .setAction(async (taskArgs, hre) => {
    // hre (Hardhat Runtime Environment) provides access to network config, ethers, etc.
    const networkName = hre.network.name;
    console.log(`🔎 Checking balance on network: ${networkName}`);

    try {
      // Get the signer(s) configured for the current network in hardhat.config.js
      // getSigners() uses the 'accounts' array (derived from PRIVATE_KEY in our setup)
      const [deployer] = await hre.ethers.getSigners();

      if (!deployer) {
        console.error("❌ Error: Could not get deployer account.");
        console.error("   Ensure PRIVATE_KEY is correctly set in your .env file and corresponds to the selected network.");
        return; // Exit the task
      }

      const address = deployer.address;
      console.log(`👤 Account Address: ${address}`);

      // Get the balance from the provider associated with the network
      const balanceWei = await hre.ethers.provider.getBalance(address);

      // Format the balance from Wei to Ether for readability
      const balanceEther = hre.ethers.formatEther(balanceWei);

      console.log(`💰 Balance: ${balanceEther} ETH`);

      // Optional: Add a check for minimum balance needed for deployment
      const minimumBalance = hre.ethers.parseEther("0.001"); // Example: 0.001 ETH
      if (balanceWei < minimumBalance) {
        console.warn(`⚠️ Warning: Balance might be low for deployment gas costs.`);
      }

    } catch (error) {
      console.error("\n❌ Error fetching balance:");
      console.error(error.message);
      // Provide hints based on common errors
      if (error.message.includes("invalid hexidecimal") || error.message.includes("private key") || error.message.includes("invalid private key") ) {
         console.error("   Hint: Check if the PRIVATE_KEY in your .env file is a valid 64-character hexadecimal string (without '0x').");
      } else if (error.message.includes("missing provider") || error.message.includes("could not detect network")) {
         console.error(`   Hint: Check if ARBITRUM_RPC_URL in your .env file is correct and the service is reachable.`);
      } else if (error.message.includes("signer mismatch")) {
         console.error(`   Hint: The PRIVATE_KEY might not correspond to an address with funds on the selected network, or the RPC node might be having issues.`);
      }
    }
  });


// --- Hardhat Configuration ---

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    compilers: [
      {
        version: "0.8.19", // For FlashSwap.sol
        settings: {
          optimizer: { enabled: true, runs: 9999 }, // Increase optimizer runs for potential deployment savings
        },
      },
      // Keep 0.7.6 if directly importing V3 Periphery contracts that need it
      // If only using interfaces, 0.8.19 might suffice, but safer to keep both
      {
        version: "0.7.6", // For Uniswap V3 Periphery interface compatibility (safe)
        settings: {
          optimizer: { enabled: true, runs: 9999 }, // Increase optimizer runs
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
      // Ensure private key has 0x prefix IF REQUIRED by the specific ethers/hardhat version (safer to add it here)
      // Hardhat typically handles adding '0x' if missing, but being explicit can sometimes help debugging.
      // If PRIVATE_KEY definitely has no prefix in .env, this adds it:
      accounts: PRIVATE_KEY ? [`0x${PRIVATE_KEY}`] : [],
      // If PRIVATE_KEY *might* have prefix in .env, use this safer check:
      // accounts: PRIVATE_KEY ? [PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY : `0x${PRIVATE_KEY}`] : [],
      chainId: 42161, // Arbitrum One Chain ID
      // Increase timeout for deployments/transactions on L2s, can be crucial
      timeout: 120000, // 120 seconds
    },
    // Add other networks like 'arbitrumGoerli' (Testnet ID: 421613) later if needed
    // arbitrumGoerli: {
    //   url: process.env.ARBITRUM_GOERLI_RPC_URL || "",
    //   accounts: PRIVATE_KEY ? [`0x${PRIVATE_KEY}`] : [],
    //   chainId: 421613,
    //   timeout: 120000,
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
    // Specify gas price for networks if needed (e.g., Arbitrum) - Arbiscan proxy might work
    // gasPriceApi: "https://api.arbiscan.io/api?module=proxy&action=eth_gasPrice",
    token: 'ETH', // Base token for Arbitrum is ETH
    // outputFile: "gas-report.txt", // Optional: Write report to a file
    // noColors: true, // Optional: Disable colors in report
  },
};
