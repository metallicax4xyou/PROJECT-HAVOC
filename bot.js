// bot.js
// Monitors Uniswap V3 pools on Arbitrum for arbitrage opportunities.
// WARNING: Experimental, placeholder simulation/gas logic. Use with caution.

require("dotenv").config();
const { ethers } = require("ethers");

// =========================================================================
// == Configuration & Constants ==
// =========================================================================

const RPC_URL = process.env.ARBITRUM_RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// Ensure required environment variables are set
if (!RPC_URL || !PRIVATE_KEY) {
    console.error("❌ Missing ARBITRUM_RPC_URL or PRIVATE_KEY in .env file. Exiting.");
    process.exit(1);
}

// Use ethers.getAddress() to ensure correct checksum for all addresses
// !! Replace with YOUR deployed FlashSwap contract address !!
const FLASH_SWAP_CONTRACT_ADDRESS = ethers.getAddress("0x3f7A3f4bb9DCE54684D06060bF4491544Ee4Dba5");

// Arbitrum One Addresses
const WETH_ADDRESS = ethers.getAddress("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1");
const USDC_ADDRESS = ethers.getAddress("0xaf88d065e77c8cC2239327C5EDb3A432268e5831");
const POOL_WETH_USDC_005 = ethers.getAddress("0xC31E54c7a869B9FcBEcc14363CF510d1c41fa443");
const POOL_WETH_USDC_030 = ethers.getAddress("0x17c14d2c404d167802b16c450d3c99f88f2c4f4d"); // Lowercase works fine here

// Token Decimals
const WETH_DECIMALS = 18;
const USDC_DECIMALS = 6;

// Bot Configuration
const CHECK_INTERVAL_MS = 15000; // Check every 15 seconds
const MIN_PROFIT_THRESHOLD_WETH = ethers.parseUnits("0.00001", WETH_DECIMALS); // Min profit target
const SLIPPAGE_TOLERANCE = 0.001; // 0.1% slippage tolerance for amountOutMinimum
const BORROW_AMOUNT_WETH = ethers.parseUnits("0.01", WETH_DECIMALS); // Amount of WETH to borrow

// --- ABIs --- (Keep these definitions)
const UNISWAP_V3_POOL_ABI = [
    "function token0() external view returns (address)",
    "function token1() external view returns (address)",
    "function fee() external view returns (uint24)",
    "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)"
];
const FLASH_SWAP_ABI = [
    "function initiateFlashSwap(address _poolAddress, uint256 _amount0, uint256 _amount1, bytes calldata _params) external",
    "event FlashSwapInitiated(address indexed caller, address indexed pool, uint256 amount0, uint256 amount1)",
    "event ArbitrageAttempt(address indexed poolA, address indexed poolB, address tokenBorrowed, uint256 amountBorrowed)",
    "event SwapExecuted(uint256 indexed swapNumber, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut)",
    "event RepaymentSuccess(address indexed token, uint256 amountRepaid)"
];

// =========================================================================
// == Ethers Setup ==
// =========================================================================

const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);

// --- Contract Instances ---
const flashSwapContract = new ethers.Contract(FLASH_SWAP_CONTRACT_ADDRESS, FLASH_SWAP_ABI, signer);
const pool005 = new ethers.Contract(POOL_WETH_USDC_005, UNISWAP_V3_POOL_ABI, provider);
const pool030 = new ethers.Contract(POOL_WETH_USDC_030, UNISWAP_V3_POOL_ABI, provider);


console.log(`🤖 Bot Initialized.`);
console.log(`   Network: Arbitrum One (connected via RPC)`);
console.log(`   Executor Address: ${signer.address}`);
console.log(`   FlashSwap Contract: ${FLASH_SWAP_CONTRACT_ADDRESS}`);

// =========================================================================
// == Helper Functions ==
// =========================================================================

/**
 * Calculates the price of token1 in terms of token0 from sqrtPriceX96.
 */
