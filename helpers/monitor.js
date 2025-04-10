// helpers/monitor.js
const { ethers } = require('ethers');
const { attemptArbitrage } = require('./arbitrage');

// --- Helper Functions ---
function calculateFlashFee(amountBorrowed, feeBps) {
    const feeBpsBigInt = BigInt(feeBps);
    const denominator = 1000000n;
    return (amountBorrowed * feeBpsBigInt) / denominator;
}

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

// --- Main Monitoring Function ---
async function monitorPools(state) {
    const { contracts, config } = state;
    const { poolAContract, poolBContract, quoterContract } = contracts;

    if (!contracts || !poolAContract || !poolBContract || !quoterContract || !config) { return; }

    const poolADesc = `Pool A (${config.POOL_A_ADDRESS} - ${config.POOL_A_FEE_BPS / 100}%)`;
    const poolBDesc = `Pool B (${config.POOL_B_ADDRESS} - ${config.POOL_B_FEE_BPS / 100}%)`;
    console.log(`\n[Monitor] ${new Date().toISOString()} - Checking ${poolADesc} and ${poolBDesc}...`);

    try {
        // Check contract instances
        console.log("  [DEBUG] Checking contract instances before fetch...");
        if (!(poolAContract instanceof ethers.Contract) || typeof poolAContract.slot0 !== 'function' /* ... etc */) { return; }
        if (!(poolBContract instanceof ethers.Contract) || typeof poolBContract.slot0 !== 'function' /* ... etc */) { return; }
        console.log("  [DEBUG] Contract instances appear valid.");

        // Fetch pool states
        console.log("  [Monitor] Fetching pool states...");
        const promisesToSettle = [ poolAContract.slot0(), poolAContract.liquidity(), poolBContract.slot0(), poolBContract.liquidity() ];
        const results = await Promise.allSettled(promisesToSettle);
        console.log("  [Monitor] Pool state fetch complete.");

        // Debug log results
        console.log("  [DEBUG] Raw Promise.allSettled results:", JSON.stringify(results, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
        console.log(`  [DEBUG] results array length: ${results?.length}`);
        if (!Array.isArray(results) || results.length < 4) { return; }

        // Process results
        let slotA = null, liqA = 0n, slotB = null, liqB = 0n;
        if (results[0]?.status === 'fulfilled') slotA = results[0].value; else console.error(/*...*/);
        if (results[1]?.status === 'fulfilled') liqA = BigInt(results[1].value); else console.error(/*...*/);
        if (results[2]?.status === 'fulfilled') slotB = results[2].value; else console.error(/*...*/);
        if (results[3]?.status === 'fulfilled') liqB = BigInt(results[3].value); else console.error(/*...*/);

        // Log states
        console.log(`  [Monitor] ${poolADesc} State: Tick=${slotA?.tick}, Liquidity=${liqA.toString()}`);
        console.log(`  [Monitor] ${poolBDesc} State: Tick=${slotB?.tick}, Liquidity=${liqB.toString()}`);

        // Exit checks
        if (!slotA || !slotB) { console.log("...Missing slot0..."); return; }
        if (liqA === 0n || liqB === 0n) { console.log("...Zero liquidity..."); return;}

        // --- Basic Opportunity Check via Ticks ---
        console.log("  [Monitor] Entering Tick Check Block...");
        let startPoolId = null;
        let flashLoanPoolFeeBps = 0;
        let swapPoolAddress = ethers.ZeroAddress;
        let swapPoolFeeBps = 0;

        if (slotA && slotB) {
            const tickA = Number(slotA.tick);
            const tickB = Number(slotB.tick);
            const TICK_DIFF_THRESHOLD = 1; // Minimum difference to attempt simulation

            // Check ticks - Pool B should have higher tick for A->B arb
            if (tickB > tickA + TICK_DIFF_THRESHOLD) {
                startPoolId = 'A'; // Borrow A, Swap on B
                flashLoanPoolFeeBps = config.POOL_A_FEE_BPS;
                swapPoolAddress = config.POOL_B_ADDRESS;
                swapPoolFeeBps = config.POOL_B_FEE_BPS;
                console.log(`  [Monitor] Tick Check Result: Potential Start A (Swap Pool B ${swapPoolFeeBps/100}%)`);
            // Check ticks - Pool A should have higher tick for B->A arb
            } else if (tickA > tickB + TICK_DIFF_THRESHOLD) {
                startPoolId = 'B'; // Borrow B, Swap on A
                flashLoanPoolFeeBps = config.POOL_B_FEE_BPS;
                swapPoolAddress = config.POOL_A_ADDRESS;
                swapPoolFeeBps = config.POOL_A_FEE_BPS;
                console.log(`  [Monitor] Tick Check Result: Potential Start B (Swap Pool A ${swapPoolFeeBps/100}%)`);
            } else {
                console.log(`  [Monitor] Tick Check Result: No significant tick difference.`);
            }
        } else { /* Should not happen due to earlier check */ }
        console.log(`  [Monitor] Exiting Tick Check Block (startPoolId=${startPoolId}).`);


        // --- Accurate Pre-Simulation (using quoteExactInputSingle) ---
        // --- RE-ENABLING THIS BLOCK --- >>>
        let proceedToAttempt = false;
        let estimatedProfitWei = 0n;

        // Only run simulation if a potential start pool was identified and pools have liquidity
        if (startPoolId && liqA > 0n && liqB > 0n) {
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
                 console.log(`    Sim: Swap 1 - Attempting staticCall (Single)... Pool: ${swapPoolAddress} Fee: ${swapPoolFeeBps}`);
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
                     // Set flag to proceed ONLY if profit is positive
                     if (estimatedProfitWei > 0n) {
                         proceedToAttempt = true;
                     } else {
                         console.log(`  [Monitor] ❌ Pre-Sim Result: Scaled profit zero/negative.`);
                     }
                 } else {
                      console.log(`  [Monitor] ❌ Pre-Sim Result: Est. final amount less than repayment.`);
                 }

             } catch (error) { // Catch for quoteExactInputSingle block
                 console.error(`  [Monitor] ❌ Pre-Sim Error (quoteExactInputSingle): ${error.reason || error.message}`);
                 // Log more details from ethers error object if available
                 if(error.data) console.error(`      Revert Data: ${error.data}`);
                 if(error.info) console.error(`      Info: ${JSON.stringify(error.info)}`);
                 if (error.transaction) console.error(`     Tx Details: ${JSON.stringify(error.transaction)}`); // Log transaction details if available in error
                 // Log params that caused the error
                 console.error(`      Params that failed: ${JSON.stringify(error.invocation?.args || "N/A")}`); // Access args if present
             } // --- END Try Block for quoteExactInputSingle ---

        } else if (startPoolId) { // This case means liquidity was zero, should have exited earlier
            console.log(`  [Monitor] Skipping simulation due to zero liquidity (Error: Should have exited earlier).`);
        }
        // <<< --- END RE-ENABLING ---


        // --- Trigger Arbitrage Attempt ---
        console.log("  [Monitor] Entering Trigger Block...");
        if (proceedToAttempt && startPoolId) { // Check proceedToAttempt flag set by simulation
             console.log("  [Monitor] Conditions met. Triggering attemptArbitrage.");
             state.opportunity = { startPool: startPoolId, profit: estimatedProfitWei };
             await attemptArbitrage(state);
        } else if (startPoolId) { // startPoolId was set, but simulation failed or was unprofitable
             console.log("  [Monitor] Not proceeding to attemptArbitrage (Pre-simulation failed or unprofitable).");
        } else { // startPoolId was null
             console.log("  [Monitor] Not proceeding to attemptArbitrage (No opportunity found).");
        }
        console.log("  [Monitor] Exiting Trigger Block.");


    } catch (error) {
        console.error(`[Monitor] CRITICAL Error during monitoring cycle:`, error);
    } finally {
         console.log(`[Monitor] ${new Date().toISOString()} - Cycle End.`);
    }
} // <<< END async function monitorPools

module.exports = { monitorPools }; 
