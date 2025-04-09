// helpers/monitor.js
// (Full File Content - With calcRepayment fix and BPS logging)
const { ethers } = require("ethers");
const { tryQuote } = require("./quoteSimulator"); // Use the new helper
const { attemptArbitrage } = require("./arbitrage"); // Import attemptArbitrage

// Helper to format units consistently
function formatUnits(value, decimals = 18) {
  if (typeof value === 'undefined' || value === null) return 'N/A';
  try {
    return ethers.formatUnits(value.toString(), decimals);
  } catch (e) {
    console.error(`Error formatting value: ${value}`, e);
    return 'Error';
  }
}

// *** REPAYMENT CALCULATION (NOW A HELPER IN arbitrage.js, OR DEFINED HERE) ***
// Let's keep the definition from arbitrage.js for consistency if needed,
// but for monitor logic, we calculate it based on the path.
// Moved flash loan fee calculation here for clarity
function calculateFlashLoanFee(amount, feeBps) {
    const feeBpsBigInt = BigInt(feeBps);
    const denominator = 1000000n; // Fee is in basis points (bps), need to divide by 1M
    return (amount * feeBpsBigInt) / denominator;
}


async function monitorPools(state) {
  const { config, contracts } = state; // Removed provider as it's in contracts/state if needed
  const { poolAContract, poolBContract, quoterContract } = contracts;
  const {
    POOL_A_ADDRESS, POOL_B_ADDRESS,
    POOL_A_FEE_BPS, POOL_B_FEE_BPS,
    WETH_ADDRESS, USDC_ADDRESS,
    BORROW_AMOUNT_WETH_WEI, WETH_DECIMALS, USDC_DECIMALS // Added USDC_DECIMALS
  } = config;

  console.log(`\n[Monitor] ${new Date().toISOString()} - Checking Pools A & B...`);

  try {
    const results = await Promise.allSettled([ // Use Promise.allSettled for resilience
        poolAContract.slot0(),
        poolBContract.slot0()
    ]);

    const slotAResult = results[0];
    const slotBResult = results[1];

    // Check if fetches succeeded
    if (slotAResult.status !== 'fulfilled' || slotBResult.status !== 'fulfilled') {
        if(slotAResult.status !== 'fulfilled') console.error(`  [Monitor] Failed to fetch Pool A slot0: ${slotAResult.reason?.message || slotAResult.reason}`);
        if(slotBResult.status !== 'fulfilled') console.error(`  [Monitor] Failed to fetch Pool B slot0: ${slotBResult.reason?.message || slotBResult.reason}`);
        console.log("  [Monitor] Skipping cycle due to fetch failure.");
        console.log(`[Monitor] ${new Date().toISOString()} - Cycle End.`);
        return; // Exit cycle if cannot fetch state
    }

    const slotA = slotAResult.value;
    const slotB = slotBResult.value;
    const tickA = Number(slotA.tick); // Convert BigInt tick to Number for comparison
    const tickB = Number(slotB.tick);

    console.log(`  [Monitor] Pool A (${POOL_A_FEE_BPS} bps) Tick: ${tickA}`);
    console.log(`  [Monitor] Pool B (${POOL_B_FEE_BPS} bps) Tick: ${tickB}`);

    let bestPath = null; // Tracks the most profitable path found { startPool, profit, ... }

    // --- Simulate A -> B ---
    console.log(`\n  --- Simulating Path A -> B (Borrow from A @ ${POOL_A_FEE_BPS} bps) ---`);
    // 1. Simulate Swap 1 on Pool A (WETH -> USDC)
    console.log(`  [Simulate A->B] 1. Quoting Swap A (${POOL_A_FEE_BPS} bps): ${formatUnits(BORROW_AMOUNT_WETH_WEI, WETH_DECIMALS)} WETH -> USDC...`);
    const simA1 = await tryQuote({
      tokenIn: WETH_ADDRESS,
      tokenOut: USDC_ADDRESS,
      amountIn: BORROW_AMOUNT_WETH_WEI,
      fee: POOL_A_FEE_BPS,
      quoter: quoterContract
    });

    if (simA1.success && simA1.amountOut > 0n) {
      const amountOutUSDC = simA1.amountOut;
      console.log(`    -> Got ${formatUnits(amountOutUSDC, USDC_DECIMALS)} USDC`);
      // 2. Simulate Swap 2 on Pool B (USDC -> WETH)
      console.log(`  [Simulate A->B] 2. Quoting Swap B (${POOL_B_FEE_BPS} bps): ${formatUnits(amountOutUSDC, USDC_DECIMALS)} USDC -> WETH...`);
      const simA2 = await tryQuote({
        tokenIn: USDC_ADDRESS,
        tokenOut: WETH_ADDRESS,
        amountIn: amountOutUSDC,
        fee: POOL_B_FEE_BPS,
        quoter: quoterContract
      });

      if (simA2.success && simA2.amountOut > 0n) {
        const finalWethOut = simA2.amountOut;
        // *** CORRECTED REPAYMENT CALCULATION FOR PATH A->B ***
        const flashLoanFeeA = calculateFlashLoanFee(BORROW_AMOUNT_WETH_WEI, POOL_A_FEE_BPS); // Use Pool A fee
        const repaymentA = BORROW_AMOUNT_WETH_WEI + flashLoanFeeA;
        const profitA = finalWethOut - repaymentA;

        console.log(`  [Simulate A->B] Final WETH Output:   ${formatUnits(finalWethOut, WETH_DECIMALS)}`);
        console.log(`  [Simulate A->B] Required Repayment:  ${formatUnits(repaymentA, WETH_DECIMALS)} (Loan + ${formatUnits(flashLoanFeeA, WETH_DECIMALS)} Fee)`);

        if (profitA > 0n) {
          console.log(`  [Simulate A->B] ✅ Path Profitable! Net Profit: ${formatUnits(profitA, WETH_DECIMALS)} WETH`);
          // Initialize or update bestPath if this path is better
          if (!bestPath || profitA > bestPath.profit) {
              console.log(`    (Setting as best path)`);
              bestPath = {
                startPool: 'A',
                profit: profitA,
                // Add any other info needed by attemptArbitrage
                finalWethOut: finalWethOut,
                repayment: repaymentA,
              };
          }
        } else {
           console.log(`  [Simulate A->B] ❌ Path Not Profitable. (${formatUnits(profitA, WETH_DECIMALS)} WETH)`);
        }
      } else {
        console.warn(`  [Simulate A->B] Swap 2 (USDC->WETH on Pool B) Failed: ${simA2.reason}`);
      }
    } else {
      console.warn(`  [Simulate A->B] Swap 1 (WETH->USDC on Pool A) Failed: ${simA1.reason}`);
    }

    // --- Simulate B -> A ---
    console.log(`\n  --- Simulating Path B -> A (Borrow from B @ ${POOL_B_FEE_BPS} bps) ---`);
     // 1. Simulate Swap 1 on Pool B (WETH -> USDC)
    console.log(`  [Simulate B->A] 1. Quoting Swap B (${POOL_B_FEE_BPS} bps): ${formatUnits(BORROW_AMOUNT_WETH_WEI, WETH_DECIMALS)} WETH -> USDC...`);
    const simB1 = await tryQuote({
      tokenIn: WETH_ADDRESS,
      tokenOut: USDC_ADDRESS,
      amountIn: BORROW_AMOUNT_WETH_WEI,
      fee: POOL_B_FEE_BPS,
      quoter: quoterContract
    });

    if (simB1.success && simB1.amountOut > 0n) {
      const amountOutUSDC = simB1.amountOut;
      console.log(`    -> Got ${formatUnits(amountOutUSDC, USDC_DECIMALS)} USDC`);
      // 2. Simulate Swap 2 on Pool A (USDC -> WETH)
      console.log(`  [Simulate B->A] 2. Quoting Swap A (${POOL_A_FEE_BPS} bps): ${formatUnits(amountOutUSDC, USDC_DECIMALS)} USDC -> WETH...`);
      const simB2 = await tryQuote({
        tokenIn: USDC_ADDRESS,
        tokenOut: WETH_ADDRESS,
        amountIn: amountOutUSDC,
        fee: POOL_A_FEE_BPS,
        quoter: quoterContract
      });

      if (simB2.success && simB2.amountOut > 0n) {
        const finalWethOut = simB2.amountOut;
         // *** CORRECTED REPAYMENT CALCULATION FOR PATH B->A ***
        const flashLoanFeeB = calculateFlashLoanFee(BORROW_AMOUNT_WETH_WEI, POOL_B_FEE_BPS); // Use Pool B fee
        const repaymentB = BORROW_AMOUNT_WETH_WEI + flashLoanFeeB;
        const profitB = finalWethOut - repaymentB;

        console.log(`  [Simulate B->A] Final WETH Output:   ${formatUnits(finalWethOut, WETH_DECIMALS)}`);
        console.log(`  [Simulate B->A] Required Repayment:  ${formatUnits(repaymentB, WETH_DECIMALS)} (Loan + ${formatUnits(flashLoanFeeB, WETH_DECIMALS)} Fee)`);

        if (profitB > 0n) {
          console.log(`  [Simulate B->A] ✅ Path Profitable! Net Profit: ${formatUnits(profitB, WETH_DECIMALS)} WETH`);
           // Update bestPath if this path is profitable AND better than the A->B path result
           if (!bestPath || profitB > bestPath.profit) {
                console.log(`    (Setting as best path)`);
                bestPath = {
                  startPool: 'B',
                  profit: profitB,
                  // Add any other info needed by attemptArbitrage
                  finalWethOut: finalWethOut,
                  repayment: repaymentB,
                };
           }
        } else {
          console.log(`  [Simulate B->A] ❌ Path Not Profitable. (${formatUnits(profitB, WETH_DECIMALS)} WETH)`);
        }
      } else {
        console.warn(`  [Simulate B->A] Swap 2 (USDC->WETH on Pool A) Failed: ${simB2.reason}`);
      }
    } else {
      console.warn(`  [Simulate B->A] Swap 1 (WETH->USDC on Pool B) Failed: ${simB1.reason}`);
    }


    // --- Decide whether to proceed ---
    if (bestPath) {
      console.log(`\n  [Monitor] >>> PROFITABLE OPPORTUNITY IDENTIFIED <<<`);
      console.log(`            Start Pool: ${bestPath.startPool}, Est. Profit: ${formatUnits(bestPath.profit, WETH_DECIMALS)} WETH`);
      console.log(`  [Monitor] Triggering attemptArbitrage...`);
      // Add bestPath to state for attemptArbitrage to use
      state.opportunity = bestPath; // Overwrite or create opportunity object in state
      await attemptArbitrage(state); // Pass updated state
    } else {
      console.log(`\n  [Monitor] No profitable path found this round.`);
    }

  } catch (err) {
    console.error(`[Monitor] Unexpected error during simulation loop:`, err);
  }

  console.log(`[Monitor] ${new Date().toISOString()} - Cycle End.`);
}

module.exports = { monitorPools }; // Export monitorPools
