// scripts/swapWETHtoUSDC.js

const { ethers } = require("hardhat"); // Use ethers from Hardhat for all features

async function main() {
  // Get the deployer account (funded in your deploy script)
  const [deployer] = await ethers.getSigners();
  console.log("Using account:", deployer.address);

  // Get contract addresses
  const WETH_ADDRESS = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"; // WETH on Arbitrum
  const USDCE_ADDRESS = "0xFF970A61A04b1cA1cA37447f62EAbeA514106c"; // USDC.e on Arbitrum
  const SUSHISWAP_ROUTER_ADDRESS = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506"; // SushiSwap Router V2
  console.log("Defined addresses.");

  // Load ABIs - using absolute paths and extracting the 'abi' property where needed
  const ERC20_ABI = require("/workspaces/arbitrum-flash/abis/ERC20.json"); // Assuming this is just the ABI array
  // If ERC20.json is an artifact like the router, use:
  // const ERC20_ARTIFACT = require("/workspaces/arbitrum-flash/abis/ERC20.json");
  // const ERC20_ABI = ERC20_ARTIFACT.abi;

  const SUSHI_ROUTER_ARTIFACT = require("/workspaces/arbitrum-flash/artifacts/contracts/interfaces/IUniswapV2Router02.sol/IUniswapV2Router02.json"); // Path to Router Artifact JSON
  const SUSHI_ROUTER_ABI = SUSHI_ROUTER_ARTIFACT.abi; // Extract .abi property

  // Get contract instances using Hardhat's ethers.getContractAt
  const weth = await ethers.getContractAt(ERC20_ABI, WETH_ADDRESS, deployer);
  const usdcE = await ethers.getContractAt(ERC20_ABI, USDCE_ADDRESS, deployer); // USDC.e also uses ERC20 ABI
  const sushiRouter = await ethers.getContractAt(SUSHI_ROUTER_ABI, SUSHISWAP_ROUTER_ADDRESS, deployer);
  console.log("Got contract instances.");

  // --- Simulation Sequence ---

  // Wrap 1 ETH into WETH
  const amountToWrap = ethers.utils.parseEther("1.0");
  console.log(`Wrapping ${ethers.utils.formatEther(amountToWrap)} ETH to WETH...`);
  // Note: WETH contract often has a 'deposit' function that accepts ETH
  let tx = await weth.deposit({ value: amountToWrap });
  await tx.wait();
  console.log("Wrapped ETH to WETH.");

  // Check WETH balance after wrapping
  let wethBalance = await weth.balanceOf(deployer.address);
  console.log("Deployer WETH balance:", ethers.utils.formatUnits(wethBalance, 18));

  // Approve the Sushi Router to spend our WETH
  const amountToApprove = ethers.constants.MaxUint256;
  console.log("Approving Sushi Router...");
  tx = await weth.approve(SUSHISWAP_ROUTER_ADDRESS, amountToApprove);
  await tx.wait();
  console.log("Approved Sushi Router.");

  // Perform the swap: Swap 0.5 WETH for USDC.e on SushiSwap
  const amountIn = ethers.utils.parseEther("0.5"); // Swap 0.5 WETH
  const path = [WETH_ADDRESS, USDCE_ADDRESS];
  const to = deployer.address;
  const deadline = Math.floor(Date.now() / 1000) + 60 * 5; // 5 minutes from now

  console.log(`Swapping ${ethers.utils.formatEther(amountIn)} WETH for USDC.e via Sushi Router...`);

  try {
      tx = await sushiRouter.swapExactTokensForTokens(
          amountIn,
          0, // amountOutMin = 0 for simplicity in testing
          path,
          to,
          deadline
      );
      const receipt = await tx.wait(); // Wait for tx to be mined
      console.log("Swap successful. Transaction hash:", receipt.transactionHash);
      console.log("Gas used:", receipt.gasUsed.toString());

  } catch (error) {
      console.error("Swap failed:", error);
  }

  // Check final balances
  wethBalance = await weth.balanceOf(deployer.address);
  let usdcEBalance = await usdcE.balanceOf(deployer.address);
  console.log("Final WETH balance:", ethers.utils.formatUnits(wethBalance, 18)); // Use Hardhat's ethers.utils
  console.log("Final USDC.e balance:", ethers.utils.formatUnits(usdcEBalance, 6)); // USDC.e has 6 decimals, use Hardhat's ethers.utils

  console.log("Swap script finished.");
}

// Standard Hardhat script runner pattern
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
