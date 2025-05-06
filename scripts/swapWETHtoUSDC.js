// scripts/swapWETHtoUSDC.js

// Use the standalone ethers library for direct provider and wallet control
const { ethers, BigInt } = require("ethers"); // Import ethers and BigInt
// Import dotenv to load environment variables from .env
require('dotenv').config();

async function main() {
  console.log("Running swapWETHtoUSDC.js script (Fixing V3 Router/Quoter ABI signatures - Final Attempt)...");

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
    deployer = new ethers.Wallet(privateKey, provider); // The signer instance (for sending txs)
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
  // --- Using UNISWAP V3 ROUTER AND QUOTER ---
  const UNISWAP_V3_ROUTER_ADDRESS = "0xE592427A0AEce92De3Edee1F18E0157C05861564"; // Uniswap V3 Router 2
  const UNISWAP_V3_QUOTER_ADDRESS = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e"; // Uniswap V3 Quoter V2
  const poolFee = 100; // Fee tier for the selected pool (100 for 0.01%)


  console.log("\n--- Addresses ---");
  console.log("WETH_ADDRESS:", WETH_ADDRESS);
  console.log("USDCE_ADDRESS:", USDCE_ADDRESS);
  console.log("UNISWAP_V3_ROUTER_ADDRESS:", UNISWAP_V3_ROUTER_ADDRESS);
  console.log("UNISWAP_V3_QUOTER_ADDRESS:", UNISWAP_V3_QUOTER_ADDRESS);
  console.log("Target Pool Fee:", poolFee);
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

  // Uniswap V3 Router 2 ABI - Minimal, with exactInputSingle
  // Use precise signature including parameter names and keywords
   const UNISWAP_V3_ROUTER_MINIMAL_ABI = [
       "function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)"
   ];
  console.log("--- Uniswap V3 Router ABI (Minimal, with exactInputSingle) ---");
  console.log("Is UNISWAP_V3_ROUTER_MINIMAL_ABI an array?", Array.isArray(UNISWAP_V3_ROUTER_MINIMAL_ABI));
  console.log("UNISWAP_V3_ROUTER_MINIMAL_ABI length:", UNISWAP_V3_ROUTER_MINIMAL_ABI.length);
  console.log("-------------------------------\n");


   // Uniswap V3 Quoter V2 ABI - Minimal, with quoteExactInputSingle
   // Use precise signature including parameter names and keywords for QuoterV2
   const UNISWAP_V3_QUOTER_MINIMAL_ABI = [
       "function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external view returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)"
   ];
   console.log("--- Uniswap V3 Quoter V2 ABI (Minimal, with quoteExactInputSingle) ---");
   console.log("Is UNISWAP_V3_QUOTER_MINIMAL_ABI an array?", Array.isArray(UNISWAP_V3_QUOTER_MINIMAL_ABI));
   console.log("UNISWAP_V3_QUOTER_MINIMAL_ABI length:", UNISWAP_V3_QUOTER_MINIMAL_ABI.length);
   console.log("--------------------------------\n");


  // Get contract instances using standard Ethers v6 constructor, connected to the standalone Wallet/Provider
  console.log("Attempting to get contract instances using new ethers.Contract() with standalone Wallet/Provider...");
  let weth, usdcE, uniswapRouter, uniswapQuoter; // Using uniswapRouter/Quoter

  try {
      console.log("-> Attempting to instantiate WETH contract...");
      weth = new ethers.Contract(WETH_ADDRESS, WETH_MINIMAL_ABI, deployer); // Use deployer for WETH (approve/deposit)
      console.log(`Instantiated WETH contract. Target: ${weth.target}`);

      console.log("-> Attempting to instantiate USDC.e contract...");
      usdcE = new ethers.Contract(USDCE_ADDRESS, ERC20_ABI, deployer); // Use deployer for USDC.e (balanceOf)
      console.log(`Instantiated USDC.e contract. Target: ${usdcE.target}`);

      console.log("-> Attempting to instantiate Uniswap V3 Router contract...");
      uniswapRouter = new ethers.Contract(UNISWAP_V3_ROUTER_ADDRESS, UNISWAP_V3_ROUTER_MINIMAL_ABI, deployer); // Use deployer for Router (swap tx)
      console.log(`Instantiated Uniswap V3 Router contract. Target: ${uniswapRouter.target}`);

       console.log("-> Attempting to instantiate Uniswap V3 Quoter contract..."); // <-- Instantiating Quoter
      uniswapQuoter = new ethers.Contract(UNISWAP_V3_QUOTER_ADDRESS, UNISWAP_V3_QUOTER_MINIMAL_ABI, provider); // Use provider for Quoter (view calls)
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


  // Approve the Uniswap V3 Router to spend our WETH (Already successfully tested)
  const amountToApprove = ethers.MaxUint256;
  console.log("Approving Uniswap V3 Router...");
  tx = await weth.approve(UNISWAP_V3_ROUTER_ADDRESS, amountToApprove);
  console.log(`Approval Transaction sent: ${tx.hash}`);
  await tx.wait();
  console.log("Approved Uniswap V3 Router.");


  // Prepare Uniswap V3 Swap parameters
  const amountIn = ethers.parseEther("0.5"); // Swap 0.5 WETH (in WETH decimals, 18)
  const deadline = Math.floor(Date.now() / 1000) + 60 * 5; // 5 minutes from now
  // Ethers v6: Use BigInt string constructor or ethers.getBigInt
  const amountOutMinimum = BigInt("0"); // Minimum amount expected out (0 for testing simplicity) - In tokenOut decimals (6)
  // Ethers v6: Use BigInt string constructor or ethers.getBigInt
  const sqrtPriceLimitX96 = BigInt("0"); // Used for limiting price movement (0 for no limit)


  // Uniswap V3 exactInputSingle parameters struct for Router
  // https://docs.uniswap.org/contracts/v3/reference/periphery/interfaces/ISwapRouter#exactinputsingle
  const routerParams = {
      tokenIn: WETH_ADDRESS,
      tokenOut: USDCE_ADDRESS,
      fee: poolFee, // Fee tier (100 for 0.01%)
      recipient: deployer.address, // Address to send tokenOut to
      deadline: deadline,
      amountIn: amountIn, // Amount of tokenIn (in tokenIn decimals)
      amountOutMinimum: amountOutMinimum, // Minimum amount of tokenOut (in tokenOut decimals)
      sqrtPriceLimitX96: sqrtPriceLimitX96,
  };

   // Uniswap V3 exactInputSingle parameters struct for QuoterV2
   // https://docs.uniswap.org/contracts/v3/reference/periphery/lens/QuoterV2#quoteexactinputsingle
   const quoterParams = {
        tokenIn: WETH_ADDRESS,
        tokenOut: USDCE_ADDRESS,
        amountIn: amountIn, // Amount of tokenIn
        fee: poolFee,
        sqrtPriceLimitX96: sqrtPriceLimitX96 // Use BigInt("0") for Quoter as well
   };


  console.log(`\nSwapping ${ethers.formatEther(amountIn)} WETH for USDC.e via Uniswap V3 Router...`);
  console.log("Router Swap Parameters:", routerParams);
  console.log("Quoter Quote Parameters:", quoterParams);


  // --- Diagnosing Swap Revert (Using correct call types and ABIs) ---

  // 1. Check expected output using Quoter.quoteExactInputSingle (view call)
  console.log("\n--- Diagnosing Swap: Checking Quoter.quoteExactInputSingle ---");
  try {
      // Call quoteExactInputSingle as a static call on the uniswapQuoter instance
      // Ethers v6 fix: Use .staticCall() or .callStatic() for view functions on instances with providers/signers
      // Use the quoterParams struct
      const quoteResult = await uniswapQuoter.callStatic.quoteExactInputSingle(quoterParams); // <-- CORRECTED CALL
      console.log(`Quoter.quoteExactInputSingle successful.`);
      // Quote result is an object containing amountOut and sqrtPriceX96After
      console.log(`Estimated output amount for WETH -> USDC.e (${poolFee} bps) swap: ${ethers.formatUnits(quoteResult.amountOut, 6)} USDC.e`); // USDC.e has 6 decimals

  } catch (error) {
      console.error("\nQuoter.quoteExactInputSingle failed. This pool might not be supported or liquidity is too low in the forked state.");
      console.error("Error Object:", error);
      console.error("Error Reason:", error.reason); // Log specific revert reason if available
      console.error("Error Code:", error.code);   // Log Ethers error code
      console.error("Error Data:", error.data);   // Log revert data if available (often empty for simple reverts)
      console.error("Error Message:", error.message);
      // Do NOT exit here, callStatic might still work or provide a better error
  }
   console.log("------------------------------------------\n");


  // 2. Perform a dry-run using callStatic on Router.exactInputSingle (simulates the transaction)
  console.log("\n--- Diagnosing Swap: Performing callStatic dry-run on Router.exactInputSingle ---");
  try {
      // Call callStatic.exactInputSingle with the router parameters on the *uniswapRouter* instance
      const callStaticResult = await uniswapRouter.callStatic.exactInputSingle(routerParams); // <-- CORRECTED CALL
      console.log("callStatic exactInputSingle successful.");
      // callStatic for exactInputSingle returns the amountOut
      console.log("callStatic Result (amountOut):", ethers.formatUnits(callStaticResult, 6)); // USDC.e has 6 decimals

  } catch (error) {
      console.error("\ncallStatic exactInputSingle failed. This confirms the transaction would revert on-chain.");
      console.error("Error Object:", error);
      console.error("Error Reason:", error.reason); // Log specific revert reason if available
      console.error("Error Code:", error.code);   // Log Ethers error code
      console.error("Error Data:", error.data);   // Log revert data if available (often empty for simple reverts)
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
        // Call exactInputSingle on the uniswapRouter instance (this is the transaction)
        actualSwapTx = await uniswapRouter.exactInputSingle(routerParams); // <-- CORRECTED CALL
        console.log(`Swap Transaction sent: ${actualSwapTx.hash}`);
        const receipt = await actualSwapTx.wait(); // Wait for tx to be mined
        console.log("Swap successful. Transaction hash:", receipt.transactionHash);
        console.log("Gas used:", receipt.gasUsed.toString());

    } catch (error) {
        console.error("\nActual Uniswap V3 Swap failed:");
         console.error("Error Object:", error);
        console.error("Error Reason:", error.reason); // Log specific revert reason if available
        console.error("Error Code:", error.code);   // Log Ethers error code
        console.error("Error Data:", error.data);   // Log revert data if available
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
