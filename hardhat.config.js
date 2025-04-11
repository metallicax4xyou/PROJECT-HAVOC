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
    // ... (checkBalance task code remains the same) ...
    const networkName = hre.network.name;
    console.log(`🔎 Checking balance on network: ${networkName}`);
    try {
      const signers = await hre.ethers.getSigners();
      if (!signers || signers.length === 0) {
          console.error(`❌ Error: Could not get deployer account for network ${networkName}. Check network config and PRIVATE_KEY in .env.`);
          return;
      }
      const deployer = signers[0];
      const address = deployer.address;
      console.log(`👤 Account Address: ${address}`);
      const balanceWei = await hre.ethers.provider.getBalance(address);
      const balanceEther = hre.ethers.formatEther(balanceWei);
      console.log(`💰 Balance: ${balanceEther} ETH`);
    } catch (error) {
      console.error("\n❌ Error fetching balance:", error.message);
    }
  });

task("testQuote", "Tests QuoterV2 quote for a specific hardcoded scenario")
  .setAction(async (taskArgs, hre) => {
    // ... (testQuote task code remains the same, useful for specific tests) ...
    const quoterAddress = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6"; // Quoter V2 Address
    const quoterAbi = require('./abis/IQuoterV2.json');
    const provider = hre.ethers.provider;
    const quoter = new hre.ethers.Contract(quoterAddress, quoterAbi, provider);
    const params = {
      tokenIn: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", // WETH
      tokenOut: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // USDC
      amountIn: hre.ethers.parseEther("0.0001"), // Sim amount
      fee: 3000, // Pool B fee (3000 bps = 0.30%) - KNOWN TO FAIL CURRENTLY
      sqrtPriceLimitX96: 0n
    };
    console.log(`[testQuote] Attempting static call to quoteExactInputSingle on ${quoterAddress} (Network: ${hre.network.name})`);
    console.log("[testQuote] Parameters:", params);
    try {
      const result = await quoter.quoteExactInputSingle.staticCall(params);
      console.log("[testQuote] ✅ Quote successful!");
      console.log(`  Amount Out (USDC): ${hre.ethers.formatUnits(result.amountOut, 6)}`);
      console.log(`  sqrtPriceX96After: ${result.sqrtPriceX96After.toString()}`);
      console.log(`  initializedTicksCrossed: ${result.initializedTicksCrossed.toString()}`);
      console.log(`  gasEstimate: ${result.gasEstimate.toString()}`);
    } catch (error) {
      console.error("[testQuote] ❌ Quote failed:");
      console.error(`  Error Code: ${error.code}`);
      console.error(`  Reason: ${error.reason}`);
      if (error.code === 'CALL_EXCEPTION' || (error.code === -32000 && error.message.includes("execution reverted"))) {
         console.error("  Revert Data:", error.data);
         console.error("  Transaction:", error.transaction);
         console.error("  ProviderError Message:", error.message);
      } else {
         console.error("  Full Error:", error);
      }
    }
  });

task("checkPools", "Checks if specific WETH/USDC pools exist on the network")
  .setAction(async (taskArgs, hre) => {
    // ... (checkPools task code remains the same) ...
    const factoryAddress = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
    const tokenWETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
    const tokenUSDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
    const feesToCheck = [100, 500, 3000, 10000];
    const factoryABI = ["function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)"];
    const factory = new hre.ethers.Contract(factoryAddress, factoryABI, hre.ethers.provider);
    console.log(`[checkPools] Checking WETH/USDC pools on ${hre.network.name} using Factory ${factoryAddress}`);
    console.log(`  WETH: ${tokenWETH}`);
    console.log(`  USDC: ${tokenUSDC}`);
    const [token0, token1] = tokenWETH.toLowerCase() < tokenUSDC.toLowerCase() ? [tokenWETH, tokenUSDC] : [tokenUSDC, tokenWETH];
    console.log(`  Token0 (Sorted): ${token0}`);
    console.log(`  Token1 (Sorted): ${token1}`);
    for (const fee of feesToCheck) {
      try {
        console.log(`\n--- Checking Fee Tier: ${fee} (${fee / 10000}%) ---`);
        const poolAddress = await factory.getPool(token0, token1, fee);
        console.log(`   Pool Address Found: ${poolAddress}`);
        if (poolAddress === hre.ethers.ZeroAddress) {
          console.log(`   Status: Pool DOES NOT EXIST.`);
        } else {
          console.log(`   Status: Pool EXISTS.`);
          // Compare with config addresses (using corrected Pool B address now)
          const configPoolA = "0xC6962004f452bE9203591991D15f6b388e09E8D0";
          const configPoolB = "0xc473e2aEE3441BF9240Be85eb122aBB059A3B57c"; // Corrected
          if (fee === 500 && poolAddress.toLowerCase() === configPoolA.toLowerCase()) {
             console.log("     ✅ Matches Pool A address in current config.");
          } else if (fee === 500) {
             console.log(`     ⚠️ Mismatch: Config Pool A is ${configPoolA} but Factory returned ${poolAddress}`);
          }
          if (fee === 3000 && poolAddress.toLowerCase() === configPoolB.toLowerCase()) {
             console.log("     ✅ Matches Pool B address in current config.");
          } else if (fee === 3000) {
              console.log(`     ⚠️ Mismatch: Config Pool B is ${configPoolB} but Factory returned ${poolAddress}`);
          }
        }
      } catch (error) {
        console.error(`[checkPools] ❌ Error checking fee ${fee}:`, error);
      }
    }
  });

