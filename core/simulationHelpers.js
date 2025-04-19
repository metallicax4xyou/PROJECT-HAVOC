// /workspaces/arbitrum-flash/core/simulationHelpers.js
const { FeeAmount } = require('@uniswap/v3-sdk');
const { Token } = require('@uniswap/sdk-core');
const JSBI = require('jsbi');

// --- Define MIN/MAX SqrtRatio constants (copied from SDK for direct comparison) ---
const MIN_SQRT_RATIO = JSBI.BigInt('4295128739');
const MAX_SQRT_RATIO = JSBI.BigInt('1461446703485210103287273052203988822378723970342');
// ---

// --- Helper function to map numeric fee to FeeAmount enum ---
function getFeeAmountEnum(feeBps) {
    const feeNumber = Number(feeBps); // Ensure it's a number
    switch (feeNumber) {
        case 100: return FeeAmount.LOWEST; // 0.01%
        case 500: return FeeAmount.LOW;    // 0.05%
        case 3000: return FeeAmount.MEDIUM; // 0.3%
        case 10000: return FeeAmount.HIGH;   // 1%
        default:
            // Handle unknown fee tiers if necessary
            console.warn(`[getFeeAmountEnum] Unknown fee tier: ${feeBps}. Returning undefined.`);
            return undefined; // Or throw new Error(`Unsupported fee tier: ${feeBps}`);
    }
}
// --- End Helper Function ---

// Helper to stringify pool state for logging, avoiding circular issues if tokens have complex properties
function stringifyPoolState(state) {
    if (!state) return 'undefined';
    try {
        const replacer = (key, value) => {
            // Handle SDK Token instances
            if (value instanceof Token) {
                return { address: value.address, symbol: value.symbol, decimals: value.decimals, chainId: value.chainId };
            }
            // Convert BigInts to strings for JSON compatibility
            if (typeof value === 'bigint') {
                return value.toString();
            }
            // Handle potential nested BigInts or Tokens in objects/arrays (basic handling)
            if (typeof value === 'object' && value !== null) {
                // Example: Check if it looks like a CurrencyAmount (has quotient)
                 if (value.quotient !== undefined && typeof value.quotient === 'bigint') {
                    return { value: value.quotient.toString(), type: 'CurrencyAmountBigInt' }; // Mark it
                 }
                 // Add more checks if other complex nested objects cause issues
            }
            // Let JSON.stringify handle the rest
            return value;
        };
        return JSON.stringify(state, replacer, 2); // Pretty print with 2 spaces
    } catch (e) {
        console.error(`[stringifyPoolState] Error stringifying state: ${e.message}`);
        // Fallback to prevent crashing the logger, provide minimal info
        return `{ address: ${state.address}, fee: ${state.fee}, tick: ${state.tick?.toString()}, sqrtPriceX96: ${state.sqrtPriceX96?.toString()}, liquidity: ${state.liquidity?.toString()}, ... (stringify error) }`;
    }
}

module.exports = {
    MIN_SQRT_RATIO,
    MAX_SQRT_RATIO,
    getFeeAmountEnum,
    stringifyPoolState,
};
