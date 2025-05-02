// scripts/create-arbitrage.js
// --- VERSION v1.0 --- Manually creates a price difference on a local fork for testing.
// Impersonates a rich account, funds it with tokens, and performs a large swap on a target pool.

const hre = require("hardhat");
const ethers = hre.ethers;

// Configuration for the manipulation
const NETWORK_TO_MANIPULATE = 'localFork'; // Must be your local fork network name
const POOL_ADDRESS_TO_MANIPULATE = "0xC31E54c7a869B9FcBEcc14363CF510d1c41fa443"; // UniV3 WETH/USDC 500bps
const IMPERSONATE_ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // Hardhat's default Account #0

// Token addresses on Arbitrum (same on fork)
const WETH_ADDRESS = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const USDC_ADDRESS = "0xFF970A61A04b1cA14834A43f585DfdE9f7654CbC"; // Assuming this is the USDC used in the UniV3 pool

// Amounts to fund the impersonated account with (in token decimals)
const FUND_AMOUNT_WETH = ethers.parseEther("1000"); // 1000 WETH
const FUND_AMOUNT_USDC = ethers.parseUnits("1000000", 6); // 1,000,000 USDC (6 decimals)

// Amount to swap to create the price difference (in WETH decimals)
const SWAP_AMOUNT_WETH = ethers.parseEther("100"); // Swap 100 WETH

