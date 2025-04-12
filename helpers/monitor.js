// helpers/monitor.js
const { ethers } = require('ethers');
const { attemptArbitrage } = require('./arbitrage'); // Assuming arbitrage.js is also updated

// --- Constants ---
const QUOTE_TIMEOUT_MS = 5000;
const FETCH_TIMEOUT_MS = 30000;

// --- Helper Functions ---
function calculateFlashFee(amountBorrowed, feeBps) { /* ... same ... */ }
function createTimeout(ms, message = 'Operation timed out') { /* ... same ... */ }

// --- Main Monitoring Function ---
async function monitorPools(state) {
    const { contracts, config, provider, networkName } = state;
    const { poolContracts, quoterContract } = contracts; // Get map of pool contracts

    if (Object.keys(poolContracts).length < 2) { console.log(`[Monitor-${networkName}] Less than 2 pool contracts initialized. Skipping.`); return; }
    if (!quoterContract) { console.error(`[Monitor-${networkName}] CRITICAL: Quoter contract instance missing.`); return; }

    console.log(`\n[Monitor-${networkName}] ${new Date().toISOString()} - Checking ${Object.keys(config.POOL_GROUPS).length} pool groups...`);

    let feeData = null;
    const fetchStartTime = Date.now();

    try {
        // --- Fetch Global Fee Data ---
        console.log(`  [Monitor-${networkName}] Fetching fee data...`);
        try {
            feeData = await Promise.race([
                provider.getFeeData(),
                createTimeout(FETCH_TIMEOUT_MS / 2, 'Fee data fetch timeout') // Shorter timeout for just fee data
            ]);
            if (feeData instanceof Error) throw feeData; // Throw timeout error
        } catch (err) { throw new Error(`Failed Fetch: Fee Data - ${err.message}`); }

        const currentMaxFeePerGas = feeData?.maxFeePerGas || 0n;
        if (currentMaxFeePerGas <= 0n) { throw new Error(`Invalid maxFeePerGas (${currentMaxFeePerGas})`); }
        console.log(`  [Monitor-${networkName}] Fee Data OK: maxFeePerGas=${ethers.formatUnits(currentMaxFeePerGas, 'gwei')} Gwei`);
        const estimatedGasCost = currentMaxFeePerGas * config.GAS_LIMIT_ESTIMATE; // Calculate once
        const nativeCurrency = networkName === 'polygon' ? 'MATIC' : 'ETH';
        console.log(`  [Gas] Base Estimated Tx Cost: ~${ethers.formatUnits(estimatedGasCost, 'ether')} ${nativeCurrency}`);

        // --- Iterate Through Pool Groups ---
        let bestOpportunityOverall = null;

        for (const groupKey in config.POOL_GROUPS) {
            const group = config.POOL_GROUPS[groupKey];
            console.log(`\n  --- Group: ${groupKey} (${group.token0Address.substring(0,6)}... / ${group.token1Address.substring(0,6)}...) ---`);

            if (!group || !Array.isArray(group.pools) || group.pools.length < 2) {
                console.log(`    Skipping group ${groupKey} - requires at least 2 pools.`);
                continue;
            }

            // --- Fetch States for Pools in this Group ---
            const poolStates = {}; // { poolAddress: { valid, slot, liquidity, tick } }
            const promisesThisGroup = [];
            const labelsThisGroup = [];
            const poolsInGroup = []; // Store poolInfo objects { address, feeBps }

            group.pools.forEach(poolInfo => {
                const poolContract = poolContracts[poolInfo.address]; // Get instance from map
                if (poolContract && typeof poolContract.slot0 === 'function' && typeof poolContract.liquidity === 'function') {
                     promisesThisGroup.push(poolContract.slot0());
                     labelsThisGroup.push(`${groupKey}-${poolInfo.feeBps}-slot0`);
                     promisesThisGroup.push(poolContract.liquidity());
                     labelsThisGroup.push(`${groupKey}-${poolInfo.feeBps}-liq`);
                     poolsInGroup.push(poolInfo); // Add valid pool to list for this group
                } else {
                    console.warn(`    Skipping pool ${poolInfo.address} in group ${groupKey} - contract invalid or missing functions.`);
                }
            });

            if (poolsInGroup.length < 2) {
                 console.log(`    Skipping group ${groupKey} - less than 2 valid pools found.`);
                 continue;
            }

            console.log(`    Fetching states for ${poolsInGroup.length} pools in group ${groupKey}...`);
            let groupResults = null;
            try {
                 groupResults = await Promise.race([
                     Promise.allSettled(promisesThisGroup),
                     createTimeout(FETCH_TIMEOUT_MS / 2, `Pool state fetch timeout for group ${groupKey}`) // Shorter timeout per group
                 ]);
                 if (groupResults instanceof Error) throw groupResults; // Throw timeout error
            } catch (groupFetchError) {
                 console.error(`    ❌ FETCH FAILED for group ${groupKey}: ${groupFetchError.message}`);
                 continue; // Skip to next group
            }

            if (!Array.isArray(groupResults) || groupResults.length !== promisesThisGroup.length) {
                  console.error(`    ❌ Invalid results structure for group ${groupKey}.`);
                  continue; // Skip to next group
            }

             // Process results for this group
             let resultIndex = 0;
             let groupFetchOk = true;
             for (const poolInfo of poolsInGroup) {
                  const slotResult = groupResults[resultIndex++];
                  const liqResult = groupResults[resultIndex++];

                  if (slotResult.status !== 'fulfilled' || liqResult.status !== 'fulfilled') {
                      const reason = slotResult.reason?.message || liqResult.reason?.message || 'Unknown';
                      console.warn(`      Pool ${poolInfo.feeBps}bps Fetch FAIL: ${reason}`);
                      poolStates[poolInfo.address] = { valid: false };
                      groupFetchOk = false;
                  } else {
                      const liq = BigInt(liqResult.value || 0);
                      const slot = slotResult.value;
                       if (!slot || typeof slot.tick === 'undefined' || liq === 0n) {
                           console.warn(`      Pool ${poolInfo.feeBps}bps Invalid State: Liquidity=${liq}, Slot invalid=${!slot || typeof slot.tick === 'undefined'}`);
                           poolStates[poolInfo.address] = { valid: false };
                           groupFetchOk = false;
                       } else {
                           poolStates[poolInfo.address] = { valid: true, slot: slot, liquidity: liq, tick: Number(slot.tick), feeBps: poolInfo.feeBps };
                           console.log(`      Pool ${poolInfo.feeBps}bps State OK: Tick=${poolStates[poolInfo.address].tick}, Liq=${liq.toString()}`);
                       }
                  }
             }
             if (!groupFetchOk) { console.log(`    Skipping comparisons for group ${groupKey} due to fetch errors.`); continue; }


            // --- Pairwise Comparison within the Group ---
            console.log(`    Comparing pairs in group ${groupKey}...`);
            for (let i = 0; i < poolsInGroup.length; i++) {
                for (let j = i + 1; j < poolsInGroup.length; j++) {
                    const poolInfo1 = poolsInGroup[i];
                    const poolInfo2 = poolsInGroup[j];
                    const state1 = poolStates[poolInfo1.address];
                    const state2 = poolStates[poolInfo2.address];

                    // Should be valid based on check above, but double-check
                    if (!state1?.valid || !state2?.valid) continue;

                    const tick1 = state1.tick;
                    const tick2 = state2.tick;
                    const tickDelta = Math.abs(tick1 - tick2);
                    const TICK_DIFF_THRESHOLD = 1; // Could make this group-specific

                    console.log(`      Compare ${poolInfo1.feeBps}bps(${tick1}) vs ${poolInfo2.feeBps}bps(${tick2}) | Delta: ${tickDelta}`);

                    let startPoolInfo = null, swapPoolInfo = null; // Pool definitions from config
                    let startPoolState = null, swapPoolState = null; // Live states

                    if (tick2 > tick1 + TICK_DIFF_THRESHOLD) { // Price Pool2 > Price Pool1 => Borrow T0/T1 from Pool1, Swap on Pool2
                        startPoolInfo = poolInfo1; startPoolState = state1;
                        swapPoolInfo = poolInfo2; swapPoolState = state2;
                    } else if (tick1 > tick2 + TICK_DIFF_THRESHOLD) { // Price Pool1 > Price Pool2 => Borrow T0/T1 from Pool2, Swap on Pool1
                        startPoolInfo = poolInfo2; startPoolState = state2;
                        swapPoolInfo = poolInfo1; swapPoolState = state1;
                    } else { continue; } // No opportunity

                    console.log(`        Potential: Start ${startPoolInfo.feeBps}bps -> Swap on ${swapPoolInfo.feeBps}bps`);
                    console.log(`        Simulating...`);

                    // --- Simulation Logic ---
                    try {
                        // Determine which token to borrow (assume WETH for WETH/USDC, Token0 for USDC/USDT for now)
                        // More robust logic needed for generic pairs
                        let tokenToBorrowAddress, tokenIntermediateAddress, borrowAmount, borrowDecimals, intermediateDecimals;
                        if (groupKey === 'WETH_USDC') {
                             tokenToBorrowAddress = config.TOKENS.WETH;
                             tokenIntermediateAddress = config.TOKENS.USDC;
                             borrowAmount = config.BORROW_AMOUNT_WEI; // Assumes WETH borrow amount
                             borrowDecimals = config.DECIMALS[tokenToBorrowAddress];
                             intermediateDecimals = config.DECIMALS[tokenIntermediateAddress];
                             // Multi quote sim amount also needs context
                             simAmountInInitial = config.MULTI_QUOTE_SIM_AMOUNT_WEI; // Assumes WETH
                        } else if (groupKey === 'USDC_USDT') {
                             // For stable/stable, flash loaning USDC might make sense
                             tokenToBorrowAddress = config.TOKENS.USDC;
                             tokenIntermediateAddress = config.TOKENS.USDT;
                             borrowDecimals = config.DECIMALS[tokenToBorrowAddress];
                             intermediateDecimals = config.DECIMALS[tokenIntermediateAddress];
                             // *** NEED TO DEFINE BORROW AMOUNT FOR STABLES ***
                             // Let's use a fixed USD value for simulation? e.g., $1000
                             borrowAmount = ethers.parseUnits("1000", borrowDecimals); // Borrow 1000 USDC
                             simAmountInInitial = ethers.parseUnits("1", borrowDecimals); // Simulate with 1 USDC
                             console.log(`        Stable Sim: Borrow ${ethers.formatUnits(borrowAmount, borrowDecimals)} ${groupKey.split('_')[0]}`);
                        } else {
                             console.warn(`        Skipping simulation - unsupported group key ${groupKey}`);
                             continue;
                        }

                        const flashFee = calculateFlashFee(borrowAmount, startPoolInfo.feeBps);
                        const requiredRepaymentAmount = borrowAmount + flashFee;

                        // Swap 1: Borrowed -> Intermediate on swapPool
                        const path1 = ethers.solidityPacked(["address", "uint24", "address"], [tokenToBorrowAddress, swapPoolInfo.feeBps, tokenIntermediateAddress]);
                        const quoteResult1 = await Promise.race([ quoterContract.quoteExactInput.staticCall(path1, simAmountInInitial), createTimeout(QUOTE_TIMEOUT_MS, 'Swap 1 quote timeout') ]);
                        const simAmountIntermediateOut = quoteResult1[0];
                        if (simAmountIntermediateOut === 0n) throw new Error("Swap 1 sim: 0 output.");

                        // Swap 2: Intermediate -> Borrowed on swapPool
                        const path2 = ethers.solidityPacked(["address", "uint24", "address"], [tokenIntermediateAddress, swapPoolInfo.feeBps, tokenToBorrowAddress]);
                        const quoteResult2 = await Promise.race([ quoterContract.quoteExactInput.staticCall(path2, simAmountIntermediateOut), createTimeout(QUOTE_TIMEOUT_MS, 'Swap 2 quote timeout') ]);
                        const simFinalAmountOut = quoteResult2[0];
                        if (simFinalAmountOut === 0n) throw new Error("Swap 2 sim: 0 output.");

                        let estimatedFinalAmountActual = 0n;
                        if (simAmountInInitial > 0n) estimatedFinalAmountActual = (simFinalAmountOut * borrowAmount) / simAmountInInitial;

                        console.log(`        Sim Out1: ${ethers.formatUnits(simAmountIntermediateOut, intermediateDecimals)} | Sim Out2: ${ethers.formatUnits(simFinalAmountOut, borrowDecimals)}`);
                        console.log(`        Est Final: ${ethers.formatUnits(estimatedFinalAmountActual, borrowDecimals)} | Repay Req: ${ethers.formatUnits(requiredRepaymentAmount, borrowDecimals)}`);

                        if (estimatedFinalAmountActual <= requiredRepaymentAmount) { console.log(`        -> Gross Profit Check FAIL.`); continue; }
                        const simGrossProfit = estimatedFinalAmountActual - requiredRepaymentAmount;
                        console.log(`        -> Gross Profit: ${ethers.formatUnits(simGrossProfit, borrowDecimals)}`);

                        // Convert gross profit to WETH for net profit check if needed (requires price feed)
                        // For now, compare gross profit in its own token vs gas cost in native token (approximation)
                        // TODO: Implement price conversion for accurate net profit check across pairs
                        const minNetProfitWei = config.MIN_NET_PROFIT_WEI_CALCULATED; // Use the calculated one

                        // Very rough check: Is gross profit (in borrow token) > gas cost (in native)?
                        // This isn't ideal but avoids needing a price feed immediately
                        // Let's assume 1 borrow token ~= X native token for check
                        // A better check requires converting gas cost to borrow token value
                        const TEMP_PROFIT_CHECK_THRESHOLD_WEI = estimatedGasCost + minNetProfitWei;

                         // If borrowing WETH, compare directly
                         if (tokenToBorrowAddress.toLowerCase() === config.TOKENS.WETH.toLowerCase()) {
                              if (simGrossProfit > TEMP_PROFIT_CHECK_THRESHOLD_WEI) {
                                   const simNetProfit = simGrossProfit - estimatedGasCost; // Approx net profit in WETH
                                   console.log(`        -> ✅✅ NET Profit Check SUCCESS (WETH): ~${ethers.formatUnits(simNetProfit, borrowDecimals)} WETH`);
                                    if (bestOpportunityOverall === null || simNetProfit > bestOpportunityOverall.estimatedNetProfit) { // Compare WETH net profit
                                         console.log(`        ---> New best overall opportunity!`);
                                         bestOpportunityOverall = { groupKey, startPoolInfo, swapPoolInfo, estimatedGrossProfit: simGrossProfit, estimatedNetProfit: simNetProfit, tokenBorrowedAddress, tokenIntermediateAddress, borrowAmount };
                                    }
                              } else { console.log(`        -> ❌ NET Profit Check FAIL (WETH vs Gas+Min).`); }
                         } else {
                             // If borrowing stables, need price feed for accurate check vs gas
                             console.log(`        -> Net Profit Check SKIPPED (Requires price feed for ${groupKey})`);
                             // Could potentially trigger if gross profit is very high as a heuristic
                             const HIGH_STABLE_PROFIT_THRESHOLD = ethers.parseUnits("0.5", borrowDecimals); // e.g., > $0.50 gross profit?
                             if (simGrossProfit > HIGH_STABLE_PROFIT_THRESHOLD) {
                                  console.log(`        -> ✅ Gross Profit High (Stablecoin) - CONSIDERED OPPORTUNITY (Net check approximate)`);
                                  // Store this, but maybe prioritize WETH profits? Need ranking logic.
                                  // For now, just log, don't set bestOpportunityOverall unless we refine ranking
                             } else {
                                 console.log(`        -> Gross Profit Low (Stablecoin)`);
                             }
                         }

                    } catch(error) { console.error(`      ❌ Simulation Error (${startPoolInfo.feeBps}->${swapPoolInfo.feeBps}): ${error.message}`); }
                    // --- End Simulation Logic ---

                } // End inner loop (j)
            } // End outer loop (i) for group

        } // End group loop

        // --- Trigger Arbitrage Attempt for the BEST overall opportunity ---
        console.log(`\n  [Monitor-${networkName}] Entering Trigger Block...`);
        if (bestOpportunityOverall) {
            console.log(`  [Monitor] Best overall opportunity: ${bestOpportunityOverall.groupKey} Start ${bestOpportunityOverall.startPoolInfo.feeBps}bps -> Swap ${bestOpportunityOverall.swapPoolInfo.feeBps}bps.`);
            console.log(`          Est Net: ${ethers.formatUnits(bestOpportunityOverall.estimatedNetProfit, 18)} WETH`); // Assuming WETH profit for now
            state.opportunity = {
                 startPoolId: bestOpportunityOverall.startPoolInfo.feeBps, // Pass fee as ID? Or need unique ID
                 tokenBorrowedAddress: bestOpportunityOverall.tokenBorrowedAddress,
                 tokenIntermediateAddress: bestOpportunityOverall.tokenIntermediateAddress,
                 borrowAmount: bestOpportunityOverall.borrowAmount,
                 flashLoanPoolAddress: bestOpportunityOverall.startPoolInfo.address,
                 swapPoolAddress: bestOpportunityOverall.swapPoolInfo.address,
                 swapFeeBps: bestOpportunityOverall.swapPoolInfo.feeBps,
                 estimatedGrossProfit: bestOpportunityOverall.estimatedGrossProfit,
                 estimatedNetProfit: bestOpportunityOverall.estimatedNetProfit
             };
            await attemptArbitrage(state);
            state.opportunity = null;
        } else { console.log(`  [Monitor-${networkName}] No profitable opportunity found this cycle.`); }
        console.log(`  [Monitor-${networkName}] Exiting Trigger Block.`);

    } catch (error) {
        console.error(`[Monitor-${networkName}] CRITICAL Error during cycle processing: ${error.message}`);
    } finally {
        console.log(`[Monitor-${networkName}] ${new Date().toISOString()} - Cycle End.`);
    }
}

module.exports = { monitorPools };
