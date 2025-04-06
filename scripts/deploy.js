// scripts/deploy.js

/**
 * Deploy script for FlashSwap.sol to Arbitrum One
 *
 * Usage: npx hardhat run scripts/deploy.js --network arbitrum
 * Requires: ARBISCAN_API_KEY and PRIVATE_KEY in .env for deployment & verification
 */

const hre = require("hardhat");
const { network } = require("hardhat"); // Import network

// Address for the Uniswap V3 SwapRouter on Arbitrum One
const ARBITRUM_SWAP_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
// Define minimum balance required for deployment (e.g., 0.001 ETH)
const MIN_BALANCE_FOR_DEPLOY = hre.ethers.parseEther("0.0005"); // Reduced slightly, adjust as needed
// --- Suggestion #4: Confirmations ---
const REQUIRED_CONFIRMATIONS = 2; // Increased from 1 for Arbitrum One

async function main() {
    // Ensure we are on the correct network
    if (network.name !== "arbitrum") {
        console.error("❌ This script is intended for the Arbitrum One network only.");
        console.error(`❌ Current network: ${network.name}`);
        process.exit(1);
    }

    console.log("🚀 Deploying FlashSwap contract to Arbitrum One...");
    console.log(`Network: ${network.name} (Chain ID: ${network.config.chainId})`);

    const [deployer] = await hre.ethers.getSigners();
    if (!deployer) {
        throw new Error("❌ Cannot find deployer account. Check Hardhat config and .env file (PRIVATE_KEY).");
    }
    console.log("Deployer Account:", deployer.address);

    const balance = await hre.ethers.provider.getBalance(deployer.address);
    console.log("Account Balance (Arbitrum ETH):", hre.ethers.formatEther(balance));
    // --- Suggestion #1: Better Balance Check ---
    if (balance < MIN_BALANCE_FOR_DEPLOY) {
        console.warn(`⚠️ Low ETH balance (${hre.ethers.formatEther(balance)} ETH) on Arbitrum. Deployment might fail. Minimum recommended: ${hre.ethers.formatEther(MIN_BALANCE_FOR_DEPLOY)} ETH.`);
        // Consider exiting if balance is extremely low:
        // if (balance === 0n) { process.exit(1); }
    }

    // Get the contract factory
    const FlashSwap = await hre.ethers.getContractFactory("FlashSwap");
    console.log(`Deploying contract with Uniswap V3 Router: ${ARBITRUM_SWAP_ROUTER}`);

    // Deploy the contract
    const flashSwap = await FlashSwap.deploy(ARBITRUM_SWAP_ROUTER);

    console.log("⏳ Waiting for deployment transaction to be mined...");

    // --- Suggestion #2: Use waitForDeployment ---
    await flashSwap.waitForDeployment(); // Waits for the contract to be deployed
    const flashSwapAddress = await flashSwap.getAddress(); // Get address after deployment is confirmed

    // Fetch the transaction receipt using the deployment transaction hash
    const deployTxHash = flashSwap.deploymentTransaction()?.hash;
    if (!deployTxHash) {
        throw new Error("❌ Deployment transaction hash is missing.");
    }
    console.log(`   Deployment Transaction Hash: ${deployTxHash}`);
    console.log(`⏳ Waiting for ${REQUIRED_CONFIRMATIONS} confirmations...`);
    const receipt = await hre.ethers.provider.waitForTransaction(deployTxHash, REQUIRED_CONFIRMATIONS);

    if (!receipt) {
       throw new Error(`❌ Transaction receipt not found after ${REQUIRED_CONFIRMATIONS} confirmations.`);
    }
    if (receipt.status !== 1) {
         console.error("❌ Deployment Transaction FAILED!");
         console.error("   Receipt:", receipt);
         process.exit(1);
    }
    // --- End change ---

    console.log("✅ FlashSwap contract deployed successfully!");
    console.log("   Contract Address:", flashSwapAddress);
    console.log("   Transaction Hash:", receipt.hash);
    console.log("   Confirmed Block:", receipt.blockNumber);
    console.log("   Deployer:", deployer.address);
    console.log("   Gas Used:", receipt.gasUsed.toString());

    // --- Verification ---
    const apiKey = process.env.ARBISCAN_API_KEY;
    if (apiKey && apiKey.length > 0) {
        console.log("\n🔍 Attempting contract verification on Arbiscan...");
        console.log(`   Run manually if fails: npx hardhat verify --network ${network.name} ${flashSwapAddress} "${ARBITRUM_SWAP_ROUTER}"`);
        console.log(`   Waiting 30 seconds for Arbiscan indexing...`);
        await new Promise(resolve => setTimeout(resolve, 30000));

        try {
            await hre.run("verify:verify", { address: flashSwapAddress, constructorArguments: [ARBITRUM_SWAP_ROUTER] });
            console.log("✅ Contract verified successfully on Arbiscan!");
        } catch (error) { /* ... Verification error handling ... */ }
    } else { /* ... Skip verification warning ... */ }
}

main().catch((error) => {
    console.error("\n❌ Deployment script failed:");
    console.error(error);
    process.exitCode = 1;
});
