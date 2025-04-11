// helpers/monitor.js
const { ethers } = require('ethers');
const { attemptArbitrage } = require('./arbitrage');

// --- Constants ---
// <<< Use CORRECT Arbitrum Quoter V2 Address >>>
const QUOTER_V2_ADDRESS = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const QUOTE_TIMEOUT_MS = 5000; // Timeout for individual quote calls
const FETCH_TIMEOUT_MS = 30000; // Timeout for combined state/fee fetch

// --- Helper Functions ---
function calculateFlashFee(amountBorrowed, feeBps) {
    const feeBpsBigInt = BigInt(feeBps);
    const denominator = 1000000n; // Uniswap V3 fee denominator
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

// --- Main Monitoring Function ---
async function monitorPools(state) {
    // Destructure state object
    if (!state || !state.contracts || !state.config || !state.provider) {
         console.error("[Monitor] CRITICAL: Invalid or incomplete state object received.");
         return;
    }
    const { contracts, config, provider } = state;
    const { poolAContract, poolBContract, quoterContract } = contracts; // quoterContract uses QUOTER_V2_ADDRESS from config

    // Check specifically for needed contract instances
    if (!poolAContract || !poolBContract || !quoterContract) {
        console.error("[Monitor] CRITICAL: One or more required contract instances missing in state.contracts.");
        console.error(`  poolA: ${!!poolAContract}, poolB: ${!!poolBContract}, quoter: ${!!quoterContract}`);
        return;
    }
    // Verify Quoter address used matches the one we know works
    if (await quoterContract.getAddress() !== QUOTER_V2_ADDRESS) {
         console.error(`[Monitor] CRITICAL: quoterContract address mismatch! Expected ${QUOTER_V2_ADDRESS}, got ${await quoterContract.getAddress()}`);
         return;
    }

    const poolADesc = `Pool A (${config.POOL_A_ADDRESS} - ${config.POOL_A_FEE_BPS / 10000}%)`; // Use 10000 for percentage
    const poolBDesc = `Pool B (${config.POOL_B_ADDRESS} - ${config.POOL_B_FEE_BPS / 10000}%)`; // Use 10000 for percentage
    console.log(`\n[Monitor] ${new Date().toISOString()} - Checking ${poolADesc} and ${poolBDesc}...`);

    let results = null; // Declare results outside try block

    try {
        // --- Fetch pool states and fee data ---
        console.log("  [Monitor] Fetching pool states and fee data...");
        const promisesToSettle = [
            provider.getFeeData(), // Uses provider from state
            poolAContract.slot0(), // Uses poolAContract from state.contracts
            poolAContract.liquidity(),
            poolBContract.slot0(), // Uses poolBContract from state.contracts
            poolBContract.liquidity()
        ];
        console.log(`  [DEBUG] Number of promises created: ${promisesToSettle.length}`);

        // --- Improved Timeout Handling ---
        try {
            results = await Promise.race([ // Assign result here
                Promise.allSettled(promisesToSettle),
                createTimeout(FETCH_TIMEOUT_MS, `State/Fee fetching timed out after ${FETCH_TIMEOUT_MS}ms`)
            ]);
            console.log("  [Monitor] Fetch attempt finished (within timeout window).");
        } catch (timeoutError) {
            console.error(`  [Monitor] ❌ FETCH TIMEOUT: ${timeoutError.message}`);
            results = null; // Explicitly set results to null on timeout
        }

        if (!results || !Array.isArray(results) || results.length < 5) {
             console.error("  [Monitor] Fetch results invalid or timeout occurred. Skipping rest of cycle.");
             return; // Exit cycle
        }
        console.log("  [Monitor] Fetch results received successfully.");

        // Process results
        const feeDataResult = results[0];
        const slotAResult = results[1]; const liqAResult = results[2];
        const slotBResult = results[3]; const liqBResult = results[4];

        // Get Fee Data
        let feeData = null;
        if (feeDataResult?.status === 'fulfilled') { feeData = feeDataResult.value; }
        else { console.error(`[Monitor] Failed Fetch: Fee Data - ${feeDataResult?.reason?.message || 'Reason N/A'}`); return; }

        const currentMaxFeePerGas = feeData.maxFeePerGas || 0n; // Handle null maxFeePerGas
        if (currentMaxFeePerGas <= 0n) {
             console.warn(`[Monitor] Warning: Invalid maxFeePerGas (${currentMaxFeePerGas}). Skipping cycle.`);
             return;
        }
         console.log(`  [Monitor] Fee Data: maxFeePerGas=${ethers.formatUnits(currentMaxFeePerGas, 'gwei')} Gwei`);

        // Calculate Estimated Gas Cost
        const estimatedGasCost = currentMaxFeePerGas * config.GAS_LIMIT_ESTIMATE;
        console.log(`  [Gas] Estimated Tx Cost: ~${ethers.formatUnits(estimatedGasCost, 'ether')} ETH (Using Limit: ${config.GAS_LIMIT_ESTIMATE})`);

        // Process Pool Data
        let slotA = null, liqA = 0n, slotB = null, liqB = 0n;
        if (slotAResult?.status === 'fulfilled') slotA = slotAResult.value; else console.error(`[Monitor] Failed Fetch: Pool A slot0`);
        if (liqAResult?.status === 'fulfilled') liqA = BigInt(liqAResult.value || 0); else console.error(`[Monitor] Failed Fetch: Pool A liquidity`); // Handle null liquidity
        if (slotBResult?.status === 'fulfilled') slotB = slotBResult.value; else console.error(`[Monitor] Failed Fetch: Pool B slot0`);
        if (liqBResult?.status === 'fulfilled') liqB = BigInt(liqBResult.value || 0); else console.error(`[Monitor] Failed Fetch: Pool B liquidity`); // Handle null liquidity

        console.log(`  [Monitor] ${poolADesc} State: Tick=${slotA?.tick}, Liquidity=${liqA.toString()}`);
        console.log(`  [Monitor] ${poolBDesc} State: Tick=${slotB?.tick}, Liquidity=${liqB.toString()}`);

        if (!slotA || !slotB) { console.log("...Missing slot0 data..."); return; }
        if (liqA === 0n || liqB === 0n) { console.log("...Zero liquidity..."); return; }

        // --- Basic Opportunity Check via Ticks ---
        console.log("  [Monitor] Entering Tick Check Block...");
        let startPoolId = null;
        let flashLoanPoolFeeBps = 0;
        let swapPoolAddress = ethers.ZeroAddress; // Address of pool to swap ON (not borrow from)
        let swapPoolFeeBps = 0; // Fee of pool to swap ON
        let tickDelta = 0;

        if (slotA && slotB) {
            const tickA = Number(slotA.tick);
            const tickB = Number(slotB.tick);
            tickDelta = Math.abs(tickA - tickB);
            const TICK_DIFF_THRESHOLD = 1; // Minimum ticks apart to consider

            // If Pool B price (tick) is higher than Pool A, we might:
            // Borrow WETH from A, Swap WETH->USDC on B, Swap USDC->WETH on B, Repay A
            if (tickB > tickA + TICK_DIFF_THRESHOLD) {
                startPoolId = 'A'; flashLoanPoolFeeBps = config.POOL_A_FEE_BPS;
                swapPoolAddress = config.POOL_B_ADDRESS; // Swap occurs on Pool B
                swapPoolFeeBps = config.POOL_B_FEE_BPS; // Use Pool B's fee for swaps
                console.log(`  [Monitor] Tick Check Result: Potential Start A (Swap on Pool B ${swapPoolFeeBps/10000}%)`);
            }
            // If Pool A price (tick) is higher than Pool B, we might:
            // Borrow WETH from B, Swap WETH->USDC on A, Swap USDC->WETH on A, Repay B
            else if (tickA > tickB + TICK_DIFF_THRESHOLD) {
                startPoolId = 'B'; flashLoanPoolFeeBps = config.POOL_B_FEE_BPS;
                swapPoolAddress = config.POOL_A_ADDRESS; // Swap occurs on Pool A
                swapPoolFeeBps = config.POOL_A_FEE_BPS; // Use Pool A's fee for swaps
                console.log(`  [Monitor] Tick Check Result: Potential Start B (Swap on Pool A ${swapPoolFeeBps/10000}%)`);
            } else { console.log(`  [Monitor] Tick Check Result: No significant tick difference (Delta: ${tickDelta}).`); }

            if (startPoolId && tickDelta > 0 && tickDelta <= config.TICK_DELTA_WARNING_THRESHOLD) {
                console.log(`  [Opportunity] Near Miss! Tick Delta: ${tickDelta} (Threshold: ${config.TICK_DELTA_WARNING_THRESHOLD})`);
            }
        } else { console.log("  [Monitor] Tick Check Skipped (Should not happen)."); }
        console.log(`  [Monitor] Exiting Tick Check Block (startPoolId=${startPoolId}).`);


        // --- Accurate Pre-Simulation using quoteExactInput ---
        let proceedToAttempt = false;
        let estimatedProfitWei = 0n;

        if (startPoolId && liqA > 0n && liqB > 0n) {
             console.log(`  [Monitor] Performing multi-quote simulation using quoteExactInput (Sim Amount: ${config.MULTI_QUOTE_SIM_AMOUNT_WETH_STR} WETH)...`);
             const intendedBorrowAmount = config.BORROW_AMOUNT_WETH_WEI;
             const simAmountInInitial = config.MULTI_QUOTE_SIM_AMOUNT_WETH_WEI;
             const tokenInInitial = config.WETH_ADDRESS; // WETH
             const tokenIntermediate = config.USDC_ADDRESS; // USDC
             const tokenOutFinal = config.WETH_ADDRESS; // WETH

             const flashFee = calculateFlashFee(intendedBorrowAmount, flashLoanPoolFeeBps);
             const requiredRepaymentAmount = intendedBorrowAmount + flashFee;
             console.log(`    Sim: Intended Borrow: ${ethers.formatUnits(intendedBorrowAmount, config.WETH_DECIMALS)} WETH`);
             console.log(`    Sim: Flash Fee Est:   ${ethers.formatUnits(flashFee, config.WETH_DECIMALS)} WETH (${flashLoanPoolFeeBps/10000}%)`);
             console.log(`    Sim: Repayment Req:   ${ethers.formatUnits(requiredRepaymentAmount, config.WETH_DECIMALS)} WETH`);

             let simAmountIntermediateOut = 0n;
             let simFinalAmountOut = 0n;
             let simError = null;

             // --- Simulate Swap 1: WETH -> USDC on the target swap pool ---
             try {
                 // Encode path: tokenIn -> fee -> tokenOut
                 const path1 = ethers.solidityPacked(
                     ["address", "uint24", "address"],
                     [tokenInInitial, swapPoolFeeBps, tokenIntermediate]
                 );
                 console.log(`    Sim: Swap 1 Path: ${path1} (Fee: ${swapPoolFeeBps})`);
                 console.log(`    Sim: Swap 1 - Attempting staticCall (quoteExactInput)...`);

                 const quoteResult1_MaybeTimed = await Promise.race([
                     quoterContract.quoteExactInput.staticCall(path1, simAmountInInitial), // Use quoteExactInput
                     createTimeout(QUOTE_TIMEOUT_MS, 'Swap 1 quote timed out')
                 ]);

                 // quoteExactInput returns [amountOut, sqrtPriceX96AfterList, initializedTicksCrossedList, gasEstimate]
                 // We only need amountOut (index 0)
                 simAmountIntermediateOut = quoteResult1_MaybeTimed[0];

                 if (simAmountIntermediateOut === 0n) throw new Error("Swap 1 sim resulted in 0 output.");
                 console.log(`    Sim: Swap 1 Output: ${ethers.formatUnits(simAmountIntermediateOut, config.USDC_DECIMALS)} USDC`);
             } catch (error) {
                 console.error(`  [Monitor] ❌ Pre-Sim Error (Swap 1): ${error.message}`);
                 if (error.code === 'CALL_EXCEPTION') { console.error("     Revert Data:", error.data); }
                 simError = error;
             }

             // --- Simulate Swap 2: USDC -> WETH on the SAME target swap pool ---
             if (!simError && simAmountIntermediateOut > 0n) {
                 try {
                     // Encode path: tokenIn -> fee -> tokenOut
                     const path2 = ethers.solidityPacked(
                         ["address", "uint24", "address"],
                         [tokenIntermediate, swapPoolFeeBps, tokenOutFinal]
                     );
                     console.log(`    Sim: Swap 2 Path: ${path2} (Fee: ${swapPoolFeeBps})`);
                     console.log(`    Sim: Swap 2 - Attempting staticCall (quoteExactInput)...`);

                     const quoteResult2_MaybeTimed = await Promise.race([
                          quoterContract.quoteExactInput.staticCall(path2, simAmountIntermediateOut), // Use quoteExactInput
                         createTimeout(QUOTE_TIMEOUT_MS, 'Swap 2 quote timed out')
                     ]);

                     // quoteExactInput returns [amountOut, sqrtPriceX96AfterList, initializedTicksCrossedList, gasEstimate]
                     simFinalAmountOut = quoteResult2_MaybeTimed[0];

                     if (simFinalAmountOut === 0n) throw new Error("Swap 2 sim resulted in 0 output.");
                     console.log(`    Sim: Swap 2 Output: ${ethers.formatUnits(simFinalAmountOut, config.WETH_DECIMALS)} WETH`);
                 } catch (error) {
                     console.error(`  [Monitor] ❌ Pre-Sim Error (Swap 2): ${error.message}`);
                     if (error.code === 'CALL_EXCEPTION') { console.error("     Revert Data:", error.data); }
                     simError = error;
                 }
             }

             // --- Profit & Gas Check (only if both swaps succeeded) ---
             if (!simError && simFinalAmountOut > 0n) {
                  // Scale simulation result to estimate outcome for actual borrow amount
                  // WARNING: Linear scaling is an approximation, doesn't account for price impact differences.
                  let estimatedFinalAmountActual = 0n;
                  if (simAmountInInitial > 0n) {
                      estimatedFinalAmountActual = (simFinalAmountOut * intendedBorrowAmount) / simAmountInInitial;
                  }

                  console.log(`    Sim: Est. Final WETH (for ${ethers.formatUnits(intendedBorrowAmount, config.WETH_DECIMALS)} borrow): ${ethers.formatUnits(estimatedFinalAmountActual, config.WETH_DECIMALS)}`);
                  console.log(`    Sim: Repayment Req:                ${ethers.formatUnits(requiredRepaymentAmount, config.WETH_DECIMALS)} WETH`);

                  if (estimatedFinalAmountActual > requiredRepaymentAmount) {
                      estimatedProfitWei = estimatedFinalAmountActual - requiredRepaymentAmount;
                      console.log(`  [Monitor] Gross Profit Found: ${ethers.formatUnits(estimatedProfitWei, config.WETH_DECIMALS)} WETH`);

                      const requiredProfitAfterGas = estimatedGasCost + config.MIN_NET_PROFIT_WEI;
                      console.log(`    Gas: Est. Max Cost: ~${ethers.formatUnits(estimatedGasCost, 'ether')} ETH`);
                      console.log(`    Gas: Min Net Profit:  ${ethers.formatUnits(config.MIN_NET_PROFIT_WEI, config.WETH_DECIMALS)} WETH`);
                      console.log(`    Gas: Required Profit > Gas + Min Net: ${ethers.formatUnits(requiredProfitAfterGas, config.WETH_DECIMALS)} WETH`);

                      if (estimatedProfitWei > requiredProfitAfterGas) {
                           console.log(`  [Monitor] ✅ NET Profit Check SUCCESS: Est. Net ~${ethers.formatUnits(estimatedProfitWei - estimatedGasCost, config.WETH_DECIMALS)} WETH`);
                           proceedToAttempt = true;
                      } else { console.log(`  [Monitor] ❌ NET Profit Check FAIL: Gross Profit <= Required (Gas + Min Net)`); }
                  } else { console.log(`  [Monitor] ❌ Gross Profit Check FAIL: Est. Final <= Repayment Req.`); }
             } else if (!simError && simAmountIntermediateOut === 0n) { console.log("  [Monitor] Skipping profit check as Swap 1 yielded zero."); }
             // else: simError occurred and was logged

        } else if (startPoolId) { console.log(`  [Monitor] Skipping simulation due to zero liquidity in one or both pools.`); }


        // --- Trigger Arbitrage Attempt ---
        console.log("  [Monitor] Entering Trigger Block...");
        if (proceedToAttempt && startPoolId) {
             console.log("  [Monitor] Conditions met. Triggering attemptArbitrage.");
             // Set opportunity details on state for attemptArbitrage to use
             state.opportunity = {
                 startPoolId: startPoolId, // 'A' or 'B'
                 tokenBorrowedAddress: config.WETH_ADDRESS,
                 tokenIntermediateAddress: config.USDC_ADDRESS,
                 borrowAmount: config.BORROW_AMOUNT_WETH_WEI,
                 flashLoanPoolAddress: startPoolId === 'A' ? config.POOL_A_ADDRESS : config.POOL_B_ADDRESS,
                 swapPoolAddress: swapPoolAddress, // The pool where swaps happen
                 swapFeeBps: swapPoolFeeBps, // The fee tier for swaps
                 estimatedGrossProfit: estimatedProfitWei // Pass estimated profit
             };
             await attemptArbitrage(state);
             state.opportunity = null; // Clear opportunity after attempt
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
