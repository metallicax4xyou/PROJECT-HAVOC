// helpers/monitor.js
const { ethers } = require('ethers');
const { simulateSwap } = require('./simulateSwap'); // Can still be used for optional basic check
const { attemptArbitrage } = require('./arbitrage'); // To call on success

// --- Helper Functions ---

// Calculate Uniswap V3 Flash Loan Fee
function calculateFlashFee(amountBorrowed, feeBps) {
    const feeBpsBigInt = BigInt(feeBps);
    const denominator = 1000000n;
    // Using floor division: amount * fee / 1_000_000
    return (amountBorrowed * feeBpsBigInt) / denominator;
}

// Tick-to-price helper (remains unchanged)
function tickToPrice(tick, token0Decimals, token1Decimals) {
    try {
        const priceRatio = Math.pow(1.0001, Number(tick));
        const decimalAdjustment = Math.pow(10, token0Decimals - token1Decimals);
        const price = priceRatio * decimalAdjustment;
        return isFinite(price) ? price : 0;
    } catch (e) {
        console.warn(`[Helper] Error calculating tickToPrice for tick ${tick}: ${e.message}`);
        return 0;
    }
}

// Optional: Helper for simple gross profit calculation (remains unchanged, may become less relevant)
function calculatePotentialGrossProfitWethWei(priceDiffUSDC_PerWETH, priceA, priceB, config) {
    try {
        const priceDiffUSDC_Wei = ethers.parseUnits(priceDiffUSDC_PerWETH.toFixed(config.USDC_DECIMALS), config.USDC_DECIMALS);
        const potentialGrossProfitUSDC_Wei = (priceDiffUSDC_Wei * config.BORROW_AMOUNT_WETH_WEI) / ethers.parseUnits("1", config.WETH_DECIMALS);
        const avgPrice = (priceA + priceB) / 2;
        if (avgPrice <= 0) return 0n;
        const avgPrice_USDC_Wei = ethers.parseUnits(avgPrice.toFixed(config.USDC_DECIMALS), config.USDC_DECIMALS);
        if (avgPrice_USDC_Wei === 0n) return 0n;
        const potentialGrossProfitWETH_Wei = (potentialGrossProfitUSDC_Wei * ethers.parseUnits("1", config.WETH_DECIMALS)) / avgPrice_USDC_Wei;
        return potentialGrossProfitWETH_Wei;
    } catch (calcError) {
        console.warn(`[Monitor] Warning during gross profit calculation: ${calcError.message}`);
        return 0n;
    }
}

