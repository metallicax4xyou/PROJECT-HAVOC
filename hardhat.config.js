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

task("testQuote", "Tests QuoterV2 quote for a specific hardcoded scenario using quoteExactInputSingle")
  .setAction(async (taskArgs, hre) => {
    // ... (testQuote task code remains the same - likely fails) ...
    console.warn("[testQuote - Single] This task uses quoteExactInputSingle and may fail.");
    const quoterAddress = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6"; // Incorrect for Arbitrum V2!
    let quoterAbi;
    try { quoterAbi = require('./abis/IQuoterV2.json'); } catch { console.error("Missing abis/IQuoterV2.json"); return; }
    const provider = hre.ethers.provider;
    const quoter = new hre.ethers.Contract(quoterAddress, quoterAbi, provider);
    const params = { /* ... */ }; // Params defined as before
    // ... rest of testQuote logic ...
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
    const [token0, token1] = tokenWETH.toLowerCase() < tokenUSDC.toLowerCase() ? [tokenWETH, tokenUSDC] : [tokenUSDC, tokenWETH];
    console.log(`  Token0: ${token0}, Token1: ${token1}`);
    for (const fee of feesToCheck) { /* ... rest of checkPools logic ... */ }
  });

task("debugQuote", "Debug quotes using Arbitrum Quoter V2 and quoteExactInput")
  .addParam("tokenIn", "Input token address")
  .addParam("tokenOut", "Output token address")
  .addParam("amount", "Amount in smallest units (wei)")
  .setAction(async (taskArgs, hre) => {
    // ... (debugQuote task code remains the same - successfully quoted fee 100) ...
    const { ethers } = hre;
    const quoterV2Address = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
    const quoterAbi_quoteExactInput = [ /* ... ABI string ... */ ];
    const fees = [100, 500, 3000, 10000];
    const quoter = await ethers.getContractAt(quoterAbi_quoteExactInput, quoterV2Address);
    console.log(`\n[debugQuote] Checking quotes for ${hre.ethers.formatUnits(taskArgs.amount, 18)} WETH -> USDC on ${hre.network.name} using QuoterV2 ${quoterV2Address}...`);
    for (const fee of fees) { /* ... rest of debugQuote logic ... */ }
  });

// <<< NEW TASK: Find Best Quote Across Fee Tiers >>>
task("findBestQuote", "Finds the best quote across common fee tiers using Quoter V2")
  .addParam("tokenIn", "Input token address")
  .addParam("tokenOut", "Output token address")
  .addParam("amount", "Amount in smallest units (wei)")
  .addOptionalParam("decimalsOut", "Decimals of the output token", "6") // Default to 6 for USDC
  .setAction(async (taskArgs, hre) => {
    const { ethers } = hre;
    // --- Use CORRECT Arbitrum Quoter V2 Address ---
    const quoterV2Address = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
    const fees = [100, 500, 3000, 10000]; // Common fee tiers to check
    const outputDecimals = parseInt(taskArgs.decimalsOut);

    // --- Minimal ABI for quoteExactInput ---
    const quoterAbi = [
      "function quoteExactInput(bytes path, uint256 amountIn) external returns (uint256 amountOut, uint160[] memory sqrtPriceX96AfterList, uint32[] memory initializedTicksCrossedList, uint256 gasEstimate)"
    ];
    const quoter = await ethers.getContractAt(quoterAbi, quoterV2Address);

    let bestQuote = { fee: 0, amountOut: 0n }; // Use BigInt for amountOut
    const inputAmountFormatted = ethers.formatUnits(taskArgs.amount, 18); // Assuming WETH input

    console.log(`\n[findBestQuote] Finding best quote for ${inputAmountFormatted} WETH -> ${taskArgs.tokenOut} on ${hre.network.name}`);

    for (const fee of fees) {
      // --- Encode the path: tokenIn + fee + tokenOut ---
      const encodedPath = ethers.solidityPacked(
        ["address", "uint24", "address"],
        [taskArgs.tokenIn, fee, taskArgs.tokenOut]
      );

      process.stdout.write(`--- Checking Fee Tier: ${fee} (${fee / 10000}%) ... `); // Use process.stdout for same line

      try {
        // --- Attempt static call ---
        const [amountOut] = await quoter.quoteExactInput.staticCall(
          encodedPath,
          taskArgs.amount
        );

        const amountOutFormatted = ethers.formatUnits(amountOut, outputDecimals);
        process.stdout.write(`✅ Success: ${amountOutFormatted}\n`); // Print result on same line

        // --- Update best quote if current is better ---
        if (amountOut > bestQuote.amountOut) {
          bestQuote = { fee, amountOut: amountOut };
        }

      } catch (error) {
        // --- Handle quote failure ---
         let reason = error.reason || "Unknown reason";
         if (error.data && error.data !== '0x') {
             reason = `Revert data: ${error.data}`;
         } else if (error.code === 'CALL_EXCEPTION' || (error.code === -32000 && error.message.includes("execution reverted"))) {
             reason = "Execution reverted";
         }
         process.stdout.write(`❌ Failed (${reason})\n`); // Print failure on same line
      }
    } // End fee loop

    // --- Log the best quote found ---
    if (bestQuote.amountOut > 0n) {
        const bestAmountOutFormatted = ethers.formatUnits(bestQuote.amountOut, outputDecimals);
        const effectivePrice = parseFloat(bestAmountOutFormatted) / parseFloat(inputAmountFormatted);
        console.log("\n🌟 Best Quote Found:");
        console.log(`   Fee Tier: ${bestQuote.fee} (${bestQuote.fee / 10000}%)`);
        console.log(`   Amount Out: ${bestAmountOutFormatted} USDC`); // Assume USDC output
        console.log(`   Effective Price: ~${effectivePrice.toFixed(2)} USDC per WETH`);
    } else {
        console.log("\n❌ No successful quote found across checked fee tiers.");
    }
  });


// --- Hardhat Configuration ---

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    compilers: [ { version: "0.7.6", settings: { optimizer: { enabled: true, runs: 9999 } } } ],
  },
  networks: {
    hardhat: { ...(MAINNET_FORK_URL && { forking: { url: MAINNET_FORK_URL } }) },
    arbitrum: {
      url: ARBITRUM_RPC_URL || "",
      accounts: PRIVATE_KEY ? [`0x${PRIVATE_KEY}`] : [],
      chainId: 42161,
      timeout: 120000,
    },
  },
  paths: { sources: "./contracts", tests: "./test", cache: "./cache", artifacts: "./artifacts" },
  etherscan: { apiKey: { arbitrumOne: ARBISCAN_API_KEY || "" }, customChains: [] },
  gasReporter: { enabled: process.env.REPORT_GAS === "true", currency: "USD", coinmarketcap: process.env.COINMARKETCAP_API_KEY, token: 'ETH' },
};
