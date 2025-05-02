// core/calculation/priceCalculation.js
// Utility functions for calculating raw and effective prices for arbitrage finders.
// --- VERSION v1.3 --- Replaced logger.trace with logger.debug.

const logger = require('../../utils/logger'); // Assuming logger is accessible via relative path
const { handleError, ArbitrageError } = require('../../utils/errorHandler'); // Adjust path as needed

// Constants needed for calculations
// Use 18 decimals as the standard scale for consistency, like ETH/WETH
const PRICE_SCALE_DECIMALS = 18;
const PRICE_SCALE = 10n ** BigInt(PRICE_SCALE_DECIMALS); // 10^18
const TEN_THOUSAND = 10000n; // Constant for basis points calculation (100.00%)
const Q96 = 2n ** 96n;
const Q192 = Q96 * Q96; // (2**96)**2 = 2**192

/**
 * Calculates the price for a Uniswap V3 pool state (token1/token0).
 * Returns price scaled by PRICE_SCALE (1e18). Returns null on error.
 * Formula for Price T1/T0 Standard = ((sqrtPriceX96 / 2**96)^2) * (10^decimals0 / 10^decimals1)
 * Scaled Price T1/T0 (1e18) = Price T1/T0 Standard * PRICE_SCALE
 * Scaled Price T1/T0 (1e18) = (((sqrtPriceX96 * sqrtPriceX96) / Q192) * ((10n ** decimals0) / (10n ** decimals1))) * PRICE_SCALE
 * Rearranging for integer arithmetic to maintain precision (multiply before dividing):
 * Scaled Price T1/T0 (1e18) = (sqrtPriceX96 * sqrtPriceX96 * (10n ** decimals0) * PRICE_SCALE) / (Q192 * (10n ** decimals1))
 */
function calculateV3PriceT1_T0_scaled(poolState) {
    const logPrefix = '[priceCalculation calculateV3PriceT1_T0_scaled]';
    if (!poolState || poolState.sqrtPriceX96 === undefined || poolState.sqrtPriceX96 === null || BigInt(poolState.sqrtPriceX96) === 0n) {
        // Log at debug if sqrtPriceX96 is 0, warn if it's missing/invalid
        if (poolState?.sqrtPriceX96 === 0n) {
             logger.debug(`${logPrefix} Invalid V3 state for price calc: Zero sqrtPriceX96. Pool: ${poolState?.address}`);
        } else {
             logger.warn(`${logPrefix} Invalid V3 state for price calc: Missing sqrtPriceX96. Pool: ${poolState?.address}`);
        }
        return null;
    }
    // Ensure token decimals are valid numbers before converting to BigInt
    if (poolState.token0?.decimals === undefined || poolState.token0?.decimals === null ||
        poolState.token1?.decimals === undefined || poolState.token1?.decimals === null ||
        typeof poolState.token0.decimals !== 'number' || typeof poolState.token1.decimals !== 'number' ||
        BigInt(poolState.token0.decimals) < 0n || BigInt(poolState.token1.decimals) < 0n) { // Check decimals are non-negative
        logger.error(`${logPrefix} Invalid V3 state for price calc: Missing or invalid token decimals (${poolState.token0?.decimals}, ${poolState.token1?.decimals}). Pool: ${poolState?.address}`);
        return null;
    }
    try {
        const sqrtPriceX96 = BigInt(poolState.sqrtPriceX96);
        const decimals0 = BigInt(poolState.token0.decimals);
        const decimals1 = BigInt(poolState.token1.decimals);

        // Calculate 10^decimals0 and 10^decimals1 as BigInts
        const scale0 = 10n ** decimals0;
        const scale1 = 10n ** decimals1;

        // Ensure denominator is not zero
        const denominator = Q192 * scale1; // Denominator for T1/T0 calculation
        if (denominator === 0n) {
             logger.error(`${logPrefix} Division by zero avoided: calculated denominator is zero. Pool: ${poolState.address}`);
             return null; // Should not happen with valid decimals
        }

        // Correct calculation for Price T1/T0 scaled by PRICE_SCALE:
        // (sqrtPriceX96 * sqrtPriceX96 * scale0 * PRICE_SCALE) / (Q192 * scale1)
        const numerator = sqrtPriceX96 * sqrtPriceX96; // Intermediate: price scaled by Q192
        const numeratorScaled = numerator * scale0 * PRICE_SCALE; // Intermediate: scaled correctly for final division

        const adjustedPriceT1_T0_scaled = numeratorScaled / denominator; // Final integer division

        // --- CHANGED FROM logger.trace TO logger.debug ---
        logger.debug(`${logPrefix} V3 Pool ${poolState.address.substring(0,6)} | Price (T1/T0 scaled, 1e${PRICE_SCALE_DECIMALS}): ${adjustedPriceT1_T0_scaled}`);
        // --- END CHANGED LOG ---

        return adjustedPriceT1_T0_scaled;
    } catch (error) {
        // Catch and log any errors during the BigInt calculations
        logger.error(`${logPrefix} Error calculating V3 price for ${poolState.address}: ${error.message}`, error);
        handleError(error, `V3PriceCalc ${poolState.address}`);
        return null; // Return null on calculation error
    }
}


