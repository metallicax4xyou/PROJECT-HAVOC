// bot.js - Arbitrum Uniswap V3 Flash Swap Bot with Debugging (v15 - Quoter Debugging)

const { ethers } = require("ethers");
require('dotenv').config();

// --- Configuration ---
const RPC_URL = process.env.ARBITRUM_RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// Use getAddress for verified/standard addresses
const FLASH_SWAP_CONTRACT_ADDRESS = ethers.getAddress("0x7a00Ec5b64e662425Bbaa0dD78972570C326210f");
const WETH_ADDRESS = ethers.getAddress("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1");
const USDC_ADDRESS = ethers.getAddress("0xaf88d065e77c8cC2239327C5EDb3A432268e5831"); // Native USDC

// Use lowercase for potentially problematic addresses
const QUOTER_V2_ADDRESS = "0x61ffe014ba17989e743c5f6d790181c0603c3996"; // Lowercase
const POOL_A_ADDRESS = "0xc6962004f452be9203591991d15f6b388e09e8d0"; // Lowercase CORRECT Address (0.05%)
const POOL_B_ADDRESS = "0x17c14d2c404d167802b16c450d3c99f88f2c4f4d"; // Lowercase CORRECT Address (0.30%)

const POOL_A_FEE_BPS = 500; const POOL_A_FEE_PERCENT = 0.05;
const POOL_B_FEE_BPS = 3000; const POOL_B_FEE_PERCENT = 0.30;
const WETH_DECIMALS = 18; const USDC_DECIMALS = 6;

// --- ABIs ---
// --- Ensure your Full FlashSwapABI is pasted here ---
const FlashSwapABI = [{"inputs":[{"internalType":"address","name":"_swapRouter","type":"address"}],"stateMutability":"nonpayable","type":"constructor"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"poolA","type":"address"},{"indexed":true,"internalType":"address","name":"poolB","type":"address"},{"indexed":false,"internalType":"address","name":"tokenBorrowed","type":"address"},{"indexed":false,"internalType":"uint256","name":"amountBorrowed","type":"uint256"}],"name":"ArbitrageAttempt","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"token","type":"address"},{"indexed":true,"internalType":"address","name":"recipient","type":"address"},{"indexed":false,"internalType":"uint256","name":"amount","type":"uint256"}],"name":"EmergencyWithdrawal","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"caller","type":"address"},{"indexed":true,"internalType":"address","name":"pool","type":"address"},{"indexed":false,"internalType":"uint256","name":"amount0","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"amount1","type":"uint256"}],"name":"FlashSwapInitiated","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"token","type":"address"},{"indexed":false,"internalType":"uint256","name":"amountRepaid","type":"uint256"}],"name":"RepaymentSuccess","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"swapNumber","type":"uint256"},{"indexed":true,"internalType":"address","name":"tokenIn","type":"address"},{"indexed":true,"internalType":"address","name":"tokenOut","type":"address"},{"indexed":false,"internalType":"uint256","name":"amountIn","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"amountOut","type":"uint256"}],"name":"SwapExecuted","type":"event"},{"inputs":[],"name":"SWAP_ROUTER","outputs":[{"internalType":"contract ISwapRouter","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"V3_FACTORY","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"_poolAddress","type":"address"},{"internalType":"uint256","name":"_amount0","type":"uint256"},{"internalType":"uint256","name":"_amount1","type":"uint256"},{"internalType":"bytes","name":"_params","type":"bytes"}],"name":"initiateFlashSwap","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"owner","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"fee0","type":"uint256"},{"internalType":"uint256","name":"fee1","type":"uint256"},{"internalType":"bytes","name":"data","type":"bytes"}],"name":"uniswapV3FlashCallback","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"withdrawEther","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"tokenAddress","type":"address"}],"name":"withdrawToken","outputs":[],"stateMutability":"nonpayable","type":"function"},{"stateMutability":"payable","type":"receive"}];
if (!FlashSwapABI || FlashSwapABI.length === 0 || FlashSwapABI[0] === ' PASTE YOUR FULL FlashSwap ABI HERE ') {
    console.error("FATAL: FlashSwapABI is missing or placeholder! Paste the actual ABI from your build artifacts.");
    process.exit(1);
}


