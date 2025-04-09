// helpers/monitor.js
const { ethers } = require('ethers');
// const { simulateSwap } = require('./simulateSwap'); // Optional: Can be removed if not used elsewhere
const { attemptArbitrage } = require('./arbitrage');

// --- Helper Functions ---

// Calculate Uniswap V3 Flash Loan Fee
function calculateFlashFee(amountBorrowed, feeBps) {
    const feeBpsBigInt = BigInt(feeBps);
    const denominator = 1000000n;
    // Using floor division: amount * fee / 1_000_000
    return (amountBorrowed * feeBpsBigInt) / denominator;
}

// Tick-to-price helper
function tickToPrice(tick, token0Decimals, token1Decimals) {
    try {
        const priceRatio = Math.pow(1.0001, Number(tick));
        const decimalAdjustment = Math.pow(10, token0Decimals - token1Decimals);
        const price = priceRatio * decimalAdjustment;
        return isFinite(price) ? price : 0; // Return 0 if price is invalid
    } catch (e) {
        console.warn(`[Helper] Error calculating tickToPrice for tick ${tick}: ${e.message}`);
        return 0; // Return 0 on error
    }
}

// --- Main Monitoring Function ---
async function monitorPools(state) { // <<< Ensure code starts inside this function
    const { contracts, config } = state;
    const { poolAContract, poolBContract, quoterContract } = contracts;

    // Check for necessary state components early
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

        // Process results safely
        const slotAResult = results[0], liqAResult = results[1];
        const slotBResult = results[2], liqBResult = results[3];
        let slotA = null, liqA = 0n, slotB = null, liqB = 0n;

        if (slotAResult.status === 'fulfilled') slotA = slotAResult.value; else console.error(`[Monitor] Failed Fetch: Pool A slot0`);
        if (liqAResult.status === 'fulfilled') liqA = liqAResult.value; else console.error(`[Monitor] Failed Fetch: Pool A liquidity`);
        if (slotBResult.status === 'fulfilled') slotB = slotBResult.value; else console.error(`[Monitor] Failed Fetch: Pool B slot0`);
        if (liqBResult.status === 'fulfilled') liqB = liqBResult.value; else console.error(`[Monitor] Failed Fetch: Pool B liquidity`);

        // Log current states
        console.log(`  [Monitor] ${poolADesc} State: Tick=${slotA?.tick}, Liquidity=${liqA.toString()}`);
        if (liqA === 0n && slotA) console.warn("    ⚠️ Pool A has ZERO active liquidity!");
        console.log(`  [Monitor] ${poolBDesc} State: Tick=${slotB?.tick}, Liquidity=${liqB.toString()}`);
        if (liqB === 0n && slotB) console.warn("    ⚠️ Pool B has ZERO active liquidity!");

        // Exit if core data is missing or pools are empty
        if (!slotA || !slotB || liqA === 0n || liqB === 0n) {
             console.log("  [Monitor] Cannot proceed due to missing state or 0 liquidity.");
             return; // Exit this cycle
        }

        // --- Basic Opportunity Check via Ticks ---
        const tickA = Number(slotA.tick);
        const tickB = Number(slotB.tick);
        const TICK_DIFF_THRESHOLD = 1; // Minimal difference needed

        // --- DECLARE ALL VARIABLES needed in this scope HERE ---
        let startPoolId = null; // <<< Declaration before first use
        let flashLoanPoolFeeBps = 0;
        let swapPoolAddress = ethers.ZeroAddress;
        let swapPoolFeeBps = 0;
        let proceedToAttempt = false;
        let estimatedProfitWei = 0n;
        // --- END VARIABLE DECLARATIONS ---


        // Determine potential path based on ticks
        if (tickB > tickA + TICK_DIFF_THRESHOLD) {
            startPoolId = 'A'; // Assign value
            flashLoanPoolFeeBps = config.POOL_A_FEE_BPS;
            swapPoolAddress = config.POOL_B_ADDRESS;
            swapPoolFeeBps = config.POOL_B_FEE_BPS;
            console.log(`  [Monitor] Tick Check: Potential Start A (Borrow A, Swap B -> B)`);
        } else if (tickA > tickB + TICK_DIFF_THRESHOLD) {
            startPoolId = 'B'; // Assign value
            flashLoanPoolFeeBps = config.POOL_B_FEE_BPS;
            swapPoolAddress = config.POOL_A_ADDRESS;
            swapPoolFeeBps = config.POOL_A_FEE_BPS;
            console.log(`  [Monitor] Tick Check: Potential Start B (Borrow B, Swap A -> A)`);
        } else {
            console.log(`  [Monitor] Tick Check: No significant tick difference.`);
        }


        // --- Accurate Pre-Simulation if Potential Opportunity Found ---
        // --- Check startPoolId HERE ---
        if (startPoolId) { // Only proceed if a potential path was identified
            console.log(`  [Monitor] Performing multi-quote simulation (Sim Amount: ${config.MULTI_QUOTE_SIM_AMOUNT_WETH_STR} WETH)...`);
            const intendedBorrowAmount = config.BORROW_AMOUNT_WETH_WEI;
            const simAmountInInitial = config.MULTI_QUOTE_SIM_AMOUNT_WETH_WEI; // Use smaller amount for quotes
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
                    tokenIn: tokenInInitial, tokenOut: tokenIntermediate,
                    amountIn: simAmountInInitial, fee: swapPoolFeeBps,
                    sqrtPriceLimitX96: 0n
                };

                // Diagnostic estimateGas call
                try {
                    console.log(`    Sim: Swap 1 - Attempting estimateGas...`);
                    const estGas = await quoterContract.quoteExactInputSingle.estimateGas(paramsSwap1, { gasLimit: 1_000_000 });
                    console.log(`    Sim: Swap 1 - estimateGas SUCCEEDED. Estimated: ${estGas.toString()}`);
                } catch (estGasError) {
                    console.error(`    Sim: Swap 1 - estimateGas FAILED: ${estGasError.reason || estGasError.message}`);
                    throw estGasError; // Exit simulation if estimateGas fails
                }

                // Attempt staticCall
                console.log(`    Sim: Swap 1 - Attempting staticCall...`);
                const quoteResult1 = await quoterContract.quoteExactInputSingle.staticCall(paramsSwap1);
                simAmountIntermediateOut = quoteResult1.amountOut;
                console.log(`    Sim: Swap 1 - staticCall SUCCEEDED.`);

                if (simAmountIntermediateOut === 0n) throw new Error("Swap 1 simulation resulted in 0 output.");
                console.log(`    Sim: Swap 1 (WETH->USDC @ ${swapPoolFeeBps/100}%) Sim Input: ${config.MULTI_QUOTE_SIM_AMOUNT_WETH_STR} WETH -> ${ethers.formatUnits(simAmountIntermediateOut, config.USDC_DECIMALS)} USDC`);

                // 3. Simulate Swap 2 (USDC -> WETH on swapPool) using simAmountIntermediateOut
                let simFinalAmountOut = 0n;
                try {
                     const paramsSwap2 = {
                        tokenIn: tokenIntermediate, tokenOut: tokenOutFinal,
                        amountIn: simAmountIntermediateOut, fee: swapPoolFeeBps,
                        sqrtPriceLimitX96: 0n
                    };
                    // Optional: Add estimateGas for Swap 2 if needed
                    console.log(`    Sim: Swap 2 - Attempting staticCall...`);
                    const quoteResult2 = await quoterContract.quoteExactInputSingle.staticCall(paramsSwap2);
                    simFinalAmountOut = quoteResult2.amountOut;
                    console.log(`    Sim: Swap 2 - staticCall SUCCEEDED.`);

                    if (simFinalAmountOut === 0n) throw new Error("Swap 2 simulation resulted in 0 output.");
                    console.log(`    Sim: Swap 2 (USDC->WETH @ ${swapPoolFeeBps/100}%) Sim Input: ${ethers.formatUnits(simAmountIntermediateOut, config.USDC_DECIMALS)} USDC -> ${ethers.formatUnits(simFinalAmountOut, config.WETH_DECIMALS)} WETH`);

                    // 4. Estimate Final Amount for the INTENDED Borrow Amount and Compare
                    let estimatedFinalAmountActual = 0n;
                    if (simAmountInInitial > 0n) {
                       estimatedFinalAmountActual = (simFinalAmountOut * intendedBorrowAmount) / simAmountInInitial;
                    } else { console.warn("    Sim: simAmountInInitial is zero, cannot scale result."); }

                    console.log(`    Sim: Est. Final WETH (for ${config.BORROW_AMOUNT_WETH_STR} WETH borrow): ${ethers.formatUnits(estimatedFinalAmountActual, config.WETH_DECIMALS)}`);
                    console.log(`    Sim: Repayment Req:                       ${ethers.formatUnits(requiredRepaymentAmount, config.WETH_DECIMALS)}`);

                    // 5. Check Profitability
                    if (estimatedFinalAmountActual > requiredRepaymentAmount) {
                        estimatedProfitWei = estimatedFinalAmountActual - requiredRepaymentAmount;
                        console.log(`  [Monitor] ✅ Pre-Sim SUCCESS: Est. Profit for ${config.BORROW_AMOUNT_WETH_STR} WETH: ${ethers.formatUnits(estimatedProfitWei, config.WETH_DECIMALS)} WETH`);
                        if (estimatedProfitWei > 0n) { proceedToAttempt = true; } // Set flag to trigger attemptArbitrage
                        else { console.log(`  [Monitor] ❌ Pre-Sim Result: Scaled profit is zero or negative.`); }
                    } else { console.log(`  [Monitor] ❌ Pre-Sim Result: Est. final amount less than required repayment.`); }

                } catch (errorSwap2) {
                     console.error(`  [Monitor] ❌ Pre-Sim Error (Swap 2): ${errorSwap2.reason || errorSwap2.message}`);
                     console.error(`      Params Swap 2: amountIn=${simAmountIntermediateOut}, fee=${swapPoolFeeBps}, pool=${swapPoolAddress}`);
                     if(errorSwap2.data) console.error(`      Revert Data: ${errorSwap2.data}`);
                } // End Swap 2 Try/Catch

            } catch (errorSwap1) {
                 // Error logging for Swap 1 (including estimateGas failure) already handled by inner try/catch
                 console.error(`  [Monitor] ❌ Pre-Sim Error (Swap 1 Block): ${errorSwap1.reason || errorSwap1.message}`);
                 if (!errorSwap1.message?.includes("estimateGas FAILED")) {
                      const paramsSwap1 = { /* Reconstruct params if needed for logging */ };
                      console.error(`      Params Swap 1: amountIn=${simAmountInInitial}, fee=${swapPoolFeeBps}, pool=${swapPoolAddress}`);
                      if(errorSwap1.data) console.error(`      Revert Data: ${errorSwap1.data}`);
                 }
            } // End Swap 1 Outer Try/Catch

        } // End if(startPoolId)


        // --- Trigger Arbitrage Attempt ---
        // --- Check startPoolId again HERE ---
        if (proceedToAttempt && startPoolId) { // Check startPoolId exists before using
             console.log("  [Monitor] Conditions met. Triggering attemptArbitrage with validated path.");
             state.opportunity = { startPool: startPoolId, profit: estimatedProfitWei };
             await attemptArbitrage(state);
        } else if (startPoolId) { // Check startPoolId exists before logging
             console.log("  [Monitor] Not proceeding to attemptArbitrage (Pre-simulation failed or unprofitable).");
        }
        // No action needed if startPoolId was null initially

    } catch (error) {
        console.error(`[Monitor] CRITICAL Error during monitoring cycle:`, error);
        // Potentially add more robust error handling (e.g., pause, alert)
    } finally {
         console.log(`[Monitor] ${new Date().toISOString()} - Cycle End.`);
    }
} // End async function monitorPools

module.exports = { monitorPools };
