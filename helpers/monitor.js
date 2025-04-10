// helpers/monitor.js
const { ethers } = require('ethers');
const { attemptArbitrage } = require('./arbitrage');

// --- Helper Functions --- (Defined FIRST)
function calculateFlashFee(amountBorrowed, feeBps) {
    const feeBpsBigInt = BigInt(feeBps);
    const denominator = 1000000n;
    return (amountBorrowed * feeBpsBigInt) / denominator;
}

function tickToPrice(tick, token0Decimals, token1Decimals) {
    try {
        const priceRatio = Math.pow(1.0001, Number(tick));
        const decimalAdjustment = Math.pow(10, token0Decimals - token1Decimals);
        const price = priceRatio * decimalAdjustment;
        return isFinite(price) ? price : 0;
    } catch (e) {
        console.warn(`[Helper] Error calculating tickToPrice for tick ${tick}: ${e.message}`);
        return 0;
    }
}
function createTimeout(ms, message = 'Operation timed out') {
    return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}
const QUOTE_TIMEOUT_MS = 5000; // Timeout for individual quote calls
const FETCH_TIMEOUT_MS = 20000; // Timeout for combined state/fee fetch


// --- Main Monitoring Function ---
// <<< Takes SINGLE 'state' object argument >>>
async function monitorPools(state) {
    // --- Destructure state object FIRST ---
    if (!state || !state.contracts || !state.config || !state.provider) {
         console.error("[Monitor] CRITICAL: Invalid or incomplete state object received.");
         return;
    }
    const { contracts, config, provider } = state; // Destructure state
    const { poolAContract, poolBContract, quoterContract } = contracts; // Destructure contracts

    // Check specifically for needed contract instances
    if (!poolAContract || !poolBContract || !quoterContract) {
        console.error("[Monitor] CRITICAL: One or more required contract instances missing in state.contracts.");
        console.error(`  poolA: ${!!poolAContract}, poolB: ${!!poolBContract}, quoter: ${!!quoterContract}`);
        return;
    }
    // --- End Destructuring and Checks ---


    const poolADesc = `Pool A (${config.POOL_A_ADDRESS} - ${config.POOL_A_FEE_BPS / 100}%)`;
    const poolBDesc = `Pool B (${config.POOL_B_ADDRESS} - ${config.POOL_B_FEE_BPS / 100}%)`;
    console.log(`\n[Monitor] ${new Date().toISOString()} - Checking ${poolADesc} and ${poolBDesc}...`);

    try {
        // Check contract instances (using destructured variables)
        console.log("  [DEBUG] Checking contract instances before fetch...");
        if (!(poolAContract instanceof ethers.Contract) || typeof poolAContract.slot0 !== 'function' /* Add other checks if needed */) {
            console.error("  [Monitor] ERROR: Pool A contract instance appears invalid."); return;
        }
        if (!(poolBContract instanceof ethers.Contract) || typeof poolBContract.slot0 !== 'function' /* Add other checks if needed */) {
            console.error("  [Monitor] ERROR: Pool B contract instance appears invalid."); return;
        }
        console.log("  [DEBUG] Contract instances appear valid.");

        // --- Fetch pool states and fee data ---
        console.log("  [Monitor] Fetching pool states and fee data...");
        const promisesToSettle = [
            provider.getFeeData(), // Uses provider from state
            poolAContract.slot0(), // Uses poolAContract from state.contracts
            poolAContract.liquidity(),
            poolBContract.slot0(), // Uses poolBContract from state.contracts
            poolBContract.liquidity()
        ];
        console.log(`  [DEBUG] Number of promises created: ${promisesToSettle.length}`);

        // Use Fetch Timeout
        const results = await Promise.race([
            Promise.allSettled(promisesToSettle),
            createTimeout(FETCH_TIMEOUT_MS, 'State/Fee fetching timed out')
        ]);
        console.log("  [Monitor] Fetch complete.");

        // Check results array structure
        if (!Array.isArray(results) || results.length < 5) {
            console.error("  [Monitor] Fetch results invalid (Likely Timeout). Results:", results);
            return;
        }

        // Process results
        const feeDataResult = results[0];
        const slotAResult = results[1]; const liqAResult = results[2];
        const slotBResult = results[3]; const liqBResult = results[4];

        // Get Fee Data
        let feeData = null;
        if (feeDataResult?.status === 'fulfilled') {
            feeData = feeDataResult.value;
            console.log(`  [Monitor] Fee Data: maxFeePerGas=${ethers.formatUnits(feeData.maxFeePerGas || 0n, 'gwei')} Gwei`);
        } else {
            console.error(`[Monitor] Failed Fetch: Fee Data - ${feeDataResult?.reason?.message || 'Reason N/A'}`);
            return; // Cannot proceed without fee data
        }
        const currentMaxFeePerGas = feeData.maxFeePerGas;
        if (!currentMaxFeePerGas || currentMaxFeePerGas <= 0n) { // Check for zero fee too
             console.warn(`[Monitor] Warning: Invalid maxFeePerGas (${currentMaxFeePerGas}). Skipping cycle.`);
             return;
        }

        // Process Pool Data
        let slotA = null, liqA = 0n, slotB = null, liqB = 0n;
        if (slotAResult?.status === 'fulfilled') slotA = slotAResult.value; else console.error(`[Monitor] Failed Fetch: Pool A slot0`);
        if (liqAResult?.status === 'fulfilled') liqA = BigInt(liqAResult.value); else console.error(`[Monitor] Failed Fetch: Pool A liquidity`);
        if (slotBResult?.status === 'fulfilled') slotB = slotBResult.value; else console.error(`[Monitor] Failed Fetch: Pool B slot0`);
        if (liqBResult?.status === 'fulfilled') liqB = BigInt(liqBResult.value); else console.error(`[Monitor] Failed Fetch: Pool B liquidity`);

        // Log states
        console.log(`  [Monitor] ${poolADesc} State: Tick=${slotA?.tick}, Liquidity=${liqA.toString()}`);
        console.log(`  [Monitor] ${poolBDesc} State: Tick=${slotB?.tick}, Liquidity=${liqB.toString()}`);

        // Exit checks
        if (!slotA || !slotB) { console.log("...Missing slot0 data..."); return; }
        if (liqA === 0n || liqB === 0n) { console.log("...Zero liquidity..."); return; }

        // --- Basic Opportunity Check via Ticks ---
        console.log("  [Monitor] Entering Tick Check Block...");
        let startPoolId = null;
        let flashLoanPoolFeeBps = 0;
        let swapPoolAddress = ethers.ZeroAddress;
        let swapPoolFeeBps = 0;

        if (slotA && slotB) { /* ... tick check logic ... */ }
        console.log(`  [Monitor] Exiting Tick Check Block (startPoolId=${startPoolId}).`);

        // --- Accurate Pre-Simulation (with Gas Check Incorporated) ---
        let proceedToAttempt = false;
        let estimatedProfitWei = 0n;

        if (startPoolId && liqA > 0n && liqB > 0n) {
            // ... (Simulation logic using quoteExactInputSingle.staticCall with timeouts) ...
            // ... (Calculate estimatedProfitWei) ...
            // ... (Calculate estimatedGasCost using currentMaxFeePerGas) ...
            // ... (Check if estimatedProfitWei > estimatedGasCost + buffer) ...
            // ... (Set proceedToAttempt = true if net profitable) ...
        } else if (startPoolId) { /* ... log skipping sim ... */ }

        // --- Trigger Arbitrage Attempt ---
        console.log("  [Monitor] Entering Trigger Block...");
        if (proceedToAttempt && startPoolId) {
             console.log("  [Monitor] Conditions met. Triggering attemptArbitrage.");
             state.opportunity = { startPool: startPoolId, profit: estimatedProfitWei };
             await attemptArbitrage(state);
        } else if (startPoolId) { console.log("  [Monitor] Not proceeding (Sim failed or unprofitable NET)."); }
        else { console.log("  [Monitor] Not proceeding (No opportunity)."); }
        console.log("  [Monitor] Exiting Trigger Block.");


    } catch (error) {
        console.error(`[Monitor] CRITICAL Error during monitoring cycle:`, error);
    } finally {
         console.log(`[Monitor] ${new Date().toISOString()} - Cycle End.`);
    }
} // <<< END async function monitorPools

module.exports = { monitorPools };
