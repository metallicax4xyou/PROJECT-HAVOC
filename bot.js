// bot.js - Arbitrum Uniswap V3 Flash Swap Bot with Debugging (v2 - Corrected Loop)

const { ethers } = require("ethers");
require('dotenv').config(); // Make sure to install dotenv: npm install dotenv

// --- Configuration ---
const RPC_URL = process.env.ARBITRUM_RPC_URL; // Your Arbitrum RPC URL (e.g., from Alchemy, Infura)
const PRIVATE_KEY = process.env.PRIVATE_KEY;   // Your deployer/owner private key
const FLASH_SWAP_CONTRACT_ADDRESS = "0x7a00Ec5b64e662425Bbaa0dD78972570C326210f"; // Your deployed FlashSwap contract

// Arbitrum Native USDC / WETH Pools & Tokens
const WETH_ADDRESS = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const USDC_ADDRESS = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"; // Native USDC
const WETH_DECIMALS = 18;
const USDC_DECIMALS = 6;

// Pool Configuration (WETH/USDC - Replace with your actual target pools)
// Pool A: WETH/USDC 0.05% (Example address - VERIFY YOURS)
const POOL_A_ADDRESS = "0xC696D20fd7ac47C89Ea8b8C51065A67B6FFa2067"; // VERIFY THIS - WETH/USDC 0.05%
const POOL_A_FEE_BPS = 500; // 0.05% in basis points
const POOL_A_FEE_PERCENT = 0.05;

// Pool B: WETH/USDC 0.30% (Example address - VERIFY YOURS)
const POOL_B_ADDRESS = "0xc31E54c7a869B9FcBEcc14363CF510d1c41fa441"; // VERIFY THIS - WETH/USDC 0.30%
const POOL_B_FEE_BPS = 3000; // 0.30% in basis points
const POOL_B_FEE_PERCENT = 0.30;

// Uniswap V3 Quoter V2 Address on Arbitrum
const QUOTER_V2_ADDRESS = "0x61fFE014bA17989E743c5F6d790181C0603C3996"; // Common Arbitrum QuoterV2 address

// --- ABIs ---
// Minimal ABI for FlashSwap contract (add more functions if needed)
const FlashSwapABI = [
    "function owner() view returns (address)",
    "function initiateFlashSwap(address _poolAddress, uint256 _amount0, uint256 _amount1, bytes calldata _params) external",
    "event FlashSwapInitiated(address indexed caller, address indexed pool, uint amount0, uint amount1)",
    "event ArbitrageAttempt(address indexed poolA, address indexed poolB, address tokenBorrowed, uint amountBorrowed, uint feePaid)",
    "event SwapExecuted(uint indexed swapNumber, address indexed tokenIn, address indexed tokenOut, uint amountIn, uint amountOut)",
    "event RepaymentSuccess(address indexed token, uint amountRepaid)",
    "event ProfitTransferred(address indexed token, address indexed recipient, uint amount)",
    "event DebugSwapValues(uint amountOutMin1, uint actualAmountIntermediate, uint amountOutMin2, uint actualFinalAmount, uint requiredRepayment)"
];

// Minimal ABI for Uniswap V3 Pool
const IUniswapV3PoolABI = [
    "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
    "function liquidity() external view returns (uint128 liquidity)",
    "function token0() external view returns (address)",
    "function token1() external view returns (address)",
    "function fee() external view returns (uint24)"
];

// Minimal ABI for QuoterV2
const IQuoterV2ABI = [
    "function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceNextX96, uint32 ticksCrossed, uint256 gasEstimate)"
];

// --- Bot Settings ---
const POLLING_INTERVAL_MS = 10000; // Check prices every 10 seconds (adjust as needed)
const PROFIT_THRESHOLD_USD = 0.05; // Minimum USD profit to attempt swap (after estimated gas) - VERY LOW FOR DEBUGGING
const SLIPPAGE_TOLERANCE = 0.001; // 0.1% slippage tolerance (for amountOutMinimum calculation when not debugging)

// --- DEBUGGING STEP 2: Reduce Borrow Amount ---
// Use a very small amount for initial debugging of estimation/simulation
let BORROW_AMOUNT_WETH_WEI = ethers.parseUnits("0.00005", WETH_DECIMALS); // DEBUG: 0.00005 WETH

