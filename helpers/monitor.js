// helpers/monitor.js
const { ethers } = require('ethers');
const { attemptArbitrage } = require('./arbitrage');

// --- Constants ---
const QUOTE_TIMEOUT_MS = 5000;
const FETCH_TIMEOUT_MS = 30000;

// --- Helper Functions ---
function calculateFlashFee(amountBorrowed, feeBps) { /* ... same ... */ }
function tickToPrice(tick, token0Decimals, token1Decimals) { /* ... same ... */ }
function createTimeout(ms, message = 'Operation timed out') { /* ... same ... */ }

// --- Main Monitoring Function ---
async function monitorPools(state) {
    const { contracts, config, provider, networkName } = state;
    // Destructure potentially 3 pools
    const { poolAContract, poolBContract, poolCContract, quoterContract } = contracts;

    // --- Define Pools to Monitor ---
    const poolsToMonitor = [];
    if (poolAContract) poolsToMonitor.push({ id: 'A', contract: poolAContract, address: config.POOL_A_ADDRESS, feeBps: config.POOL_A_FEE_BPS });
    if (poolBContract) poolsToMonitor.push({ id: 'B', contract: poolBContract, address: config.POOL_B_ADDRESS, feeBps: config.POOL_B_FEE_BPS });
    if (poolCContract) poolsToMonitor.push({ id: 'C', contract: poolCContract, address: config.POOL_C_ADDRESS, feeBps: config.POOL_C_FEE_BPS });

    if (poolsToMonitor.length < 2) {
        console.log(`[Monitor-${networkName}] Less than 2 valid pools configured/initialized. Skipping cycle.`);
        return;
    }
    if (!quoterContract) {
         console.error(`[Monitor-${networkName}] CRITICAL: Quoter contract instance missing.`);
         return;
    }

    const poolDescriptions = poolsToMonitor.map(p => `Pool ${p.id} (${p.address} - ${p.feeBps / 10000}%)`).join(', ');
    console.log(`\n[Monitor-${networkName}] ${new Date().toISOString()} - Checking ${poolDescriptions}...`);

    // --- Fetch states and fee data ---
    let feeData = null;
    const poolStates = {}; // Store slot0 and liquidity per pool id
    try {
        console.log(`  [Monitor-${networkName}] Fetching pool states and fee data...`);
        const promisesToSettle = [ provider.getFeeData() ];
        poolsToMonitor.forEach(pool => {
            promisesToSettle.push(pool.contract.slot0());
            promisesToSettle.push(pool.contract.liquidity());
        });
        console.log(`  [DEBUG] Number of promises created: ${promisesToSettle.length}`);

        const results = await Promise.race([
            Promise.allSettled(promisesToSettle),
            createTimeout(FETCH_TIMEOUT_MS, `State/Fee fetching timed out after ${FETCH_TIMEOUT_MS}ms`)
        ]);

        if (!results || !Array.isArray(results) || results.length !== promisesToSettle.length) {
             throw new Error("Fetch results invalid or timeout occurred.");
        }
         console.log(`  [Monitor-${networkName}] Fetch results received successfully.`);

        // Process Fee Data
        const feeDataResult = results[0];
        if (feeDataResult?.status === 'fulfilled') { feeData = feeDataResult.value; }
        else { throw new Error(`Failed Fetch: Fee Data - ${feeDataResult?.reason?.message || 'Reason N/A'}`); }

        const currentMaxFeePerGas = feeData?.maxFeePerGas || 0n;
        if (currentMaxFeePerGas <= 0n) { throw new Error(`Invalid maxFeePerGas (${currentMaxFeePerGas})`); }
        console.log(`  [Monitor-${networkName}] Fee Data: maxFeePerGas=${ethers.formatUnits(currentMaxFeePerGas, 'gwei')} Gwei`);

        // Process Pool Data
        let resultIndex = 1;
        for (const pool of poolsToMonitor) {
            const slotResult = results[resultIndex++];
            const liqResult = results[resultIndex++];
            const slot = slotResult?.status === 'fulfilled' ? slotResult.value : null;
            const liq = liqResult?.status === 'fulfilled' ? BigInt(liqResult.value || 0) : 0n;

            if (!slot || liq === 0n) {
                 console.warn(`  [Monitor-${networkName}] Incomplete data or zero liquidity for Pool ${pool.id} (${pool.address}).`);
                 // Mark pool as invalid for this cycle? Or handle in comparison loop.
                 poolStates[pool.id] = { slot: null, liquidity: 0n, tick: null }; // Mark as invalid
            } else {
                poolStates[pool.id] = { slot: slot, liquidity: liq, tick: Number(slot.tick) };
                console.log(`  [Monitor-${networkName}] Pool ${pool.id} State: Tick=${poolStates[pool.id].tick}, Liquidity=${liq.toString()}`);
            }
        }

    } catch (fetchError) {
         console.error(`[Monitor-${networkName}] Error during data fetch: ${fetchError.message}`);
         return; // Exit cycle on fetch errors
    }

    // --- Pairwise Opportunity Check & Simulation ---
    let bestOpportunity = null; // Track the best *profitable* opportunity found

    for (let i = 0; i < poolsToMonitor.length; i++) {
        for (let j = i + 1; j < poolsToMonitor.length; j++) {
            const pool1 = poolsToMonitor[i];
            const pool2 = poolsToMonitor[j];
            const state1 = poolStates[pool1.id];
            const state2 = poolStates[pool2.id];

            // Skip pair if any pool had fetch issues
            if (!state1 || !state1.slot || !state2 || !state2.slot) {
                console.log(`  [Compare] Skipping pair ${pool1.id}/${pool2.id} due to missing state.`);
                continue;
            }

            const tick1 = state1.tick;
            const tick2 = state2.tick;
            const tickDelta = Math.abs(tick1 - tick2);
            const TICK_DIFF_THRESHOLD = 1; // Can be network specific in config if needed

             console.log(`  [Compare] Checking ${pool1.id} (Tick ${tick1}) vs ${pool2.id} (Tick ${tick2}). Delta: ${tickDelta}`);

            let startPool = null; // Pool to borrow from
            let swapPool = null; // Pool to swap on

            if (tick2 > tick1 + TICK_DIFF_THRESHOLD) { // Price on Pool2 > Price on Pool1 => Borrow WETH from Pool1, Swap on Pool2
                startPool = pool1;
                swapPool = pool2;
                console.log(`    Potential: Start ${startPool.id} (Borrow ${startPool.feeBps/10000}%), Swap on ${swapPool.id} (${swapPool.feeBps/10000}%)`);
            } else if (tick1 > tick2 + TICK_DIFF_THRESHOLD) { // Price on Pool1 > Price on Pool2 => Borrow WETH from Pool2, Swap on Pool1
                startPool = pool2;
                swapPool = pool1;
                console.log(`    Potential: Start ${startPool.id} (Borrow ${startPool.feeBps/10000}%), Swap on ${swapPool.id} (${swapPool.feeBps/10000}%)`);
            } else {
                console.log(`    No significant tick difference.`);
                continue; // No opportunity for this pair
            }

            // --- Simulation for this pair ---
            console.log(`    Simulating opportunity: Start ${startPool.id} -> Swap ${swapPool.id}...`);
            let simGrossProfit = 0n;
            let simNetProfit = -Infinity; // Use -Infinity to ensure first profitable updates
            let simError = null;

            try {
                 const intendedBorrowAmount = config.BORROW_AMOUNT_WETH_WEI;
                 const simAmountInInitial = config.MULTI_QUOTE_SIM_AMOUNT_WETH_WEI;
                 const tokenInInitial = config.WETH_ADDRESS;
                 const tokenIntermediate = config.USDC_ADDRESS;
                 const tokenOutFinal = config.WETH_ADDRESS;

                 const flashFee = calculateFlashFee(intendedBorrowAmount, startPool.feeBps);
                 const requiredRepaymentAmount = intendedBorrowAmount + flashFee;

                 // Simulate Swap 1: WETH -> USDC on swapPool
                 const path1 = ethers.solidityPacked(["address", "uint24", "address"], [tokenInInitial, swapPool.feeBps, tokenIntermediate]);
                 const quoteResult1 = await Promise.race([
                     quoterContract.quoteExactInput.staticCall(path1, simAmountInInitial),
                     createTimeout(QUOTE_TIMEOUT_MS, `Swap 1 quote timeout (${startPool.id}->${swapPool.id})`)
                 ]);
                 const simAmountIntermediateOut = quoteResult1[0];
                 if (simAmountIntermediateOut === 0n) throw new Error("Swap 1 sim resulted in 0 output.");
                 console.log(`      Sim Swap 1 Out: ${ethers.formatUnits(simAmountIntermediateOut, config.USDC_DECIMALS)} USDC`);

                 // Simulate Swap 2: USDC -> WETH on swapPool
                 const path2 = ethers.solidityPacked(["address", "uint24", "address"], [tokenIntermediate, swapPool.feeBps, tokenOutFinal]);
                  const quoteResult2 = await Promise.race([
                      quoterContract.quoteExactInput.staticCall(path2, simAmountIntermediateOut),
                      createTimeout(QUOTE_TIMEOUT_MS, `Swap 2 quote timeout (${startPool.id}->${swapPool.id})`)
                  ]);
                 const simFinalAmountOut = quoteResult2[0];
                 if (simFinalAmountOut === 0n) throw new Error("Swap 2 sim resulted in 0 output.");
                 console.log(`      Sim Swap 2 Out: ${ethers.formatUnits(simFinalAmountOut, config.WETH_DECIMALS)} WETH`);

                 // Scale simulation result
                 let estimatedFinalAmountActual = 0n;
                 if (simAmountInInitial > 0n) {
                     estimatedFinalAmountActual = (simFinalAmountOut * intendedBorrowAmount) / simAmountInInitial;
                 }

                 console.log(`      Est. Final WETH: ${ethers.formatUnits(estimatedFinalAmountActual, config.WETH_DECIMALS)}`);
                 console.log(`      Repayment Req:   ${ethers.formatUnits(requiredRepaymentAmount, config.WETH_DECIMALS)}`);

                 // Check Gross Profit
                 if (estimatedFinalAmountActual <= requiredRepaymentAmount) {
                     console.log(`      ❌ Gross Profit Check FAIL.`);
                     continue; // Skip to next pair if grossly unprofitable
                 }
                 simGrossProfit = estimatedFinalAmountActual - requiredRepaymentAmount;
                 console.log(`      ✅ Gross Profit Found: ${ethers.formatUnits(simGrossProfit, config.WETH_DECIMALS)} WETH`);

                 // Check Net Profit
                 const estimatedGasCost = (feeData?.maxFeePerGas || 0n) * config.GAS_LIMIT_ESTIMATE;
                 const requiredProfitAfterGas = estimatedGasCost + config.MIN_NET_PROFIT_WEI;
                 const nativeCurrency = networkName === 'polygon' ? 'MATIC' : 'ETH'; // Use state.networkName

                 console.log(`      Gas Cost Est: ~${ethers.formatUnits(estimatedGasCost, 'ether')} ${nativeCurrency}`);
                 console.log(`      Min Net Profit:  ${ethers.formatUnits(config.MIN_NET_PROFIT_WEI, config.WETH_DECIMALS)} WETH`);
                 console.log(`      Required > Gas+Min: ${ethers.formatUnits(requiredProfitAfterGas, config.WETH_DECIMALS)} WETH`);

                 if (simGrossProfit > requiredProfitAfterGas) {
                     simNetProfit = simGrossProfit - estimatedGasCost;
                     console.log(`      ✅✅ NET Profit Check SUCCESS: Est. Net ~${ethers.formatUnits(simNetProfit, config.WETH_DECIMALS)} WETH`);

                     // --- Update Best Opportunity Found So Far ---
                     if (bestOpportunity === null || simNetProfit > bestOpportunity.estimatedNetProfit) {
                          console.log(`      ---> New best opportunity found!`);
                          bestOpportunity = {
                             startPool: startPool, // Contains id, address, feeBps
                             swapPool: swapPool,   // Contains id, address, feeBps
                             estimatedGrossProfit: simGrossProfit,
                             estimatedNetProfit: simNetProfit
                          };
                     }

                 } else {
                     console.log(`      ❌ NET Profit Check FAIL: Gross Profit <= Required.`);
                 }

            } catch(error) {
                simError = error;
                console.error(`    ❌ Simulation Error for ${startPool.id}->${swapPool.id}: ${simError.message}`);
                // Don't proceed with this pair if simulation fails
            }
        } // End inner loop (j)
    } // End outer loop (i)

    // --- Trigger Arbitrage Attempt for the BEST opportunity found ---
    console.log(`  [Monitor-${networkName}] Entering Trigger Block...`);
    if (bestOpportunity) {
         console.log(`  [Monitor-${networkName}] Best opportunity found: Start ${bestOpportunity.startPool.id} -> Swap ${bestOpportunity.swapPool.id}. Est Net: ${ethers.formatUnits(bestOpportunity.estimatedNetProfit, config.WETH_DECIMALS)} WETH`);
         console.log("  [Monitor] Conditions met. Triggering attemptArbitrage.");
         // Set opportunity details on state for attemptArbitrage to use
         state.opportunity = {
             startPoolId: bestOpportunity.startPool.id, // 'A', 'B', or 'C'
             tokenBorrowedAddress: config.WETH_ADDRESS,
             tokenIntermediateAddress: config.USDC_ADDRESS,
             borrowAmount: config.BORROW_AMOUNT_WETH_WEI,
             flashLoanPoolAddress: bestOpportunity.startPool.address,
             swapPoolAddress: bestOpportunity.swapPool.address, // The pool where swaps happen
             swapFeeBps: bestOpportunity.swapPool.feeBps, // The fee tier for swaps
             estimatedGrossProfit: bestOpportunity.estimatedGrossProfit, // Pass estimated profit
             estimatedNetProfit: bestOpportunity.estimatedNetProfit
         };
         await attemptArbitrage(state); // Ensure attemptArbitrage uses these details
         state.opportunity = null; // Clear opportunity after attempt
    } else {
         console.log(`  [Monitor-${networkName}] No profitable opportunity found this cycle.`);
    }
    console.log(`  [Monitor-${networkName}] Exiting Trigger Block.`);

    console.log(`[Monitor-${networkName}] ${new Date().toISOString()} - Cycle End.`);

} // <<< END async function monitorPools

module.exports = { monitorPools };
