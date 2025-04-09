// helpers/arbitrage.js
const { ethers } = require('ethers');

async function attemptArbitrage(state) {
    const { signer, contracts, config, opportunity } = state;
    // ... (null checks for state parts) ...

    const startPoolId = opportunity.startPool; // 'A' or 'B'
    const estimatedProfit = opportunity.profit;

    console.log(`\n========= Arbitrage Attempt Triggered (Start Pool: ${startPoolId}) =========`);
    console.log(`  (Pre-simulation indicated profit: ${ethers.formatUnits(estimatedProfit || 0n, config.WETH_DECIMALS)} WETH)`);

    // --- Determine Path Parameters ---
    let flashLoanPoolAddress;     // Pool to borrow from
    let swapPoolAddress;          // Pool for BOTH swaps (the non-lending pool)
    let swapPoolFeeBps;           // Fee for the swap pool

    let borrowAmount0 = 0n; let borrowAmount1 = 0n;
    let tokenBorrowedAddress = config.WETH_ADDRESS;
    let tokenIntermediateAddress = config.USDC_ADDRESS;
    let amountToBorrowWei = config.BORROW_AMOUNT_WETH_WEI;

    // --- *** CORRECTED LOGIC FOR SWAP POOL *** ---
    if (startPoolId === 'A') {
        // Borrow from A, Both swaps happen on B
        flashLoanPoolAddress = config.POOL_A_ADDRESS;
        swapPoolAddress = config.POOL_B_ADDRESS; // BOTH swaps use Pool B
        swapPoolFeeBps = config.POOL_B_FEE_BPS;
        console.log(`  Configuring path: Borrow WETH from A (${config.POOL_A_FEE_BPS} bps), Swap B(${swapPoolFeeBps} bps) -> Swap B(${swapPoolFeeBps} bps) -> Repay A`);

    } else if (startPoolId === 'B') {
        // Borrow from B, Both swaps happen on A
        flashLoanPoolAddress = config.POOL_B_ADDRESS;
        swapPoolAddress = config.POOL_A_ADDRESS; // BOTH swaps use Pool A
        swapPoolFeeBps = config.POOL_A_FEE_BPS;
        console.log(`  Configuring path: Borrow WETH from B (${config.POOL_B_FEE_BPS} bps), Swap A(${swapPoolFeeBps} bps) -> Swap A(${swapPoolFeeBps} bps) -> Repay B`);

    } else { /* ... error handling ... */ return; }
    // --- *** END CORRECTED LOGIC *** ---


    // Assign Borrow Amounts (Still assuming WETH is token0)
    borrowAmount0 = amountToBorrowWei;
    borrowAmount1 = 0n;

    console.log(`  Executing Path: Borrow ${ethers.formatUnits(amountToBorrowWei, config.WETH_DECIMALS)} WETH from Pool ${startPoolId} (${flashLoanPoolAddress})`);
    console.log(`    -> Swap 1 on ${swapPoolAddress} (Fee: ${swapPoolFeeBps} bps)`);
    console.log(`    -> Swap 2 on ${swapPoolAddress} (Fee: ${swapPoolFeeBps} bps)`); // Note: Same pool and fee

    // --- Construct Callback Params (Using Single Swap Pool for Both Steps) ---
    const arbitrageParams = {
        tokenIntermediate: tokenIntermediateAddress,
        poolA: swapPoolAddress, feeA: swapPoolFeeBps, // Params for 1st swap (uses the single swap pool)
        poolB: swapPoolAddress, feeB: swapPoolFeeBps, // Params for 2nd swap (uses the SAME single swap pool)
        amountOutMinimum1: 0n,
        amountOutMinimum2: 0n
    };

    // The Solidity contract's ArbitrageParams struct uses poolA/feeA for swap1 and poolB/feeB for swap2.
    // By setting them both to the same swapPoolAddress/swapPoolFeeBps here, we instruct
    // the contract to perform both swaps on that non-locked pool.

    let encodedParams;
    try {
        console.log("  Encoding callback parameters...");
        // Type definition remains the same as it matches the Solidity struct
        const paramTypes = ['tuple(address tokenIntermediate, address poolA, uint24 feeA, address poolB, uint24 feeB, uint256 amountOutMinimum1, uint256 amountOutMinimum2)'];
        encodedParams = ethers.AbiCoder.defaultAbiCoder().encode(paramTypes, [arbitrageParams]);
    } catch (encodeError) { /* ... error handling ... */ return; }

    // --- initiateFlashSwap Args ---
    const initiateFlashSwapArgs = [
        flashLoanPoolAddress,
        borrowAmount0,
        borrowAmount1,
        encodedParams
    ];

    // --- Final Simulation (Static Call) & Estimation ---
    console.log("  Simulating initiateFlashSwap contract call...");
    try {
        // ... (staticCall and estimateGas logic remains the same) ...
        console.log("  [1/2] Attempting staticCall simulation...");
        await flashSwapContract.initiateFlashSwap.staticCall(...initiateFlashSwapArgs, { gasLimit: 3_000_000 });
        console.log("  ✅ [1/2] staticCall simulation successful.");

        console.log("  [2/2] Attempting estimateGas...");
        const estimatedGas = await flashSwapContract.initiateFlashSwap.estimateGas(...initiateFlashSwapArgs);
        console.log(`  ✅ [2/2] estimateGas successful. Estimated Gas: ${estimatedGas.toString()}`);

        console.warn("  >>> !!! SIMULATION SUCCESSFUL - Transaction Execution DISABLED !!! <<<");

    } catch (simulationError) {
        // ... (error handling remains the same, but hopefully won't hit LOK) ...
        console.error(`  ❌ Final Simulation failed: ${simulationError.reason || simulationError.message}`);
        // ... (detailed revert decoding) ...
    } finally {
        console.log("========= Arbitrage Attempt Complete =========");
    }
 }

module.exports = { attemptArbitrage };
