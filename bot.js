// bot.js
// Monitors Uniswap V3 pools on Arbitrum for arbitrage opportunities.
// Uses QuoterV2 for swap simulation. Includes dynamic gas estimation.
// WARNING: Experimental. Review thresholds, slippage, and execution logic carefully.

require("dotenv").config();
const { ethers } = require("ethers");

// =========================================================================
// == Configuration & Constants ==
// =========================================================================
const RPC_URL = process.env.ARBITRUM_RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!RPC_URL || !PRIVATE_KEY) { console.error("❌ Missing RPC_URL or PRIVATE_KEY in .env file."); process.exit(1); }

const FLASH_SWAP_CONTRACT_ADDRESS = ethers.getAddress("0x3f7A3f4bb9DCE54684D06060bF4491544Ee4Dba5");
const WETH_ADDRESS = ethers.getAddress("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1");
const USDC_ADDRESS = ethers.getAddress("0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8"); // USDC.e
const POOL_WETH_USDC_005 = ethers.getAddress("0xC31E54c7a869B9FcBEcc14363CF510d1c41fa443"); // 0.05%
const POOL_WETH_USDC_030 = ethers.getAddress("0x17c14D2c404D167802b16C450d3c99F88F2c4F4d"); // 0.30%
const QUOTER_V2_ADDRESS = ethers.getAddress("0x61fFE014bA17989E743c5F6cB21bF9697530B21e");

const WETH_DECIMALS = 18;
const USDC_DECIMALS = 6;

const CHECK_INTERVAL_MS = 15000;
const MIN_PROFIT_THRESHOLD_WETH = ethers.parseUnits("0.00001", WETH_DECIMALS);
const SLIPPAGE_TOLERANCE = 0.001; // 0.1%
const BORROW_AMOUNT_WETH = ethers.parseUnits("0.01", WETH_DECIMALS); // --- Increased borrow amount slightly ---
const GAS_ESTIMATE_BUFFER = 1.2; // Add 20% buffer to gas estimate

// --- ABIs ---
const UNISWAP_V3_POOL_ABI = [ /* ... pool ABI ... */
    "function token0() external view returns (address)", "function token1() external view returns (address)", "function fee() external view returns (uint24)",
    "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)"
];
const FLASH_SWAP_ABI = [ /* ... flash swap ABI ... */
    "function initiateFlashSwap(address _poolAddress, uint256 _amount0, uint256 _amount1, bytes calldata _params) external",
    // ... events
];
const QUOTER_V2_ABI = [ /* ... quoter ABI ... */
     "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)"
];

// =========================================================================
// == Ethers Setup ==
// =========================================================================
const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);
const flashSwapContract = new ethers.Contract(FLASH_SWAP_CONTRACT_ADDRESS, FLASH_SWAP_ABI, signer);
const pool005 = new ethers.Contract(POOL_WETH_USDC_005, UNISWAP_V3_POOL_ABI, provider);
const pool030 = new ethers.Contract(POOL_WETH_USDC_030, UNISWAP_V3_POOL_ABI, provider);
const quoterContract = new ethers.Contract(QUOTER_V2_ADDRESS, QUOTER_V2_ABI, provider);

console.log(`🤖 Bot Initialized.`); /* ... */ console.log(`   Executor: ${signer.address}`); /* ... */

// =========================================================================
// == Helper Functions ==
// =========================================================================
function sqrtPriceX96ToPrice(sqrtPriceX96, decimals0, decimals1) { /* ... */
    const Q96 = 2n**96n; const priceRatio = (Number(sqrtPriceX96) / Number(Q96)) ** 2;
    const decimalAdjustment = 10**(decimals0 - decimals1); return priceRatio * decimalAdjustment;
}

