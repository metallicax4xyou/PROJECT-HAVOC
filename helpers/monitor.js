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

        // <<< --- ADDED DEBUG LOG for results array --- >>>
        console.log("  [DEBUG] Raw Promise.allSettled results:", JSON.stringify(results, null, 2));
        // Log length as well
        console.log(`  [DEBUG] results array length: ${results?.length}`);
        // <<< --- END DEBUG LOG --- >>>

        // Check if results is actually an array with the expected length
        if (!Array.isArray(results) || results.length < 4) {
            console.error("  [Monitor] CRITICAL: Promise.allSettled did not return the expected array structure. Results:", results);
            // Prevent accessing undefined elements
             return; // Exit cycle if structure is wrong
        }


        // Process results safely
        let slotA = null, liqA = 0n, slotB = null, liqB = 0n;
        // Access elements ONLY if results array is valid
        const slotAResult = results[0];
        const liqAResult = results[1];
        const slotBResult = results[2];
        const liqBResult = results[3];

        // Add checks for undefined results before accessing .status
        if (slotAResult && slotAResult.status === 'fulfilled') slotA = slotAResult.value;
        else console.error(`[Monitor] Failed Fetch: Pool A slot0 - ${slotAResult?.reason?.message || slotAResult?.reason || 'Result undefined'}`);
        if (liqAResult && liqAResult.status === 'fulfilled') liqA = liqAResult.value;
        else console.error(`[Monitor] Failed Fetch: Pool A liquidity - ${liqAResult?.reason?.message || liqAResult?.reason || 'Result undefined'}`);
        if (slotBResult && slotBResult.status === 'fulfilled') slotB = slotBResult.value;
        else console.error(`[Monitor] Failed Fetch: Pool B slot0 - ${slotBResult?.reason?.message || slotBResult?.reason || 'Result undefined'}`);
        if (liqBResult && liqBResult.status === 'fulfilled') liqB = liqBResult.value;
        else console.error(`[Monitor] Failed Fetch: Pool B liquidity - ${liqBResult?.reason?.message || liqBResult?.reason || 'Result undefined'}`);


        // Log states
        console.log(`  [Monitor] ${poolADesc} State: Tick=${slotA?.tick}, Liquidity=${liqA.toString()}`);
        // ... (rest of the logic remains the same, including commented out simulation) ...


    } catch (error) {
        console.error(`[Monitor] CRITICAL Error during monitoring cycle:`, error);
    } finally {
         console.log(`[Monitor] ${new Date().toISOString()} - Cycle End.`);
    }
}

module.exports = { monitorPools };
