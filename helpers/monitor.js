// helpers/monitor.js - MINIMAL QUOTE TEST
const { ethers } = require('ethers');
// const { attemptArbitrage } = require('./arbitrage'); // Not needed for this test

// --- Helper Functions ---
// Not strictly needed for this test, but keep them for context if uncommenting later
function calculateFlashFee(amountBorrowed, feeBps) { /* ... */ }
function tickToPrice(tick, token0Decimals, token1Decimals) { /* ... */ }

// --- Main Monitoring Function ---
async function monitorPools(state) {
    const { contracts, config } = state;
    const { poolAContract, poolBContract, quoterContract } = contracts;

    if (!poolAContract || !poolBContract || !quoterContract || !config) { return; }

    const poolADesc = `Pool A (${config.POOL_A_ADDRESS} - ${config.POOL_A_FEE_BPS / 100}%)`;
    const poolBDesc = `Pool B (${config.POOL_B_ADDRESS} - ${config.POOL_B_FEE_BPS / 100}%)`;
    console.log(`\n[Monitor] ${new Date().toISOString()} - Checking ${poolADesc} and ${poolBDesc}...`);

    try {
        // Fetch pool states (only need slot0 for tick check)
        const results = await Promise.allSettled([
            poolAContract.slot0(),
            poolBContract.slot0() // Only fetch slot0 for this test
        ]);

        let slotA = null, slotB = null;
        if (results[0]?.status === 'fulfilled') slotA = results[0].value; else { console.error("Failed fetch A"); return; }
        if (results[1]?.status === 'fulfilled') slotB = results[1].value; else { console.error("Failed fetch B"); return; }

        console.log(`  State: Pool A Tick=${slotA.tick}, Pool B Tick=${slotB.tick}`);

        // --- Determine Swap Pool based on Ticks ---
        let swapPoolAddress = ethers.ZeroAddress;
        let swapPoolFeeBps = 0;
        let testPathDescription = "N/A";

        const tickA = Number(slotA.tick);
        const tickB = Number(slotB.tick);
        const TICK_DIFF_THRESHOLD = 1;

        if (tickB > tickA + TICK_DIFF_THRESHOLD) { // Start A -> Swap on B
            swapPoolAddress = config.POOL_B_ADDRESS;
            swapPoolFeeBps = config.POOL_B_FEE_BPS;
            testPathDescription = "Test Quote: WETH->USDC on Pool B (0.30%)";
        } else if (tickA > tickB + TICK_DIFF_THRESHOLD) { // Start B -> Swap on A
            swapPoolAddress = config.POOL_A_ADDRESS;
            swapPoolFeeBps = config.POOL_A_FEE_BPS;
            testPathDescription = "Test Quote: WETH->USDC on Pool A (0.05%)";
        } else {
            console.log("  No significant tick difference. Skipping quote test.");
            return; // Exit cycle if no path determined
        }

        // --- Isolated Quote Test ---
        if (swapPoolAddress !== ethers.ZeroAddress) {
            console.log(`  ${testPathDescription}`);
            const simAmountIn = config.MULTI_QUOTE_SIM_AMOUNT_WETH_WEI; // Use small amount
            const paramsQuote = {
                tokenIn: config.WETH_ADDRESS,
                tokenOut: config.USDC_ADDRESS,
                amountIn: simAmountIn,
                fee: swapPoolFeeBps,
                sqrtPriceLimitX96: 0n
            };
            console.log(`    Params: amountIn=${simAmountIn.toString()}, fee=${swapPoolFeeBps}, pool=${swapPoolAddress}`);

            try {
                console.log("    Attempting quoteExactInputSingle.staticCall...");
                const quoteResult = await quoterContract.quoteExactInputSingle.staticCall(paramsQuote);
                // Access amountOut property if the call succeeds
                const amountOut = quoteResult.amountOut; // Or just quoteResult[0] if ABI is minimal
                console.log(`    ✅ SUCCESS! Quoted Amount Out (USDC): ${ethers.formatUnits(amountOut, config.USDC_DECIMALS)}`);
            } catch (error) {
                 console.error(`    ❌ FAILED: ${error.reason || error.message}`);
                 if(error.data) console.error(`      Revert Data: ${error.data}`);
                 if(error.info) console.error(`      Info: ${JSON.stringify(error.info)}`);
                 if(error.code) console.error(`      Code: ${error.code}`); // Log error code (e.g., BAD_DATA)
            }
        }

    } catch (error) {
        console.error(`[Monitor] CRITICAL Error:`, error);
    } finally {
         console.log(`[Monitor] ${new Date().toISOString()} - Cycle End.`);
    }
} // <<< END async function monitorPools

module.exports = { monitorPools };
