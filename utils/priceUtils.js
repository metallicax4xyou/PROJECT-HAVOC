// utils/priceUtils.js
// Provides utility functions for calculating raw spot prices from different pool types
// and defines shared price-related constants.
// --- VERSION v2.1 --- Fixed SyntaxError in ethers import.

// Needed for BigInt/parsing in some contexts (though mostly just BigInt used)
// CORRECTED SYNTAX: Use '=' for destructuring assignment
const { ethers } = require('ethers');

const logger = require('./logger'); // Assuming logger is correctly imported
const { ArbitrageError, handleError } = require('./errorHandler'); // Assuming errorHandler is in utils
const { TOKENS } = require('../constants/tokens'); // Assuming TOKENS is needed here

// --- Shared Constants for Price Calculations ---
// Use 18 decimals as the standard scale for consistency, like ETH/WETH for price representation
const PRICE_SCALE_DECIMALS = 18;
const PRICE_SCALE = 10n ** BigInt(PRICE_SCALE_DECIMALS); // 10^18
const TEN_THOUSAND = 10000n; // Constant for basis points calculation (100.00%)
const Q96 = 2n ** 96n; // Constant used in Uniswap V3 math (2^96)
const Q192 = Q96 * Q96; // Constant used in Uniswap V3 math (2^192 = (2^96)^2)
// --- End Constants ---


/**
 * Calculates the price for a Uniswap V3 pool state (token0/token1).
 * Returns price of token0 in terms of token1 (T0/T1) scaled by PRICE_SCALE (1e18).
 * Returns null if calculation fails or inputs invalid.
 * Formula: Scaled Price T0/T1 (1e18) = (Q192 * (10n ** decimals1) * PRICE_SCALE) / (sqrtPriceX96 * sqrtPriceX96 * (10n ** decimals0))
 */
function calculateV3PriceT0_T1_scaled(poolState) {
    const logPrefix = '[priceUtils calculateV3PriceT0_T1_scaled]';
    if (!poolState || poolState.sqrtPriceX96 === undefined || poolState.sqrtPriceX96 === null || BigInt(poolState.sqrtPriceX96) === 0n) {
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

        const scale0 = 10n ** decimals0;
        const scale1 = 10n ** decimals1;

        // Denominator: (sqrtPriceX96)^2 * 10^decimals0
        const denominator = sqrtPriceX96 * sqrtPriceX96 * scale0;

        if (denominator === 0n) {
             logger.error(`${logPrefix} Division by zero avoided: calculated denominator is zero. Pool: ${poolState.address}`);
             return null; // Should not happen with valid decimals and non-zero sqrtPriceX96
        }

        // Numerator: Q192 * 10^decimals1 * PRICE_SCALE
        const numerator = Q192 * scale1 * PRICE_SCALE;

        const adjustedPriceT0_T1_scaled = numerator / denominator;

        logger.debug(`${logPrefix} V3 Pool ${poolState.address.substring(0,6)} | Price (T0/T1 scaled, 1e${PRICE_SCALE_DECIMALS}): ${adjustedPriceT0_T1_scaled}`);

        return adjustedPriceT0_T1_scaled; // Return the calculated price T0/T1 scaled by 1e18
    } catch (error) {
        logger.error(`${logPrefix} Error calculating V3 price for ${poolState.address}: ${error.message}`, error);
        handleError(error, `V3PriceCalc ${poolState.address}`);
        return null; // Return null on calculation error
    }
}


/**
 * Calculates the price for a SushiSwap or Uniswap V2 style pool state (token0/token1).
 * Returns price of token0 in terms of token1 (T0/T1) scaled by PRICE_SCALE (1e18).
 * Returns null if calculation fails or inputs invalid/reserves zero.
 * Formula: Scaled Price T0/T1 (1e18) = (reserve1 * (10n ** decimals0) * PRICE_SCALE) / (reserve0 * (10n ** decimals1))
 */
