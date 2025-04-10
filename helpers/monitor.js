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

        // Debug log results (Keep this - it worked)
        console.log("  [DEBUG] Raw Promise.allSettled results:", JSON.stringify(results, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
        console.log(`  [DEBUG] results array length: ${results?.length}`);
        if (!Array.isArray(results) || results.length < 4) { return; }

        // Process results safely (Keep this)
        let slotA = null, liqA = 0n, slotB = null, liqB = 0n;
        // ... (Assign results safely, checking for undefined results[i]) ...
        if (results[0] && results[0].status === 'fulfilled') slotA = results[0].value; else console.error(/*...*/);
        if (results[1] && results[1].status === 'fulfilled') liqA = BigInt(results[1].value); else console.error(/*...*/);
        if (results[2] && results[2].status === 'fulfilled') slotB = results[2].value; else console.error(/*...*/);
        if (results[3] && results[3].status === 'fulfilled') liqB = BigInt(results[3].value); else console.error(/*...*/);


        // Log states (Keep this)
        console.log(`  [Monitor] ${poolADesc} State: Tick=${slotA?.tick}, Liquidity=${liqA.toString()}`);
        console.log(`  [Monitor] ${poolBDesc} State: Tick=${slotB?.tick}, Liquidity=${liqB.toString()}`);

        // Exit checks (Keep this)
        if (!slotA || !slotB) { console.log("...Missing slot0..."); return; }
        if (liqA === 0n || liqB === 0n) { console.log("...Zero liquidity..."); return;}


        // --- Basic Opportunity Check via Ticks ---
        console.log("  [Monitor] Entering Tick Check Block...");
        // --- DECLARE VARIABLES CLOSER TO USE ---
        let startPoolId = null; // <<< Declare immediately before use/assignment
        let flashLoanPoolFeeBps = 0;
        let swapPoolAddress = ethers.ZeroAddress;
        let swapPoolFeeBps = 0;
        // ---

        if (slotA && slotB) {
            const tickA = Number(slotA.tick);
            const tickB = Number(slotB.tick);
            const TICK_DIFF_THRESHOLD = 1;

            if (tickB > tickA + TICK_DIFF_THRESHOLD) {
                startPoolId = 'A'; // Assign
                flashLoanPoolFeeBps = config.POOL_A_FEE_BPS;
                swapPoolAddress = config.POOL_B_ADDRESS;
                swapPoolFeeBps = config.POOL_B_FEE_BPS;
                console.log(`  [Monitor] Tick Check Result: Potential Start A`);
            } else if (tickA > tickB + TICK_DIFF_THRESHOLD) {
                startPoolId = 'B'; // Assign
                flashLoanPoolFeeBps = config.POOL_B_FEE_BPS;
                swapPoolAddress = config.POOL_A_ADDRESS;
                swapPoolFeeBps = config.POOL_A_FEE_BPS;
                console.log(`  [Monitor] Tick Check Result: Potential Start B`);
            } else {
                // startPoolId remains null
                console.log(`  [Monitor] Tick Check Result: No significant tick difference.`);
            }
        } else {
             // startPoolId remains null
            console.log("  [Monitor] Tick Check Skipped (Error: slotA or slotB missing despite check).");
        }
        // Use the potentially assigned value
        console.log(`  [Monitor] Exiting Tick Check Block (startPoolId=${startPoolId}).`);


        // --- Accurate Pre-Simulation (Still Commented Out) ---
        // Declare these closer to use too, although it matters less here
        let proceedToAttempt = false;
        let estimatedProfitWei = 0n;
        /*
        if (startPoolId && liqA > 0n && liqB > 0n) {
           // ... Simulation logic ...
           // if (profit > 0) proceedToAttempt = true;
        } else if (startPoolId) { ... }
        */

        // --- Trigger Arbitrage Attempt ---
        console.log("  [Monitor] Entering Trigger Block...");
        if (proceedToAttempt && startPoolId) { // proceedToAttempt is false, startPoolId might be null or 'A'/'B'
             console.log("  [Monitor] Conditions met. Triggering attemptArbitrage.");
             state.opportunity = { startPool: startPoolId, profit: estimatedProfitWei };
             await attemptArbitrage(state);
        } else if (startPoolId) { // Check if startPoolId has a value ('A' or 'B')
             console.log("  [Monitor] Not proceeding to attemptArbitrage (Simulation commented out or unprofitable).");
        } else { // startPoolId is still null
             console.log("  [Monitor] Not proceeding to attemptArbitrage (No opportunity found).");
        }
        console.log("  [Monitor] Exiting Trigger Block.");


    } catch (error) {
        console.error(`[Monitor] CRITICAL Error during monitoring cycle:`, error);
    } finally {
         console.log(`[Monitor] ${new Date().toISOString()} - Cycle End.`);
    }
}

module.exports = { monitorPools };
