// helpers/monitor.js
const { ethers } = require('ethers');
const { simulateSwap } = require('./simulateSwap'); // Adjust path as needed
const { attemptArbitrage } = require('./arbitrage'); // Adjust path as needed

// Helper function for tick-to-price (rough estimation)
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

// Helper for profit calculation
function calculatePotentialProfitWethWei(priceDiffUSDC_PerWETH, priceA, priceB, config) {
    try {
        const priceDiffUSDC_Wei = ethers.parseUnits(priceDiffUSDC_PerWETH.toFixed(config.USDC_DECIMALS), config.USDC_DECIMALS);
        const potentialGrossProfitUSDC_Wei = (priceDiffUSDC_Wei * config.BORROW_AMOUNT_WETH_WEI) / ethers.parseUnits("1", config.WETH_DECIMALS);
        const avgPrice = (priceA + priceB) / 2;
        if (avgPrice <= 0) return 0n;
        const avgPrice_USDC_Wei = ethers.parseUnits(avgPrice.toFixed(config.USDC_DECIMALS), config.USDC_DECIMALS);
        if (avgPrice_USDC_Wei === 0n) return 0n;
        const potentialGrossProfitWETH_Wei = (potentialGrossProfitUSDC_Wei * ethers.parseUnits("1", config.WETH_DECIMALS)) / avgPrice_USDC_Wei;
        return potentialGrossProfitWETH_Wei;
    } catch (calcError) {
        console.warn(`[Monitor] Warning during profit calculation: ${calcError.message}`);
        return 0n;
    }
}

async function monitorPools(state) {
    // Destructure required parts from state
    const { contracts, config } = state;
    const { poolAContract, poolBContract, quoterContract } = contracts;

    if (!poolAContract || !poolBContract || !quoterContract || !config) {
        console.error("[Monitor] Missing contracts or config in state. Skipping cycle.");
        return;
    }

    // Use updated config values
    const poolADesc = `Pool A (${config.POOL_A_ADDRESS} - ${config.POOL_A_FEE_BPS / 100}%)`;
    const poolBDesc = `Pool B (${config.POOL_B_ADDRESS} - ${config.POOL_B_FEE_BPS / 100}%)`;

    console.log(`\n[Monitor] ${new Date().toISOString()} - Checking ${poolADesc} and ${poolBDesc}...`);

    try {
        // Fetch pool states concurrently, INCLUDING LIQUIDITY
        const results = await Promise.allSettled([
            poolAContract.slot0(),
            poolAContract.liquidity(), // Fetch liquidity for Pool A
            poolBContract.slot0(),
            poolBContract.liquidity()  // Fetch liquidity for Pool B
        ]);

        // Process results safely
        const slotAResult = results[0];
        const liqAResult = results[1];
        const slotBResult = results[2];
        const liqBResult = results[3];

        let slotA = null, liqA = 0n, slotB = null, liqB = 0n; // Default liquidity to 0n

        if (slotAResult.status === 'fulfilled') slotA = slotAResult.value;
        else console.error(`  [Monitor] Failed to fetch slot0 for Pool A: ${slotAResult.reason?.message || slotAResult.reason}`);

        if (liqAResult.status === 'fulfilled') liqA = liqAResult.value;
        else console.error(`  [Monitor] Failed to fetch liquidity for Pool A: ${liqAResult.reason?.message || liqAResult.reason}`);

        if (slotBResult.status === 'fulfilled') slotB = slotBResult.value;
        else console.error(`  [Monitor] Failed to fetch slot0 for Pool B: ${slotBResult.reason?.message || slotBResult.reason}`);

        if (liqBResult.status === 'fulfilled') liqB = liqBResult.value;
        else console.error(`  [Monitor] Failed to fetch liquidity for Pool B: ${liqBResult.reason?.message || liqBResult.reason}`);

        // Log fetched states (even if fetch failed for one part)
        console.log(`  [Monitor] ${poolADesc} State: Tick=${slotA?.tick}, Liquidity=${liqA.toString()}`);
        if (liqA === 0n && slotA) console.warn("    ⚠️ Pool A has ZERO active liquidity!");

        console.log(`  [Monitor] ${poolBDesc} State: Tick=${slotB?.tick}, Liquidity=${liqB.toString()}`);
        if (liqB === 0n && slotB) console.warn("    ⚠️ Pool B has ZERO active liquidity!");

        // --- EXIT IF STATES NOT FETCHED OR LIQUIDITY IS ZERO ---
        if (!slotA || !slotB) {
            console.log("  [Monitor] Could not fetch complete slot0 state for both pools. Skipping analysis.");
            return;
        }
        if (liqA === 0n || liqB === 0n) {
            console.log("  [Monitor] One or both pools have zero liquidity. Skipping analysis.");
            return;
        }

        // --- Opportunity Detection & Basic Profit Check ---
        const tickA = Number(slotA.tick);
        const tickB = Number(slotB.tick);
        const TICK_DIFF_THRESHOLD = 1;

        let potentialGrossProfitWei = 0n;
        let startPoolId = null;
        let proceedToAttempt = false;

        const priceA = tickToPrice(tickA, config.WETH_DECIMALS, config.USDC_DECIMALS);
        const priceB = tickToPrice(tickB, config.WETH_DECIMALS, config.USDC_DECIMALS);
        console.log(`  [Monitor] Approx Prices (WETH/USDC): A=${priceA.toFixed(config.USDC_DECIMALS)}, B=${priceB.toFixed(config.USDC_DECIMALS)}`);

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
            console.log(`  [Monitor] Performing final Quoter check... (Sim Amount: ${config.QUOTER_SIM_AMOUNT_WETH_STR} WETH)`);
            const [simASuccess, simBSuccess] = await Promise.all([
                 simulateSwap(poolADesc, config.WETH_ADDRESS, config.USDC_ADDRESS, config.QUOTER_SIM_AMOUNT_WETH_WEI, config.POOL_A_FEE_BPS, quoterContract),
                 simulateSwap(poolBDesc, config.WETH_ADDRESS, config.USDC_ADDRESS, config.QUOTER_SIM_AMOUNT_WETH_WEI, config.POOL_B_FEE_BPS, quoterContract)
            ]);
            // Logs for success/failure are now INSIDE simulateSwap helper

            if (simASuccess && simBSuccess) {
                console.log("  [Monitor] ✅ Both Quoter checks passed. Triggering attemptArbitrage.");
                state.opportunity = {
                    startPool: startPoolId,
                };
                await attemptArbitrage(state);
            } else {
                 console.log("  [Monitor] ❌ One or both Quoter simulations failed. Skipping arbitrage attempt.");
            }
        } else if (startPoolId) {
             console.log("  [Monitor] Not proceeding to attempt (Profit below threshold or zero).");
        }
        // else: No opportunity found

    } catch (error) {
        console.error(`[Monitor] Error during monitoring cycle:`, error);
    } finally {
         console.log(`[Monitor] ${new Date().toISOString()} - Cycle End.`);
    }
}

module.exports = { monitorPools };