/**
 * Calculates the price for a SushiSwap pool state (token0/token1).
 * Returns price scaled by PRICE_SCALE (1e18). Returns null on error.
 * Formula: price = (reserve1 / reserve0) * (10^decimals0 / 10^decimals1)
 * Scaled Price = price * 10^PRICE_SCALE_DECIMALS
 * Rearranging for integer arithmetic:
 * Scaled Price = (reserve1 * (10n ** decimals0) * PRICE_SCALE) / (reserve0 * (10n ** decimals1))
 */
function calculateSushiPrice(poolState) {
    const logPrefix = '[priceCalculation calculateSushiPrice]';
     // Check for null/undefined reserves and also check if reserve0 is zero before accessing value
    if (!poolState || poolState.reserve0 === undefined || poolState.reserve0 === null || BigInt(poolState.reserve0) === 0n ||
        poolState.reserve1 === undefined || poolState.reserve1 === null) {
        logger.warn(`${logPrefix} Invalid Sushi state for price calc: Missing or zero reserve0. Pool: ${poolState?.address}`);
        return null;
    }
    // Ensure token decimals are valid numbers before converting to BigInt
    if (poolState.token0?.decimals === undefined || poolState.token0?.decimals === null ||
        poolState.token1?.decimals === undefined || poolState.token1?.decimals === null ||
        typeof poolState.token0.decimals !== 'number' || typeof poolState.token1.decimals !== 'number' ||
        BigInt(poolState.token0.decimals) < 0n || BigInt(poolState.token1.decimals) < 0n) { // Check decimals are non-negative
        logger.error(`${logPrefix} Invalid Sushi state for price calc: Missing or invalid token decimals (${poolState.token0?.decimals}, ${poolState.token1?.decimals}). Pool: ${poolState?.address}`);
        return null;
    }
    try {
        const reserve0 = BigInt(poolState.reserve0); // Amount of token0 in reserves
        const reserve1 = BigInt(poolState.reserve1); // Amount of token1 in reserves
        const decimals0 = BigInt(poolState.token0.decimals);
        const decimals1 = BigInt(poolState.token1.decimals);

        // Calculate 10^decimals0 and 10^decimals1 as BigInts
        const scale0 = 10n ** decimals0;
        const scale1 = 10n ** decimals1;

         // Ensure denominator is not zero (reserve0 checked already, scale1 could be if decimals1 < 0, which we checked)
        const denominator = reserve0 * scale1;
         if (denominator === 0n) {
             logger.error(`${logPrefix} Division by zero avoided: calculated denominator is zero. Pool: ${poolState.address}`);
             return null; // Should not happen with valid decimals and non-zero reserve0
         }

        // Correct calculation: (reserve1 * scale0 * PRICE_SCALE) / denominator
         const numeratorScaled = reserve1 * scale0 * PRICE_SCALE;

        const adjustedPriceScaled = numeratorScaled / denominator;

        // --- CHANGED FROM logger.trace TO logger.debug ---
        logger.debug(`${logPrefix} Sushi Pool ${poolState.address.substring(0,6)} | Adjusted Price (scaled, 1e${PRICE_SCALE_DECIMALS}): ${adjustedPriceScaled}`);
        // --- END CHANGED LOG ---

        return adjustedPriceScaled;
    } catch (error) {
        // Catch and log any errors during the BigInt calculations
        logger.error(`${logPrefix} Error calculating Sushi price for ${poolState.address}: ${error.message}`);
        handleError(error, `SushiPriceCalc ${poolState.address}`);
        return null; // Return null on calculation error
    }
}

