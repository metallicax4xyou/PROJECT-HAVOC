// helpers/arbitrage.js
const { ethers } = require('ethers');

async function attemptArbitrage(state) {
    // Destructure state, including contracts
    const { signer, contracts, config, opportunity } = state;

    // --- Comprehensive Null/Undefined Checks ---
    if (!opportunity || !opportunity.startPool) {
        console.error("  [Attempt] Opportunity data (startPool) missing in state.opportunity. Aborting.");
        return;
    }
    if (!signer) {
        console.error("  [Attempt] Signer missing in state. Aborting.");
        return;
    }
    if (!config) {
        console.error("  [Attempt] Config missing in state. Aborting.");
        return;
    }
    if (!contracts) {
        console.error("  [Attempt] Contracts object missing in state. Aborting.");
        return;
    }
    // *** Explicitly check for flashSwapContract within contracts ***
    if (!contracts.flashSwapContract) {
        console.error("  [Attempt] FlashSwap contract instance missing in state.contracts. Aborting.");
        return;
    }
    // *** Assign to local const AFTER verification ***
    const flashSwapContract = contracts.flashSwapContract;
    // --- End Checks ---

    const startPoolId = opportunity.startPool;
    const estimatedProfit = opportunity.profit;

    console.log(`\n========= Arbitrage Attempt Triggered (Start Pool: ${startPoolId}) =========`);
    console.log(`  (Pre-simulation indicated profit: ${ethers.formatUnits(estimatedProfit || 0n, config.WETH_DECIMALS)} WETH)`);

    // --- Determine Path Parameters ---
    let flashLoanPoolAddress;
    let swapPoolAddress;
    let swapPoolFeeBps;
    let borrowAmount0 = 0n; let borrowAmount1 = 0n;
    let tokenBorrowedAddress = config.WETH_ADDRESS;
    let tokenIntermediateAddress = config.USDC_ADDRESS;
    let amountToBorrowWei = config.BORROW_AMOUNT_WETH_WEI;

    if (startPoolId === 'A') {
        flashLoanPoolAddress = config.POOL_A_ADDRESS;
        swapPoolAddress = config.POOL_B_ADDRESS;
        swapPoolFeeBps = config.POOL_B_FEE_BPS;
        console.log(`  Configuring path: Borrow WETH from A (${config.POOL_A_FEE_BPS} bps), Swap B(${swapPoolFeeBps} bps) -> Swap B(${swapPoolFeeBps} bps) -> Repay A`);
    } else if (startPoolId === 'B') {
        flashLoanPoolAddress = config.POOL_B_ADDRESS;
        swapPoolAddress = config.POOL_A_ADDRESS;
        swapPoolFeeBps = config.POOL_A_FEE_BPS;
        console.log(`  Configuring path: Borrow WETH from B (${config.POOL_B_FEE_BPS} bps), Swap A(${swapPoolFeeBps} bps) -> Swap A(${swapPoolFeeBps} bps) -> Repay B`);
    } else {
        console.error("  [Attempt] Invalid startPoolId in opportunity data:", startPoolId);
        return;
    }

    borrowAmount0 = amountToBorrowWei;
    borrowAmount1 = 0n;

    console.log(`  Executing Path: Borrow ${ethers.formatUnits(amountToBorrowWei, config.WETH_DECIMALS)} WETH from Pool ${startPoolId} (${flashLoanPoolAddress})`);
    console.log(`    -> Swap 1 on ${swapPoolAddress} (Fee: ${swapPoolFeeBps} bps)`);
    console.log(`    -> Swap 2 on ${swapPoolAddress} (Fee: ${swapPoolFeeBps} bps)`);

    const arbitrageParams = {
        tokenIntermediate: tokenIntermediateAddress,
        poolA: swapPoolAddress, feeA: swapPoolFeeBps,
        poolB: swapPoolAddress, feeB: swapPoolFeeBps,
        amountOutMinimum1: 0n,
        amountOutMinimum2: 0n
    };

    let encodedParams;
    try {
        console.log("  Encoding callback parameters...");
        const paramTypes = ['tuple(address tokenIntermediate, address poolA, uint24 feeA, address poolB, uint24 feeB, uint256 amountOutMinimum1, uint256 amountOutMinimum2)'];
        encodedParams = ethers.AbiCoder.defaultAbiCoder().encode(paramTypes, [arbitrageParams]);
    } catch (encodeError) {
        console.error("  ❌ [Attempt] Error encoding arbitrage parameters:", encodeError);
        console.log("========= Arbitrage Attempt Complete (Encode Error) =========");
        return;
    }

    const initiateFlashSwapArgs = [
        flashLoanPoolAddress,
        borrowAmount0,
        borrowAmount1,
        encodedParams
    ];

    console.log("  Simulating initiateFlashSwap contract call...");
    try {
        // --- Simulation using the verified flashSwapContract constant ---
        if (typeof flashSwapContract.initiateFlashSwap !== 'function') {
             throw new Error("FlashSwap contract instance is missing 'initiateFlashSwap' function.");
        }

        console.log("  [1/2] Attempting staticCall simulation...");
        // flashSwapContract should be defined here
        await flashSwapContract.initiateFlashSwap.staticCall(...initiateFlashSwapArgs, { gasLimit: 3_000_000 });
        console.log("  ✅ [1/2] staticCall simulation successful.");

        console.log("  [2/2] Attempting estimateGas...");
        // flashSwapContract should be defined here
        const estimatedGas = await flashSwapContract.initiateFlashSwap.estimateGas(...initiateFlashSwapArgs);
        console.log(`  ✅ [2/2] estimateGas successful. Estimated Gas: ${estimatedGas.toString()}`);

        console.warn("  >>> !!! SIMULATION SUCCESSFUL - Transaction Execution DISABLED !!! <<<");

    } catch (simulationError) {
        // Check if it's the specific ReferenceError we saw, otherwise handle normally
        if (simulationError instanceof ReferenceError && simulationError.message.includes('flashSwapContract is not defined')) {
             console.error("  ❌ CRITICAL INTERNAL ERROR: flashSwapContract variable was unexpectedly undefined during simulation block.");
             // This indicates a deeper issue with JS scope or state management if it happens again
        } else {
            console.error(`  ❌ Final Simulation failed: ${simulationError.reason || simulationError.message}`);
            // Use contracts.flashSwapContract directly in catch block for safety
            if (simulationError.data && simulationError.data !== '0x' && contracts.flashSwapContract) {
                 try {
                     const decodedError = contracts.flashSwapContract.interface.parseError(simulationError.data);
                     if (decodedError.name === "Error") {
                         if (decodedError.args[0] === "LOK") console.error("     Decoded Reason: LOK (Pool locked)");
                         else console.error(`     Decoded Reason: ${decodedError.args[0]}`);
                     } else {
                        console.error(`     Revert Reason: ${decodedError?.name}(${decodedError?.args})`);
                     }
                 } catch (decodeErr) {
                     console.error(`     Raw Revert Data: ${simulationError.data}`);
                 }
            } else if (!contracts.flashSwapContract) {
                 console.error("     Could not decode revert data: flashSwapContract instance was missing.");
            }
        }
    } finally {
        console.log("========= Arbitrage Attempt Complete =========");
    }
 }

module.exports = { attemptArbitrage };