async function main() {
    console.log(`Attempting to create arbitrage opportunity on network: ${NETWORK_TO_MANIPULATE}`);

    if (hre.network.name !== NETWORK_TO_MANIPULATE) {
        console.error(`❌ This script is intended for network "${NETWORK_TO_MANIPULATE}", but you are running on "${hre.network.name}". Aborting.`);
        process.exit(1);
    }

    try {
        const impersonatedSigner = await ethers.getImpersonatedSigner(IMPERSONATE_ACCOUNT);
        console.log(`Impersonating account: ${impersonatedSigner.address}`);

        // --- Fund the impersonated account with WETH and USDC ---
        console.log(`Funding ${impersonatedSigner.address} with tokens...`);

        // Note: Directly setting ERC20 balances requires knowing storage slots, which can be fragile.
        // A more robust method is often to impersonate a known whale account that holds the tokens,
        // or use Hardhat's test functions if available and reliable.
        // Let's try the hardhat_setBalance method for ETH, and maybe hardhat_setStorageAt if necessary for ERC20s.
        // Or, even simpler for local fork: impersonate a known rich account *and* fund it with ETH,
        // then use that ETH to *buy* WETH/USDC on the fork's *real* mainnet pools (like UniV3 WETH/ETH pool)
        // to get the necessary tokens. This is more realistic.

        // Let's try the simplest Hardhat internal method: setting ETH balance, and hope we can swap for tokens.
        // We already funded this account with 10 ETH in the deploy script using hardhat_setBalance.
        // Let's just ensure it has enough ETH to swap for tokens.
        const ethBalance = await ethers.provider.getBalance(impersonatedSigner.address);
        console.log(`Impersonated account ETH balance: ${ethers.formatEther(ethBalance)} ETH`);

        // We need WETH and USDC tokens to perform a swap on the WETH/USDC pool.
        // The easiest way is to swap some of the impersonated account's ETH for WETH and USDC.
        // We need the addresses of WETH and USDC on Arbitrum (same on fork).
        // We need the ABI for WETH (standard ERC20) and potentially Uniswap V3 Router/Pool ABIs.
        const wethContract = new ethers.Contract(WETH_ADDRESS, ["function deposit() payable", "function approve(address spender, uint256 amount) returns (bool)", "function balanceOf(address account) view returns (uint256)"], impersonatedSigner);
        const usdcContract = new ethers.Contract(USDC_ADDRESS, ["function approve(address spender, uint256 amount) returns (bool)", "function balanceOf(address account) view returns (uint256)"], impersonatedSigner);

        // Get the Uniswap V3 WETH/ETH pool address to swap ETH -> WETH
        // Hardcoding the address for WETH/ETH 0.05% pool on Arbitrum
        const WETH_ETH_V3_POOL = "0x8b0b5ac506e222b4a75548c7215b1063500b689d"; // WETH/ETH 500bps pool on Arbitrum
         const wethEthPool = new ethers.Contract(WETH_ETH_V3_POOL, ["function swap(address recipient, bool zeroForOne, int24 tickLower, int24 tickUpper, uint128 amountSpecified, bytes memory data) returns (uint256 amount0, uint256 amount1)", "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint32 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)"], impersonatedSigner);


        // Swap ETH for WETH
        const ethToSwapForWeth = ethers.parseEther("5"); // Swap 5 ETH for WETH
        console.log(`Swapping ${ethers.formatEther(ethToSwapForWeth)} ETH for WETH...`);
        // WETH.deposit() is the standard way to wrap ETH
        const wethDepositTx = await wethContract.deposit({ value: ethToSwapForWeth });
        await wethDepositTx.wait();
        console.log("ETH swapped for WETH (deposited).");

        const wethBalanceAfterFund = await wethContract.balanceOf(impersonatedSigner.address);
         console.log(`Impersonated account WETH balance: ${ethers.formatEther(wethBalanceAfterFund)} WETH`);


        // Now swap some WETH for USDC on a UniV3 pool to get USDC
        // Let's use the WETH/USDC 500bps pool we plan to manipulate
        const wethUsdcPool = new ethers.Contract(POOL_ADDRESS_TO_MANIPULATE, ["function swap(address recipient, bool zeroForOne, int24 tickLower, int24 tickUpper, uint128 amountSpecified, bytes memory data) returns (uint256 amount0, uint256 amount1)", "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint32 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)"], impersonatedSigner);
        const wethToSwapForUsdc = ethers.parseEther("1"); // Swap 1 WETH for USDC
        console.log(`Swapping ${ethers.formatEther(wethToSwapForUsdc)} WETH for USDC on ${POOL_ADDRESS_TO_MANIPULATE}...`);

        // Need to approve the pool to spend WETH
        const approveTx = await wethContract.approve(POOL_ADDRESS_TO_MANIPULATE, wethToSwapForUsdc);
        await approveTx.wait();
        console.log("Approved pool to spend WETH.");

        // Perform the swap (WETH -> USDC is zeroForOne=true if WETH is token0, check pool config)
        // Need to determine zeroForOne based on the actual pool's token0/token1
        const poolConfig = require('../config/localfork').UNISWAP_V3_POOLS.find(p => p.address === POOL_ADDRESS_TO_MANIPULATE);
        if (!poolConfig) {
             throw new Error(`Pool config not found for address ${POOL_ADDRESS_TO_MANIPULATE}`);
        }
        const zeroForOne = poolConfig.token0Symbol === 'WETH'; // True if WETH is token0

        // Need tickLower/tickUpper for the swap call. For a simple swap, use min/max ticks.
        const MIN_TICK = -887272;
        const MAX_TICK = 887272;

        const swapTx = await wethUsdcPool.swap(
            impersonatedSigner.address, // recipient
            zeroForOne,                 // zeroForOne (WETH -> USDC)
            MIN_TICK,                   // tickLower
            MAX_TICK,                   // tickUpper
            wethToSwapForUsdc,          // amountSpecified (using amountSpecified for exact input)
            "0x"                        // data
        );
        await swapTx.wait();
        console.log("Swap WETH -> USDC completed.");

        const usdcBalanceAfterFund = await usdcContract.balanceOf(impersonatedSigner.address);
        console.log(`Impersonated account USDC balance: ${ethers.formatUnits(usdcBalanceAfterFund, 6)} USDC`);


        // --- Perform the large swap to create arbitrage ---
        // Swap a large amount of WETH for USDC on the target pool (`POOL_ADDRESS_TO_MANIPULATE`)
        console.log(`Performing large swap (${ethers.formatEther(SWAP_AMOUNT_WETH)} WETH) on pool ${POOL_ADDRESS_TO_MANIPULATE} to create price difference...`);

        // Need to approve the pool again for the large swap amount
        const approveLargeTx = await wethContract.approve(POOL_ADDRESS_TO_MANIPULATE, SWAP_AMOUNT_WETH);
        await approveLargeTx.wait();
        console.log("Approved pool for large swap.");

         // Get current price before swap (optional, for logging)
         const slot0Before = await wethUsdcPool.slot0();
         const priceBefore = (BigInt(slot0Before.sqrtPriceX96) * BigInt(slot0Before.sqrtPriceX96)) / (2n ** 192n);
         console.log(`Price before swap (WETH/USDC): ${ethers.formatEther(priceBefore)}`);


        // Perform the large swap (WETH -> USDC)
        const largeSwapTx = await wethUsdcPool.swap(
            impersonatedSigner.address, // recipient
            zeroForOne,                 // zeroForOne (WETH -> USDC)
            MIN_TICK,                   // tickLower
            MAX_TICK,                   // tickUpper
            SWAP_AMOUNT_WETH,           // amountSpecified (using amountSpecified for exact input)
            "0x"                        // data
        );
        await largeSwapTx.wait();
        console.log(`Large swap of ${ethers.formatEther(SWAP_AMOUNT_WETH)} WETH completed.`);

         // Get price after swap (optional, for logging)
         const slot0After = await wethUsdcPool.slot0();
         const priceAfter = (BigInt(slot0After.sqrtPriceX96) * BigInt(slot0After.sqrtPriceX96)) / (2n ** 192n);
         console.log(`Price after swap (WETH/USDC): ${ethers.formatEther(priceAfter)}`);


        console.log("\nArbitrage opportunity likely created!");
        console.log(`Check prices between ${POOL_ADDRESS_TO_MANIPULATE} (UniV3 WETH/USDC) and other WETH/USDC or WETH/USDC.e pools monitored by the bot.`);
        console.log("Now run the bot with DRY_RUN=false to attempt execution.");

    } catch (error) {
        console.error("\n❌ Script failed to create arbitrage opportunity:");
        if (error instanceof Error) {
           console.error(`   Reason: ${error.message}`);
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
  console.error("❌ Unhandled error in script:");
  console.error(error);
  process.exitCode = 1;
});
