// helpers/arbitrage.js
// (Full File Content - Updated to read from state.opportunity)
const { ethers } = require('ethers');

// Flash loan fee calculation helper (can be shared/imported if needed elsewhere)
function calculateFlashLoanFee(amount, feeBps) {
    const feeBpsBigInt = BigInt(feeBps);
    const denominator = 1000000n; // Fee is in basis points (bps), need to divide by 1M
    return (amount * feeBpsBigInt) / denominator;
}

// --- Arbitrage Attempt Function --- Accepts state object
// Reads opportunity details from state.opportunity
async function attemptArbitrage(state) { // Only takes state now
    // Destructure necessary components from the state object
    const { signer, contracts, config, opportunity } = state; // Opportunity now holds bestPath info

    // Check if opportunity details exist from monitor.js
    if (!opportunity || !opportunity.startPool) {
        console.error("  [Attempt] Opportunity data (startPool) missing in state.opportunity. Aborting.");
        return;
    }
    // Ensure contracts and config are loaded
    if (!contracts || !config || !signer) {
        console.error("  [Attempt] Missing contracts, config, or signer in state. Aborting.");
        return;
    }
    const { flashSwapContract } = contracts; // Pool contracts aren't strictly needed here
    if (!flashSwapContract) {
        console.error("  [Attempt] FlashSwap contract instance missing in state.contracts. Aborting.");
        return;
    }

    // --- Get Details from Opportunity (Previously bestPath) ---
    const startPoolId = opportunity.startPool; // 'A' or 'B'
    const estimatedProfit = opportunity.profit; // Get simulated profit if needed for logging

    console.log(`\n========= Arbitrage Attempt Triggered (Start Pool: ${startPoolId}) =========`);
    console.log(`  (Pre-simulation indicated profit: ${ethers.formatUnits(estimatedProfit || 0n, config.WETH_DECIMALS)} WETH)`); // Log estimated profit

    // --- Determine Path Parameters ---
    let flashLoanPoolAddress;
    let borrowAmount0 = 0n; let borrowAmount1 = 0n;
    let tokenBorrowedAddress = config.WETH_ADDRESS; // Hardcoded WETH borrow for now
    let tokenIntermediateAddress = config.USDC_ADDRESS;
    let poolAForSwap; let poolBForSwap; // Address of pool for 1st swap, 2nd swap
    let feeAForSwap; let feeBForSwap; // Fee for 1st swap, 2nd swap
    let amountToBorrowWei = config.BORROW_AMOUNT_WETH_WEI;

    // Configure based on startPoolId determined by monitor.js
    if (startPoolId === 'A') {
        // Borrow from A (Pool A Fee), Swap 1 on A (Pool A Fee), Swap 2 on B (Pool B Fee)
        flashLoanPoolAddress = config.POOL_A_ADDRESS;
        poolAForSwap = config.POOL_A_ADDRESS; feeAForSwap = config.POOL_A_FEE_BPS;
        poolBForSwap = config.POOL_B_ADDRESS; feeBForSwap = config.POOL_B_FEE_BPS;
        console.log(`  Configuring path: Borrow WETH from A (${feeAForSwap} bps), Swap A(${feeAForSwap} bps) -> B(${feeBForSwap} bps)`);
    } else if (startPoolId === 'B') {
        // Borrow from B (Pool B Fee), Swap 1 on B (Pool B Fee), Swap 2 on A (Pool A Fee)
        flashLoanPoolAddress = config.POOL_B_ADDRESS;
        poolAForSwap = config.POOL_B_ADDRESS; feeAForSwap = config.POOL_B_FEE_BPS;
        poolBForSwap = config.POOL_A_ADDRESS; feeBForSwap = config.POOL_A_FEE_BPS;
        console.log(`  Configuring path: Borrow WETH from B (${feeAForSwap} bps), Swap B(${feeAForSwap} bps) -> A(${feeBForSwap} bps)`);
    } else {
        console.error("  [Attempt] Invalid startPoolId in opportunity data:", startPoolId);
        return;
    }

    // --- Assign Borrow Amounts (Assuming WETH is token0 - Needs Verification!) ---
    // !! IMPORTANT !!: This assumes WETH is token0 in BOTH POOL_A and POOL_B.
    // If USDC is token0 in one pool, this logic needs adjustment.
    // You'd need to check pool.token0() or store it in config.
    borrowAmount0 = amountToBorrowWei; // WETH amount
    borrowAmount1 = 0n; // USDC amount

    console.log(`  Executing Path: Borrow ${ethers.formatUnits(amountToBorrowWei, config.WETH_DECIMALS)} WETH from Pool ${startPoolId} (${flashLoanPoolAddress})`);
    console.log(`    -> Swap 1 on ${poolAForSwap} (Fee: ${feeAForSwap} bps)`);
    console.log(`    -> Swap 2 on ${poolBForSwap} (Fee: ${feeBForSwap} bps)`);

    // --- Construct Callback Params ---
    const arbitrageParams = {
        tokenIntermediate: tokenIntermediateAddress,
        poolA: poolAForSwap, feeA: feeAForSwap, // 1st Swap Params
        poolB: poolBForSwap, feeB: feeBForSwap, // 2nd Swap Params
        amountOutMinimum1: 0n, amountOutMinimum2: 0n // No slippage protection in this version
    };

    let encodedParams;
    try {
        console.log("  Encoding callback parameters...");
        const paramTypes = ['tuple(address tokenIntermediate, address poolA, uint24 feeA, address poolB, uint24 feeB, uint256 amountOutMinimum1, uint256 amountOutMinimum2)'];
        // Self-correction: Added fees to tuple definition
        encodedParams = ethers.AbiCoder.defaultAbiCoder().encode(paramTypes, [arbitrageParams]);
    } catch (encodeError) {
        console.error("  ❌ [Attempt] Error encoding arbitrage parameters:", encodeError);
        console.log("========= Arbitrage Attempt Complete (Encode Error) =========");
        return;
    }

    // --- initiateFlashSwap Args ---
    const initiateFlashSwapArgs = [
        flashLoanPoolAddress, // Pool to borrow from
        borrowAmount0,        // Amount of token0 (WETH) to borrow
        borrowAmount1,        // Amount of token1 (USDC) to borrow
        encodedParams         // Encoded data for the callback
    ];

    // --- Final Simulation (Static Call) & Estimation ---
    console.log("  Simulating initiateFlashSwap contract call...");
    try {
        if (!flashSwapContract.initiateFlashSwap || typeof flashSwapContract.initiateFlashSwap.staticCall !== 'function') {
            throw new Error("FlashSwap contract instance or 'initiateFlashSwap' function is invalid.");
        }

        // 1. Static Call (Final Check)
        console.log("  [1/2] Attempting staticCall simulation...");
        await flashSwapContract.initiateFlashSwap.staticCall(...initiateFlashSwapArgs, { gasLimit: 3_000_000 });
        console.log("  ✅ [1/2] staticCall simulation successful.");

        // 2. Estimate Gas (Only if static call succeeds)
        console.log("  [2/2] Attempting estimateGas...");
        const estimatedGas = await flashSwapContract.initiateFlashSwap.estimateGas(...initiateFlashSwapArgs);
        console.log(`  ✅ [2/2] estimateGas successful. Estimated Gas: ${estimatedGas.toString()}`);

        // --- Transaction Execution (DISABLED) ---
        console.warn("  >>> !!! SIMULATION SUCCESSFUL - Transaction Execution DISABLED !!! <<<");
        // Log execution details if needed
        // console.log("  Would execute with args:", initiateFlashSwapArgs);
        // console.log("  Estimated Gas:", estimatedGas.toString());

    } catch (simulationError) {
        console.error(`  ❌ Final Simulation failed: ${simulationError.reason || simulationError.message}`);
        if (simulationError.data && simulationError.data !== '0x') {
             try {
                 const decodedError = flashSwapContract.interface.parseError(simulationError.data);
                 console.error(`     Revert Reason: ${decodedError?.name}(${decodedError?.args})`);
             } catch (decodeErr) {
                 console.error(`     Raw Revert Data: ${simulationError.data}`);
             }
        }
    } finally {
        console.log("========= Arbitrage Attempt Complete =========");
    }
 } // <<< Closing brace for attemptArbitrage function

module.exports = { attemptArbitrage }; // Export the function
