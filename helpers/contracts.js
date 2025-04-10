// helpers/monitor.js
const { ethers } = require('ethers');
const { attemptArbitrage } = require('./arbitrage');

// --- Helper Functions ---
function calculateFlashFee(amountBorrowed, feeBps) { /* ... */ }
function tickToPrice(tick, token0Decimals, token1Decimals) { /* ... */ }
function createTimeout(ms, message = 'Operation timed out') {
    return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}
const QUOTE_TIMEOUT_MS = 5000;
// <<< INCREASED FETCH TIMEOUT SIGNIFICANTLY >>>
const FETCH_TIMEOUT_MS = 30000; // Try 30 seconds

// --- Main Monitoring Function ---
async function monitorPools(state) {
    // ... (state/contract checks) ...
    const { contracts, config, provider } = state;
    const { poolAContract, poolBContract, quoterContract } = contracts;

    const poolADesc = `Pool A (${config.POOL_A_ADDRESS} - ${config.POOL_A_FEE_BPS / 100}%)`;
    const poolBDesc = `Pool B (${config.POOL_B_ADDRESS} - ${config.POOL_B_FEE_BPS / 100}%)`;
    console.log(`\n[Monitor] ${new Date().toISOString()} - Checking ${poolADesc} and ${poolBDesc}...`);

    let results = null; // Declare results outside try block

    try {
        console.log("  [Monitor] Fetching pool states and fee data...");
        const promisesToSettle = [
            provider.getFeeData(), poolAContract.slot0(), poolAContract.liquidity(),
            poolBContract.slot0(), poolBContract.liquidity()
        ];

        // --- Improved Timeout Handling ---
        try {
            results = await Promise.race([ // Assign result here
                Promise.allSettled(promisesToSettle),
                createTimeout(FETCH_TIMEOUT_MS, `State/Fee fetching timed out after ${FETCH_TIMEOUT_MS}ms`)
            ]);
            console.log("  [Monitor] Fetch attempt finished (within timeout window).");
        } catch (timeoutError) {
            // This block executes ONLY if the createTimeout promise rejects first
            console.error(`  [Monitor] ❌ FETCH TIMEOUT: ${timeoutError.message}`);
            results = null; // Explicitly set results to null on timeout
        }
        // --- End Improved Timeout Handling ---


        // Check if fetch succeeded (results is an array) or timed out (results is null)
        if (!results || !Array.isArray(results) || results.length < 5) {
             console.error("  [Monitor] Fetch results invalid or timeout occurred. Skipping rest of cycle.");
             return; // Exit cycle
        }
        console.log("  [Monitor] Fetch results received successfully."); // Log success


        // Process results (Now guaranteed that results is a valid array)
        const feeDataResult = results[0]; /* ... other results ... */
        let feeData = null; /* ... assign feeData ... */
        if (!feeData || !feeData.maxFeePerGas || feeData.maxFeePerGas <= 0n) { return; }
        const currentMaxFeePerGas = feeData.maxFeePerGas;
        console.log(`  [Monitor] Fee Data OK: maxFeePerGas=${ethers.formatUnits(currentMaxFeePerGas, 'gwei')} Gwei`);

        const estimatedGasCost = currentMaxFeePerGas * config.GAS_LIMIT_ESTIMATE; // Calculate gas cost early
        console.log(`  [Gas] Estimated Tx Cost: ~${ethers.formatUnits(estimatedGasCost, 'ether')} ETH`);

        let slotA = null, liqA = 0n, slotB = null, liqB = 0n;
        // ... (Assign pool data results safely) ...
        console.log(`  [Monitor] ${poolADesc} State: Tick=${slotA?.tick}, Liquidity=${liqA.toString()}`);
        console.log(`  [Monitor] ${poolBDesc} State: Tick=${slotB?.tick}, Liquidity=${liqB.toString()}`);

        // Exit checks
        if (!slotA || !slotB || liqA === 0n || liqB === 0n) { return; }

        // --- Basic Opportunity Check via Ticks ---
        // ... (logic remains the same, including near-miss log) ...

        // --- Accurate Pre-Simulation --- (Using BORROW_AMOUNT, Positional Args)
        // ... (logic remains the same, including simulation with quote timeouts) ...

        // --- Trigger Arbitrage Attempt ---
        // ... (logic remains the same) ...

    } catch (error) {
        // Catch unexpected errors *after* the fetch block
        console.error(`[Monitor] CRITICAL Error during processing/simulation:`, error);
    } finally {
         console.log(`[Monitor] ${new Date().toISOString()} - Cycle End.`); // Should always run now
    }
}

module.exports = { monitorPools };