// <<< NEW TASK: Debug Quote Across Fee Tiers >>>
task("debugQuote", "Checks pool existence and attempts quotes across common fee tiers")
  .addParam("tokenIn", "Input token address")
  .addParam("tokenOut", "Output token address")
  .addParam("amount", "Amount in smallest units (wei)")
  .setAction(async (taskArgs, hre) => {
    const { ethers } = hre;
    const factoryAddress = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
    const quoterAddress = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";

    // Factory ABI
    const factoryAbi = ["function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)"];
    // Quoter ABI (ensure IQuoterV2.json is correct and cleaned)
    const quoterAbi = require('./abis/IQuoterV2.json');

    const fees = [100, 500, 3000, 10000]; // Common fee tiers
    const factory = await ethers.getContractAt(factoryAbi, factoryAddress);
    const quoter = await ethers.getContractAt(quoterAbi, quoterAddress); // Use full ABI

    console.log(`\n[debugQuote] Checking quotes for ${ethers.formatUnits(taskArgs.amount, 18)} WETH -> USDC on ${hre.network.name}...`); // Assume WETH input for logging

    // Sort tokens for factory call
    const tokenA = taskArgs.tokenIn;
    const tokenB = taskArgs.tokenOut;
    const [token0, token1] = tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];

    for (const fee of fees) {
      console.log(`\n--- Checking Fee Tier: ${fee} (${fee / 10000}%) ---`);

      // Check pool existence
      const poolAddress = await factory.getPool(token0, token1, fee);

      if (poolAddress === ethers.ZeroAddress) {
        console.log(`   ❌ Pool DOES NOT EXIST for fee tier ${fee}. Skipping quote.`);
        continue;
      }

      console.log(`   ✅ Pool EXISTS at ${poolAddress}. Attempting quote...`);

      // Prepare params for quoter
      const params = {
          tokenIn: taskArgs.tokenIn,
          tokenOut: taskArgs.tokenOut,
          amountIn: taskArgs.amount,
          fee: fee,
          sqrtPriceLimitX96: 0n
      };

      try {
        // Attempt static call using the object param structure
        const result = await quoter.quoteExactInputSingle.staticCall(params);

        // Assuming USDC output (6 decimals)
        const amountOutFormatted = ethers.formatUnits(result.amountOut, 6);

        console.log(`   ✅ Quote Success!`);
        console.log(`      Amount Out: ${amountOutFormatted} USDC`);
        // Exit on first successful quote for simplicity, or remove 'return' to see all
        return;

      } catch (error) {
        console.log(`   ❌ Quote Failed for fee ${fee}: ${error.reason || error.message}`);
         if (error.code === 'CALL_EXCEPTION' || (error.code === -32000 && error.message.includes("execution reverted"))) {
             // Don't log the full transaction object here, too verbose
             console.log(`      (Revert Code: ${error.code}, Reason: ${error.reason || 'None provided'}, Data: ${error.data})`);
         }
      }
    }
    console.log("\n[debugQuote] Finished checking all specified fee tiers.");
  });


// --- Hardhat Configuration ---

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    compilers: [
      {
        version: "0.7.6",
        settings: { optimizer: { enabled: true, runs: 9999 } },
      },
    ],
  },
  networks: {
    hardhat: {
       ...(MAINNET_FORK_URL && { forking: { url: MAINNET_FORK_URL } }),
    },
    arbitrum: {
      url: ARBITRUM_RPC_URL || "",
      accounts: PRIVATE_KEY ? [`0x${PRIVATE_KEY}`] : [],
      chainId: 42161,
      timeout: 120000,
    },
  },
  paths: {
    sources: "./contracts", tests: "./test", cache: "./cache", artifacts: "./artifacts",
  },
  etherscan: {
    apiKey: { arbitrumOne: ARBISCAN_API_KEY || "" },
    customChains: []
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true", currency: "USD", coinmarketcap: process.env.COINMARKETCAP_API_KEY, token: 'ETH',
  },
};
