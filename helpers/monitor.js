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
        // Fetch pool states (Same as before)
        console.log("  [Monitor] Fetching pool states...");
        const results = await Promise.allSettled([/*...*/]);
        console.log("  [Monitor] Pool state fetch complete.");
        let slotA = null, liqA = 0n, slotB = null, liqB = 0n;
        // Process results (Same as before)
        if (results[0].status === 'fulfilled') slotA = results[0].value; else console.error(/*...*/);
        if (results[1].status === 'fulfilled') liqA = results[1].value; else console.error(/*...*/);
        if (results[2].status === 'fulfilled') slotB = results[2].value; else console.error(/*...*/);
        if (results[3].status === 'fulfilled') liqB = results[3].value; else console.error(/*...*/);

        // Log states (Same as before)
        console.log(`  [Monitor] ${poolADesc} State: Tick=${slotA?.tick}, Liquidity=${liqA.toString()}`);
        console.log(`  [Monitor] ${poolBDesc} State: Tick=${slotB?.tick}, Liquidity=${liqB.toString()}`);

        // Exit checks (Same as before)
        if (!slotA || !slotB) { console.log("...Missing slot0..."); return; }
        if (liqA === 0n || liqB === 0n) { console.log("...Zero liquidity..."); return;}

        // --- Basic Opportunity Check via Ticks ---
        console.log("  [Monitor] Entering Tick Check Block..."); // <<< ADD LOG
        let startPoolId = null;
        let flashLoanPoolFeeBps = 0;
        let swapPoolAddress = ethers.ZeroAddress;
        let swapPoolFeeBps = 0;
        let proceedToAttempt = false; // Keep this for later trigger logic
        let estimatedProfitWei = 0n;  // Keep this for later trigger logic

        if (slotA && slotB) {
            const tickA = Number(slotA.tick);
            const tickB = Number(slotB.tick);
            const TICK_DIFF_THRESHOLD = 1;

            if (tickB > tickA + TICK_DIFF_THRESHOLD) {
                startPoolId = 'A'; flashLoanPoolFeeBps = config.POOL_A_FEE_BPS;
                swapPoolAddress = config.POOL_B_ADDRESS; swapPoolFeeBps = config.POOL_B_FEE_BPS;
                console.log(`  [Monitor] Tick Check Result: Potential Start A`);
            } else if (tickA > tickB + TICK_DIFF_THRESHOLD) {
                startPoolId = 'B'; flashLoanPoolFeeBps = config.POOL_B_FEE_BPS;
                swapPoolAddress = config.POOL_A_ADDRESS; swapPoolFeeBps = config.POOL_A_FEE_BPS;
                console.log(`  [Monitor] Tick Check Result: Potential Start B`);
            } else {
                console.log(`  [Monitor] Tick Check Result: No significant tick difference.`);
            }
        } else {
            console.log("  [Monitor] Tick Check Skipped (should not happen if previous check passed).");
        }
        console.log(`  [Monitor] Exiting Tick Check Block (startPoolId=${startPoolId}).`); // <<< ADD LOG


        // --- Accurate Pre-Simulation ---
        // --- TEMPORARILY COMMENT OUT SIMULATION BLOCK --- >>>
        /*
        if (startPoolId && liqA > 0n && liqB > 0n) {
             console.log(`  [Monitor] Performing multi-quote simulation...`);
             const intendedBorrowAmount = config.BORROW_AMOUNT_WETH_WEI;
             const simAmountInInitial = config.MULTI_QUOTE_SIM_AMOUNT_WETH_WEI;
             // ... (rest of simulation setup) ...

             try {
                 // ... (paramsSwap1 definition) ...
                 console.log(`    Sim: Swap 1 - Attempting staticCall (Single)...`);
                 const quoteResult1 = await quoterContract.quoteExactInputSingle.staticCall(paramsSwap1);
                 // ... (check output, log, define paramsSwap2) ...

                 console.log(`    Sim: Swap 2 - Attempting staticCall (Single)...`);
                 const quoteResult2 = await quoterContract.quoteExactInputSingle.staticCall(paramsSwap2);
                 // ... (check output, log, scale result, check profit) ...
                 // ... (set proceedToAttempt = true if profitable) ...

             } catch (error) {
                 console.error(`  [Monitor] ❌ Pre-Sim Error: ${error.reason || error.message}`);
                 // ... (log details) ...
             } // --- END Try Block ---

        } else if (startPoolId) {
            console.log(`  [Monitor] Skipping simulation due to zero liquidity (should not happen if previous check passed).`);
        }
        */
        // <<< --- END TEMPORARY COMMENT OUT ---


        // --- Trigger Arbitrage Attempt ---
        console.log("  [Monitor] Entering Trigger Block..."); // <<< ADD LOG
        if (proceedToAttempt && startPoolId) { // proceedToAttempt will be false now
             console.log("  [Monitor] Conditions met. Triggering attemptArbitrage.");
             state.opportunity = { startPool: startPoolId, profit: estimatedProfitWei };
             await attemptArbitrage(state);
        } else if (startPoolId) {
             console.log("  [Monitor] Not proceeding to attemptArbitrage (Simulation commented out or unprofitable)."); // <<< THIS SHOULD LOG NOW >>>
        } else {
             console.log("  [Monitor] Not proceeding to attemptArbitrage (No opportunity found)."); // <<< OR THIS >>>
        }
        console.log("  [Monitor] Exiting Trigger Block."); // <<< ADD LOG


    } catch (error) {
        console.error(`[Monitor] CRITICAL Error during monitoring cycle:`, error);
    } finally {
         console.log(`[Monitor] ${new Date().toISOString()} - Cycle End.`); // <<< THIS SHOULD LOG NOW >>>
    }
}

module.exports = { monitorPools };
