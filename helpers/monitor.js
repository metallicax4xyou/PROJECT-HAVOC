// helpers/monitor.js
// (Full File Content - Updated Logging Strings to use BPS)
const { ethers } = require('ethers');
const { attemptArbitrage } = require('./arbitrage');

// Flash loan fee calculation helper (Uniswap V3 fee is same as pool fee)
function calculateFlashLoanFee(amount, feeBps) {
    const feeBpsBigInt = BigInt(feeBps);
    const denominator = 1000000n;
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
        const results = await Promise.allSettled([
            poolAContract.slot0(),
            poolBContract.slot0(),
        ]);

        const slotAResult = results[0];
        const slotBResult = results[1];

        let slotA = null, slotB = null;

        if (slotAResult.status === 'fulfilled') {
            slotA = slotAResult.value;
            // *** CORRECTED LOGGING: Show BPS ***
            console.log(`  [Monitor] Pool A (${config.POOL_A_FEE_BPS} bps) State: Tick=${slotA.tick}`);
        } else {
            console.error(`  [Monitor] Failed to fetch slot0 for Pool A: ${slotAResult.reason?.message || slotAResult.reason}`);
        }
        if (slotBResult.status === 'fulfilled') {
            slotB = slotBResult.value;
             // *** CORRECTED LOGGING: Show BPS ***
            console.log(`  [Monitor] Pool B (${config.POOL_B_FEE_BPS} bps) State: Tick=${slotB.tick}`);
        } else {
            console.error(`  [Monitor] Failed to fetch slot0 for Pool B: ${slotBResult.reason?.message || slotBResult.reason}`);
        }

        if (!slotA || !slotB) {
            console.log("  [Monitor] Could not fetch complete state for both pools. Skipping analysis.");
            return;
        }

        const tickA = Number(slotA.tick);
        const tickB = Number(slotB.tick);
        const TICK_DIFF_THRESHOLD = 1;
        let startPoolId = null;
        let proceedToAttempt = false;
        const amountToBorrow = config.BORROW_AMOUNT_WETH_WEI;

        // --- Path 1: Try Borrowing from Pool B ---
        if (tickA > tickB + TICK_DIFF_THRESHOLD) {
            startPoolId = 'B';
            // *** CORRECTED LOGGING: Show BPS ***
            console.log(`  [Monitor] Potential Path: Borrow WETH from B (${config.POOL_B_FEE_BPS} bps), Swap B -> A.`);

            try {
                // *** CORRECTED LOGGING: Show BPS ***
                console.log(`  [Simulate B->A] 1. Quoting Swap B (${config.POOL_B_FEE_BPS} bps): ${config.BORROW_AMOUNT_WETH_STR} WETH -> USDC...`);
                const quote1Params = { tokenIn: config.WETH_ADDRESS, tokenOut: config.USDC_ADDRESS, amountIn: amountToBorrow, fee: config.POOL_B_FEE_BPS, sqrtPriceLimitX96: 0n };
                const quote1Result = await quoterContract.quoteExactInputSingle.staticCall(quote1Params);
                const amountOutUSDC = quote1Result.amountOut;
                console.log(`  [Simulate B->A]    -> Got ${ethers.formatUnits(amountOutUSDC, config.USDC_DECIMALS)} USDC`);

                if (amountOutUSDC === 0n) throw new Error("Swap 1 simulation resulted in 0 USDC output.");

                 // *** CORRECTED LOGGING: Show BPS ***
                console.log(`  [Simulate B->A] 2. Quoting Swap A (${config.POOL_A_FEE_BPS} bps): ${ethers.formatUnits(amountOutUSDC, config.USDC_DECIMALS)} USDC -> WETH...`);
                const quote2Params = { tokenIn: config.USDC_ADDRESS, tokenOut: config.WETH_ADDRESS, amountIn: amountOutUSDC, fee: config.POOL_A_FEE_BPS, sqrtPriceLimitX96: 0n };
                const quote2Result = await quoterContract.quoteExactInputSingle.staticCall(quote2Params);
                const finalWETHAmount = quote2Result.amountOut;
                console.log(`  [Simulate B->A]    -> Got ${ethers.formatUnits(finalWETHAmount, config.WETH_DECIMALS)} WETH (final)`);

                if (finalWETHAmount === 0n) throw new Error("Swap 2 simulation resulted in 0 WETH output.");

                const flashLoanFeeB = calculateFlashLoanFee(amountToBorrow, config.POOL_B_FEE_BPS);
                const requiredRepaymentB = amountToBorrow + flashLoanFeeB;
                 // *** CORRECTED LOGGING: Show BPS ***
                console.log(`  [Simulate B->A] Flash Loan Fee (Pool B - ${config.POOL_B_FEE_BPS} bps): ${ethers.formatUnits(flashLoanFeeB, config.WETH_DECIMALS)} WETH`);
                console.log(`  [Simulate B->A] Required Repayment:              ${ethers.formatUnits(requiredRepaymentB, config.WETH_DECIMALS)} WETH`);

                if (finalWETHAmount > requiredRepaymentB) {
                    const profitWei = finalWETHAmount - requiredRepaymentB;
                    console.log(`  [Monitor] ✅ PROFITABLE (Simulated)! Profit: ${ethers.formatUnits(profitWei, config.WETH_DECIMALS)} WETH`);
                    proceedToAttempt = true;
                } else {
                    console.log(`  [Monitor] ❌ NOT PROFITABLE (Simulated). Final WETH <= Repayment.`);
                }

            } catch (error) {
                console.error(`  [Monitor] Error simulating B->A path: ${error.reason || error.message}`);
            }
        }

        // --- Path 2: Try Borrowing from Pool A ---
        else if (tickB > tickA + TICK_DIFF_THRESHOLD) {
            startPoolId = 'A';
             // *** CORRECTED LOGGING: Show BPS ***
            console.log(`  [Monitor] Potential Path: Borrow WETH from A (${config.POOL_A_FEE_BPS} bps), Swap A -> B.`);

            try {
                 // *** CORRECTED LOGGING: Show BPS ***
                console.log(`  [Simulate A->B] 1. Quoting Swap A (${config.POOL_A_FEE_BPS} bps): ${config.BORROW_AMOUNT_WETH_STR} WETH -> USDC...`);
                const quote1Params = { tokenIn: config.WETH_ADDRESS, tokenOut: config.USDC_ADDRESS, amountIn: amountToBorrow, fee: config.POOL_A_FEE_BPS, sqrtPriceLimitX96: 0n };
                const quote1Result = await quoterContract.quoteExactInputSingle.staticCall(quote1Params);
                const amountOutUSDC = quote1Result.amountOut;
                console.log(`  [Simulate A->B]    -> Got ${ethers.formatUnits(amountOutUSDC, config.USDC_DECIMALS)} USDC`);

                if (amountOutUSDC === 0n) throw new Error("Swap 1 simulation resulted in 0 USDC output.");

                 // *** CORRECTED LOGGING: Show BPS ***
                console.log(`  [Simulate A->B] 2. Quoting Swap B (${config.POOL_B_FEE_BPS} bps): ${ethers.formatUnits(amountOutUSDC, config.USDC_DECIMALS)} USDC -> WETH...`);
                const quote2Params = { tokenIn: config.USDC_ADDRESS, tokenOut: config.WETH_ADDRESS, amountIn: amountOutUSDC, fee: config.POOL_B_FEE_BPS, sqrtPriceLimitX96: 0n };
                const quote2Result = await quoterContract.quoteExactInputSingle.staticCall(quote2Params);
                const finalWETHAmount = quote2Result.amountOut;
                console.log(`  [Simulate A->B]    -> Got ${ethers.formatUnits(finalWETHAmount, config.WETH_DECIMALS)} WETH (final)`);

                if (finalWETHAmount === 0n) throw new Error("Swap 2 simulation resulted in 0 WETH output.");

                const flashLoanFeeA = calculateFlashLoanFee(amountToBorrow, config.POOL_A_FEE_BPS);
                const requiredRepaymentA = amountToBorrow + flashLoanFeeA;
                // *** CORRECTED LOGGING: Show BPS ***
                console.log(`  [Simulate A->B] Flash Loan Fee (Pool A - ${config.POOL_A_FEE_BPS} bps): ${ethers.formatUnits(flashLoanFeeA, config.WETH_DECIMALS)} WETH`);
                console.log(`  [Simulate A->B] Required Repayment:              ${ethers.formatUnits(requiredRepaymentA, config.WETH_DECIMALS)} WETH`);

                if (finalWETHAmount > requiredRepaymentA) {
                   const profitWei = finalWETHAmount - requiredRepaymentA;
                   console.log(`  [Monitor] ✅ PROFITABLE (Simulated)! Profit: ${ethers.formatUnits(profitWei, config.WETH_DECIMALS)} WETH`);
                    proceedToAttempt = true;
                } else {
                    console.log(`  [Monitor] ❌ NOT PROFITABLE (Simulated). Final WETH <= Repayment.`);
                }

            } catch (error) {
                console.error(`  [Monitor] Error simulating A->B path: ${error.reason || error.message}`);
            }
        }
        else {
            console.log(`  [Monitor] No significant price difference detected (Ticks: A=${tickA}, B=${tickB}). Skipping simulation.`);
        }

        if (proceedToAttempt && startPoolId) {
            console.log(`  [Monitor] Pre-simulation indicated profit for Start Pool ${startPoolId}. Triggering attemptArbitrage...`);
            state.opportunity = { startPool: startPoolId };
            await attemptArbitrage(state);
        } else if (startPoolId) {
            console.log(`  [Monitor] Pre-simulation did not indicate profit for Start Pool ${startPoolId}. Not attempting arbitrage.`);
        }

    } catch (error) {
        console.error(`[Monitor] Error during monitoring cycle:`, error);
    } finally {
         console.log(`[Monitor] ${new Date().toISOString()} - Cycle End.`);
    }
}

module.exports = { monitorPools };
