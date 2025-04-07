// bot.js - Arbitrum Uniswap V3 Flash Swap Bot with Debugging (v10 - Corrected Pool Addr & Logs)

const { ethers } = require("ethers");
require('dotenv').config();

// --- Configuration ---
const RPC_URL = process.env.ARBITRUM_RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// Use getAddress for verified/standard addresses
const FLASH_SWAP_CONTRACT_ADDRESS = ethers.getAddress("0x7a00Ec5b64e662425Bbaa0dD78972570C326210f");
const WETH_ADDRESS = ethers.getAddress("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1");
const USDC_ADDRESS = ethers.getAddress("0xaf88d065e77c8cC2239327C5EDb3A432268e5831"); // Native USDC

// Use lowercase for Quoter address to bypass potential checksum issues if copied incorrectly
const QUOTER_V2_ADDRESS = "0x61ffe014ba17989e743c5f6d790181c0603c3996"; // Lowercase

// --- CORRECTED POOL ADDRESSES AND FEES (Verified 07 Apr 2025 - WETH/Native USDC) ---
// Pool A: WETH/USDC 0.05%
const POOL_A_ADDRESS = "0xc31e54c7a869b9fcbecc14363cf510d1c41fa441"; // Lowercase (0.05% pool)
const POOL_A_FEE_BPS = 500;
const POOL_A_FEE_PERCENT = 0.05;

// Pool B: WETH/USDC 0.30%
const POOL_B_ADDRESS = "0x17c14d2c404d167802b16c450d3c99f88f2c4f4d"; // Lowercase (0.30% pool)
const POOL_B_FEE_BPS = 3000;
const POOL_B_FEE_PERCENT = 0.30;

const WETH_DECIMALS = 18;
const USDC_DECIMALS = 6;

// --- ABIs ---
// Ensure these ABIs match the contracts you are interacting with
const FlashSwapABI = [
    "function owner() view returns (address)",
    "function initiateFlashSwap(address _poolAddress, uint256 _amount0, uint256 _amount1, bytes calldata _params) external",
    // Add necessary events if parsing receipts later
    "event ProfitTransferred(address indexed token, address indexed recipient, uint amount)"
];
const IUniswapV3PoolABI = [
    "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
    "function liquidity() external view returns (uint128 liquidity)",
    "function token0() external view returns (address)",
    "function token1() external view returns (address)",
    "function fee() external view returns (uint24)"
];
const IQuoterV2ABI = [
    "function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceNextX96, uint32 ticksCrossed, uint256 gasEstimate)"
];

// --- Bot Settings ---
const POLLING_INTERVAL_MS = 10000; // Check prices every 10 seconds
const PROFIT_THRESHOLD_USD = 0.05; // Very low for debugging
let BORROW_AMOUNT_WETH_WEI = ethers.parseUnits("0.00005", WETH_DECIMALS); // DEBUG amount

// --- Initialization ---
if (!RPC_URL || !PRIVATE_KEY) { console.error("ENV VAR MISSING"); process.exit(1); }
const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);
const flashSwapContract = new ethers.Contract(FLASH_SWAP_CONTRACT_ADDRESS, FlashSwapABI, signer);
const quoterContract = new ethers.Contract(QUOTER_V2_ADDRESS, IQuoterV2ABI, provider);
// Create contracts with corrected lowercase addresses
const poolAContract = new ethers.Contract(POOL_A_ADDRESS, IUniswapV3PoolABI, provider);
const poolBContract = new ethers.Contract(POOL_B_ADDRESS, IUniswapV3PoolABI, provider);

