// hardhat.config.js

// --- Imports ---
require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config(); // Load .env file
const { task } = require("hardhat/config"); // Import task function

// --- Environment Variable Checks ---
// Load all potential variables
const ARBITRUM_RPC_URL = process.env.ARBITRUM_RPC_URL;
const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL;
const BASE_RPC_URL = process.env.BASE_RPC_URL;
const OPTIMISM_RPC_URL = process.env.OPTIMISM_RPC_URL;

const PRIVATE_KEY = process.env.PRIVATE_KEY; // Shared private key for all networks

const ARBISCAN_API_KEY = process.env.ARBISCAN_API_KEY;
const POLYGONSCAN_API_KEY = process.env.POLYGONSCAN_API_KEY;
const BASESCAN_API_KEY = process.env.BASESCAN_API_KEY;
const OPTIMISMSCAN_API_KEY = process.env.OPTIMISMSCAN_API_KEY;

const MAINNET_FORK_URL = process.env.MAINNET_FORK_URL; // Optional

// --- Custom Hardhat Tasks ---

task("checkBalance", "Prints the ETH balance of the deployer account configured for the specified network")
  .setAction(async (taskArgs, hre) => {
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
      // Adjust label based on network
      const currency = networkName === 'polygon' ? 'MATIC' : 'ETH';
      console.log(`💰 Balance: ${balanceEther} ${currency}`);
    } catch (error) {
      console.error("\n❌ Error fetching balance:", error.message);
    }
  });

