// scripts/swapWETHtoUSDC.js

// This is the standard Hardhat way to import the ethers object
// It includes Hardhat-specific functions (getSigners, getContractAt)
// and provides access to standard ethers.js utilities (parseEther, formatUnits, constants)
// Note: This script uses Ethers v6 syntax, and attempts to resolve the Hardhat resolveName error
// by passing raw address strings to contract method arguments.
const { ethers } = require("hardhat");

async function main() {
  console.log("Running swapWETHtoUSDC.js script (Reverting address formatting)...");

  // Get the deployer account (funded in your deploy script)
  const [deployer] = await ethers.getSigners();
  console.log("Using account:", deployer.address);
  console.log("Deployer address type:", typeof deployer.address);
  // Log deployer address directly for debugging
  console.log("Deployer address string:", deployer.address);


  // Get contract addresses
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


  // Get contract instances using Hardhat's ethers.getContractAt with appropriate ABIs (Passing ABI Arrays directly)
  console.log("Attempting to get contract instances with validated ABIs...");
  let weth, usdcE, sushiRouter;

  try {
      // Use getContractAt with the ABI arrays directly and correct addresses/signer

      weth = await ethers.getContractAt(WETH_MINIMAL_ABI, WETH_ADDRESS, deployer);
      // Using .address property directly should be fine here as it's the contract address, not an input parameter
      console.log(`Got WETH contract instance at ${weth.address || 'undefined'}`);

      usdcE = await ethers.getContractAt(ERC20_ABI, USDCE_ADDRESS, deployer); // USDC.e also uses ERC20 ABI
      console.log(`Got USDC.e contract instance at ${usdcE.address || 'undefined'}`);

      sushiRouter = await ethers.getContractAt(SUSHI_ROUTER_ABI, SUSHISWAP_ROUTER_ADDRESS, deployer);
      console.log(`Got Sushi Router contract instance at ${sushiRouter.address || 'undefined'}`);

      console.log("Finished attempting to get contract instances.");

      // Check if instances were successfully obtained before proceeding
      if (!weth || !usdcE || !sushiRouter) {
           // This error should now be caught if instantiation truly fails
          throw new Error("Failed to get one or more contract instances after getContractAt calls. Check addresses and network connection.");
      }

  } catch (error) {
      console.error("\nError during contract instantiation:", error);
      // Additional logging to help diagnose failure
       if (error.message.includes("resolveName not implemented")) {
           console.error("Hint: resolveName error during instantiation might indicate an issue with signer or provider.");
       }
      process.exit(1); // Exit on contract instantiation failure
  }

  console.log("\n--- Contract Instances Obtained. Proceeding with Simulation Sequence ---\n");

  // --- Simulation Sequence ---

  // Wrap 1 ETH into WETH
  const amountToWrap = ethers.parseEther("1.0"); // Ethers v6 syntax
  console.log(`Wrapping ${ethers.formatEther(amountToWrap)} ETH to WETH...`); // Ethers v6 syntax
  // Note: WETH contract often has a 'deposit' function that accepts ETH
  // Calling deposit directly with ABI array works in Ethers v6
  let tx = await weth.deposit({ value: amountToWrap });

  console.log(`Transaction sent: ${tx.hash}`);
  await tx.wait();
  console.log("Wrapped ETH to WETH.");

  // Check WETH balance after wrapping
  // Use weth.balanceOf which is included in the minimal ABI (no .functions needed for view calls)
  // Ethers v6: ethers.utils.formatUnits becomes ethers.formatUnits
  // Revert to passing deployer.address string directly
  let wethBalance = await weth.balanceOf(deployer.address); // <-- CORRECTED LINE
  console.log("Deployer WETH balance:", ethers.formatUnits(wethBalance, 18));


  // Approve the Sushi Router to spend our WETH
  // Ethers v6: ethers.constants.MaxUint256 becomes ethers.MaxUint256
  const amountToApprove = ethers.MaxUint256;
  console.log("Approving Sushi Router...");
  // Call the approve function on the weth instance loaded with the correct ABI (.approve should work directly)
  // Revert to passing SUSHISWAP_ROUTER_ADDRESS string directly
  tx = await weth.approve(SUSHISWAP_ROUTER_ADDRESS, amountToApprove); // <-- CORRECTED LINE (Approving Router)
  console.log(`Approval Transaction sent: ${tx.hash}`);
  await tx.wait();
  console.log("Approved Sushi Router.");


  // Perform the swap: Swap 0.5 WETH for USDC.e on SushiSwap
  const amountIn = ethers.parseEther("0.5"); // Swap 0.5 WETH, Ethers v6 syntax
  const path = [WETH_ADDRESS, USDCE_ADDRESS]; // These are constants, fine as is (unless they represent names, which they don't)
  // Revert to passing deployer.address string directly for the 'to' address
  const to = deployer.address; // <-- CORRECTED LINE
  const deadline = Math.floor(Date.now() / 1000) + 60 * 5; // 5 minutes from now

  console.log(`Swapping ${ethers.formatEther(amountIn)} WETH for USDC.e via Sushi Router...`); // Ethers v6 syntax
  console.log(`Swap 'to' address (raw string): ${to}`); // Debug log for the 'to' address - should be raw string


  try {
      // Call swapExactTokensForTokens on the sushiRouter instance
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
      console.error("Swap failed:", error);
      // Add more specific error logging if possible
      if (error.error && error.error.message) {
          console.error("Swap failure message:", error.error.message);
      } else if (error.data && error.data.message) {
           console.error("Swap failure message:", error.data.message);
      }
       if (error.message.includes("resolveName not implemented")) {
           console.error("Hint: Still getting resolveName error. This is highly unusual when passing raw hex strings from getSigners(). Might indicate a deeper Hardhat/Ethers v6 compatibility issue or environment problem.");
       }
  }

  // Check final balances
  console.log("Checking final balances...");
  // Use weth.balanceOf and usdcE.balanceOf loaded with appropriate ABIs (view calls)
  // Revert to passing deployer.address string directly for balance checks
  const deployerRawAddress = deployer.address; // <-- Raw deployer address for balance checks

  // Ethers v6: ethers.utils.formatUnits becomes ethers.formatUnits
  wethBalance = await weth.balanceOf(deployerRawAddress); // <-- Use raw address
  let usdcEBalance = await usdcE.balanceOf(deployerRawAddress); // <-- Use raw address

  console.log("Final WETH balance:", ethers.formatUnits(wethBalance, 18));
  // Ethers v6: ethers.utils.formatUnits becomes ethers.formatUnits
  console.log("Final USDC.e balance:", ethers.formatUnits(usdcEBalance, 6)); // USDC.e has 6 decimals
  console.log("Finished checking balances.");


  console.log("Swap script finished successfully.");
}

// Standard Hardhat script runner pattern
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Script encountered a critical error:");
    console.error(error);
    process.exit(1);
  });