/**
 * Calculates the price for a DODO pool state (Base/Quote).
 * Returns price scaled by PRICE_SCALE (1e18). Returns null on error.
 * Assumes queryAmountOutWei is the amount of quote token (in smallest units) received when selling a standard amount (1 * 10^decimalsBase) of base token (in smallest units).
 *
 * Price (Base/Quote in standard units) = (queryAmountOutWei / 10^decimalsQuote) for 1 standard unit of Base.
 *
 * Scaled Price (Base/Quote) = Price (Base/Quote in standard units) * PRICE_SCALE
 * Integer arithmetic: (queryAmountOutWei * PRICE_SCALE) / (10n ** decimalsQuote)
 *
 * Need to determine if T0 is Base and T1 is Quote (Price T0/T1 = Price Base/Quote) or vice versa (Price T0/T1 = Price Quote/Base = 1 / Price Base/Quote)
 */
function calculateDodoPrice(poolState) {
     const logPrefix = '[priceCalculation calculateDodoPrice]';
    // Check for essential data from the fetcher's query
    if (!poolState || poolState.queryAmountOutWei === undefined || poolState.queryAmountOutWei === null ||
         !poolState.queryBaseToken?.address || !poolState.queryQuoteToken?.address ||
         poolState.queryBaseToken?.decimals === undefined || poolState.queryBaseToken?.decimals === null ||
         poolState.queryQuoteToken?.decimals === undefined || poolState.queryQuoteToken?.decimals === null ||
         poolState.token0?.decimals === undefined || poolState.token0?.decimals === null || // Need T0/T1 decimals for scaling
         poolState.token1?.decimals === undefined || poolState.token1?.decimals === null ||
          typeof poolState.queryBaseToken.decimals !== 'number' || typeof poolState.queryQuoteToken.decimals !== 'number' ||
          typeof poolState.token0.decimals !== 'number' || typeof poolState.token1.decimals !== 'number' ||
          BigInt(poolState.queryBaseToken.decimals) < 0n || BigInt(poolState.queryQuoteToken.decimals) < 0n ||
          BigInt(poolState.token0.decimals) < 0n || BigInt(poolState.token1.decimals) < 0n // Check decimals are non-negative
         ) {
        logger.warn(`${logPrefix} Invalid DODO state for price calc: Missing query results or invalid token decimals. Pool: ${poolState?.address}`);
        return null;
    }

    const queryAmountOutWei = BigInt(poolState.queryAmountOutWei);
    const baseToken = poolState.queryBaseToken;
    const quoteToken = poolState.queryQuoteToken;
    const decimalsBase = BigInt(baseToken.decimals);
    const decimalsQuote = BigInt(quoteToken.decimals);

     // Calculate scale factors for Base and Quote tokens based on their decimals
     const scaleBase = 10n ** decimalsBase;
     const scaleQuote = 10n ** decimalsQuote;

     // Check for division by zero if queryAmountOutWei is zero, which would happen if price is infinite or liquidity zero
     if (queryAmountOutWei === 0n) {
         logger.debug(`${logPrefix} queryAmountOutWei is zero for DODO pool ${poolState.address}. Cannot calculate price.`);
         return null;
     }

    try {
         const [token0, token1] = [poolState.token0, poolState.token1]; // Get T0/T1 from poolState

         // Determine which case we are in: T0=Base, T1=Quote or T1=Base, T0=Quote
         let adjustedPriceScaled;
         if (token0.address.toLowerCase() === baseToken.address.toLowerCase() &&
             token1.address.toLowerCase() === quoteToken.address.toLowerCase()) {
             // Case 1: T0 is Base, T1 is Quote. We need Price(Base/Quote).
             // Price(Base/Quote standard) = queryAmountOutWei / scaleQuote
             // Scaled Price = (queryAmountOutWei * PRICE_SCALE) / scaleQuote
              if (scaleQuote === 0n) throw new Error("ScaleQuote is zero"); // Should not happen with valid decimals
              adjustedPriceScaled = (queryAmountOutWei * PRICE_SCALE) / scaleQuote;

         } else if (token1.address.toLowerCase() === baseToken.address.toLowerCase() &&
                    token0.address.toLowerCase() === quoteToken.address.toLowerCase()) {
             // Case 2: T1 is Base, T0 is Quote. We need Price(Quote/Base), which is 1 / Price(Base/Quote).
             // Price(Quote/Base standard) = 1 / (queryAmountOutWei / scaleQuote) = scaleQuote / queryAmountOutWei
             // Scaled Price = (scaleQuote / queryAmountOutWei) * PRICE_SCALE
             // Integer arithmetic: (scaleQuote * PRICE_SCALE) / queryAmountOutWei
              if (queryAmountOutWei === 0n) throw new Error("queryAmountOutWei is zero for inverse calc"); // Checked above, but safety
              adjustedPriceScaled = (scaleQuote * PRICE_SCALE) / queryAmountOutWei;

         } else {
              // Tokens T0/T1 don't match Base/Quote from the query. This is unexpected config/logic.
              logger.error(`${logPrefix} Pool T0/T1 tokens (${token0.symbol}/${token1.symbol}) do not match query Base/Quote (${baseToken.symbol}/${quoteToken.symbol}). Pool: ${poolState.address}`);
              return null;
         }

        // --- CHANGED FROM logger.trace TO logger.debug ---
        logger.debug(`${logPrefix} DODO Pool ${poolState.address.substring(0,6)} | Adjusted Price (scaled, 1e${PRICE_SCALE_DECIMALS}): ${adjustedPriceScaled}`);
        // --- END CHANGED LOG ---

        return adjustedPriceScaled;

    } catch (error) {
        // Catch and log any errors during the BigInt calculations
        logger.error(`${logPrefix} Error calculating DODO price for ${poolState.address}: ${error.message}`, error);
        handleError(error, `DodoPriceCalc ${poolState.address}`);
        return null; // Return null on calculation error
    }
}


