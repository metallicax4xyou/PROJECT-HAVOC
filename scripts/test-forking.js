// scripts/test-forking.js
// A simple script to check the current block number via the Hardhat provider.
// Used to verify if network forking is active.

const hre = require("hardhat");

async function main() {
  try {
    // Access the provider configured for the current network
    const provider = hre.ethers.provider;

    // Get the current block number
    const blockNumber = await provider.getBlockNumber();

    console.log("-----------------------------------------");
    console.log(`Connected to network: ${hre.network.name}`);
    console.log(`Current block number: ${blockNumber}`);
    console.log("-----------------------------------------");

    // Add more checks if needed, e.g., fetching a block or transaction

  } catch (error) {
    console.error("Error running test-forking script:", error);
    process.exitCode = 1;
  }
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