// --- Initialization ---
if (!RPC_URL || !PRIVATE_KEY) {
    console.error("Error: ARBITRUM_RPC_URL and PRIVATE_KEY must be set in .env file.");
    process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);
const flashSwapContract = new ethers.Contract(FLASH_SWAP_CONTRACT_ADDRESS, FlashSwapABI, signer);
const quoterContract = new ethers.Contract(QUOTER_V2_ADDRESS, IQuoterV2ABI, provider);
const poolAContract = new ethers.Contract(POOL_A_ADDRESS, IUniswapV3PoolABI, provider);
const poolBContract = new ethers.Contract(POOL_B_ADDRESS, IUniswapV3PoolABI, provider);

console.log(`Bot starting...`);
console.log(` - Signer Address: ${signer.address}`);
console.log(` - FlashSwap Contract: ${FLASH_SWAP_CONTRACT_ADDRESS}`);
console.log(` - Monitoring Pools:`);
console.log(`   - Pool A (WETH/USDC ${POOL_A_FEE_PERCENT}%): ${POOL_A_ADDRESS}`);
console.log(`   - Pool B (WETH/USDC ${POOL_B_FEE_PERCENT}%): ${POOL_B_ADDRESS}`);
console.log(` - Debug Borrow Amount: ${ethers.formatUnits(BORROW_AMOUNT_WETH_WEI, WETH_DECIMALS)} WETH`);
console.log(` - Polling Interval: ${POLLING_INTERVAL_MS / 1000} seconds`);
console.log(` - Profit Threshold: $${PROFIT_THRESHOLD_USD} USD (approx, before gas)`);


// --- Helper Functions ---

// Calculate price from sqrtPriceX96 (WETH = T0, USDC = T1) -> Price of WETH in USDC
function calculatePriceFromSqrt(sqrtPriceX96) {
    const priceX96 = BigInt(sqrtPriceX96);
    const twoPow192 = 2n ** 192n;
    // (sqrtPriceX96 / 2^96)^2 = price of token0 in terms of token1
    // Adjust for decimals: price * 10^decimals1 / 10^decimals0
    // Price of WETH in USDC = (sqrtPriceX96^2 / 2^192) * (10^USDC_DECIMALS / 10^WETH_DECIMALS)
    // To avoid floating point issues with large numbers, rearrange:
    // (priceX96 * priceX96 * (10n ** BigInt(USDC_DECIMALS))) / (twoPow192 * (10n ** BigInt(WETH_DECIMALS)))
    // Let's return the raw ratio and format later to preserve precision
    const numerator = priceX96 * priceX96 * (10n ** BigInt(USDC_DECIMALS));
    const denominator = twoPow192 * (10n ** BigInt(WETH_DECIMALS));
    // Return as a float for easy comparison, though precision loss is possible
    return parseFloat(ethers.formatUnits(numerator * (10n**18n) / denominator, 18)); // Scale up for formatUnits, then parse
}


// Simulate swap using QuoterV2 - returns BigInt amountOut
async function simulateSwap(tokenIn, tokenOut, amountInWei, feeBps, quoter) {
    try {
        const params = {
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountInWei,
            fee: feeBps,
            sqrtPriceLimitX96: 0n // No price limit for simulation
        };
        // Use staticCall to simulate
        const quoteResult = await quoter.quoteExactInputSingle.staticCall(params);
        return quoteResult[0]; // amountOut as BigInt
    } catch (error) {
        // Mute warnings during normal operation unless debugging quoter itself
        // console.warn(`Quoter simulation failed: ${error.reason || error.message}`);
        return 0n; // Return 0 if simulation fails (e.g., insufficient liquidity)
    }
}


// --- Core Arbitrage Logic ---

/**
 * Attempts to execute the flash swap arbitrage if an opportunity is detected.
 * Includes detailed debugging steps (liquidity check, staticCall, estimateGas).
 */
