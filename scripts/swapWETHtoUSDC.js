// scripts/swapWETHtoUSDC.js

// Use the standalone ethers library for direct provider and wallet control
const { ethers } = require("ethers");
// Import dotenv to load environment variables from .env
require('dotenv').config();

async function main() {
  console.log("Running swapWETHtoUSDC.js script (Attempting swap with Uniswap V3 WETH/USDC.e)...");

  // Get RPC URL and Private Key from environment variables
  const rpcUrl = process.env.LOCAL_FORK_RPC_URL;
  const privateKey = process.env.LOCAL_FORK_PRIVATE_KEY;

  if (!rpcUrl || !privateKey) {
      console.error("Error: LOCAL_FORK_RPC_URL and LOCAL_FORK_PRIVATE_KEY must be set in your .env file.");
      console.error("Process Environment Keys:", Object.keys(process.env));
      process.exit(1);
  }

  console.log(`Connecting to RPC: ${rpcUrl}`);

  // Set up a standalone JsonRpcProvider and Wallet (Signer)
  let provider;
  try {
    provider = new ethers.JsonRpcProvider(rpcUrl);
    console.log("JsonRpcProvider created.");
    const blockNumber = await provider.getBlockNumber();
    console.log(`Provider successfully connected. Current block: ${blockNumber}`);
  } catch (error) {
    console.error("Error creating JsonRpcProvider or connecting:", error);
    process.exit(1);
  }

  let deployer;
  try {
    deployer = new ethers.Wallet(privateKey, provider); // The signer instance
    console.log("Ethers Wallet created.");
    console.log("Using account:", deployer.address);
    console.log("Deployer address type:", typeof deployer.address);
  } catch (error) {
    console.error("Error creating Ethers Wallet:", error);
    if (error.message.includes("invalid mnemonic") || error.message.includes("invalid private key")) {
      console.error("Hint: Ensure LOCAL_FORK_PRIVATE_KEY is a valid private key string (starts with 0x) and corresponds to a funded account on the local fork.");
    }
    process.exit(1);
  }

  // Get contract addresses
  const WETH_ADDRESS = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"; // WETH on Arbitrum
  const USDCE_ADDRESS = "0xFF970A61A04b1cA1cA37447f62EAbeA514106c"; // USDC.e on Arbitrum
  // --- UPDATING TO UNISWAP V3 ROUTER AND QUOTER ---
  const UNISWAP_V3_ROUTER_ADDRESS = "0xE592427A0AEce92De3Edee1F18E0157C05861564"; // Uniswap V3 Router 2
  const UNISWAP_V3_QUOTER_ADDRESS = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e"; // Uniswap V3 Quoter V2
  const USDC_WETH_V3_POOL_ADDRESS = "0x6f38e884725a116C9C7fBF208e79FE8828a2595F"; // Example WETH/USDC.e 100bps pool from your config

  console.log("\n--- Addresses ---");
  console.log("WETH_ADDRESS:", WETH_ADDRESS);
  console.log("USDCE_ADDRESS:", USDCE_ADDRESS);
  console.log("UNISWAP_V3_ROUTER_ADDRESS:", UNISWAP_V3_ROUTER_ADDRESS);
  console.log("UNISWAP_V3_QUOTER_ADDRESS:", UNISWAP_V3_QUOTER_ADDRESS);
  console.log("-----------------\n");

  // --- Define specific ABIs needed in the script ---

  // Minimal WETH ABI including deposit, approve, and balanceOf
  const WETH_MINIMAL_ABI = [
      "function deposit() payable",
      "function approve(address spender, uint amount) returns (bool)",
      "function balanceOf(address account) view returns (uint256)"
  ];
  console.log("--- WETH ABI (Minimal) ---");
  console.log("Is WETH_MINIMAL_ABI an array?", Array.isArray(WETH_MINIMAL_ABI));
  console.log("WETH_MINIMAL_ABI length:", WETH_MINIMAL_ABI.length);
  console.log("-------------------------\n");

  // Standard ERC20 ABI for USDC.e
  let ERC20_ABI;
  console.log("--- ERC20 ABI (from abis/ERC20.json) ---");
  try {
      const ERC20_LOADED = require("/workspaces/arbitrum-flash/abis/ERC20.json");
      console.log("Required abis/ERC20.json successfully.");
      if (Array.isArray(ERC20_LOADED)) {
          ERC20_ABI = ERC20_LOADED;
      } else if (ERC20_LOADED && Array.isArray(ERC20_LOADED.abi)) {
          ERC20_ABI = ERC20_LOADED.abi;
      } else {
          throw new Error("Invalid ERC20 ABI format");
      }
      console.log("Is ERC20_ABI an array?", Array.isArray(ERC20_ABI));
      console.log("ERC20_ABI length:", ERC20_ABI.length);
  } catch (error) {
      console.error("Error requiring or processing abis/ERC20.json:", error);
      process.exit(1);
  }
  console.log("-------------------------\n");

  // Uniswap V3 Router 2 ABI (from artifacts)
  let UNISWAP_V3_ROUTER_ABI;
  console.log("--- Uniswap V3 Router ABI (from artifacts/...) ---");
  try {
    // Assuming the artifact path for Uniswap V3 Router 2
    const UNISWAP_V3_ROUTER_ARTIFACT = require("/workspaces/arbitrum-flash/artifacts/@uniswap/v3-periphery/contracts/SwapRouter.sol/SwapRouter.json"); // COMMON V3 Router path
    console.log("Required V3 Router artifact JSON successfully.");
    if (UNISWAP_V3_ROUTER_ARTIFACT && Array.isArray(UNISWAP_V3_ROUTER_ARTIFACT.abi)) {
      UNISWAP_V3_ROUTER_ABI = UNISWAP_V3_ROUTER_ARTIFACT.abi;
    } else {
      throw new Error("Invalid V3 Router ABI artifact format");
    }
    console.log("Is UNISWAP_V3_ROUTER_ABI an array?", Array.isArray(UNISWAP_V3_ROUTER_ABI));
    console.log("UNISWAP_V3_ROUTER_ABI length:", UNISWAP_V3_ROUTER_ABI.length);
  } catch (error) {
    console.error("Error requiring or processing V3 Router artifact JSON:", error);
     // Fallback to a known V3 Router ABI if artifact path is wrong
     console.warn("Attempting to load V3 Router ABI from a common hardcoded path...");
     try {
        const FALLBACK_ROUTER_ARTIFACT = require("@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json");
         if (FALLBACK_ROUTER_ARTIFACT && Array.isArray(FALLBACK_ROUTER_ARTIFACT.abi)) {
              UNISWAP_V3_ROUTER_ABI = FALLBACK_ROUTER_ARTIFACT.abi;
              console.warn("Successfully loaded V3 Router ABI from fallback path.");
         } else {
             throw new Error("Fallback V3 Router ABI not valid");
         }
     } catch(fallbackError) {
          console.error("Fallback V3 Router ABI loading failed:", fallbackError);
          process.exit(1); // Exit if we can't load critical ABI
     }
  }
  console.log("-------------------------------\n");

   // Uniswap V3 Quoter V2 ABI (from artifacts) - Needed for getAmountsOut equivalent
   let UNISWAP_V3_QUOTER_ABI;
   console.log("--- Uniswap V3 Quoter V2 ABI (from artifacts/...) ---");
   try {
     // Assuming the artifact path for Uniswap V3 Quoter V2
     const UNISWAP_V3_QUOTER_ARTIFACT = require("/workspaces/arbitrum-flash/artifacts/@uniswap/v3-periphery/contracts/lens/QuoterV2.sol/QuoterV2.json"); // COMMON V3 Quoter path
     console.log("Required V3 Quoter artifact JSON successfully.");
     if (UNISWAP_V3_QUOTER_ARTIFACT && Array.isArray(UNISWAP_V3_QUOTER_ARTIFACT.abi)) {
       UNISWAP_V3_QUOTER_ABI = UNISWAP_V3_QUOTER_ARTIFACT.abi;
     } else {
       throw new Error("Invalid V3 Quoter ABI artifact format");
     }
     console.log("Is UNISWAP_V3_QUOTER_ABI an array?", Array.isArray(UNISWAP_V3_QUOTER_ABI));
     console.log("UNISWAP_V3_QUOTER_ABI length:", UNISWAP_V3_QUOTER_ABI.length);
   } catch (error) {
     console.error("Error requiring or processing V3 Quoter artifact JSON:", error);
      // Fallback to a known V3 Quoter ABI if artifact path is wrong
      console.warn("Attempting to load V3 Quoter ABI from a common hardcoded path...");
      try {
         const FALLBACK_QUOTER_ARTIFACT = require("@uniswap/v3-periphery/artifacts/contracts/lens/QuoterV2.sol/QuoterV2.json");
          if (FALLBACK_QUOTER_ARTIFACT && Array.isArray(FALLBACK_QUOTER_ARTIFACT.abi)) {
               UNISWAP_V3_QUOTER_ABI = FALLBACK_QUOTER_ARTIFACT.abi;
               console.warn("Successfully loaded V3 Quoter ABI from fallback path.");
          } else {
              throw new Error("Fallback V3 Quoter ABI not valid");
          }
      } catch(fallbackError) {
           console.error("Fallback V3 Quoter ABI loading failed:", fallbackError);
           process.exit(1); // Exit if we can't load critical ABI
      }
   }
   console.log("--------------------------------\n");


  // Get contract instances using standard Ethers v6 constructor, connected to the standalone Wallet
  console.log("Attempting to get contract instances using new ethers.Contract() with standalone Wallet...");
  let weth, usdcE, uniswapRouter, uniswapQuoter; // Changed from sushiRouter to uniswapRouter/Quoter

  try {
      console.log("-> Attempting to instantiate WETH contract...");
      weth = new ethers.Contract(WETH_ADDRESS, WETH_MINIMAL_ABI, deployer);
      console.log(`Instantiated WETH contract. Target: ${weth.target}`);

      console.log("-> Attempting to instantiate USDC.e contract...");
      usdcE = new ethers.Contract(USDCE_ADDRESS, ERC20_ABI, deployer); // Use ERC20 ABI for USDC.e
      console.log(`Instantiated USDC.e contract. Target: ${usdcE.target}`);

      console.log("-> Attempting to instantiate Uniswap V3 Router contract...");
      uniswapRouter = new ethers.Contract(UNISWAP_V3_ROUTER_ADDRESS, UNISWAP_V3_ROUTER_ABI, deployer); // <-- Using V3 Router
      console.log(`Instantiated Uniswap V3 Router contract. Target: ${uniswapRouter.target}`);

       console.log("-> Attempting to instantiate Uniswap V3 Quoter contract..."); // <-- Instantiating Quoter
      uniswapQuoter = new ethers.Contract(UNISWAP_V3_QUOTER_ADDRESS, UNISWAP_V3_QUOTER_ABI, deployer);
      console.log(`Instantiated Uniswap V3 Quoter contract. Target: ${uniswapQuoter.target}`);


      console.log("Finished attempting to get contract instances.");

      if (!weth || !usdcE || !uniswapRouter || !uniswapQuoter || !weth.target || !usdcE.target || !uniswapRouter.target || !uniswapQuoter.target) {
           throw new Error("Failed to get one or more contract instances with valid targets.");
      }
       console.log("\nAll contract instances obtained and have valid targets. Proceeding with Simulation Sequence ---\n");

  } catch (error) {
      console.error("\nError during contract instantiation with new ethers.Contract():", error);
      process.exit(1);
  }

  console.log("\n--- Contract Instances Obtained. Proceeding with Simulation Sequence ---\n");

  // --- Simulation Sequence ---

  // Wrap 1 ETH into WETH (Already successfully tested)
  const amountToWrap = ethers.parseEther("1.0");
  console.log(`Wrapping ${ethers.formatEther(amountToWrap)} ETH to WETH...`);
  let tx = await weth.deposit({ value: amountToWrap });
  console.log(`Transaction sent: ${tx.hash}`);
  await tx.wait();
  console.log("Wrapped ETH to WETH.");

  // Check WETH balance after wrapping (Already successfully tested)
  let wethBalance = await weth.balanceOf(deployer.address);
  console.log("Deployer WETH balance:", ethers.formatUnits(wethBalance, 18));


  // Approve the Uniswap V3 Router to spend our WETH
  const amountToApprove = ethers.MaxUint256;
  console.log("Approving Uniswap V3 Router..."); // <-- Updated Log
  // Approve the V3 Router address
  tx = await weth.approve(UNISWAP_V3_ROUTER_ADDRESS, amountToApprove); // <-- Approving V3 Router
  console.log(`Approval Transaction sent: ${tx.hash}`);
  await tx.wait();
  console.log("Approved Uniswap V3 Router.");


  // Perform the swap: Swap 0.5 WETH for USDC.e on Uniswap V3
  const amountIn = ethers.parseEther("0.5"); // Swap 0.5 WETH
  // Uniswap V3 exactInputSingle uses a struct parameter
  const poolFee = 100; // WETH/USDC.e 100bps pool Fee (0.01%)
  const deadline = Math.floor(Date.now() / 1000) + 60 * 5; // 5 minutes from now
  const amountOutMinimum = 0; // Minimum amount expected out (0 for testing simplicity)
  const sqrtPriceLimitX96 = 0; // Used for limiting price movement (0 for no limit)

  // Uniswap V3 exactInputSingle parameters struct
  const params = {
      tokenIn: WETH_ADDRESS,
      tokenOut: USDCE_ADDRESS,
      fee: poolFee,
      recipient: deployer.address,
      deadline: deadline,
      amountIn: amountIn,
      amountOutMinimum: amountOutMinimum,
      sqrtPriceLimitX96: sqrtPriceLimitX96, // Need to use BigInt(0) or similar if not 0
      // sqrtPriceLimitX96: ethers.getBigInt(0), // Example for BigInt conversion
  };


  console.log(`Swapping ${ethers.formatEther(amountIn)} WETH for USDC.e via Uniswap V3 Router...`); // <-- Updated Log
  console.log("Swap Parameters:", params); // Log the parameters struct


  // --- Diagnosing Swap Revert (Adapted for Uniswap V3 Quoter) ---

  // 1. Check expected output using Quoter.quoteExactInputSingle (view call)
  console.log("\n--- Diagnosing Swap: Checking Quoter.quoteExactInputSingle ---");
  try {
      // Quoter V2 uses a struct as well, but simpler than the router swap params
      const quoteParams = {
           tokenIn: WETH_ADDRESS,
           tokenOut: USDCE_ADDRESS,
           amountIn: amountIn,
           fee: poolFee,
           sqrtPriceLimitX96: 0 // Use 0 for Quoter as well
           // sqrtPriceLimitX96: ethers.getBigInt(0), // Example for BigInt conversion
      };
      const quoteResult = await uniswapQuoter.quoteExactInputSingle(quoteParams);
      console.log(`Quoter.quoteExactInputSingle successful.`);
      // Quote result is an object containing amountOut and sqrtPriceX96After
      console.log(`Estimated output amount for WETH -> USDC.e (${poolFee} bps) swap: ${ethers.formatUnits(quoteResult.amountOut, 6)} USDC.e`); // USDC.e has 6 decimals

  } catch (error) {
      console.error("\nQuoter.quoteExactInputSingle failed. This pool might not be supported or liquidity is too low in the forked state."); // <-- Updated Log
      console.error("Error Object:", error);
      console.error("Error Reason:", error.reason);
      console.error("Error Code:", error.code);
      console.error("Error Data:", error.data);
      console.error("Error Message:", error.message);
      // Do NOT exit here, callStatic might still work or provide a better error
  }
   console.log("------------------------------------------\n");


  // 2. Perform a dry-run using callStatic on Router.exactInputSingle (simulates the transaction)
  console.log("\n--- Diagnosing Swap: Performing callStatic dry-run on Router.exactInputSingle ---");
  try {
      // Call callStatic.exactInputSingle with the swap parameters
      const callStaticResult = await uniswapRouter.callStatic.exactInputSingle(params); // <-- Using V3 Router callStatic
      console.log("callStatic exactInputSingle successful.");
      console.log("callStatic Result (amountOut):", ethers.formatUnits(callStaticResult, 6)); // callStatic returns amountOut directly for this method

  } catch (error) {
      console.error("\ncallStatic exactInputSingle failed. This confirms the transaction would revert on-chain."); // <-- Updated Log
      console.error("Error Object:", error);
      console.error("Error Reason:", error.reason);
      console.error("Error Code:", error.code);
      console.error("Error Data:", error.data);
      console.error("Error Message:", error.message);
       if (error.code === 'CALL_EXCEPTION') {
            console.error("Hint: CALL_EXCEPTION from callStatic often means the specific on-chain revert reason was not returned.");
       }
      process.exit(1); // Exit if callStatic fails
  }
   console.log("-----------------------------------------------------\n");


    // --- If Quoter and callStatic succeeded, attempt the actual transaction ---
    console.log("\n--- Diagnosis passed. Attempting actual swap transaction (Router.exactInputSingle) ---");
    let actualSwapTx;
    try {
        // Call exactInputSingle on the uniswapRouter instance
        actualSwapTx = await uniswapRouter.exactInputSingle(params); // <-- Using V3 Router
        console.log(`Swap Transaction sent: ${actualSwapTx.hash}`);
        const receipt = await actualSwapTx.wait(); // Wait for tx to be mined
        console.log("Swap successful. Transaction hash:", receipt.transactionHash);
        console.log("Gas used:", receipt.gasUsed.toString());

    } catch (error) {
        console.error("\nActual Uniswap V3 Swap failed:"); // <-- Updated Log
         console.error("Error Object:", error);
        console.error("Error Reason:", error.reason);
        console.error("Error Code:", error.code);
        console.error("Error Data:", error.data);
        console.error("Error Message:", error.message);
        process.exit(1); // Exit on actual swap failure
    }
     console.log("-----------------------------\n");


  // Check final balances
  console.log("Checking final balances...");
  // Use the wallet instance for static calls like balanceOf
  const deployerAddress = deployer.address; // Raw string address

  wethBalance = await weth.balanceOf(deployerAddress);
  let usdcEBalance = await usdcE.balanceOf(deployerAddress);

  console.log("Final WETH balance:", ethers.formatUnits(wethBalance, 18));
  console.log("Final USDC.e balance:", ethers.formatUnits(usdcEBalance, 6)); // USDC.e has 6 decimals
  console.log("Finished checking balances.");


  console.log("\nSwap script finished successfully.");
}

// Standard script runner pattern
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\nScript encountered a critical error outside of main execution flow:");
    console.error(error);
    process.exit(1);
  });
