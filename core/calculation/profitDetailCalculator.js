// core/calculation/profitDetailCalculator.js
// Calculates detailed profit/cost figures, applies thresholds, and determines final profitability.
// --- VERSION v2.13 --- Corrected import path for PRICE_SCALE and TEN_THOUSAND constants.

const { ethers } = require('ethers');
const logger = require('../../utils/logger');
const { ArbitrageError } = require('../../utils/errorHandler');
const priceConverter = require('../../utils/priceConverter'); // Needs price converter
// Corrected import path for constants PRICE_SCALE and TEN_THOUSAND
const { PRICE_SCALE, TEN_THOUSAND } = require('../../utils/priceUtils'); // Import constants from utils/priceUtils

/**
 * Calculates detailed profit, fee, and cost metrics for a single opportunity,
 * augments the opportunity object, and checks if it meets profitability criteria.
 * @param {object} opportunity - The opportunity object (will be augmented in place).
 * @param {object} simulationResults - { amountOut: bigint, intermediateAmountOut: bigint } - Results from swap simulation.
 * @param {object} gasEstimationResult - { totalCostWei: bigint, pathGasLimit: bigint, effectiveGasPrice: bigint, estimateGasSuccess: boolean, errorMessage?: string } - Results from gas estimation.
 * @param {object} config - Application configuration (needs MIN_PROFIT_THRESHOLDS, NATIVE_CURRENCY_SYMBOL, TITHE_BPS).
 * @param {{symbol: string, decimals: number, address: string}} nativeCurrencyToken - The native currency token object.
 * @param {bigint} aaveFlashLoanFeeBps - The Aave flash loan fee in basis points (BigInt).
 * @returns {Promise<boolean>} True if the opportunity is deemed profitable after all checks, false otherwise.
 * @throws {ArbitrageError} If a critical calculation or conversion fails.
 */