async function attemptArbitrage(opportunity) {
    console.log("\n========= Arbitrage Opportunity Detected =========");
    console.log(`  Pool A (${opportunity.poolA.address}, ${opportunity.poolA.feeBps}bps): Price ${opportunity.poolA.price.toFixed(6)} USDC/WETH`);
    console.log(`  Pool B (${opportunity.poolB.address}, ${opportunity.poolB.feeBps}bps): Price ${opportunity.poolB.price.toFixed(6)} USDC/WETH`);
    console.log(`  Direction: Borrow ${opportunity.borrowTokenSymbol} from Pool ${opportunity.startPool === 'A' ? 'A' : 'B'}`);
    console.log(`  Simulated Profit (Before Gas/Fees): ~$${opportunity.estimatedProfitUsd.toFixed(4)} USD`);

    // Determine parameters based on the detected opportunity direction
    let flashLoanPoolAddress;
    let borrowAmount0 = 0n; // WETH amount
    let borrowAmount1 = 0n; // USDC amount
    let tokenBorrowedAddress;
    let tokenIntermediateAddress;
    let poolAForSwap; // Address of pool for Swap 1 in callback
    let poolBForSwap; // Address of pool for Swap 2 in callback
    let feeAForSwap;  // Fee (bps) for Swap 1
    let feeBForSwap;  // Fee (bps) for Swap 2
    let amountToBorrowWei;

    // WETH is Token0, USDC is Token1 in these pools
    if (opportunity.borrowTokenSymbol === 'WETH') {
        tokenBorrowedAddress = WETH_ADDRESS;
        tokenIntermediateAddress = USDC_ADDRESS;
        amountToBorrowWei = BORROW_AMOUNT_WETH_WEI; // Use the small debug amount
        borrowAmount0 = amountToBorrowWei;
        borrowAmount1 = 0n;
        // Determine the flash loan pool and swap path
        if (opportunity.startPool === 'A') { // Borrow from Pool A, first swap on A
            flashLoanPoolAddress = opportunity.poolA.address;
            poolAForSwap = opportunity.poolA.address;
            feeAForSwap = opportunity.poolA.feeBps;
            poolBForSwap = opportunity.poolB.address;
            feeBForSwap = opportunity.poolB.feeBps;
        } else { // Borrow from Pool B, first swap on B
            flashLoanPoolAddress = opportunity.poolB.address;
            poolAForSwap = opportunity.poolB.address;
            feeAForSwap = opportunity.poolB.feeBps;
            poolBForSwap = opportunity.poolA.address;
            feeBForSwap = opportunity.poolA.feeBps;
        }
    } else { // Borrowing USDC
        console.error("Borrowing USDC path not fully implemented yet (needs borrow amount). Exiting attempt.");
        return;
        // You would need to set:
        // BORROW_AMOUNT_USDC_WEI = ethers.parseUnits("YOUR_USDC_AMOUNT", USDC_DECIMALS);
        // tokenBorrowedAddress = USDC_ADDRESS;
        // tokenIntermediateAddress = WETH_ADDRESS;
        // amountToBorrowWei = BORROW_AMOUNT_USDC_WEI;
        // borrowAmount0 = 0n;
        // borrowAmount1 = amountToBorrowWei;
        // Set flashLoanPoolAddress, poolA/BForSwap, feeA/BForSwap based on startPool 'A' or 'B'
    }

    console.log(`  Executing Path: Borrow ${ethers.formatUnits(amountToBorrowWei, tokenBorrowedAddress === WETH_ADDRESS ? WETH_DECIMALS : USDC_DECIMALS)} ${opportunity.borrowTokenSymbol} from ${flashLoanPoolAddress}`);
    console.log(`    -> Swap 1 on ${poolAForSwap} (Fee: ${feeAForSwap}bps)`);
    console.log(`    -> Swap 2 on ${poolBForSwap} (Fee: ${feeBForSwap}bps)`);

    // --- DEBUGGING STEP 3: Log Pool Liquidity and Tick for the FLASH LOAN POOL ---
    try {
        const flashLoanPoolContract = flashLoanPoolAddress === POOL_A_ADDRESS ? poolAContract : poolBContract;
        const [slot0, liquidity] = await Promise.all([
            flashLoanPoolContract.slot0(),
            flashLoanPoolContract.liquidity()
        ]);
        console.log(`  Flash Loan Pool Status (${flashLoanPoolAddress}):`);
        console.log(`    Current Tick: ${slot0.tick}`);
        console.log(`    Active Liquidity: ${liquidity.toString()}`);
        if (liquidity === 0n) {
             console.warn(`    WARNING: Flash loan pool has ZERO active liquidity. Flash loan/swap will likely fail.`);
        } else if (liquidity < 10n**15n) { // Arbitrary low liquidity threshold for warning
             console.warn(`    WARNING: Flash loan pool has very LOW active liquidity (${liquidity.toString()}). Swap simulation might fail.`);
        }
    } catch (err) {
        console.error(`  Error fetching liquidity/tick for pool ${flashLoanPoolAddress}:`, err.message);
    }

    // Construct the ArbitrageParams for the callback
    const arbitrageParams = {
        tokenIntermediate: tokenIntermediateAddress,
        poolA: poolAForSwap,
        poolB: poolBForSwap,
        feeA: feeAForSwap,
        feeB: feeBForSwap,
        // For Debugging: amountOutMinimum = 0 allows simulation even if slippage is high
        // For Production: Calculate based on quoted amounts and SLIPPAGE_TOLERANCE
        amountOutMinimum1: 0n,
        amountOutMinimum2: 0n
    };

    // Encode the params using AbiCoder
    const encodedParams = ethers.AbiCoder.defaultAbiCoder().encode(
        ['tuple(address tokenIntermediate, address poolA, address poolB, uint24 feeA, uint24 feeB, uint amountOutMinimum1, uint amountOutMinimum2)'],
        [arbitrageParams]
    );

    // --- DEBUGGING STEP 4: Log ArbitrageParams ---
    console.log("  Callback Parameters (Decoded):", {
        ...arbitrageParams, // Spread operator for easy logging
        amountOutMinimum1: arbitrageParams.amountOutMinimum1.toString(),
        amountOutMinimum2: arbitrageParams.amountOutMinimum2.toString()
    });
    console.log("  Callback Parameters (Encoded):", encodedParams);

    // Parameters for the initiateFlashSwap function call itself
    const initiateFlashSwapArgs = [
        flashLoanPoolAddress, // _poolAddress
        borrowAmount0,        // _amount0 (WETH)
        borrowAmount1,        // _amount1 (USDC)
        encodedParams         // _params
    ];

    // --- DEBUGGING STEP 1: Add staticCall Simulation ---
    try {
        console.log("  [1/3] Attempting staticCall simulation...");
        await flashSwapContract.initiateFlashSwap.staticCall(
            ...initiateFlashSwapArgs,
             { gasLimit: 3_000_000 } // Provide gas limit for simulation
        );
        console.log("  ✅ [1/3] staticCall successful. Transaction logic appears valid.");

        // --- Proceed to Estimate Gas ---
        console.log("  [2/3] Attempting estimateGas...");
        try {
            const estimatedGas = await flashSwapContract.initiateFlashSwap.estimateGas(
                ...initiateFlashSwapArgs
            );
            const estimatedGasNum = Number(estimatedGas);
            console.log(`  ✅ [2/3] estimateGas successful. Estimated Gas: ${estimatedGasNum}`);

            // --- Optional Gas Cost Estimation ---
            // const feeData = await provider.getFeeData();
            // const gasPrice = feeData.gasPrice || ethers.parseUnits("5", "gwei"); // Fallback
            // const estimatedCostWei = estimatedGas * gasPrice;
            // console.log(`  Est. Gas Cost: ~${ethers.formatEther(estimatedCostWei)} ETH`);

            // --- FINAL STEP: SEND TRANSACTION (Commented Out for Debugging) ---
            console.log("  [3/3] Conditions met for sending transaction (Execution Disabled).");
            /*
            try {
                 console.log("  >>> SENDING TRANSACTION <<<");
                 const tx = await flashSwapContract.initiateFlashSwap(...initiateFlashSwapArgs, {
                     gasLimit: estimatedGas + BigInt(60000), // Add buffer
                     // Use EIP-1559 gas settings if available from feeData
                     // maxFeePerGas: feeData.maxFeePerGas,
                     // maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
                     // Or fallback to legacy gasPrice
                     // gasPrice: gasPrice
                 });
                 console.log(`  Transaction Sent: ${tx.hash}`);
                 console.log("  Waiting for receipt...");
                 const receipt = await tx.wait(1);
                 console.log(`  Transaction Mined! Status: ${receipt.status === 1 ? "Success ✅" : "Failed ❌"}`);
                 if (receipt.status === 1) {
                     // TODO: Parse receipt.logs for ProfitTransferred event
                     console.log("  >> PARSE LOGS FOR PROFIT <<");
                 }
             } catch (sendError) {
                 console.error(`  ❌ [3/3] FAILED TO SEND TRANSACTION:`, sendError);
             }
            */

        } catch (gasError) {
            console.error(`  ❌ [2/3] estimateGas failed:`);
            if (gasError.reason) {
                 console.error(`      Reason: ${gasError.reason}`);
            } else if (gasError.error?.data) {
                 console.error(`      Revert Data: ${gasError.error.data}`);
            } else {
                 console.error("      Full Error:", gasError);
            }
            console.log("      Transaction NOT sent due to gas estimation failure.");
        } // End estimateGas try/catch

    } catch (staticCallError) {
        console.error(`  ❌ [1/3] staticCall failed:`);
        if (staticCallError.reason) {
             console.error(`      Reason: ${staticCallError.reason}`); // This is where "Swap 1 execution failed" should appear
         } else if (staticCallError.error?.data) {
              console.error(`      Revert Data: ${staticCallError.error.data}`);
         } else {
             console.error("      Full Error:", staticCallError);
         }
        console.log("      Transaction NOT attempted due to staticCall failure.");
    } // End staticCall try/catch

    console.log("========= Arbitrage Attempt Complete =========");
} // End attemptArbitrage function


