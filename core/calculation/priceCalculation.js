// core/calculation/priceCalculation.js
// Utility functions for calculating effective prices for arbitrage finders,
// using raw price calculations from utils/priceUtils.js.
// --- VERSION v1.8 --- Removed raw price calcs and constants, imported from utils/priceUtils.js

const logger = require('../../utils/logger');
const { handleError, ArbitrageError } = require('../../utils/errorHandler'); // Adjust path as needed

// Import constants and raw price calculation functions from utils/priceUtils.js
const {
    PRICE_SCALE,
    PRICE_SCALE_DECIMALS,
    TEN_THOUSAND,
    // Q96, // Not strictly needed here, only in V3 raw price calc
    // Q192 // Not strictly needed here, only in V3 raw price calc
} = require('../../utils/priceUtils'); // <-- NEW IMPORT for constants
// Import raw price calculation functions (though calculateEffectivePrices takes scaled prices, not pool state)
// const { calculateV3PriceT0_T1_scaled, calculateV2PriceT0_T1_scaled, calculateDodoPriceT0_T1_scaled } = require('../../utils/priceUtils'); // Not needed directly in this file


/**
 * Calculates the effective buy and sell prices for a pair of pools, accounting for fees.
 * This function assumes `poolA` and `poolB` are for the *same* token pair, but potentially different DEX types.
 * It requires the *already calculated and scaled* raw prices for each pool (T0/T1 scaled by 1e18).
 * It returns effective prices for all 4 potential swap directions (A->B and B->A for both T0 and T1) scaled by PRICE_SCALE.
 *
 * @param {object} poolA - The state object for the first pool (needed for fees and token decimals).
 * @param {object} poolB - The state object for the second pool (needed for fees and token decimals).
 * @param {bigint} priceA_0_per_1_scaled - Scaled raw price of poolA (T0/T1 scaled by PRICE_SCALE).
 * @param {bigint} priceB_0_per_1_scaled - Scaled raw price of poolB (T0/T1 scaled by PRICE_SCALE).
 * @returns {object|null} An object containing effective prices for all 4 potential swap directions (A->B, B->A for both T0 and T1) scaled by PRICE_SCALE, or null if calculation fails.
 * Example return: { price_A_T0_to_T1_sell_effective: scaledPrice, price_B_T0_to_T1_buy_effective: scaledPrice, ... }
 */