function calculateV2PriceT0_T1_scaled(poolState) { // Renamed for consistency
    const logPrefix = '[priceUtils calculateV2PriceT0_T1_scaled]'; // Updated log prefix
     // Check for null/undefined reserves and also check if reserve0 is zero before accessing value
    if (!poolState || poolState.reserve0 === undefined || poolState.reserve0 === null || BigInt(poolState.reserve0) === 0n ||
        poolState.reserve1 === undefined || poolState.reserve1 === null) {
        logger.warn(`${logPrefix} Invalid V2 state for price calc: Missing or zero reserve0. Pool: ${poolState?.address}`);
        return null;
    }
    // Ensure token decimals are valid numbers before converting to BigInt
    if (poolState.token0?.decimals === undefined || poolState.token0?.decimals === null ||
        poolState.token1?.decimals === undefined || poolState.token1?.decimals === null ||
        typeof poolState.token0.decimals !== 'number' || typeof poolState.token1.decimals !== 'number' ||
        BigInt(poolState.token0.decimals) < 0n || BigInt(poolState.token1.decimals) < 0n) { // Check decimals are non-negative
        logger.error(`${logPrefix} Invalid V2 state for price calc: Missing or invalid token decimals (${poolState.token0?.decimals}, ${poolState.token1?.decimals}). Pool: ${poolState?.address}`);
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

        // Correct calculation for Price T0/T1 scaled by PRICE_SCALE (1e18):
        // (reserve1 * scale0 * PRICE_SCALE) / denominator
         const numeratorScaled = reserve1 * scale0 * PRICE_SCALE;

        const adjustedPriceScaled = numeratorScaled / denominator;

        logger.debug(`${logPrefix} V2 Pool ${poolState.address.substring(0,6)} | Adjusted Price (T0/T1 scaled, 1e${PRICE_SCALE_DECIMALS}): ${adjustedPriceScaled}`);

        return adjustedPriceScaled;
    } catch (error) {
        logger.error(`${logPrefix} Error calculating V2 price for ${poolState.address}: ${error.message}`);
        handleError(error, `V2PriceCalc ${poolState.address}`);
        return null; // Return null on calculation error
    }
}

/**
 * Calculates the price for a DODO pool state (Base/Quote).
 * Returns price of token0 in terms of token1 (T0/T1) scaled by PRICE_SCALE (1e18).
 * Returns null if calculation fails or inputs invalid.
 *
 * DODO fetcher provides queryAmountOutWei: amount of quote token (in smallest units) received when selling a standard amount (1 * 10^decimalsBase) of base token (in smallest units).
 *
 * Price (Base/Quote in standard units) = queryAmountOutWei / (10n ** decimalsQuote) for 1 standard unit of Base.
 *
 * Scaled Price (Base/Quote, 1e18) = Price (Base/Quote in standard units) * PRICE_SCALE
 * Integer arithmetic: (queryAmountOutWei * PRICE_SCALE) / (10n ** decimalsQuote)
 *
 * We need Price T0/T1 scaled by PRICE_SCALE.
 * Determine if T0 is Base and T1 is Quote (Price T0/T1 = Price Base/Quote) or vice versa (Price T0/T1 = Price Quote/Base = 1 / Price Base/Quote)
 */
function calculateDodoPriceT0_T1_scaled(poolState) { // Renamed for consistency
     const logPrefix = '[priceUtils calculateDodoPriceT0_T1_scaled]'; // Updated log prefix
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

        logger.debug(`${logPrefix} DODO Pool ${poolState.address.substring(0,6)} | Adjusted Price (T0/T1 scaled, 1e${PRICE_SCALE_DECIMALS}): ${adjustedPriceScaled}`);

        return adjustedPriceScaled; // Return the calculated price T0/T1 scaled by 1e18

    } catch (error) {
        logger.error(`${logPrefix} Error calculating DODO price for ${poolState.address}: ${error.message}`, error);
        handleError(error, `DodoPriceCalc ${poolState.address}`);
        return null; // Return null on calculation error
    }
}

// Export the consolidated raw price calculation functions and constants
module.exports = {
    calculateV3PriceT0_T1_scaled,
    calculateV2PriceT0_T1_scaled, // Use the renamed function
    calculateDodoPriceT0_T1_scaled, // Use the renamed function

    // Export constants
     PRICE_SCALE,
     PRICE_SCALE_DECIMALS,
     TEN_THOUSAND,
     Q96,
     Q192
};