task("testQuote", "Tests QuoterV2 quote for a specific hardcoded scenario using quoteExactInputSingle")
  .setAction(async (taskArgs, hre) => {
    console.warn("[testQuote - Single] This task uses quoteExactInputSingle and may fail.");
    // Use Arbitrum V2 Quoter address here, although the function might still fail
    const quoterAddress = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
    let quoterAbi;
    try { quoterAbi = require('./abis/IQuoterV2.json'); } catch { console.error("Missing abis/IQuoterV2.json"); return; }

    const provider = hre.ethers.provider;
    const quoter = new hre.ethers.Contract(quoterAddress, quoterAbi, provider);
    const params = {
      tokenIn: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", // WETH on Arbitrum
      tokenOut: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // USDC on Arbitrum
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
    const factoryAddress = "0x1F98431c8aD98523631AE4a59f267346ea31F984"; // Uniswap V3 Factory

    // --- Define Tokens Per Network ---
    // We need to use the correct WETH/USDC addresses for the target network
    let tokenWETH = "";
    let tokenUSDC = "";
    const networkName = hre.network.name;

    switch(networkName) {
        case 'arbitrum':
            tokenWETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
            tokenUSDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
            break;
        case 'polygon':
            tokenWETH = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";
            tokenUSDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // Native USDC on Polygon PoS
            break;
        case 'base':
            tokenWETH = "0x4200000000000000000000000000000000000006";
            tokenUSDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Native USDC on Base
            break;
        case 'optimism':
            tokenWETH = "0x4200000000000000000000000000000000000006";
            tokenUSDC = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"; // Native USDC on Optimism
            break;
        default:
            console.error(`❌ Network ${networkName} not configured in checkPools task.`);
            return;
    }

    const feesToCheck = [100, 500, 3000, 10000]; // Check common fee tiers
    const factoryABI = ["function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)"];
    const factory = new hre.ethers.Contract(factoryAddress, factoryABI, hre.ethers.provider);

    console.log(`\n[checkPools] Checking WETH/USDC pools on ${networkName} using Factory ${factoryAddress}`);
    console.log(`  WETH: ${tokenWETH}`);
    console.log(`  USDC: ${tokenUSDC}`);

    // Factory requires tokens sorted numerically by address
    const [token0, token1] = tokenWETH.toLowerCase() < tokenUSDC.toLowerCase() ? [tokenWETH, tokenUSDC] : [tokenUSDC, tokenWETH];
    console.log(`  Token0 (Sorted): ${token0}`);
    console.log(`  Token1 (Sorted): ${token1}`);

    for (const fee of feesToCheck) {
      try {
        console.log(`--- Checking Fee Tier: ${fee} (${fee / 10000}%) ---`);
        const poolAddress = await factory.getPool(token0, token1, fee); // Use sorted tokens
        console.log(`   Pool Address Found: ${poolAddress}`);
        if (poolAddress === hre.ethers.ZeroAddress) {
          console.log(`   Status: Pool DOES NOT EXIST.`);
        } else {
          console.log(`   Status: Pool EXISTS.`);
        }
      } catch (error) {
        console.error(`[checkPools] ❌ Error checking fee ${fee}:`, error);
      }
    }
     console.log("[checkPools] Finished checking pools.");
  });

task("debugQuote", "Debug quotes using Quoter V2 and quoteExactInput")
  .addParam("tokenIn", "Input token address")
  .addParam("tokenOut", "Output token address")
  .addParam("amount", "Amount in smallest units (wei)")
  .setAction(async (taskArgs, hre) => {
    const { ethers } = hre;
    let quoterV2Address = "";
    const networkName = hre.network.name;
    let inputDecimals = 18; // Default WETH
    let outputDecimals = 6; // Default USDC

    // Select Quoter Address based on network
    switch(networkName) {
        case 'arbitrum':
        case 'polygon':
        case 'base':
        case 'optimism':
            quoterV2Address = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e"; // Same V2 address on these L2s
            break;
        // Add other networks if needed
        default:
             console.error(`❌ Quoter V2 address not configured for network ${networkName} in debugQuote task.`);
             return;
    }

    // Basic check for non-WETH input to adjust logging - more robust check needed for real use
    if (taskArgs.tokenIn.toLowerCase() !== "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1".toLowerCase() && // Arb WETH
        taskArgs.tokenIn.toLowerCase() !== "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619".toLowerCase() && // Poly WETH
        taskArgs.tokenIn.toLowerCase() !== "0x4200000000000000000000000000000000000006".toLowerCase()) { // Base/Op WETH
           // Assume input is USDC if not WETH for logging purposes
           inputDecimals = 6;
           outputDecimals = 18; // Assume output is WETH
           console.warn("[debugQuote] Input token doesn't look like standard WETH, assuming 6 decimals for input formatting.");
        }

    const quoterAbi_quoteExactInput = [
      "function quoteExactInput(bytes path, uint256 amountIn) external returns (uint256 amountOut, uint160[] memory sqrtPriceX96AfterList, uint32[] memory initializedTicksCrossedList, uint256 gasEstimate)"
    ];
    const fees = [100, 500, 3000, 10000];
    const quoter = await ethers.getContractAt(quoterAbi_quoteExactInput, quoterV2Address);

    console.log(`\n[debugQuote] Checking quotes for ${hre.ethers.formatUnits(taskArgs.amount, inputDecimals)} input -> ${taskArgs.tokenOut} on ${networkName} using QuoterV2 ${quoterV2Address}...`);

    for (const fee of fees) {
      console.log(`--- Attempting quote with fee ${fee} (${fee / 10000}%) ---`);
      const encodedPath = ethers.solidityPacked(
        ["address", "uint24", "address"],
        [taskArgs.tokenIn, fee, taskArgs.tokenOut]
      );
      console.log(`   Encoded Path: ${encodedPath}`);
      try {
        const [amountOut] = await quoter.quoteExactInput.staticCall(encodedPath, taskArgs.amount);
        const formattedOut = ethers.formatUnits(amountOut, outputDecimals);
        const inputAmountFormatted = ethers.formatUnits(taskArgs.amount, inputDecimals);
        const effectivePrice = parseFloat(formattedOut) / parseFloat(inputAmountFormatted); // Price of input in terms of output
        console.log(`   ✅ Quote Success!`);
        console.log(`      Amount Out: ${formattedOut}`);
        console.log(`      Effective Price: ~${effectivePrice.toFixed(outputDecimals === 6 ? 2 : 6)} Output per Input`);
        // return; // Remove return to see all successful quotes
      } catch (error) {
        console.log(`   ❌ Quote Failed for fee ${fee}:`);
        let reason = error.reason || "No reason provided";
        if (error.data && error.data !== '0x') { reason = `Revert data: ${error.data}`; }
        else if (error.code === 'CALL_EXCEPTION' || (error.code === -32000 && error.message.includes("execution reverted"))) { reason = "Execution reverted"; }
        console.log(`      Error: ${reason} (Code: ${error.code || 'N/A'})`);
      }
    }
    console.log("\n[debugQuote] Finished checking all specified fee tiers.");
  });

task("findBestQuote", "Finds the best quote across common fee tiers using Quoter V2")
  .addParam("tokenIn", "Input token address")
  .addParam("tokenOut", "Output token address")
  .addParam("amount", "Amount in smallest units (wei)")
  .addOptionalParam("decimalsOut", "Decimals of the output token", "6")
  .setAction(async (taskArgs, hre) => {
    const { ethers } = hre;
    let quoterV2Address = "";
    const networkName = hre.network.name;
    let inputDecimals = 18; // Default WETH

     // Select Quoter Address based on network
    switch(networkName) {
        case 'arbitrum':
        case 'polygon':
        case 'base':
        case 'optimism':
            quoterV2Address = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e"; // Same V2 address on these L2s
            break;
        default:
             console.error(`❌ Quoter V2 address not configured for network ${networkName} in findBestQuote task.`);
             return;
    }
     // Basic check for non-WETH input to adjust logging
    if (taskArgs.tokenIn.toLowerCase() !== "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1".toLowerCase() && // Arb WETH
        taskArgs.tokenIn.toLowerCase() !== "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619".toLowerCase() && // Poly WETH
        taskArgs.tokenIn.toLowerCase() !== "0x4200000000000000000000000000000000000006".toLowerCase()) { // Base/Op WETH
           inputDecimals = 6; // Assume 6 decimals if not WETH
           console.warn("[findBestQuote] Input token doesn't look like standard WETH, assuming 6 decimals for input formatting.");
        }

    const fees = [100, 500, 3000, 10000];
    const outputDecimals = parseInt(taskArgs.decimalsOut);
    const quoterAbi = [
      "function quoteExactInput(bytes path, uint256 amountIn) external returns (uint256 amountOut, uint160[] memory sqrtPriceX96AfterList, uint32[] memory initializedTicksCrossedList, uint256 gasEstimate)"
    ];
    const quoter = await ethers.getContractAt(quoterAbi, quoterV2Address);

    let bestQuote = { fee: 0, amountOut: 0n };
    const inputAmountFormatted = ethers.formatUnits(taskArgs.amount, inputDecimals);

    console.log(`\n[findBestQuote] Finding best quote for ${inputAmountFormatted} input -> ${taskArgs.tokenOut} on ${networkName}`);

    for (const fee of fees) {
      const encodedPath = ethers.solidityPacked(
        ["address", "uint24", "address"],
        [taskArgs.tokenIn, fee, taskArgs.tokenOut]
      );
      process.stdout.write(`--- Checking Fee Tier: ${fee} (${fee / 10000}%) ... `);
      try {
        const [amountOut] = await quoter.quoteExactInput.staticCall(encodedPath, taskArgs.amount);
        const amountOutFormatted = ethers.formatUnits(amountOut, outputDecimals);
        process.stdout.write(`✅ Success: ${amountOutFormatted}\n`);
        if (amountOut > bestQuote.amountOut) {
          bestQuote = { fee, amountOut: amountOut };
        }
      } catch (error) {
        let reason = error.reason || "Unknown reason";
        if (error.data && error.data !== '0x') { reason = `Revert data: ${error.data}`; }
        else if (error.code === 'CALL_EXCEPTION' || (error.code === -32000 && error.message.includes("execution reverted"))) { reason = "Execution reverted"; }
        process.stdout.write(`❌ Failed (${reason})\n`);
      }
    }

    if (bestQuote.amountOut > 0n) {
        const bestAmountOutFormatted = ethers.formatUnits(bestQuote.amountOut, outputDecimals);
        const effectivePrice = parseFloat(bestAmountOutFormatted) / parseFloat(inputAmountFormatted);
        console.log("\n🌟 Best Quote Found:");
        console.log(`   Fee Tier: ${bestQuote.fee} (${bestQuote.fee / 10000}%)`);
        console.log(`   Amount Out: ${bestAmountOutFormatted}`); // Units depend on output token
        console.log(`   Effective Price: ~${effectivePrice.toFixed(outputDecimals === 6 ? 2 : 6)} Output per Input`);
    } else {
        console.log("\n❌ No successful quote found across checked fee tiers.");
    }
  });


// --- Hardhat Configuration ---

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: { // Keep solidity config
    compilers: [ { version: "0.7.6", settings: { optimizer: { enabled: true, runs: 9999 } } } ],
  },
  defaultNetwork: "hardhat", // Optional: Set a default network
  networks: {
    hardhat: { // Keep hardhat config
       ...(MAINNET_FORK_URL && { forking: { url: MAINNET_FORK_URL } }),
    },
    // --- Arbitrum ---
    arbitrum: {
      url: ARBITRUM_RPC_URL || "",
      accounts: PRIVATE_KEY ? [`0x${PRIVATE_KEY}`] : [],
      chainId: 42161,
      timeout: 120000,
    },
    // --- Polygon ---
    polygon: {
      url: POLYGON_RPC_URL || "",
      accounts: PRIVATE_KEY ? [`0x${PRIVATE_KEY}`] : [],
      chainId: 137,
      // gasPrice: 80000000000, // Optional: Set gas price if needed for Polygon legacy txns
      timeout: 120000,
    },
    // --- Base ---
    base: {
      url: BASE_RPC_URL || "",
      accounts: PRIVATE_KEY ? [`0x${PRIVATE_KEY}`] : [],
      chainId: 8453,
      timeout: 120000,
    },
     // --- Optimism ---
    optimism: {
      url: OPTIMISM_RPC_URL || "",
      accounts: PRIVATE_KEY ? [`0x${PRIVATE_KEY}`] : [],
      chainId: 10,
      // gasPrice: 1000000, // Optional: Optimism gas price setting if needed
      timeout: 120000,
    },
  },
  paths: { // Keep paths config
    sources: "./contracts", tests: "./test", cache: "./cache", artifacts: "./artifacts",
  },
  etherscan: {
    apiKey: { // Add API keys for all networks
       arbitrumOne: ARBISCAN_API_KEY || "",
       polygon: POLYGONSCAN_API_KEY || "",
       base: BASESCAN_API_KEY || "", // Use 'base' as the key
       optimisticEthereum: OPTIMISMSCAN_API_KEY || "",
    },
     // Add custom chain definition for Base verification
     customChains: [
        {
          network: "base",
          chainId: 8453,
          urls: {
            apiURL: "https://api.basescan.org/api",
            browserURL: "https://basescan.org"
          }
        }
      ]
  },
  gasReporter: { // Keep gas reporter config
    enabled: process.env.REPORT_GAS === "true", currency: "USD", coinmarketcap: process.env.COINMARKETCAP_API_KEY, token: 'ETH',
  },
};