// --- Main Monitoring Function ---
async function monitorPools(state) {
    const { contracts, config } = state;
    const { poolAContract, poolBContract, quoterContract } = contracts;

    if (!poolAContract || !poolBContract || !quoterContract || !config) {
        console.error("[Monitor] Missing contracts or config in state. Skipping cycle.");
        return;
    }

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

        // Process results and log liquidity (remains unchanged)
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
        const TICK_DIFF_THRESHOLD = 1; // Minimal tick difference to consider an arb

        let startPoolId = null;
        let flashLoanPoolFeeBps = 0;
        let swapPoolAddress = ethers.ZeroAddress;
        let swapPoolFeeBps = 0;

        // Determine potential path based on ticks
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
            console.log(`  [Monitor] Tick Check: No significant tick difference.`);
        }

        // --- Accurate Pre-Simulation if Potential Opportunity Found ---
        let proceedToAttempt = false;
        let estimatedProfitWei = 0n; // Store profit from this simulation

        if (startPoolId) {
            console.log(`  [Monitor] Performing multi-quote simulation (Sim Amount: ${config.MULTI_QUOTE_SIM_AMOUNT_WETH_STR} WETH)...`);

            // Use the INTENDED borrow amount for fee/repayment calculation
            const intendedBorrowAmount = config.BORROW_AMOUNT_WETH_WEI;
            // Use the SMALLER simulation amount for the actual quote calls
            const simAmountInInitial = config.MULTI_QUOTE_SIM_AMOUNT_WETH_WEI;

            // Define path tokens
            const tokenInInitial = config.WETH_ADDRESS;
            const tokenIntermediate = config.USDC_ADDRESS;
            const tokenOutFinal = config.WETH_ADDRESS;

            // 1. Calculate Required Repayment based on INTENDED borrow amount
            const flashFee = calculateFlashFee(intendedBorrowAmount, flashLoanPoolFeeBps);
            const requiredRepaymentAmount = intendedBorrowAmount + flashFee;
            console.log(`    Sim: Intended Borrow: ${ethers.formatUnits(intendedBorrowAmount, config.WETH_DECIMALS)} WETH`);
            console.log(`    Sim: Flash Fee Est:   ${ethers.formatUnits(flashFee, config.WETH_DECIMALS)} WETH (${flashLoanPoolFeeBps/100}%)`);
            console.log(`    Sim: Repayment Req:   ${ethers.formatUnits(requiredRepaymentAmount, config.WETH_DECIMALS)} WETH`);

            // 2. Simulate Swap 1 (WETH -> USDC on swapPool) using simAmountInInitial
            let simAmountIntermediateOut = 0n;
            try {
                const paramsSwap1 = {
                    tokenIn: tokenInInitial,
                    tokenOut: tokenIntermediate,
                    amountIn: simAmountInInitial, // <<< USE SMALL SIM AMOUNT
                    fee: swapPoolFeeBps,
                    sqrtPriceLimitX96: 0n
                };
                // Use staticCall for simulation to get return values
                const quoteResult1 = await quoterContract.quoteExactInputSingle.staticCall(paramsSwap1);
                simAmountIntermediateOut = quoteResult1.amountOut;

                if (simAmountIntermediateOut === 0n) throw new Error("Swap 1 simulation resulted in 0 output.");

                console.log(`    Sim: Swap 1 (WETH->USDC @ ${swapPoolFeeBps/100}%) Sim Input: ${config.MULTI_QUOTE_SIM_AMOUNT_WETH_STR} WETH -> ${ethers.formatUnits(simAmountIntermediateOut, config.USDC_DECIMALS)} USDC`);

                // 3. Simulate Swap 2 (USDC -> WETH on swapPool) using simAmountIntermediateOut
                let simFinalAmountOut = 0n;
                try {
                     const paramsSwap2 = {
                        tokenIn: tokenIntermediate,
                        tokenOut: tokenOutFinal,
                        amountIn: simAmountIntermediateOut, // Use output from Sim Swap 1
                        fee: swapPoolFeeBps,
                        sqrtPriceLimitX96: 0n
                    };
                    // Use staticCall for simulation
                    const quoteResult2 = await quoterContract.quoteExactInputSingle.staticCall(paramsSwap2);
                    simFinalAmountOut = quoteResult2.amountOut;

                    if (simFinalAmountOut === 0n) throw new Error("Swap 2 simulation resulted in 0 output.");

                    console.log(`    Sim: Swap 2 (USDC->WETH @ ${swapPoolFeeBps/100}%) Sim Input: ${ethers.formatUnits(simAmountIntermediateOut, config.USDC_DECIMALS)} USDC -> ${ethers.formatUnits(simFinalAmountOut, config.WETH_DECIMALS)} WETH`);

                    // 4. Estimate Final Amount for the INTENDED Borrow Amount and Compare
                    // Scale the simulation result: final_actual ≈ final_sim * (intended_borrow / sim_borrow)
                    let estimatedFinalAmountActual = 0n;
                    if (simAmountInInitial > 0n) { // Avoid division by zero
                       // Perform multiplication before division for better precision with BigInt
                       estimatedFinalAmountActual = (simFinalAmountOut * intendedBorrowAmount) / simAmountInInitial;
                    } else {
                        console.warn("    Sim: simAmountInInitial is zero, cannot scale result.");
                    }

                    console.log(`    Sim: Est. Final WETH (for ${config.BORROW_AMOUNT_WETH_STR} WETH borrow): ${ethers.formatUnits(estimatedFinalAmountActual, config.WETH_DECIMALS)}`);
                    console.log(`    Sim: Repayment Req:                       ${ethers.formatUnits(requiredRepaymentAmount, config.WETH_DECIMALS)}`);

                    // 5. Check Profitability
                    if (estimatedFinalAmountActual > requiredRepaymentAmount) {
                        estimatedProfitWei = estimatedFinalAmountActual - requiredRepaymentAmount;
                        console.log(`  [Monitor] ✅ Pre-Sim SUCCESS: Est. Profit for ${config.BORROW_AMOUNT_WETH_STR} WETH: ${ethers.formatUnits(estimatedProfitWei, config.WETH_DECIMALS)} WETH`);
                        // Basic check: Profit must be greater than zero. Could add gas threshold later.
                        if (estimatedProfitWei > 0n) {
                             proceedToAttempt = true;
                        } else {
                            console.log(`  [Monitor] ❌ Pre-Sim Result: Scaled profit is zero or negative.`);
                        }
                    } else {
                        console.log(`  [Monitor] ❌ Pre-Sim Result: Est. final amount (${ethers.formatUnits(estimatedFinalAmountActual, config.WETH_DECIMALS)}) less than required repayment (${ethers.formatUnits(requiredRepaymentAmount, config.WETH_DECIMALS)}).`);
                    }

                } catch (errorSwap2) {
                     console.error(`  [Monitor] ❌ Pre-Sim Error (Swap 2): ${errorSwap2.reason || errorSwap2.message}`);
                     // Log params for debugging
                     console.error(`      Params Swap 2: amountIn=${simAmountIntermediateOut}, fee=${swapPoolFeeBps}, pool=${swapPoolAddress}`);
                     if(errorSwap2.data) console.error(`      Revert Data: ${errorSwap2.data}`);
                } // End Swap 2 Try/Catch

            } catch (errorSwap1) {
                console.error(`  [Monitor] ❌ Pre-Sim Error (Swap 1): ${errorSwap1.reason || errorSwap1.message}`);
                 // Log params for debugging
                 console.error(`      Params Swap 1: amountIn=${simAmountInInitial}, fee=${swapPoolFeeBps}, pool=${swapPoolAddress}`);
                 if(errorSwap1.data) console.error(`      Revert Data: ${errorSwap1.data}`);
            } // End Swap 1 Try/Catch

        } // End if(startPoolId)

        // --- Trigger Arbitrage Attempt ---
        if (proceedToAttempt && startPoolId) {
             console.log("  [Monitor] Conditions met. Triggering attemptArbitrage with validated path.");
             // Pass necessary details (including estimated profit for logging) to attemptArbitrage via state
             state.opportunity = {
                 startPool: startPoolId,
                 profit: estimatedProfitWei // Pass the calculated profit based on scaled simulation
             };
             await attemptArbitrage(state);
        } else if (startPoolId) {
             // Reason for not proceeding logged within the simulation block
             console.log("  [Monitor] Not proceeding to attemptArbitrage (Pre-simulation failed or unprofitable).");
        }
        // else: No tick difference found

    } catch (error) {
        console.error(`[Monitor] CRITICAL Error during monitoring cycle:`, error);
        // Consider adding more robust error handling, maybe pausing/retrying
    } finally {
         console.log(`[Monitor] ${new Date().toISOString()} - Cycle End.`);
    }
}

module.exports = { monitorPools };
