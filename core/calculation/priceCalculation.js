// core/calculation/priceCalculation.js
// Utility functions for calculating raw and effective prices for arbitrage finders.
// --- VERSION v1.6 --- Corrected export name for calculateV3PriceT0_T1_scaled.

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
 * Calculates the price for a Uniswap V3 pool state (token0/token1).
 * Returns price of token0 in terms of token1 (T0/T1) scaled by PRICE_SCALE (1e18).
 * Returns null on error.
 * Formula for Price T0/T1 Standard = ((sqrtPriceX96 / 2**96)^2) * (10^decimals1 / 10^decimals0)
 *
 * Let's use the relationship between sqrtPriceX96 and price:
 * sqrt(price T1/T0 in underlying) = sqrtPriceX96 / 2^96
 * price T1/T0 in underlying = (sqrtPriceX96 / 2^96)^2 = (sqrtPriceX96 * sqrtPriceX96) / Q192
 * Price T1/T0 Standard = price T1/T0 in underlying * (10^decimals0 / 10^decimals1)
 *
 * We need Price T0/T1 Standard = 1 / Price T1/T0 Standard
 * Price T0/T1 Standard = 1 / ((sqrtPriceX96 * sqrtPriceX96 * 10^decimals0) / (Q192 * 10^decimals1))
 * Price T0/T1 Standard = (Q192 * 10^decimals1) / (sqrtPriceX96 * sqrtPriceX96 * 10^decimals0)
 *
 * Scaled Price T0/T1 (1e18) = Price T0/T1 Standard * PRICE_SCALE
 * = ((Q192 * 10^decimals1) / (sqrtPriceX96 * sqrtPriceX96 * 10^decimals0)) * PRICE_SCALE
 * Integer arithmetic: (Q192 * (10n ** decimals1) * PRICE_SCALE) / (sqrtPriceX96 * sqrtPriceX96 * (10n ** decimals0))
 *
 * Let's use the direct formula for T0/T1 standard, scaled by PRICE_SCALE, ensuring BigInt precision:
 * Price T0/T1 Standard = (sqrtPriceX96 / Q96)^2 * (10^decimals1 / 10^decimals0)
 * Scaled Price T0/T1 (1e18) = Price T0/T1 Standard * PRICE_SCALE
 * = (sqrtPriceX96 * sqrtPriceX96 * 10^decimals1 * PRICE_SCALE) / (Q192 * 10^decimals0)
 */
function calculateV3PriceT0_T1_scaled(poolState) { // Renamed function
    const logPrefix = '[priceCalculation calculateV3PriceT0_T1_scaled]'; // Updated log prefix
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
        const denominator = Q192 * scale0; // Denominator for T0/T1 calculation
        if (denominator === 0n) {
             logger.error(`${logPrefix} Division by zero avoided: calculated denominator is zero. Pool: ${poolState.address}`);
             return null; // Should not happen with valid decimals
        }

        // Correct calculation for Price T0/T1 scaled by PRICE_SCALE:
        // (sqrtPriceX96 * sqrtPriceX96 * scale1 * PRICE_SCALE) / (Q192 * scale0)
        const numerator = sqrtPriceX96 * sqrtPriceX96; // Intermediate: price scaled by Q192
        const numeratorScaled = numerator * scale1 * PRICE_SCALE; // Intermediate: scaled correctly for final division

        const adjustedPriceT0_T1_scaled = numeratorScaled / denominator; // Final integer division

        // --- CHANGED FROM logger.trace TO logger.debug ---
        logger.debug(`${logPrefix} V3 Pool ${poolState.address.substring(0,6)} | Price (T0/T1 scaled, 1e${PRICE_SCALE_DECIMALS}): ${adjustedPriceT0_T1_scaled}`);
        // --- END CHANGED LOG ---

        return adjustedPriceT0_T1_scaled; // Return the calculated price T0/T1 scaled by 1e18
    } catch (error) {
        // Catch and log any errors during the BigInt calculations
        logger.error(`${logPrefix} Error calculating V3 price for ${poolState.address}: ${error.message}`, error);
        handleError(error, `V3PriceCalc ${poolState.address}`);
        return null; // Return null on calculation error
    }
}


