// bot.js
// ... (Keep imports, config, ABIs) ...

// --- Helper Function: Calculate Price from sqrtPriceX96 ---
// ... (Keep sqrtPriceX96ToPrice function as is) ...

// --- Provider & Signer ---
// ... (Keep Provider & Signer setup) ...

// --- Contract Instances ---
// ... (Keep Contract Instances setup) ...


// --- Main Bot Logic ---
async function checkArbitrage() {
    console.log(`\n[${new Date().toISOString()}] Checking for arbitrage: ${POOL_WETH_USDC_005} vs ${POOL_WETH_USDC_030}`);

    try {
        // 1. Get Current Pool Data
        const [slot0_005, slot0_030, token0_pool005, token1_pool005] = await Promise.all([
             pool005.slot0(),
             pool030.slot0(),
             pool005.token0(), // Get both tokens to be sure
             pool005.token1()
        ]);

        const sqrtPriceX96_005 = slot0_005.sqrtPriceX96;
        const sqrtPriceX96_030 = slot0_030.sqrtPriceX96;

        // --- Determine Actual Token Order and Decimals ---
        let token0Address, token1Address, decimals0, decimals1;
        // Check based on the fetched token0 address
        if (token0_pool005.toLowerCase() === WETH_ADDRESS.toLowerCase()) {
            console.log("   Token Order: WETH (Token0) / USDC (Token1)");
            token0Address = WETH_ADDRESS; decimals0 = WETH_DECIMALS;
            token1Address = USDC_ADDRESS; decimals1 = USDC_DECIMALS;
            // Sanity check token1
            if (token1_pool005.toLowerCase() !== USDC_ADDRESS.toLowerCase()) {
                 console.error(`❌ Mismatched token1! Expected ${USDC_ADDRESS}, got ${token1_pool005}. Aborting.`);
                 return;
            }
        } else if (token0_pool005.toLowerCase() === USDC_ADDRESS.toLowerCase()) {
            // This case is currently unexpected based on the error, but handle defensively
             console.log("   Token Order: USDC (Token0) / WETH (Token1)");
            token0Address = USDC_ADDRESS; decimals0 = USDC_DECIMALS;
            token1Address = WETH_ADDRESS; decimals1 = WETH_DECIMALS;
             // Sanity check token1
             if (token1_pool005.toLowerCase() !== WETH_ADDRESS.toLowerCase()) {
                 console.error(`❌ Mismatched token1! Expected ${WETH_ADDRESS}, got ${token1_pool005}. Aborting.`);
                 return;
             }
        } else {
             console.error(`❌ Unexpected token0 ${token0_pool005} in Pool ${POOL_WETH_USDC_005}. Aborting.`);
             return;
        }

        // 2. Calculate Prices (Price = Token1 / Token0)
        // Since Token1 is now USDC and Token0 is WETH, the price represents USDC per WETH.
        const price_005 = sqrtPriceX96ToPrice(sqrtPriceX96_005, decimals0, decimals1);
        const price_030 = sqrtPriceX96ToPrice(sqrtPriceX96_030, decimals0, decimals1); // Assume same order for 0.30% pool

        console.log(`   Pool 0.05% Price (USDC/WETH): ${price_005.toFixed(decimals1)}`); // Display with Token1 (USDC) decimals
        console.log(`   Pool 0.30% Price (USDC/WETH): ${price_030.toFixed(decimals1)}`);
        const priceDiffPercent = Math.abs(price_005 - price_030) / Math.min(price_005, price_030) * 100;
        console.log(`   Price Difference: ${priceDiffPercent.toFixed(4)}%`);


        // 3. Identify Potential Arbitrage Direction & Parameters
        // Strategy: Borrow WETH (token0), Sell WETH->USDC (Pool A=higher price), Buy WETH<-USDC (Pool B=lower price), Repay WETH
        // Price here is USDC/WETH. Higher price means WETH is more expensive (better to sell WETH).

        const BORROW_TOKEN = WETH_ADDRESS; // Still borrowing WETH (which is token0)
        const INTERMEDIATE_TOKEN = USDC_ADDRESS; // Swapping through USDC (which is token1)

        let poolA, feeA, poolB, feeB, loanPool;
        if (price_030 > price_005) { // Sell WETH where price (USDC/WETH) is higher (Pool 0.30)
            poolA = POOL_WETH_USDC_030; feeA = 3000;
            poolB = POOL_WETH_USDC_005; feeB = 500;
            loanPool = poolA;
            console.log(`   Potential Path: Borrow WETH(0) from ${loanPool}, Sell WETH(0)->USDC(1)@${feeA/10000}%, Buy WETH(0)<-USDC(1)@${feeB/10000}%`);
        } else if (price_005 > price_030) { // Sell WETH where price is higher (Pool 0.05)
            poolA = POOL_WETH_USDC_005; feeA = 500;
            poolB = POOL_WETH_USDC_030; feeB = 3000;
            loanPool = poolA;
            console.log(`   Potential Path: Borrow WETH(0) from ${loanPool}, Sell WETH(0)->USDC(1)@${feeA/10000}%, Buy WETH(0)<-USDC(1)@${feeB/10000}%`);
        } else {
             console.log(`   Prices are equal or too close. No arbitrage opportunity.`);
             return;
        }


        // 4. Calculate Expected Output & Profitability (CRITICAL TODO)
        // TODO: Implement actual swap simulation logic. This placeholder is now conceptually misaligned with token order.
        const amountToBorrow = ethers.parseUnits("0.01", WETH_DECIMALS); // Borrow 0.01 WETH (Token0)
        console.log(`   Simulating borrow of ${ethers.formatUnits(amountToBorrow, WETH_DECIMALS)} WETH (Token0)...`);

        // --- !! Placeholder Simulation - Needs replacing & REVERSING !! ---
        // Swap 1: WETH -> USDC. Output should be USDC.
        const expectedIntermediateFromSwap1 = ethers.parseUnits("35.0", USDC_DECIMALS); // Placeholder USDC amount
        // Swap 2: USDC -> WETH. Output should be WETH.
        const expectedFinalFromSwap2 = ethers.parseUnits("0.01005", WETH_DECIMALS); // Placeholder WETH amount

        const loanPoolFeeTier = feeA;
        const flashLoanFee = (amountToBorrow * BigInt(loanPoolFeeTier)) / 1000000n;
        const totalAmountToRepay = amountToBorrow + flashLoanFee; // Repay WETH (Token0)
        const potentialProfitWeth = expectedFinalFromSwap2 - totalAmountToRepay; // Profit in WETH (Token0)

        console.log(`   Expected USDC(1) (Swap 1): ${ethers.formatUnits(expectedIntermediateFromSwap1, USDC_DECIMALS)}`);
        console.log(`   Expected WETH(0) (Swap 2): ${ethers.formatUnits(expectedFinalFromSwap2, WETH_DECIMALS)}`);
        console.log(`   Flash Loan Fee (WETH(0)): ${ethers.formatUnits(flashLoanFee, WETH_DECIMALS)}`);
        console.log(`   Total WETH(0) to Repay: ${ethers.formatUnits(totalAmountToRepay, WETH_DECIMALS)}`);
        console.log(`   Potential Profit (WETH(0), before gas): ${ethers.formatUnits(potentialProfitWeth, WETH_DECIMALS)}`);


        // 5. Estimate Gas Cost (CRITICAL TODO)
        // ... (Keep placeholder gas cost logic) ...
        const estimatedGasCostWei = ethers.parseUnits("0.0001", "ether");
        const estimatedGasCostWeth = estimatedGasCostWei;
        console.log(`   Estimated Gas Cost (WETH): ${ethers.formatUnits(estimatedGasCostWeth, WETH_DECIMALS)}`);


        // 6. Check Profitability (After Gas)
        const netProfitWeth = potentialProfitWeth - estimatedGasCostWeth;
        console.log(`   Net Profit (WETH, after estimated gas): ${ethers.formatUnits(netProfitWeth, WETH_DECIMALS)}`);
        const MIN_PROFIT_THRESHOLD_WETH = ethers.parseUnits("0.00001", WETH_DECIMALS);

        if (netProfitWeth > MIN_PROFIT_THRESHOLD_WETH) {
            console.log("✅ PROFITABLE OPPORTUNITY DETECTED! Preparing flash swap...");

            // 7. Construct Arbitrage Parameters
            // TODO: Calculate amountOutMinimum based on REAL simulation results minus slippage
            const slippageTolerance = 0.001;
            const amountOutMinimum1 = expectedIntermediateFromSwap1 * BigInt(Math.floor((1 - slippageTolerance) * 10000)) / 10000n; // Min USDC(1) from Swap 1
            const requiredRepaymentThreshold = totalAmountToRepay + MIN_PROFIT_THRESHOLD_WETH;
            const amountOutMinimum2 = requiredRepaymentThreshold * BigInt(Math.floor((1 - slippageTolerance) * 10000)) / 10000n; // Min WETH(0) from Swap 2

            console.log(`   Setting amountOutMinimum1 (USDC(1)): ${ethers.formatUnits(amountOutMinimum1, USDC_DECIMALS)}`);
            console.log(`   Setting amountOutMinimum2 (WETH(0)): ${ethers.formatUnits(amountOutMinimum2, WETH_DECIMALS)}`);

            // Pass tokens/pools/fees to the contract based on the detected route
            const arbitrageParams = ethers.AbiCoder.defaultAbiCoder().encode(
                ['address', 'address', 'address', 'uint24', 'uint24', 'uint256', 'uint256'],
                [INTERMEDIATE_TOKEN, poolA, poolB, feeA, feeB, amountOutMinimum1, amountOutMinimum2]
            );

            // Determine amount0/amount1 based on BORROW_TOKEN (WETH) which is token0
            let amount0 = 0n;
            let amount1 = 0n;
            if (BORROW_TOKEN.toLowerCase() === token0Address.toLowerCase()) { // WETH is token0
                 amount0 = amountToBorrow;
            } else { // WETH is token1 (should not happen with current logic)
                 amount1 = amountToBorrow;
                 console.error("Error: Borrowing WETH logic assumes it's token0 for this pair.");
                 return;
            }

            // 8. Execute Flash Swap Transaction
            console.log(`   Executing initiateFlashSwap on contract ${FLASH_SWAP_CONTRACT_ADDRESS}...`);
            console.log(`     Loan Pool: ${loanPool}`);
            console.log(`     Amount0: ${ethers.formatUnits(amount0, WETH_DECIMALS)} WETH(0)`); // Log amount0 as WETH
            console.log(`     Amount1: ${amount1.toString()}`); // amount1 should be 0
            console.warn("   !!! EXECUTING TRANSACTION WITH HARDCODED SIMULATION & GAS !!!");

            try {
                // ... (Keep transaction execution try/catch block) ...
                 const tx = await flashSwapContract.initiateFlashSwap(
                    loanPool,
                    amount0,
                    amount1,
                    arbitrageParams
                );
                console.log(`   ✅ Transaction Sent: ${tx.hash}`);
                console.log(`   ⏳ Waiting for confirmation...`);
                const receipt = await tx.wait(1);
                console.log(`   ✅ Transaction Confirmed! Block: ${receipt.blockNumber}, Gas Used: ${receipt.gasUsed.toString()}`);

            } catch (executionError) {
                 // ... (Keep error handling for execution) ...
                 console.error(`   ❌ Flash Swap Transaction Failed: ${executionError.message}`);
                 if (executionError.data && executionError.data !== '0x') {
                    try {
                        const decodedError = flashSwapContract.interface.parseError(executionError.data);
                        console.error(`   Contract Revert Reason: ${decodedError?.name}${decodedError?.args ? `(${decodedError.args})` : '()'}`);
                    } catch (decodeErr) { console.error("   Error data decoding failed:", decodeErr.message); }
                 } else if (executionError.receipt) {
                     console.error("   Transaction Receipt (if available):", executionError.receipt);
                 } else if (executionError.transactionHash) {
                    console.error("   Transaction Hash:", executionError.transactionHash);
                 }
            }

        } else {
            console.log("   No profitable opportunity found this cycle (profit below threshold or negative).");
        }

    } catch (error) {
        // ... (Keep outer try/catch block) ...
        console.error(`❌ Error during arbitrage check cycle: ${error.message}`);
    }
}

// --- Run the Bot ---
// ... (Keep run/shutdown logic) ...
const CHECK_INTERVAL_MS = 15000;
console.log(`Starting arbitrage check loop: Checking every ${CHECK_INTERVAL_MS / 1000} seconds.`);
console.log("Press Ctrl+C to stop.");
checkArbitrage();
const intervalId = setInterval(checkArbitrage, CHECK_INTERVAL_MS);
process.on('SIGINT', () => { /* ... */ console.log("\n🛑 Received SIGINT (Ctrl+C). Shutting down bot..."); clearInterval(intervalId); process.exit(0); });
process.on('unhandledRejection', (reason, promise) => { /* ... */ console.error('Unhandled Rejection at:', promise, 'reason:', reason); });
process.on('uncaughtException', (error) => { /* ... */ console.error('Uncaught Exception:', error); process.exit(1); });
