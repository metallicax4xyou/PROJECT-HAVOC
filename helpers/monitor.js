// helpers/monitor.js
const { ethers } = require('ethers');
const { simulateSwap } = require('./simulateSwap'); // Adjust path as needed
const { attemptArbitrage } = require('./arbitrage'); // Adjust path as needed
// No need to import config if passed via state

// Helper function for tick-to-price (rough estimation) - Keep it here as it's specific to monitoring logic
function tickToPrice(tick, token0Decimals, token1Decimals) {
    try {
        // price = 1.0001 ^ tick * (10**(token0Decimals) / 10**(token1Decimals))
        const priceRatio = Math.pow(1.0001, Number(tick)); // Ensure tick is a number
        const decimalAdjustment = Math.pow(10, token0Decimals - token1Decimals);
        // Handle potential NaN or Infinity results from extreme tick values
        const price = priceRatio * decimalAdjustment;
        return isFinite(price) ? price : 0;
    } catch (e) {
        console.warn(`[Helper] Error calculating tickToPrice for tick ${tick}: ${e.message}`);
        return 0; // Return 0 on error
    }
}

async function monitorPools(state) {
    // Destructure required parts from state
    const { contracts, config } = state;
    const { poolAContract, poolBContract, quoterContract } = contracts;

    if (!poolAContract || !poolBContract || !quoterContract || !config) {
        console.error("[Monitor] Missing contracts or config in state. Skipping cycle.");
        return; // Cannot proceed
    }

    console.log(`\n[Monitor] ${new Date().toISOString()} - Checking Pools A & B...`);

    try {
        // Fetch pool states concurrently
        const results = await Promise.allSettled([
            poolAContract.slot0(),
            // poolAContract.liquidity(), // Optional: Fetch liquidity if needed for checks
            poolBContract.slot0(),
            // poolBContract.liquidity()  // Optional
        ]);

        const slotAResult = results[0];
        const slotBResult = results[1]; // Adjust index if liquidity is fetched

        let slotA = null, slotB = null;

        if (slotAResult.status === 'fulfilled') {
            slotA = slotAResult.value;
            console.log(`  [Monitor] Pool A State: Tick=${slotA.tick}`);
        } else {
            console.error(`  [Monitor] Failed to fetch slot0 for Pool A: ${slotAResult.reason?.message || slotAResult.reason}`);
        }
        if (slotBResult.status === 'fulfilled') {
            slotB = slotBResult.value;
            console.log(`  [Monitor] Pool B State: Tick=${slotB.tick}`);
        } else {
            console.error(`  [Monitor] Failed to fetch slot0 for Pool B: ${slotBResult.reason?.message || slotBResult.reason}`);
        }

        // --- EXIT IF STATES NOT FETCHED ---
        if (!slotA || !slotB) {
            console.log("  [Monitor] Could not fetch complete state for both pools. Skipping analysis.");
            return;
        }

        // --- Opportunity Detection & Basic Profit Check ---
        const tickA = Number(slotA.tick);
        const tickB = Number(slotB.tick);
        const TICK_DIFF_THRESHOLD = 1; // Minimum tick difference

        let potentialGrossProfitWei = 0n; // Use BigInt
        let startPoolId = null; // 'A' or 'B'
        let proceedToAttempt = false;

        const priceA = tickToPrice(tickA, config.WETH_DECIMALS, config.USDC_DECIMALS);
        const priceB = tickToPrice(tickB, config.WETH_DECIMALS, config.USDC_DECIMALS);
        console.log(`  [Monitor] Approx Prices: A=${priceA.toFixed(config.USDC_DECIMALS)}, B=${priceB.toFixed(config.USDC_DECIMALS)} (WETH/USDC)`);

        // Compare ticks to find potential direction
        if (tickB > tickA + TICK_DIFF_THRESHOLD && priceA > 0 && priceB > 0) {
            console.log("  [Monitor] Potential: WETH cheaper on A (Tick B > Tick A). Start Pool A.");
            startPoolId = 'A';
            const priceDiff = priceB - priceA;
            potentialGrossProfitWei = calculatePotentialProfitWethWei(priceDiff, priceA, priceB, config);

        } else if (tickA > tickB + TICK_DIFF_THRESHOLD && priceA > 0 && priceB > 0) {
            console.log("  [Monitor] Potential: WETH cheaper on B (Tick A > Tick B). Start Pool B.");
            startPoolId = 'B';
            const priceDiff = priceA - priceB;
            potentialGrossProfitWei = calculatePotentialProfitWethWei(priceDiff, priceA, priceB, config);

        } else {
            console.log(`  [Monitor] No significant price difference detected (Ticks: A=${tickA}, B=${tickB}).`);
        }

        // Check threshold if a potential direction was found
        if (startPoolId) {
            const profitThreshold = config.MIN_POTENTIAL_GROSS_PROFIT_WETH_WEI;
            console.log(`  [Monitor] Potential Gross Profit (WETH Wei, pre-fees): ${potentialGrossProfitWei.toString()}`);
            console.log(`  [Monitor] Profit Threshold (WETH Wei):                 ${profitThreshold.toString()}`);

            if (potentialGrossProfitWei > profitThreshold) {
                console.log("  [Monitor] ✅ Potential profit exceeds threshold. Proceeding to final checks.");
                proceedToAttempt = true;
            } else {
                console.log("  [Monitor] ❌ Potential profit below threshold. Skipping.");
            }
        }

        // --- Final Checks & Trigger Arbitrage ---
        if (proceedToAttempt && startPoolId) {
            // Optional: Final Quoter simulation check (adds safety, costs RPC call)
            console.log(`  [Monitor] Performing final Quoter check...`);
            const [simASuccess, simBSuccess] = await Promise.all([
                 simulateSwap("Pool A", config.WETH_ADDRESS, config.USDC_ADDRESS, config.QUOTER_SIM_AMOUNT_WETH_WEI, config.POOL_A_FEE_BPS, quoterContract),
                 simulateSwap("Pool B", config.WETH_ADDRESS, config.USDC_ADDRESS, config.QUOTER_SIM_AMOUNT_WETH_WEI, config.POOL_B_FEE_BPS, quoterContract)
            ]);
            console.log(`  [Monitor] Quoter sim results: A=${simASuccess}, B=${simBSuccess}`);

            if (simASuccess && simBSuccess) {
                console.log("  [Monitor] ✅ Quoter checks passed. Triggering attemptArbitrage.");
                // Update state with the identified opportunity details
                state.opportunity = {
                    startPool: startPoolId, // 'A' or 'B'
                    // Add any other details attemptArbitrage might need
                };
                await attemptArbitrage(state); // Pass the whole state object
            } else {
                 console.log("  [Monitor] ❌ Quoter simulation failed post-profit check. Skipping arbitrage attempt.");
            }
        } else if (startPoolId) {
             console.log("  [Monitor] Not proceeding to attempt (reason logged above).");
        }
        // else: No opportunity found in the first place

    } catch (error) {
        console.error(`[Monitor] Error during monitoring cycle:`, error);
        // Consider more specific error handling or logging if needed
    } finally {
         console.log(`[Monitor] ${new Date().toISOString()} - Cycle End.`);
    }
}

