// helpers/arbitrage.js
const { ethers } = require('ethers');

// Function to attempt the arbitrage trade based on a validated opportunity
async function attemptArbitrage(state) {
    // Destructure the necessary parts from the state object
    const { signer, contracts, config, networkName, opportunity, feeData } = state;

    // --- Input Validation ---
    if (!opportunity) { console.error("  [Attempt] Opportunity data missing. Aborting."); return; }
    if (!signer) { console.error("  [Attempt] Signer missing. Aborting."); return; }
    if (!config) { console.error("  [Attempt] Config missing. Aborting."); return; }
    if (!contracts?.flashSwapContract) { console.error("  [Attempt] FlashSwap contract instance missing. Aborting."); return; }
    if (!feeData) { console.error("  [Attempt] FeeData missing. Aborting."); return; }

    // Destructure the opportunity object for clarity
    const {
        startPoolInfo,
        swapPoolInfo,
        tokenBorrowed,
        tokenIntermediate,
        borrowAmount,
        estimatedNetProfit,
        amountOutMinimum1, // Calculated minimum intermediate token out (Swap 1)
        amountOutMinimum2, // Calculated minimum borrowed token out (Swap 2)
        swapFeeA,          // Fee tier for Swap 1 (X -> Y on swapPool)
        swapFeeB,          // Fee tier for Swap 2 (Y -> X on swapPool)
        estimatedGasCost
    } = opportunity;

    // Extract addresses and details needed for the call
    const flashLoanPoolAddress = startPoolInfo.address; // Pool to borrow from
    const swapPoolAddress = swapPoolInfo.address; // Pool used for swaps (address needed for params struct even if ignored by logic)
    const tokenBorrowedAddress = tokenBorrowed.address;
    const tokenIntermediateAddress = tokenIntermediate.address;

    console.log(`\n========= Arbitrage Attempt Triggered (${networkName}) =========`);
    console.log(`  Opportunity Ref: ${opportunity.groupKey} | Start ${startPoolInfo.feeBps}bps -> Swap ${swapPoolInfo.feeBps}bps`);
    console.log(`  Flash Loan Pool: ${flashLoanPoolAddress}`);
    console.log(`  Swap Route Pool: ${swapPoolAddress} (Fees: ${swapFeeA}bps -> ${swapFeeB}bps)`);
    console.log(`  Borrowing:       ${ethers.formatUnits(borrowAmount, tokenBorrowed.decimals)} ${tokenBorrowed.symbol} (${tokenBorrowedAddress})`);
    console.log(`  Intermediate:    ${tokenIntermediate.symbol} (${tokenIntermediateAddress})`);
    console.log(`  Est. Net Profit: ${ethers.formatUnits(estimatedNetProfit, tokenBorrowed.decimals)} ${tokenBorrowed.symbol}`);
    console.log(`  Min Out Swap 1:  ${ethers.formatUnits(amountOutMinimum1, tokenIntermediate.decimals)} ${tokenIntermediate.symbol}`);
    console.log(`  Min Out Swap 2:  ${ethers.formatUnits(amountOutMinimum2, tokenBorrowed.decimals)} ${tokenBorrowed.symbol}`);
    console.log(`  Est. Gas Cost:   ${ethers.formatUnits(estimatedGasCost, config.NATIVE_SYMBOL === 'MATIC' ? 18 : 18)} ${config.NATIVE_SYMBOL}`);


    // --- Determine amount0 and amount1 for the flash call ---
    // The flash call requires specifying which amount (0 or 1) corresponds to the token being borrowed.
    let amount0ToBorrow = 0n;
    let amount1ToBorrow = 0n;

    // Get token0/token1 from the START POOL
    const startPoolContract = new ethers.Contract(flashLoanPoolAddress, contracts.flashSwapContract.interface, provider); // minimal interface okay
     // TODO: Potentially cache these token0/token1 lookups or get them earlier
    let startPoolToken0Addr, startPoolToken1Addr;
     try {
          [startPoolToken0Addr, startPoolToken1Addr] = await Promise.all([
              startPoolContract.token0(),
              startPoolContract.token1()
          ]);
     } catch (tokenFetchError) {
         console.error(`  ❌ Error fetching token0/token1 from start pool ${flashLoanPoolAddress}: ${tokenFetchError.message}`);
         console.log("========= Arbitrage Attempt Complete (Pool Token Fetch Error) =========");
         return;
     }

    if (ethers.getAddress(tokenBorrowedAddress) === ethers.getAddress(startPoolToken0Addr)) {
        amount0ToBorrow = borrowAmount;
        console.log(`  Borrowing token0 from Start Pool.`);
    } else if (ethers.getAddress(tokenBorrowedAddress) === ethers.getAddress(startPoolToken1Addr)) {
        amount1ToBorrow = borrowAmount;
        console.log(`  Borrowing token1 from Start Pool.`);
    } else {
        console.error(`  ❌ [Attempt] Internal Error: Borrowed token ${tokenBorrowedAddress} does not match token0 (${startPoolToken0Addr}) or token1 (${startPoolToken1Addr}) of the start pool ${flashLoanPoolAddress}.`);
        console.log("========= Arbitrage Attempt Complete (Token Mismatch Error) =========");
        return;
    }

    // --- Prepare Arbitrage Parameters for Callback ---
    // Struct definition in Solidity:
    // struct ArbitrageParams { address tokenIntermediate; address poolA; uint24 feeA; address poolB; uint24 feeB; uint amountOutMinimum1; uint amountOutMinimum2; }
    const arbitrageParams = {
        tokenIntermediate: tokenIntermediateAddress,
        poolA: swapPoolAddress, // Address is technically ignored by router, but provide swap pool for clarity
        feeA: swapFeeA,         // Correct fee for Swap 1 (X -> Y)
        poolB: swapPoolAddress, // Address is technically ignored by router, but provide swap pool for clarity
        feeB: swapFeeB,         // Correct fee for Swap 2 (Y -> X)
        amountOutMinimum1: amountOutMinimum1, // Min intermediate tokens from Swap 1
        amountOutMinimum2: amountOutMinimum2  // Min borrowed tokens from Swap 2
    };

    // --- Encode Callback Parameters ---
    let encodedParams;
    try {
        console.log("  Encoding callback parameters...");
        // Ensure the tuple structure matches the Solidity struct definition EXACTLY
        const paramTypes = ['(address tokenIntermediate, address poolA, uint24 feeA, address poolB, uint24 feeB, uint256 amountOutMinimum1, uint256 amountOutMinimum2)'];
        encodedParams = ethers.AbiCoder.defaultAbiCoder().encode(paramTypes, [arbitrageParams]);
        console.log("  Encoding successful.");
    } catch (encodeError) {
        console.error("  ❌ [Attempt] Error encoding arbitrage parameters:", encodeError);
        console.log("========= Arbitrage Attempt Complete (Encode Error) =========");
        return;
    }

    // --- Prepare Arguments for initiateFlashSwap ---
    const initiateFlashSwapArgs = [
        flashLoanPoolAddress, // Pool to borrow from
        amount0ToBorrow,      // Amount of token0 to borrow
        amount1ToBorrow,      // Amount of token1 to borrow
        encodedParams         // Encoded ArbitrageParams struct
    ];

    // --- Transaction Simulation & Execution ---
    console.log("  Simulating initiateFlashSwap contract call...");
    const flashSwapContract = contracts.flashSwapContract; // Use verified instance

    try {
        // 1. Static Call Simulation (Checks for basic reverts)
        console.log("  [1/2] Attempting staticCall simulation...");
        await flashSwapContract.initiateFlashSwap.staticCall(
            ...initiateFlashSwapArgs,
            { from: signer.address, gasLimit: config.GAS_LIMIT_ESTIMATE } // Specify gasLimit for simulation
        );
        console.log("  ✅ [1/2] staticCall simulation successful.");

        // 2. Gas Estimation (More accurate cost prediction)
        console.log("  [2/2] Attempting estimateGas...");
        const estimatedGas = await flashSwapContract.initiateFlashSwap.estimateGas(
            ...initiateFlashSwapArgs,
            { from: signer.address } // Don't need gasLimit for estimateGas itself
        );
        const gasLimitWithBuffer = (estimatedGas * 120n) / 100n; // Add 20% buffer to estimated gas
        console.log(`  ✅ [2/2] estimateGas successful. Estimated: ${estimatedGas.toString()}, With Buffer: ${gasLimitWithBuffer.toString()}`);

        // 3. Execution (DISABLED - Uncomment to enable live trading)
        // =============================================================
        // console.log("  >>> EXECUTION ENABLED - Sending Transaction! <<<");
        // const txOverrides = {
        //     gasLimit: gasLimitWithBuffer,
        //     maxFeePerGas: feeData.maxFeePerGas, // Use current EIP-1559 fees
        //     maxPriorityFeePerGas: feeData.maxPriorityFeePerGas // Use current EIP-1559 fees
        // };
        // const tx = await flashSwapContract.initiateFlashSwap(...initiateFlashSwapArgs, txOverrides);
        // console.log(`  Transaction Sent! Hash: ${tx.hash}`);
        // console.log(`  Waiting for receipt...`);
        // const receipt = await tx.wait();
        // console.log(`  Transaction Confirmed! Block: ${receipt.blockNumber}, Gas Used: ${receipt.gasUsed.toString()}`);
        // // Potentially log profit events from the receipt here if needed
        // =============================================================
        console.warn("  >>> !!! SIMULATION SUCCESSFUL - Transaction Execution DISABLED !!! <<<");
        console.warn("  >>> !!! Uncomment code block above in helpers/arbitrage.js to enable live trading !!! <<<");


    } catch (simulationError) {
        // Handle simulation errors (staticCall or estimateGas failures)
        console.error(`  ❌ Final Simulation or Execution failed:`);

        // Attempt to decode Solidity revert reason
        if (simulationError.data && simulationError.data !== '0x') {
             try {
                 const decodedError = flashSwapContract.interface.parseError(simulationError.data);
                 // Check for standard Error(string) used in the contract
                 if (decodedError && decodedError.name === "Error" && decodedError.args.length > 0) {
                     const reason = decodedError.args[0];
                     // Check for specific known errors
                     if (reason === "LOK") console.error("     Decoded Reason: LOK (Pool locked - likely temporary)");
                     else if (reason === "FlashSwap: Insufficient funds to repay loan + fee") console.error("     Decoded Reason: Insufficient funds to repay (Simulation predicted profit, but reality differed or slippage too high)");
                     else console.error(`     Decoded Reason: ${reason}`);

                 } else if (decodedError) {
                     console.error(`     Decoded Revert: ${decodedError.name}(${decodedError.args})`);
                 } else {
                      console.error(`     Could not parse known error interface from data: ${simulationError.data}`);
                 }
             } catch (decodeErr) {
                  console.error(`     Error decoding revert data: ${decodeErr.message}`);
                  console.error(`     Raw Revert Data: ${simulationError.data}`);
             }
        } else {
             // If no data, print the general error message
             console.error(`     Reason: ${simulationError.reason || simulationError.message}`);
        }
         // Log the full error object *if* debugging is needed
         // console.error("    Full Simulation Error Object:", simulationError);
    } finally {
        console.log("========= Arbitrage Attempt Complete =========");
    }
 }

module.exports = { attemptArbitrage };
