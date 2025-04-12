// helpers/monitor.js
const { ethers } = require('ethers');
const { attemptArbitrage } = require('./arbitrage');

// --- Constants ---
const QUOTE_TIMEOUT_MS = 5000;
const FETCH_TIMEOUT_MS = 30000; // 30 seconds

// --- Helper Functions ---
function calculateFlashFee(amountBorrowed, feeBps) { /* ... same ... */ }
function tickToPrice(tick, token0Decimals, token1Decimals) { /* ... same ... */ }
function createTimeout(ms, message = 'Operation timed out') { /* ... same ... */ }

// --- Main Monitoring Function ---
async function monitorPools(state) {
    const { contracts, config, provider, networkName } = state;
    const { poolAContract, poolBContract, poolCContract, quoterContract } = contracts;

    const poolsToMonitor = [];
    if (poolAContract) poolsToMonitor.push({ id: 'A', contract: poolAContract, address: config.POOL_A_ADDRESS, feeBps: config.POOL_A_FEE_BPS });
    if (poolBContract) poolsToMonitor.push({ id: 'B', contract: poolBContract, address: config.POOL_B_ADDRESS, feeBps: config.POOL_B_FEE_BPS });
    if (poolCContract) poolsToMonitor.push({ id: 'C', contract: poolCContract, address: config.POOL_C_ADDRESS, feeBps: config.POOL_C_FEE_BPS });

    if (poolsToMonitor.length < 2) { console.log(`[Monitor-${networkName}] Less than 2 valid pools configured. Skipping.`); return; }
    if (!quoterContract) { console.error(`[Monitor-${networkName}] CRITICAL: Quoter contract instance missing.`); return; }

    const poolDescriptions = poolsToMonitor.map(p => `Pool ${p.id} (${p.feeBps / 10000}%)`).join(', ');
    console.log(`\n[Monitor-${networkName}] ${new Date().toISOString()} - Checking ${poolDescriptions}...`);

    let feeData = null;
    const poolStates = {};
    const fetchStartTime = Date.now(); // Start timer

    try {
        // --- Build Promises ---
        console.log(`  [Monitor-${networkName}] Fetching pool states and fee data...`);
        const promisesToSettle = [];
        const promiseLabels = []; // Keep track of what each promise is

        // Add fee data promise
        promisesToSettle.push(provider.getFeeData());
        promiseLabels.push("Fee Data");

        // Add pool state promises
        poolsToMonitor.forEach(pool => {
            promisesToSettle.push(pool.contract.slot0());
            promiseLabels.push(`Pool ${pool.id} slot0`);
            promisesToSettle.push(pool.contract.liquidity());
            promiseLabels.push(`Pool ${pool.id} liquidity`);
        });
        console.log(`  [DEBUG] Number of promises created: ${promisesToSettle.length}`);

        // --- Execute with Timeout ---
        let results = null;
        try {
             results = await Promise.race([
                Promise.allSettled(promisesToSettle),
                createTimeout(FETCH_TIMEOUT_MS, `State/Fee fetching timed out after ${FETCH_TIMEOUT_MS}ms`)
            ]);
            const fetchEndTime = Date.now();
            console.log(`  [Monitor-${networkName}] Fetch attempt finished (Duration: ${fetchEndTime - fetchStartTime}ms).`);
        } catch (timeoutError) {
            const fetchEndTime = Date.now();
            console.error(`  [Monitor-${networkName}] ❌ FETCH TIMEOUT after ${fetchEndTime - fetchStartTime}ms: ${timeoutError.message}`);
            return; // Exit cycle on timeout
        }

        // --- Process Results ---
        if (!results || !Array.isArray(results) || results.length !== promisesToSettle.length) {
             throw new Error(`Fetch results invalid. Expected ${promisesToSettle.length}, Got: ${results?.length}`);
        }
        console.log(`  [Monitor-${networkName}] Processing ${results.length} fetch results...`);

        // Log status of each promise
        results.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                // console.log(`    [Fetch OK] ${promiseLabels[index]}`); // Optional: Log success
            } else {
                console.warn(`    [Fetch FAIL] ${promiseLabels[index]}: ${result.reason?.message || result.reason || 'Unknown reason'}`);
            }
        });

        // Extract Fee Data (Promise 0)
        const feeDataResult = results[0];
        if (feeDataResult?.status === 'fulfilled') { feeData = feeDataResult.value; }
        else { throw new Error(`Failed Fetch: Fee Data - ${feeDataResult?.reason?.message || 'Reason N/A'}`); }
        const currentMaxFeePerGas = feeData?.maxFeePerGas || 0n;
        if (currentMaxFeePerGas <= 0n) { throw new Error(`Invalid maxFeePerGas (${currentMaxFeePerGas})`); }
        console.log(`  [Monitor-${networkName}] Fee Data OK: maxFeePerGas=${ethers.formatUnits(currentMaxFeePerGas, 'gwei')} Gwei`);

        // Extract Pool Data (Promises 1 onwards)
        let resultIndex = 1;
        for (const pool of poolsToMonitor) {
            const slotResult = results[resultIndex++];
            const liqResult = results[resultIndex++];
            const slot = slotResult?.status === 'fulfilled' ? slotResult.value : null;
            const liq = liqResult?.status === 'fulfilled' ? BigInt(liqResult.value || 0) : 0n;

            if (slotResult.status !== 'fulfilled' || liqResult.status !== 'fulfilled') {
                 console.warn(`  [Monitor-${networkName}] Incomplete fetch for Pool ${pool.id}. Skipping pair checks involving it.`);
                 poolStates[pool.id] = { valid: false }; // Mark as invalid for this cycle
            } else if (liq === 0n) {
                console.warn(`  [Monitor-${networkName}] Zero liquidity for Pool ${pool.id}.`);
                 poolStates[pool.id] = { valid: false }; // Mark as invalid
            }
             else {
                poolStates[pool.id] = { valid: true, slot: slot, liquidity: liq, tick: Number(slot.tick) };
                console.log(`  [Monitor-${networkName}] Pool ${pool.id} State OK: Tick=${poolStates[pool.id].tick}, Liquidity=${liq.toString()}`);
            }
        }

        // --- Calculate Gas Cost (now that feeData is confirmed) ---
        const estimatedGasCost = currentMaxFeePerGas * config.GAS_LIMIT_ESTIMATE;
        const nativeCurrency = networkName === 'polygon' ? 'MATIC' : 'ETH';
        console.log(`  [Gas] Estimated Tx Cost: ~${ethers.formatUnits(estimatedGasCost, 'ether')} ${nativeCurrency}`);


        // --- Pairwise Opportunity Check & Simulation ---
        let bestOpportunity = null;
        console.log(`  [Monitor-${networkName}] Starting pairwise pool comparison...`);

        for (let i = 0; i < poolsToMonitor.length; i++) {
            for (let j = i + 1; j < poolsToMonitor.length; j++) {
                const pool1 = poolsToMonitor[i];
                const pool2 = poolsToMonitor[j];
                const state1 = poolStates[pool1.id];
                const state2 = poolStates[pool2.id];

                // Skip pair if either pool had fetch/liquidity issues
                if (!state1?.valid || !state2?.valid) {
                    console.log(`    [Compare] Skipping pair ${pool1.id}/${pool2.id} (Invalid state)`);
                    continue;
                }

                const tick1 = state1.tick;
                const tick2 = state2.tick;
                const tickDelta = Math.abs(tick1 - tick2);
                const TICK_DIFF_THRESHOLD = 1;

                console.log(`    [Compare] Checking ${pool1.id}(${tick1}) vs ${pool2.id}(${tick2}) | Delta: ${tickDelta}`);

                let startPool = null, swapPool = null;
                if (tick2 > tick1 + TICK_DIFF_THRESHOLD) { startPool = pool1; swapPool = pool2; }
                else if (tick1 > tick2 + TICK_DIFF_THRESHOLD) { startPool = pool2; swapPool = pool1; }
                else { continue; } // No significant difference

                console.log(`      Potential: Start ${startPool.id} -> Swap on ${swapPool.id}`);
                console.log(`      Simulating...`);

                // --- Simulation Logic (remains the same as before) ---
                try {
                    const intendedBorrowAmount = config.BORROW_AMOUNT_WETH_WEI;
                    const simAmountInInitial = config.MULTI_QUOTE_SIM_AMOUNT_WETH_WEI;
                    const tokenInInitial = config.WETH_ADDRESS;
                    const tokenIntermediate = config.USDC_ADDRESS;
                    const tokenOutFinal = config.WETH_ADDRESS;

                    const flashFee = calculateFlashFee(intendedBorrowAmount, startPool.feeBps);
                    const requiredRepaymentAmount = intendedBorrowAmount + flashFee;

                    const path1 = ethers.solidityPacked(["address", "uint24", "address"], [tokenInInitial, swapPool.feeBps, tokenIntermediate]);
                    const quoteResult1 = await Promise.race([ quoterContract.quoteExactInput.staticCall(path1, simAmountInInitial), createTimeout(QUOTE_TIMEOUT_MS, 'Swap 1 quote timeout') ]);
                    const simAmountIntermediateOut = quoteResult1[0];
                    if (simAmountIntermediateOut === 0n) throw new Error("Swap 1 sim: 0 output.");

                    const path2 = ethers.solidityPacked(["address", "uint24", "address"], [tokenIntermediate, swapPool.feeBps, tokenOutFinal]);
                    const quoteResult2 = await Promise.race([ quoterContract.quoteExactInput.staticCall(path2, simAmountIntermediateOut), createTimeout(QUOTE_TIMEOUT_MS, 'Swap 2 quote timeout') ]);
                    const simFinalAmountOut = quoteResult2[0];
                    if (simFinalAmountOut === 0n) throw new Error("Swap 2 sim: 0 output.");

                    let estimatedFinalAmountActual = 0n;
                    if (simAmountInInitial > 0n) estimatedFinalAmountActual = (simFinalAmountOut * intendedBorrowAmount) / simAmountInInitial;

                    console.log(`        Sim Out1: ${ethers.formatUnits(simAmountIntermediateOut, config.USDC_DECIMALS)} USDC | Sim Out2: ${ethers.formatUnits(simFinalAmountOut, config.WETH_DECIMALS)} WETH`);
                    console.log(`        Est Final: ${ethers.formatUnits(estimatedFinalAmountActual, config.WETH_DECIMALS)} | Repay Req: ${ethers.formatUnits(requiredRepaymentAmount, config.WETH_DECIMALS)}`);

                    if (estimatedFinalAmountActual <= requiredRepaymentAmount) { console.log(`        -> Gross Profit Check FAIL.`); continue; }
                    const simGrossProfit = estimatedFinalAmountActual - requiredRepaymentAmount;
                    console.log(`        -> Gross Profit: ${ethers.formatUnits(simGrossProfit, config.WETH_DECIMALS)} WETH`);

                    const requiredProfitAfterGas = estimatedGasCost + config.MIN_NET_PROFIT_WEI;
                    if (simGrossProfit > requiredProfitAfterGas) {
                        const simNetProfit = simGrossProfit - estimatedGasCost;
                        console.log(`        -> ✅✅ NET Profit Check SUCCESS: ~${ethers.formatUnits(simNetProfit, config.WETH_DECIMALS)} WETH`);
                        if (bestOpportunity === null || simNetProfit > bestOpportunity.estimatedNetProfit) {
                            console.log(`        ---> New best opportunity!`);
                            bestOpportunity = { startPool, swapPool, estimatedGrossProfit: simGrossProfit, estimatedNetProfit: simNetProfit };
                        }
                    } else { console.log(`        -> ❌ NET Profit Check FAIL.`); }

                } catch(error) {
                    console.error(`      ❌ Simulation Error (${startPool.id}->${swapPool.id}): ${error.message}`);
                }
                // --- End Simulation Logic ---

            } // End inner loop (j)
        } // End outer loop (i)

        // --- Trigger Arbitrage Attempt ---
        console.log(`  [Monitor-${networkName}] Entering Trigger Block...`);
        if (bestOpportunity) {
            console.log(`  [Monitor] Best opportunity: Start ${bestOpportunity.startPool.id} -> Swap ${bestOpportunity.swapPool.id}. Est Net: ${ethers.formatUnits(bestOpportunity.estimatedNetProfit, config.WETH_DECIMALS)} WETH`);
            state.opportunity = { /* ... fill opportunity data ... */ };
            await attemptArbitrage(state);
            state.opportunity = null;
        } else { console.log(`  [Monitor-${networkName}] No profitable opportunity found.`); }
        console.log(`  [Monitor-${networkName}] Exiting Trigger Block.`);

    } catch (error) {
        // Catch errors from processing results or simulation phase
        console.error(`[Monitor-${networkName}] CRITICAL Error during cycle processing: ${error.message}`);
    } finally {
        console.log(`[Monitor-${networkName}] ${new Date().toISOString()} - Cycle End.`);
    }
} // <<< END async function monitorPools

module.exports = { monitorPools };
