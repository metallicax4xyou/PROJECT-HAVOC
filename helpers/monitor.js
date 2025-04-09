// helpers/monitor.js
// ... (imports, helpers, main function setup) ...

async function monitorPools(state) {
    // ... (state fetching, liquidity checks, tick checks) ...

    if (startPoolId) {
        // ... (log setup, repayment calculation) ...

        // --- START Diagnostic Try Block (using quoteExactInput) ---
        try {
            // Simulate Swap 1
            const path1 = encodePath([tokenInInitial, tokenIntermediate], [swapPoolFeeBps]);
            console.log(`    Sim Alt: Swap 1 Path: ${path1}`);
            // <<< --- ADD .staticCall HERE --- >>>
            simAmountIntermediateOut_Alt = await quoterContract.quoteExactInput.staticCall(path1, simAmountInInitial);

            if (simAmountIntermediateOut_Alt === 0n) throw new Error("Swap 1 (quoteExactInput) resulted in 0 output.");
            console.log(`    Sim Alt: Swap 1 (WETH->USDC @ ${swapPoolFeeBps/100}%) Output: ${ethers.formatUnits(simAmountIntermediateOut_Alt, config.USDC_DECIMALS)} USDC`);

            // Simulate Swap 2
             const path2 = encodePath([tokenIntermediate, tokenOutFinal], [swapPoolFeeBps]);
             console.log(`    Sim Alt: Swap 2 Path: ${path2}`);
             // <<< --- ADD .staticCall HERE --- >>>
             simFinalAmountOut_Alt = await quoterContract.quoteExactInput.staticCall(path2, simAmountIntermediateOut_Alt);

             if (simFinalAmountOut_Alt === 0n) throw new Error("Swap 2 (quoteExactInput) resulted in 0 output.");
             console.log(`    Sim Alt: Swap 2 (USDC->WETH @ ${swapPoolFeeBps/100}%) Output: ${ethers.formatUnits(simFinalAmountOut_Alt, config.WETH_DECIMALS)} WETH`);

             // --- Profit Check using _Alt results ---
             // ... (scaling, comparison, set proceedToAttempt) ...

        } catch (error) { // <<< Catch block for the quoteExactInput attempts
            // ... (error logging) ...
        } // <<< END Diagnostic Try Block

    } // End if(startPoolId)

    // --- Trigger Arbitrage Attempt ---
    // ... (check proceedToAttempt, call attemptArbitrage) ...

    // ... (outer try/catch/finally) ...
}

module.exports = { monitorPools };
