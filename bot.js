// bot.js
// This script monitors Uniswap V3 pools on Arbitrum for potential arbitrage opportunities
// and attempts to execute them using the deployed FlashSwap contract.
// WARNING: Highly experimental, contains placeholders, assumes specific token pairs,
// and lacks robust error handling, simulation, and gas calculation. DO NOT USE WITH SIGNIFICANT FUNDS.

require("dotenv").config();
const { ethers } = require("ethers"); // Ensure ethers is imported

// --- Configuration ---
const RPC_URL = process.env.ARBITRUM_RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// Use ethers.getAddress() to ensure correct checksum for all addresses
// !! Replace with YOUR deployed FlashSwap contract address !!
const FLASH_SWAP_CONTRACT_ADDRESS = ethers.getAddress("0x3f7A3f4bb9DCE54684D06060bF4491544Ee4Dba5");

// Arbitrum One Addresses (Verify these using Arbiscan/DexScreener for certainty)
const WETH_ADDRESS = ethers.getAddress("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"); // Wrapped Ether
const USDC_ADDRESS = ethers.getAddress("0xaf88d065e77c8cC2239327C5EDb3A432268e5831"); // Native USDC (usually preferred)
const POOL_WETH_USDC_005 = ethers.getAddress("0xC31E54c7a869B9FcBEcc14363CF510d1c41fa443"); // WETH/USDC 0.05% Fee Pool
const POOL_WETH_USDC_030 = ethers.getAddress("0x17c14d2c404d167802b16c450d3c99f88f2c4f4d"); // Use fully lowercase // WETH/USDC 0.30% Fee Pool (Can use non-checksummed here too)
// const ROUTER_ADDRESS = ethers.getAddress("0xE592427A0AEce92De3Edee1F18E0157C05861564"); // Router not directly needed by bot if calling FlashSwap

// Token Decimals
const WETH_DECIMALS = 18;
const USDC_DECIMALS = 6;

// --- ABIs ---
// Uniswap V3 Pool ABI (Minimal: need slot0, token0, token1, fee)
const UNISWAP_V3_POOL_ABI = [
    "function token0() external view returns (address)",
    "function token1() external view returns (address)",
    "function fee() external view returns (uint24)",
    "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)"
];

// FlashSwap Contract ABI (Minimal: need initiateFlashSwap and potentially events/owner)
const FLASH_SWAP_ABI = [
    // Function to trigger the flash swap
    "function initiateFlashSwap(address _poolAddress, uint256 _amount0, uint256 _amount1, bytes calldata _params) external",
    // Optional: Read owner if needed for checks
    // "function owner() external view returns (address)",
    // Events for logging/monitoring off-chain
    "event FlashSwapInitiated(address indexed caller, address indexed pool, uint256 amount0, uint256 amount1)",
    "event ArbitrageAttempt(address indexed poolA, address indexed poolB, address tokenBorrowed, uint256 amountBorrowed)",
    "event SwapExecuted(uint256 indexed swapNumber, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut)",
    "event RepaymentSuccess(address indexed token, uint256 amountRepaid)"
];


// --- Helper Function: Calculate Price from sqrtPriceX96 ---
/**
 * Calculates the price of token1 in terms of token0 from sqrtPriceX96.
 * Uses floating-point math for easier display, may lose precision vs bigint math.
 * @param {bigint} sqrtPriceX96 The sqrtPriceX96 value from pool.slot0().
 * @param {number} decimals0 Decimals of token0.
 * @param {number} decimals1 Decimals of token1.
 * @returns {number} The price of 1 unit of token1 denominated in token0.
 */
function sqrtPriceX96ToPrice(sqrtPriceX96, decimals0, decimals1) {
    const Q96 = 2n**96n;
    // Calculate price = (sqrtPriceX96 / 2^96)^2
    // Use floating point for simplicity here
    const priceRatio = (Number(sqrtPriceX96) / Number(Q96)) ** 2;

    // Adjust for token decimals
    const decimalAdjustment = 10**(decimals0 - decimals1);
    return priceRatio * decimalAdjustment;
}

// --- Provider & Signer ---
if (!RPC_URL || !PRIVATE_KEY) {
    console.error("❌ Missing ARBITRUM_RPC_URL or PRIVATE_KEY in .env file. Exiting.");
    process.exit(1); // Exit if essential config is missing
}
const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);
console.log(`🤖 Bot Initialized.`);
console.log(`   Network: Arbitrum One (connected via RPC)`);
console.log(`   Executor Address: ${signer.address}`);
console.log(`   FlashSwap Contract: ${FLASH_SWAP_CONTRACT_ADDRESS}`); // Will now show checksummed version

