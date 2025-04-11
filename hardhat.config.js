// hardhat.config.js

// --- Imports ---
require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config(); // Load .env file
const { task } = require("hardhat/config"); // Import task function

// --- Environment Variable Checks ---
const ARBITRUM_RPC_URL = process.env.ARBITRUM_RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const ARBISCAN_API_KEY = process.env.ARBISCAN_API_KEY;
const MAINNET_FORK_URL = process.env.MAINNET_FORK_URL; // Optional

// --- Custom Hardhat Tasks ---

task("checkBalance", "Prints the ETH balance of the deployer account configured for the specified network")
  .setAction(async (taskArgs, hre) => {
    const networkName = hre.network.name;
    console.log(`🔎 Checking balance on network: ${networkName}`);
    try {
      // Use hre.ethers.getSigners() which respects the network config
      const signers = await hre.ethers.getSigners();
      if (!signers || signers.length === 0) {
          console.error(`❌ Error: Could not get deployer account for network ${networkName}. Check network config and PRIVATE_KEY in .env.`);
          return;
      }
      const deployer = signers[0];
      const address = deployer.address;
      console.log(`👤 Account Address: ${address}`);

      // Use provider from hre
      const balanceWei = await hre.ethers.provider.getBalance(address);
      const balanceEther = hre.ethers.formatEther(balanceWei);
      console.log(`💰 Balance: ${balanceEther} ETH`);
      // Optional balance check warning
      // const minimumBalance = hre.ethers.parseEther("0.001");
      // if (balanceWei < minimumBalance) { console.warn(`⚠️ Low balance warning.`); }
    } catch (error) {
      console.error("\n❌ Error fetching balance:", error.message); /* Add hints */
    }
  });

// <<< NEW TASK DEFINITION >>>
task("testQuote", "Tests QuoterV2 quote")
  .setAction(async (taskArgs, hre) => {
    const quoterAddress = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6"; // Quoter V2 Address
    const quoterAbi = require('./abis/IQuoterV2.json'); // Load local ABI
    const provider = hre.ethers.provider; // Use provider from HRE
    const quoter = new hre.ethers.Contract(quoterAddress, quoterAbi, provider);

    // --- Define Parameters ---
    // Match the parameters causing the error in monitor.js (Swap 1, Start A)
    const params = {
      tokenIn: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", // WETH
      tokenOut: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // USDC
      amountIn: hre.ethers.parseEther("0.0001"), // Same sim amount
      fee: 3000, // Pool B fee (3000 bps = 0.30%)
      sqrtPriceLimitX96: 0n // No price limit
    };

    console.log(`[testQuote] Attempting static call to quoteExactInputSingle on ${quoterAddress} (Network: ${hre.network.name})`);
    console.log("[testQuote] Parameters:", params);

    try {
      // --- Perform the Static Call ---
      // Use .staticCall explicitly for clarity, although often implied for view functions
      // The ABI expects a tuple, ethers v6 handles the JS object correctly
      const result = await quoter.quoteExactInputSingle.staticCall(params);

      // --- Process Result ---
      // The result object should contain named outputs based on the ABI
      console.log("[testQuote] ✅ Quote successful!");
      console.log(`  Amount Out (USDC): ${hre.ethers.formatUnits(result.amountOut, 6)}`); // Assuming USDC has 6 decimals
      console.log(`  sqrtPriceX96After: ${result.sqrtPriceX96After.toString()}`);
      console.log(`  initializedTicksCrossed: ${result.initializedTicksCrossed.toString()}`);
      console.log(`  gasEstimate: ${result.gasEstimate.toString()}`);

    } catch (error) {
      // --- Handle Error ---
      console.error("[testQuote] ❌ Quote failed:");
      // Log detailed error information
      console.error(`  Error Code: ${error.code}`);
      console.error(`  Reason: ${error.reason}`); // Often null for CALL_EXCEPTION without reason
      // Check if it's the same CALL_EXCEPTION
      if (error.code === 'CALL_EXCEPTION') {
         console.error("  Revert Data:", error.data); // Often null if missing revert data
         console.error("  Transaction:", error.transaction); // Shows the call data
      } else {
         console.error("  Full Error:", error);
      }
    }
  });


// --- Hardhat Configuration ---

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    compilers: [
      // --- KEEPING ONLY 0.7.6 for compatibility ---
      // No need to add 0.8.x unless you add new contracts requiring it
      {
        version: "0.7.6", // For FlashSwap.sol and Uniswap V3 compatibility
        settings: {
          optimizer: { enabled: true, runs: 9999 }, // Keep optimizer enabled
        },
      },
    ],
  },
  networks: {
    hardhat: {
       // Optional Forking Config
       ...(MAINNET_FORK_URL && {
          forking: { url: MAINNET_FORK_URL, /* blockNumber: ... */ },
       }),
       // Allow unlimited contract size for local testing if needed
       // allowUnlimitedContractSize: true
    },
    arbitrum: {
      url: ARBITRUM_RPC_URL || "",
      // Ensure PRIVATE_KEY has 0x prefix if needed by this version/ethers setup
      // Hardhat usually handles it, but double check if issues persist
      accounts: PRIVATE_KEY ? [`0x${PRIVATE_KEY}`] : [],
      chainId: 42161,
      timeout: 120000, // 120 seconds
    },
    // Add other networks if needed later (Polygon, Base, Optimism)
    // polygon: { ... },
    // base: { ... },
    // optimism: { ... },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  etherscan: {
    apiKey: {
       arbitrumOne: ARBISCAN_API_KEY || "",
       // Add keys for other networks when adding them
       // polygon: process.env.POLYGONSCAN_API_KEY || "",
       // base: process.env.BASESCAN_API_KEY || "", // Requires custom chain definition below
       // optimisticEthereum: process.env.OPTIMISMSCAN_API_KEY || "",
    },
     // Add custom chain definition for Base if not built-in
     customChains: [
        // {
        //   network: "base",
        //   chainId: 8453,
        //   urls: {
        //     apiURL: "https://api.basescan.org/api",
        //     browserURL: "https://basescan.org"
        //   }
        // }
      ]
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    coinmarketcap: process.env.COINMARKETCAP_API_KEY,
    token: 'ETH', // Change token if reporting for other networks like Polygon (MATIC)
  },
};