// --- Initial Logs ---
console.log(`Bot starting...`);
console.log(` - Signer Address: ${signer.address}`);
console.log(` - FlashSwap Contract: ${FLASH_SWAP_CONTRACT_ADDRESS}`);
console.log(` - Quoter V2 Contract: ${QUOTER_V2_ADDRESS}`);
console.log(` - Monitoring Pools:`);
console.log(`   - Pool A (WETH/USDC ${POOL_A_FEE_PERCENT}%): ${POOL_A_ADDRESS}`); // Corrected 0.05%
console.log(`   - Pool B (WETH/USDC ${POOL_B_FEE_PERCENT}%): ${POOL_B_ADDRESS}`); // Corrected 0.30%
console.log(` - Debug Borrow Amount: ${ethers.formatUnits(BORROW_AMOUNT_WETH_WEI, WETH_DECIMALS)} WETH`);
console.log(` - Polling Interval: ${POLLING_INTERVAL_MS / 1000} seconds`);
console.log(` - Profit Threshold: $${PROFIT_THRESHOLD_USD} USD (approx, before gas)`);

// --- Helper Functions ---

// Simulate swap using QuoterV2 - includes error logging
async function simulateSwap(poolDesc, tokenIn, tokenOut, amountInWei, feeBps, quoter) {
    try {
        const params = {
            tokenIn: tokenIn,       // Expects checksummed address
            tokenOut: tokenOut,     // Expects checksummed address
            amountIn: amountInWei,
            fee: feeBps,
            sqrtPriceLimitX96: 0n
        };
        const quoteResult = await quoter.quoteExactInputSingle.staticCall(params);
        return quoteResult[0];
    } catch (error) {
        console.warn(`Quoter simulation failed for ${poolDesc} (Fee: ${feeBps}bps): ${error.reason || error.message || error}`);
        return 0n;
    }
}

