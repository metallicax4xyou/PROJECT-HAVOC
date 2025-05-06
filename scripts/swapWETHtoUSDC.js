// scripts/swapWETHtoUSDC.js

// Use the standalone ethers library for direct provider and wallet control
const { ethers } = require("ethers");
// Import dotenv to load environment variables from .env
require('dotenv').config();

async function main() {
  console.log("Running swapWETHtoUSDC.js script (Adding detailed swap error logging)...");

  // Get RPC URL and Private Key from environment variables
  const rpcUrl = process.env.LOCAL_FORK_RPC_URL;
  const privateKey = process.env.LOCAL_FORK_PRIVATE_KEY;

  if (!rpcUrl || !privateKey) {
      console.error("Error: LOCAL_FORK_RPC_URL and LOCAL_FORK_PRIVATE_KEY must be set in your .env file.");
      // Log the process environment to help diagnose missing keys if needed
      console.error("Process Environment Keys:", Object.keys(process.env));
      process.exit(1);
  }

  console.log(`Connecting to RPC: ${rpcUrl}`);

  // Set up a standalone JsonRpcProvider and Wallet (Signer)
  let provider;
  try {
    provider = new ethers.JsonRpcProvider(rpcUrl);
    console.log("JsonRpcProvider created.");
    // Optional: Check connection
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


  // Get contract addresses (these remain the same)
  const WETH_ADDRESS = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"; // WETH on Arbitrum
  const USDCE_ADDRESS = "0xFF970A61A04b1cA1cA37447f62EAbeA514106c"; // USDC.e on Arbitrum
  const SUSHISWAP_ROUTER_ADDRESS = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506"; // SushiSwap Router V2

  console.log("\n--- Addresses ---");
  console.log("WETH_ADDRESS:", WETH_ADDRESS);
  console.log("USDCE_ADDRESS:", USDCE_ADDRESS);
  console.log("SUSHISWAP_ROUTER_ADDRESS:", SUSHISWAP_ROUTER_ADDRESS);
  console.log("-----------------\n");


  // --- Define specific ABIs needed in the script ---

  // Minimal WETH ABI including deposit, approve, and balanceOf
  const WETH_MINIMAL_ABI = [
      "function deposit() payable",
      "function approve(address spender, uint amount) returns (bool)",
      "function balanceOf(address account) view returns (uint256)"
  ];
   console.log("--- WETH ABI (Minimal) ---");
  console.log("WETH_MINIMAL_ABI (first 3 entries):", WETH_MINIMAL_ABI.slice(0, 3)); // Log first few entries
  console.log("Is WETH_MINIMAL_ABI an array?", Array.isArray(WETH_MINIMAL_ABI));
  console.log("WETH_MINIMAL_ABI length:", WETH_MINIMAL_ABI.length);
  console.log("-------------------------\n");


  // Standard ERC20 ABI for USDC.e (assuming it's just the array in abis/)
  // We'll require the JSON and check its structure
  let ERC20_ABI;
   console.log("--- ERC20 ABI (from abis/ERC20.json) ---");
  try {
      const ERC20_LOADED = require("/workspaces/arbitrum-flash/abis/ERC20.json"); // Path to ERC20 JSON
      console.log("Required abis/ERC20.json successfully.");
      console.log("Type of loaded ERC20 JSON:", typeof ERC20_LOADED);
      if (Array.isArray(ERC20_LOADED)) {
          console.log("ERC20 JSON is directly an array.");
          ERC20_ABI = ERC20_LOADED;
      } else if (ERC20_LOADED && Array.isArray(ERC20_LOADED.abi)) {
           console.log("ERC20 JSON has a .abi property which is an array.");
          ERC20_ABI = ERC20_LOADED.abi;
      } else {
          console.error("ERC20 JSON is not an array and doesn't have a .abi array property.");
          console.log("ERC20 JSON content:", ERC20_LOADED);
          throw new Error("Invalid ERC20 ABI format");
      }
       console.log("Is ERC20_ABI an array?", Array.isArray(ERC20_ABI));
       console.log("ERC20_ABI length:", ERC20_ABI.length);

  } catch (error) {
      console.error("Error requiring or processing abis/ERC20.json:", error);
      process.exit(1); // Exit if we can't load critical ABI
  }
  console.log("-------------------------\n");


  // Sushi Router ABI (from artifact, extracting the 'abi' property)
  let SUSHI_ROUTER_ABI;
  console.log("--- Sushi Router ABI (from artifacts/...) ---");
   try {
      const SUSHI_ROUTER_ARTIFACT = require("/workspaces/arbitrum-flash/artifacts/contracts/interfaces/IUniswapV2Router02.sol/IUniswapV2Router02.json"); // Path to Router Artifact JSON
      console.log("Required router artifact JSON successfully.");
      console.log("Type of loaded router artifact:", typeof SUSHI_ROUTER_ARTIFACT);
      if (SUSHI_ROUTER_ARTIFACT && Array.isArray(SUSHI_ROUTER_ARTIFACT.abi)) {
          console.log("Router artifact has a .abi property which is an array.");
           SUSHI_ROUTER_ABI = SUSHI_ROUTER_ARTIFACT.abi;
      } else {
          console.error("Router artifact JSON does not have a .abi array property.");
           console.log("Router artifact content:", SUSHI_ROUTER_ARTIFACT);
          throw new Error("Invalid Router ABI artifact format");
      }
       console.log("Is SUSHI_ROUTER_ABI an array?", Array.isArray(SUSHI_ROUTER_ABI));
       console.log("SUSHI_ROUTER_ABI length:", SUSHI_ROUTER_ABI.length);

   } catch (error) {
       console.error("Error requiring or processing router artifact JSON:", error);
       process.exit(1); // Exit if we can't load critical ABI
   }
  console.log("-------------------------------\n");


  // Get contract instances using standard Ethers v6 constructor, connected to the standalone Wallet
  console.log("Attempting to get contract instances using new ethers.Contract() with standalone Wallet...");
  let weth, usdcE, sushiRouter;

  try {
      // Use new ethers.Contract(address, abi, signer)
      console.log("-> Attempting to instantiate WETH contract...");
      weth = new ethers.Contract(WETH_ADDRESS, WETH_MINIMAL_ABI, deployer);
      console.log(`Instantiated WETH contract. Target: ${weth.target}`);

      console.log("-> Attempting to instantiate USDC.e contract...");
      usdcE = new ethers.Contract(USDCE_ADDRESS, ERC20_ABI, deployer);
      console.log(`Instantiated USDC.e contract. Target: ${usdcE.target}`);

      console.log("-> Attempting to instantiate Sushi Router contract...");
      sushiRouter = new ethers.Contract(SUSHISWAP_ROUTER_ADDRESS, SUSHI_ROUTER_ABI, deployer);
      console.log(`Instantiated Sushi Router contract. Target: ${sushiRouter.target}`);


      console.log("Finished attempting to get contract instances.");

      // Check if instances were successfully obtained
      if (!weth || !usdcE || !sushiRouter || !weth.target || !usdcE.target || !sushiRouter.target) {
           throw new Error("Failed to get one or more contract instances with valid targets.");
      }
       console.log("\nAll contract instances obtained and have valid targets. Proceeding with Simulation Sequence ---\n");


  } catch (error) {
      console.error("\nError during contract instantiation with new ethers.Contract():", error);
      // Additional logging to help diagnose failure
       if (error.message.includes("invalid address")) {
           console.error("Hint: An address might be formatted incorrectly.");
       }
       if (error.message.includes("abi is not iterable") || error.message.includes("Invalid ABI format")) {
            console.error("Hint: An ABI might not be in the expected array format.");
       }
      process.exit(1); // Exit on contract instantiation failure
  }

  console.log("\n--- Contract Instances Obtained. Proceeding with Simulation Sequence ---\n");

  // --- Simulation Sequence ---

  // Wrap 1 ETH into WETH
  const amountToWrap = ethers.parseEther("1.0"); // Ethers v6 syntax
  console.log(`Wrapping ${ethers.formatEther(amountToWrap)} ETH to WETH...`); // Ethers v6 syntax
  // Note: WETH contract often has a 'deposit' function that accepts ETH
  // Use the wallet instance to send the transaction
  let tx = await weth.deposit({ value: amountToWrap });

  console.log(`Transaction sent: ${tx.hash}`);
  await tx.wait();
  console.log("Wrapped ETH to WETH.");

  // Check WETH balance after wrapping
  // Use the wallet instance for static calls like balanceOf
  // Ethers v6: ethers.utils.formatUnits becomes ethers.formatUnits
  // Use deployer.address string directly for balanceOf input - Should work with standalone ethers
  let wethBalance = await weth.balanceOf(deployer.address); // Raw string address
  console.log("Deployer WETH balance:", ethers.formatUnits(wethBalance, 18));


  // Approve the Sushi Router to spend our WETH
  // Ethers v6: ethers.constants.MaxUint256 becomes ethers.MaxUint256
  const amountToApprove = ethers.MaxUint256;
  console.log("Approving Sushi Router...");
  // Use the wallet instance to send the transaction
  // Use SUSHISWAP_ROUTER_ADDRESS string directly - Should work with standalone ethers
  tx = await weth.approve(SUSHISWAP_ROUTER_ADDRESS, amountToApprove); // Raw string address (Approving Router)
  console.log(`Approval Transaction sent: ${tx.hash}`);
  await tx.wait();
  console.log("Approved Sushi Router.");


  // Perform the swap: Swap 0.5 WETH for USDC.e on SushiSwap
  const amountIn = ethers.parseEther("0.5"); // Swap 0.5 WETH, Ethers v6 syntax
  const path = [WETH_ADDRESS, USDCE_ADDRESS]; // These are constants, fine as is
  // Use deployer.address string directly for the 'to' address - Should work with standalone ethers
  const to = deployer.address; // Raw string address
  const deadline = Math.floor(Date.now() / 1000) + 60 * 5; // 5 minutes from now

  console.log(`Swapping ${ethers.formatEther(amountIn)} WETH for USDC.e via Sushi Router...`); // Ethers v6 syntax
  console.log(`Swap 'to' address (raw string): ${to}`); // Debug log for the 'to' address - should be raw string


  // --- ADDED DETAILED ERROR LOGGING FOR SWAP ---
  try {
      // Call swapExactTokensForTokens on the sushiRouter instance using the wallet
      // Pass the raw 'to' address string
      tx = await sushiRouter.swapExactTokensForTokens(
          amountIn,
          0, // amountOutMin = 0 for simplicity in testing
          path,
          to, // Pass the raw 'to' address string
          deadline
      );
      console.log(`Swap Transaction sent: ${tx.hash}`);
      const receipt = await tx.wait(); // Wait for tx to be mined
      console.log("Swap successful. Transaction hash:", receipt.transactionHash);
      console.log("Gas used:", receipt.gasUsed.toString());

  } catch (error) {
      console.error("\nSwap failed:");
      console.error("Error Object:", error); // Log the full error object
      console.error("Error Reason:", error.reason); // Log specific revert reason if available
      console.error("Error Code:", error.code);   // Log Ethers error code
      console.error("Error Data:", error.data);   // Log revert data if available
      console.error("Error Message:", error.message); // Log the standard error message

       // With standalone ethers, resolveName should be implemented (or not attempted with raw strings)
       if (error.message.includes("resolveName not implemented")) {
           console.error("Hint: Still getting resolveName error on swap with standalone ethers. This is highly unexpected. Verify Ethers version or look for other environment issues.");
       }
       if (error.code === 'CALL_EXCEPTION' || error.code === 'UNPREDICTABLE_GAS_LIMIT') {
            console.error("Hint: This often indicates an on-chain revert. Check logs or transaction data for specific revert reasons.");
       }
       if (error.code === 'BUFFER_OVERRUN') {
           console.error("Hint: This usually means the contract call reverted without returning error data, and Ethers tried to decode nothing.");
       }

      process.exit(1); // Exit on swap failure
  }
    // --- END ADDED ERROR LOGGING ---


  // Check final balances
  console.log("Checking final balances...");
  // Use the wallet instance for static calls like balanceOf
  // Use deployer.address string directly for balance checks - Should work with standalone ethers
  const deployerRawAddress = deployer.address; // Raw deployer address for balance checks

  // Ethers v6: ethers.utils.formatUnits becomes ethers.formatUnits
  wethBalance = await weth.balanceOf(deployerRawAddress); // <-- Use raw address
  let usdcEBalance = await usdcE.balanceOf(deployerRawAddress); // <-- Use raw address

  console.log("Final WETH balance:", ethers.formatUnits(wethBalance, 18));
  // Ethers v6: ethers.utils.formatUnits becomes ethers.formatUnits
  console.log("Final USDC.e balance:", ethers.formatUnits(usdcEBalance, 6)); // USDC.e has 6 decimals
  console.log("Finished checking balances.");


  console.log("Swap script finished successfully.");
}

// Standard script runner pattern
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Script encountered a critical error outside of swap catch:");
    console.error(error);
    process.exit(1);
  });
