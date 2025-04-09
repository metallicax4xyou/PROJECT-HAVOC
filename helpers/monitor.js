// helpers/monitor.js
const { ethers } = require('ethers');
const { simulateSwap } = require('./simulateSwap'); // Keep for basic quoter health check if desired
const { attemptArbitrage } = require('./arbitrage'); // To call on success

// --- Helper Functions ---

// Calculate Uniswap V3 Flash Loan Fee
// Fee is based on the amount *borrowed* and the fee tier of the *lending* pool
function calculateFlashFee(amountBorrowed, feeBps) {
    // Uniswap V3 fee math: fee = amount * fee_tier / 1_000_000
    const feeBpsBigInt = BigInt(feeBps);
    const denominator = 1000000n;
    // Use ceiling division: (a * b + d - 1) / d for precision
    // return (amountBorrowed * feeBpsBigInt + denominator - 1n) / denominator;
    // Simpler floor division is usually sufficient for checks:
    return (amountBorrowed * feeBpsBigInt) / denominator;
}

// Tick-to-price helper (same as before)
function tickToPrice(tick, token0Decimals, token1Decimals) { /* ... (keep existing code) ... */ }

// Helper for simple gross profit calculation (optional, for logging maybe)
function calculatePotentialGrossProfitWethWei(priceDiffUSDC_PerWETH, priceA, priceB, config) { /* ... (keep existing code) ... */ }

