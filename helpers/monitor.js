// helpers/monitor.js
const { ethers } = require('ethers');
const { attemptArbitrage } = require('./arbitrage');

function calculateFlashFee(amountBorrowed, feeBps) { /* ... */ }
function tickToPrice(tick, token0Decimals, token1Decimals) { /* ... */ }

async function monitorPools(state) {
    const { contracts, config } = state;
    const { poolAContract, poolBContract, quoterContract } = contracts;

    if (!poolAContract || !poolBContract || !quoterContract || !config) { return; }

    const poolADesc = `Pool A (${config.POOL_A_ADDRESS} - ${config.POOL_A_FEE_BPS / 100}%)`;
    const poolBDesc = `Pool B (${config.POOL_B_ADDRESS} - ${config.POOL_B_FEE_BPS / 100}%)`;
    console.log(`\n[Monitor] ${new Date().toISOString()} - Checking ${poolADesc} and ${poolBDesc}...`);

    try {
        // Fetch pool states
        console.log("  [Monitor] Fetching pool states...");
        const results = await Promise.allSettled([
            poolAContract.slot0(), poolAContract.liquidity(),
            poolBContract.slot0(), poolBContract.liquidity()
        ]);
        console.log("  [Monitor] Pool state fetch complete.");

        // <<< --- UPDATED DEBUG LOG with BigInt replacer --- >>>
        console.log("  [DEBUG] Raw Promise.allSettled results:", JSON.stringify(results, (key, value) =>
            typeof value === 'bigint'
                ? value.toString() // Convert BigInts to strings
                : value // Return other values unchanged
        , 2)); // Indent for readability
        // <<< --- END UPDATED DEBUG LOG --- >>>

        console.log(`  [DEBUG] results array length: ${results?.length}`); // Keep this

        // Check array structure (Keep this)
        if (!Array.isArray(results) || results.length < 4) { /* ... error and return ... */ }

        // Process results safely (Keep this logic)
        let slotA = null, liqA = 0n, slotB = null, liqB = 0n;
        const slotAResult = results[0]; const liqAResult = results[1];
        const slotBResult = results[2]; const liqBResult = results[3];

        // Keep checks for undefined results before accessing .status
        if (slotAResult && slotAResult.status === 'fulfilled') slotA = slotAResult.value; else console.error(/*...*/);
        if (liqAResult && liqAResult.status === 'fulfilled') liqA = BigInt(liqAResult.value); else console.error(/*...*/); // Ensure liqA is BigInt
        if (slotBResult && slotBResult.status === 'fulfilled') slotB = slotBResult.value; else console.error(/*...*/);
        if (liqBResult && liqBResult.status === 'fulfilled') liqB = BigInt(liqBResult.value); else console.error(/*...*/); // Ensure liqB is BigInt

        // Log states (Keep this)
        console.log(`  [Monitor] ${poolADesc} State: Tick=${slotA?.tick}, Liquidity=${liqA.toString()}`);
        // ...

        // Exit checks (Keep this)
        if (!slotA || !slotB) { /*...*/ }
        if (liqA === 0n || liqB === 0n) { /*...*/ }

        // --- Basic Opportunity Check via Ticks --- (Keep this, simulation still commented out)
        console.log("  [Monitor] Entering Tick Check Block...");
        // ... (tick check logic) ...
        console.log(`  [Monitor] Exiting Tick Check Block (startPoolId=${startPoolId}).`);

        // --- Accurate Pre-Simulation (Still Commented Out) ---
        /*
        if (startPoolId && liqA > 0n && liqB > 0n) {
            // ... simulation logic ...
        } else if (startPoolId) { ... }
        */

        // --- Trigger Arbitrage Attempt --- (Keep this)
        console.log("  [Monitor] Entering Trigger Block...");
        // ... (trigger logic) ...
        console.log("  [Monitor] Exiting Trigger Block.");


    } catch (error) {
        console.error(`[Monitor] CRITICAL Error during monitoring cycle:`, error);
    } finally {
         console.log(`[Monitor] ${new Date().toISOString()} - Cycle End.`);
    }
}

module.exports = { monitorPools };