async function calculateDetailedProfit(opportunity, simulationResults, gasEstimationResult, config, nativeCurrencyToken, aaveFlashLoanFeeBps) {
    const logPrefix = `[ProfitDetailCalc ${opportunity.type || '?'}-${opportunity.pairKey || '?'}]`;
    logger.debug(`${logPrefix} Starting detailed profit calculation...`);

    const { amountOut, intermediateAmountOut } = simulationResults;

    // Ensure required data is present
    if (amountOut === undefined || amountOut === null || BigInt(opportunity.amountIn || 0n) <= 0n) {
        const errorMsg = "Missing or invalid simulation results (amountOut) or initial amountIn.";
        logger.error(`${logPrefix} CRITICAL: ${errorMsg}`);
        throw new ArbitrageError('ProfitCalculationError', errorMsg);
    }
    if (!gasEstimationResult || gasEstimationResult.totalCostWei === undefined || typeof gasEstimationResult.estimateGasSuccess !== 'boolean' || gasEstimationResult.pathGasLimit === undefined) {
        const errorMsg = "Missing or invalid gas estimation results.";
        logger.error(`${logPrefix} CRITICAL: ${errorMsg}`);
        throw new ArbitrageError('ProfitCalculationError', errorMsg);
    }
     if (!nativeCurrencyToken || nativeCurrencyToken.decimals === undefined) {
         const errorMsg = "Missing or invalid native currency token object.";
         logger.error(`${logPrefix} CRITICAL: ${errorMsg}`);
         throw new ArbitrageError('ProfitCalculationError', errorMsg);
     }


    // --- 1. Calculate Gross Profit ---
    const grossProfitBorrowedTokenWei = amountOut - BigInt(opportunity.amountIn || 0n);
    logger.debug(`${logPrefix} Gross Profit (Borrowed): ${grossProfitBorrowedTokenWei.toString()} wei.`);

    // --- 2. Calculate Flash Loan Fee ---
    // Fee = BorrowedAmount * FeeBps / 10000
    // Ensure opportunity.amountIn is BigInt for safety, although finder should provide BigInt
    const borrowedAmountBigInt = BigInt(opportunity.amountIn || 0n);
    const flashLoanFeeBorrowedTokenWei = (borrowedAmountBigInt * aaveFlashLoanFeeBps) / TEN_THOUSAND; // Use provided feeBps
    opportunity.flashLoanDetails = { // Add details to opportunity for logging
        token: opportunity.tokenIn, // Borrowed token object
        amount: borrowedAmountBigInt, // Borrowed amount
        feeBps: aaveFlashLoanFeeBps, // Store the BPS used
        feeBorrowedTokenWei: flashLoanFeeBorrowedTokenWei, // Store Fee in borrowed token wei
        feeNativeWei: 0n // Placeholder, calculated below
    };
    logger.debug(`${logPrefix} FL Fee (Borrowed): ${flashLoanFeeBorrowedTokenWei.toString()} wei.`);

    // --- 3. Calculate Net Profit Pre-Gas ---
    const netProfitPreGasBorrowedTokenWei = grossProfitBorrowedTokenWei - flashLoanFeeBorrowedTokenWei;
    logger.debug(`${logPrefix} Net Profit (Pre-Gas) in borrowed token: ${netProfitPreGasBorrowedTokenWei.toString()} wei.`);

    if (netProfitPreGasBorrowedTokenWei <= 0n) {
        logger.debug(`${logPrefix} Net Profit (Pre-Gas) in borrowed token is non-positive (${netProfitPreGasBorrowedTokenWei}). Not profitable before costs.`);
        return false; // Not profitable
    }

    // --- 4. Convert Profit and Fee to Native Wei ---
    let netProfitPreGasNativeWei = 0n;
    let flashLoanFeeNativeWei = 0n;
    try {
        // Use the extracted utility function
        netProfitPreGasNativeWei = await priceConverter.convertToNativeWei(netProfitPreGasBorrowedTokenWei, opportunity.tokenIn, config, nativeCurrencyToken);
        flashLoanFeeNativeWei = await priceConverter.convertToNativeWei(flashLoanFeeBorrowedTokenWei, opportunity.tokenIn, config, nativeCurrencyToken);
        opportunity.flashLoanDetails.feeNativeWei = flashLoanFeeNativeWei; // Store Fee in native wei

        logger.debug(`${logPrefix} Net Profit (Pre-Gas, Native): ${netProfitPreGasNativeWei.toString()} wei. FL Fee (Native): ${flashLoanFeeNativeWei.toString()} wei.`);

    } catch (conversionError) {
        logger.error(`${logPrefix} Error converting profit/fee to Native Wei: ${conversionError.message}`, conversionError);
        opportunity.conversionError = conversionError.message;
        throw new ArbitrageError('PriceConversionError', `Conversion failed: ${conversionError.message}`, conversionError); // Re-throw as critical
    }

    // --- 5. Subtract Gas Cost ---
    const gasCostNativeWei = BigInt(gasEstimationResult.totalCostWei || 0n); // Ensure it's BigInt

    if (netProfitPreGasNativeWei < gasCostNativeWei) {
        logger.debug(`${logPrefix} Net profit pre-gas (${ethers.formatEther(netProfitPreGasNativeWei)}) less than gas cost (${ethers.formatEther(gasCostNativeWei)}). Not profitable after gas.`);
        return false; // Not profitable
    }
    const netProfitAfterGasNativeWei = netProfitPreGasNativeWei - gasCostNativeWei;
    opportunity.netProfitNativeWei = netProfitAfterGasNativeWei; // Augment opportunity object
    logger.debug(`${logPrefix} Net Profit (After Gas, Native): ${netProfitAfterGasNativeWei.toString()} wei`);

    // --- 6. Apply Minimum Profit Threshold ---
    const thresholdInNativeStandardUnits = config.MIN_PROFIT_THRESHOLDS[opportunity.borrowTokenSymbol] || config.MIN_PROFIT_THRESHOLDS.DEFAULT;
    let minProfitThresholdNativeWei = 0n;
    if (thresholdInNativeStandardUnits !== undefined && thresholdInNativeStandardUnits !== null) {
        try {
             // Use ethers.parseUnits to convert standard units (number/string) to native wei (BigInt)
            minProfitThresholdNativeWei = ethers.parseUnits(String(thresholdInNativeStandardUnits), nativeCurrencyToken.decimals);
        } catch (e) {
            logger.error(`${logPrefix} Error converting min profit threshold (${thresholdInNativeStandardUnits}) to native wei: ${e.message}. Using threshold 0n.`, e); // Log error object
            minProfitThresholdNativeWei = 0n; // Fallback to 0 threshold on error
        }
    } else {
        logger.warn(`${logPrefix} Min profit threshold not found for token ${opportunity.borrowTokenSymbol || '?'} or DEFAULT. Using threshold 0n.`); // Log 0n
        minProfitThresholdNativeWei = 0n;
    }
    opportunity.thresholdNativeWei = minProfitThresholdNativeWei; // Store threshold in native wei

    if (netProfitAfterGasNativeWei <= minProfitThresholdNativeWei) {
        logger.debug(`${logPrefix} Net profit (${ethers.formatEther(netProfitAfterGasNativeWei)}) below threshold (${ethers.formatEther(minProfitThresholdNativeWei)}). Not profitable.`);
        return false; // Not profitable
    }
    logger.debug(`${logPrefix} Net profit (${ethers.formatEther(netProfitAfterGasNativeWei)}) meets threshold (${ethers.formatEther(minProfitThresholdNativeWei)}).`);


    // --- 7. Calculate Tithe ---
    // Safely read TITHE_BPS from config, default to 0 if missing/invalid, use 3000n (30%) if config > 0.
    const titheBpsConfig = BigInt(config.TITHE_BPS || 0n); // Default to 0n if missing
    const titheBps = titheBpsConfig > 0n ? titheBpsConfig : 3000n; // Use config if > 0, else use hardcoded 30% (3000 BPS)
    if (titheBpsConfig > 0n) logger.debug(`${logPrefix} Using configured tithe BPS: ${titheBpsConfig.toString()}`); // Log as string


    // Ensure netProfitAfterGasNativeWei is BigInt for calculation
    const netProfitAfterGasNativeWeiBigInt = BigInt(netProfitAfterGasNativeWei || 0n);

    const titheAmountNativeWei = (netProfitAfterGasNativeWeiBigInt * titheBps) / TEN_THOUSAND; // Tithe calculated in Native Wei
    opportunity.titheAmountNativeWei = titheAmountNativeWei; // Augment opportunity object
    logger.debug(`${logPrefix} Tithe Amount (Native): ${ethers.formatEther(titheAmountNativeWei)} wei (${(titheBps * 10000n / TEN_THOUSAND)/100n}% of ${ethers.formatEther(netProfitAfterGasNativeWeiBigInt)}). Raw Tithe: ${titheAmountNativeWei.toString()}`); // Log raw tithe and percentage check


    // --- 8. Calculate Profit Percentage ---
    let profitPercentage = 0;
    let borrowedAmountNativeWei_ForPercent = 0n;
    try {
        // Ensure opportunity.amountIn is BigInt before passing
        borrowedAmountNativeWei_ForPercent = await priceConverter.convertToNativeWei(BigInt(opportunity.amountIn || 0n), opportunity.tokenIn, config, nativeCurrencyToken);
    } catch (conversionError) {
         logger.warn(`${logPrefix} Error converting borrowed amount to Native for percent calc: ${conversionError.message}`, conversionError);
         // Continue, just profitPercentage will remain 0
    }

    if (borrowedAmountNativeWei_ForPercent > 0n) {
        try {
             // Calculation: (netProfitAfterGasNativeWei / borrowedAmountNativeWei_ForPercent) * 100
             // Need BigInt arithmetic: (netProfitAfterGasNativeWei * 10000n) / borrowedAmountNativeWei_ForPercent * (100/10000) = * 100 / 10000
             // Percentage = (netProfitAfterGasNativeWei * 100n) / borrowedAmountNativeWei_ForPercent --- No, percentage is (profit/borrowed)*100
             // (netProfitAfterGasNativeWei * 100n) / borrowedAmountNativeWei_ForPercent this gives the percentage as a BigInt scaled by some factor.
             // To get a float percentage: Number(netProfitAfterGasNativeWei * 100n) / Number(borrowedAmountNativeWei_ForPercent)
             // Or, to keep BigInt precision and convert later:
             const profitRatioScaledBy10000 = (netProfitAfterGasNativeWeiBigInt * TEN_THOUSAND) / borrowedAmountNativeWei_ForPercent; // Ratio scaled by 10000 (BPS)
             profitPercentage = Number(profitRatioScaledBy10000) / 100; // Convert BPS to percentage as a Number

        } catch (divError) {
             logger.warn(`${logPrefix} Error calculating profit percentage: ${divError.message}`, divError);
             profitPercentage = 0; // Fallback on error
        }
    }
    opportunity.profitPercentage = profitPercentage; // Augment opportunity object
    logger.debug(`${logPrefix} Estimated Profit Percentage: ${profitPercentage}%`);

    // --- 9. Calculate Estimated Profit for Executor ---
    // Ensure both operands are BigInt for subtraction
    const estimatedProfitForExecutorNativeWei = netProfitAfterGasNativeWeiBigInt - titheAmountNativeWei;
    opportunity.estimatedProfitForExecutorNativeWei = estimatedProfitForExecutorNativeWei; // Profit left for bot after tithe transfer
    logger.debug(`${logPrefix} Estimated Profit for Executor (After Tithe, Native): ${ethers.formatEther(estimatedProfitForExecutorNativeWei)} wei. Raw Executor Profit: ${estimatedProfitForExecutorNativeWei.toString()}`); // Log raw executor profit


    // --- Final Check: Is it truly profitable based on all criteria? ---
    // We already checked netProfitAfterGasNativeWei > minProfitThresholdNativeWei
    // and simulationSuccess and gasEstimationResult.estimateGasSuccess were checked before calling this function.
    // Just confirm here for clarity, although redundant if called correctly.
    if (netProfitAfterGasNativeWeiBigInt > minProfitThresholdNativeWei && gasEstimationResult.estimateGasSuccess) {
         logger.debug(`${logPrefix} Opportunity is profitable after all calculations and checks.`);
         return true;
    } else {
         logger.debug(`${logPrefix} Opportunity failed final profitability check (Profit > Threshold: ${netProfitAfterGasNativeWeiBigInt > minProfitThresholdNativeWei}, Gas Estimate Success: ${gasEstimationResult.estimateGasSuccess}).`);
         return false;
    }
}

module.exports = {
    calculateDetailedProfit
};