// Attempt arbitrage execution - includes staticCall and estimateGas
async function attemptArbitrage(opportunity) {
    console.log("\n========= Arbitrage Opportunity Detected =========");
    console.log(`  Pool A (${opportunity.poolA.address}, ${opportunity.poolA.feeBps}bps): Price ${opportunity.poolA.price.toFixed(6)} USDC/WETH`);
    console.log(`  Pool B (${opportunity.poolB.address}, ${opportunity.poolB.feeBps}bps): Price ${opportunity.poolB.price.toFixed(6)} USDC/WETH`);
    console.log(`  Direction: Borrow ${opportunity.borrowTokenSymbol} from Pool ${opportunity.startPool === 'A' ? 'A' : 'B'}`);
    console.log(`  Simulated Profit (Before Gas/Fees): ~$${opportunity.estimatedProfitUsd.toFixed(4)} USD`);

    // Determine parameters
    let flashLoanPoolAddress;
    let borrowAmount0 = 0n; let borrowAmount1 = 0n;
    let tokenBorrowedAddress; let tokenIntermediateAddress;
    let poolAForSwap; let poolBForSwap;
    let feeAForSwap; let feeBForSwap;
    let amountToBorrowWei;

    if (opportunity.borrowTokenSymbol === 'WETH') {
        tokenBorrowedAddress = WETH_ADDRESS; // Checksummed
        tokenIntermediateAddress = USDC_ADDRESS; // Checksummed
        amountToBorrowWei = BORROW_AMOUNT_WETH_WEI;
        borrowAmount0 = amountToBorrowWei;
        borrowAmount1 = 0n;
        if (opportunity.startPool === 'A') { // Borrow from A (0.05%), Swap A -> B
            flashLoanPoolAddress = opportunity.poolA.address; // Lowercase ok
            poolAForSwap = opportunity.poolA.address; // Lowercase ok
            feeAForSwap = opportunity.poolA.feeBps;
            poolBForSwap = opportunity.poolB.address; // Lowercase ok
            feeBForSwap = opportunity.poolB.feeBps;
        } else { // Borrow from B (0.30%), Swap B -> A
            flashLoanPoolAddress = opportunity.poolB.address; // Lowercase ok
            poolAForSwap = opportunity.poolB.address; // Lowercase ok
            feeAForSwap = opportunity.poolB.feeBps;
            poolBForSwap = opportunity.poolA.address; // Lowercase ok
            feeBForSwap = opportunity.poolA.feeBps;
        }
    } else { /* USDC Borrow logic not implemented */ console.error("USDC Borrow NYI"); return; }

    console.log(`  Executing Path: Borrow ${ethers.formatUnits(amountToBorrowWei, tokenBorrowedAddress === WETH_ADDRESS ? WETH_DECIMALS : USDC_DECIMALS)} ${opportunity.borrowTokenSymbol} from ${flashLoanPoolAddress}`);
    console.log(`    -> Swap 1 on ${poolAForSwap} (Fee: ${feeAForSwap}bps)`);
    console.log(`    -> Swap 2 on ${poolBForSwap} (Fee: ${feeBForSwap}bps)`);

    // --- Check Flash Loan Pool State ---
    try {
        const flashLoanPoolContract = flashLoanPoolAddress.toLowerCase() === POOL_A_ADDRESS.toLowerCase() ? poolAContract : poolBContract;
        const [slot0, liquidity] = await Promise.all([ flashLoanPoolContract.slot0(), flashLoanPoolContract.liquidity() ]);
        console.log(`  Flash Loan Pool Status (${flashLoanPoolAddress}):`);
        console.log(`    Current Tick: ${slot0.tick}, Liquidity: ${liquidity.toString()}`);
        if (liquidity === 0n) console.warn(`    WARNING: Flash loan pool has ZERO active liquidity!`);
    } catch (err) { console.error(`  Error fetching state for pool ${flashLoanPoolAddress}:`, err.message); }

    // --- Construct Callback Params ---
    const arbitrageParams = {
        tokenIntermediate: tokenIntermediateAddress, // Checksummed
        poolA: poolAForSwap, // Lowercase OK
        poolB: poolBForSwap, // Lowercase OK
        feeA: feeAForSwap,
        feeB: feeBForSwap,
        amountOutMinimum1: 0n, // Debugging
        amountOutMinimum2: 0n  // Debugging
    };
    const encodedParams = ethers.AbiCoder.defaultAbiCoder().encode(
        ['tuple(address tokenIntermediate, address poolA, address poolB, uint24 feeA, uint24 feeB, uint amountOutMinimum1, uint amountOutMinimum2)'],
        [arbitrageParams]
    );
    console.log("  Callback Parameters (Decoded):", { /* ... logging ... */ }); // Add details if needed
    console.log("  Callback Parameters (Encoded):", encodedParams);

    // --- initiateFlashSwap Args ---
    const initiateFlashSwapArgs = [ flashLoanPoolAddress, borrowAmount0, borrowAmount1, encodedParams ];

    // --- Simulation & Estimation ---
    try {
        console.log("  [1/3] Attempting staticCall simulation...");
        await flashSwapContract.initiateFlashSwap.staticCall( ...initiateFlashSwapArgs, { gasLimit: 3_000_000 });
        console.log("  ✅ [1/3] staticCall successful.");

        console.log("  [2/3] Attempting estimateGas...");
        try {
            const estimatedGas = await flashSwapContract.initiateFlashSwap.estimateGas(...initiateFlashSwapArgs);
            console.log(`  ✅ [2/3] estimateGas successful. Estimated Gas: ${Number(estimatedGas)}`);
            console.log("  [3/3] Conditions met for sending transaction (Execution Disabled).");
            // --- TX SENDING CODE (COMMENTED) ---
            /*
            const tx = await flashSwapContract.initiateFlashSwap(...initiateFlashSwapArgs, { gasLimit: ..., gasPrice: ... });
            ... wait for receipt ...
            */
        } catch (gasError) {
            console.error(`  ❌ [2/3] estimateGas failed:`, gasError.reason || gasError.message || gasError);
        }
    } catch (staticCallError) {
        console.error(`  ❌ [1/3] staticCall failed:`, staticCallError.reason || staticCallError.message || staticCallError);
         if (staticCallError.data) console.error(`     Revert Data: ${staticCallError.data}`); // Log revert data if present
    }
    console.log("========= Arbitrage Attempt Complete =========");
} // End attemptArbitrage

