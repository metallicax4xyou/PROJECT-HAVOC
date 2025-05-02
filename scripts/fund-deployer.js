// scripts/fund-deployer.js
// --- VERSION v1.0 --- Funds the default Hardhat Account #0 for deployment.

const hre = require("hardhat");
const ethers = hre.ethers;

async function main() {
  console.log("Attempting to fund deployer account on localFork...");

  // Private key of Hardhat's default Account #1 (0x70997970C51812dc3A010C7d01b50e0d17dc79C8)
  // This account is funded with 10000 ETH by default when running `npx hardhat node` without PRIVATE_KEY set.
  // We use this known private key to get a signer with funds on the local fork.
  const funderPrivateKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // Hardhat Account #1 PK
  const funder = new ethers.Wallet(funderPrivateKey, ethers.provider);

  // The deployer account address (Hardhat's default Account #0)
  // This is the account configured in hardhat.config.js for the localFork network
  const deployerAddress = "0xf39Fd6e5e51aad88F6F4ce6aB8827279cffFb92266"; // Hardhat Account #0 Address

  // Amount to send (e.g., 1 ETH - this should be more than enough for deployment)
  const amountToSend = ethers.parseEther("1.0"); // Use parseEther for string -> wei BigInt

  console.log(`Funder Account: ${funder.address}`);
  console.log(`Deployer Account to Fund: ${deployerAddress}`);
  console.log(`Amount to Send: ${ethers.formatEther(amountToSend)} ETH`);

  try {
    // Check funder balance to confirm the node started correctly with funded accounts
    const funderBalance = await ethers.provider.getBalance(funder.address);
    console.log(`Funder balance before: ${ethers.formatEther(funderBalance)} ETH`);

    // We need at least 1 ETH + gas for the funding transaction
    if (funderBalance < amountToSend + ethers.parseEther("0.001")) { // Add a small buffer for gas
      console.error("❌ Funder account does not have enough ETH to send the required amount.");
      console.error("Hint: Ensure your Hardhat node was started correctly with default funded accounts (e.g., using `PRIVATE_KEY='' npx hardhat node`). The funder account should have 10000 ETH.");
      process.exit(1);
    }

    // Send the transaction
    const tx = await funder.sendTransaction({
      to: deployerAddress,
      value: amountToSend,
    });

    console.log(`⏳ Transaction sent: ${tx.hash}`);
    console.log("⏳ Waiting for confirmation...");

    const receipt = await tx.wait();
    console.log(`✅ Transaction confirmed in block ${receipt.blockNumber}`);

    const deployerBalanceAfter = await ethers.provider.getBalance(deployerAddress);
    console.log(`Deployer balance after funding: ${ethers.formatEther(deployerBalanceAfter)} ETH`);

    console.log("Funding complete. Deployer account is now funded.");

  } catch (error) {
    console.error("\n❌ Funding script failed:");
    if (error instanceof Error) {
       console.error(`   Reason: ${error.message}`);
    } else {
       console.error(error);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("❌ Unhandled error in funding script:");
  console.error(error);
  process.exitCode = 1;
});
