// helpers/monitor.js
const { ethers } = require('ethers');
const { attemptArbitrage } = require('./arbitrage');

// --- Helper Functions ---

function calculateFlashFee(amountBorrowed, feeBps) { /* ... (keep) ... */ }
function tickToPrice(tick, token0Decimals, token1Decimals) { /* ... (keep) ... */ }
// encodePath is no longer needed

// --- Main Monitoring Function ---
async function monitorPools(state) {
    const { contracts, config } = state;
    const { poolAContract, poolBContract, quoterContract } = contracts;

    if (!poolAContract || !poolBContract || !quoterContract || !config) { /* ... error check ... */ return; }

    const poolADesc = `Pool A (${config.POOL_A_ADDRESS} - ${config.POOL_A_FEE_BPS / 100}%)`;
    const poolBDesc = `Pool B (${config.POOL_B_ADDRESS} - ${config.POOL_B_FEE_BPS / 100}%)`;
    console.log(`\n[Monitor] ${new Date().toISOString()} - Checking ${poolADesc} and ${poolBDesc}...`);

    try {
        // Fetch pool states
        const results = await Promise.allSettled([ /* ... fetch slot0/liquidity ... */ ]);
        // Process results & Check liquidity (keep this logic)
        let slotA = null, liqA = 0n, slotB = null, liqB = 0n;
        // ... (assign results, log states, check for 0 liquidity & return) ...
        if (!slotA || !slotB || liqA === 0n || liqB === 0n) { return; }

        // --- Basic Opportunity Check via Ticks ---
        const tickA = Number(slotA.tick);
        const tickB = Number(slotB.tick);
        const TICK_DIFF_THRESHOLD = 1;

        let startPoolId = null;
        let flashLoanPoolFeeBps = 0;
        let swapPoolAddress = ethers.ZeroAddress;
        let swapPoolFeeBps = 0;
        let proceedToAttempt = false;
        let estimatedProfitWei = 0n;

        // Determine potential path (keep this logic)
        if (tickB > tickA + TICK_DIFF_THRESHOLD) { /* ... Set params for Start A ... */ }
        else if (tickA > tickB + TICK_DIFF_THRESHOLD) { /* ... Set params for Start B ... */ }
        else { console.log(`  [Monitor] Tick Check: No significant tick difference.`); }

        // --- Accurate Pre-Simulation (using quoteExactInputSingle) ---
        if (startPoolId) {
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
                    amountIn: simAmountInInitial, fee: swapPoolFeeBps,
                    sqrtPriceLimitX96: 0n
                };
                // Optional: Add estimateGas check here if needed
                console.log(`    Sim: Swap 1 - Attempting staticCall (Single)...`);
                const quoteResult1 = await quoterContract.quoteExactInputSingle.staticCall(paramsSwap1);
                const simAmountIntermediateOut = quoteResult1.amountOut;

                if (simAmountIntermediateOut === 0n) throw new Error("Swap 1 simulation resulted in 0 output.");
                console.log(`    Sim: Swap 1 (WETH->USDC @ ${swapPoolFeeBps/100}%) Output: ${ethers.formatUnits(simAmountIntermediateOut, config.USDC_DECIMALS)} USDC`);

                // Simulate Swap 2 (USDC -> WETH) using quoteExactInputSingle
                const paramsSwap2 = {
                    tokenIn: tokenIntermediate, tokenOut: tokenOutFinal,
                    amountIn: simAmountIntermediateOut, fee: swapPoolFeeBps,
                    sqrtPriceLimitX96: 0n
                };
                // Optional: Add estimateGas check here if needed
                console.log(`    Sim: Swap 2 - Attempting staticCall (Single)...`);
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
                    if (estimatedProfitWei > 0n) proceedToAttempt = true;
                    else console.log(`  [Monitor] ❌ Pre-Sim Result: Scaled profit zero/negative.`);
                } else {
                     console.log(`  [Monitor] ❌ Pre-Sim Result: Est. final amount less than repayment.`);
                }

            } catch (error) { // Catch for quoteExactInputSingle block
                console.error(`  [Monitor] ❌ Pre-Sim Error (quoteExactInputSingle): ${error.reason || error.message}`);
                if(error.data) console.error(`      Revert Data: ${error.data}`);
                if(error.info) console.error(`      Info: ${JSON.stringify(error.info)}`); // Log ethers error info
            } // --- END Try Block ---

        } // End if(startPoolId)

        // --- Trigger Arbitrage Attempt ---
        if (proceedToAttempt && startPoolId) {
             console.log("  [Monitor] Conditions met. Triggering attemptArbitrage.");
             state.opportunity = { startPool: startPoolId, profit: estimatedProfitWei };
             await attemptArbitrage(state);
        } else if (startPoolId) {
             console.log("  [Monitor] Not proceeding to attemptArbitrage (Pre-simulation failed or unprofitable).");
        }
        // No log needed if startPoolId was null

    } catch (error) { /* ... outer catch ... */ }
    finally { /* ... outer finally ... */ }
}

module.exports = { monitorPools };
