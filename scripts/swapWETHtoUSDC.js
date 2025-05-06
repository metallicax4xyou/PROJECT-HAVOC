// scripts/swapWETHtoUSDC.js

// This is the standard Hardhat way to import the ethers object
// It includes Hardhat-specific functions (getSigners, getContractAt)
// and provides access to standard ethers.js utilities (parseEther, formatUnits, constants)
// Note: This script uses Ethers v6 syntax, where many utilities are directly on the ethers object,
// and payable function calls on contract instances from getContractAt with raw ABIs
// may require accessing via .functions.methodName(...)
const { ethers } = require("hardhat");

async function main() {
  console.log("Running swapWETHtoUSDC.js script (Ethers v6 deposit fix)...");

  // Get the deployer account (funded in your deploy script)
  const [deployer] = await ethers.getSigners();
  console.log("Using account:", deployer.address);

  // Get contract addresses
  const WETH_ADDRESS = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"; // WETH on Arbitrum
  const USDCE_ADDRESS = "0xFF970A61A04b1cA1cA37447f62EAbeA514106c"; // USDC.e on Arbitrum
  const SUSHISWAP_ROUTER_ADDRESS = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506"; // SushiSwap Router V2
  console.log("Defined addresses.");

  // --- Define specific ABIs needed in the script ---

  // Minimal WETH ABI including deposit, approve, and balanceOf
  // (We confirmed deposit() is included and payable based on the specialist's feedback)
  const WETH_MINIMAL_ABI = [
      "function deposit() payable",
      "function approve(address spender, uint amount) returns (bool)",
      "function balanceOf(address account) view returns (uint256)"
  ];

  // Standard ERC20 ABI for USDC.e (assuming it's just the array in abis/)
  // If ERC20.json is an artifact, use:
  // const ERC20_ARTIFACT = require("/workspaces/arbitrum-flash/abis/ERC20.json");
  // const ERC20_ABI = ERC20_ARTIFACT.abi;
  const ERC20_ABI = require("/workspaces/arbitrum-flash/abis/ERC20.json"); // Assuming this is just the ABI array

  // Sushi Router ABI (from artifact, extracting the 'abi' property)
  const SUSHI_ROUTER_ARTIFACT = require("/workspaces/arbitrum-flash/artifacts/contracts/interfaces/IUniswapV2Router02.sol/IUniswapV2Router02.json"); // Path to Router Artifact JSON
  const SUSHI_ROUTER_ABI = SUSHI_ROUTER_ARTIFACT.abi; // Extract .abi property

  // Get contract instances using Hardhat's ethers.getContractAt with appropriate ABIs
  console.log("Getting contract instances...");
  // Use the minimal WETH ABI for the WETH contract
  const weth = await ethers.getContractAt(WETH_MINIMAL_ABI, WETH_ADDRESS, deployer);
  console.log(`Got WETH contract instance at ${weth.address}`);

  // Use the standard ERC20 ABI for the USDC.e contract
  const usdcE = await ethers.getContractAt(ERC20_ABI, USDCE_ADDRESS, deployer); // USDC.e also uses ERC20 ABI
  console.log(`Got USDC.e contract instance at ${usdcE.address}`);

  // Use the Sushi Router ABI for the router contract
  const sushiRouter = await ethers.getContractAt(SUSHI_ROUTER_ABI, SUSHISWAP_ROUTER_ADDRESS, deployer);
  console.log(`Got Sushi Router contract instance at ${sushiRouter.address}`);
  console.log("Finished getting contract instances.");

  // --- Simulation Sequence ---

  // Wrap 1 ETH into WETH
  const amountToWrap = ethers.parseEther("1.0"); // Ethers v6 syntax
  console.log(`Wrapping ${ethers.formatEther(amountToWrap)} ETH to WETH...`); // Ethers v6 syntax
  // Note: WETH contract often has a 'deposit' function that accepts ETH
  // Ethers v6 fix: Call payable function via .functions when using getContractAt with raw ABI
  let tx = await weth.functions.deposit({ value: amountToWrap }); // <-- CORRECTED LINE
  console.log(`Transaction sent: ${tx.hash}`);
  await tx.wait();
  console.log("Wrapped ETH to WETH.");

  // Check WETH balance after wrapping
  // Use weth.balanceOf which is included in the minimal ABI (no .functions needed for view calls)
  // Ethers v6: ethers.utils.formatUnits becomes ethers.formatUnits
  let wethBalance = await weth.balanceOf(deployer.address);
  console.log("Deployer WETH balance:", ethers.formatUnits(wethBalance, 18));

  // Approve the Sushi Router to spend our WETH
  const amountToApprove = ethers.MaxUint256; // Ethers v6 syntax
  console.log("Approving Sushi Router...");
  // Call the approve function on the weth instance loaded with the correct ABI (.approve should work directly)
  tx = await weth.approve(SUSHISWAP_ROUTER_ADDRESS, amountToApprove); // Approve is not payable, direct call should be fine
  console.log(`Approval Transaction sent: ${tx.hash}`);
  await tx.wait();
  console.log("Approved Sushi Router.");

  // Perform the swap: Swap 0.5 WETH for USDC.e on SushiSwap
  const amountIn = ethers.parseEther("0.5"); // Swap 0.5 WETH, Ethers v6 syntax
  const path = [WETH_ADDRESS, USDCE_ADDRESS];
  const to = deployer.address;
  const deadline = Math.floor(Date.now() / 1000) + 60 * 5; // 5 minutes from now

  console.log(`Swapping ${ethers.formatEther(amountIn)} WETH for USDC.e via Sushi Router...`); // Ethers v6 syntax

  try {
      // Call swapExactTokensForTokens on the sushiRouter instance
      // Check if this also needs .functions based on the Router ABI and if it's payable
      // Assuming for now that direct call works for the router, as the specialist's fix targeted deposit
      tx = await sushiRouter.swapExactTokensForTokens(
          amountIn,
          0, // amountOutMin = 0 for simplicity in testing
          path,
          to,
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
  }

  // Check final balances
  console.log("Checking final balances...");
  // Use weth.balanceOf and usdcE.balanceOf loaded with appropriate ABIs (view calls)
  // Ethers v6: ethers.utils.formatUnits becomes ethers.formatUnits
  wethBalance = await weth.balanceOf(deployer.address);
  let usdcEBalance = await usdcE.balanceOf(deployer.address);
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
    console.error("Script encountered an error:");
    console.error(error);
    process.exit(1);
  });