// --- Main Monitoring Loop ---
async function monitorPools() {
    console.log(`\n${new Date().toISOString()} - Checking for opportunities...`);

    try {
        // Fetch current prices using Quoter V2 for better accuracy
        // We simulate swapping a small amount of WETH for USDC in both pools
        const simulateAmountWeth = ethers.parseUnits("0.1", WETH_DECIMALS); // 0.1 WETH for price check

        const [amountOutA, amountOutB] = await Promise.all([
            simulateSwap(WETH_ADDRESS, USDC_ADDRESS, simulateAmountWeth, POOL_A_FEE_BPS, quoterContract),
            simulateSwap(WETH_ADDRESS, USDC_ADDRESS, simulateAmountWeth, POOL_B_FEE_BPS, quoterContract)
        ]);

        if (amountOutA === 0n || amountOutB === 0n) {
             console.log("  Failed to get valid quotes for one or both pools (likely low liquidity). Skipping cycle.");
             return; // Exit check if prices can't be determined
        }

        // Calculate effective price: USDC received per 1 WETH
        const priceA = parseFloat(ethers.formatUnits(amountOutA, USDC_DECIMALS)) / 0.1;
        const priceB = parseFloat(ethers.formatUnits(amountOutB, USDC_DECIMALS)) / 0.1;

        console.log(`  Pool A Price (USDC/WETH): ${priceA.toFixed(6)}`);
        console.log(`  Pool B Price (USDC/WETH): ${priceB.toFixed(6)}`);

        let opportunity = null;
        let estimatedProfitUsd = 0; // Very rough estimate based on price diff * debug borrow amount

        // Opportunity exists if prices differ significantly
        if (Math.abs(priceA - priceB) / Math.max(priceA, priceB) > 0.0001) { // Tiny threshold for difference detection

             if (priceA > priceB) {
                 // Price is higher on Pool A. Strategy: Sell WETH on A, Buy WETH on B.
                 // Path: Borrow WETH from A, Swap A (WETH->USDC), Swap B (USDC->WETH), Repay A.
                 estimatedProfitUsd = (priceA - priceB) * parseFloat(ethers.formatUnits(BORROW_AMOUNT_WETH_WEI, WETH_DECIMALS));
                 opportunity = {
                     poolA: { address: POOL_A_ADDRESS, feeBps: POOL_A_FEE_BPS, price: priceA },
                     poolB: { address: POOL_B_ADDRESS, feeBps: POOL_B_FEE_BPS, price: priceB },
                     startPool: "A", // Borrow from the pool where we sell WETH (higher price)
                     borrowTokenSymbol: "WETH",
                     estimatedProfitUsd: estimatedProfitUsd // NOTE: Needs refinement with fees/gas
                 };
                 console.log(`  Potential Opportunity: Sell WETH on A ($${priceA.toFixed(4)}), Buy on B ($${priceB.toFixed(4)})`);

            } else {
                 // Price is higher on Pool B. Strategy: Sell WETH on B, Buy WETH on A.
                 // Path: Borrow WETH from B, Swap B (WETH->USDC), Swap A (USDC->WETH), Repay B.
                 estimatedProfitUsd = (priceB - priceA) * parseFloat(ethers.formatUnits(BORROW_AMOUNT_WETH_WEI, WETH_DECIMALS));
                 opportunity = {
                     poolA: { address: POOL_A_ADDRESS, feeBps: POOL_A_FEE_BPS, price: priceA },
                     poolB: { address: POOL_B_ADDRESS, feeBps: POOL_B_FEE_BPS, price: priceB },
                     startPool: "A", // Borrow from the pool where we sell WETH (higher price)
                     borrowTokenSymbol: "WETH",
                     estimatedProfitUsd: estimatedProfitUsd // NOTE: Needs refinement with fees/gas
                 };
                 console.log(`  Potential Opportunity: Sell WETH on A ($${priceA.toFixed(4)}), Buy on B ($${priceB.toFixed(4)})`);

            } else {
                 // Price is higher on Pool B. Strategy: Sell WETH on B, Buy WETH on A.
                 // Path: Borrow WETH from B, Swap B (WETH->USDC), Swap A (USDC->WETH), Repay B.
                 estimatedProfitUsd = (priceB - priceA) * parseFloat(ethers.formatUnits(BORROW_AMOUNT_WETH_WEI, WETH_DECIMALS));
                 opportunity = {
                     poolA: { address: POOL_A_ADDRESS, feeBps: POOL_A_FEE_BPS, price: priceA },
                     poolB: { address: POOL_B_ADDRESS, feeBps: POOL_B_FEE_BPS, price: priceB },
                     startPool: "B", // Borrow from the pool where we sell WETH (higher price)
                     borrowTokenSymbol: "WETH",
                     estimatedProfitUsd: estimatedProfitUsd // NOTE: Needs refinement with fees/gas
                 };
                  console.log(`  Potential Opportunity: Sell WETH on B ($${priceB.toFixed(4)}), Buy on A ($${priceA.toFixed(4)})`);
            }

                // Check if rough estimated profit exceeds threshold (needs accurate gas cost later)
            if (estimatedProfitUsd > PROFIT_THRESHOLD_USD) {
                await attemptArbitrage(opportunity);
            } else {
                console.log(`  Price difference detected, but estimated profit ($${estimatedProfitUsd.toFixed(4)}) below threshold ($${PROFIT_THRESHOLD_USD}).`);
            }
        } else {
            console.log("  No significant price difference detected.");
        }

    } catch (error) {
        console.error(`${new Date().toISOString()} - Error in monitoring loop:`, error);
    } finally {
        // --- Schedule the next check ---
        // Moved the setTimeout inside the main IIFE after the first call
    }
} // End monitorPools function

// --- Start the Bot ---
(async () => {
    try {
        // Initial check if owner matches signer
        const contractOwner = await flashSwapContract.owner();
        if (contractOwner.toLowerCase()
!== signer.address.toLowerCase()) {
            console.warn(`\nWarning: Signer address (${signer.address}) does not match the FlashSwap contract owner (${contractOwner}). 'onlyOwner' calls will fail.\n`);
        } else {
            console.log(`Signer matches contract owner. 'onlyOwner' calls should succeed.\n`);
        }

        // Perform the first check immediately
        await monitorPools();

        // --- Start the recurring checks using setInterval ---
        setInterval(monitorPools, POLLING_INTERVAL_MS);
        console.log(`\nMonitoring started. Will check every ${POLLING_INTERVAL_MS / 1000}
seconds.`);


    } catch (initError) {
        console.error("Initialization Error:", initError);
        process.exit(1);
    }
})();
