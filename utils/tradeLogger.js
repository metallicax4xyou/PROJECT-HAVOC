// utils/tradeLogger.js
// Handles formatting and logging details of profitable arbitrage trades

const { ethers } = require('ethers');
const logger = require('./logger'); // Needs logger utility

/**
 * Formats a BigInt amount for display based on token decimals.
 * @param {bigint | string | number | null | undefined} amountBigInt - The amount as BigInt or string/number convertible to BigInt.
 * @param {{decimals: number, symbol: string} | null | undefined} token - The token object containing decimals and symbol.
 * @returns {string} - Formatted amount string.
 */
function formatAmount(amountBigInt, token) {
    if (amountBigInt === null || amountBigInt === undefined || !token?.decimals) return 'N/A';
    try {
        if (typeof amountBigInt !== 'bigint') amountBigInt = BigInt(amountBigInt);
        if (amountBigInt === 0n) return `0.0 ${token.symbol || '?'}`;
        // Safely handle potential large numbers or precision issues if formatUnits throws
        try {
           return `${ethers.formatUnits(amountBigInt, token.decimals)} ${token.symbol || '?'}`;
        } catch (formatError) {
           logger.debug(`[TradeLogger] Error formatting amount ${amountBigInt.toString()} with decimals ${token.decimals}: ${formatError.message}`);
           // Fallback to raw BigInt string if formatting fails
           return `${amountBigInt.toString()} (Raw) ${token.symbol || '?'}`;
        }
    } catch (e) {
        logger.debug(`[TradeLogger] Error processing amount ${amountBigInt} for ${token?.symbol}: ${e.message}`);
        return `Error formatting (${String(amountBigInt)})`;
    }
}

/**
 * Formats a wei amount (BigInt) into Ether string.
 * @param {bigint | string | number | null | undefined} weiAmount - The amount in wei as BigInt or string/number.
 * @param {string} nativeSymbol - The symbol for the native currency (e.g., 'ETH').
 * @returns {string} - Formatted native currency string.
 */
function formatEth(weiAmount, nativeSymbol) {
    if (weiAmount === null || weiAmount === undefined) return 'N/A';
    try {
        if (typeof weiAmount !== 'bigint') weiAmount = BigInt(weiAmount);
         if (weiAmount === 0n) return `0.0 ${nativeSymbol || '?'}`;
        // Safely handle potential large numbers or precision issues if formatEther throws
         try {
             return `${ethers.formatEther(weiAmount)} ${nativeSymbol || '?'}`;
         } catch (formatError) {
             logger.debug(`[TradeLogger] Error formatting ETH amount ${weiAmount.toString()}: ${formatError.message}`);
             // Fallback to raw BigInt string if formatting fails
             return `${weiAmount.toString()} (Raw) ${nativeSymbol || '?'}`;
         }
    } catch (e) {
        logger.debug(`[TradeLogger] Error processing ETH amount ${weiAmount}: ${e.message}`);
        return `Error formatting (${String(weiAmount)}) ${nativeSymbol || '?'}`;
    }
}


/**
 * Logs the details of a profitable trade opportunity.
 * @param {object} trade - The profitable trade object.
 * @param {number} index - The index of the trade in the list (for logging).
 * @param {string} nativeSymbol - The symbol for the native currency (e.g., 'ETH').
 */
