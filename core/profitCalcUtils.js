// core/profitCalcUtils.js
// Helper functions for ProfitCalculator logic.

const { ethers } = require('ethers');
const logger = require('../utils/logger'); // Adjust path if needed
const { convertTokenAmountToNative } = require('../utils/priceFeed'); // Adjust path
const { ArbitrageError } = require('../utils/errorHandler'); // Adjust path

// --- Validation & Setup Helper ---
function validateAndSetup(opportunity, config, logPrefix) {
    // Basic structure validation
    if (opportunity?.type !== 'spatial' || !Array.isArray(opportunity.path) || opportunity.path.length !== 2 || !opportunity.tokenIn || !opportunity.tokenIntermediate || !opportunity.tokenOut) {
        return { isValid: false, reason: "Malformed structure (requires spatial, 2-hop path, tokenIn/Intermediate/Out)" };
    }
    const step1 = opportunity.path[0]; const step2 = opportunity.path[1];
    const poolBuyState = step1?.poolState; const poolSellState = step2?.poolState; // Optional chaining
    if (!poolBuyState || !poolSellState) {
        return { isValid: false, reason: "Missing pool state in path" };
    }
    // Ensure token objects exist before accessing symbol
    const initialToken = config.TOKENS[opportunity.tokenIn.symbol];
    const intermediateToken = config.TOKENS[opportunity.tokenIntermediate.symbol];
    const finalToken = config.TOKENS[opportunity.tokenOut.symbol];
    if (!initialToken || !intermediateToken || !finalToken || initialToken.symbol !== finalToken.symbol) {
        return { isValid: false, reason: `Token lookup failed or tokenIn/Out mismatch (Symbols: ${opportunity.tokenIn?.symbol} vs ${opportunity.tokenOut?.symbol})` };
    }
    const amountInStart = BigInt(opportunity.amountIn || 0n); // Default to 0 if missing
    if (amountInStart <= 0n) {
        return { isValid: false, reason: "Invalid amountIn (must be positive)" };
    }
    logger.debug(`${logPrefix} Validation OK. Initial: ${ethers.formatUnits(amountInStart, initialToken.decimals)} ${initialToken.symbol}`);
    return { isValid: true, initialToken, intermediateToken, finalToken, amountInStart, poolBuyState, poolSellState };
}

// --- Simulation Helper ---
async function simulatePath(swapSimulator, initialToken, intermediateToken, finalToken, amountInStart, poolBuyState, poolSellState, logPrefix) {
    // Simulate Hop 1
    const sim1Result = await swapSimulator.simulateSwap(poolBuyState, initialToken, amountInStart);
    if (!sim1Result.success || !sim1Result.amountOut || sim1Result.amountOut <= 0n) {
        return { success: false, reason: `Leg 1 Sim Fail: ${sim1Result.error || 'Zero output'}` };
    }
    const amountIntermediate = sim1Result.amountOut;
    logger.debug(`${logPrefix} Sim Hop 1 Out: ${ethers.formatUnits(amountIntermediate, intermediateToken.decimals)} ${intermediateToken.symbol}`);

    // Simulate Hop 2
    const sim2Result = await swapSimulator.simulateSwap(poolSellState, intermediateToken, amountIntermediate);
    if (!sim2Result.success || !sim2Result.amountOut || sim2Result.amountOut <= 0n) {
        return { success: false, reason: `Leg 2 Sim Fail: ${sim2Result.error || 'Zero output'}` };
    }
    const finalAmountOut = sim2Result.amountOut;
    logger.debug(`${logPrefix} Sim Hop 2 Out: ${ethers.formatUnits(finalAmountOut, finalToken.decimals)} ${finalToken.symbol}`);

    // Calculate Gross Profit
    const grossProfitWei_InitialToken = finalAmountOut - amountInStart;
    if (grossProfitWei_InitialToken <= 0n) {
        return { success: false, reason: "Negative gross profit (sim)", grossProfitWei_InitialToken };
    }
    logger.debug(`${logPrefix} Gross Profit (Sim): ${ethers.formatUnits(grossProfitWei_InitialToken, initialToken.decimals)} ${initialToken.symbol}`);

    return { success: true, amountIntermediate, finalAmountOut, grossProfitWei_InitialToken };
}