// Helper for profit calculation to keep monitorPools cleaner
function calculatePotentialProfitWethWei(priceDiffUSDC_PerWETH, priceA, priceB, config) {
    try {
        // Calculate profit in USDC first for precision with USDC decimals
        const priceDiffUSDC_Wei = ethers.parseUnits(priceDiffUSDC_PerWETH.toFixed(config.USDC_DECIMALS), config.USDC_DECIMALS);

        // Potential Gross Profit (USDC Wei) = priceDiffUSDC_Wei * BORROW_AMOUNT_WETH (adjusting for WETH decimals)
        const potentialGrossProfitUSDC_Wei = (priceDiffUSDC_Wei * config.BORROW_AMOUNT_WETH_WEI) / ethers.parseUnits("1", config.WETH_DECIMALS);

        // Convert rough USDC profit back to WETH using average price for threshold check
        const avgPrice = (priceA + priceB) / 2;
        if (avgPrice <= 0) return 0n; // Avoid division by zero

        const avgPrice_USDC_Wei = ethers.parseUnits(avgPrice.toFixed(config.USDC_DECIMALS), config.USDC_DECIMALS);
        if (avgPrice_USDC_Wei === 0n) return 0n; // Avoid division by zero

        const potentialGrossProfitWETH_Wei = (potentialGrossProfitUSDC_Wei * ethers.parseUnits("1", config.WETH_DECIMALS)) / avgPrice_USDC_Wei;
        return potentialGrossProfitWETH_Wei;

    } catch (calcError) {
        console.warn(`[Monitor] Warning during profit calculation: ${calcError.message}`);
        return 0n; // Return zero BigInt on error
    }
}


module.exports = { monitorPools };
