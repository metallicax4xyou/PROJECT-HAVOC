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
function createTimeout(ms, message = 'Operation timed out') {
    return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}
const QUOTE_TIMEOUT_MS = 5000;
const FETCH_TIMEOUT_MS = 20000;

// --- Main Monitoring Function ---
async function monitorPools(state) {
    // Destructure state object
    if (!state || !state.contracts || !state.config || !state.provider) { return; }
    const { contracts, config, provider } = state;
    const { poolAContract, poolBContract, quoterContract } = contracts;
    if (!poolAContract || !poolBContract || !quoterContract) { return; }


    const poolADesc = `Pool A (${config.POOL_A_ADDRESS} - ${config.POOL_A_FEE_BPS / 100}%)`;
    const poolBDesc = `Pool B (${config.POOL_B_ADDRESS} - ${config.POOL_B_FEE_BPS / 100}%)`;
    console.log(`\n[Monitor] ${new Date().toISOString()} - Checking ${poolADesc} and ${poolBDesc}...`);

    try {
        // Check contract instances are valid
        console.log("  [DEBUG] Checking contract instances before fetch...");
        if (!(poolAContract instanceof ethers.Contract) /* Add more checks if needed */) { return; }
        if (!(poolBContract instanceof ethers.Contract) /* Add more checks if needed */) { return; }
        console.log("  [DEBUG] Contract instances appear valid.");

        // Fetch states and fee data concurrently with timeout
        console.log("  [Monitor] Fetching pool states and fee data...");
        const promisesToSettle = [
            provider.getFeeData(),
            poolAContract.slot0(), poolAContract.liquidity(),
            poolBContract.slot0(), poolBContract.liquidity()
        ];
        const results = await Promise.race([
            Promise.allSettled(promisesToSettle),
            createTimeout(FETCH_TIMEOUT_MS, 'State/Fee fetching timed out')
        ]);
        console.log("  [Monitor] Fetch complete.");

        // Validate fetch results
        if (!Array.isArray(results) || results.length < 5) {
             console.error("  [Monitor] Fetch results invalid (Likely Timeout). Results:", results); return;
        }

        // Process Fee Data
        const feeDataResult = results[0];
        let feeData = null;
        if (feeDataResult?.status === 'fulfilled') {
            feeData = feeDataResult.value;
            console.log(`  [Monitor] Fee Data: maxFeePerGas=${ethers.formatUnits(feeData.maxFeePerGas || 0n, 'gwei')} Gwei`);
        } else {
            console.error(`[Monitor] Failed Fetch: Fee Data - ${feeDataResult?.reason?.message || 'Reason N/A'}`); return;
        }
        const currentMaxFeePerGas = feeData.maxFeePerGas;
        if (!currentMaxFeePerGas || currentMaxFeePerGas <= 0n) {
             console.warn(`[Monitor] Warning: Invalid maxFeePerGas (${currentMaxFeePerGas}). Skipping cycle.`); return;
        }

        // --- Calculate Estimated Gas Cost (Using config estimate) ---
        const estimatedGasCost = currentMaxFeePerGas * config.GAS_LIMIT_ESTIMATE;
        console.log(`  [Gas] Estimated Tx Cost: ~${ethers.formatUnits(estimatedGasCost, 'ether')} ETH (Using Limit: ${config.GAS_LIMIT_ESTIMATE})`);
        // ---

        // Process Pool Data
        const slotAResult = results[1]; const liqAResult = results[2];
        const slotBResult = results[3]; const liqBResult = results[4];
        let slotA = null, liqA = 0n, slotB = null, liqB = 0n;
        if (slotAResult?.status === 'fulfilled') slotA = slotAResult.value; else console.error(`[Monitor] Failed Fetch: Pool A slot0`);
        if (liqAResult?.status === 'fulfilled') liqA = BigInt(liqAResult.value); else console.error(`[Monitor] Failed Fetch: Pool A liquidity`);
        if (slotBResult?.status === 'fulfilled') slotB = slotBResult.value; else console.error(`[Monitor] Failed Fetch: Pool B slot0`);
        if (liqBResult?.status === 'fulfilled') liqB = BigInt(liqBResult.value); else console.error(`[Monitor] Failed Fetch: Pool B liquidity`);

        // Log states
        console.log(`  [Monitor] ${poolADesc} State: Tick=${slotA?.tick}, Liquidity=${liqA.toString()}`);
        console.log(`  [Monitor] ${poolBDesc} State: Tick=${slotB?.tick}, Liquidity=${liqB.toString()}`);

        // Exit checks
        if (!slotA || !slotB) { console.log("...Missing slot0 data..."); return; }
        if (liqA === 0n || liqB === 0n) { console.log("...Zero liquidity..."); return; }

        // --- Basic Opportunity Check via Ticks ---
        console.log("  [Monitor] Entering Tick Check Block...");
        let startPoolId = null;
        let flashLoanPoolFeeBps = 0;
        let swapPoolAddress = ethers.ZeroAddress;
        let swapPoolFeeBps = 0;
        let tickDelta = 0;

        if (slotA && slotB) {
            const tickA = Number(slotA.tick);
            const tickB = Number(slotB.tick);
            tickDelta = Math.abs(tickA - tickB);
            const TICK_DIFF_THRESHOLD = 1; // Minimal difference needed

            if (tickB > tickA + TICK_DIFF_THRESHOLD) {
                startPoolId = 'A'; flashLoanPoolFeeBps = config.POOL_A_FEE_BPS;
                swapPoolAddress = config.POOL_B_ADDRESS; swapPoolFeeBps = config.POOL_B_FEE_BPS;
                console.log(`  [Monitor] Tick Check Result: Potential Start A (Swap Pool B ${swapPoolFeeBps/100}%)`);
            } else if (tickA > tickB + TICK_DIFF_THRESHOLD) {
                startPoolId = 'B'; flashLoanPoolFeeBps = config.POOL_B_FEE_BPS;
                swapPoolAddress = config.POOL_A_ADDRESS; swapPoolFeeBps = config.POOL_A_FEE_BPS;
                console.log(`  [Monitor] Tick Check Result: Potential Start B (Swap Pool A ${swapPoolFeeBps/100}%)`);
            } else { console.log(`  [Monitor] Tick Check Result: No significant tick difference (Delta: ${tickDelta}).`); }

            // --- Near Miss Logging ---
            if (startPoolId && tickDelta > 0 && tickDelta <= config.TICK_DELTA_WARNING_THRESHOLD) { // Only log near miss if direction identified
                console.log(`  [Opportunity] Near Miss! Tick Delta: ${tickDelta} (Threshold: ${config.TICK_DELTA_WARNING_THRESHOLD})`);
            }
            // ---

        } else { console.log("  [Monitor] Tick Check Skipped (Should not happen)."); }
        console.log(`  [Monitor] Exiting Tick Check Block (startPoolId=${startPoolId}).`);


        // --- Accurate Pre-Simulation (with Gas Check Incorporated) ---
        let proceedToAttempt = false;
        let estimatedProfitWei = 0n;

        if (startPoolId && liqA > 0n && liqB > 0n) {
             console.log(`  [Monitor] Performing multi-quote simulation (Sim Amount: ${config.MULTI_QUOTE_SIM_AMOUNT_WETH_STR} WETH)...`);
             const intendedBorrowAmount = config.BORROW_AMOUNT_WETH_WEI;
             const simAmountInInitial = config.MULTI_QUOTE_SIM_AMOUNT_WETH_WEI;
             const tokenInInitial = config.WETH_ADDRESS;
             const tokenIntermediate = config.USDC_ADDRESS;
             const tokenOutFinal = config.WETH_ADDRESS;

             const flashFee = calculateFlashFee(intendedBorrowAmount, flashLoanPoolFeeBps);
             const requiredRepaymentAmount = intendedBorrowAmount + flashFee;
             console.log(`    Sim: Intended Borrow: ${ethers.formatUnits(intendedBorrowAmount, config.WETH_DECIMALS)} WETH`);
             console.log(`    Sim: Flash Fee Est:   ${ethers.formatUnits(flashFee, config.WETH_DECIMALS)} WETH (${flashLoanPoolFeeBps/100}%)`);
             console.log(`    Sim: Repayment Req:   ${ethers.formatUnits(requiredRepaymentAmount, config.WETH_DECIMALS)} WETH`);

             let simAmountIntermediateOut = 0n;
             let simFinalAmountOut = 0n;
             let simError = null;

             // Swap 1 with Timeout
             try {
                 const paramsSwap1 = { tokenIn: tokenInInitial, tokenOut: tokenIntermediate, amountIn: simAmountInInitial, fee: swapPoolFeeBps, sqrtPriceLimitX96: 0n };
                 console.log(`    Sim: Swap 1 - Attempting staticCall (Single)... Pool: ${swapPoolAddress} Fee: ${swapPoolFeeBps}`);
                 const quoteResult1_MaybeTimed = await Promise.race([quoterContract.quoteExactInputSingle.staticCall(paramsSwap1), createTimeout(QUOTE_TIMEOUT_MS, 'Swap 1 quote timed out')]);
                 simAmountIntermediateOut = quoteResult1_MaybeTimed.amountOut; // Assumes struct return, adjust if needed based on ABI
                 if (simAmountIntermediateOut === 0n) throw new Error("Swap 1 sim resulted in 0 output.");
                 console.log(`    Sim: Swap 1 Output: ${ethers.formatUnits(simAmountIntermediateOut, config.USDC_DECIMALS)} USDC`);
             } catch (error) { console.error(`  [Monitor] ❌ Pre-Sim Error (Swap 1): ${error.message}`); simError = error; }

             // Swap 2 with Timeout (only if Swap 1 succeeded)
             if (!simError && simAmountIntermediateOut > 0n) {
                 try {
                     const paramsSwap2 = { tokenIn: tokenIntermediate, tokenOut: tokenOutFinal, amountIn: simAmountIntermediateOut, fee: swapPoolFeeBps, sqrtPriceLimitX96: 0n };
                     console.log(`    Sim: Swap 2 - Attempting staticCall (Single)... Pool: ${swapPoolAddress} Fee: ${swapPoolFeeBps}`);
                     const quoteResult2_MaybeTimed = await Promise.race([quoterContract.quoteExactInputSingle.staticCall(paramsSwap2), createTimeout(QUOTE_TIMEOUT_MS, 'Swap 2 quote timed out')]);
                     simFinalAmountOut = quoteResult2_MaybeTimed.amountOut;
                     if (simFinalAmountOut === 0n) throw new Error("Swap 2 sim resulted in 0 output.");
                     console.log(`    Sim: Swap 2 Output: ${ethers.formatUnits(simFinalAmountOut, config.WETH_DECIMALS)} WETH`);
                 } catch (error) { console.error(`  [Monitor] ❌ Pre-Sim Error (Swap 2): ${error.message}`); simError = error; }
             }

             // Profit & Gas Check (only if both swaps succeeded)
             if (!simError && simFinalAmountOut > 0n) {
                  let estimatedFinalAmountActual = 0n;
                  if (simAmountInInitial > 0n) { estimatedFinalAmountActual = (simFinalAmountOut * intendedBorrowAmount) / simAmountInInitial; }

                  console.log(`    Sim: Est. Final WETH: ${ethers.formatUnits(estimatedFinalAmountActual, config.WETH_DECIMALS)}`);
                  console.log(`    Sim: Repayment Req:   ${ethers.formatUnits(requiredRepaymentAmount, config.WETH_DECIMALS)}`);

                  if (estimatedFinalAmountActual > requiredRepaymentAmount) {
                      estimatedProfitWei = estimatedFinalAmountActual - requiredRepaymentAmount;
                      console.log(`  [Monitor] Gross Profit Found: ${ethers.formatUnits(estimatedProfitWei, config.WETH_DECIMALS)} WETH`);

                      // Use configured MIN_NET_PROFIT_WEI
                      const requiredProfitAfterGas = estimatedGasCost + config.MIN_NET_PROFIT_WEI;

                      console.log(`    Gas: Est. Max Cost: ~${ethers.formatUnits(estimatedGasCost, 'ether')} ETH`);
                      console.log(`    Gas: Required Profit > Gas + Min Net: ${ethers.formatUnits(requiredProfitAfterGas, config.WETH_DECIMALS)} WETH`);

                      if (estimatedProfitWei > requiredProfitAfterGas) {
                           console.log(`  [Monitor] ✅ NET Profit Check SUCCESS: Est. Net ~${ethers.formatUnits(estimatedProfitWei - estimatedGasCost, config.WETH_DECIMALS)} WETH`);
                           proceedToAttempt = true;
                      } else { console.log(`  [Monitor] ❌ NET Profit Check FAIL: Gross Profit <= Required`); }
                  } else { console.log(`  [Monitor] ❌ Gross Profit Check FAIL: Final <= Repayment.`); }
             } else if (!simError && simAmountIntermediateOut === 0n) { console.log("  [Monitor] Skipping profit check as Swap 1 yielded zero."); }
             // else: simError occurred and was logged

        } else if (startPoolId) { console.log(`  [Monitor] Skipping simulation due to zero liquidity.`); }


        // --- Trigger Arbitrage Attempt ---
        console.log("  [Monitor] Entering Trigger Block...");
        if (proceedToAttempt && startPoolId) {
             console.log("  [Monitor] Conditions met. Triggering attemptArbitrage.");
             state.opportunity = { startPool: startPoolId, profit: estimatedProfitWei };
             await attemptArbitrage(state);
        } else if (startPoolId) { console.log("  [Monitor] Not proceeding (Sim failed or unprofitable NET)."); }
        else { console.log("  [Monitor] Not proceeding (No opportunity)."); }
        console.log("  [Monitor] Exiting Trigger Block.");

    } catch (error) {
        console.error(`[Monitor] CRITICAL Error during monitoring cycle:`, error);
    } finally {
         console.log(`[Monitor] ${new Date().toISOString()} - Cycle End.`);
    }
} // <<< END async function monitorPools

module.exports = { monitorPools };
