// helpers/monitor.js
const { ethers } = require('ethers');
const { attemptArbitrage } = require('./arbitrage');

// --- Helper Functions ---
function calculateFlashFee(amountBorrowed, feeBps) { /* ... */ }
function tickToPrice(tick, token0Decimals, token1Decimals) { /* ... */ }
function createTimeout(ms, message = 'Operation timed out') {
    return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}
const QUOTE_TIMEOUT_MS = 5000; // Timeout for individual quote calls (keep at 5s)
// <<< INCREASED FETCH TIMEOUT >>>
const FETCH_TIMEOUT_MS = 20000; // Increase timeout for combined state/fee fetch (e.g., 20 seconds)

// --- Main Monitoring Function ---
async function monitorPools(state) {
    const { contracts, config, provider } = state;
    // ... (provider/contract checks) ...

    const poolADesc = `Pool A (${config.POOL_A_ADDRESS} - ${config.POOL_A_FEE_BPS / 100}%)`;
    const poolBDesc = `Pool B (${config.POOL_B_ADDRESS} - ${config.POOL_B_FEE_BPS / 100}%)`;
    console.log(`\n[Monitor] ${new Date().toISOString()} - Checking ${poolADesc} and ${poolBDesc}...`);

    try {
        // --- Fetch GAS PRICE concurrently with pool states ---
        console.log("  [Monitor] Fetching pool states and fee data...");
        const promisesToSettle = [
            provider.getFeeData(),
            poolAContract.slot0(), poolAContract.liquidity(),
            poolBContract.slot0(), poolBContract.liquidity()
        ];
        // --- Use Increased FETCH_TIMEOUT_MS ---
        const results = await Promise.race([
            Promise.allSettled(promisesToSettle),
            createTimeout(FETCH_TIMEOUT_MS, 'State/Fee fetching timed out') // Use longer timeout
        ]);
        console.log("  [Monitor] Fetch complete.");

        // Check results array structure (expecting 5)
        if (!Array.isArray(results) || results.length < 5) {
             console.error("  [Monitor] Fetch results invalid (Likely Timeout). Results:", results);
             return; // Exit cycle if fetch timed out or failed structurally
        }

        // Process results
        const feeDataResult = results[0];
        const slotAResult = results[1]; const liqAResult = results[2];
        const slotBResult = results[3]; const liqBResult = results[4];

        // Get Fee Data (Keep checks)
        let feeData = null;
        if (feeDataResult?.status === 'fulfilled') { feeData = feeDataResult.value; /* ... log ... */ }
        else { console.error(/*...*/); return; } // Exit if fee data failed
        const currentMaxFeePerGas = feeData.maxFeePerGas;
        if (!currentMaxFeePerGas || currentMaxFeePerGas === 0n) { /* ... warning/exit ... */ return;}

        // Process Pool Data (Keep checks)
        let slotA = null, liqA = 0n, slotB = null, liqB = 0n;
        // ... (assign results safely) ...
        if (slotAResult?.status === 'fulfilled') slotA = slotAResult.value; else console.error(/*...*/);
        // ... etc ...

        // Log states (Keep)
        console.log(`  [Monitor] ${poolADesc} State: Tick=${slotA?.tick}, Liquidity=${liqA.toString()}`);
        console.log(`  [Monitor] ${poolBDesc} State: Tick=${slotB?.tick}, Liquidity=${liqB.toString()}`);

        // Exit checks (Keep)
        if (!slotA || !slotB) { /*...*/ return; }
        if (liqA === 0n || liqB === 0n) { /*...*/ return; }

        // --- Basic Opportunity Check --- (Keep)
        // ...

        // --- Accurate Pre-Simulation --- (Keep, including internal timeouts)
        // ...

        // --- Trigger Arbitrage Attempt --- (Keep)
        // ...

    } catch (error) {
        // Catch errors from outside the Promise.race or after it resolves incorrectly
        console.error(`[Monitor] CRITICAL Error during monitoring cycle:`, error);
    } finally {
         console.log(`[Monitor] ${new Date().toISOString()} - Cycle End.`);
    }
}

module.exports = { monitorPools };
