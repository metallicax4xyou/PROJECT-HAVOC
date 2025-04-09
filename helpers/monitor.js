// helpers/monitor.js
const { ethers } = require('ethers');
const { attemptArbitrage } = require('./arbitrage');

// ... (calculateFlashFee, tickToPrice helpers) ...

// --- NEW Helper: Encode path for quoteExactInput ---
function encodePath(tokenAddresses, fees) {
    if (tokenAddresses.length !== fees.length + 1) {
        throw new Error("Path encoding error: Invalid lengths");
    }
    let encoded = '0x';
    for (let i = 0; i < fees.length; i++) {
        // Remove '0x' prefix before concatenation
        encoded += tokenAddresses[i].slice(2);
        encoded += fees[i].toString(16).padStart(6, '0'); // fee is uint24, 3 bytes = 6 hex chars
    }
    encoded += tokenAddresses[tokenAddresses.length - 1].slice(2);
    return encoded.toLowerCase();
}


async function monitorPools(state) {
    const { contracts, config } = state;
    const { poolAContract, poolBContract, quoterContract } = contracts;
    // ... (null checks, pool descriptions, state fetching, liquidity checks) ...

    // --- Basic Opportunity Check via Ticks ---
    // ... (determine startPoolId, flashLoanPoolFeeBps, swapPoolAddress, swapPoolFeeBps) ...

    // --- Accurate Pre-Simulation if Potential Opportunity Found ---
    let proceedToAttempt = false;
    let estimatedProfitWei = 0n;

    if (startPoolId) {
        console.log(`  [Monitor] Performing multi-quote simulation (Sim Amount: ${config.MULTI_QUOTE_SIM_AMOUNT_WETH_STR} WETH)...`);
        const intendedBorrowAmount = config.BORROW_AMOUNT_WETH_WEI;
        const simAmountInInitial = config.MULTI_QUOTE_SIM_AMOUNT_WETH_WEI;
        const tokenInInitial = config.WETH_ADDRESS;
        const tokenIntermediate = config.USDC_ADDRESS;
        const tokenOutFinal = config.WETH_ADDRESS;

        // 1. Calculate Repayment (remains the same)
        // ... (calculate flashFee, requiredRepaymentAmount, log them) ...
        const flashFee = calculateFlashFee(intendedBorrowAmount, flashLoanPoolFeeBps);
        const requiredRepaymentAmount = intendedBorrowAmount + flashFee;
        console.log(`    Sim: Intended Borrow: ${ethers.formatUnits(intendedBorrowAmount, config.WETH_DECIMALS)} WETH`);
        console.log(`    Sim: Flash Fee Est:   ${ethers.formatUnits(flashFee, config.WETH_DECIMALS)} WETH (${flashLoanPoolFeeBps/100}%)`);
        console.log(`    Sim: Repayment Req:   ${ethers.formatUnits(requiredRepaymentAmount, config.WETH_DECIMALS)} WETH`);


        // --- Try Quoting using quoteExactInput as a diagnostic ---
        // This is less efficient but might bypass issues with quoteExactInputSingle
        let simAmountIntermediateOut_Alt = 0n;
        let simFinalAmountOut_Alt = 0n;
        let quoteError = null;

        try {
            // Simulate Swap 1 (WETH -> USDC via swapPool) using quoteExactInput
            const path1 = encodePath([tokenInInitial, tokenIntermediate], [swapPoolFeeBps]);
            console.log(`    Sim Alt: Swap 1 Path: ${path1}`);
            simAmountIntermediateOut_Alt = await quoterContract.quoteExactInput(path1, simAmountInInitial); // No struct needed

            if (simAmountIntermediateOut_Alt === 0n) throw new Error("Swap 1 (quoteExactInput) resulted in 0 output.");
            console.log(`    Sim Alt: Swap 1 (WETH->USDC @ ${swapPoolFeeBps/100}%) Output: ${ethers.formatUnits(simAmountIntermediateOut_Alt, config.USDC_DECIMALS)} USDC`);

            // Simulate Swap 2 (USDC -> WETH via swapPool) using quoteExactInput
             const path2 = encodePath([tokenIntermediate, tokenOutFinal], [swapPoolFeeBps]);
             console.log(`    Sim Alt: Swap 2 Path: ${path2}`);
             simFinalAmountOut_Alt = await quoterContract.quoteExactInput(path2, simAmountIntermediateOut_Alt);

             if (simFinalAmountOut_Alt === 0n) throw new Error("Swap 2 (quoteExactInput) resulted in 0 output.");
             console.log(`    Sim Alt: Swap 2 (USDC->WETH @ ${swapPoolFeeBps/100}%) Output: ${ethers.formatUnits(simFinalAmountOut_Alt, config.WETH_DECIMALS)} WETH`);

             // --- Profit Check using _Alt results ---
             let estimatedFinalAmountActual_Alt = 0n;
             if (simAmountInInitial > 0n) {
                 estimatedFinalAmountActual_Alt = (simFinalAmountOut_Alt * intendedBorrowAmount) / simAmountInInitial;
             }
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


        } catch (error) {
            quoteError = error; // Store error to log outside
            console.error(`  [Monitor] ❌ Pre-Sim Error (Alt - quoteExactInput): ${error.reason || error.message}`);
            if(error.data) console.error(`      Revert Data: ${error.data}`);
        }

        // --- END Diagnostic Section ---


        // --- Trigger Arbitrage Attempt ---
        // Only trigger if the ALT simulation succeeded and showed profit
        if (proceedToAttempt && startPoolId && !quoteError) { // <<< Added !quoteError check
             console.log("  [Monitor] Conditions met (Alt Sim). Triggering attemptArbitrage.");
             state.opportunity = { startPool: startPoolId, profit: estimatedProfitWei };
             await attemptArbitrage(state);
        } else if (startPoolId) {
             console.log("  [Monitor] Not proceeding to attemptArbitrage (Alt Pre-simulation failed or unprofitable).");
        }
        // ... (rest of function) ...

    } catch (error) { /*...*/ }
    finally { /*...*/ }
}

module.exports = { monitorPools };