/**
 * Calculates the effective buy and sell prices for a pair of pools, accounting for fees.
 * This function assumes `poolA` and `poolB` are for the *same* token pair, but potentially different DEX types.
 * It returns effective prices for all 4 potential swap directions (A->B and B->A for both T0 and T1) scaled by PRICE_SCALE.
 *
 * @param {object} poolA - The state object for the first pool.
 * @param {object} poolB - The state object for the second pool.
 * @param {bigint} priceA_0_per_1_scaled - Scaled raw price of poolA (T0/T1).
 * @param {bigint} priceB_0_per_1_scaled - Scaled raw price of poolB (T0/T1).
 * @returns {object|null} An object containing effective prices for all 4 potential swap directions (A->B, B->A for both T0 and T1) scaled by PRICE_SCALE, or null if calculation fails.
 * Example return: { price_A_T0_to_T1_sell_effective: scaledPrice, price_B_T0_to_T1_buy_effective: scaledPrice, ... }
 */
function calculateEffectivePrices(poolA, poolB, priceA_0_per_1_scaled, priceB_0_per_1_scaled) {
    const logPrefix = '[priceCalculation calculateEffectivePrices]';

    // Validate inputs
    if (!poolA || !poolB || priceA_0_per_1_scaled === null || priceA_0_per_1_scaled === undefined ||
        priceB_0_per_1_scaled === null || priceB_0_per_1_scaled === undefined) {
        logger.error(`${logPrefix} Cannot calculate effective prices with null pools or raw prices.`);
        return null;
    }
     // Ensure token decimals match and are valid (basic check, more thorough done in raw price calcs)
     if (poolA.token0?.decimals === undefined || poolA.token1?.decimals === undefined ||
         poolB.token0?.decimals === undefined || poolB.token1?.decimals === undefined ||
         poolA.token0.decimals !== poolB.token0.decimals ||
         poolA.token1.decimals !== poolB.token1.decimals) {
          logger.error(`${logPrefix} Mismatched or invalid token decimals between pools. PoolA: (${poolA.token0?.decimals}/${poolA.token1?.decimals}), PoolB: (${poolB.token0?.decimals}/${poolB.token1?.decimals})`);
          return null;
     }

    // The raw prices (priceA_0_per_1_scaled, priceB_0_per_1_scaled) are now scaled by PRICE_SCALE (1e18).
    // We need the inverse price (T1/T0) also scaled by PRICE_SCALE.
    // Price(T1/T0 standard) = 1 / Price(T0/T1 standard)
    // Scaled Price(T1/T0) = (1 / (Price(T0/T1 standard))) * PRICE_SCALE
    // Scaled Price(T0/T1) = Price(T0/T1 standard) * PRICE_SCALE
    // Price(T0/T1 standard) = Scaled Price(T0/T1) / PRICE_SCALE
    // Scaled Price(T1/T0) = 1 / (Scaled Price(T0/T1) / PRICE_SCALE) * PRICE_SCALE
    // Scaled Price(T1/T0) = (PRICE_SCALE * PRICE_SCALE) / Scaled Price(T0/T1)

    let priceA_1_per_0_scaled = (priceA_0_per_1_scaled > 0n) ? (PRICE_SCALE * PRICE_SCALE) / priceA_0_per_1_scaled : 0n;
    let priceB_1_per_0_scaled = (priceB_0_per_1_scaled > 0n) ? (PRICE_SCALE * PRICE_SCALE) / priceB_0_per_1_scaled : 0n;

     // Ensure inverse prices were calculated and are non-zero
     if (priceA_1_per_0_scaled === 0n || priceB_1_per_0_scaled === 0n) {
         logger.debug(`${logPrefix} Failed to calculate valid inverse price (T1/T0) for one or both pools (result was 0n).`);
         return null; // Cannot calculate effective prices for both directions if inverse is 0
     }


     // Now calculate effective prices considering fees
     // Fee is assumed to be in basis points (e.g., 30 for 0.3%)
     // Price after selling (getting output token): rawPrice * (10000 - feeBps) / 10000
     // Price after buying (spending input token): rawPrice / (10000 - feeBps) / 10000  -- needs careful scaling for division by (1-fee)
     // Price / (1 - fee) = Price * 10000 / (10000 - feeBps)

     const feeA_Bps = BigInt(poolA.fee); // Assuming pool.fee is the BPS value (e.g., 3000 for 0.3%)
     const feeB_Bps = BigInt(poolB.fee); // Need to confirm fee format for all DEX types

     const numeratorFee = TEN_THOUSAND; // 10000n
     const divisorA = TEN_THOUSAND - feeA_Bps;
     const divisorB = TEN_THOUSAND - feeB_Bps;

     if (divisorA <= 0n || divisorB <= 0n) {
         logger.error(`${logPrefix} Invalid fee divisor generated (Pool A Div: ${divisorA}, Pool B Div: ${divisorB}). Fees might be 100% or more?`);
         return null;
     }


    // Effective Price T0/T1 (scaled by PRICE_SCALE)
    // Selling T0 on Pool A (getting T1): priceA_0_per_1_scaled * (1 - feeA)
    effectivePrices.price_A_T0_to_T1_sell_effective = (priceA_0_per_1_scaled * divisorA) / TEN_THOUSAND;
    // Buying T0 on Pool A (spending T1): priceA_0_per_1_scaled / (1 - feeA)
    // Integer arithmetic: (priceA_0_per_1_scaled * numeratorFee) / divisorA
    effectivePrices.price_A_T0_to_T1_buy_effective = (priceA_0_per_1_scaled * numeratorFee) / divisorA;


    // Effective Price T1/T0 (scaled by PRICE_SCALE)
    // Selling T1 on Pool A (getting T0): priceA_1_per_0_scaled * (1 - feeA)
    effectivePrices.price_A_T1_to_T0_sell_effective = (priceA_1_per_0_scaled * divisorA) / TEN_THOUSAND;
    // Buying T1 on Pool A (spending T0): priceA_1_per_0_scaled / (1 - feeA)
    // Integer arithmetic: (priceA_1_per_0_scaled * numeratorFee) / divisorA
    effectivePrices.price_A_T1_to_T0_buy_effective = (priceA_1_per_0_scaled * numeratorFee) / divisorA;

    // Repeat for Pool B
    effectivePrices.price_B_T0_to_T1_sell_effective = (priceB_0_per_1_scaled * divisorB) / TEN_THOUSAND;
    effectivePrices.price_B_T1_to_T0_sell_effective = (priceB_1_per_0_scaled * divisorB) / TEN_THOUSAND;
    effectivePrices.price_B_T0_to_T1_buy_effective = (priceB_0_per_1_scaled * numeratorFee) / divisorB;
    effectivePrices.price_B_T1_to_T0_buy_effective = (priceB_1_per_0_scaled * numeratorFee) / divisorB;


    // Sanity checks (optional but good)
    // Ensure effective prices are positive (except maybe in extreme edge cases, but should be positive for arbitrage)
    for (const key in effectivePrices) {
        if (effectivePrices[key] < 0n) {
             logger.warn(`${logPrefix} Negative effective price calculated for ${key}. Value: ${effectivePrices[key].toString()}`);
             // Negative prices are usually a calculation error or data anomaly.
             // Let's return null if any effective price is calculated as negative, as it's not a valid scenario.
             return null;
        }
        // Ensure prices aren't excessively large or small (relative to each other or known good prices)
        // This could be a more complex check based on historical prices or comparison to centralized feeds.
        // For now, the raw price max diff check in SpatialFinder provides some sanity.
    }


    // --- CHANGED FROM logger.trace TO logger.debug ---
    logger.debug(`${logPrefix} Effective prices calculated successfully.`);
    // --- END CHANGED LOG ---

    return effectivePrices;
}


module.exports = {
    calculateV3PriceT1_T0_scaled, // Export the new function name
    calculateSushiPrice,
    calculateDodoPrice, // Added DODO price calculation
    calculateEffectivePrices,
    // Expose constants if needed by callers, or keep them internal
     PRICE_SCALE,
     PRICE_SCALE_DECIMALS,
     TEN_THOUSAND,
     Q96,
     Q192
};