function sqrtPriceX96ToPrice(sqrtPriceX96, decimals0, decimals1) {
    const Q96 = 2n**96n;
    const priceRatio = (Number(sqrtPriceX96) / Number(Q96)) ** 2;
    const decimalAdjustment = 10**(decimals0 - decimals1);
    return priceRatio * decimalAdjustment;
}

// =========================================================================
// == Main Arbitrage Logic ==
// =========================================================================

/**
 * Checks for arbitrage opportunities and executes if profitable.
 */
async function checkArbitrage() {
    // Now the constants POOL_WETH_USDC_005 and POOL_WETH_USDC_030 are definitely defined before this line is reached.
    console.log(`\n[${new Date().toISOString()}] Checking for arbitrage: ${POOL_WETH_USDC_005} vs ${POOL_WETH_USDC_030}`);

    try {
        // 1. Get Current Pool Data
        const [slot0_005, slot0_030, token0_pool005, token1_pool005] = await Promise.all([
             pool005.slot0(),
             pool030.slot0(),
             pool005.token0(),
             pool005.token1()
        ]);

        const sqrtPriceX96_005 = slot0_005.sqrtPriceX96;
        const sqrtPriceX96_030 = slot0_030.sqrtPriceX96;

        // --- Determine Actual Token Order and Decimals ---
        let token0Address, token1Address, decimals0, decimals1;
        if (token0_pool005.toLowerCase() === WETH_ADDRESS.toLowerCase()) {
            // console.log("   Token Order: WETH (Token0) / USDC (Token1)"); // Reduce noise
            token0Address = WETH_ADDRESS; decimals0 = WETH_DECIMALS;
            token1Address = USDC_ADDRESS; decimals1 = USDC_DECIMALS;
            if (token1_pool005.toLowerCase() !== USDC_ADDRESS.toLowerCase()) {
                 console.error(`❌ Mismatched token1! Expected ${USDC_ADDRESS}, got ${token1_pool005}. Aborting.`); return;
            }
        } else if (token0_pool005.toLowerCase() === USDC_ADDRESS.toLowerCase()) {
            // console.log("   Token Order: USDC (Token0) / WETH (Token1)"); // Reduce noise
            token0Address = USDC_ADDRESS; decimals0 = USDC_DECIMALS;
            token1Address = WETH_ADDRESS; decimals1 = WETH_DECIMALS;
             if (token1_pool005.toLowerCase() !== WETH_ADDRESS.toLowerCase()) {
                 console.error(`❌ Mismatched token1! Expected ${WETH_ADDRESS}, got ${token1_pool005}. Aborting.`); return;
             }
        } else {
             console.error(`❌ Unexpected token0 ${token0_pool005} in Pool ${POOL_WETH_USDC_005}. Aborting.`); return;
        }

        // 2. Calculate Prices (Price = Token1 / Token0 = USDC / WETH)
        const price_005 = sqrtPriceX96ToPrice(sqrtPriceX96_005, decimals0, decimals1);
        const price_030 = sqrtPriceX96ToPrice(sqrtPriceX96_030, decimals0, decimals1);

        console.log(`   Pool 0.05% Price (USDC/WETH): ${price_005.toFixed(decimals1)}`);
        console.log(`   Pool 0.30% Price (USDC/WETH): ${price_030.toFixed(decimals1)}`);
        const priceDiffPercent = Math.abs(price_005 - price_030) / Math.min(price_005, price_030) * 100;
        // console.log(`   Price Difference: ${priceDiffPercent.toFixed(4)}%`); // Reduce noise


        // 3. Identify Potential Arbitrage Direction & Parameters
        // Strategy: Borrow WETH (token0), Sell WETH->USDC (Pool A=higher price), Buy WETH<-USDC (Pool B=lower price), Repay WETH
        const BORROW_TOKEN = WETH_ADDRESS; // Borrowing WETH (Token0)
        const INTERMEDIATE_TOKEN = USDC_ADDRESS; // Swapping through USDC (Token1)

        let poolA, feeA, poolB, feeB, loanPool;
        if (price_030 > price_005) { // Sell WETH where price (USDC/WETH) is higher (Pool 0.30)
            poolA = POOL_WETH_USDC_030; feeA = 3000;
            poolB = POOL_WETH_USDC_005; feeB = 500;
            loanPool = poolA;
        } else if (price_005 > price_030) { // Sell WETH where price is higher (Pool 0.05)
            poolA = POOL_WETH_USDC_005; feeA = 500;
            poolB = POOL_WETH_USDC_030; feeB = 3000;
            loanPool = poolA;
        } else {
             // console.log(`   Prices are equal or too close. No arbitrage opportunity.`);
             return;
        }
        // console.log(`   Potential Path: Borrow WETH(0) from ${loanPool}, Sell WETH(0)->USDC(1)@${feeA/10000}%, Buy WETH(0)<-USDC(1)@${feeB/10000}%`);


        // 4. Calculate Expected Output & Profitability (CRITICAL TODO)
        const amountToBorrow = BORROW_AMOUNT_WETH;
        // console.log(`   Simulating borrow of ${ethers.formatUnits(amountToBorrow, WETH_DECIMALS)} WETH (Token0)...`); // Reduce noise

        // --- !! Placeholder Simulation - Needs replacing & REVERSING !! ---
        const expectedIntermediateFromSwap1 = ethers.parseUnits("35.0", USDC_DECIMALS); // Placeholder USDC amount
        const expectedFinalFromSwap2 = ethers.parseUnits("0.01005", WETH_DECIMALS); // Placeholder WETH amount

        const loanPoolFeeTier = feeA;
        const flashLoanFee = (amountToBorrow * BigInt(loanPoolFeeTier)) / 1000000n;
        const totalAmountToRepay = amountToBorrow + flashLoanFee;
        const potentialProfitWeth = expectedFinalFromSwap2 - totalAmountToRepay;

        // console.log(`   Expected USDC(1) (Swap 1): ${ethers.formatUnits(expectedIntermediateFromSwap1, USDC_DECIMALS)}`); // Reduce noise
        // console.log(`   Expected WETH(0) (Swap 2): ${ethers.formatUnits(expectedFinalFromSwap2, WETH_DECIMALS)}`);
        // console.log(`   Flash Loan Fee (WETH(0)): ${ethers.formatUnits(flashLoanFee, WETH_DECIMALS)}`);
        // console.log(`   Total WETH(0) to Repay: ${ethers.formatUnits(totalAmountToRepay, WETH_DECIMALS)}`);
        // console.log(`   Potential Profit (WETH(0), before gas): ${ethers.formatUnits(potentialProfitWeth, WETH_DECIMALS)}`);


        // 5. Estimate Gas Cost (CRITICAL TODO)
        // TODO: Implement reliable gas estimation
        const estimatedGasCostWei = ethers.parseUnits("0.0001", "ether"); // FIXME: HARDCODED ESTIMATE
        const estimatedGasCostWeth = estimatedGasCostWei;
        // console.log(`   Estimated Gas Cost (WETH): ${ethers.formatUnits(estimatedGasCostWeth, WETH_DECIMALS)}`); // Reduce noise


        // 6. Check Profitability (After Gas)
        const netProfitWeth = potentialProfitWeth - estimatedGasCostWeth;
        // console.log(`   Net Profit (WETH, after estimated gas): ${ethers.formatUnits(netProfitWeth, WETH_DECIMALS)}`); // Reduce noise

        if (netProfitWeth > MIN_PROFIT_THRESHOLD_WETH) {
            console.log(`✅ PROFITABLE OPPORTUNITY! Price Diff: ${priceDiffPercent.toFixed(4)}%, Est. Net Profit: ${ethers.formatUnits(netProfitWeth, WETH_DECIMALS)} WETH`);
            console.log(`   Path: Borrow WETH(0) from ${loanPool}, Sell WETH(0)->USDC(1)@${feeA/10000}%, Buy WETH(0)<-USDC(1)@${feeB/10000}%`);

            // 7. Construct Arbitrage Parameters
            // TODO: Calculate amountOutMinimum based on REAL simulation results minus slippage
            const amountOutMinimum1 = expectedIntermediateFromSwap1 * BigInt(Math.floor((1 - SLIPPAGE_TOLERANCE) * 10000)) / 10000n; // Min USDC(1)
            const requiredRepaymentThreshold = totalAmountToRepay + MIN_PROFIT_THRESHOLD_WETH;
            const amountOutMinimum2 = requiredRepaymentThreshold * BigInt(Math.floor((1 - SLIPPAGE_TOLERANCE) * 10000)) / 10000n; // Min WETH(0)

            // console.log(`   Setting amountOutMinimum1 (USDC(1)): ${ethers.formatUnits(amountOutMinimum1, USDC_DECIMALS)}`);
            // console.log(`   Setting amountOutMinimum2 (WETH(0)): ${ethers.formatUnits(amountOutMinimum2, WETH_DECIMALS)}`);

            const arbitrageParams = ethers.AbiCoder.defaultAbiCoder().encode(
                ['address', 'address', 'address', 'uint24', 'uint24', 'uint256', 'uint256'],
                [INTERMEDIATE_TOKEN, poolA, poolB, feeA, feeB, amountOutMinimum1, amountOutMinimum2]
            );

            // Determine amount0/amount1 based on BORROW_TOKEN (WETH) which is token0
            let amount0 = 0n; let amount1 = 0n;
            if (BORROW_TOKEN.toLowerCase() === token0Address.toLowerCase()) { // WETH is token0
                 amount0 = amountToBorrow;
            } else {
                 console.error("Error: Borrowing WETH logic assumes it's token0 for this pair."); return;
            }

            // 8. Execute Flash Swap Transaction
            console.log(`   Executing initiateFlashSwap... Amount0: ${ethers.formatUnits(amount0, WETH_DECIMALS)} WETH(0)`);
            console.warn("   !!! EXECUTING TRANSACTION WITH HARDCODED SIMULATION & GAS !!!");

            try {
                // TODO: Add dynamic gas estimation result here
                const tx = await flashSwapContract.initiateFlashSwap( loanPool, amount0, amount1, arbitrageParams );
                console.log(`   ✅ Transaction Sent: ${tx.hash}`);
                console.log(`   ⏳ Waiting for confirmation...`);
                const receipt = await tx.wait(1);
                console.log(`   ✅ Transaction Confirmed! Block: ${receipt.blockNumber}, Gas Used: ${receipt.gasUsed.toString()}`);

            } catch (executionError) {
                 console.error(`   ❌ Flash Swap Transaction Failed: ${executionError.message}`);
                 if (executionError.data && executionError.data !== '0x') {
                    try {
                        const decodedError = flashSwapContract.interface.parseError(executionError.data);
                        console.error(`   Contract Revert Reason: ${decodedError?.name}${decodedError?.args ? `(${decodedError.args})` : '()'}`);
                    } catch (decodeErr) { console.error("   Error data decoding failed:", decodeErr.message); }
                 } else if (executionError.transactionHash) {
                    console.error("   Transaction Hash:", executionError.transactionHash);
                 }
            }

        } else {
            // Log only if difference was notable but not profitable enough
             if (priceDiffPercent > 0.01) { // Example threshold: log if diff > 0.01%
                  console.log(`   Opportunity found but below profit threshold. Est. Net: ${ethers.formatUnits(netProfitWeth, WETH_DECIMALS)} WETH`);
             }
            // console.log("   No profitable opportunity found this cycle."); // Reduce noise
        }

    } catch (error) {
        console.error(`❌ Error during arbitrage check cycle: ${error.message}`);
        // console.error(error); // Uncomment for full error object if needed
    }
}

// =========================================================================
// == Bot Execution ==
// =========================================================================

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
  process.exit(0);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});
