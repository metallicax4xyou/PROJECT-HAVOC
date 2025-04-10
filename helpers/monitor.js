// helpers/monitor.js
// ... (imports, helpers, state fetching, tick check logic) ...

    console.log(`  [Monitor] Exiting Tick Check Block (startPoolId=${startPoolId}).`);


    // --- Accurate Pre-Simulation ---
    // --- RE-ENABLE SIMULATION BLOCK --- >>> Remove the /* and */ below

    if (startPoolId && liqA > 0n && liqB > 0n) { // Check liquidity again just before sim
         console.log(`  [Monitor] Performing multi-quote simulation (Sim Amount: ${config.MULTI_QUOTE_SIM_AMOUNT_WETH_STR} WETH)...`);
         const intendedBorrowAmount = config.BORROW_AMOUNT_WETH_WEI;
         const simAmountInInitial = config.MULTI_QUOTE_SIM_AMOUNT_WETH_WEI;
         const tokenInInitial = config.WETH_ADDRESS;
         const tokenIntermediate = config.USDC_ADDRESS;
         const tokenOutFinal = config.WETH_ADDRESS;

         // Calculate Repayment needed
         const flashFee = calculateFlashFee(intendedBorrowAmount, flashLoanPoolFeeBps);
         const requiredRepaymentAmount = intendedBorrowAmount + flashFee;
         console.log(`    Sim: Intended Borrow: ${ethers.formatUnits(intendedBorrowAmount, config.WETH_DECIMALS)} WETH`);
         console.log(`    Sim: Flash Fee Est:   ${ethers.formatUnits(flashFee, config.WETH_DECIMALS)} WETH (${flashLoanPoolFeeBps/100}%)`);
         console.log(`    Sim: Repayment Req:   ${ethers.formatUnits(requiredRepaymentAmount, config.WETH_DECIMALS)} WETH`);

         // --- START Try Block for quoteExactInputSingle ---
         try {
             // Simulate Swap 1 (WETH -> USDC) using quoteExactInputSingle
             const paramsSwap1 = {
                 tokenIn: tokenInInitial, tokenOut: tokenIntermediate,
                 amountIn: simAmountInInitial, fee: swapPoolFeeBps, // Uses fee of the swap pool
                 sqrtPriceLimitX96: 0n
             };
             console.log(`    Sim: Swap 1 - Attempting staticCall (Single)... Pool: ${swapPoolAddress} Fee: ${swapPoolFeeBps}`);
             const quoteResult1 = await quoterContract.quoteExactInputSingle.staticCall(paramsSwap1);
             const simAmountIntermediateOut = quoteResult1.amountOut;

             if (simAmountIntermediateOut === 0n) throw new Error("Swap 1 simulation resulted in 0 output.");
             console.log(`    Sim: Swap 1 (WETH->USDC @ ${swapPoolFeeBps/100}%) Output: ${ethers.formatUnits(simAmountIntermediateOut, config.USDC_DECIMALS)} USDC`);

             // Simulate Swap 2 (USDC -> WETH) using quoteExactInputSingle
             const paramsSwap2 = {
                 tokenIn: tokenIntermediate, tokenOut: tokenOutFinal,
                 amountIn: simAmountIntermediateOut, fee: swapPoolFeeBps, // Uses fee of the swap pool
                 sqrtPriceLimitX96: 0n
             };
             console.log(`    Sim: Swap 2 - Attempting staticCall (Single)... Pool: ${swapPoolAddress} Fee: ${swapPoolFeeBps}`);
             const quoteResult2 = await quoterContract.quoteExactInputSingle.staticCall(paramsSwap2);
             const simFinalAmountOut = quoteResult2.amountOut;

             if (simFinalAmountOut === 0n) throw new Error("Swap 2 simulation resulted in 0 output.");
             console.log(`    Sim: Swap 2 (USDC->WETH @ ${swapPoolFeeBps/100}%) Output: ${ethers.formatUnits(simFinalAmountOut, config.WETH_DECIMALS)} WETH`);

             // --- Profit Check ---
             let estimatedFinalAmountActual = 0n;
             if (simAmountInInitial > 0n) {
                 estimatedFinalAmountActual = (simFinalAmountOut * intendedBorrowAmount) / simAmountInInitial;
             } else { console.warn("    Sim: simAmountInInitial is zero."); }

             console.log(`    Sim: Est. Final WETH (for ${config.BORROW_AMOUNT_WETH_STR} WETH borrow): ${ethers.formatUnits(estimatedFinalAmountActual, config.WETH_DECIMALS)}`);
             console.log(`    Sim: Repayment Req:                       ${ethers.formatUnits(requiredRepaymentAmount, config.WETH_DECIMALS)}`);

             if (estimatedFinalAmountActual > requiredRepaymentAmount) {
                 estimatedProfitWei = estimatedFinalAmountActual - requiredRepaymentAmount;
                 console.log(`  [Monitor] ✅ Pre-Sim SUCCESS: Est. Profit: ${ethers.formatUnits(estimatedProfitWei, config.WETH_DECIMALS)} WETH`);
                 if (estimatedProfitWei > 0n) proceedToAttempt = true; // Set flag to trigger attemptArbitrage
                 else console.log(`  [Monitor] ❌ Pre-Sim Result: Scaled profit zero/negative.`);
             } else {
                  console.log(`  [Monitor] ❌ Pre-Sim Result: Est. final amount less than repayment.`);
             }

         } catch (error) { // Catch for quoteExactInputSingle block
             console.error(`  [Monitor] ❌ Pre-Sim Error (quoteExactInputSingle): ${error.reason || error.message}`);
             if(error.data) console.error(`      Revert Data: ${error.data}`);
             if(error.info) console.error(`      Info: ${JSON.stringify(error.info)}`);
         } // --- END Try Block ---

    } else if (startPoolId) {
        console.log(`  [Monitor] Skipping simulation due to zero liquidity (Error: Should have exited earlier).`);
    }

    // <<< --- END RE-ENABLE SIMULATION BLOCK ---


    // --- Trigger Arbitrage Attempt --- (Keep this logic)
    console.log("  [Monitor] Entering Trigger Block...");
    // ... (trigger logic using proceedToAttempt) ...
    console.log("  [Monitor] Exiting Trigger Block.");

} catch (error) { /* ... outer catch ... */ }
finally { /* ... outer finally ... */ }
}