// --- Main Monitoring Loop ---
async function monitorPools() {
    console.log(`\n[Monitor] START - ${new Date().toISOString()}`);
    try {
        console.log("  [Monitor] Fetching pool states...");
        console.log(`  [Monitor] Calling Promise.all for pool states... (A: ${POOL_A_ADDRESS}, B: ${POOL_B_ADDRESS})`);
        const poolStatePromises = [
            poolAContract.slot0().catch(e => { console.error(`[Monitor] Error fetching slot0 for Pool A (${POOL_A_ADDRESS}): ${e.message}`); return null; }),
            poolAContract.liquidity().catch(e => { console.error(`[Monitor] Error fetching liquidity for Pool A (${POOL_A_ADDRESS}): ${e.message}`); return null; }),
            poolBContract.slot0().catch(e => { console.error(`[Monitor] Error fetching slot0 for Pool B (${POOL_B_ADDRESS}): ${e.message}`); return null; }),
            poolBContract.liquidity().catch(e => { console.error(`[Monitor] Error fetching liquidity for Pool B (${POOL_B_ADDRESS}): ${e.message}`); return null; })
        ];
        const [slotA, liqA, slotB, liqB] = await Promise.all(poolStatePromises);
        console.log("  [Monitor] Promise.all for pool states resolved.");

        let poolAStateFetched = false; let poolBStateFetched = false;
        if (slotA && liqA !== null) {
             console.log(`  [Monitor] Pool A State: Tick=${slotA.tick}, Liquidity=${liqA.toString()}`);
             if (liqA === 0n) console.warn("    [Monitor] WARNING: Pool A has ZERO active liquidity!");
             poolAStateFetched = true;
        } else { console.log(`  [Monitor] Pool A State: Failed to fetch.`); }
        if (slotB && liqB !== null) {
             console.log(`  [Monitor] Pool B State: Tick=${slotB.tick}, Liquidity=${liqB.toString()}`);
              if (liqB === 0n) console.warn("    [Monitor] WARNING: Pool B has ZERO active liquidity!");
              poolBStateFetched = true;
        } else { console.log(`  [Monitor] Pool B State: Failed to fetch.`); }

        if (!poolAStateFetched || !poolBStateFetched) {
            console.log("  [Monitor] Could not fetch state for both pools. Skipping simulation cycle.");
            console.log("[Monitor] END (Early exit due to fetch failure)");
            return;
        }

        const simulateAmountWeth = ethers.parseUnits("0.1", WETH_DECIMALS);
        console.log("  [Monitor] Simulating swaps with QuoterV2...");
        const quotePromises = [
            simulateSwap("Pool A", WETH_ADDRESS, USDC_ADDRESS, simulateAmountWeth, POOL_A_FEE_BPS, quoterContract),
            simulateSwap("Pool B", WETH_ADDRESS, USDC_ADDRESS, simulateAmountWeth, POOL_B_FEE_BPS, quoterContract)
        ];
        const [amountOutA, amountOutB] = await Promise.all(quotePromises);
        console.log(`  [Monitor] Quoter simulations complete. OutA: ${amountOutA}, OutB: ${amountOutB}`);

        if (amountOutA === 0n || amountOutB === 0n) {
             console.log("  [Monitor] Failed to get valid quotes for one or both pools. Skipping cycle.");
             console.log("[Monitor] END (Early exit due to quote failure)");
             return;
        }

        const priceA = parseFloat(ethers.formatUnits(amountOutA, USDC_DECIMALS)) / 0.1;
        const priceB = parseFloat(ethers.formatUnits(amountOutB, USDC_DECIMALS)) / 0.1;
        console.log(`  [Monitor] Pool A Price (USDC/WETH): ${priceA.toFixed(6)}`);
        console.log(`  [Monitor] Pool B Price (USDC/WETH): ${priceB.toFixed(6)}`);

        let opportunity = null;
        let estimatedProfitUsd = 0; // Very rough estimate
        const priceDiffThreshold = 0.0001; // Minimum difference ratio to consider

        if (Math.abs(priceA - priceB) / Math.max(priceA, priceB) > priceDiffThreshold) {
             estimatedProfitUsd = Math.abs(priceA - priceB) * parseFloat(ethers.formatUnits(BORROW_AMOUNT_WETH_WEI, WETH_DECIMALS));
             if (priceA > priceB) { // Sell high on A, buy low on B
                 console.log(`  [Monitor] Potential Opportunity: Sell WETH on A ($${priceA.toFixed(4)}), Buy on B ($${priceB.toFixed(4)})`);
                 opportunity = {
                     poolA: { address: POOL_A_ADDRESS, feeBps: POOL_A_FEE_BPS, price: priceA },
                     poolB: { address: POOL_B_ADDRESS, feeBps: POOL_B_FEE_BPS, price: priceB },
                     startPool: "A", borrowTokenSymbol: "WETH", estimatedProfitUsd: estimatedProfitUsd
                 };
             } else { // Sell high on B, buy low on A
                  console.log(`  [Monitor] Potential Opportunity: Sell WETH on B ($${priceB.toFixed(4)}), Buy on A ($${priceA.toFixed(4)})`);
                 opportunity = {
                     poolA: { address: POOL_A_ADDRESS, feeBps: POOL_A_FEE_BPS, price: priceA },
                     poolB: { address: POOL_B_ADDRESS, feeBps: POOL_B_FEE_BPS, price: priceB },
                     startPool: "B", borrowTokenSymbol: "WETH", estimatedProfitUsd: estimatedProfitUsd
                 };
             }

            // Check PROFIT_THRESHOLD_USD (needs gas cost factored in for real trades)
            if (estimatedProfitUsd > PROFIT_THRESHOLD_USD) {
                await attemptArbitrage(opportunity);
            } else {
                console.log(`  [Monitor] Price difference detected, but estimated profit ($${estimatedProfitUsd.toFixed(4)}) below threshold ($${PROFIT_THRESHOLD_USD}).`);
            }
        } else {
            console.log("  [Monitor] No significant price difference detected.");
        }

    } catch (error) {
        console.error(`[Monitor] Error in monitoring loop:`, error);
    } finally {
        console.log(`[Monitor] END - ${new Date().toISOString()}`);
    }
} // End monitorPools function

// --- Start the Bot ---
(async () => {
    console.log("\n>>> Entering startup async IIFE...");
    try {
        console.log(">>> Checking signer balance (as connectivity test)...");
        const balance = await provider.getBalance(signer.address);
        console.log(`>>> Signer balance: ${ethers.formatEther(balance)} ETH`);
        console.log(">>> Attempting to fetch contract owner...");
        const contractOwner = await flashSwapContract.owner();
        console.log(`>>> Successfully fetched owner: ${contractOwner}`);
        if (contractOwner.toLowerCase() === signer.address.toLowerCase()) {
             console.log(`Signer matches contract owner. 'onlyOwner' calls should succeed.\n`);
        } else { /* warning */ }

        console.log(">>> Attempting first monitorPools() run...");
        await monitorPools();
        console.log(">>> First monitorPools() run complete.");

        console.log(">>> Setting up setInterval...");
        setInterval(monitorPools, POLLING_INTERVAL_MS);
        console.log(`\nMonitoring started. Will check every ${POLLING_INTERVAL_MS / 1000} seconds.`);

    } catch (initError) {
        console.error("\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        console.error("Initialization Error / Startup Error:");
        console.error(initError);
        console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        process.exit(1);
    }
})();
