// bot.js
// Monitors Uniswap V3 WETH/NativeUSDC pools on Arbitrum for arbitrage opportunities.
// Uses QuoterV2 for swap simulation. Includes dynamic gas estimation.
// Fetches pool data sequentially WITH DELAYS. Reverted Quoter ABI/Calls. Fixes price calculation.
// WARNING: Experimental. Review thresholds, slippage, and execution logic carefully.

require("dotenv").config();
const { ethers } = require("ethers");

// =========================================================================
// == Configuration & Constants ==
// =========================================================================
const RPC_URL = process.env.ARBITRUM_RPC_URL; // Make sure this points back to your Alchemy URL
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!RPC_URL || !PRIVATE_KEY) { console.error("❌ Missing RPC_URL or PRIVATE_KEY in .env file."); process.exit(1); }

const FLASH_SWAP_CONTRACT_ADDRESS = ethers.getAddress("0x7a00Ec5b64e662425Bbaa0dD78972570C326210f"); // Use latest deployed address
const WETH_ADDRESS = ethers.getAddress("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1");
const USDC_ADDRESS = ethers.getAddress("0xaf88d065e77c8cC2239327C5EDb3A432268e5831"); // Native USDC
const POOL_WETH_USDC_005 = ethers.getAddress("0xC6962004f452bE9203591991D15f6b388e09E8D0"); // 0.05% WETH/NativeUSDC
const POOL_WETH_USDC_030 = ethers.getAddress("0xc473e2aEE3441BF9240Be85eb122aBB059A3B57c"); // 0.30% WETH/NativeUSDC
const QUOTER_V2_ADDRESS = ethers.getAddress("0x61fFE014bA17989E743c5F6cB21bF9697530B21e");

const WETH_DECIMALS = 18;
const USDC_DECIMALS = 6;

const CHECK_INTERVAL_MS = 15000;
const MIN_PROFIT_THRESHOLD_WETH = ethers.parseUnits("0.00001", WETH_DECIMALS);
const SLIPPAGE_TOLERANCE = 0.005; // 0.5%
const BORROW_AMOUNT_WETH = ethers.parseUnits("0.001", WETH_DECIMALS);
const GAS_ESTIMATE_BUFFER = 1.2;

// --- ABIs ---
const UNISWAP_V3_POOL_ABI = [ "function token0() external view returns (address)", "function token1() external view returns (address)", "function fee() external view returns (uint24)", "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)" ];
const FLASH_SWAP_ABI = [ "function initiateFlashSwap(address,uint256,uint256,bytes) external", /* events */ ];
// Using simpler Quoter ABI again
const QUOTER_V2_ABI = [ "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)" ];


// =========================================================================
// == Ethers Setup ==
// =========================================================================
const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);
const flashSwapContract = new ethers.Contract(FLASH_SWAP_CONTRACT_ADDRESS, FLASH_SWAP_ABI, signer);
const pool005 = new ethers.Contract(POOL_WETH_USDC_005, UNISWAP_V3_POOL_ABI, provider);
const pool030 = new ethers.Contract(POOL_WETH_USDC_030, UNISWAP_V3_POOL_ABI, provider);
const quoterContract = new ethers.Contract(QUOTER_V2_ADDRESS, QUOTER_V2_ABI, provider);

console.log(`🤖 Bot Initialized.`);
console.log(`   Executor: ${signer.address}`);
console.log(`   FlashSwap Contract: ${FLASH_SWAP_CONTRACT_ADDRESS}`);
console.log("✅ Using Native USDC address:", USDC_ADDRESS);
console.warn(`⚠️ Borrow amount set to: ${ethers.formatUnits(BORROW_AMOUNT_WETH, WETH_DECIMALS)} WETH`);

// =========================================================================
// == Helper Functions ==
// =========================================================================
/**
 * Calculates the price of token1 in terms of token0 from sqrtPriceX96, using BigInt math.
 * @param {bigint} sqrtPriceX96 The sqrtPriceX96 value from pool.slot0().
 * @param {number} decimals0 Decimals of token0.
 * @param {number} decimals1 Decimals of token1.
 * @returns {number} The price of 1 unit of token1 denominated in token0, or NaN on error.
 */
