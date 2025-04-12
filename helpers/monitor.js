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
    // Add pools ONLY if the contract instance exists
    if (poolAContract) poolsToMonitor.push({ id: 'A', contract: poolAContract, address: config.POOL_A_ADDRESS, feeBps: config.POOL_A_FEE_BPS });
    if (poolBContract) poolsToMonitor.push({ id: 'B', contract: poolBContract, address: config.POOL_B_ADDRESS, feeBps: config.POOL_B_FEE_BPS });
    if (poolCContract) poolsToMonitor.push({ id: 'C', contract: poolCContract, address: config.POOL_C_ADDRESS, feeBps: config.POOL_C_FEE_BPS });

    if (poolsToMonitor.length < 2) { console.log(`[Monitor-${networkName}] Less than 2 valid pools configured/initialized. Skipping.`); return; }
    if (!quoterContract) { console.error(`[Monitor-${networkName}] CRITICAL: Quoter contract instance missing.`); return; }

    const poolDescriptions = poolsToMonitor.map(p => `Pool ${p.id} (${p.feeBps / 10000}%)`).join(', ');
    console.log(`\n[Monitor-${networkName}] ${new Date().toISOString()} - Checking ${poolDescriptions}...`);

    let feeData = null;
    const poolStates = {};
    const fetchStartTime = Date.now();

    try {
        // --- Build Promises ---
        console.log(`  [Monitor-${networkName}] Building promises for data fetch...`);
        const promisesToSettle = [];
        const promiseLabels = [];

        try {
            // Add fee data promise
            console.log("    [DEBUG] Adding Fee Data promise...");
            if (provider && typeof provider.getFeeData === 'function') {
                promisesToSettle.push(provider.getFeeData());
                promiseLabels.push("Fee Data");
                console.log("    [DEBUG] Fee Data promise added.");
            } else {
                 console.error("    [DEBUG] ERROR: Provider or getFeeData function missing!");
                 throw new Error("Provider missing getFeeData"); // Stop if essential data can't be fetched
            }


            // Add pool state promises
            for (const pool of poolsToMonitor) {
                console.log(`    [DEBUG] Preparing promises for Pool ${pool.id}...`);
                let slot0Promise = null;
                let liquidityPromise = null;

                // --- Check contract and functions EXIST before calling ---
                if (!pool.contract) {
                     console.warn(`    [DEBUG] Skipping Pool ${pool.id} - contract instance is null.`);
                } else {
                    if (typeof pool.contract.slot0 === 'function') {
                         console.log(`      [DEBUG] Adding ${pool.id}.slot0() promise...`);
                         slot0Promise = pool.contract.slot0(); // Call returns a Promise
                    } else {
                         console.error(`      [DEBUG] ERROR: Pool ${pool.id}.slot0 is NOT a function!`);
                    }

                    if (typeof pool.contract.liquidity === 'function') {
                         console.log(`      [DEBUG] Adding ${pool.id}.liquidity() promise...`);
                         liquidityPromise = pool.contract.liquidity(); // Call returns a Promise
                    } else {
                         console.error(`      [DEBUG] ERROR: Pool ${pool.id}.liquidity is NOT a function!`);
                    }
                }

                // Add promises (or rejecting placeholders if calls failed)
                promisesToSettle.push(slot0Promise || Promise.reject(new Error(`Invalid slot0 call for ${pool.id}`)));
                promiseLabels.push(`Pool ${pool.id} slot0`);
                promisesToSettle.push(liquidityPromise || Promise.reject(new Error(`Invalid liquidity call for ${pool.id}`)));
                promiseLabels.push(`Pool ${pool.id} liquidity`);
                console.log(`    [DEBUG] Promises for Pool ${pool.id} added/handled.`);
            }
        } catch (promiseCreationError) {
             console.error(`  [Monitor-${networkName}] ❌ ERROR DURING PROMISE CREATION: ${promiseCreationError.message}`);
             return;
        }

        console.log(`  [Monitor-${networkName}] All promises built (${promisesToSettle.length}). Starting fetch...`);

        // --- Execute with Timeout ---
        let results = null;
        try {
             // Directly await the race, handle results or timeout error
             results = await Promise.race([
                Promise.allSettled(promisesToSettle),
                createTimeout(FETCH_TIMEOUT_MS, `State/Fee fetching timed out after ${FETCH_TIMEOUT_MS}ms`)
            ]);
            // Check if the result is an error object (meaning timeout won)
            if (results instanceof Error) {
                throw results; // Re-throw the timeout error
            }
            const fetchEndTime = Date.now();
            console.log(`  [Monitor-${networkName}] Fetch attempt finished (Duration: ${fetchEndTime - fetchStartTime}ms).`);

        } catch (fetchOrTimeoutError) {
             console.error(`  [Monitor-${networkName}] ❌ FETCH FAILED OR TIMED OUT: ${fetchOrTimeoutError.message}`);
             return; // Exit cycle on timeout or race error
        }

        // --- Process Results ---
        if (!Array.isArray(results) || results.length !== promisesToSettle.length) {
             // This case should ideally not happen if the above try/catch works, but safeguard anyway
             throw new Error(`Fetch results invalid structure. Expected ${promisesToSettle.length} array items, Got: ${JSON.stringify(results)}`);
        }
        console.log(`  [Monitor-${networkName}] Processing ${results.length} fetch results...`);

        // Log status of each promise
        results.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                // console.log(`    [Fetch OK] ${promiseLabels[index]}`);
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

        // Extract Pool Data
        let resultIndex = 1;
        for (const pool of poolsToMonitor) {
            const slotResult = results[resultIndex++];
            const liqResult = results[resultIndex++];
            // Mark as invalid if *either* promise for this pool failed
            if (slotResult.status !== 'fulfilled' || liqResult.status !== 'fulfilled') {
                 console.warn(`  [Monitor-${networkName}] Incomplete fetch for Pool ${pool.id}.`);
                 poolStates[pool.id] = { valid: false };
            } else {
                const liq = BigInt(liqResult.value || 0);
                if (liq === 0n) {
                    console.warn(`  [Monitor-${networkName}] Zero liquidity for Pool ${pool.id}.`);
                    poolStates[pool.id] = { valid: false };
                } else {
                    const slot = slotResult.value;
                    poolStates[pool.id] = { valid: true, slot: slot, liquidity: liq, tick: Number(slot.tick) };
                    console.log(`  [Monitor-${networkName}] Pool ${pool.id} State OK: Tick=${poolStates[pool.id].tick}, Liquidity=${liq.toString()}`);
                }
            }
        }

        // Calculate Gas Cost
        const estimatedGasCost = currentMaxFeePerGas * config.GAS_LIMIT_ESTIMATE;
        const nativeCurrency = networkName === 'polygon' ? 'MATIC' : 'ETH';
        console.log(`  [Gas] Estimated Tx Cost: ~${ethers.formatUnits(estimatedGasCost, 'ether')} ${nativeCurrency}`);

        // Pairwise Opportunity Check & Simulation
        // ... (logic remains the same) ...
        let bestOpportunity = null;
        console.log(`  [Monitor-${networkName}] Starting pairwise pool comparison...`);
        for (let i = 0; i < poolsToMonitor.length; i++) {
             for (let j = i + 1; j < poolsToMonitor.length; j++) {
                 const pool1 = poolsToMonitor[i];
                 const pool2 = poolsToMonitor[j];
                 const state1 = poolStates[pool1.id];
                 const state2 = poolStates[pool2.id];

                 if (!state1?.valid || !state2?.valid) {
                     console.log(`    [Compare] Skipping pair ${pool1.id}/${pool2.id} (Invalid state)`);
                     continue;
                 }
                 // ... rest of comparison and simulation logic ...
                 const tick1 = state1.tick;
                 const tick2 = state2.tick;
                 const tickDelta = Math.abs(tick1 - tick2);
                 const TICK_DIFF_THRESHOLD = 1;
                 console.log(`    [Compare] Checking ${pool1.id}(${tick1}) vs ${pool2.id}(${tick2}) | Delta: ${tickDelta}`);
                 let startPool = null, swapPool = null;
                 if (tick2 > tick1 + TICK_DIFF_THRESHOLD) { startPool = pool1; swapPool = pool2; }
                 else if (tick1 > tick2 + TICK_DIFF_THRESHOLD) { startPool = pool2; swapPool = pool1; }
                 else { continue; }
                 console.log(`      Potential: Start ${startPool.id} -> Swap on ${swapPool.id}`);
                 console.log(`      Simulating...`);
                 try { /* ... simulation logic ... */ } catch(error) { /* ... error handling ... */ }
             }
         }


        // Trigger Arbitrage Attempt
        // ... (logic remains the same) ...
        console.log(`  [Monitor-${networkName}] Entering Trigger Block...`);
        if (bestOpportunity) { /* ... trigger ... */ }
        else { console.log(`  [Monitor-${networkName}] No profitable opportunity found.`); }
        console.log(`  [Monitor-${networkName}] Exiting Trigger Block.`);


    } catch (error) {
        // Catch errors from promise creation, result processing, or simulation phase
        console.error(`[Monitor-${networkName}] CRITICAL Error during cycle processing: ${error.message}`);
    } finally {
        console.log(`[Monitor-${networkName}] ${new Date().toISOString()} - Cycle End.`);
    }
} // <<< END async function monitorPools

module.exports = { monitorPools };