// --- Gas Estimation Helper ---
async function estimateGas(gasEstimator, opportunity, signerAddress, logPrefix) {
    logger.debug(`${logPrefix} Estimating gas...`);
    const gasCostDetails = await gasEstimator.estimateTxGasCost(opportunity, signerAddress);

    if (!gasCostDetails?.totalCostWei || gasCostDetails.totalCostWei <= 0n || !gasCostDetails.estimateGasSuccess) {
        const reason = !gasCostDetails?.estimateGasSuccess ? "estimateGas reverted (path invalid)" : "Gas cost estimation failed";
        return { success: false, reason: reason };
    }
    const gasCostNativeWei = gasCostDetails.totalCostWei;
    const gasLimitEstimate = gasCostDetails.pathGasLimit;
    if (!gasLimitEstimate || gasLimitEstimate <= 0n) {
        return { success: false, reason: "Invalid gas limit in gasCostDetails" };
    }
    logger.debug(`${logPrefix} Est. Gas Cost: ${ethers.formatEther(gasCostNativeWei)} ETH, Gas Limit: ${gasLimitEstimate.toString()}`); // Assuming native is ETH, use config?
    return { success: true, gasCostNativeWei, gasLimitEstimate };
}

// --- Net Profit Calculation Helper (Includes Aave Fee Logic) ---
async function calculateNetProfitDetails(pcInstance, grossProfitWei_InitialToken, initialToken, gasCostNativeWei, opportunity, amountInStart, logPrefix) {
    // Use pcInstance to access provider, config values (fees, chainlink feeds, native token info)
    const { provider, config, nativeSymbol, nativeDecimals, chainlinkFeeds, aaveFeeBps } = pcInstance;

    const grossProfitNativeWei = await convertTokenAmountToNative( grossProfitWei_InitialToken, initialToken, chainlinkFeeds, nativeSymbol, nativeDecimals, provider );
    if (grossProfitNativeWei === null || grossProfitNativeWei <= 0n) { return { success: false, reason: "Gross profit conversion failed", netProfitNativeWei: null, grossProfitNativeWei: null }; }
    logger.debug(`${logPrefix} Gross Profit (Native): ${ethers.formatEther(grossProfitNativeWei)} ${nativeSymbol}`);

    let totalFeesNativeWei = gasCostNativeWei;
    let aaveFeeNativeWei = 0n;
    const likelyUsesAave = opportunity.path[0].dex !== 'uniswapV3';

    if (likelyUsesAave && aaveFeeBps !== undefined && aaveFeeBps > 0n) {
         logger.debug(`${logPrefix} Path starts non-V3 (${opportunity.path[0].dex}), attempting to calculate Aave fee...`);
         try {
             const borrowedAmountNativeWei = await convertTokenAmountToNative( amountInStart, initialToken, chainlinkFeeds, nativeSymbol, nativeDecimals, provider );
             if (borrowedAmountNativeWei !== null && borrowedAmountNativeWei > 0n) {
                  aaveFeeNativeWei = (borrowedAmountNativeWei * aaveFeeBps) / 10000n;
                  logger.debug(`${logPrefix} Adding estimated Aave Fee (Native): ${ethers.formatEther(aaveFeeNativeWei)} ${nativeSymbol}`);
                  totalFeesNativeWei = totalFeesNativeWei + aaveFeeNativeWei;
             } else {
                  logger.warn(`${logPrefix} Could not convert borrow amount to native value to estimate Aave fee accurately.`);
             }
         } catch (feeConvError) { logger.error(`${logPrefix} Error calculating/converting Aave fee: ${feeConvError.message}`); }
    }

    const netProfitNativeWei = grossProfitNativeWei - totalFeesNativeWei;
    if (netProfitNativeWei <= 0n) { logger.debug(`${logPrefix} Net profit <= 0 after total fees: ${ethers.formatEther(netProfitNativeWei)} ${nativeSymbol}`); return { success: false, reason: "Net profit <= 0 after fees", netProfitNativeWei, grossProfitNativeWei }; }
    logger.debug(`${logPrefix} Net Profit (Native, after fees): ${ethers.formatEther(netProfitNativeWei)} ${nativeSymbol}`);
    return { success: true, netProfitNativeWei, grossProfitNativeWei };
}

