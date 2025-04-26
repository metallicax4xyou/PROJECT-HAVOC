// scripts/deploy.js
const hre = require("hardhat");
const ethers = hre.ethers; // Use ethers from Hardhat Runtime Environment

// --- Configuration ---
// Make sure these addresses are correct for the target network (Arbitrum One)
const UNISWAP_V3_ROUTER_ADDRESS = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const AAVE_V3_POOL_ADDRESS = "0x794a61358D6845594F94dc1DB02A252b5b4814aD"; // <<< ADDED Aave Pool Address
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
        }
    } catch (error) {
        console.error("❌ Error fetching deployer balance:", error);
    }

    // --- Deployment ---
    console.log(`Deploying contract with:`);
    console.log(`   Uniswap V3 Router: ${UNISWAP_V3_ROUTER_ADDRESS}`);
    console.log(`   Aave V3 Pool:      ${AAVE_V3_POOL_ADDRESS}`); // Log Aave address

    try {
        // Get the contract factory
        const FlashSwapFactory = await ethers.getContractFactory("FlashSwap");

        // Start the deployment transaction - PROVIDE BOTH ARGUMENTS
        const flashSwapContract = await FlashSwapFactory.deploy(
            UNISWAP_V3_ROUTER_ADDRESS,
            AAVE_V3_POOL_ADDRESS  // <<< Pass Aave Pool as second argument
        );

        // --- Wait for Deployment (Unchanged) ---
        const deployTxResponse = flashSwapContract.deploymentTransaction();
        if (!deployTxResponse) { throw new Error("Deployment transaction response not found after deploy() call."); }
        console.log("⏳ Waiting for deployment transaction to be mined...");
        console.log(`   Deployment Transaction Hash: ${deployTxResponse.hash}`);
        console.log(`⏳ Waiting for ${CONFIRMATIONS_TO_WAIT} confirmations...`);
        const deployReceipt = await deployTxResponse.wait(CONFIRMATIONS_TO_WAIT);
        if (!deployReceipt) { throw new Error(`Transaction receipt not found after waiting for ${CONFIRMATIONS_TO_WAIT} confirmations.`); }
        const deployedAddress = await flashSwapContract.getAddress();
        // --- ---

        console.log("----------------------------------------------------");
        console.log(`✅ FlashSwap deployed successfully!`);
        console.log(`   Contract Address: ${deployedAddress}`);
        console.log(`   Transaction Hash: ${deployReceipt.hash}`);
        console.log(`   Block Number: ${deployReceipt.blockNumber}`);
        console.log(`   Gas Used: ${deployReceipt.gasUsed.toString()}`);
        console.log("----------------------------------------------------");
        console.log("➡️ NEXT STEPS:");
        console.log("   1. Update ARBITRUM_FLASH_SWAP_ADDRESS in your .env file with the new address.");
        console.log("   2. Add ARBITRUM_AAVE_POOL_ADDRESS=${AAVE_V3_POOL_ADDRESS} to your .env file.");
        console.log("   3. Update config/arbitrum.js and config/index.js to load the Aave address.");
        console.log("   4. Implement off-chain JS logic for Aave path handling.");
        console.log("----------------------------------------------------");


    } catch (error) {
        console.error("\n❌ Deployment script failed:");
        console.error(error);
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error("❌ Unhandled error in deployment script:");
    console.error(error);
    process.exitCode = 1;
});