function calculateEffectivePrices(poolA, poolB, priceA_0_per_1_scaled, priceB_0_per_1_scaled) {
    const logPrefix = '[priceCalculation calculateEffectivePrices]';
    logger.debug(`${logPrefix} Calculating effective prices for pools ${poolA?.address?.substring(0,6)} and ${poolB?.address?.substring(0,6)}`);

    // Validate inputs - Check for null/undefined and BigInt type for prices
    if (!poolA || !poolB || typeof priceA_0_per_1_scaled !== 'bigint' || priceA_0_per_1_scaled < 0n ||
        typeof priceB_0_per_1_scaled !== 'bigint' || priceB_0_per_1_scaled < 0n) {
        logger.error(`${logPrefix} Cannot calculate effective prices with null pools or invalid raw prices.`);
        return null;
    }
     // Ensure token decimals match and are valid numbers before converting to BigInt
     if (poolA.token0?.decimals === undefined || poolA.token1?.decimals === undefined ||
         poolB.token0?.decimals === undefined || poolB.token1?.decimals === undefined ||
         typeof poolA.token0.decimals !== 'number' || typeof poolA.token1.decimals !== 'number' ||
         typeof poolB.token0.decimals !== 'number' || typeof poolB.token1.decimals !== 'number' ||
         BigInt(poolA.token0.decimals) < 0n || BigInt(poolA.token1.decimals) < 0n ||
         BigInt(poolB.token0.decimals) < 0n || BigInt(poolB.token1.decimals) < 0n ||
         poolA.token0.address?.toLowerCase() !== poolB.token0.address?.toLowerCase() || // Ensure they are for the same pair
         poolA.token1.address?.toLowerCase() !== poolB.token1.address?.toLowerCase() // Case-insensitive address check
        ) {
          logger.error(`${logPrefix} Mismatched or invalid token details between pools. PoolA: ${poolA.address} (${poolA.token0?.symbol}/${poolA.token1?.symbol}), PoolB: ${poolB.address} (${poolB.token0?.symbol}/${poolB.token1?.symbol})`);
          return null;
     }

    // The raw prices (priceA_0_per_1_scaled, priceB_0_per_1_scaled) are scaled by PRICE_SCALE (1e18).
    // We need the inverse price (T1/T0) also scaled by PRICE_SCALE.
    // Scaled Price(T1/T0, 1e18) = (PRICE_SCALE * PRICE_SCALE) / Scaled Price(T0/T1, 1e18)

    let priceA_1_per_0_scaled = 0n;
    if (priceA_0_per_1_scaled > 0n) {
        priceA_1_per_0_scaled = (PRICE_SCALE * PRICE_SCALE) / priceA_0_per_1_scaled;
    } else {
         logger.debug(`${logPrefix} Raw price A (T0/T1) is zero or negative (${priceA_0_per_1_scaled}). Cannot calculate inverse.`);
         return null; // Cannot calculate effective prices if raw price is invalid
    }

    let priceB_1_per_0_scaled = 0n;
    if (priceB_0_per_1_scaled > 0n) {
         priceB_1_per_0_scaled = (PRICE_SCALE * PRICE_SCALE) / priceB_0_per_1_scaled;
    } else {
         logger.debug(`${logPrefix} Raw price B (T0/T1) is zero or negative (${priceB_0_per_1_scaled}). Cannot calculate inverse.`);
         return null; // Cannot calculate effective prices if raw price is invalid
    }


    // Now calculate effective prices considering fees
    // Fee is assumed to be in basis points (0-10000 range)
    // Need to ensure fee is BigInt and scaled consistently (e.g., all as BPS 0-10000)
    // Assuming pool.fee is already in BPS (0-10000 range) from the fetcher/scanner
    const feeA_Bps = BigInt(poolA.fee);
    const feeB_Bps = BigInt(poolB.fee);

     // Validate fees are within a reasonable range (e.g., non-negative and < 10000 BPS)
     if (feeA_Bps < 0n || feeA_Bps >= TEN_THOUSAND || feeB_Bps < 0n || feeB_Bps >= TEN_THOUSAND) {
          logger.error(`${logPrefix} Invalid fee basis points found. PoolA Fee: ${feeA_Bps}, PoolB Fee: ${feeB_Bps}. PoolA: ${poolA.address}, PoolB: ${poolB.address}`);
          return null; // Invalid fees
     }

     const numeratorFee = TEN_THOUSAND; // 10000n
     const divisorA = TEN_THOUSAND - feeA_Bps; // 10000 - feeBps
     const divisorB = TEN_THOUSAND - feeB_Bps; // 10000 - feeBps

     // These should not be zero or negative if fees are validated to be < 10000
     // if (divisorA <= 0n || divisorB <= 0n) { /* ... error ... */ } // Check now redundant due to fee validation above

    const effectivePrices = {}; // Object to store results

    // Effective Price T0/T1 (scaled by PRICE_SCALE)
    // Selling T0 on Pool A (getting T1): rawPrice * (1 - feeA) = rawPrice * divisorA / 10000
    // Price T0/T1 means selling T0 to get T1. So fee applies to the amount of T0 *sold*.
    // Effective price = (Amount T1 Received) / (Amount T0 Sent)
    // Amount T1 Received = (Amount T0 Sent * rawPrice) * (1 - fee) = Amount T0 Sent * rawPrice * divisor / 10000
    // Effective Price = (Amount T0 Sent * rawPrice * divisor / 10000) / Amount T0 Sent = rawPrice * divisor / 10000
    effectivePrices.price_A_T0_to_T1_sell_effective = (priceA_0_per_1_scaled * divisorA) / TEN_THOUSAND; // Correct

    // Buying T0 on Pool A (spending T1): rawPrice / (1 - feeA) = rawPrice * 10000 / divisorA
    // Price T0/T1 means buying T0 by spending T1. So fee applies to the amount of T0 *bought*.
    // Effective price = (Amount T0 Bought) / (Amount T1 Spent)
    // Amount T0 Bought = (Amount T1 Spent / rawPrice) * (1-fee)
    // Wait, fee is usually taken from the input amount or a percentage of the trade value.
    // Let's assume fee is taken from the INPUT token amount.
    // Selling T0 (Input T0): Effective Price T0/T1 = RawPrice * (1 - fee) = rawPrice * divisorA / 10000. This is correct.
    // Buying T0 (Input T1): Amount T1 Sent. Amount T0 Received = (Amount T1 Sent / rawPrice) * (1 - fee).
    // Effective Price = (Amount T0 Received) / Amount T1 Sent = (Amount T1 Sent / rawPrice * (1-fee)) / Amount T1 Sent = (1/rawPrice) * (1-fee)
    // No, that's Price T1/T0 effective.
    // Let's rethink. Fee is taken from the *input* amount.
    // Sell X T0 -> get Y T1. Fee taken from X T0. Net T0 = X * (1-fee). Get Y T1. Price = Y / (X * (1-fee)) = (Y/X) / (1-fee) = rawPrice / (1-fee).
    // Buy X T0 -> spend Y T1. Fee taken from Y T1. Net T1 = Y * (1-fee). Get X T0. Price = X / (Y * (1-fee)) = (X/Y) / (1-fee) = (1/rawPrice) / (1-fee).
    // This is Price T1/T0 effective. To get Price T0/T1 effective, invert this: rawPrice * (1-fee).
    // This implies fee is taken from the output token... which is common in some pools (e.g., token received).
    // For V3, fee is taken from the input amount. Let's stick to the common V2/V3 model where fee is taken from input.
    // If you input X T0, you get Y T1. Fee is X * feeRate, net input is X * (1-feeRate). Output Y T1. Price = Y / (X * (1-feeRate)) = (Y/X) / (1-feeRate) = rawPrice / (1-feeRate).
    // So, Effective Price = Raw Price / (1 - fee rate) = Raw Price * 10000 / divisor.
    // This applies when the INPUT token is the one on the left side of the price ratio (T0 in T0/T1).
    // If you sell T0 (input T0), the effective price T0/T1 is RawPrice * 10000 / divisor.
    effectivePrices.price_A_T0_to_T1_sell_effective = (priceA_0_per_1_scaled * numeratorFee) / divisorA; // CORRECTED

    // If you buy T0 (input T1), the effective price T0/T1 is different. The raw price T0/T1 is P. Raw price T1/T0 is 1/P.
    // You input X T1, get Y T0. Fee is X * feeRate, net input is X * (1-feeRate). Output Y T0.
    // Price T1/T0 effective = Y / (X * (1-feeRate)) = (Y/X) / (1-feeRate) = RawPrice(T1/T0) / (1-feeRate).
    // Price T0/T1 effective = 1 / (Price T1/T0 effective) = 1 / (RawPrice(T1/T0) / (1-feeRate)) = (1-feeRate) / RawPrice(T1/T0) = (1-feeRate) * RawPrice(T0/T1).
    // So, Effective Price T0/T1 (when inputting T1) = Raw Price T0/T1 * (1-fee rate) = Raw Price T0/T1 * divisor / 10000.
    effectivePrices.price_A_T0_to_T1_buy_effective = (priceA_0_per_1_scaled * divisorA) / TEN_THOUSAND; // CORRECTED

    // Let's label correctly:
    // Price_A_T0_per_T1_buy_T0_with_T1_effective: spending T1 to buy T0. Raw Price T0/T1. Input is T1.
    // Price_A_T0_per_T1_sell_T0_for_T1_effective: selling T0 to get T1. Raw Price T0/T1. Input is T0.

    // Effective Price T0/T1 when INPUT is T0 (selling T0): Raw Price T0/T1 * (1 - fee)
    effectivePrices.price_A_T0_per_T1_input_T0_effective = (priceA_0_per_1_scaled * divisorA) / TEN_THOUSAND; // Selling T0 on A

    // Effective Price T0/T1 when INPUT is T1 (buying T0): Raw Price T0/T1 / (1 - fee)
    effectivePrices.price_A_T0_per_T1_input_T1_effective = (priceA_0_per_1_scaled * numeratorFee) / divisorA; // Buying T0 on A


    // Effective Price T1/T0 (scaled by PRICE_SCALE)
    // Selling T1 on Pool A (input T1): Raw Price T1/T0 * (1 - fee)
    effectivePrices.price_A_T1_per_T0_input_T1_effective = (priceA_1_per_0_scaled * divisorA) / TEN_THOUSAND; // Selling T1 on A

    // Buying T1 on Pool A (input T0): Raw Price T1/T0 / (1 - fee)
    effectivePrices.price_A_T1_per_T0_input_T0_effective = (priceA_1_per_0_scaled * numeratorFee) / divisorA; // Buying T1 on A

    // Repeat for Pool B
    effectivePrices.price_B_T0_per_T1_input_T0_effective = (priceB_0_per_1_scaled * divisorB) / TEN_THOUSAND; // Selling T0 on B
    effectivePrices.price_B_T0_per_T1_input_T1_effective = (priceB_0_per_1_scaled * numeratorFee) / divisorB; // Buying T0 on B

    effectivePrices.price_B_T1_per_T0_input_T1_effective = (priceB_1_per_0_scaled * divisorB) / TEN_THOUSAND; // Selling T1 on B
    effectivePrices.price_B_T1_per_T0_input_T0_effective = (priceB_1_per_0_scaled * numeratorFee) / divisorB; // Buying T1 on B

     // Sanity checks (optional but good)
     // Ensure effective prices are positive
     for (const key in effectivePrices) {
         if (effectivePrices[key] < 0n) {
              logger.warn(`${logPrefix} Negative effective price calculated for ${key}. Value: ${effectivePrices[key].toString()}. PoolA: ${poolA.address}, PoolB: ${poolB.address}`);
              // Return null or set to 0n depending on desired strictness
              return null; // Invalid scenario
         }
     }

    logger.debug(`${logPrefix} Effective prices calculated successfully for ${poolA.address.substring(0,6)}-${poolB.address.substring(0,6)}.`);

    return effectivePrices;
}


module.exports = {
    // Raw price calculation functions are now in utils/priceUtils.js
    calculateEffectivePrices, // Export the function for calculating effective prices
    // Constants are now exported from utils/priceUtils.js
};
