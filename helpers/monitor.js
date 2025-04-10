// helpers/monitor.js
const { ethers } = require('ethers');
const { attemptArbitrage } = require('./arbitrage');

// --- Helper Functions --- (DEFINED FIRST)

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

// --- Main Monitoring Function --- (DEFINED AFTER HELPERS)
async function monitorPools(state) { // <<< async keyword is here
    const { contracts, config } = state;
    const { poolAContract, poolBContract, quoterContract } = contracts;

    if (!poolAContract || !poolBContract || !quoterContract || !config) { return; }

    const poolADesc = `Pool A (${config.POOL_A_ADDRESS} - ${config.POOL_A_FEE_BPS / 100}%)`;
    const poolBDesc = `Pool B (${config.POOL_B_ADDRESS} - ${config.POOL_B_FEE_BPS / 100}%)`;
    console.log(`\n[Monitor] ${new Date().toISOString()} - Checking ${poolADesc} and ${poolBDesc}...`);

    try {
        // Fetch pool states
        console.log("  [Monitor] Fetching pool states...");
        const results = await Promise.allSettled([ /* pool calls */ ]); // await is valid inside async function
        console.log("  [Monitor] Pool state fetch complete.");

        // Debug log results
        console.log("  [DEBUG] Raw Promise.allSettled results:", JSON.stringify(results, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
        console.log(`  [DEBUG] results array length: ${results?.length}`);
        if (!Array.isArray(results) || results.length < 4) { return; }

        // Process results
        let slotA = null, liqA = 0n, slotB = null, liqB = 0n;
        // ... (assign results safely) ...
        if (results[0] && results[0].status === 'fulfilled') slotA = results[0].value; else console.error(/*...*/);
        // ... etc ...

        // Log states
        console.log(`  [Monitor] ${poolADesc} State: Tick=${slotA?.tick}, Liquidity=${liqA.toString()}`);
        console.log(`  [Monitor] ${poolBDesc} State: Tick=${slotB?.tick}, Liquidity=${liqB.toString()}`);

        // Exit checks
        if (!slotA || !slotB) { /*...*/ return; }
        if (liqA === 0n || liqB === 0n) { /*...*/ return; }

        // --- Basic Opportunity Check ---
        console.log("  [Monitor] Entering Tick Check Block...");
        let startPoolId = null;
        let flashLoanPoolFeeBps = 0;
        let swapPoolAddress = ethers.ZeroAddress;
        let swapPoolFeeBps = 0;

        if (slotA && slotB) {
            // ... (tick check logic - assigns startPoolId etc.) ...
        } else { /*...*/ }
        console.log(`  [Monitor] Exiting Tick Check Block (startPoolId=${startPoolId}).`);


        // --- Accurate Pre-Simulation --- (Now uncommented)
        let proceedToAttempt = false;
        let estimatedProfitWei = 0n;

        if (startPoolId && liqA > 0n && liqB > 0n) {
             console.log(`  [Monitor] Performing multi-quote simulation...`);
             const intendedBorrowAmount = config.BORROW_AMOUNT_WETH_WEI;
             const simAmountInInitial = config.MULTI_QUOTE_SIM_AMOUNT_WETH_WEI;
             // ... (rest of simulation setup) ...

             try {
                 const paramsSwap1 = { /* ... */ };
                 console.log(`    Sim: Swap 1 - Attempting staticCall (Single)...`);
                 // <<< await is VALID here because we are inside async function monitorPools >>>
                 const quoteResult1 = await quoterContract.quoteExactInputSingle.staticCall(paramsSwap1);
                 const simAmountIntermediateOut = quoteResult1.amountOut;
                 // ... (check output, log, define paramsSwap2) ...

                 console.log(`    Sim: Swap 2 - Attempting staticCall (Single)...`);
                  // <<< await is VALID here >>>
                 const quoteResult2 = await quoterContract.quoteExactInputSingle.staticCall(paramsSwap2);
                 const simFinalAmountOut = quoteResult2.amountOut;
                 // ... (check output, log, scale result, check profit) ...
                 // ... (set proceedToAttempt = true if profitable) ...

             } catch (error) {
                 console.error(`  [Monitor] ❌ Pre-Sim Error: ${error.reason || error.message}`);
                 // ... (log details) ...
             } // --- END Try Block ---

        } else if (startPoolId) { /* ... log skipping sim ... */ }


        // --- Trigger Arbitrage Attempt ---
        console.log("  [Monitor] Entering Trigger Block...");
        if (proceedToAttempt && startPoolId) {
             console.log("  [Monitor] Conditions met. Triggering attemptArbitrage.");
             state.opportunity = { startPool: startPoolId, profit: estimatedProfitWei };
              // <<< await is VALID here >>>
             await attemptArbitrage(state);
        } else if (startPoolId) { /* ... log not proceeding ... */ }
        else { /* ... log no opportunity ... */ }
        console.log("  [Monitor] Exiting Trigger Block.");


    } catch (error) { /* ... outer catch ... */ }
    finally { /* ... outer finally ... */ }

} // <<< --- END async function monitorPools ---

module.exports = { monitorPools };
