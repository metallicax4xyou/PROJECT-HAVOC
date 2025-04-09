// helpers/monitor.js
// ... (imports and helper functions: calculateFlashFee, tickToPrice, etc.) ...

async function monitorPools(state) {
    const { contracts, config } = state;
    const { poolAContract, poolBContract, quoterContract } = contracts;
    // ... (null checks, pool descriptions, state fetching, liquidity checks) ...

    // --- Basic Opportunity Check via Ticks ---
    // ... (determine startPoolId, flashLoanPoolFeeBps, swapPoolAddress, swapPoolFeeBps) ...

    // --- Accurate Pre-Simulation if Potential Opportunity Found ---
    let proceedToAttempt = false;
    let estimatedProfitWei = 0n;

    if (startPoolId) {
        console.log(`  [Monitor] Performing multi-quote simulation (Sim Amount: ${config.MULTI_QUOTE_SIM_AMOUNT_WETH_STR} WETH)...`);
        const intendedBorrowAmount = config.BORROW_AMOUNT_WETH_WEI;
        const simAmountInInitial = config.MULTI_QUOTE_SIM_AMOUNT_WETH_WEI;
        const tokenInInitial = config.WETH_ADDRESS;
        const tokenIntermediate = config.USDC_ADDRESS;
        const tokenOutFinal = config.WETH_ADDRESS;

        // 1. Calculate Required Repayment (remains the same)
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
                amountIn: simAmountInInitial,
                fee: swapPoolFeeBps,
                sqrtPriceLimitX96: 0n
            };

            // <<< --- ADDED DIAGNOSTIC estimateGas CALL --- >>>
            try {
                console.log(`    Sim: Swap 1 - Attempting estimateGas...`);
                const estGas = await quoterContract.quoteExactInputSingle.estimateGas(paramsSwap1, { gasLimit: 1_000_000 }); // Add gas limit to estimateGas too
                console.log(`    Sim: Swap 1 - estimateGas SUCCEEDED. Estimated: ${estGas.toString()}`);
            } catch (estGasError) {
                console.error(`    Sim: Swap 1 - estimateGas FAILED: ${estGasError.reason || estGasError.message}`);
                // If estimateGas fails, staticCall will likely fail too, re-throw or handle
                throw estGasError; // Stop simulation if estimateGas fails
            }
            // <<< --- END ADDED DIAGNOSTIC --- >>>

            // Now attempt the staticCall
            console.log(`    Sim: Swap 1 - Attempting staticCall...`);
            const quoteResult1 = await quoterContract.quoteExactInputSingle.staticCall(paramsSwap1);
            simAmountIntermediateOut = quoteResult1.amountOut;
            console.log(`    Sim: Swap 1 - staticCall SUCCEEDED.`); // Log if staticCall works

            if (simAmountIntermediateOut === 0n) throw new Error("Swap 1 simulation resulted in 0 output.");
            console.log(`    Sim: Swap 1 (WETH->USDC @ ${swapPoolFeeBps/100}%) Sim Input: ${config.MULTI_QUOTE_SIM_AMOUNT_WETH_STR} WETH -> ${ethers.formatUnits(simAmountIntermediateOut, config.USDC_DECIMALS)} USDC`);

            // 3. Simulate Swap 2 (Only if Swap 1 succeeded)
            let simFinalAmountOut = 0n;
            try {
                 // ... (paramsSwap2 definition) ...
                 const paramsSwap2 = { /* ... */ };

                 // <<< Optional: Add estimateGas for Swap 2 as well if needed >>>
                 // try { await quoterContract.quoteExactInputSingle.estimateGas(paramsSwap2, { gasLimit: 1_000_000 }); } catch { ... }

                 console.log(`    Sim: Swap 2 - Attempting staticCall...`);
                 const quoteResult2 = await quoterContract.quoteExactInputSingle.staticCall(paramsSwap2);
                 simFinalAmountOut = quoteResult2.amountOut;
                 console.log(`    Sim: Swap 2 - staticCall SUCCEEDED.`);

                 if (simFinalAmountOut === 0n) throw new Error("Swap 2 simulation resulted in 0 output.");
                 console.log(`    Sim: Swap 2 (USDC->WETH @ ${swapPoolFeeBps/100}%) Sim Input: ... -> ${ethers.formatUnits(simFinalAmountOut, config.WETH_DECIMALS)} WETH`);

                 // 4. Estimate Final Amount and Check Profitability (remains the same)
                 // ... (scaling logic, comparison, set proceedToAttempt) ...

            } catch (errorSwap2) { /* ... handle Swap 2 error ... */ }

        } catch (errorSwap1) {
            // Error logging for Swap 1 (including estimateGas failure) already handled by inner try/catch
             console.error(`  [Monitor] ❌ Pre-Sim Error (Swap 1 Block): ${errorSwap1.reason || errorSwap1.message}`);
             // Log params only if it wasn't an estimateGas failure (which already logged)
             if (!errorSwap1.message.includes("estimateGas FAILED")) {
                  console.error(`      Params Swap 1: amountIn=${simAmountInInitial}, fee=${swapPoolFeeBps}, pool=${swapPoolAddress}`);
                  if(errorSwap1.data) console.error(`      Revert Data: ${errorSwap1.data}`);
             }
        } // End Swap 1 Outer Try/Catch

    } // End if(startPoolId)

    // --- Trigger Arbitrage Attempt ---
    if (proceedToAttempt && startPoolId) {
        // ... (call attemptArbitrage) ...
    } else if (startPoolId) {
        console.log("  [Monitor] Not proceeding to attemptArbitrage (Pre-simulation failed or unprofitable).");
    }
    // ... (rest of function) ...
}

module.exports = { monitorPools };