// --- Main Monitoring Function ---
async function monitorPools(state) {
    const { contracts, config } = state;
    const { poolAContract, poolBContract, quoterContract } = contracts;

    if (!poolAContract || !poolBContract || !quoterContract || !config) { /* ... error check ... */ return; }

    const poolADesc = `Pool A (${config.POOL_A_ADDRESS} - ${config.POOL_A_FEE_BPS / 100}%)`;
    const poolBDesc = `Pool B (${config.POOL_B_ADDRESS} - ${config.POOL_B_FEE_BPS / 100}%)`;
    console.log(`\n[Monitor] ${new Date().toISOString()} - Checking ${poolADesc} and ${poolBDesc}...`);

    try {
        // Fetch pool states (slot0 and liquidity)
        const results = await Promise.allSettled([
            poolAContract.slot0(), poolAContract.liquidity(),
            poolBContract.slot0(), poolBContract.liquidity()
        ]);

        const slotAResult = results[0], liqAResult = results[1];
        const slotBResult = results[2], liqBResult = results[3];
        let slotA = null, liqA = 0n, slotB = null, liqB = 0n;

        // Process results and log liquidity (same as before)
        if (slotAResult.status === 'fulfilled') slotA = slotAResult.value; else console.error(/*...*/);
        if (liqAResult.status === 'fulfilled') liqA = liqAResult.value; else console.error(/*...*/);
        if (slotBResult.status === 'fulfilled') slotB = slotBResult.value; else console.error(/*...*/);
        if (liqBResult.status === 'fulfilled') liqB = liqBResult.value; else console.error(/*...*/);
        console.log(`  [Monitor] ${poolADesc} State: Tick=${slotA?.tick}, Liquidity=${liqA.toString()}`);
        if (liqA === 0n && slotA) console.warn("    ⚠️ Pool A has ZERO active liquidity!");
        console.log(`  [Monitor] ${poolBDesc} State: Tick=${slotB?.tick}, Liquidity=${liqB.toString()}`);
        if (liqB === 0n && slotB) console.warn("    ⚠️ Pool B has ZERO active liquidity!");
        if (!slotA || !slotB || liqA === 0n || liqB === 0n) {
             console.log("  [Monitor] Cannot proceed due to missing state or 0 liquidity.");
             return;
         }

        // --- Basic Opportunity Check via Ticks ---
        const tickA = Number(slotA.tick);
        const tickB = Number(slotB.tick);
        const TICK_DIFF_THRESHOLD = 1;

        let startPoolId = null;
        let flashLoanPoolFeeBps = 0;
        let swapPoolAddress = ethers.ZeroAddress; // Use ZeroAddress constant
        let swapPoolFeeBps = 0;

        if (tickB > tickA + TICK_DIFF_THRESHOLD) {
            startPoolId = 'A'; // Borrow A, Swap on B
            flashLoanPoolFeeBps = config.POOL_A_FEE_BPS;
            swapPoolAddress = config.POOL_B_ADDRESS;
            swapPoolFeeBps = config.POOL_B_FEE_BPS;
            console.log(`  [Monitor] Tick Check: Potential Start A (Borrow A, Swap B -> B)`);
        } else if (tickA > tickB + TICK_DIFF_THRESHOLD) {
            startPoolId = 'B'; // Borrow B, Swap on A
            flashLoanPoolFeeBps = config.POOL_B_FEE_BPS;
            swapPoolAddress = config.POOL_A_ADDRESS;
            swapPoolFeeBps = config.POOL_A_FEE_BPS;
            console.log(`  [Monitor] Tick Check: Potential Start B (Borrow B, Swap A -> A)`);
        } else {
            console.log(`  [Monitor] Tick Check: No significant difference.`);
        }

        // --- Accurate Pre-Simulation if Opportunity Found ---
        let proceedToAttempt = false;
        let estimatedProfitWei = 0n; // Store profit from this simulation

        if (startPoolId) {
            console.log(`  [Monitor] Performing multi-quote simulation...`);

            // Constants for simulation path (WETH -> USDC -> WETH)
            const tokenInInitial = config.WETH_ADDRESS;
            const tokenIntermediate = config.USDC_ADDRESS;
            const tokenOutFinal = config.WETH_ADDRESS;
            const amountInInitial = config.BORROW_AMOUNT_WETH_WEI;

            // 1. Calculate Required Repayment (Loan + Flash Fee)
            const flashFee = calculateFlashFee(amountInInitial, flashLoanPoolFeeBps);
            const requiredRepaymentAmount = amountInInitial + flashFee;
            console.log(`    Sim: Borrow Amount: ${ethers.formatUnits(amountInInitial, config.WETH_DECIMALS)} WETH`);
            console.log(`    Sim: Flash Fee:     ${ethers.formatUnits(flashFee, config.WETH_DECIMALS)} WETH (${flashLoanPoolFeeBps/100}%)`);
            console.log(`    Sim: Repayment Req: ${ethers.formatUnits(requiredRepaymentAmount, config.WETH_DECIMALS)} WETH`);

            // 2. Simulate Swap 1 (WETH -> USDC on swapPool)
            let amountIntermediateOut = 0n;
            try {
                const paramsSwap1 = {
                    tokenIn: tokenInInitial,
                    tokenOut: tokenIntermediate,
                    amountIn: amountInInitial,
                    fee: swapPoolFeeBps,
                    sqrtPriceLimitX96: 0n
                };
                // Use callStatic to get return values directly
                const quoteResult1 = await quoterContract.quoteExactInputSingle.staticCall(paramsSwap1);
                amountIntermediateOut = quoteResult1.amountOut; // amountOut is usually the first return value

                if (amountIntermediateOut === 0n) throw new Error("Swap 1 simulation resulted in 0 output.");

                console.log(`    Sim: Swap 1 (WETH->USDC on ${swapPoolAddress} @ ${swapPoolFeeBps/100}%): ${ethers.formatUnits(amountInInitial, config.WETH_DECIMALS)} -> ${ethers.formatUnits(amountIntermediateOut, config.USDC_DECIMALS)}`);

                // 3. Simulate Swap 2 (USDC -> WETH on swapPool)
                let finalAmountOut = 0n;
                try {
                     const paramsSwap2 = {
                        tokenIn: tokenIntermediate,
                        tokenOut: tokenOutFinal,
                        amountIn: amountIntermediateOut, // Use output from Swap 1
                        fee: swapPoolFeeBps,
                        sqrtPriceLimitX96: 0n
                    };
                    const quoteResult2 = await quoterContract.quoteExactInputSingle.staticCall(paramsSwap2);
                    finalAmountOut = quoteResult2.amountOut;

                    if (finalAmountOut === 0n) throw new Error("Swap 2 simulation resulted in 0 output.");

                    console.log(`    Sim: Swap 2 (USDC->WETH on ${swapPoolAddress} @ ${swapPoolFeeBps/100}%): ${ethers.formatUnits(amountIntermediateOut, config.USDC_DECIMALS)} -> ${ethers.formatUnits(finalAmountOut, config.WETH_DECIMALS)}`);

                    // 4. Compare Final Amount vs Repayment Required
                    console.log(`    Sim: Final WETH Out: ${ethers.formatUnits(finalAmountOut, config.WETH_DECIMALS)}`);
                    console.log(`    Sim: Repayment Req:  ${ethers.formatUnits(requiredRepaymentAmount, config.WETH_DECIMALS)}`);

                    if (finalAmountOut > requiredRepaymentAmount) {
                        estimatedProfitWei = finalAmountOut - requiredRepaymentAmount;
                        console.log(`  [Monitor] ✅ Pre-Sim SUCCESS: Estimated Profit: ${ethers.formatUnits(estimatedProfitWei, config.WETH_DECIMALS)} WETH`);
                        // Basic check: Is profit > 0? Add gas check later if needed.
                        if (estimatedProfitWei > 0n) {
                             proceedToAttempt = true;
                             // Optional: Add a minimum profit threshold here if desired
                             // const MIN_PROFIT_WEI = ethers.parseUnits("0.0001", config.WETH_DECIMALS);
                             // if (estimatedProfitWei > MIN_PROFIT_WEI) proceedToAttempt = true;
                        } else {
                            console.log(`  [Monitor] ❌ Pre-Sim Result: Profit is zero or negative.`);
                        }
                    } else {
                        console.log(`  [Monitor] ❌ Pre-Sim Result: Final amount (${ethers.formatUnits(finalAmountOut, config.WETH_DECIMALS)}) less than required repayment (${ethers.formatUnits(requiredRepaymentAmount, config.WETH_DECIMALS)}).`);
                    }

                } catch (errorSwap2) {
                     console.error(`  [Monitor] ❌ Pre-Sim Error (Swap 2): ${errorSwap2.reason || errorSwap2.message}`);
                } // End Swap 2 Try/Catch

            } catch (errorSwap1) {
                console.error(`  [Monitor] ❌ Pre-Sim Error (Swap 1): ${errorSwap1.reason || errorSwap1.message}`);
            } // End Swap 1 Try/Catch

        } // End if(startPoolId)

        // --- Trigger Arbitrage Attempt ---
        if (proceedToAttempt && startPoolId) {
            console.log("  [Monitor] Conditions met. Triggering attemptArbitrage with validated path.");
            // Update state with the identified opportunity details including simulated profit
            state.opportunity = {
                startPool: startPoolId, // 'A' or 'B'
                profit: estimatedProfitWei // Pass the calculated profit
                // Add other details if attemptArbitrage needs them
            };
            await attemptArbitrage(state); // Pass the whole state object
        } else if (startPoolId) {
             console.log("  [Monitor] Not proceeding to attemptArbitrage (Pre-simulation failed or unprofitable).");
        }
        // else: No tick difference found

    } catch (error) {
        console.error(`[Monitor] Error during monitoring cycle:`, error);
    } finally {
         console.log(`[Monitor] ${new Date().toISOString()} - Cycle End.`);
    }
}

module.exports = { monitorPools };
