// helpers/monitor.js
const { ethers } = require('ethers');
const { attemptArbitrage } = require('./arbitrage');

// --- Helper Functions ---
function calculateFlashFee(amountBorrowed, feeBps) { /* ... (keep) ... */ }
function tickToPrice(tick, token0Decimals, token1Decimals) { /* ... (keep) ... */ }
function createTimeout(ms, message = 'Operation timed out') { /* ... (keep) ... */ }
const QUOTE_TIMEOUT_MS = 5000;

// --- Main Monitoring Function ---
async function monitorPools(state) {
    const { contracts, config, provider } = state; // <<< Add provider for gas price
    const { poolAContract, poolBContract, quoterContract } = contracts;

    // <<< Add provider check >>>
    if (!contracts || !poolAContract || !poolBContract || !quoterContract || !config || !provider) {
         console.error("[Monitor] CRITICAL: Invalid state object passed. Missing contracts, config, or provider.");
         return;
    }

    const poolADesc = `Pool A (${config.POOL_A_ADDRESS} - ${config.POOL_A_FEE_BPS / 100}%)`;
    const poolBDesc = `Pool B (${config.POOL_B_ADDRESS} - ${config.POOL_B_FEE_BPS / 100}%)`;
    console.log(`\n[Monitor] ${new Date().toISOString()} - Checking ${poolADesc} and ${poolBDesc}...`);

    try {
        // --- Fetch GAS PRICE concurrently with pool states ---
        console.log("  [Monitor] Fetching pool states and fee data...");
        const promisesToSettle = [
            provider.getFeeData(), // <<< Get EIP-1559 fee data
            poolAContract.slot0(),
            poolAContract.liquidity(),
            poolBContract.slot0(),
            poolBContract.liquidity()
        ];
        const results = await Promise.race([
            Promise.allSettled(promisesToSettle),
            createTimeout(QUOTE_TIMEOUT_MS * 2, 'State/Fee fetching timed out')
        ]);
        console.log("  [Monitor] Fetch complete.");

        // Check results array structure
        if (!Array.isArray(results) || results.length < 5) { // Expect 5 results now
             console.error("  [Monitor] Fetch results invalid:", results); return;
        }

        // Process results
        const feeDataResult = results[0];
        const slotAResult = results[1]; const liqAResult = results[2];
        const slotBResult = results[3]; const liqBResult = results[4];

        // --- Get Fee Data ---
        let feeData = null;
        if (feeDataResult?.status === 'fulfilled') {
            feeData = feeDataResult.value;
             console.log(`  [Monitor] Fee Data: maxFeePerGas=${ethers.formatUnits(feeData.maxFeePerGas || 0n, 'gwei')} Gwei, maxPriorityFeePerGas=${ethers.formatUnits(feeData.maxPriorityFeePerGas || 0n, 'gwei')} Gwei`);
        } else {
            console.error(`[Monitor] Failed Fetch: Fee Data - ${feeDataResult?.reason?.message || feeDataResult?.reason || 'Result undefined'}`);
            console.log("  [Monitor] Cannot proceed without fee data.");
            return; // Exit if we can't get fee data
        }
        // Use maxFeePerGas for cost estimation (worst case)
        const currentMaxFeePerGas = feeData.maxFeePerGas;
        if (!currentMaxFeePerGas || currentMaxFeePerGas === 0n) {
             console.warn("  [Monitor] Warning: maxFeePerGas is zero or null. Using fallback.");
             // Fallback or alternative handling needed here if necessary
             return; // Exit if fee is invalid
        }

        // --- Process Pool Data ---
        let slotA = null, liqA = 0n, slotB = null, liqB = 0n;
        // ... (Assign results safely for slotA, liqA, slotB, liqB as before) ...
        if (slotAResult?.status === 'fulfilled') slotA = slotAResult.value; else console.error(/*...*/);
        if (liqAResult?.status === 'fulfilled') liqA = BigInt(liqAResult.value); else console.error(/*...*/);
        if (slotBResult?.status === 'fulfilled') slotB = slotBResult.value; else console.error(/*...*/);
        if (liqBResult?.status === 'fulfilled') liqB = BigInt(liqBResult.value); else console.error(/*...*/);

        // Log states
        console.log(`  [Monitor] ${poolADesc} State: Tick=${slotA?.tick}, Liquidity=${liqA.toString()}`);
        console.log(`  [Monitor] ${poolBDesc} State: Tick=${slotB?.tick}, Liquidity=${liqB.toString()}`);

        // Exit checks
        if (!slotA || !slotB) { /*...*/ return; }
        if (liqA === 0n || liqB === 0n) { /*...*/ return; }

        // --- Basic Opportunity Check via Ticks ---
        console.log("  [Monitor] Entering Tick Check Block...");
        let startPoolId = null; /* ... other declarations ... */
        if (slotA && slotB) { /* ... tick check logic ... */ }
        console.log(`  [Monitor] Exiting Tick Check Block (startPoolId=${startPoolId}).`);

        // --- Accurate Pre-Simulation (with Gas Check Incorporated) ---
        let proceedToAttempt = false;
        let estimatedProfitWei = 0n;

        if (startPoolId && liqA > 0n && liqB > 0n) {
             console.log(`  [Monitor] Performing multi-quote simulation (Sim Amount: ${config.MULTI_QUOTE_SIM_AMOUNT_WETH_STR} WETH)...`);
             const intendedBorrowAmount = config.BORROW_AMOUNT_WETH_WEI;
             const simAmountInInitial = config.MULTI_QUOTE_SIM_AMOUNT_WETH_WEI;
             // ... (token vars, flash fee, repayment amount, logs) ...
             const flashFee = calculateFlashFee(intendedBorrowAmount, flashLoanPoolFeeBps);
             const requiredRepaymentAmount = intendedBorrowAmount + flashFee;
             // Log repayment req etc...

             let simAmountIntermediateOut = 0n;
             let simFinalAmountOut = 0n;
             let simError = null;

             // Simulate Swap 1 & 2 with Timeout (Keep this logic)
             try { /* ... await Promise.race for Swap 1 ... */ } catch(e) { simError = e; }
             if (!simError) { try { /* ... await Promise.race for Swap 2 ... */ } catch(e) { simError = e; } }

             // --- Profit & Gas Check (only if swaps succeeded) ---
             if (!simError && simFinalAmountOut > 0n) {
                  let estimatedFinalAmountActual = 0n;
                  if (simAmountInInitial > 0n) { estimatedFinalAmountActual = (simFinalAmountOut * intendedBorrowAmount) / simAmountInInitial; }

                  console.log(`    Sim: Est. Final WETH: ${ethers.formatUnits(estimatedFinalAmountActual, config.WETH_DECIMALS)}`);
                  console.log(`    Sim: Repayment Req:   ${ethers.formatUnits(requiredRepaymentAmount, config.WETH_DECIMALS)}`);

                  // --- Calculate Gross Profit ---
                  if (estimatedFinalAmountActual > requiredRepaymentAmount) {
                      estimatedProfitWei = estimatedFinalAmountActual - requiredRepaymentAmount; // Gross profit before gas
                      console.log(`  [Monitor] Gross Profit Found: ${ethers.formatUnits(estimatedProfitWei, config.WETH_DECIMALS)} WETH`);

                      // --- Calculate Estimated Gas Cost & Buffer ---
                      const GAS_LIMIT_ESTIMATE = 1_000_000n; // Use BigInt for limit
                      const estimatedGasCost = currentMaxFeePerGas * GAS_LIMIT_ESTIMATE;
                      // Optional: Add a buffer (e.g., 20%) - can be a config variable
                      // const PROFIT_BUFFER_WEI = estimatedGasCost * 120n / 100n; // Gas cost + 20%
                      const MIN_NET_PROFIT_WEI = 100000000000000n; // Example: Require ~0.0001 WETH net profit minimum? TUNABLE.
                      const requiredProfitAfterGas = estimatedGasCost + MIN_NET_PROFIT_WEI;


                      console.log(`    Gas: Est. Max Cost: ~${ethers.formatUnits(estimatedGasCost, 'ether')} ETH (@ ${ethers.formatUnits(currentMaxFeePerGas, 'gwei')} Gwei maxFee)`);
                      console.log(`    Gas: Required Profit > Gas + Buffer: ${ethers.formatUnits(requiredProfitAfterGas, config.WETH_DECIMALS)} WETH`);

                      // --- FINAL CHECK: Gross Profit > Gas Cost + Buffer ---
                      if (estimatedProfitWei > requiredProfitAfterGas) {
                           console.log(`  [Monitor] ✅ NET Profit Check SUCCESS: Est. Net ~${ethers.formatUnits(estimatedProfitWei - estimatedGasCost, config.WETH_DECIMALS)} WETH`);
                           proceedToAttempt = true; // Set flag to trigger attemptArbitrage
                      } else {
                          console.log(`  [Monitor] ❌ NET Profit Check FAIL: Gross Profit ${ethers.formatUnits(estimatedProfitWei, config.WETH_DECIMALS)} <= Required ${ethers.formatUnits(requiredProfitAfterGas, config.WETH_DECIMALS)}`);
                      }
                  } else {
                      console.log(`  [Monitor] ❌ Gross Profit Check FAIL: Est. final amount less than repayment.`);
                  }
             } // else: simError occurred or simFinalAmountOut was zero

        } else if (startPoolId) { /* ... log skipping sim due to zero liq ... */ }


        // --- Trigger Arbitrage Attempt ---
        console.log("  [Monitor] Entering Trigger Block...");
        if (proceedToAttempt && startPoolId) { /* ... call attemptArbitrage ... */ }
        else if (startPoolId) { console.log("  [Monitor] Not proceeding (Sim failed or unprofitable NET)."); }
        else { console.log("  [Monitor] Not proceeding (No opportunity)."); }
        console.log("  [Monitor] Exiting Trigger Block.");

    } catch (error) { console.error(`[Monitor] CRITICAL Error:`, error); }
    finally { console.log(`[Monitor] ${new Date().toISOString()} - Cycle End.`); }
}

module.exports = { monitorPools };