function logTradeDetails(trade, index, nativeSymbol) {
    try {
        const pathDesc = trade.path?.map(p => {
            const symbols = p.poolState?.token0Symbol && p.poolState?.token1Symbol ? `${p.poolState.token0Symbol}/${p.poolState.token1Symbol}` : '?/?';
             const fee = p.fee !== undefined && p.fee !== null ? `@${p.fee}` : ''; // Include fee in path description
            return `${p.dex || '?'}(${symbols}${fee})`;
        }).join('->') || 'N/A';


        logger.info(`  [${index}] ${trade.type || '?'}-Arb | Path: ${pathDesc}`);
        logger.info(`      Borrow: ${formatAmount(trade.amountIn, trade.tokenIn)}`);
        if (trade.intermediateAmountOut !== undefined && trade.intermediateAmountOut !== null && trade.tokenIntermediate) {
             logger.info(`      -> Intermediate Out: ${formatAmount(trade.intermediateAmountOut, trade.tokenIntermediate)}`);
        }
        logger.info(`      -> Final Out: ${formatAmount(trade.amountOut, trade.tokenOut)}`);

        if (trade.netProfitNativeWei !== undefined && trade.netProfitNativeWei !== null) {
             logger.info(`      NET Profit: ${formatEth(trade.netProfitNativeWei, nativeSymbol)} (Gross: ${formatEth(trade.estimatedProfit || 0n, nativeSymbol)})`);
             logger.info(`      Costs: Gas ~${formatEth(trade.gasEstimate?.totalCostWei || 0n, nativeSymbol)}, Loan Fee ~${formatEth(trade.flashLoanDetails?.feeNativeWei || 0n, nativeSymbol)}`);
             logger.info(`      Gas Estimate Check: ${trade.gasEstimateSuccess ? 'OK' : 'FAIL'} ${trade.gasEstimate?.errorMessage ? '(' + trade.gasEstimate.errorMessage + ')' : ''}`);

             if (trade.thresholdNativeWei !== undefined && trade.thresholdNativeWei !== null) {
                  logger.info(`      Threshold Required: ${formatEth(trade.thresholdNativeWei, nativeSymbol)}`);
             }
             // Check for tithe amount being a BigInt and greater than 0n
             if (trade.titheAmountNativeWei !== null && trade.titheAmountNativeWei !== undefined && typeof trade.titheAmountNativeWei === 'bigint' && trade.titheAmountNativeWei > 0n) {
                  logger.info(`      Tithe Amount: ${formatEth(trade.titheAmountNativeWei, nativeSymbol)} (To: ${trade.titheRecipient})`);
             } else if (trade.titheAmountNativeWei !== null && trade.titheAmountNativeWei !== undefined && trade.titheAmountNativeWei > 0) {
                  // Handle potential non-BigInt tithe amounts logged in older versions? (Safety check)
                  logger.debug(`[TradeLogger] Tithe amount is non-BigInt but > 0: ${trade.titheAmountNativeWei}`);
             }


             if (trade.profitPercentage !== null && trade.profitPercentage !== undefined) {
                  // Ensure profitPercentage is a number before toFixed
                  if (typeof trade.profitPercentage === 'number') {
                      logger.info(`      Profit Percentage: ~${trade.profitPercentage.toFixed(4)}% (vs borrowed ${trade.tokenIn?.symbol || '?'})`);
                  } else {
                      logger.debug(`[TradeLogger] profitPercentage is not a number: ${typeof trade.profitPercentage}`);
                  }
             }
        } else {
             logger.info(`      Profit calculation details not available or failed.`);
             // Log raw amounts even if profit not available
             logger.debug(`      Raw Simulation Output (Borrowed Token Decimals): ${trade.amountOut?.toString() || 'N/A'}`);
        }

        // Always log raw amounts at debug level if they exist
         if (trade.amountIn !== undefined && trade.intermediateAmountOut !== undefined && trade.amountOut !== undefined) {
             logger.debug(`      Raw Amounts: Borrow=${trade.amountIn?.toString()}, IntermediateOut=${trade.intermediateAmountOut?.toString()}, FinalOut=${trade.amountOut?.toString()}`);
         }


    } catch (logError) {
        logger.error(`[TradeLogger] Error logging trade details for index ${index}: ${logError.message}`);
        // Attempt to log the raw trade object for debugging purposes
        try { logger.debug("Raw trade object:", JSON.stringify(trade, (k,v) => typeof v === 'bigint' ? v.toString() : v, 2)); } catch { logger.debug("Raw trade object: (Cannot stringify)");}
    }
}

// Export the logging function
module.exports = {
    logTradeDetails
};
