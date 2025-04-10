// helpers/monitor.js
const { ethers } = require('ethers');
const { attemptArbitrage } = require('./arbitrage');

// --- Helper Functions --- (Defined FIRST)
function calculateFlashFee(amountBorrowed, feeBps) { /* ... */ }
function tickToPrice(tick, token0Decimals, token1Decimals) { /* ... */ }

// --- Main Monitoring Function ---
async function monitorPools(state) {
    const { contracts, config } = state;

    // --- Check state object validity ---
    if (!contracts || !contracts.poolAContract || !contracts.poolBContract || !contracts.quoterContract || !config) {
        console.error("[Monitor] CRITICAL: Invalid state object passed. Missing contracts or config. State:", state);
        return;
    }
    const { poolAContract, poolBContract, quoterContract } = contracts; // Destructure after check
    // --- End Check ---


    const poolADesc = `Pool A (${config.POOL_A_ADDRESS} - ${config.POOL_A_FEE_BPS / 100}%)`;
    const poolBDesc = `Pool B (${config.POOL_B_ADDRESS} - ${config.POOL_B_FEE_BPS / 100}%)`;
    console.log(`\n[Monitor] ${new Date().toISOString()} - Checking ${poolADesc} and ${poolBDesc}...`);

    try {
        // --- Check contract instances before use ---
        console.log("  [DEBUG] Checking contract instances before fetch...");
        if (!(poolAContract instanceof ethers.Contract) || typeof poolAContract.slot0 !== 'function' || typeof poolAContract.liquidity !== 'function') {
            console.error("  [Monitor] ERROR: Pool A contract instance appears invalid or missing methods.");
            return;
        }
         if (!(poolBContract instanceof ethers.Contract) || typeof poolBContract.slot0 !== 'function' || typeof poolBContract.liquidity !== 'function') {
            console.error("  [Monitor] ERROR: Pool B contract instance appears invalid or missing methods.");
            return;
        }
        console.log("  [DEBUG] Contract instances appear valid.");
        // --- End Check ---

        // --- Fetch pool states ---
        console.log("  [Monitor] Fetching pool states...");
        // --- *** ENSURE THIS ARRAY IS CORRECT *** ---
        const promisesToSettle = [
            poolAContract.slot0(),
            poolAContract.liquidity(),
            poolBContract.slot0(),
            poolBContract.liquidity()
        ];
        // --- *** END ENSURE *** ---
        console.log(`  [DEBUG] Number of promises created: ${promisesToSettle.length}`); // Should log 4

        const results = await Promise.allSettled(promisesToSettle); // Pass the defined array
        console.log("  [Monitor] Pool state fetch complete.");

        // Debug log results
        console.log("  [DEBUG] Raw Promise.allSettled results:", JSON.stringify(results, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
        console.log(`  [DEBUG] results array length: ${results?.length}`); // Should log 4

        // Check array structure
        if (!Array.isArray(results) || results.length < 4) {
            console.error("  [Monitor] CRITICAL: Promise.allSettled did not return the expected array structure.");
            return;
        }

        // Process results safely
        let slotA = null, liqA = 0n, slotB = null, liqB = 0n;
        // ... (Assign results safely, checking results[i] and results[i].status) ...
        if (results[0] && results[0].status === 'fulfilled') slotA = results[0].value; else console.error(/*...*/);
        if (results[1] && results[1].status === 'fulfilled') liqA = BigInt(results[1].value); else console.error(/*...*/);
        if (results[2] && results[2].status === 'fulfilled') slotB = results[2].value; else console.error(/*...*/);
        if (results[3] && results[3].status === 'fulfilled') liqB = BigInt(results[3].value); else console.error(/*...*/);

        // Log states
        console.log(`  [Monitor] ${poolADesc} State: Tick=${slotA?.tick}, Liquidity=${liqA.toString()}`);
        console.log(`  [Monitor] ${poolBDesc} State: Tick=${slotB?.tick}, Liquidity=${liqB.toString()}`);

        // Exit checks
        if (!slotA || !slotB) { /*...*/ return; }
        if (liqA === 0n || liqB === 0n) { /*...*/ return; }

        // --- Basic Opportunity Check via Ticks ---
        // ... (Declare startPoolId etc. Check ticks. Log result.) ...
        console.log("  [Monitor] Entering Tick Check Block...");
        let startPoolId = null; /* ... other declarations ... */
        if(slotA && slotB) { /* ... tick comparison logic ... */ }
        console.log(`  [Monitor] Exiting Tick Check Block (startPoolId=${startPoolId}).`);

        // --- Accurate Pre-Simulation (Still Commented Out) ---
        let proceedToAttempt = false; /* ... other declarations ... */
        /* if (startPoolId && ...) { ... simulation logic ... } */

        // --- Trigger Arbitrage Attempt ---
        // ... (Trigger logic. Log results.) ...
        console.log("  [Monitor] Entering Trigger Block...");
        if (proceedToAttempt && startPoolId) { /* ... call attemptArbitrage ... */ }
        else if (startPoolId) { console.log("  [Monitor] Not proceeding (Sim commented out)...");}
        else { console.log("  [Monitor] Not proceeding (No opportunity)..."); }
        console.log("  [Monitor] Exiting Trigger Block.");


    } catch (error) {
        console.error(`[Monitor] CRITICAL Error during monitoring cycle:`, error);
    } finally {
         console.log(`[Monitor] ${new Date().toISOString()} - Cycle End.`);
    }
} // <<< END async function monitorPools

module.exports = { monitorPools };