/**
 * Calculates the price for a SushiSwap pool state (token0/token1).
 * Returns price of token0 in terms of token1 (T0/T1) scaled by PRICE_SCALE (1e18).
 * Returns null on error.
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
        const reserve0 = BigInt(poolState.reserve0); // Amount of token0 in reserves (smallest units)
        const reserve1 = BigInt(poolState.reserve1); // Amount of token1 in reserves (smallest units)
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
        logger.debug(`${logPrefix} Sushi Pool ${poolState.address.substring(0,6)} | Adjusted Price (T0/T1 scaled, 1e${PRICE_SCALE_DECIMALS}): ${adjustedPriceScaled}`);
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
 * Returns price of token0 in terms of token1 (T0/T1) scaled by PRICE_SCALE (1e18).
 * Returns null on error.
 *
 * DODO fetcher provides queryAmountOutWei: amount of quote token (in smallest units) received when selling a standard amount (1 * 10^decimalsBase) of base token (in smallest units).
 *
 * Price (Base/Quote in standard units) = (queryAmountOutWei / 10^decimalsQuote) for 1 standard unit of Base.
 *
 * Scaled Price (Base/Quote, 1e18) = Price (Base/Quote in standard units) * PRICE_SCALE
 * Integer arithmetic: (queryAmountOutWei * PRICE_SCALE) / (10n ** decimalsQuote)
 *
 * We need Price T0/T1 scaled by PRICE_SCALE.
 * Determine if T0 is Base and T1 is Quote (Price T0/T1 = Price Base/Quote) or vice versa (Price T0/T1 = Price Quote/Base = 1 / Price Base/Quote)
 */