function sqrtPriceX96ToPrice(sqrtPriceX96, decimals0, decimals1) {
    if (!sqrtPriceX96 || sqrtPriceX96 === 0n) {
        console.warn("   sqrtPriceX96ToPrice received zero sqrtPriceX96!");
        return NaN;
    }
    try {
        const Q96 = 2n**96n;
        const Q192 = Q96 * Q96; // 2^192

        // price = (sqrtPriceX96^2 / 2^192) * (10^decimals0 / 10^decimals1)
        const numerator = sqrtPriceX96 * sqrtPriceX96 * (10n**BigInt(decimals0));
        const denominator = Q192 * (10n**BigInt(decimals1));

        // Use a scaling factor for precision with BigInt division
        const scalingFactor = 18; // Represents the number of decimal places for the final price
        const multiplier = 10n**BigInt(scalingFactor);

        const priceScaled = (numerator * multiplier) / denominator;

        // Convert scaled BigInt to float using ethers formatting
        return parseFloat(ethers.formatUnits(priceScaled, scalingFactor));

    } catch (error) {
        console.error(`   Error in sqrtPriceX96ToPrice calculation: ${error.message}`);
        return NaN;
    }
}
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// =========================================================================
// == Main Arbitrage Logic ==
// =========================================================================
async function checkArbitrage() {
    console.log(`\n[${new Date().toISOString()}] Checking: ${POOL_WETH_USDC_005.slice(0,6)} vs ${POOL_WETH_USDC_030.slice(0,6)} (Native USDC)`);
    try {
        // 1. Get Pool Data & Determine Order
        let slot0_005, slot0_030, token0_pool005, token1_pool005;
        try {
             // Sequential Fetch
             slot0_005 = await pool005.slot0(); await delay(50);
             slot0_030 = await pool030.slot0(); await delay(50);
             token0_pool005 = await pool005.token0(); await delay(50);
             token1_pool005 = await pool005.token1();
        } catch (fetchError) { console.error(`   ❌ Fetch Error: ${fetchError.message}`); return; }

        // Validity Checks
        if (!slot0_005 || !slot0_030 || !token0_pool005 || !token1_pool005) { console.error(`   ❌ Incomplete data.`); return; }
        // console.log(`   Raw sqrtPriceX96_005: ${slot0_005.sqrtPriceX96?.toString()}`); // Keep commented unless needed
        // console.log(`   Raw sqrtPriceX96_030: ${slot0_030.sqrtPriceX96?.toString()}`);
        if (slot0_005.sqrtPriceX96 === 0n || slot0_030.sqrtPriceX96 === 0n) { console.error(`   ❌ sqrtPriceX96 is zero.`); return; }

        // Determine Token Order
        let token0Address, token1Address, decimals0, decimals1;
        // Assume WETH < Native USDC for this pair (WETH = T0, USDC = T1)
        token0Address = WETH_ADDRESS; decimals0 = WETH_DECIMALS;
        token1Address = USDC_ADDRESS; decimals1 = USDC_DECIMALS;
        if (token0_pool005.toLowerCase() !== token0Address.toLowerCase() || token1_pool005.toLowerCase() !== token1Address.toLowerCase()) {
            console.error(`❌ Pool ${POOL_WETH_USDC_005} T0/T1 mismatch: ${token0_pool005}/${token1_pool005}`); return;
        }

        // 2. Calculate Prices
        const price_005 = sqrtPriceX96ToPrice(slot0_005.sqrtPriceX96, decimals0, decimals1);
        const price_030 = sqrtPriceX96ToPrice(slot0_030.sqrtPriceX96, decimals0, decimals1);
        if (isNaN(price_005) || isNaN(price_030)) { console.error(`   ❌ Price calc NaN.`); return; }
        console.log(`   P_0.05: ${price_005.toFixed(decimals1)} | P_0.30: ${price_030.toFixed(decimals1)} (Native USDC/WETH)`);
        const priceDiffPercent = Math.abs(price_005 - price_030) / Math.min(price_005, price_030) * 100;

        // 3. Identify Direction
        const BORROW_TOKEN = WETH_ADDRESS; const INTERMEDIATE_TOKEN = USDC_ADDRESS;
        let poolA, feeA, poolB, feeB, loanPool;
        if (price_030 > price_005) { poolA = POOL_WETH_USDC_030; feeA = 3000; poolB = POOL_WETH_USDC_005; feeB = 500; loanPool = poolA; }
        else if (price_005 > price_030) { poolA = POOL_WETH_USDC_005; feeA = 500; poolB = POOL_WETH_USDC_030; feeB = 3000; loanPool = poolA; }
        else { return; } // Prices equal

        // 4. SIMULATE SWAPS
        const amountToBorrow = BORROW_AMOUNT_WETH;
        let simulatedIntermediateFromSwap1, simulatedFinalFromSwap2;
        try {
            // Swap 1: WETH -> Native USDC
            simulatedIntermediateFromSwap1 = await quoterContract.quoteExactInputSingle.staticCall(
                token0Address, token1Address, feeA, amountToBorrow, 0
            );
            if (simulatedIntermediateFromSwap1 === 0n) { console.warn("   Swap 1 quote is 0."); return; }
            // Swap 2: Native USDC -> WETH
            simulatedFinalFromSwap2 = await quoterContract.quoteExactInputSingle.staticCall(
                token1Address, token0Address, feeB, simulatedIntermediateFromSwap1, 0
            );
        } catch (quoteError) { console.error(`   ❌ Quote Error: ${quoteError.message}`); return; }

        // Calculate Potential Profit
        const loanPoolFeeTier = feeA;
        const flashLoanFee = (amountToBorrow * BigInt(loanPoolFeeTier)) / 1000000n;
        const totalAmountToRepay = amountToBorrow + flashLoanFee;
        const potentialProfitWeth = simulatedFinalFromSwap2 - totalAmountToRepay;
        console.log(`   Sim Swap1: ${ethers.formatUnits(simulatedIntermediateFromSwap1, decimals1)} Native USDC | Sim Swap2: ${ethers.formatUnits(simulatedFinalFromSwap2, decimals0)} WETH`);
        console.log(`   Repay: ${ethers.formatUnits(totalAmountToRepay, decimals0)} WETH | Pot. Profit: ${ethers.formatUnits(potentialProfitWeth, decimals0)} WETH`);

        // --- 5. ESTIMATE GAS COST ---
        let estimatedGasUnits = 0n; let gasPrice = 0n; let estimatedGasCostWeth = 0n;
        const gasEstimateAmountOutMinimum1 = 0n; const gasEstimateAmountOutMinimum2 = 0n;
        const gasEstimateParams = ethers.AbiCoder.defaultAbiCoder().encode(
            ['address', 'address', 'address', 'uint24', 'uint24', 'uint256', 'uint256'],
            [token1Address, poolA, poolB, feeA, feeB, gasEstimateAmountOutMinimum1, gasEstimateAmountOutMinimum2]
        );
        let amount0 = 0n; let amount1 = 0n;
        if (BORROW_TOKEN.toLowerCase() === token0Address.toLowerCase()) { amount0 = amountToBorrow; } else { return; }

        try {
            const feeData = await provider.getFeeData();
            gasPrice = feeData.gasPrice;
            if (!gasPrice || gasPrice === 0n) { gasPrice = ethers.parseUnits("0.1", "gwei"); }
            estimatedGasUnits = await flashSwapContract.initiateFlashSwap.estimateGas( loanPool, amount0, amount1, gasEstimateParams );
            const gasUnitsWithBuffer = estimatedGasUnits * BigInt(Math.round(GAS_ESTIMATE_BUFFER * 100)) / 100n;
            estimatedGasCostWeth = gasUnitsWithBuffer * gasPrice;
            console.log(`   Est. Gas: ${estimatedGasUnits} units | Price: ${ethers.formatUnits(gasPrice, "gwei")} Gwei | Est. Cost: ${ethers.formatUnits(estimatedGasCostWeth, WETH_DECIMALS)} WETH`);
        } catch (gasEstimateError) {
             console.error(`   ❌ Gas Estimation Failed: ${gasEstimateError.message}`);
             if (gasEstimateError.data && gasEstimateError.data !== '0x') { /* Decode */ } return;
        }

        // 6. Check Profitability
        const netProfitWeth = potentialProfitWeth - estimatedGasCostWeth;
        console.log(`   Net Profit (WETH, after estimated gas): ${ethers.formatUnits(netProfitWeth, WETH_DECIMALS)}`);

        if (netProfitWeth > MIN_PROFIT_THRESHOLD_WETH) {
            console.log(`✅ PROFITABLE OPPORTUNITY! Est. Net Profit: ${ethers.formatUnits(netProfitWeth, WETH_DECIMALS)} WETH`);
            // --- Construct ACTUAL TX Params ---
            const actualAmountOutMinimum1 = simulatedIntermediateFromSwap1 * BigInt(Math.floor((1 - SLIPPAGE_TOLERANCE) * 10000)) / 10000n;
            const requiredRepaymentThreshold = totalAmountToRepay + MIN_PROFIT_THRESHOLD_WETH;
            const actualAmountOutMinimum2 = requiredRepaymentThreshold;
            const actualArbitrageParams = ethers.AbiCoder.defaultAbiCoder().encode(
                 ['address', 'address', 'address', 'uint24', 'uint24', 'uint256', 'uint256'],
                 [token1Address, poolA, poolB, feeA, feeB, actualAmountOutMinimum1, actualAmountOutMinimum2]
            );
            console.log(`   Params: MinOut1=${ethers.formatUnits(actualAmountOutMinimum1, decimals1)}, MinOut2=${ethers.formatUnits(actualAmountOutMinimum2, decimals0)}`);
            // 7. Execute Transaction
            console.log(`   Executing initiateFlashSwap... Amount0: ${ethers.formatUnits(amount0, WETH_DECIMALS)} WETH(0)`);
            try {
                const gasLimitWithBuffer = estimatedGasUnits * BigInt(Math.round(GAS_ESTIMATE_BUFFER * 100)) / 100n;
                const tx = await flashSwapContract.initiateFlashSwap(
                    loanPool, amount0, amount1, actualArbitrageParams,
                    { gasLimit: gasLimitWithBuffer, gasPrice: gasPrice }
                );
                console.log(`   ✅ Transaction Sent: ${tx.hash}`);
                console.log(`   ⏳ Waiting for confirmation...`);
                const receipt = await tx.wait(1);
                console.log(`   ✅ Tx Confirmed! Block: ${receipt.blockNumber}, Gas Used: ${receipt.gasUsed.toString()}`);
            } catch (executionError) {
                 console.error(`   ❌ Flash Swap Transaction Failed: ${executionError.message}`);
                 if (executionError.data && executionError.data !== '0x') { /* Decode */ }
                 else if (executionError.transactionHash) { console.error("   Tx Hash:", executionError.transactionHash); }
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
console.log(`Starting arbitrage check loop: Checking every ${CHECK_INTERVAL_MS / 1000} seconds.`);
checkArbitrage();
const intervalId = setInterval(checkArbitrage, CHECK_INTERVAL_MS);
// --- Shutdown handlers ---
process.on('SIGINT', () => { console.log("\n🛑 Shutting down..."); clearInterval(intervalId); process.exit(0); });
process.on('unhandledRejection', (reason, promise) => { console.error('Unhandled Rejection:', reason); });
process.on('uncaughtException', (error) => { console.error('Uncaught Exception:', error); process.exit(1); });
