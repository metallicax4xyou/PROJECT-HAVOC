// helpers/monitor.js
const { ethers } = require('ethers');
const { attemptArbitrage } = require('./arbitrage');

// --- Helper Functions --- (These belong OUTSIDE the main monitorPools function)

// Calculate Uniswap V3 Flash Loan Fee
function calculateFlashFee(amountBorrowed, feeBps) {
    const feeBpsBigInt = BigInt(feeBps);
    const denominator = 1000000n;
    return (amountBorrowed * feeBpsBigInt) / denominator;
}

// Tick-to-price helper
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

// Encode path for quoteExactInput
function encodePath(tokenAddresses, fees) {
    if (tokenAddresses.length !== fees.length + 1) {
        throw new Error("Path encoding error: Invalid lengths");
    }
    let encoded = '0x';
    for (let i = 0; i < fees.length; i++) {
        const addr = ethers.getAddress(tokenAddresses[i]);
        encoded += addr.slice(2);
        encoded += fees[i].toString(16).padStart(6, '0');
    }
    const finalAddr = ethers.getAddress(tokenAddresses[tokenAddresses.length - 1]);
    encoded += finalAddr.slice(2);
    return encoded.toLowerCase();
}

// --- Main Monitoring Function ---
async function monitorPools(state) { // <<< ALL LOGIC GOES INSIDE HERE
    const { contracts, config } = state;
    const { poolAContract, poolBContract, quoterContract } = contracts;

    // Check for necessary state components
    if (!poolAContract || !poolBContract || !quoterContract || !config) {
        console.error("[Monitor] Missing contracts or config in state. Skipping cycle.");
        return;
    }

    const poolADesc = `Pool A (${config.POOL_A_ADDRESS} - ${config.POOL_A_FEE_BPS / 100}%)`;
    const poolBDesc = `Pool B (${config.POOL_B_ADDRESS} - ${config.POOL_B_FEE_BPS / 100}%)`;
    console.log(`\n[Monitor] ${new Date().toISOString()} - Checking ${poolADesc} and ${poolBDesc}...`);

    // --- START Outer Try Block ---
    try {
        // Fetch pool states
        const results = await Promise.allSettled([
            poolAContract.slot0(), poolAContract.liquidity(),
            poolBContract.slot0(), poolBContract.liquidity()
        ]);

        // Process results
        const slotAResult = results[0], liqAResult = results[1];
        const slotBResult = results[2], liqBResult = results[3];
        let slotA = null, liqA = 0n, slotB = null, liqB = 0n;

        // Assign results safely
        if (slotAResult.status === 'fulfilled') slotA = slotAResult.value; else console.error(`[Monitor] Failed Fetch: Pool A slot0`);
        if (liqAResult.status === 'fulfilled') liqA = liqAResult.value; else console.error(`[Monitor] Failed Fetch: Pool A liquidity`);
        if (slotBResult.status === 'fulfilled') slotB = slotBResult.value; else console.error(`[Monitor] Failed Fetch: Pool B slot0`);
        if (liqBResult.status === 'fulfilled') liqB = liqBResult.value; else console.error(`[Monitor] Failed Fetch: Pool B liquidity`);

        // Log states
        console.log(`  [Monitor] ${poolADesc} State: Tick=${slotA?.tick}, Liquidity=${liqA.toString()}`);
        if (liqA === 0n && slotA) console.warn("    ⚠️ Pool A has ZERO active liquidity!");
        console.log(`  [Monitor] ${poolBDesc} State: Tick=${slotB?.tick}, Liquidity=${liqB.toString()}`);
        if (liqB === 0n && slotB) console.warn("    ⚠️ Pool B has ZERO active liquidity!");

        // Exit if core data missing or pools empty
        if (!slotA || !slotB || liqA === 0n || liqB === 0n) {
             console.log("  [Monitor] Cannot proceed due to missing state or 0 liquidity.");
             return; // Exit this cycle
        }

        // --- Basic Opportunity Check via Ticks ---
        const tickA = Number(slotA.tick);
        const tickB = Number(slotB.tick);
        const TICK_DIFF_THRESHOLD = 1;

        // --- DECLARE ALL VARIABLES needed in this scope ---
        let startPoolId = null; // <<< Declaration
        let flashLoanPoolFeeBps = 0;
        let swapPoolAddress = ethers.ZeroAddress;
        let swapPoolFeeBps = 0;
        let proceedToAttempt = false;
        let estimatedProfitWei = 0n;
        let quoteError = null;
        // --- END VARIABLE DECLARATIONS ---

        // Determine potential path
        if (tickB > tickA + TICK_DIFF_THRESHOLD) {
            startPoolId = 'A'; flashLoanPoolFeeBps = config.POOL_A_FEE_BPS;
            swapPoolAddress = config.POOL_B_ADDRESS; swapPoolFeeBps = config.POOL_B_FEE_BPS;
            console.log(`  [Monitor] Tick Check: Potential Start A (Borrow A, Swap B -> B)`);
        } else if (tickA > tickB + TICK_DIFF_THRESHOLD) {
            startPoolId = 'B'; flashLoanPoolFeeBps = config.POOL_B_FEE_BPS;
            swapPoolAddress = config.POOL_A_ADDRESS; swapPoolFeeBps = config.POOL_A_FEE_BPS;
            console.log(`  [Monitor] Tick Check: Potential Start B (Borrow B, Swap A -> A)`);
        } else { console.log(`  [Monitor] Tick Check: No significant tick difference.`); }


        // --- Accurate Pre-Simulation (using quoteExactInput diagnostic) ---
        if (startPoolId) { // <<< Check startPoolId AFTER potential assignment
            console.log(`  [Monitor] Performing multi-quote simulation (Alt Method - Sim Amount: ${config.MULTI_QUOTE_SIM_AMOUNT_WETH_STR} WETH)...`);
            const intendedBorrowAmount = config.BORROW_AMOUNT_WETH_WEI;
            const simAmountInInitial = config.MULTI_QUOTE_SIM_AMOUNT_WETH_WEI;
            const tokenInInitial = config.WETH_ADDRESS;
            const tokenIntermediate = config.USDC_ADDRESS;
            const tokenOutFinal = config.WETH_ADDRESS;

            // Calculate Repayment needed
            const flashFee = calculateFlashFee(intendedBorrowAmount, flashLoanPoolFeeBps);
            const requiredRepaymentAmount = intendedBorrowAmount + flashFee;
            console.log(`    Sim Alt: Intended Borrow: ${ethers.formatUnits(intendedBorrowAmount, config.WETH_DECIMALS)} WETH`);
            console.log(`    Sim Alt: Flash Fee Est:   ${ethers.formatUnits(flashFee, config.WETH_DECIMALS)} WETH (${flashLoanPoolFeeBps/100}%)`);
            console.log(`    Sim Alt: Repayment Req:   ${ethers.formatUnits(requiredRepaymentAmount, config.WETH_DECIMALS)} WETH`);

            // --- START Diagnostic Try Block ---
            try {
                // Simulate Swap 1
                const path1 = encodePath([tokenInInitial, tokenIntermediate], [swapPoolFeeBps]);
                console.log(`    Sim Alt: Swap 1 Path: ${path1}`);
                const simAmountIntermediateOut_Alt = await quoterContract.quoteExactInput.staticCall(path1, simAmountInInitial);

                if (simAmountIntermediateOut_Alt === 0n) throw new Error("Swap 1 (quoteExactInput) resulted in 0 output.");
                console.log(`    Sim Alt: Swap 1 (WETH->USDC @ ${swapPoolFeeBps/100}%) Output: ${ethers.formatUnits(simAmountIntermediateOut_Alt, config.USDC_DECIMALS)} USDC`);

                // Simulate Swap 2
                const path2 = encodePath([tokenIntermediate, tokenOutFinal], [swapPoolFeeBps]);
                console.log(`    Sim Alt: Swap 2 Path: ${path2}`);
                const simFinalAmountOut_Alt = await quoterContract.quoteExactInput.staticCall(path2, simAmountIntermediateOut_Alt);

                if (simFinalAmountOut_Alt === 0n) throw new Error("Swap 2 (quoteExactInput) resulted in 0 output.");
                console.log(`    Sim Alt: Swap 2 (USDC->WETH @ ${swapPoolFeeBps/100}%) Output: ${ethers.formatUnits(simFinalAmountOut_Alt, config.WETH_DECIMALS)} WETH`);

                // --- Profit Check ---
                let estimatedFinalAmountActual_Alt = 0n;
                if (simAmountInInitial > 0n) {
                    estimatedFinalAmountActual_Alt = (simFinalAmountOut_Alt * intendedBorrowAmount) / simAmountInInitial;
                } else { console.warn("    Sim Alt: simAmountInInitial is zero, cannot scale result."); }

                console.log(`    Sim Alt: Est. Final WETH (for ${config.BORROW_AMOUNT_WETH_STR} WETH borrow): ${ethers.formatUnits(estimatedFinalAmountActual_Alt, config.WETH_DECIMALS)}`);
                console.log(`    Sim Alt: Repayment Req:                       ${ethers.formatUnits(requiredRepaymentAmount, config.WETH_DECIMALS)}`);

                if (estimatedFinalAmountActual_Alt > requiredRepaymentAmount) {
                    estimatedProfitWei = estimatedFinalAmountActual_Alt - requiredRepaymentAmount;
                    console.log(`  [Monitor] ✅ Pre-Sim (Alt) SUCCESS: Est. Profit: ${ethers.formatUnits(estimatedProfitWei, config.WETH_DECIMALS)} WETH`);
                    if (estimatedProfitWei > 0n) proceedToAttempt = true;
                    else console.log(`  [Monitor] ❌ Pre-Sim (Alt) Result: Scaled profit zero/negative.`);
                } else {
                     console.log(`  [Monitor] ❌ Pre-Sim (Alt) Result: Est. final amount less than repayment.`);
                }

            } catch (error) { // Catch for quoteExactInput block
                quoteError = error;
                console.error(`  [Monitor] ❌ Pre-Sim Error (Alt - quoteExactInput): ${error.reason || error.message}`);
                if(error.data) console.error(`      Revert Data: ${error.data}`);
            } // --- END Diagnostic Try Block ---

        } // End if(startPoolId)


        // --- Trigger Arbitrage Attempt ---
        if (proceedToAttempt && startPoolId && !quoteError) {
             console.log("  [Monitor] Conditions met (Alt Sim). Triggering attemptArbitrage.");
             state.opportunity = { startPool: startPoolId, profit: estimatedProfitWei };
             await attemptArbitrage(state);
        } else if (startPoolId) {
             console.log("  [Monitor] Not proceeding to attemptArbitrage (Alt Pre-simulation failed or unprofitable).");
        }
        // No log needed if startPoolId was null


    // --- Catch block for the OUTER try ---
    } catch (error) {
        console.error(`[Monitor] CRITICAL Error during monitoring cycle:`, error);
    } finally {
        // --- Finally block ---
         console.log(`[Monitor] ${new Date().toISOString()} - Cycle End.`);
    } // --- END Outer Try Block ---

} // <<< --- END async function monitorPools ---

module.exports = { monitorPools };
