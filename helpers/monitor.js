// helpers/monitor.js
const { ethers } = require('ethers');
const { attemptArbitrage } = require('./arbitrage');

// ... (Helper functions: calculateFlashFee, tickToPrice, createTimeout) ...
const QUOTE_TIMEOUT_MS = 5000;
const FETCH_TIMEOUT_MS = 20000;

async function monitorPools(state) {
    const { contracts, config, provider } = state;
    // ... (Checks for state, contracts, provider) ...
    const { poolAContract, poolBContract, quoterContract } = contracts;
    // ... (Checks for specific contract instances) ...

    const poolADesc = `Pool A (${config.POOL_A_ADDRESS} - ${config.POOL_A_FEE_BPS / 100}%)`;
    const poolBDesc = `Pool B (${config.POOL_B_ADDRESS} - ${config.POOL_B_FEE_BPS / 100}%)`;
    console.log(`\n[Monitor] ${new Date().toISOString()} - Checking ${poolADesc} and ${poolBDesc}...`);

    try {
        // ... (Fetch states and fee data, Process results, Log states, Exit checks) ...
        // ... (Basic Opportunity Check via Ticks - Determine startPoolId etc.) ...

        // --- Accurate Pre-Simulation (Using INTENDED Borrow Amount Directly) ---
        let proceedToAttempt = false;
        let estimatedProfitWei = 0n; // Store actual profit if sim works

        if (startPoolId && liqA > 0n && liqB > 0n) {
             // <<< Use INTENDED Borrow Amount for Simulation >>>
             const amountToSimulate = config.BORROW_AMOUNT_WETH_WEI;
             console.log(`  [Monitor] Performing quote simulation (Sim Amount: ${config.BORROW_AMOUNT_WETH_STR} WETH)...`);

             const tokenInInitial = config.WETH_ADDRESS;
             const tokenIntermediate = config.USDC_ADDRESS;
             const tokenOutFinal = config.WETH_ADDRESS;

             // Calculate Repayment needed (remains the same calculation)
             const flashFee = calculateFlashFee(amountToSimulate, flashLoanPoolFeeBps); // Fee based on actual amount
             const requiredRepaymentAmount = amountToSimulate + flashFee;
             console.log(`    Sim: Borrow Amount:   ${ethers.formatUnits(amountToSimulate, config.WETH_DECIMALS)} WETH`);
             console.log(`    Sim: Flash Fee Est:   ${ethers.formatUnits(flashFee, config.WETH_DECIMALS)} WETH (${flashLoanPoolFeeBps/100}%)`);
             console.log(`    Sim: Repayment Req:   ${ethers.formatUnits(requiredRepaymentAmount, config.WETH_DECIMALS)} WETH`);

             let simAmountIntermediateOut = 0n;
             let simFinalAmountOut = 0n;
             let simError = null;

             // --- Simulate Swap 1 with Timeout ---
             try {
                 console.log(`    Sim: Swap 1 - Attempting staticCall (Positional)... Pool: ${swapPoolAddress} Fee: ${swapPoolFeeBps}`);
                 const quoteResult1_MaybeTimed = await Promise.race([
                     quoterContract.quoteExactInputSingle.staticCall(
                         tokenInInitial, tokenIntermediate, amountToSimulate, // <<< Use actual amount
                         swapPoolFeeBps, 0n
                     ),
                     createTimeout(QUOTE_TIMEOUT_MS, 'Swap 1 quote timed out')
                 ]);
                 simAmountIntermediateOut = quoteResult1_MaybeTimed; // Direct result

                 if (simAmountIntermediateOut === 0n) throw new Error("Swap 1 simulation resulted in 0 output.");
                 console.log(`    Sim: Swap 1 Output: ${ethers.formatUnits(simAmountIntermediateOut, config.USDC_DECIMALS)} USDC`);

             } catch (error) { console.error(`  [Monitor] ❌ Pre-Sim Error (Swap 1): ${error.message}`); simError = error; }

             // --- Simulate Swap 2 with Timeout (only if Swap 1 succeeded) ---
             if (!simError && simAmountIntermediateOut > 0n) {
                 try {
                     console.log(`    Sim: Swap 2 - Attempting staticCall (Positional)... Pool: ${swapPoolAddress} Fee: ${swapPoolFeeBps}`);
                     const quoteResult2_MaybeTimed = await Promise.race([
                         quoterContract.quoteExactInputSingle.staticCall(
                             tokenIntermediate, tokenOutFinal, simAmountIntermediateOut, // Use intermediate amount
                             swapPoolFeeBps, 0n
                         ),
                         createTimeout(QUOTE_TIMEOUT_MS, 'Swap 2 quote timed out')
                     ]);
                     simFinalAmountOut = quoteResult2_MaybeTimed;

                     if (simFinalAmountOut === 0n) throw new Error("Swap 2 simulation resulted in 0 output.");
                     console.log(`    Sim: Swap 2 Output: ${ethers.formatUnits(simFinalAmountOut, config.WETH_DECIMALS)} WETH`);

                 } catch (error) { console.error(`  [Monitor] ❌ Pre-Sim Error (Swap 2): ${error.message}`); simError = error; }
             }

             // --- Profit & Gas Check (only if both swaps succeeded) ---
             // No scaling needed now, simFinalAmountOut is the direct result for the intended borrow
             if (!simError && simFinalAmountOut > 0n) {
                  console.log(`    Sim: Final WETH Out: ${ethers.formatUnits(simFinalAmountOut, config.WETH_DECIMALS)}`);
                  console.log(`    Sim: Repayment Req:  ${ethers.formatUnits(requiredRepaymentAmount, config.WETH_DECIMALS)}`);

                  if (simFinalAmountOut > requiredRepaymentAmount) {
                      estimatedProfitWei = simFinalAmountOut - requiredRepaymentAmount; // Direct profit
                      console.log(`  [Monitor] Gross Profit Found: ${ethers.formatUnits(estimatedProfitWei, config.WETH_DECIMALS)} WETH`);

                      // Gas Check (remains the same)
                      const estimatedGasCost = currentMaxFeePerGas * config.GAS_LIMIT_ESTIMATE;
                      const requiredProfitAfterGas = estimatedGasCost + config.MIN_NET_PROFIT_WEI;
                      console.log(`    Gas: Est. Max Cost: ~${ethers.formatUnits(estimatedGasCost, 'ether')} ETH`);
                      console.log(`    Gas: Required Profit > Gas + Min Net: ${ethers.formatUnits(requiredProfitAfterGas, config.WETH_DECIMALS)} WETH`);

                      if (estimatedProfitWei > requiredProfitAfterGas) {
                           console.log(`  [Monitor] ✅ NET Profit Check SUCCESS`);
                           proceedToAttempt = true;
                      } else { console.log(`  [Monitor] ❌ NET Profit Check FAIL`); }
                  } else { console.log(`  [Monitor] ❌ Gross Profit Check FAIL`); }
             } else if (!simError && simAmountIntermediateOut === 0n) { /* ... */ }
             // else: simError occurred

        } else if (startPoolId) { /* ... log skipping sim ... */ }

        // --- Trigger Arbitrage Attempt --- (Keep)
        // ...

    } catch (error) { /* ... outer catch ... */ }
    finally { /* ... outer finally ... */ }
}

module.exports = { monitorPools };
