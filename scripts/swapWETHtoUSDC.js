// scripts/swapWETHtoUSDC.js

// This is the standard Hardhat way to import the ethers object
// It includes Hardhat-specific functions (getSigners, getContractAt)
// and provides access to standard ethers.js utilities (utils, constants)
// Note: This script uses Ethers v6 syntax, where many utilities are directly on the ethers object.
const { ethers } = require("hardhat");

async function main() {
  console.log("Running swapWETHtoUSDC.js script (Ethers v6 syntax)...");

  // Get the deployer account (funded in your deploy script)
  const [deployer] = await ethers.getSigners();
  console.log("Using account:", deployer.address);

  // Get contract addresses
  const WETH_ADDRESS = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"; // WETH on Arbitrum
  const USDCE_ADDRESS = "0xFF970A61A04b1cA1cA37447f62EAbeA514106c"; // USDC.e on Arbitrum
  const SUSHISWAP_ROUTER_ADDRESS = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506"; // SushiSwap Router V2
  console.log("Defined addresses.");

  // Load ABIs - using absolute paths and extracting the 'abi' property where needed
  // We'll use the .abi || artifact pattern for robustness, in case ERC20.json is also an artifact
  const ERC20_ARTIFACT = require("/workspaces/arbitrum-flash/abis/ERC20.json"); // Path to ERC20 JSON
  const ERC20_ABI = ERC20_ARTIFACT.abi || ERC20_ARTIFACT; // Use .abi property, or the object itself as fallback

  const SUSHI_ROUTER_ARTIFACT = require("/workspaces/arbitrum-flash/artifacts/contracts/interfaces/IUniswapV2Router02.sol/IUniswapV2Router02.json"); // Path to Router Artifact JSON
  const SUSHI_ROUTER_ABI = SUSHI_ROUTER_ARTIFACT.abi || SUSHI_ROUTER_ARTIFACT; // Use .abi property, or the object itself as fallback

  // Get contract instances using Hardhat's ethers.getContractAt
  console.log("Getting contract instances...");
  const weth = await ethers.getContractAt(ERC20_ABI, WETH_ADDRESS, deployer);
  console.log(`Got WETH contract instance at ${weth.address}`);
  const usdcE = await ethers.getContractAt(ERC20_ABI, USDCE_ADDRESS, deployer); // USDC.e also uses ERC20 ABI
   console.log(`Got USDC.e contract instance at ${usdcE.address}`);
  const sushiRouter = await ethers.getContractAt(SUSHI_ROUTER_ABI, SUSHISWAP_ROUTER_ADDRESS, deployer);
  console.log(`Got Sushi Router contract instance at ${sushiRouter.address}`);
  console.log("Finished getting contract instances.");

  // --- Simulation Sequence ---

  // Wrap 1 ETH into WETH
  // Ethers v6: ethers.utils.parseEther becomes ethers.parseEther
  const amountToWrap = ethers.parseEther("1.0");
  // Ethers v6: ethers.utils.formatEther becomes ethers.formatEther
  console.log(`Wrapping ${ethers.formatEther(amountToWrap)} ETH to WETH...`);
  // Note: WETH contract often has a 'deposit' function that accepts ETH
  let tx = await weth.deposit({ value: amountToWrap });
  console.log(`Transaction sent: ${tx.hash}`);
  await tx.wait();
  console.log("Wrapped ETH to WETH.");

  // Check WETH balance after wrapping
  let wethBalance = await weth.balanceOf(deployer.address);
  // Ethers v6: ethers.utils.formatUnits becomes ethers.formatUnits
  console.log("Deployer WETH balance:", ethers.formatUnits(wethBalance, 18));

  // Approve the Sushi Router to spend our WETH
  // Ethers v6: ethers.constants.MaxUint256 becomes ethers.MaxUint256
  const amountToApprove = ethers.MaxUint256;
  console.log("Approving Sushi Router...");
  tx = await weth.approve(SUSHISWAP_ROUTER_ADDRESS, amountToApprove);
   console.log(`Approval Transaction sent: ${tx.hash}`);
  await tx.wait();
  console.log("Approved Sushi Router.");

  // Perform the swap: Swap 0.5 WETH for USDC.e on SushiSwap
  // Ethers v6: ethers.utils.parseEther becomes ethers.parseEther
  const amountIn = ethers.parseEther("0.5"); // Swap 0.5 WETH
  const path = [WETH_ADDRESS, USDCE_ADDRESS];
  const to = deployer.address;
  const deadline = Math.floor(Date.now() / 1000) + 60 * 5; // 5 minutes from now

  // Ethers v6: ethers.utils.formatEther becomes ethers.formatEther
  console.log(`Swapping ${ethers.formatEther(amountIn)} WETH for USDC.e via Sushi Router...`);

  try {
      tx = await sushiRouter.swapExactTokensForTokens( // Use sushiRouter instance
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
  wethBalance = await weth.balanceOf(deployer.address);
  let usdcEBalance = await usdcE.balanceOf(deployer.address);
  // Ethers v6: ethers.utils.formatUnits becomes ethers.formatUnits
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