// =========================================================================
// == Main Arbitrage Logic ==
// =========================================================================
async function checkArbitrage() {
    console.log(`\n[${new Date().toISOString()}] Checking: ${POOL_WETH_USDC_005.slice(0,6)} vs ${POOL_WETH_USDC_030.slice(0,6)}`); // Shorter log
    try {
        // 1. Get Pool Data & Determine Order
        const [slot0_005, slot0_030, token0_pool005, token1_pool005] = await Promise.all([ /* ... */
            pool005.slot0(), pool030.slot0(), pool005.token0(), pool005.token1()
        ]);
        let token0Address, token1Address, decimals0, decimals1;
        // ... (Keep token order determination logic - WETH=T0, USDC.e=T1) ...
         if (token0_pool005.toLowerCase() === WETH_ADDRESS.toLowerCase()) {
            token0Address = WETH_ADDRESS; decimals0 = WETH_DECIMALS;
            token1Address = USDC_ADDRESS; decimals1 = USDC_DECIMALS;
            if (token1_pool005.toLowerCase() !== USDC_ADDRESS.toLowerCase()) { console.error(`❌ Mismatch T1`); return; }
        } else if (token0_pool005.toLowerCase() === USDC_ADDRESS.toLowerCase()) {
            token0Address = USDC_ADDRESS; decimals0 = USDC_DECIMALS;
            token1Address = WETH_ADDRESS; decimals1 = WETH_DECIMALS;
             if (token1_pool005.toLowerCase() !== WETH_ADDRESS.toLowerCase()) { console.error(`❌ Mismatch T1`); return; }
        } else { console.error(`❌ Unexpected T0`); return; }

        // 2. Calculate Prices
        const price_005 = sqrtPriceX96ToPrice(slot0_005.sqrtPriceX96, decimals0, decimals1);
        const price_030 = sqrtPriceX96ToPrice(slot0_030.sqrtPriceX96, decimals0, decimals1);
        console.log(`   P_0.05: ${price_005.toFixed(decimals1)} | P_0.30: ${price_030.toFixed(decimals1)} (USDC.e/WETH)`); // Shorter log
        const priceDiffPercent = Math.abs(price_005 - price_030) / Math.min(price_005, price_030) * 100;

        // 3. Identify Direction
        const BORROW_TOKEN = WETH_ADDRESS; const INTERMEDIATE_TOKEN = USDC_ADDRESS;
        let poolA, feeA, poolB, feeB, loanPool;
        // ... (Keep direction logic: poolA=sell high, poolB=buy low, loanPool=poolA) ...
        if (price_030 > price_005) { poolA = POOL_WETH_USDC_030; feeA = 3000; poolB = POOL_WETH_USDC_005; feeB = 500; loanPool = poolA; }
        else if (price_005 > price_030) { poolA = POOL_WETH_USDC_005; feeA = 500; poolB = POOL_WETH_USDC_030; feeB = 3000; loanPool = poolA; }
        else { return; }

        // 4. SIMULATE SWAPS
        const amountToBorrow = BORROW_AMOUNT_WETH;
        let simulatedIntermediateFromSwap1, simulatedFinalFromSwap2;
        try {
            simulatedIntermediateFromSwap1 = (await quoterContract.quoteExactInputSingle.staticCall({ /* Swap 1 Params */
                tokenIn: token0Address, tokenOut: token1Address, amountIn: amountToBorrow, fee: feeA, sqrtPriceLimitX96: 0
            }))[0];
            if (simulatedIntermediateFromSwap1 === 0n) { console.warn("   Swap 1 quote is 0."); return; }
            simulatedFinalFromSwap2 = (await quoterContract.quoteExactInputSingle.staticCall({ /* Swap 2 Params */
                tokenIn: token1Address, tokenOut: token0Address, amountIn: simulatedIntermediateFromSwap1, fee: feeB, sqrtPriceLimitX96: 0
            }))[0];
        } catch (quoteError) { console.error(`   ❌ Quote Error: ${quoteError.message}`); return; }

        // Calculate Potential Profit
        const loanPoolFeeTier = feeA;
        const flashLoanFee = (amountToBorrow * BigInt(loanPoolFeeTier)) / 1000000n;
        const totalAmountToRepay = amountToBorrow + flashLoanFee;
        const potentialProfitWeth = simulatedFinalFromSwap2 - totalAmountToRepay;
        console.log(`   Sim Swap1: ${ethers.formatUnits(simulatedIntermediateFromSwap1, decimals1)} USDC.e | Sim Swap2: ${ethers.formatUnits(simulatedFinalFromSwap2, decimals0)} WETH`);
        console.log(`   Repay: ${ethers.formatUnits(totalAmountToRepay, decimals0)} WETH | Pot. Profit: ${ethers.formatUnits(potentialProfitWeth, decimals0)} WETH`);


        // --- 5. ESTIMATE GAS COST ---
        let estimatedGasUnits = 0n;
        let gasPrice = 0n; // Using legacy gasPrice for simplicity on Arbitrum, can use feeData for EIP1559
        let estimatedGasCostWeth = 0n;

        // Construct params *before* estimating gas
        const amountOutMinimum1 = simulatedIntermediateFromSwap1 * BigInt(Math.floor((1 - SLIPPAGE_TOLERANCE) * 10000)) / 10000n;
        const requiredRepaymentThreshold = totalAmountToRepay + MIN_PROFIT_THRESHOLD_WETH;
        const amountOutMinimum2 = requiredRepaymentThreshold;
        const arbitrageParams = ethers.AbiCoder.defaultAbiCoder().encode(
            ['address', 'address', 'address', 'uint24', 'uint24', 'uint256', 'uint256'],
            [token1Address, poolA, poolB, feeA, feeB, amountOutMinimum1, amountOutMinimum2]
        );
        let amount0 = 0n; let amount1 = 0n;
        if (BORROW_TOKEN.toLowerCase() === token0Address.toLowerCase()) { amount0 = amountToBorrow; }
        else { /* Handle error */ return; }

        try {
            // Get current gas price from provider
            const feeData = await provider.getFeeData();
            gasPrice = feeData.gasPrice; // Use legacy gas price; could use feeData.maxFeePerGas with EIP-1559 tx type
            if (!gasPrice || gasPrice === 0n) {
                console.warn("   Could not fetch gas price, using default.");
                gasPrice = ethers.parseUnits("0.1", "gwei"); // Arbitrum default min is 0.1 Gwei
            }

            // Estimate gas for the specific flash swap call
            estimatedGasUnits = await flashSwapContract.initiateFlashSwap.estimateGas(
                loanPool,
                amount0,
                amount1,
                arbitrageParams
            );

            // Add buffer to estimated gas units
            const gasUnitsWithBuffer = estimatedGasUnits * BigInt(Math.round(GAS_ESTIMATE_BUFFER * 100)) / 100n;
            estimatedGasCostWeth = gasUnitsWithBuffer * gasPrice; // Cost in ETH (Wei)

            console.log(`   Est. Gas: ${estimatedGasUnits} units | Price: ${ethers.formatUnits(gasPrice, "gwei")} Gwei | Est. Cost: ${ethers.formatUnits(estimatedGasCostWeth, WETH_DECIMALS)} WETH`);

        } catch (gasEstimateError) {
             console.error(`   ❌ Gas Estimation Failed: ${gasEstimateError.message}`);
             // This often happens if the transaction is expected to revert (e.g., insufficient profit simulation)
             // Treat as non-profitable if gas can't be estimated
             return;
        }

        // 6. Check Profitability (After REAL Gas Estimate)
        const netProfitWeth = potentialProfitWeth - estimatedGasCostWeth;
        console.log(`   Net Profit (WETH, after estimated gas): ${ethers.formatUnits(netProfitWeth, WETH_DECIMALS)}`);

        if (netProfitWeth > MIN_PROFIT_THRESHOLD_WETH) {
            console.log(`✅ PROFITABLE OPPORTUNITY! Est. Net Profit: ${ethers.formatUnits(netProfitWeth, WETH_DECIMALS)} WETH`);
            console.log(`   Path: Borrow WETH(0)@${loanPool.slice(0,6)}, Sell@${poolA.slice(0,6)}(${feeA/10000}%), Buy@${poolB.slice(0,6)}(${feeB/10000}%)`);
            console.log(`   Params: MinOut1=${ethers.formatUnits(amountOutMinimum1, decimals1)}, MinOut2=${ethers.formatUnits(amountOutMinimum2, decimals0)}`);

            // 7. Execute Transaction
            console.log(`   Executing initiateFlashSwap... Amount0: ${ethers.formatUnits(amount0, WETH_DECIMALS)} WETH(0)`);
            try {
                const tx = await flashSwapContract.initiateFlashSwap(
                    loanPool,
                    amount0,
                    amount1,
                    arbitrageParams,
                    { // Pass gas settings
                        gasLimit: estimatedGasUnits * BigInt(Math.round(GAS_ESTIMATE_BUFFER * 100)) / 100n, // Use buffered estimate
                        gasPrice: gasPrice // Use fetched gas price (legacy)
                        // For EIP-1559:
                        // maxFeePerGas: feeData.maxFeePerGas,
                        // maxPriorityFeePerGas: feeData.maxPriorityFeePerGas
                    }
                );
                console.log(`   ✅ Transaction Sent: ${tx.hash}`);
                console.log(`   ⏳ Waiting for confirmation...`);
                const receipt = await tx.wait(1);
                console.log(`   ✅ Tx Confirmed! Block: ${receipt.blockNumber}, Gas Used: ${receipt.gasUsed.toString()}`);
                // TODO: Check receipt logs for actual success/profit

            } catch (executionError) {
                 console.error(`   ❌ Flash Swap Transaction Failed: ${executionError.message}`);
                 if (executionError.data && executionError.data !== '0x') {
                    try { /* Decode revert reason */ /* ... */ } catch (decodeErr) { /* ... */ }
                 } else if (executionError.transactionHash) { /* ... */ }
            }
        } else {
             if (priceDiffPercent > 0.01) {
                  console.log(`   Opportunity found but below profit threshold. Est. Net: ${ethers.formatUnits(netProfitWeth, WETH_DECIMALS)} WETH`);
             }
        }
    } catch (error) {
        console.error(`❌ Error during arbitrage check cycle: ${error.message}`);
    }
}

// =========================================================================
// == Bot Execution ==
// =========================================================================
console.log(`Starting arbitrage check loop: Checking every ${CHECK_INTERVAL_MS / 1000} seconds.`); /* ... */
checkArbitrage();
const intervalId = setInterval(checkArbitrage, CHECK_INTERVAL_MS);
// --- Shutdown handlers ---
process.on('SIGINT', () => { /* ... */ console.log("\n🛑 Shutting down..."); clearInterval(intervalId); process.exit(0); });
process.on('unhandledRejection', (reason, promise) => { /* ... */ console.error('Unhandled Rejection:', reason); });
process.on('uncaughtException', (error) => { /* ... */ console.error('Uncaught Exception:', error); process.exit(1); });
