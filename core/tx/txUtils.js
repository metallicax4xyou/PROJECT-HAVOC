// core/tx/txUtils.js
// Utility functions shared across transaction builders/encoders.

let logger; try { logger = require('../../utils/logger'); } catch(e) { console.error("No logger for txUtils"); logger = console; }

// Helper function to calculate minimum amount out based on slippage
function calculateMinAmountOut(amountOut, slippageToleranceBps) {
    if (amountOut == null || typeof amountOut !== 'bigint' || amountOut <= 0n || slippageToleranceBps < 0) {
        logger.warn(`[calculateMinAmountOut] Invalid input: amountOut=${amountOut} (type: ${typeof amountOut}), slippage=${slippageToleranceBps}. Returning 0n.`);
        return 0n;
    }
    const BPS_DIVISOR = 10000n;
    const slippageFactor = BPS_DIVISOR - BigInt(slippageToleranceBps);
    if (slippageFactor <= 0n) { // Also check for <= 0 to handle 100% slippage case
        logger.warn(`[calculateMinAmountOut] Slippage tolerance ${slippageToleranceBps} >= 10000 BPS. Returning 0n.`);
        return 0n;
    }
    return (amountOut * slippageFactor) / BPS_DIVISOR;
}

module.exports = {
    calculateMinAmountOut,
};
