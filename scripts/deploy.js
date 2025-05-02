// scripts/deploy.js
// --- VERSION v4.0 --- Impersonates and funds the default Hardhat Account #0 for deployment.

const hre = require("hardhat");
const ethers = hre.ethers; // Use ethers from Hardhat Runtime Environment

// --- Configuration ---
// Store raw addresses as strings
const UNISWAP_V3_ROUTER_RAW = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const SUSHI_ROUTER_RAW = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506";
const AAVE_V3_POOL_RAW = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const AAVE_ADDRESSES_PROVIDER_RAW = "0xa9768dEaF220135113516e574640BeA2979DBf85";

const CONFIRMATIONS_TO_WAIT = 1; // Lower confirmations for faster local testing
const DEFAULT_HARDHAT_DEPLOYER_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // Hardhat's default Account #0
const ETH_TO_FUND_DEPLOYER = ethers.parseEther("10"); // Amount of ETH to give the deployer on the fork

async function main() {
    console.log(`🚀 Deploying FlashSwap contract to ${hre.network.name}...`);

    let deployer;

    // --- Impersonate and Fund the Default Hardhat Deployer Account on the Local Fork ---
    if (hre.network.name === 'localFork') {
        console.log(`Attempting to impersonate and fund default Hardhat deployer account: ${DEFAULT_HARDHAT_DEPLOYER_ADDRESS}`);
        try {
            // Request impersonation
            await hre.network.provider.request({
                method: "hardhat_impersonateAccount",
                params: [DEFAULT_HARDHAT_DEPLOYER_ADDRESS],
            });

            // Fund the impersonated account using Hardhat's test methods
            // Get a signer for the impersonated account
            deployer = await ethers.getSigner(DEFAULT_HARDHAT_DEPLOYER_ADDRESS);

            // Check current balance (might be very low if not auto-funded)
            const currentBalance = await ethers.provider.getBalance(DEFAULT_HARDHAT_DEPLOYER_ADDRESS);
            console.log(`Current balance of ${DEFAULT_HARDHAT_DEPLOYER_ADDRESS}: ${ethers.formatEther(currentBalance)} ETH`);

            // Only fund if necessary (e.g., balance is too low for deployment)
            // The exact gas cost of deployment varies, 0.5 ETH is a safe minimum buffer
            const minRequiredBalance = ethers.parseEther("0.5"); // Estimate needed ETH for deployment

            if (currentBalance < minRequiredBalance) {
                console.log(`Funding ${DEFAULT_HARDHAT_DEPLOYER_ADDRESS} with ${ethers.formatEther(ETH_TO_FUND_DEPLOYER)} ETH...`);
                 // Use Hardhat's internal method to set balance (requires impersonation and enough ETH in the source account,
                 // or if run directly on the Hardhat node process, it can mint).
                 // A more reliable way is to use Hardhat's `setBalance` if available via `network.provider`.
                 await hre.network.provider.send("hardhat_setBalance", [
                     DEFAULT_HARDHAT_DEPLOYER_ADDRESS,
                     ethers.toQuantity(ETH_TO_FUND_DEPLOYER), // Amount in hex string
                 ]);
                 console.log("Funding successful via hardhat_setBalance.");

                 // Re-get signer to ensure it's connected to the updated balance
                 deployer = await ethers.getSigner(DEFAULT_HARDHAT_DEPLOYER_ADDRESS);

            } else {
                 console.log("Account already has sufficient balance. Skipping funding.");
            }

            const fundedBalance = await ethers.provider.getBalance(DEFAULT_HARDHAT_DEPLOYER_ADDRESS);
            console.log(`Balance after funding/check: ${ethers.formatEther(fundedBalance)} ETH`);


        } catch (impersonationError) {
            console.error(`❌ FATAL: Failed to impersonate or fund account ${DEFAULT_HARDHAT_DEPLOYER_ADDRESS}:`, impersonationError.message);
            console.log("Hint: Ensure your Hardhat node is running with forking enabled.");
            process.exit(1);
        }
         console.log(`Using Impersonated Deployer Account: ${deployer.address}`);

    } else {
        // --- Get Standard Signer for Non-Local Networks ---
        console.log("Using standard signer retrieval for non-local network...");
        try {
            const signers = await ethers.getSigners();
            if (signers.length === 0) {
                 throw new Error("No signers available. Ensure PRIVATE_KEY is set for this network.");
            }
            deployer = signers[0]; // Get the first signer
             if (!deployer?.address) {
                 throw new Error("First signer retrieved is undefined or missing address.");
             }
        } catch (signerError) {
             console.error("❌ FATAL: Error getting deployer signer:", signerError.message);
             console.log("Hint: Ensure PRIVATE_KEY is correctly set in your .env for network", hre.network.name);
             process.exit(1);
        }
        console.log(`Deployer Account: ${deployer.address}`);
         try {
            const balance = await ethers.provider.getBalance(deployer.address);
            console.log(`Account Balance (${hre.network.name} ETH): ${ethers.formatEther(balance)}`);
            if (balance === 0n) {
                console.warn("⚠️ Warning: Deployer account has zero balance.");
            }
        } catch (error) {
            console.error("❌ Error fetching deployer balance:", error);
        }
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

        // Start the deployment transaction
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
        console.log(`⏳ Waiting for ${CONFIRMATIONS_TO_WAIT} confirmation(s)...`); // Updated log
        const deployReceipt = await deployTxResponse.wait(CONFIRMATIONS_TO_WAIT);
        if (!deployReceipt) { throw new Error(`Transaction receipt not found after waiting for ${CONFIRMATIONS_TO_WAIT} confirmation(s).`); } // Updated log
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
        console.log(`   2. Configure your bot's Provider to use the localFork RPC: http://127.0.0.1:8545`);
        console.log(`   3. Ensure your .env has TITHE_WALLET_ADDRESS set.`);
        console.log(`   4. Run the bot in DRY_RUN=true mode first to find opportunities.`);
        console.log(`   5. Once opportunities are found, set DRY_RUN=false and attempt execution to test the Tithe mechanism.`);
        console.log("----------------------------------------------------");


    } catch (error) {
        console.error("\n❌ Deployment script failed:");
        if (error instanceof Error) {
           console.error(`   Reason: ${error.message}`);
           // Log original error stack in debug mode
           if (process.env.DEBUG === 'true' && error.stack) {
               console.error("Error stack:", error.stack);
           }
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