const IUniswapV3PoolABI = [
    "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
    "function liquidity() external view returns (uint128)"
];

// --- MODIFIED: Simplified IQuoterV2ABI - Only expecting amountOut ---
const IQuoterV2ABI = [
    "function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external view returns (uint256 amountOut, uint160 sqrtPriceNextX96, uint32 ticksCrossed, uint256 gasEstimate)"
];

// --- Bot Settings ---
const POLLING_INTERVAL_MS = 10000;
const PROFIT_THRESHOLD_USD = 0.05;
let BORROW_AMOUNT_WETH_WEI = ethers.parseUnits("0.00005", WETH_DECIMALS);

// --- Initialization ---
if (!RPC_URL || !PRIVATE_KEY) { console.error("ENV VAR MISSING"); process.exit(1); }
console.log("[Init] Setting up Provider...");
const provider = new ethers.JsonRpcProvider(RPC_URL);
console.log("[Init] Setting up Signer...");
const signer = new ethers.Wallet(PRIVATE_KEY, provider);

console.log("[Init] Instantiating Contracts...");
let flashSwapContract, quoterContract, poolAContract, poolBContract;
try {
    flashSwapContract = new ethers.Contract(FLASH_SWAP_CONTRACT_ADDRESS, FlashSwapABI, signer);
    // Use the simplified Quoter ABI
    quoterContract = new ethers.Contract(QUOTER_V2_ADDRESS, IQuoterV2ABI, provider);
    poolAContract = new ethers.Contract(POOL_A_ADDRESS, IUniswapV3PoolABI, provider);
    poolBContract = new ethers.Contract(POOL_B_ADDRESS, IUniswapV3PoolABI, provider);
    console.log("[Init] All Contract instances created successfully.");
} catch (contractError) {
    console.error("\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    console.error("FATAL: Error instantiating contracts!");
    console.error("Likely cause: Syntax error or incompleteness in one of the ABIs.");
    console.error(contractError);
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    process.exit(1);
}


// --- Initial Logs ---
console.log(`Bot starting...`);
console.log(` - Signer Address: ${signer.address}`);
console.log(` - FlashSwap Contract: ${FLASH_SWAP_CONTRACT_ADDRESS}`);
console.log(` - Quoter V2 Contract: ${QUOTER_V2_ADDRESS}`);
console.log(` - Monitoring Pools:`);
console.log(`   - Pool A (WETH/USDC ${POOL_A_FEE_PERCENT}%): ${POOL_A_ADDRESS}`); // Updated
console.log(`   - Pool B (WETH/USDC ${POOL_B_FEE_PERCENT}%): ${POOL_B_ADDRESS}`);
console.log(` - Debug Borrow Amount: ${ethers.formatUnits(BORROW_AMOUNT_WETH_WEI, WETH_DECIMALS)} WETH`);
console.log(` - Polling Interval: ${POLLING_INTERVAL_MS / 1000} seconds`);
console.log(` - Profit Threshold: $${PROFIT_THRESHOLD_USD} USD (approx, before gas)`);

// --- Helper Functions ---
// MODIFIED: Added logging of params
async function simulateSwap(poolDesc, tokenIn, tokenOut, amountInWei, feeBps, quoter) {
// --- Helper Functions ---
// MODIFIED: Handle full return tuple from Quoter // <<< REPLACE WITH THIS FUNCTION
async function simulateSwap(poolDesc, tokenIn, tokenOut, amountInWei, feeBps, quoter) {
    const params = {
        tokenIn: tokenIn,
        tokenOut: tokenOut,
        amountIn: amountInWei,
        fee: feeBps,
        sqrtPriceLimitX96: 0n
    };
    console.log(`  [Quoter Call - ${poolDesc}] Params:`, {
        tokenIn: params.tokenIn, tokenOut: params.tokenOut, amountIn: params.amountIn.toString(),
        fee: params.fee, sqrtPriceLimitX96: params.sqrtPriceLimitX96.toString()
     }); // Log params
    try {
        // Call using the full ABI, expecting multiple return values
        const quoteResult = await quoter.quoteExactInputSingle.staticCall(params);
        // quoteResult is an array/tuple: [amountOut, sqrtPriceNextX96, ticksCrossed, gasEstimate]
        const amountOut = quoteResult[0]; // Extract amountOut
        console.log(`  [Quoter Call - ${poolDesc}] Success. AmountOut: ${amountOut.toString()}`);
        return amountOut; // Return only amountOut for price calculation
    } catch (error) {
        console.warn(`  [Quoter Call - ${poolDesc}] Failed (Fee: ${feeBps}bps): ${error.reason || error.message || error}`);
         if (error.data && error.data !== '0x') console.warn(`     Raw Revert Data: ${error.data}`);
        return 0n;
    }
}

// (Keep existing attemptArbitrage function)
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
        tokenBorrowedAddress = WETH_ADDRESS; tokenIntermediateAddress = USDC_ADDRESS;
        amountToBorrowWei = BORROW_AMOUNT_WETH_WEI;
        borrowAmount0 = amountToBorrowWei; borrowAmount1 = 0n;
        if (opportunity.startPool === 'A') {
            flashLoanPoolAddress = opportunity.poolA.address; poolAForSwap = opportunity.poolA.address;
            feeAForSwap = opportunity.poolA.feeBps; poolBForSwap = opportunity.poolB.address;
            feeBForSwap = opportunity.poolB.feeBps;
        } else {
            flashLoanPoolAddress = opportunity.poolB.address; poolAForSwap = opportunity.poolB.address;
            feeAForSwap = opportunity.poolB.feeBps; poolBForSwap = opportunity.poolA.address;
            feeBForSwap = opportunity.poolA.feeBps;
        }
    } else { console.error("USDC Borrow NYI"); return; }

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
        tokenIntermediate: tokenIntermediateAddress, poolA: poolAForSwap, poolB: poolBForSwap,
        feeA: feeAForSwap, feeB: feeBForSwap,
        amountOutMinimum1: 0n, amountOutMinimum2: 0n
    };
    const encodedParams = ethers.AbiCoder.defaultAbiCoder().encode(
        ['tuple(address tokenIntermediate, address poolA, address poolB, uint24 feeA, uint24 feeB, uint amountOutMinimum1, uint amountOutMinimum2)'],
        [arbitrageParams]
    );
    console.log("  Callback Parameters (Decoded):", {
        tokenIntermediate: arbitrageParams.tokenIntermediate, poolA: arbitrageParams.poolA, poolB: arbitrageParams.poolB,
        feeA: arbitrageParams.feeA, feeB: arbitrageParams.feeB,
        amountOutMinimum1: '0', amountOutMinimum2: '0' // Log simplified
     });
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
        } catch (gasError) {
            console.error(`  ❌ [2/3] estimateGas failed:`, gasError.reason || gasError.message || gasError);
        }
    } catch (staticCallError) {
        console.error(`  ❌ [1/3] staticCall failed:`, staticCallError.reason || staticCallError.message || staticCallError);
         if (staticCallError.data && staticCallError.data !== '0x') console.error(`     Revert Data: ${staticCallError.data}`);
    }
    console.log("========= Arbitrage Attempt Complete =========");
 } // End attemptArbitrage


