// scripts/deploy.js
const hre = require("hardhat");
const { network } = require("hardhat"); // Import network

// Address for the Uniswap V3 SwapRouter on Arbitrum One (and many other chains)
// Verify this address from official Uniswap documentation if needed.
const ARBITRUM_SWAP_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";

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
    if (balance === 0n) {
        console.warn("⚠️ Deployer account has 0 ETH on Arbitrum. Deployment will likely fail.");
    }

    // Get the contract factory
    const FlashSwap = await hre.ethers.getContractFactory("FlashSwap");
    console.log(`Deploying contract with Uniswap V3 Router: ${ARBITRUM_SWAP_ROUTER}`);

    // Deploy the contract
    const flashSwap = await FlashSwap.deploy(ARBITRUM_SWAP_ROUTER);

    console.log("⏳ Waiting for deployment transaction to be mined...");
    // Use Hardhat's recommended way to wait for deployment confirmation
    const deploymentTransaction = flashSwap.deploymentTransaction();
    if (!deploymentTransaction) {
        throw new Error("❌ Deployment transaction object is missing.");
    }
    const receipt = await deploymentTransaction.wait(1); // Wait for 1 confirmation
    if (!receipt) {
       throw new Error("❌ Transaction receipt is missing after waiting.");
    }
    const flashSwapAddress = await flashSwap.getAddress();


    console.log("✅ FlashSwap contract deployed successfully!");
    console.log("   Contract Address:", flashSwapAddress);
    console.log("   Transaction Hash:", receipt.hash); // Use receipt.hash
    console.log("   Deployed Block:", receipt.blockNumber);
    console.log("   Deployer:", deployer.address);
    console.log("   Gas Used:", receipt.gasUsed.toString());

    // --- Verification ---
    const apiKey = process.env.ARBISCAN_API_KEY;
    if (apiKey && apiKey.length > 0) { // Added length check
        console.log("\n🔍 Attempting contract verification on Arbiscan...");
        console.log(`   Run this command manually if automatic verification fails:`);
        console.log(`   npx hardhat verify --network ${network.name} ${flashSwapAddress} "${ARBITRUM_SWAP_ROUTER}"`);

        // Wait a few seconds before verification to ensure Arbiscan indexes the contract
        console.log("   Waiting 30 seconds for Arbiscan indexing...");
        await new Promise(resolve => setTimeout(resolve, 30000)); // 30 sec wait

        try {
            await hre.run("verify:verify", {
                address: flashSwapAddress,
                constructorArguments: [ARBITRUM_SWAP_ROUTER],
                // Optional: Specify contract path if Hardhat struggles to find it
                // contract: "contracts/FlashSwap.sol:FlashSwap"
            });
            console.log("✅ Contract verified successfully on Arbiscan!");
        } catch (error) {
            console.error("❌ Contract verification failed:", error.message);
            if (error.message.toLowerCase().includes("already verified")) {
               console.log("   Contract might already be verified.");
            } else {
               console.error("   Manual verification command provided above.");
            }
        }
    } else {
        console.warn("\n⚠️ ARBISCAN_API_KEY not found or empty in .env. Skipping automatic contract verification.");
        console.warn(`   You can manually verify later using:`);
        console.warn(`   npx hardhat verify --network ${network.name} ${flashSwapAddress} "${ARBITRUM_SWAP_ROUTER}"`);
    }
}

main().catch((error) => {
    console.error("\n❌ Deployment script failed:");
    console.error(error);
    process.exitCode = 1;
});
