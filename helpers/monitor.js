// helpers/monitor.js
const { ethers } = require('ethers');
const { attemptArbitrage } = require('./arbitrage');

// --- Helper Functions ---
function calculateFlashFee(amountBorrowed, feeBps) { /* ... */ }
function tickToPrice(tick, token0Decimals, token1Decimals) { /* ... */ }

// --- Timeout Helper ---
function createTimeout(ms, message = 'Operation timed out') {
    return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}
const QUOTE_TIMEOUT_MS = 5000; // 5 seconds timeout for quote calls

// --- Main Monitoring Function ---
async function monitorPools(state) {
    const { contracts, config } = state;
    const { poolAContract, poolBContract, quoterContract } = contracts;

    if (!contracts || !poolAContract || !poolBContract || !quoterContract || !config) { return; }

    const poolADesc = `Pool A (${config.POOL_A_ADDRESS} - ${config.POOL_A_FEE_BPS / 100}%)`;
    const poolBDesc = `Pool B (${config.POOL_B_ADDRESS} - ${config.POOL_B_FEE_BPS / 100}%)`;
    console.log(`\n[Monitor] ${new Date().toISOString()} - Checking ${poolADesc} and ${poolBDesc}...`);

    try {
        // Fetch pool states
        console.log("  [Monitor] Fetching pool states...");
        const promisesToSettle = [ poolAContract.slot0(), poolAContract.liquidity(), poolBContract.slot0(), poolBContract.liquidity() ];
        const results = await Promise.race([ // Add timeout for the *entire* fetch block
            Promise.allSettled(promisesToSettle),
            createTimeout(QUOTE_TIMEOUT_MS * 2, 'Pool state fetching timed out') // Longer timeout for fetching
        ]);
        console.log("  [Monitor] Pool state fetch complete.");

        // Check results array structure
        if (!Array.isArray(results) || results.length < 4) {
             console.error("  [Monitor] Fetch results invalid:", results); return;
        }

        // Process results
        let slotA = null, liqA = 0n, slotB = null, liqB = 0n;
        // ... (Assign results safely) ...
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
        let startPoolId = null; /* ... other declarations ... */
        if (slotA && slotB) { /* ... tick check logic ... */ }
        console.log(`  [Monitor] Exiting Tick Check Block (startPoolId=${startPoolId}).`);

        // --- Accurate Pre-Simulation (Re-enabled with Timeouts) ---
        let proceedToAttempt = false;
        let estimatedProfitWei = 0n;

        if (startPoolId && liqA > 0n && liqB > 0n) {
             console.log(`  [Monitor] Performing multi-quote simulation (Sim Amount: ${config.MULTI_QUOTE_SIM_AMOUNT_WETH_STR} WETH)...`);
             const intendedBorrowAmount = config.BORROW_AMOUNT_WETH_WEI;
             const simAmountInInitial = config.MULTI_QUOTE_SIM_AMOUNT_WETH_WEI;
             // ... (token vars, flash fee, repayment amount, logs) ...
             const flashFee = calculateFlashFee(intendedBorrowAmount, flashLoanPoolFeeBps);
             const requiredRepaymentAmount = intendedBorrowAmount + flashFee;
             console.log(`    Sim: Intended Borrow: ...`);
             console.log(`    Sim: Flash Fee Est:   ...`);
             console.log(`    Sim: Repayment Req:   ...`);

             let simAmountIntermediateOut = 0n;
             let simFinalAmountOut = 0n;
             let simError = null;

             // --- Simulate Swap 1 with Timeout ---
             try {
                 const paramsSwap1 = { /* ... */ };
                 console.log(`    Sim: Swap 1 - Attempting staticCall (Single)...`);

                 const quoteResult1_MaybeTimed = await Promise.race([
                     quoterContract.quoteExactInputSingle.staticCall(paramsSwap1),
                     createTimeout(QUOTE_TIMEOUT_MS, 'Swap 1 quote timed out')
                 ]);
                 // If timeout didn't hit, quoteResult1_MaybeTimed is the actual result
                 simAmountIntermediateOut = quoteResult1_MaybeTimed.amountOut; // Use .amountOut if struct is returned

                 if (simAmountIntermediateOut === 0n) throw new Error("Swap 1 simulation resulted in 0 output.");
                 console.log(`    Sim: Swap 1 Output: ${ethers.formatUnits(simAmountIntermediateOut, config.USDC_DECIMALS)} USDC`);

             } catch (error) {
                 console.error(`  [Monitor] ❌ Pre-Sim Error (Swap 1): ${error.message}`);
                 simError = error; // Mark simulation as failed
             }

             // --- Simulate Swap 2 with Timeout (only if Swap 1 succeeded) ---
             if (!simError && simAmountIntermediateOut > 0n) {
                 try {
                     const paramsSwap2 = { /* amountIn: simAmountIntermediateOut ... */ };
                     console.log(`    Sim: Swap 2 - Attempting staticCall (Single)...`);

                     const quoteResult2_MaybeTimed = await Promise.race([
                         quoterContract.quoteExactInputSingle.staticCall(paramsSwap2),
                         createTimeout(QUOTE_TIMEOUT_MS, 'Swap 2 quote timed out')
                     ]);
                     simFinalAmountOut = quoteResult2_MaybeTimed.amountOut;

                     if (simFinalAmountOut === 0n) throw new Error("Swap 2 simulation resulted in 0 output.");
                     console.log(`    Sim: Swap 2 Output: ${ethers.formatUnits(simFinalAmountOut, config.WETH_DECIMALS)} WETH`);

                 } catch (error) {
                     console.error(`  [Monitor] ❌ Pre-Sim Error (Swap 2): ${error.message}`);
                     simError = error; // Mark simulation as failed
                 }
             }

             // --- Profit Check (only if both swaps succeeded) ---
             if (!simError && simFinalAmountOut > 0n) {
                  let estimatedFinalAmountActual = 0n;
                  if (simAmountInInitial > 0n) { estimatedFinalAmountActual = (simFinalAmountOut * intendedBorrowAmount) / simAmountInInitial; }

                  console.log(`    Sim: Est. Final WETH: ${ethers.formatUnits(estimatedFinalAmountActual, config.WETH_DECIMALS)}`);
                  console.log(`    Sim: Repayment Req:   ${ethers.formatUnits(requiredRepaymentAmount, config.WETH_DECIMALS)}`);

                  if (estimatedFinalAmountActual > requiredRepaymentAmount) {
                      estimatedProfitWei = estimatedFinalAmountActual - requiredRepaymentAmount;
                      console.log(`  [Monitor] ✅ Pre-Sim SUCCESS: Est. Profit: ${ethers.formatUnits(estimatedProfitWei, config.WETH_DECIMALS)} WETH`);
                      if (estimatedProfitWei > 0n) proceedToAttempt = true;
                      else console.log(`  [Monitor] ❌ Pre-Sim Result: Scaled profit zero/negative.`);
                  } else { console.log(`  [Monitor] ❌ Pre-Sim Result: Est. final amount less than repayment.`); }
             } else if (!simError && simAmountIntermediateOut === 0n) {
                 console.log("  [Monitor] Skipping profit check as Swap 1 yielded zero.");
             } // else: simError occurred and was logged

        } else if (startPoolId) { /* ... log skipping sim due to zero liq ... */ }


        // --- Trigger Arbitrage Attempt ---
        console.log("  [Monitor] Entering Trigger Block...");
        if (proceedToAttempt && startPoolId) { /* ... call attemptArbitrage ... */ }
        else if (startPoolId) { console.log("  [Monitor] Not proceeding (Sim failed/unprofitable)."); }
        else { console.log("  [Monitor] Not proceeding (No opportunity)."); }
        console.log("  [Monitor] Exiting Trigger Block.");

    } catch (error) { console.error(`[Monitor] CRITICAL Error:`, error); }
    finally { console.log(`[Monitor] ${new Date().toISOString()} - Cycle End.`); }
}

module.exports = { monitorPools };