function calculateDodoPrice(poolState) {
     const logPrefix = '[priceCalculation calculateDodoPrice]';
    // Check for essential data from the fetcher's query
    if (!poolState || poolState.queryAmountOutWei === undefined || poolState.queryAmountOutWei === null ||
         !poolState.queryBaseToken?.address || !poolState.queryQuoteToken?.address ||
         poolState.queryBaseToken?.decimals === undefined || poolState.queryBaseToken?.decimals === null ||
         poolState.queryQuoteToken?.decimals === undefined || poolState.queryQuoteToken?.decimals === null ||
         poolState.token0?.decimals === undefined || poolState.token0?.decimals === null || // Need T0/T1 decimals for mapping
         poolState.token1?.decimals === undefined || poolState.token1?.decimals === null ||
          typeof poolState.queryBaseToken.decimals !== 'number' || typeof poolState.queryQuoteToken.decimals !== 'number' ||
          typeof poolState.token0.decimals !== 'number' || typeof poolState.token1.decimals !== 'number' ||
          BigInt(poolState.queryBaseToken.decimals) < 0n || BigInt(poolState.queryQuoteToken.decimals) < 0n ||
          BigInt(poolState.token0.decimals) < 0n || BigInt(poolState.token1.decimals) < 0n // Check decimals are non-negative
         ) {
        logger.warn(`${logPrefix} Invalid DODO state for price calc: Missing query results or invalid token decimals. Pool: ${poolState?.address}`);
        return null;
    }

    const queryAmountOutWei = BigInt(poolState.queryAmountOutWei); // Amount of Quote received (smallest units)
    const baseToken = poolState.queryBaseToken; // Base Token object
    const quoteToken = poolState.queryQuoteToken; // Quote Token object
    const decimalsQuote = BigInt(quoteToken.decimals);

     // Calculate scale factor for Quote token
     const scaleQuote = 10n ** decimalsQuote;

     // Check for division by zero if queryAmountOutWei is zero, which would happen if price is infinite or liquidity zero
     if (queryAmountOutWei === 0n) {
         logger.debug(`${logPrefix} queryAmountOutWei is zero for DODO pool ${poolState.address}. Cannot calculate price.`);
         return null;
     }

    try {
         const [token0, token1] = [poolState.token0, poolState.token1]; // Get T0/T1 from poolState

         let adjustedPriceScaled;
         if (token0.address.toLowerCase() === baseToken.address.toLowerCase() &&
             token1.address.toLowerCase() === quoteToken.address.toLowerCase()) {
             // Case 1: T0 is Base, T1 is Quote. We need Price(Base/Quote) scaled by PRICE_SCALE.
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
        logger.debug(`${logPrefix} DODO Pool ${poolState.address.substring(0,6)} | Adjusted Price (T0/T1 scaled, 1e${PRICE_SCALE_DECIMALS}): ${adjustedPriceScaled}`);
        // --- END CHANGED LOG ---

        return adjustedPriceScaled; // Return the calculated price T0/T1 scaled by 1e18

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
         typeof poolA.token0.decimals !== 'number' || typeof poolA.token1.decimals !== 'number' ||
         typeof poolB.token0.decimals !== 'number' || typeof poolB.token1.decimals !== 'number' ||
         BigInt(poolA.token0.decimals) < 0n || BigInt(poolA.token1.decimals) < 0n ||
         BigInt(poolB.token0.decimals) < 0n || BigInt(poolB.token1.decimals) < 0n ||
         poolA.token0.decimals !== poolB.token0.decimals ||
         poolA.token1.decimals !== poolB.token1.decimals) {
          logger.error(`${logPrefix} Mismatched or invalid token decimals between pools. PoolA: (${poolA.token0?.decimals}/${poolA.token1?.decimals}), PoolB: (${poolB.token0?.decimals}/${poolB.token1?.decimals})`);
          return null;
     }

    // The raw prices (priceA_0_per_1_scaled, priceB_0_per_1_scaled) are now scaled by PRICE_SCALE (1e18).
    // We need the inverse price (T1/T0) also scaled by PRICE_SCALE.
    // Scaled Price(T1/T0, 1e18) = (PRICE_SCALE * PRICE_SCALE) / Scaled Price(T0/T1, 1e18)

    let priceA_1_per_0_scaled = (priceA_0_per_1_scaled > 0n) ? (PRICE_SCALE * PRICE_SCALE) / priceA_0_per_1_scaled : 0n;
    let priceB_1_per_0_scaled = (priceB_0_per_1_scaled > 0n) ? (PRICE_SCALE * PRICE_SCALE) / priceB_0_per_1_scaled : 0n;

     // Ensure inverse prices were calculated and are non-zero
     if (priceA_1_per_0_scaled === 0n || priceB_1_per_0_scaled === 0n) {
         logger.debug(`${logPrefix} Failed to calculate valid inverse price (T1/T0) for one or both pools (result was 0n).`);
         return null; // Cannot calculate effective prices for both directions if inverse is 0
     }


     // Now calculate effective prices considering fees
     // Fee is assumed to be in basis points (e.g., 3000 for 0.3% in V3, or 30 for 0.3% in V2/DODO)
     // Need to ensure fee is BigInt and scaled consistently (e.g., all as BPS 0-10000)
     // The fee in pool state might be different units depending on fetcher (e.g., UniV3 fee is uint24, need to convert to BPS)
     // Assuming pool.fee is already in BPS (0-10000 range)
     const feeA_Bps = BigInt(poolA.fee);
     const feeB_Bps = BigInt(poolB.fee);


     const numeratorFee = TEN_THOUSAND; // 10000n
     const divisorA = TEN_THOUSAND - feeA_Bps;
     const divisorB = TEN_THOUSAND - feeB_Bps;

     if (divisorA <= 0n || divisorB <= 0n) {
         logger.error(`${logPrefix} Invalid fee divisor generated (Pool A Div: ${divisorA}, Pool B Div: ${divisorB}). Fees might be 100% or more?`);
         return null;
     }


    // Effective Price T0/T1 (scaled by PRICE_SCALE)
    // Selling T0 on Pool A (getting T1): rawPrice * (1 - feeA) = rawPrice * divisorA / 10000
    effectivePrices.price_A_T0_to_T1_sell_effective = (priceA_0_per_1_scaled * divisorA) / TEN_THOUSAND;
    // Buying T0 on Pool A (spending T1): rawPrice / (1 - feeA) = rawPrice * 10000 / divisorA
    effectivePrices.price_A_T0_to_T1_buy_effective = (priceA_0_per_1_scaled * numeratorFee) / divisorA;


    // Effective Price T1/T0 (scaled by PRICE_SCALE)
    // Selling T1 on Pool A (getting T0): rawPrice * (1 - feeA) = rawPrice * divisorA / 10000
    effectivePrices.price_A_T1_to_T0_sell_effective = (priceA_1_per_0_scaled * divisorA) / TEN_THOUSAND;
    // Buying T1 on Pool A (spending T0): rawPrice / (1 - feeA) = rawPrice * 10000 / divisorA
    effectivePrices.price_A_T1_to_T0_buy_effective = (priceA_1_per_0_scaled * numeratorFee) / divisorA;

    // Repeat for Pool B
    effectivePrices.price_B_T0_to_T1_sell_effective = (priceB_0_per_1_scaled * divisorB) / TEN_THOUSAND;
    effectivePrices.price_B_T1_to_T0_sell_effective = (priceB_1_per_0_scaled * divisorB) / TEN_THOUSAND;
    effectivePrices.price_B_T0_to_T1_buy_effective = (priceB_0_per_1_scaled * numeratorFee) / divisorB;
    effectivePrices.price_B_T1_to_T0_buy_effective = (priceB_1_per_0_scaled * numeratorFee) / divisorB;


    // Sanity checks (optional but good)
    // Ensure effective prices are positive
    for (const key in effectivePrices) {
        if (effectivePrices[key] < 0n) {
             logger.warn(`${logPrefix} Negative effective price calculated for ${key}. Value: ${effectivePrices[key].toString()}`);
             return null; // Invalid scenario
        }
    }

    logger.debug(`${logPrefix} Effective prices calculated successfully.`);

    return effectivePrices;
}


module.exports = {
    calculateV3PriceT0_T1_scaled, // Export the corrected function name
    calculateSushiPrice,
    calculateDodoPrice,
    calculateEffectivePrices,
    // Expose constants if needed by callers, or keep them internal
     PRICE_SCALE,
     PRICE_SCALE_DECIMALS,
     TEN_THOUSAND,
     Q96,
     Q192
};