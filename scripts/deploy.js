// scripts/deploy.js
// --- VERSION v3.8 --- Use getNamedSigner('deployer') for robustness

const hre = require("hardhat");
const ethers = hre.ethers; // Use ethers from Hardhat Runtime Environment

// --- Configuration ---
// Store raw addresses as strings
const UNISWAP_V3_ROUTER_RAW = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const SUSHI_ROUTER_RAW = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506";
const AAVE_V3_POOL_RAW = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const AAVE_ADDRESSES_PROVIDER_RAW = "0xa9768dEaF220135113516e574640BeA2979DBf85";

const CONFIRMATIONS_TO_WAIT = 2; // Number of block confirmations to wait for

async function main() {
    console.log(`🚀 Deploying FlashSwap contract to ${hre.network.name}...`);

    // --- Get Network and Deployer Signer Info ---
    // Use getNamedSigner for more robust account retrieval in Hardhat environments
    let deployer;
    try {
        // 'deployer' is a convention often used by Hardhat plugins, or defaults to the first signer
        deployer = await ethers.getNamedSigner('deployer');
        if (!deployer?.address) {
             throw new Error("Could not retrieve deployer signer.");
        }
    } catch (signerError) {
         console.error("❌ FATAL: Error getting deployer signer:", signerError.message);
         // If using 'remote' accounts, ensure the Hardhat node is running with funded accounts.
         console.log("Hint: If running against a local node, ensure the node is started and configured correctly (e.g., with --fork and funded accounts).");
         process.exit(1);
    }

    const network = await ethers.provider.getNetwork();
    console.log(`Network: ${network.name} (Chain ID: ${network.chainId})`);
    console.log(`Deployer Account: ${deployer.address}`);

    try {
        const balance = await ethers.provider.getBalance(deployer.address);
        console.log(`Account Balance (${network.name} ETH): ${ethers.formatEther(balance)}`);
        if (balance === 0n && network.chainId !== 31337) { // Only warn for zero balance on non-local chains
            console.warn("⚠️ Warning: Deployer account has zero balance.");
        }
    } catch (error) {
        console.error("❌ Error fetching deployer balance:", error);
    }

    // --- Get Checksummed Addresses using ethers ---
    let UNISWAP_V3_ROUTER_ADDRESS, SUSHI_ROUTER_ADDRESS, AAVE_V3_POOL_ADDRESS, AAVE_ADDRESSES_PROVIDER;
    try {
        UNISWAP_V3_ROUTER_ADDRESS = ethers.getAddress(UNISWAP_V3_ROUTER_RAW);
        SUSHI_ROUTER_ADDRESS = ethers.getAddress(SUSHI_ROUTER_RAW);
        AAVE_V3_POOL_ADDRESS = ethers.getAddress(AAVE_V3_POOL_RAW);
        // --- Try lowercase first ---
        AAVE_ADDRESSES_PROVIDER = ethers.getAddress(AAVE_ADDRESSES_PROVIDER_RAW.toLowerCase());
        // --- ---
        console.log("Checksummed addresses verified.");
    } catch (checksumError) {
         console.error("❌ FATAL: Error checksumming addresses defined in script:", checksumError);
         process.exit(1);
    }


    // --- Deployment ---
    console.log(`Deploying contract with:`);
    console.log(`   Uniswap V3 Router: ${UNISWAP_V3_ROUTER_ADDRESS}`);
    console.log(`   SushiSwap Router:  ${SUSHI_ROUTER_ADDRESS}`);
    console.log(`   Aave V3 Pool:      ${AAVE_V3_POOL_ADDRESS}`);
    console.log(`   Aave Addr Prov:  ${AAVE_ADDRESSES_PROVIDER}`);

    try {
        // Get the contract factory, connected to the deployer signer
        const FlashSwapFactory = await ethers.getContractFactory("FlashSwap", deployer); // <-- Pass deployer here

        // Start the deployment transaction - Pass checksummed addresses
        console.log("Deploying with 4 arguments...");
        const flashSwapContract = await FlashSwapFactory.deploy(
            UNISWAP_V3_ROUTER_ADDRESS, // Arg 1
            SUSHI_ROUTER_ADDRESS,      // Arg 2
            AAVE_V3_POOL_ADDRESS,      // Arg 3
            AAVE_ADDRESSES_PROVIDER    // Arg 4
        );
        console.log("Deploy call sent...");

        // --- Wait for Deployment ---
        const deployTxResponse = flashSwapContract.deploymentTransaction();
        if (!deployTxResponse) { throw new Error("Deployment transaction response not found after deploy() call."); }
        console.log("⏳ Waiting for deployment transaction to be mined...");
        console.log(`   Deployment Transaction Hash: ${deployTxResponse.hash}`);
        console.log(`⏳ Waiting for ${CONFIRMATIONS_TO_WAIT} confirmations...`);
        const deployReceipt = await deployTxResponse.wait(CONFIRMATIONS_TO_WAIT);
        if (!deployReceipt) { throw new Error(`Transaction receipt not found after waiting for ${CONFIRMATIONS_TO_WAIT} confirmations.`); }
        // Use getAddress() on the contract instance after deployment is confirmed
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
        console.log(`   1. Update ARBITRUM_FLASH_SWAP_ADDRESS in your .env file with: ${deployedAddress}`);
        console.log(`   2. Ensure your .env has ARBITRUM_RPC_URLS, PRIVATE_KEY (if needed for bot), etc.`);
        console.log(`   3. For testing the Tithe mechanism, configure your bot to use the 'localFork' RPC and this new contract address.`);
        console.log("----------------------------------------------------");


    } catch (error) {
        console.error("\n❌ Deployment script failed:");
        if (error instanceof Error) {
           console.error(`   Reason: ${error.message}`);
        } else {
           console.error(error);
        }
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error("❌ Unhandled error in deployment script:");
    console.error(error);
    process.exitCode = 1;
});
