// helpers/monitor.js - MINIMAL FETCH TEST
const { ethers } = require('ethers'); // Keep ethers for instanceof check

async function monitorPools(state) {
    const { contracts, config } = state;

    // Basic check for contracts
    if (!contracts || !contracts.poolAContract || !contracts.poolBContract) {
        console.error("[Monitor] Minimal Test: Missing contracts in state.");
        return; // Exit if contracts are missing
    }
    const { poolAContract, poolBContract } = contracts;

    console.log(`\n[Monitor Minimal Test] ${new Date().toISOString()} - Starting fetch...`);

    try {
        console.log("  [Monitor Minimal Test] Preparing promises...");
        const promisesToSettle = [
            poolAContract.slot0(),
            poolAContract.liquidity(),
            poolBContract.slot0(),
            poolBContract.liquidity()
        ];
        console.log(`  [Monitor Minimal Test] Calling await Promise.allSettled for ${promisesToSettle.length} promises...`);

        // --- The suspected hanging point ---
        const results = await Promise.allSettled(promisesToSettle);
        // ------------------------------------

        // --- If we reach here, the await completed ---
        console.log("  [Monitor Minimal Test] await Promise.allSettled COMPLETED.");

        // Basic log of results (optional)
        try {
            console.log("  [Monitor Minimal Test] Results:", JSON.stringify(results, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
        } catch (stringifyError) {
            console.error("  [Monitor Minimal Test] Error stringifying results:", stringifyError.message);
            console.log("  [Monitor Minimal Test] Raw Results:", results); // Log raw array if stringify fails
        }

    } catch (error) {
        // Catch errors occurring *outside* Promise.allSettled (less likely for hangs)
        console.error(`[Monitor Minimal Test] CRITICAL Error during fetch block:`, error);
    } finally {
         // This should always execute if the await doesn't hang indefinitely
         console.log(`[Monitor Minimal Test] ${new Date().toISOString()} - Fetch attempt finished.`);
    }
} // <<< END async function monitorPools

module.exports = { monitorPools };