// --- Main Monitoring Loop ---
// MODIFIED: Increased simulation amount
async function monitorPools() {
    console.log(`\n[Monitor] START - ${new Date().toISOString()}`);
    try {
        console.log("  [Monitor] Fetching pool states...");
        console.log(`  [Monitor] Calling Promise.all for pool states... (A: ${POOL_A_ADDRESS}, B: ${POOL_B_ADDRESS})`);
        const poolStatePromises = [
            poolAContract.slot0().catch(e => { console.error(`[Monitor] Error fetching slot0 for Pool A (${POOL_A_ADDRESS}): ${e.message || e}`); return null; }),
            poolAContract.liquidity().catch(e => { console.error(`[Monitor] Error fetching liquidity for Pool A (${POOL_A_ADDRESS}): ${e.message || e}`); return null; }),
            poolBContract.slot0().catch(e => { console.error(`[Monitor] Error fetching slot0 for Pool B (${POOL_B_ADDRESS}): ${e.message || e}`); return null; }),
            poolBContract.liquidity().catch(e => { console.error(`[Monitor] Error fetching liquidity for Pool B (${POOL_B_ADDRESS}): ${e.message || e}`); return null; })
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

        // --- MODIFIED: Simulate with 1 WETH ---
        const simulateAmountWeth = ethers.parseUnits("1", WETH_DECIMALS); // Increased from 0.1
        console.log(`  [Monitor] Simulating swaps with QuoterV2 using ${ethers.formatUnits(simulateAmountWeth, WETH_DECIMALS)} WETH...`);
        const quotePromises = [
            simulateSwap("Pool A", WETH_ADDRESS, USDC_ADDRESS, simulateAmountWeth, POOL_A_FEE_BPS, quoterContract),
            simulateSwap("Pool B", WETH_ADDRESS, USDC_ADDRESS, simulateAmountWeth, POOL_B_FEE_BPS, quoterContract)
        ];
        const [amountOutA, amountOutB] = await Promise.all(quotePromises);
        // --- ADDED LOG ---
        console.log(`  [Monitor] Quoter simulations results. AmountOutA: ${amountOutA.toString()}, AmountOutB: ${amountOutB.toString()}`);


        if (amountOutA === 0n || amountOutB === 0n) {
             console.log("  [Monitor] Failed to get valid quotes for one or both pools (AmountOut is 0). Skipping cycle.");
             console.log("[Monitor] END (Early exit due to quote failure)");
             return;
        }

        // --- Price calculation based on 1 WETH input ---
        const priceA = parseFloat(ethers.formatUnits(amountOutA, USDC_DECIMALS)); // amountOut is directly the price per 1 WETH
        const priceB = parseFloat(ethers.formatUnits(amountOutB, USDC_DECIMALS));
        console.log(`  [Monitor] Pool A Price (USDC/WETH): ${priceA.toFixed(6)}`);
        console.log(`  [Monitor] Pool B Price (USDC/WETH): ${priceB.toFixed(6)}`);

        let opportunity = null;
        let estimatedProfitUsd = 0; // Very rough estimate
        const priceDiffThreshold = 0.0001; // Minimum difference ratio

        if (Math.abs(priceA - priceB) / Math.max(priceA, priceB) > priceDiffThreshold) {
             estimatedProfitUsd = Math.abs(priceA - priceB) * parseFloat(ethers.formatUnits(BORROW_AMOUNT_WETH_WEI, WETH_DECIMALS));
             if (priceA > priceB) {
                 console.log(`  [Monitor] Potential Opportunity: Sell WETH on A ($${priceA.toFixed(4)}), Buy on B ($${priceB.toFixed(4)})`);
                 opportunity = { /* ... setup struct ... */ };
             } else {
                  console.log(`  [Monitor] Potential Opportunity: Sell WETH on B ($${priceB.toFixed(4)}), Buy on A ($${priceA.toFixed(4)})`);
                 opportunity = { /* ... setup struct ... */ };
             }
             // Correctly structure the opportunity object before passing
             opportunity = {
                 poolA: { address: POOL_A_ADDRESS, feeBps: POOL_A_FEE_BPS, price: priceA },
                 poolB: { address: POOL_B_ADDRESS, feeBps: POOL_B_FEE_BPS, price: priceB },
                 startPool: priceA > priceB ? "A" : "B", // Borrow from the higher priced pool for this simple logic
                 borrowTokenSymbol: "WETH",
                 estimatedProfitUsd: estimatedProfitUsd
             };

            if (estimatedProfitUsd > PROFIT_THRESHOLD_USD) {
                await attemptArbitrage(opportunity); // Call the attempt function
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
        } else { console.warn("Warning: Signer does not match owner!") }

        console.log(">>> Attempting first monitorPools() run...");
        await monitorPools();
        console.log(">>> First monitorPools() run complete.");

        console.log(">>> Setting up setInterval...");
        setInterval(monitorPools, POLLING_INTERVAL_MS);
        console.log(`\nMonitoring started. Will check every ${POLLING_INTERVAL_MS / 1000} seconds.`);

    } catch (initError) {
        console.error("\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        console.error("Initialization Error / Startup Error:");
        console.error("Check RPC connection, ABIs, Private Key, and Initial Contract Calls.");
        console.error(initError);
        console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        process.exit(1);
    }
})()
