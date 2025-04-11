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
    // NOTE: This task still uses the OLD Quoter address and quoteExactInputSingle
    // It will likely continue to fail, kept for reference.
    const quoterAddress = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6"; // INCORRECT for Arbitrum V2!
    let quoterAbi;
    try { quoterAbi = require('./abis/IQuoterV2.json'); } catch { console.error("Missing abis/IQuoterV2.json"); return; }

    const provider = hre.ethers.provider;
    const quoter = new hre.ethers.Contract(quoterAddress, quoterAbi, provider);
    const params = {
      tokenIn: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", // WETH
      tokenOut: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // USDC
      amountIn: hre.ethers.parseEther("0.0001"), // Sim amount
      fee: 3000,
      sqrtPriceLimitX96: 0n
    };
    console.log(`[testQuote - Single] Attempting static call on ${quoterAddress} (Network: ${hre.network.name})`);
    console.log("[testQuote - Single] Parameters:", params);
    try {
      const result = await quoter.quoteExactInputSingle.staticCall(params);
      console.log("[testQuote - Single] ✅ Quote successful!");
      console.log(`  Amount Out (USDC): ${hre.ethers.formatUnits(result.amountOut, 6)}`);
    } catch (error) {
      console.error("[testQuote - Single] ❌ Quote failed:");
      console.error(`  Error Code: ${error.code}`);
      console.error(`  Reason: ${error.reason}`);
      if (error.code === 'CALL_EXCEPTION' || (error.code === -32000 && error.message.includes("execution reverted"))) {
         console.error("  Revert Data:", error.data);
         console.error("  ProviderError Message:", error.message);
      } else { console.error("  Full Error:", error); }
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
        } else { console.log(`   Status: Pool EXISTS.`); }
      } catch (error) {
        console.error(`[checkPools] ❌ Error checking fee ${fee}:`, error);
      }
    }
  });

// <<< UPDATED TASK: Use Arbitrum Quoter V2 (0x61f...) and quoteExactInput >>>
task("debugQuote", "Debug quotes using Arbitrum Quoter V2 and quoteExactInput")
  .addParam("tokenIn", "Input token address")
  .addParam("tokenOut", "Output token address")
  .addParam("amount", "Amount in smallest units (wei)")
  .setAction(async (taskArgs, hre) => {
    const { ethers } = hre;
    // --- Use CORRECT Arbitrum Quoter V2 Address ---
    const quoterV2Address = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
    const factoryAddress = "0x1F98431c8aD98523631AE4a59f267346ea31F984"; // Keep factory for checks if needed

    // --- ABI for Quoter V2 quoteExactInput ---
    // Need to ensure this matches the actual QuoterV2 interface if using full ABI
    // Or use a minimal ABI like this:
    const quoterAbi_quoteExactInput = [
      "function quoteExactInput(bytes path, uint256 amountIn) external returns (uint256 amountOut, uint160[] memory sqrtPriceX96AfterList, uint32[] memory initializedTicksCrossedList, uint256 gasEstimate)"
    ];
    // Factory ABI for pool check (optional within this task)
    // const factoryAbi = ["function getPool(address, address, uint24) view returns (address)"];

    const fees = [100, 500, 3000, 10000]; // Common fee tiers
    // const factory = await ethers.getContractAt(factoryAbi, factoryAddress); // Optional pool check
    const quoter = await ethers.getContractAt(quoterAbi_quoteExactInput, quoterV2Address);

    console.log(`\n[debugQuote] Checking quotes for ${hre.ethers.formatUnits(taskArgs.amount, 18)} WETH -> USDC on ${hre.network.name} using QuoterV2 ${quoterV2Address}...`); // Assume WETH input for logging

    for (const fee of fees) {
      console.log(`\n--- Attempting quote with fee ${fee} (${fee / 10000}%) ---`);

      // --- Encode the path: tokenIn + fee + tokenOut ---
      // Note: ethers.solidityPacked is correct in v6
      const encodedPath = ethers.solidityPacked(
        ["address", "uint24", "address"],
        [taskArgs.tokenIn, fee, taskArgs.tokenOut]
      );
      console.log(`   Encoded Path: ${encodedPath}`);

      try {
        // --- Attempt static call to quoteExactInput ---
        // The function returns multiple values, we destructure to get amountOut
        const [amountOut] = await quoter.quoteExactInput.staticCall(
          encodedPath,
          taskArgs.amount // Pass amount directly
        );

        // Assuming USDC output (6 decimals)
        const formattedOut = ethers.formatUnits(amountOut, 6);
        const inputAmountFormatted = ethers.formatUnits(taskArgs.amount, 18);
        const effectivePrice = parseFloat(formattedOut) / parseFloat(inputAmountFormatted);

        console.log(`   ✅ Quote Success!`);
        console.log(`      Amount Out: ${formattedOut} USDC`);
        console.log(`      Effective Price: ~${effectivePrice.toFixed(2)} USDC per WETH`);
        // Exit on first successful quote for simplicity
        // If you want to see all successful quotes, remove the 'return;' statement
        return;

      } catch (error) {
        console.log(`   ❌ Quote Failed for fee ${fee}:`);
        // Try to parse custom errors if possible (requires full ABI usually)
        let reason = error.reason || "No reason provided";
        if (error.data && error.data !== '0x') {
            try {
                // Attempt to parse with Quoter interface if available, otherwise just show data
                // Note: Minimal ABI won't parse custom errors well. Need full ABI loaded.
                // const decodedError = quoter.interface.parseError(error.data);
                // reason = `${decodedError?.name}(${decodedError?.args})` || reason;
                reason = `Revert data: ${error.data}`;
            } catch (parseErr) { /* ignore if parsing fails */ }
        }
        console.log(`      Error: ${reason} (Code: ${error.code || 'N/A'})`);
      }
    }
    console.log("\n[debugQuote] Finished checking all specified fee tiers. No successful quote found.");
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
