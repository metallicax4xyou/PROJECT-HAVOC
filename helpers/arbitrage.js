// helpers/arbitrage.js
const { ethers } = require('ethers');
// No need to import config directly if we get it from state

// --- Arbitrage Attempt Function --- Accepts state object
async function attemptArbitrage(state) {
    // Destructure necessary components from the state object
    const { signer, contracts, config, opportunity } = state;
    const { flashSwapContract, poolAContract, poolBContract } = contracts; // Assuming these are in state.contracts

    if (!opportunity) { console.error("  [Attempt] Opportunity data missing in state."); return; }
    if (!flashSwapContract || !poolAContract || !poolBContract) { console.error("  [Attempt] Contract instances missing in state.contracts."); return; }
    if (!config) { console.error("  [Attempt] Config missing in state."); return; }
    if (!signer) { console.error("  [Attempt] Signer missing in state."); return; }


    const startPool = opportunity.startPool; // 'A' or 'B'
    console.log(`\n========= Arbitrage Attempt Triggered (Start Pool: ${startPool}) =========`);

    console.log(`  Pool A Addr: ${config.POOL_A_ADDRESS}, Fee: ${config.POOL_A_FEE_BPS}bps`);
    console.log(`  Pool B Addr: ${config.POOL_B_ADDRESS}, Fee: ${config.POOL_B_FEE_BPS}bps`);
    console.log(`  Using Start Pool: ${startPool}`);

    // Determine parameters based on the opportunity identified in monitorPools
    let flashLoanPoolAddress; let borrowAmount0 = 0n; let borrowAmount1 = 0n;
    let tokenBorrowedAddress; let tokenIntermediateAddress;
    let poolAForSwap; let poolBForSwap; // Address of pool for 1st swap, 2nd swap
    let feeAForSwap; let feeBForSwap; // Fee for 1st swap, 2nd swap
    let amountToBorrowWei;

    // Currently hardcoded to borrow WETH based on monitorPools logic
    const borrowTokenSymbol = "WETH"; // Should ideally come from opportunity if flexible
    console.log(`  Borrow Token: ${borrowTokenSymbol}`);

    if (borrowTokenSymbol === 'WETH') {
        tokenBorrowedAddress = config.WETH_ADDRESS;
        tokenIntermediateAddress = config.USDC_ADDRESS;
        amountToBorrowWei = config.BORROW_AMOUNT_WETH_WEI; // Use configured borrow amount
        borrowAmount0 = amountToBorrowWei; // WETH is token0 in the pools? Assume yes for now. Needs check based on actual pool token order.
        borrowAmount1 = 0n; // USDC amount is 0

        if (startPool === 'A') {
            // Borrow from A (0.05%), Swap on A (0.05%), Swap on B (0.30%)
            console.log("  Configuring path: Borrow WETH from A(0.05), Swap A(0.05) -> B(0.30)");
            flashLoanPoolAddress = config.POOL_A_ADDRESS;
            poolAForSwap = config.POOL_A_ADDRESS; // 1st swap pool
            feeAForSwap = config.POOL_A_FEE_BPS;  // 1st swap fee
            poolBForSwap = config.POOL_B_ADDRESS; // 2nd swap pool
            feeBForSwap = config.POOL_B_FEE_BPS;  // 2nd swap fee
        } else { // Start Pool B
            // Borrow from B (0.30%), Swap on B (0.30%), Swap on A (0.05%)
            console.log("  Configuring path: Borrow WETH from B(0.30), Swap B(0.30) -> A(0.05)");
            flashLoanPoolAddress = config.POOL_B_ADDRESS;
            poolAForSwap = config.POOL_B_ADDRESS; // 1st swap pool
            feeAForSwap = config.POOL_B_FEE_BPS;  // 1st swap fee
            poolBForSwap = config.POOL_A_ADDRESS; // 2nd swap pool
            feeBForSwap = config.POOL_A_FEE_BPS;  // 2nd swap fee
        }
    } else {
        console.error("  [Attempt] Only WETH borrowing is currently implemented.");
        return;
    }

     if (!flashLoanPoolAddress || !tokenBorrowedAddress || !tokenIntermediateAddress || !poolAForSwap || !poolBForSwap || feeAForSwap === undefined || feeBForSwap === undefined || amountToBorrowWei === undefined) {
         console.error("  [Attempt] Failed to determine all necessary parameters. Check token order assumptions.");
         return;
     }
     // TODO: Add check here: Is WETH actually token0 in flashLoanPoolAddress? If not, swap borrowAmount0 and borrowAmount1.


    console.log(`  Executing Path: Borrow ${ethers.formatUnits(amountToBorrowWei, config.WETH_DECIMALS)} ${borrowTokenSymbol} from Pool ${startPool} (${flashLoanPoolAddress})`);
    console.log(`    -> Swap 1 on ${poolAForSwap} (Fee: ${feeAForSwap}bps)`);
    console.log(`    -> Swap 2 on ${poolBForSwap} (Fee: ${feeBForSwap}bps)`);

    // --- Construct Callback Params ---
    const arbitrageParams = {
        tokenIntermediate: tokenIntermediateAddress,
        poolA: poolAForSwap, // Address for 1st swap
        poolB: poolBForSwap, // Address for 2nd swap
        feeA: feeAForSwap,   // Fee for 1st swap
        feeB: feeBForSwap,   // Fee for 2nd swap
        amountOutMinimum1: 0n, // We don't check minimums in this simplified version
        amountOutMinimum2: 0n
    };

    let encodedParams;
    try {
        console.log("  Encoding callback parameters...");
        const paramTypes = ['tuple(address tokenIntermediate, address poolA, address poolB, uint24 feeA, uint24 feeB, uint256 amountOutMinimum1, uint256 amountOutMinimum2)'];
        encodedParams = ethers.AbiCoder.defaultAbiCoder().encode(paramTypes, [arbitrageParams]);
        // console.log("  Callback Parameters (Encoded):", encodedParams); // Can be very long
    } catch (encodeError) {
        console.error("  ❌ [Attempt] Error encoding arbitrage parameters:", encodeError);
        console.log("========= Arbitrage Attempt Complete (Encode Error) =========");
        return;
    }

    // --- initiateFlashSwap Args ---
    // Ensure borrowAmount0/1 correspond to token0/token1 of the flashLoanPoolAddress
    // This requires knowing which token (WETH/USDC) is token0/token1 in POOL_A and POOL_B
    // For now, assuming WETH is token0 in both based on common convention, but this IS RISKY
    const initiateFlashSwapArgs = [
        flashLoanPoolAddress, // Pool to borrow from
        borrowAmount0,        // Amount of token0 to borrow
        borrowAmount1,        // Amount of token1 to borrow
        encodedParams         // Encoded data for the callback
    ];

    // --- Simulation & Estimation ---
    console.log("  Simulating initiateFlashSwap call...");
    try {
        if (!flashSwapContract.initiateFlashSwap || typeof flashSwapContract.initiateFlashSwap.staticCall !== 'function') {
             throw new Error("FlashSwap contract instance or 'initiateFlashSwap' function is invalid.");
        }

        // 1. Static Call (Simulation)
        console.log("  [1/2] Attempting staticCall simulation...");
        // Use callStatic in ethers v6
        await flashSwapContract.initiateFlashSwap.staticCall(
            ...initiateFlashSwapArgs,
            { gasLimit: 3_000_000 } // High gas limit for simulation
        );
        console.log("  ✅ [1/2] staticCall simulation successful.");

        // 2. Estimate Gas (Check if likely to succeed on chain)
        console.log("  [2/2] Attempting estimateGas...");
        const estimatedGas = await flashSwapContract.initiateFlashSwap.estimateGas(
            ...initiateFlashSwapArgs
            // No need for gasLimit override here unless estimateGas itself runs out of gas
        );
        console.log(`  ✅ [2/2] estimateGas successful. Estimated Gas: ${estimatedGas.toString()}`);

        // --- Transaction Execution (DISABLED) ---
        console.warn("  >>> !!! SIMULATION SUCCESSFUL - Transaction Execution DISABLED !!! <<<");
        console.log("  Would attempt to send transaction with estimated gas:", estimatedGas.toString());
        /*
        // Example Execution (Requires Signer connected to contract instance)
        const txOverrides = {
            gasLimit: estimatedGas + BigInt(100000) // Add buffer
            // Add gasPrice or maxFeePerGas/maxPriorityFeePerGas based on network type
        };
        console.log("  Sending transaction...");
        const tx = await flashSwapContract.initiateFlashSwap(...initiateFlashSwapArgs, txOverrides);
        console.log(`  Transaction submitted: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`  Transaction confirmed in block: ${receipt.blockNumber}`);
        console.log(`  Gas Used: ${receipt.gasUsed.toString()}`);
        */
        // --- End Disabled Execution ---

    } catch (simulationError) {
        console.error(`  ❌ Simulation failed: ${simulationError.reason || simulationError.message}`);
        // More detailed logging for revert reasons
        if (simulationError.data && simulationError.data !== '0x') {
            // Try decoding standard Error(string)
             try {
                 const decodedError = flashSwapContract.interface.parseError(simulationError.data);
                 console.error(`     Revert Reason: ${decodedError?.name}(${decodedError?.args})`);
             } catch (decodeErr) {
                 console.error(`     Raw Revert Data: ${simulationError.data}`);
             }
        }
         // Log stack trace for debugging code errors vs contract reverts
         // console.error("     Stack Trace:", simulationError.stack);
    } finally {
        console.log("========= Arbitrage Attempt Complete =========");
    }
 } // <<< Closing brace for attemptArbitrage function

module.exports = { attemptArbitrage };