// --- Contract Instances ---
// FlashSwap contract instance connected to the signer (to send transactions)
const flashSwapContract = new ethers.Contract(FLASH_SWAP_CONTRACT_ADDRESS, FLASH_SWAP_ABI, signer);
// Uniswap Pool instances connected to the provider (for read-only data fetching)
const pool005 = new ethers.Contract(POOL_WETH_USDC_005, UNISWAP_V3_POOL_ABI, provider);
const pool030 = new ethers.Contract(POOL_WETH_USDC_030, UNISWAP_V3_POOL_ABI, provider);

// --- Main Bot Logic ---

/**
 * Checks for arbitrage opportunities between the configured WETH/USDC pools
 * and attempts to execute a flash swap if profitable.
 */
async function checkArbitrage() {
    console.log(`\n[${new Date().toISOString()}] Checking for arbitrage: ${POOL_WETH_USDC_005} vs ${POOL_WETH_USDC_030}`);

    try {
        // 1. Get Current Pool Data (slot0 includes sqrtPriceX96)
        // Use Promise.all for concurrent fetching
        const [slot0_005, slot0_030, token0_pool005] = await Promise.all([
             pool005.slot0(),
             pool030.slot0(),
             pool005.token0() // Check token order for price calculation
        ]);

        const sqrtPriceX96_005 = slot0_005.sqrtPriceX96;
        const sqrtPriceX96_030 = slot0_030.sqrtPriceX96;

        // Ensure token order assumption is correct (USDC=token0, WETH=token1)
        // Note: This assumes both pools have the same token0/token1 order. Usually true for same pair.
        if (token0_pool005.toLowerCase() !== USDC_ADDRESS.toLowerCase()) {
            console.error(`❌ Unexpected token0 in Pool ${POOL_WETH_USDC_005}: ${token0_pool005}. Expected USDC. Exiting check.`);
            return; // Stop this check cycle if token order is wrong
        }

        // 2. Calculate Human-Readable Prices
        // Prices calculated as USDC per 1 WETH (since USDC is token0, WETH is token1)
        const price_005 = sqrtPriceX96ToPrice(sqrtPriceX96_005, USDC_DECIMALS, WETH_DECIMALS);
        const price_030 = sqrtPriceX96ToPrice(sqrtPriceX96_030, USDC_DECIMALS, WETH_DECIMALS);

        console.log(`   Pool 0.05% Price (USDC/WETH): ${price_005.toFixed(USDC_DECIMALS)}`); // Use USDC decimals for price display
        console.log(`   Pool 0.30% Price (USDC/WETH): ${price_030.toFixed(USDC_DECIMALS)}`);
        const priceDiffPercent = Math.abs(price_005 - price_030) / Math.min(price_005, price_030) * 100;
        console.log(`   Price Difference: ${priceDiffPercent.toFixed(4)}%`);


        // 3. Identify Potential Arbitrage Direction & Parameters
        // Basic check: Is the difference potentially large enough to cover fees? Needs refinement.

        // --- Simplified Example Scenario: ---
        // Strategy: Always try Borrow WETH, Sell WETH->USDC (Pool A), Buy WETH<-USDC (Pool B), Repay WETH
        // Pool A should be the one with the HIGHER WETH price (sell high)
        // Pool B should be the one with the LOWER WETH price (buy low)

        const BORROW_TOKEN = WETH_ADDRESS; // Borrowing WETH
        const INTERMEDIATE_TOKEN = USDC_ADDRESS; // Swapping through USDC

        let poolA, feeA, poolB, feeB, loanPool;
        if (price_030 > price_005) { // Sell high (0.30%), buy low (0.05%)
            poolA = POOL_WETH_USDC_030; feeA = 3000;
            poolB = POOL_WETH_USDC_005; feeB = 500;
            loanPool = poolA; // Borrow from the pool where we sell first (higher price)
            console.log(`   Potential Path: Borrow WETH from ${loanPool}, Sell WETH->USDC@${feeA/10000}%, Buy WETH<-USDC@${feeB/10000}%`);
        } else if (price_005 > price_030) { // Sell high (0.05%), buy low (0.30%)
            poolA = POOL_WETH_USDC_005; feeA = 500;
            poolB = POOL_WETH_USDC_030; feeB = 3000;
            loanPool = poolA; // Borrow from the pool where we sell first (higher price)
            console.log(`   Potential Path: Borrow WETH from ${loanPool}, Sell WETH->USDC@${feeA/10000}%, Buy WETH<-USDC@${feeB/10000}%`);
        } else {
             console.log(`   Prices are equal or too close. No arbitrage opportunity.`);
             return; // Exit if prices are effectively equal
        }


        // 4. Calculate Expected Output & Profitability (CRITICAL TODO)
        // TODO: Implement actual swap simulation using sqrtPriceX96, liquidity, fees. Uniswap SDK/Quoter is best.
        // TODO: Accurately calculate flash loan fee (pool fee if borrow/repay same pool)

        const amountToBorrow = ethers.parseUnits("0.01", WETH_DECIMALS); // Example: Borrow 0.01 WETH
        console.log(`   Simulating borrow of ${ethers.formatUnits(amountToBorrow, WETH_DECIMALS)} WETH...`);

        // --- !! Placeholder Simulation - Needs replacing !! ---
        const expectedIntermediateFromSwap1 = ethers.parseUnits("35.0", USDC_DECIMALS); // e.g., 35.0 USDC (HIGHLY DEPENDENT ON PRICE & AMOUNT)
        const expectedFinalFromSwap2 = ethers.parseUnits("0.01005", WETH_DECIMALS); // e.g., get slightly more WETH back

        // Flash loan fee is the fee of the pool you borrowed from (Pool A in this logic)
        const loanPoolFeeTier = feeA; // feeA corresponds to loanPool
        const flashLoanFee = (amountToBorrow * BigInt(loanPoolFeeTier)) / 1000000n; // Fee = amount * feeTier / 1,000,000
        const totalAmountToRepay = amountToBorrow + flashLoanFee;

        // Calculate potential profit in WETH
        const potentialProfitWeth = expectedFinalFromSwap2 - totalAmountToRepay;

        console.log(`   Expected USDC (Swap 1): ${ethers.formatUnits(expectedIntermediateFromSwap1, USDC_DECIMALS)}`);
        console.log(`   Expected WETH (Swap 2): ${ethers.formatUnits(expectedFinalFromSwap2, WETH_DECIMALS)}`);
        console.log(`   Flash Loan Fee (WETH): ${ethers.formatUnits(flashLoanFee, WETH_DECIMALS)}`);
        console.log(`   Total WETH to Repay: ${ethers.formatUnits(totalAmountToRepay, WETH_DECIMALS)}`);
        console.log(`   Potential Profit (WETH, before gas): ${ethers.formatUnits(potentialProfitWeth, WETH_DECIMALS)}`);


        // 5. Estimate Gas Cost (CRITICAL TODO)
        // TODO: Implement reliable gas estimation for the initiateFlashSwap call.
        // const estimatedGasUnits = await flashSwapContract.initiateFlashSwap.estimateGas(...); // Needs params filled
        // const feeData = await provider.getFeeData();
        // const estimatedGasCostWei = estimatedGasUnits * (feeData.maxFeePerGas ?? feeData.gasPrice); // Use EIP-1559 or legacy
        const estimatedGasCostWei = ethers.parseUnits("0.0001", "ether"); // FIXME: HARDCODED ESTIMATE - VERY DANGEROUS AND LIKELY WRONG
        const estimatedGasCostWeth = estimatedGasCostWei; // Assuming 1:1 ETH:WETH for simplicity

        console.log(`   Estimated Gas Cost (WETH): ${ethers.formatUnits(estimatedGasCostWeth, WETH_DECIMALS)}`);


        // 6. Check Profitability (After Gas)
        const netProfitWeth = potentialProfitWeth - estimatedGasCostWeth;
        console.log(`   Net Profit (WETH, after estimated gas): ${ethers.formatUnits(netProfitWeth, WETH_DECIMALS)}`);

        // Set a minimum profit threshold (e.g., equivalent of a few cents/dollars)
        const MIN_PROFIT_THRESHOLD_WETH = ethers.parseUnits("0.00001", WETH_DECIMALS); // Tiny threshold for testing

        if (netProfitWeth > MIN_PROFIT_THRESHOLD_WETH) {
            console.log("✅ PROFITABLE OPPORTUNITY DETECTED! Preparing flash swap...");

            // 7. Construct Arbitrage Parameters
            // TODO: Calculate amountOutMinimum based on simulation results minus slippage tolerance (e.g., 0.1%)
            const slippageTolerance = 0.001; // 0.1% slippage example
            // Calculate minimum intermediate tokens expected from swap 1
            const amountOutMinimum1 = expectedIntermediateFromSwap1 * BigInt(Math.floor((1 - slippageTolerance) * 10000)) / 10000n;
            // Calculate minimum final tokens expected from swap 2. MUST cover repayment + target profit (with slippage)
            // For safety, let's start by just ensuring repayment is covered + tiny profit buffer
            const requiredRepaymentThreshold = totalAmountToRepay + MIN_PROFIT_THRESHOLD_WETH; // Must get back at least this much
            const amountOutMinimum2 = requiredRepaymentThreshold * BigInt(Math.floor((1 - slippageTolerance) * 10000)) / 10000n; // Apply slippage to required amount


            console.log(`   Setting amountOutMinimum1 (USDC): ${ethers.formatUnits(amountOutMinimum1, USDC_DECIMALS)}`);
            console.log(`   Setting amountOutMinimum2 (WETH): ${ethers.formatUnits(amountOutMinimum2, WETH_DECIMALS)}`);


            const arbitrageParams = ethers.AbiCoder.defaultAbiCoder().encode(
                ['address', 'address', 'address', 'uint24', 'uint24', 'uint256', 'uint256'],
                [INTERMEDIATE_TOKEN, poolA, poolB, feeA, feeB, amountOutMinimum1, amountOutMinimum2]
            );

            // Determine amount0/amount1 based on borrowed token vs loan pool token order
            let amount0 = 0n;
            let amount1 = 0n;
            // We checked token0 is USDC earlier for pool005. Assume same for pool030.
            // Since we borrow WETH (token1), set amount1.
            if (BORROW_TOKEN.toLowerCase() === WETH_ADDRESS.toLowerCase()) {
                 amount1 = amountToBorrow;
            } else {
                 amount0 = amountToBorrow; // Logic for borrowing USDC would go here
                 console.error("Error: Borrowing non-WETH not fully implemented in this example path.");
                 return; // Prevent execution if logic isn't ready
            }


            // 8. Execute Flash Swap Transaction
            console.log(`   Executing initiateFlashSwap on contract ${FLASH_SWAP_CONTRACT_ADDRESS}...`);
            console.log(`     Loan Pool: ${loanPool}`);
            console.log(`     Amount0: ${amount0.toString()}`);
            console.log(`     Amount1: ${ethers.formatUnits(amount1, WETH_DECIMALS)} WETH`);
            // console.log(`     Params: ${arbitrageParams}`); // Can be very long

            try {
                // TODO: Add dynamic gas estimation result here
                // const estimatedGasLimit = estimatedGasUnits * 12n / 10n; // Example: 1.2x buffer
                console.warn("   !!! EXECUTING TRANSACTION WITH HARDCODED SIMULATION & GAS !!!"); // Add warning
                const tx = await flashSwapContract.initiateFlashSwap(
                    loanPool,
                    amount0,
                    amount1,
                    arbitrageParams
                    // Optional: Specify gas settings if needed, e.g., based on provider.getFeeData()
                    // { gasLimit: estimatedGasLimit, maxFeePerGas: feeData.maxFeePerGas, maxPriorityFeePerGas: feeData.maxPriorityFeePerGas }
                );

                console.log(`   ✅ Transaction Sent: ${tx.hash}`);
                console.log(`   ⏳ Waiting for confirmation...`);

                const receipt = await tx.wait(1); // Wait for 1 confirmation
                console.log(`   ✅ Transaction Confirmed! Block: ${receipt.blockNumber}, Gas Used: ${receipt.gasUsed.toString()}`);
                // TODO: Check receipt logs for success/failure events from FlashSwap contract to confirm internal success

            } catch (executionError) {
                 console.error(`   ❌ Flash Swap Transaction Failed: ${executionError.message}`);
                 // Try to decode revert reason if possible
                 if (executionError.data && executionError.data !== '0x') { // Check if data exists and is not empty
                    try {
                        const decodedError = flashSwapContract.interface.parseError(executionError.data);
                        console.error(`   Contract Revert Reason: ${decodedError?.name}${decodedError?.args ? `(${decodedError.args})` : '()'}`);
                    } catch (decodeErr) { console.error("   Error data decoding failed:", decodeErr.message); }
                 } else if (executionError.receipt) {
                     console.error("   Transaction Receipt (if available):", executionError.receipt);
                 } else if (executionError.transactionHash) {
                    console.error("   Transaction Hash:", executionError.transactionHash);
                 }
            }


        } else {
            console.log("   No profitable opportunity found this cycle (profit below threshold or negative).");
        }

    } catch (error) {
        console.error(`❌ Error during arbitrage check cycle: ${error.message}`);
        // Log stack trace for debugging if available
        if (error.stack) {
           // console.error(error.stack); // Uncomment for detailed stack traces
        }
    }
}

// --- Run the Bot ---
const CHECK_INTERVAL_MS = 15000; // Check every 15 seconds (adjust as needed)
console.log(`Starting arbitrage check loop: Checking every ${CHECK_INTERVAL_MS / 1000} seconds.`);
console.log("Press Ctrl+C to stop.");

// Run immediately once to start
checkArbitrage();

// Then run on an interval
const intervalId = setInterval(checkArbitrage, CHECK_INTERVAL_MS);

// Basic shutdown handling
process.on('SIGINT', () => {
  console.log("\n🛑 Received SIGINT (Ctrl+C). Shutting down bot...");
  clearInterval(intervalId);
  // Add any other cleanup logic here
  process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Application specific logging, throwing an error, or other logic here
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Application specific logging, throwing an error, or other logic here
  process.exit(1); // Mandatory exit after uncaught exception
});
