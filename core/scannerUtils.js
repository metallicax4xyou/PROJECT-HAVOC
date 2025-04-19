// core/scannerUtils.js
const logger = require('../utils/logger'); // Assuming logger is accessible

const BIGNUM_SCALE_DECIMALS = 36; // Must match poolScanner.js

// Helper Function to get Tick Spacing from Fee Tier
function getTickSpacingFromFeeBps(feeBps) {
    const feeMap = { 100: 1, 500: 10, 3000: 60, 10000: 200 };
    const spacing = feeMap[feeBps];
    if (spacing === undefined) {
        logger.warn(`[ScannerUtils] Unknown fee tier (${feeBps}bps), defaulting tickSpacing to 60.`);
        return 60;
    }
    return spacing;
}

// --- HELPER #4 (BigInt Price Ratio Calculation) ---
/**
 * Calculates the price ratio of token1/token0 using BigInt math, scaled.
 * Price(token1/token0) = (sqrtPriceX96 / 2^96)^2
 * Returns priceRatio * SCALE as a BigInt.
 * @param {bigint} sqrtPriceX96 The sqrtPriceX96 value from the pool.
 * @param {bigint} scale The scaling factor (BIGNUM_SCALE).
 * @returns {bigint|null} The scaled price ratio, or null on error.
 */
function getScaledPriceRatio(sqrtPriceX96, scale) {
    const Q96 = 1n << 96n;
    const Q192 = Q96 * Q96;

    if (sqrtPriceX96 === 0n) return 0n;
    if (Q192 === 0n) {
        logger.error("[ScannerUtils:getScaledPriceRatio] Q192 constant is zero!");
        return null;
    }
    if (scale === 0n) {
         logger.error("[ScannerUtils:getScaledPriceRatio] Scale factor is zero!");
         return null;
    }
    try {
        const sqrtP_squared = sqrtPriceX96 * sqrtPriceX96;
        const numerator = sqrtP_squared * scale;
        const priceRatioScaled = numerator / Q192;
        return priceRatioScaled;
    } catch (error) {
        logger.error(`[ScannerUtils:getScaledPriceRatio] Error calculating scaled price ratio: ${error.message} for sqrtP=${sqrtPriceX96}`);
        return null;
    }
}


// --- Helper to format scaled BigInt for logging (Safer) ---
function formatScaledBigIntForLogging(scaledValue, scaleDecimals = BIGNUM_SCALE_DECIMALS, displayDecimals = 8) {
    if (typeof scaledValue !== 'bigint') return 'N/A';
    try {
        const scaleFactor = 10n ** BigInt(scaleDecimals);
        if (scaleFactor === 0n) return scaledValue.toString() + ' (Scale Factor Zero)';

        const isNegative = scaledValue < 0n;
        const absValue = isNegative ? -scaledValue : scaledValue;

        const integerPart = absValue / scaleFactor;
        const fractionalPart = absValue % scaleFactor;

        const fractionalString = fractionalPart.toString().padStart(scaleDecimals, '0');
        const displayFractional = fractionalString.slice(0, displayDecimals);

        return `${isNegative ? '-' : ''}${integerPart}.${displayFractional}`;
    } catch (e) {
        logger.error(`[ScannerUtils:formatScaledBigIntForLogging] Error formatting BigInt ${scaledValue}: ${e.message}`);
        return scaledValue.toString() + ` (Scale ${scaleDecimals})`;
    }
}

module.exports = {
    getTickSpacingFromFeeBps,
    getScaledPriceRatio,
    formatScaledBigIntForLogging,
    BIGNUM_SCALE_DECIMALS // Export constant if needed elsewhere, though maybe better defined once
};