// --- Threshold Check Helper ---
function checkThreshold(pcInstance, netProfitNativeWei, logPrefix) {
    // Use pcInstance to access nativeToken and profitBufferPercent
    const { nativeToken, profitBufferPercent } = pcInstance;
    try {
        const thresholdNativeWei = pcInstance._getMinProfitThresholdWei(nativeToken); // Call private method on instance
        const bufferMultiplier = 10000n - (profitBufferPercent * 100n);
        if (bufferMultiplier <= 0n) throw new Error("Invalid profit buffer percentage.");

        const bufferedNetProfitNativeWei = (netProfitNativeWei * bufferMultiplier) / 10000n;
        const isProfitableAfterThreshold = bufferedNetProfitNativeWei > thresholdNativeWei;

        logger.debug(`${logPrefix} Buffered Net: ${ethers.formatEther(bufferedNetProfitNativeWei)}, Threshold: ${ethers.formatEther(thresholdNativeWei)}. Profitable: ${isProfitableAfterThreshold}`);

        if (!isProfitableAfterThreshold) {
            return { isProfitable: false, reason: "Below profit threshold", thresholdNativeWei };
        }
        return { isProfitable: true, thresholdNativeWei };

    } catch (evalError) {
        logger.error(`${logPrefix} Error during threshold check: ${evalError.message}`);
        throw new ArbitrageError(`Threshold check error: ${evalError.message}`, 'THRESHOLD_ERROR', evalError);
    }
}

// --- Build Trade Data Helper ---
async function buildTradeData( pcInstance, opportunity, amountInStart, amountIntermediate, finalAmountOut, grossProfitWei_InitialToken, grossProfitNativeWei, gasCostNativeWei, netProfitNativeWei, gasLimitEstimate, thresholdNativeWei, initialToken) {
    // Use pcInstance for config/provider details needed by convertTokenAmountToNative
    const { provider, config, nativeSymbol, nativeDecimals, chainlinkFeeds } = pcInstance;
    let profitPercentage = 0;
    try {
        const amountInNative = await convertTokenAmountToNative(amountInStart, initialToken, chainlinkFeeds, nativeSymbol, nativeDecimals, provider);
        if (amountInNative !== null && amountInNative > 0n) {
             profitPercentage = Number((netProfitNativeWei * 1000000n) / amountInNative) / 10000;
        } else { logger.warn(`[ProfitCalcUtils _buildTradeData] Could not convert amountIn to native.`); }
     } catch (percError) { logger.warn(`[ProfitCalcUtils _buildTradeData] Failed to calculate profitPercentage: ${percError.message}`); }

    const finalTradeData = {
        ...opportunity, amountIn: amountInStart.toString(), intermediateAmountOut: amountIntermediate.toString(), amountOut: finalAmountOut.toString(),
        profitAmount: grossProfitWei_InitialToken.toString(), profitAmountNativeWei: grossProfitNativeWei.toString(), gasCostNativeWei: gasCostNativeWei.toString(),
        netProfitNativeWei: netProfitNativeWei.toString(), gasEstimate: gasLimitEstimate.toString(), profitPercentage: profitPercentage,
        thresholdNativeWei: thresholdNativeWei.toString(), timestamp: Date.now()
    };
    return finalTradeData;
}

module.exports = {
    validateAndSetup,
    simulatePath,
    estimateGas,
    calculateNetProfitDetails,
    checkThreshold,
    buildTradeData,
};
