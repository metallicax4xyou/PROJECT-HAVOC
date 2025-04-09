// scripts/deploy.js
const hre = require("hardhat");
const ethers = hre.ethers; // Use ethers from Hardhat Runtime Environment

// --- Configuration ---
// Make sure this address is correct for the target network (Arbitrum One)
const UNISWAP_V3_ROUTER_ADDRESS = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const CONFIRMATIONS_TO_WAIT = 2; // Number of block confirmations to wait for

async function main() {
    console.log(`🚀 Deploying FlashSwap contract to ${hre.network.name}...`);

    // --- Get Network and Signer Info ---
    const [deployer] = await ethers.getSigners();
    const network = await ethers.provider.getNetwork();
    console.log(`Network: ${network.name} (Chain ID: ${network.chainId})`);
    console.log(`Deployer Account: ${deployer.address}`);

    try {
        const balance = await ethers.provider.getBalance(deployer.address);
        console.log(`Account Balance (${network.name} ETH): ${ethers.formatEther(balance)}`);
        if (balance === 0n) {
            console.warn("⚠️ Warning: Deployer account has zero balance.");
            // Consider adding a check to stop deployment if balance is too low
        }
    } catch (error) {
        console.error("❌ Error fetching deployer balance:", error);
        // Decide if this should halt deployment
    }

    // --- Deployment ---
    console.log(`Deploying contract with Uniswap V3 Router: ${UNISWAP_V3_ROUTER_ADDRESS}`);

    try {
        // Get the contract factory
        const FlashSwapFactory = await ethers.getContractFactory("FlashSwap");

        // Start the deployment transaction
        const flashSwapContract = await FlashSwapFactory.deploy(UNISWAP_V3_ROUTER_ADDRESS);

        // --- Correct Way to Get Transaction and Wait ---
        const deployTxResponse = flashSwapContract.deploymentTransaction(); // Get the transaction response object

        if (!deployTxResponse) {
             throw new Error("Deployment transaction response not found after deploy() call.");
        }

        console.log("⏳ Waiting for deployment transaction to be mined...");
        console.log(`   Deployment Transaction Hash: ${deployTxResponse.hash}`);

        // Call .wait() directly on the transaction response object
        // This replaces the problematic provider.waitForTransaction call
        console.log(`⏳ Waiting for ${CONFIRMATIONS_TO_WAIT} confirmations...`);
        const deployReceipt = await deployTxResponse.wait(CONFIRMATIONS_TO_WAIT);

        if (!deployReceipt) {
            throw new Error(`Transaction receipt not found after waiting for ${CONFIRMATIONS_TO_WAIT} confirmations.`);
        }

        // Get the final deployed contract address AFTER waiting
        const deployedAddress = await flashSwapContract.getAddress(); // Use getAddress()

        console.log("----------------------------------------------------");
        console.log(`✅ FlashSwap deployed successfully!`);
        console.log(`   Contract Address: ${deployedAddress}`);
        console.log(`   Transaction Hash: ${deployReceipt.hash}`);
        console.log(`   Block Number: ${deployReceipt.blockNumber}`);
        console.log(`   Gas Used: ${deployReceipt.gasUsed.toString()}`);
        console.log("----------------------------------------------------");

        // Optional: Verify on Etherscan/Arbiscan
        // Add verification logic here if needed

    } catch (error) {
        console.error("\n❌ Deployment script failed:");
        console.error(error);
        process.exitCode = 1; // Set exit code to indicate failure
    }
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
    console.error("❌ Unhandled error in deployment script:");
    console.error(error);
    process.exitCode = 1;
});
