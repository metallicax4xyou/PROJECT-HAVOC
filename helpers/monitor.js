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
    const fetchStartTime = Date.now();

    try {
        // --- Build Promises ---
        console.log(`  [Monitor-${networkName}] Building promises for data fetch...`);
        const promisesToSettle = [];
        const promiseLabels = [];

        try {
            // Add fee data promise
            console.log("    [DEBUG] Adding Fee Data promise...");
            promisesToSettle.push(provider.getFeeData());
            promiseLabels.push("Fee Data");
            console.log("    [DEBUG] Fee Data promise added.");

            // Add pool state promises
            for (const pool of poolsToMonitor) {
                console.log(`    [DEBUG] Adding promises for Pool ${pool.id}...`);
                if (!pool.contract) {
                     console.warn(`    [DEBUG] Skipping Pool ${pool.id} - contract instance is null.`);
                     // Add placeholders that will reject, so array length matches later
                     promisesToSettle.push(Promise.reject(new Error(`Contract null for ${pool.id}`)));
                     promiseLabels.push(`Pool ${pool.id} slot0 (skipped)`);
                     promisesToSettle.push(Promise.reject(new Error(`Contract null for ${pool.id}`)));
                     promiseLabels.push(`Pool ${pool.id} liquidity (skipped)`);
                     continue;
                }
                // --- Log before each call ---
                console.log(`      [DEBUG] Calling ${pool.id}.slot0()...`);
                promisesToSettle.push(pool.contract.slot0());
                promiseLabels.push(`Pool ${pool.id} slot0`);
                console.log(`      [DEBUG] Calling ${pool.id}.liquidity()...`);
                promisesToSettle.push(pool.contract.liquidity());
                promiseLabels.push(`Pool ${pool.id} liquidity`);
                console.log(`    [DEBUG] Promises for Pool ${pool.id} added.`);
            }
        } catch (promiseCreationError) {
             console.error(`  [Monitor-${networkName}] ❌ ERROR DURING PROMISE CREATION: ${promiseCreationError.message}`);
             // If creation fails, we likely can't proceed with Promise.allSettled
             return;
        }

        console.log(`  [Monitor-${networkName}] All promises built (${promisesToSettle.length}). Starting fetch...`);

        // --- Execute with Timeout ---
        let results = null;
        try {
             const raceWinner = await Promise.race([ // Capture the winner
                Promise.allSettled(promisesToSettle).then(res => ({ type: 'allSettled', value: res })), // Wrap result
                createTimeout(FETCH_TIMEOUT_MS, `State/Fee fetching timed out after ${FETCH_TIMEOUT_MS}ms`).then(() => ({ type: 'timeout' })) // Wrap timeout
            ]);

            const fetchEndTime = Date.now();
            console.log(`  [Monitor-${networkName}] Fetch race finished (Duration: ${fetchEndTime - fetchStartTime}ms). Winner: ${raceWinner.type}`);

            if (raceWinner.type === 'timeout') {
                 console.error(`  [Monitor-${networkName}] ❌ FETCH TIMEOUT.`);
                 return; // Exit cycle on timeout
            }
            // If allSettled won, assign its value
            results = raceWinner.value;

        } catch (raceError) {
            // This catch block might not be strictly necessary with the .then wrapping, but good practice
            const fetchEndTime = Date.now();
            console.error(`  [Monitor-${networkName}] ❌ UNEXPECTED RACE ERROR after ${fetchEndTime - fetchStartTime}ms: ${raceError.message}`);
            return;
        }

        // --- Process Results ---
        // Add extra check here
        if (results === null || typeof results === 'undefined') {
             throw new Error(`Fetch results variable is null or undefined after race.`);
        }
        if (!Array.isArray(results) || results.length !== promisesToSettle.length) {
             throw new Error(`Fetch results invalid. Expected ${promisesToSettle.length} array items, Got: ${JSON.stringify(results)}`);
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
        // ... (rest of processing remains the same) ...
        const feeDataResult = results[0];
        if (feeDataResult?.status === 'fulfilled') { feeData = feeDataResult.value; }
        else { throw new Error(`Failed Fetch: Fee Data - ${feeDataResult?.reason?.message || 'Reason N/A'}`); }
        const currentMaxFeePerGas = feeData?.maxFeePerGas || 0n;
        if (currentMaxFeePerGas <= 0n) { throw new Error(`Invalid maxFeePerGas (${currentMaxFeePerGas})`); }
        console.log(`  [Monitor-${networkName}] Fee Data OK: maxFeePerGas=${ethers.formatUnits(currentMaxFeePerGas, 'gwei')} Gwei`);

        // Extract Pool Data
        // ... (rest of processing remains the same) ...
         let resultIndex = 1;
        for (const pool of poolsToMonitor) {
            const slotResult = results[resultIndex++];
            const liqResult = results[resultIndex++];
            // ... safe processing ...
             if (slotResult.status !== 'fulfilled' || liqResult.status !== 'fulfilled') {
                 poolStates[pool.id] = { valid: false };
             } else if (BigInt(liqResult.value || 0) === 0n) {
                poolStates[pool.id] = { valid: false };
             } else {
                const slot = slotResult.value;
                const liq = BigInt(liqResult.value);
                poolStates[pool.id] = { valid: true, slot: slot, liquidity: liq, tick: Number(slot.tick) };
                console.log(`  [Monitor-${networkName}] Pool ${pool.id} State OK: Tick=${poolStates[pool.id].tick}, Liquidity=${liq.toString()}`);
            }
        }


        // Calculate Gas Cost
        // ... (remains the same) ...
        const estimatedGasCost = currentMaxFeePerGas * config.GAS_LIMIT_ESTIMATE;
        const nativeCurrency = networkName === 'polygon' ? 'MATIC' : 'ETH';
        console.log(`  [Gas] Estimated Tx Cost: ~${ethers.formatUnits(estimatedGasCost, 'ether')} ${nativeCurrency}`);


        // Pairwise Opportunity Check & Simulation
        // ... (remains the same) ...
        let bestOpportunity = null;
        console.log(`  [Monitor-${networkName}] Starting pairwise pool comparison...`);
        for (let i = 0; i < poolsToMonitor.length; i++) { /* ... */ } // Pairwise loop unchanged


        // Trigger Arbitrage Attempt
        // ... (remains the same) ...
        console.log(`  [Monitor-${networkName}] Entering Trigger Block...`);
        if (bestOpportunity) { /* ... trigger ... */ }
        else { console.log(`  [Monitor-${networkName}] No profitable opportunity found.`); }
        console.log(`  [Monitor-${networkName}] Exiting Trigger Block.`);


    } catch (error) {
        console.error(`[Monitor-${networkName}] CRITICAL Error during cycle processing: ${error.message}`);
    } finally {
        console.log(`[Monitor-${networkName}] ${new Date().toISOString()} - Cycle End.`);
    }
} // <<< END async function monitorPools

module.exports = { monitorPools };
