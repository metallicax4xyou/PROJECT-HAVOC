// helpers/monitor.js
const { ethers } = require('ethers');
const { attemptArbitrage } = require('./arbitrage');

// --- Helper Functions --- (Keep these as they are)
function calculateFlashFee(amountBorrowed, feeBps) { /* ... */ }
function tickToPrice(tick, token0Decimals, token1Decimals) { /* ... */ }

// --- Main Monitoring Function ---
async function monitorPools(state) {
    const { contracts, config } = state;
    const { poolAContract, poolBContract, quoterContract } = contracts;

    if (!poolAContract || !poolBContract || !quoterContract || !config) { /* ... error check ... */ return; }

    const poolADesc = `Pool A (${config.POOL_A_ADDRESS} - ${config.POOL_A_FEE_BPS / 100}%)`;
    const poolBDesc = `Pool B (${config.POOL_B_ADDRESS} - ${config.POOL_B_FEE_BPS / 100}%)`;
    console.log(`\n[Monitor] ${new Date().toISOString()} - Checking ${poolADesc} and ${poolBDesc}...`);

    try {
        // Fetch pool states
        console.log("  [Monitor] Fetching pool states via Promise.allSettled..."); // Log before fetch
        const results = await Promise.allSettled([
            poolAContract.slot0(), poolAContract.liquidity(),
            poolBContract.slot0(), poolBContract.liquidity()
        ]);
        console.log("  [Monitor] Pool state fetch complete."); // Log after fetch

        // Process results
        const slotAResult = results[0], liqAResult = results[1];
        const slotBResult = results[2], liqBResult = results[3];
        let slotA = null, liqA = 0n, slotB = null, liqB = 0n;

        // Assign results safely, logging errors if promises rejected
        if (slotAResult.status === 'fulfilled') slotA = slotAResult.value;
        else console.error(`[Monitor] Failed Fetch: Pool A slot0 - ${slotAResult.reason?.message || slotAResult.reason}`);
        if (liqAResult.status === 'fulfilled') liqA = liqAResult.value;
        else console.error(`[Monitor] Failed Fetch: Pool A liquidity - ${liqAResult.reason?.message || liqAResult.reason}`);
        if (slotBResult.status === 'fulfilled') slotB = slotBResult.value;
        else console.error(`[Monitor] Failed Fetch: Pool B slot0 - ${slotBResult.reason?.message || slotBResult.reason}`);
        if (liqBResult.status === 'fulfilled') liqB = liqBResult.value;
        else console.error(`[Monitor] Failed Fetch: Pool B liquidity - ${liqBResult.reason?.message || liqBResult.reason}`);

        // <<< --- ADDED DEBUG LOGS --- >>>
        console.log("  [DEBUG] Raw Fetch Results:", {
             slotA_status: slotAResult.status,
             liqA_status: liqAResult.status,
             slotB_status: slotBResult.status,
             liqB_status: liqBResult.status,
        });
        console.log("  [DEBUG] Assigned Values:", {
            slotA_tick: slotA?.tick?.toString(), // Use optional chaining and toString
            liqA: liqA.toString(),
            slotB_tick: slotB?.tick?.toString(),
            liqB: liqB.toString(),
        });
        // <<< --- END ADDED DEBUG LOGS --- >>>

        // Log states using assigned values (this log might have been skipped before)
        console.log(`  [Monitor] ${poolADesc} State (Post-Debug): Tick=${slotA?.tick}, Liquidity=${liqA.toString()}`);
        if (liqA === 0n && slotA) console.warn("    ⚠️ Pool A has ZERO active liquidity!");
        console.log(`  [Monitor] ${poolBDesc} State (Post-Debug): Tick=${slotB?.tick}, Liquidity=${liqB.toString()}`);
        if (liqB === 0n && slotB) console.warn("    ⚠️ Pool B has ZERO active liquidity!");

        // Exit check (Now we'll see logs before this hits if fetching failed)
        if (!slotA || !slotB) { // Only need slot0 for basic tick check
             console.log("  [Monitor] Cannot proceed: Missing slot0 data for one or both pools.");
             // Don't return yet if only liquidity failed, might still log ticks
        }
        // Check liquidity specifically before simulation
        if (liqA === 0n || liqB === 0n) {
             console.log("  [Monitor] Cannot proceed with simulation: Zero liquidity detected.");
             // We can still log tick difference below if desired, but don't proceed to quotes
             // return; // Optionally return here to skip tick check too
        }


        // --- Basic Opportunity Check via Ticks ---
        // This requires slotA and slotB to be non-null
        let startPoolId = null;
        let flashLoanPoolFeeBps = 0;
        let swapPoolAddress = ethers.ZeroAddress;
        let swapPoolFeeBps = 0;
        let proceedToAttempt = false;
        let estimatedProfitWei = 0n;

        if (slotA && slotB) { // Check if we have tick data
            const tickA = Number(slotA.tick);
            const tickB = Number(slotB.tick);
            const TICK_DIFF_THRESHOLD = 1;

            if (tickB > tickA + TICK_DIFF_THRESHOLD) { /* ... Set params for Start A ... */ }
            else if (tickA > tickB + TICK_DIFF_THRESHOLD) { /* ... Set params for Start B ... */ }
            else { console.log(`  [Monitor] Tick Check: No significant tick difference.`); }
        } else {
            console.log("  [Monitor] Skipping Tick Check due to missing slot0 data.");
        }


        // --- Accurate Pre-Simulation ---
        // Requires startPoolId AND non-zero liquidity
        if (startPoolId && liqA > 0n && liqB > 0n) {
             console.log(`  [Monitor] Performing multi-quote simulation...`);
             // ... (The rest of the simulation logic using quoteExactInputSingle remains the same) ...
             // ... (try/catch block for simulation) ...
        } else if (startPoolId) {
            console.log(`  [Monitor] Skipping simulation due to zero liquidity.`);
        }


        // --- Trigger Arbitrage Attempt ---
        if (proceedToAttempt && startPoolId) {
             // ... (call attemptArbitrage) ...
        } else if (startPoolId) {
             console.log("  [Monitor] Not proceeding to attemptArbitrage.");
        }

    } catch (error) {
        console.error(`[Monitor] CRITICAL Error during monitoring cycle:`, error);
    } finally {
         console.log(`[Monitor] ${new Date().toISOString()} - Cycle End.`);
    }
}

module.exports = { monitorPools };
