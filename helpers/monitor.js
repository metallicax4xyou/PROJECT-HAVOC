// helpers/monitor.js
// (Full File Content - Updated Logging Strings)
const { ethers } = require('ethers');
const { attemptArbitrage } = require('./arbitrage');

// Flash loan fee calculation helper (Uniswap V3 fee is same as pool fee)
function calculateFlashLoanFee(amount, feeBps) {
    // Use BigInt math for precision
    const feeBpsBigInt = BigInt(feeBps);
    const denominator = 1000000n; // Fee is in basis points (bps), need to divide by 1M
    return (amount * feeBpsBigInt) / denominator;
}

async function monitorPools(state) {
    const { contracts, config } = state;
    const { poolAContract, poolBContract, quoterContract } = contracts;

    if (!poolAContract || !poolBContract || !quoterContract || !config) {
        console.error("[Monitor] Missing contracts or config in state. Skipping cycle.");
        return;
    }

    console.log(`\n[Monitor] ${new Date().toISOString()} - Checking Pools A & B...`);

    try {
        // Fetch pool states concurrently
        const results = await Promise.allSettled([
            poolAContract.slot0(),
            poolBContract.slot0(),
        ]);

        const slotAResult = results[0];
        const slotBResult = results[1];

        let slotA = null, slotB = null;

        if (slotAResult.status === 'fulfilled') {
            slotA = slotAResult.value;
            console.log(`  [Monitor] Pool A (${(config.POOL_A_FEE_PERCENT * 100).toFixed(2)}%) State: Tick=${slotA.tick}`); // Added fee % log
        } else {
            console.error(`  [Monitor] Failed to fetch slot0 for Pool A: ${slotAResult.reason?.message || slotAResult.reason}`);
        }
        if (slotBResult.status === 'fulfilled') {
            slotB = slotBResult.value;
            console.log(`  [Monitor] Pool B (${(config.POOL_B_FEE_PERCENT * 100).toFixed(2)}%) State: Tick=${slotB.tick}`); // Added fee % log
        } else {
            console.error(`  [Monitor] Failed to fetch slot0 for Pool B: ${slotBResult.reason?.message || slotBResult.reason}`);
        }

        // --- EXIT IF STATES NOT FETCHED ---
        if (!slotA || !slotB) {
            console.log("  [Monitor] Could not fetch complete state for both pools. Skipping analysis.");
            return;
        }

        // --- Refined Opportunity Detection & Profit Simulation ---
        const tickA = Number(slotA.tick);
        const tickB = Number(slotB.tick);
        const TICK_DIFF_THRESHOLD = 1; // Still useful as an initial quick check

        let startPoolId = null; // 'A' or 'B'
        let proceedToAttempt = false; // Flag to trigger attemptArbitrage

        const amountToBorrow = config.BORROW_AMOUNT_WETH_WEI; // The amount we plan to flash loan

        // --- Path 1: Try Borrowing from Pool B (if WETH potentially cheaper on B) ---
        if (tickA > tickB + TICK_DIFF_THRESHOLD) {
            startPoolId = 'B'; // Set potential start pool
            // *** CORRECTED LOGGING ***
            console.log(`  [Monitor] Potential Path: Borrow WETH from B (${(config.POOL_B_FEE_PERCENT * 100).toFixed(2)}%), Swap B -> A.`);

            try {
                // *** CORRECTED LOGGING ***
                console.log(`  [Simulate B->A] 1. Quoting Swap B (${(config.POOL_B_FEE_PERCENT * 100).toFixed(2)}%): ${config.BORROW_AMOUNT_WETH_STR} WETH -> USDC...`);
                const quote1Params = {
                    tokenIn: config.WETH_ADDRESS,
                    tokenOut: config.USDC_ADDRESS,
                    amountIn: amountToBorrow,
                    fee: config.POOL_B_FEE_BPS, // Fee for Swap 1 (Pool B)
                    sqrtPriceLimitX96: 0n
                };
                const quote1Result = await quoterContract.quoteExactInputSingle.staticCall(quote1Params);
                const amountOutUSDC = quote1Result.amountOut;
                console.log(`  [Simulate B->A]    -> Got ${ethers.formatUnits(amountOutUSDC, config.USDC_DECIMALS)} USDC`);

                if (amountOutUSDC === 0n) throw new Error("Swap 1 simulation resulted in 0 USDC output.");

                // *** CORRECTED LOGGING ***
                console.log(`  [Simulate B->A] 2. Quoting Swap A (${(config.POOL_A_FEE_PERCENT * 100).toFixed(2)}%): ${ethers.formatUnits(amountOutUSDC, config.USDC_DECIMALS)} USDC -> WETH...`);
                const quote2Params = {
                    tokenIn: config.USDC_ADDRESS,
                    tokenOut: config.WETH_ADDRESS,
                    amountIn: amountOutUSDC,
                    fee: config.POOL_A_FEE_BPS, // Fee for Swap 2 (Pool A)
                    sqrtPriceLimitX96: 0n
                };
                const quote2Result = await quoterContract.quoteExactInputSingle.staticCall(quote2Params);
                const finalWETHAmount = quote2Result.amountOut;
                console.log(`  [Simulate B->A]    -> Got ${ethers.formatUnits(finalWETHAmount, config.WETH_DECIMALS)} WETH (final)`);

                if (finalWETHAmount === 0n) throw new Error("Swap 2 simulation resulted in 0 WETH output.");

                // 3. Calculate Repayment Amount (Borrow Amount + Flash Loan Fee for Pool B)
                const flashLoanFeeB = calculateFlashLoanFee(amountToBorrow, config.POOL_B_FEE_BPS);
                const requiredRepaymentB = amountToBorrow + flashLoanFeeB;
                console.log(`  [Simulate B->A] Flash Loan Fee (Pool B): ${ethers.formatUnits(flashLoanFeeB, config.WETH_DECIMALS)} WETH`);
                console.log(`  [Simulate B->A] Required Repayment:    ${ethers.formatUnits(requiredRepaymentB, config.WETH_DECIMALS)} WETH`);

                // 4. Compare Final Amount vs Repayment
                if (finalWETHAmount > requiredRepaymentB) {
                    const profitWei = finalWETHAmount - requiredRepaymentB;
                    console.log(`  [Monitor] ✅ PROFITABLE (Simulated)! Profit: ${ethers.formatUnits(profitWei, config.WETH_DECIMALS)} WETH`);
                    proceedToAttempt = true;
                } else {
                    console.log(`  [Monitor] ❌ NOT PROFITABLE (Simulated). Final WETH <= Repayment.`);
                }

            } catch (error) {
                console.error(`  [Monitor] Error simulating B->A path: ${error.reason || error.message}`);
                // Optional: Log more details like error.data if available
                // if (error.data) console.error(`    Data: ${error.data}`);
            }
        }

        // --- Path 2: Try Borrowing from Pool A (if WETH potentially cheaper on A) ---
        else if (tickB > tickA + TICK_DIFF_THRESHOLD) {
            startPoolId = 'A'; // Set potential start pool
            // *** CORRECTED LOGGING ***
            console.log(`  [Monitor] Potential Path: Borrow WETH from A (${(config.POOL_A_FEE_PERCENT * 100).toFixed(2)}%), Swap A -> B.`);

            try {
                // *** CORRECTED LOGGING ***
                console.log(`  [Simulate A->B] 1. Quoting Swap A (${(config.POOL_A_FEE_PERCENT * 100).toFixed(2)}%): ${config.BORROW_AMOUNT_WETH_STR} WETH -> USDC...`);
                const quote1Params = {
                    tokenIn: config.WETH_ADDRESS,
                    tokenOut: config.USDC_ADDRESS,
                    amountIn: amountToBorrow,
                    fee: config.POOL_A_FEE_BPS, // Fee for Swap 1 (Pool A)
                    sqrtPriceLimitX96: 0n
                };
                const quote1Result = await quoterContract.quoteExactInputSingle.staticCall(quote1Params);
                const amountOutUSDC = quote1Result.amountOut;
                console.log(`  [Simulate A->B]    -> Got ${ethers.formatUnits(amountOutUSDC, config.USDC_DECIMALS)} USDC`);

                if (amountOutUSDC === 0n) throw new Error("Swap 1 simulation resulted in 0 USDC output.");

                // *** CORRECTED LOGGING ***
                console.log(`  [Simulate A->B] 2. Quoting Swap B (${(config.POOL_B_FEE_PERCENT * 100).toFixed(2)}%): ${ethers.formatUnits(amountOutUSDC, config.USDC_DECIMALS)} USDC -> WETH...`);
                const quote2Params = {
                    tokenIn: config.USDC_ADDRESS,
                    tokenOut: config.WETH_ADDRESS,
                    amountIn: amountOutUSDC,
                    fee: config.POOL_B_FEE_BPS, // Fee for Swap 2 (Pool B)
                    sqrtPriceLimitX96: 0n
                };
                const quote2Result = await quoterContract.quoteExactInputSingle.staticCall(quote2Params);
                const finalWETHAmount = quote2Result.amountOut;
                console.log(`  [Simulate A->B]    -> Got ${ethers.formatUnits(finalWETHAmount, config.WETH_DECIMALS)} WETH (final)`);

                if (finalWETHAmount === 0n) throw new Error("Swap 2 simulation resulted in 0 WETH output.");

                // 3. Calculate Repayment Amount (Borrow Amount + Flash Loan Fee for Pool A)
                const flashLoanFeeA = calculateFlashLoanFee(amountToBorrow, config.POOL_A_FEE_BPS);
                const requiredRepaymentA = amountToBorrow + flashLoanFeeA;
                console.log(`  [Simulate A->B] Flash Loan Fee (Pool A): ${ethers.formatUnits(flashLoanFeeA, config.WETH_DECIMALS)} WETH`);
                console.log(`  [Simulate A->B] Required Repayment:    ${ethers.formatUnits(requiredRepaymentA, config.WETH_DECIMALS)} WETH`);

                // 4. Compare Final Amount vs Repayment
                if (finalWETHAmount > requiredRepaymentA) {
                   const profitWei = finalWETHAmount - requiredRepaymentA;
                   console.log(`  [Monitor] ✅ PROFITABLE (Simulated)! Profit: ${ethers.formatUnits(profitWei, config.WETH_DECIMALS)} WETH`);
                    proceedToAttempt = true;
                } else {
                    console.log(`  [Monitor] ❌ NOT PROFITABLE (Simulated). Final WETH <= Repayment.`);
                }

            } catch (error) {
                console.error(`  [Monitor] Error simulating A->B path: ${error.reason || error.message}`);
                // if (error.data) console.error(`    Data: ${error.data}`);
            }
        }

        // --- If no significant tick difference ---
        else {
            console.log(`  [Monitor] No significant price difference detected (Ticks: A=${tickA}, B=${tickB}). Skipping simulation.`);
        }


        // --- Trigger Arbitrage Attempt IF Simulation Showed Profit ---
        if (proceedToAttempt && startPoolId) {
            console.log(`  [Monitor] Pre-simulation indicated profit for Start Pool ${startPoolId}. Triggering attemptArbitrage...`);
            // Update state with the identified opportunity details
            state.opportunity = {
                startPool: startPoolId, // 'A' or 'B'
            };
            // Now call the actual arbitrage attempt function which will perform its own simulation (staticCall)
            await attemptArbitrage(state);
        } else if (startPoolId) {
            // Logged reason above (simulation error or not profitable)
            console.log(`  [Monitor] Pre-simulation did not indicate profit for Start Pool ${startPoolId}. Not attempting arbitrage.`);
        }
        // else: No opportunity found in the first place

    } catch (error) {
        console.error(`[Monitor] Error during monitoring cycle:`, error);
    } finally {
         console.log(`[Monitor] ${new Date().toISOString()} - Cycle End.`);
    }
}

module.exports = { monitorPools };
