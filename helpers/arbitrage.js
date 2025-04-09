// helpers/arbitrage.js
const { ethers } = require('ethers');

async function attemptArbitrage(state) {
    const { signer, contracts, config, opportunity } = state;
    if (!opportunity || !opportunity.startPool) { /* ... error check ... */ return; }
    if (!contracts || !config || !signer) { /* ... error check ... */ return; }
    const { flashSwapContract } = contracts;
    if (!flashSwapContract) { /* ... error check ... */ return; }

    const startPoolId = opportunity.startPool; // 'A' or 'B'
    const estimatedProfit = opportunity.profit;

    console.log(`\n========= Arbitrage Attempt Triggered (Start Pool: ${startPoolId}) =========`);
    console.log(`  (Pre-simulation indicated profit: ${ethers.formatUnits(estimatedProfit || 0n, config.WETH_DECIMALS)} WETH)`);

    // --- Determine Path Parameters ---
    let flashLoanPoolAddress;     // Pool to borrow from
    let firstSwapPoolAddress;     // Pool for the FIRST swap in the callback
    let secondSwapPoolAddress;    // Pool for the SECOND swap in the callback
    let firstSwapFeeBps;
    let secondSwapFeeBps;

    let borrowAmount0 = 0n; let borrowAmount1 = 0n;
    let tokenBorrowedAddress = config.WETH_ADDRESS;
    let tokenIntermediateAddress = config.USDC_ADDRESS;
    let amountToBorrowWei = config.BORROW_AMOUNT_WETH_WEI;

    // --- *** CORRECTED LOGIC *** ---
    if (startPoolId === 'A') {
        // Borrow from A, Swap 1 must be on B, Swap 2 must be on A
        flashLoanPoolAddress = config.POOL_A_ADDRESS;
        firstSwapPoolAddress = config.POOL_B_ADDRESS; // SWAP 1 is on the OTHER pool
        firstSwapFeeBps = config.POOL_B_FEE_BPS;
        secondSwapPoolAddress = config.POOL_A_ADDRESS; // SWAP 2 is back on the loan pool (or another)
        secondSwapFeeBps = config.POOL_A_FEE_BPS;
        console.log(`  Configuring path: Borrow WETH from A (${config.POOL_A_FEE_BPS} bps), Swap B(${firstSwapFeeBps} bps) -> A(${secondSwapFeeBps} bps)`);

    } else if (startPoolId === 'B') {
        // Borrow from B, Swap 1 must be on A, Swap 2 must be on B
        flashLoanPoolAddress = config.POOL_B_ADDRESS;
        firstSwapPoolAddress = config.POOL_A_ADDRESS; // SWAP 1 is on the OTHER pool
        firstSwapFeeBps = config.POOL_A_FEE_BPS;
        secondSwapPoolAddress = config.POOL_B_ADDRESS; // SWAP 2 is back on the loan pool (or another)
        secondSwapFeeBps = config.POOL_B_FEE_BPS;
        console.log(`  Configuring path: Borrow WETH from B (${config.POOL_B_FEE_BPS} bps), Swap A(${firstSwapFeeBps} bps) -> B(${secondSwapFeeBps} bps)`);

    } else { /* ... error handling ... */ return; }
    // --- *** END CORRECTED LOGIC *** ---


    // Assign Borrow Amounts (Still assuming WETH is token0)
    borrowAmount0 = amountToBorrowWei;
    borrowAmount1 = 0n;

    console.log(`  Executing Path: Borrow ${ethers.formatUnits(amountToBorrowWei, config.WETH_DECIMALS)} WETH from Pool ${startPoolId} (${flashLoanPoolAddress})`);
    console.log(`    -> Swap 1 on ${firstSwapPoolAddress} (Fee: ${firstSwapFeeBps} bps)`);
    console.log(`    -> Swap 2 on ${secondSwapPoolAddress} (Fee: ${secondSwapFeeBps} bps)`);

    // --- Construct Callback Params (Using Corrected Pool Order) ---
    const arbitrageParams = {
        tokenIntermediate: tokenIntermediateAddress,
        poolA: firstSwapPoolAddress, feeA: firstSwapFeeBps,   // Use the dynamically determined 1st swap pool/fee
        poolB: secondSwapPoolAddress, feeB: secondSwapFeeBps, // Use the dynamically determined 2nd swap pool/fee
        amountOutMinimum1: 0n,
        amountOutMinimum2: 0n
    };

    let encodedParams;
    try {
        console.log("  Encoding callback parameters...");
        // Ensure this type matches the (corrected) Solidity struct order
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
        console.error(`  ❌ Final Simulation failed: ${simulationError.reason || simulationError.message}`);
        if (simulationError.data && simulationError.data !== '0x') {
             try {
                 const decodedError = flashSwapContract.interface.parseError(simulationError.data);
                 // Try to decode Uniswap V3 errors specifically if possible
                 if (decodedError.name === "Error") { // Generic Error(string)
                     // Check for known Uniswap reverts
                     if (decodedError.args[0] === "LOK") console.error("     Decoded Reason: LOK (Pool locked - Likely re-entrancy)");
                     else console.error(`     Decoded Reason: ${decodedError.args[0]}`);
                 } else {
                    console.error(`     Revert Reason: ${decodedError?.name}(${decodedError?.args})`);
                 }
             } catch (decodeErr) {
                 console.error(`     Raw Revert Data: ${simulationError.data}`);
             }
        }
    } finally {
        console.log("========= Arbitrage Attempt Complete =========");
    }
 }

module.exports = { attemptArbitrage };
