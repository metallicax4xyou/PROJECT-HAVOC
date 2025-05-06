// utils/priceConverter.js
// Helper functions for converting token amounts to native currency amounts using price data.
// --- VERSION v1.1 --- Corrected import path for PRICE_SCALE and TEN_THOUSAND constants.

const { ethers } = require('ethers');
const logger = require('./logger');
const { ArbitrageError } = require('./errorHandler'); // Using ErrorHandler from utils as it's a utility
// Corrected import path for constants PRICE_SCALE and TEN_THOUSAND
const { PRICE_SCALE, TEN_THOUSAND } = require('./priceUtils'); // Import constants from priceUtils

/**
 * Converts an amount of a token (in smallest units / wei) to the equivalent amount
 * in native currency (in smallest units / wei), based on mock or real price data.
 * This is a MOCK implementation and needs proper implementation using price feeds.
 * @param {bigint} amountWei - The amount of the token in its smallest units (wei).
 * @param {{address: string, symbol: string, decimals: number}} tokenObject - The token object containing details.
 * @param {{TOKENS: object, NATIVE_CURRENCY_SYMBOL: string}} config - Subset of config needed for token details.
 * @param {{symbol: string, decimals: number, address: string}} nativeCurrencyToken - The native currency token object.
 * @returns {Promise<bigint>} The equivalent amount in native currency smallest units (wei).
 * @throws {ArbitrageError} If conversion fails or invalid parameters are provided.
 */
async function convertToNativeWei(amountWei, tokenObject, config, nativeCurrencyToken) {
     // --- MOCK IMPLEMENTATION ---
     const logPrefix = '[PriceConverter Mock]';

     if (!tokenObject?.address || tokenObject.decimals === undefined || tokenObject.decimals === null) {
         const errorMsg = "Invalid token object for native conversion mock.";
         logger.error(`${logPrefix} ${errorMsg}`);
         throw new ArbitrageError("PriceConversionError", errorMsg);
     }
      // Ensure amountWei is explicitly a BigInt for safety before checks/calculations
      const amountWeiBigInt = BigInt(amountWei || 0n);

      if (amountWeiBigInt === 0n) {
           logger.debug(`${logPrefix} Received zero amountWei for ${tokenObject.symbol}, returning 0n.`);
           return 0n; // Handle 0 amount
      }


     // If token is native, return amount directly
     // Check address as well as symbol for robustness
     if (nativeCurrencyToken && (tokenObject.symbol === nativeCurrencyToken.symbol || (nativeCurrencyToken.address && tokenObject.address.toLowerCase() === nativeCurrencyToken.address.toLowerCase()))) {
         logger.debug(`${logPrefix} Token ${tokenObject.symbol} is native, returning amount directly.`);
         return amountWeiBigInt; // Return the BigInt amount
     }

     if (!nativeCurrencyToken) {
         const errorMsg = "Native currency token object is not provided or invalid.";
         logger.error(`${logPrefix} CRITICAL: ${errorMsg}`);
         throw new ArbitrageError("PriceConversionError", errorMsg);
     }


     // For non-native tokens, use a mock price conversion
     // Need price of Token / Native (Scaled 1e18)
     let tokenNativePriceScaled = 0n;
     // MOCKING based on common tokens relative to WETH (assuming WETH is Native if NATIVE_CURRENCY_SYMBOL is ETH/WETH)
     const isNativeWeth = nativeCurrencyToken.symbol === 'WETH' || (nativeCurrencyToken.address && nativeCurrencyToken.address.toLowerCase() === '0x82af49447d8a07e3bd95bd0d56f35241523fbab1'.toLowerCase()); // Added address check
     if (!isNativeWeth) {
          logger.warn(`${logPrefix} Native currency is ${nativeCurrencyToken.symbol} (${nativeCurrencyToken.address}). Mock price conversion assumes WETH/ETH as base and might be inaccurate.`);
     }


     // --- Replace with real price feed logic here later ---
     // IMPORTANT: These mock prices should represent Price(Token Standard / Native Standard)
     // and be scaled by PRICE_SCALE (1e18) for BigInt arithmetic consistency.
     // Example: If Price(USDC Standard / WETH Standard) = 1 / 1850
     // Then tokenNativePriceScaled = PRICE_SCALE / 1850n
     // If Price(WBTC Standard / WETH Standard) = 50
     // Then tokenNativePriceScaled = 50n * PRICE_SCALE

     let mockPriceStandardRatio_Token_Native_Scaled = 0n;

     if (tokenObject.symbol === 'USDC' || tokenObject.symbol === 'USDC.e' || tokenObject.symbol === 'USDT' || tokenObject.symbol === 'DAI' || tokenObject.symbol === 'FRAX') {
         // Mock Price Stablecoin / Native (~WETH) Standard = ~1 / 1850
         // Scaled: PRICE_SCALE / 1850n
         mockPriceStandardRatio_Token_Native_Scaled = PRICE_SCALE / 1850n;
     }
      else if (tokenObject.symbol === 'WBTC') {
           // Mock Price WBTC / Native (~WETH) Standard = ~50
           // Scaled: 50n * PRICE_SCALE
           mockPriceStandardRatio_Token_Native_Scaled = 50n * PRICE_SCALE;
      } else {
           // For other tokens (ARB, LINK, GMX, MAGIC), assume 1:1 with Native for testing
           // Mock Price Token / Native Standard = 1
           // Scaled: 1n * PRICE_SCALE
           mockPriceStandardRatio_Token_Native_Scaled = 1n * PRICE_SCALE;
      }

      if (mockPriceStandardRatio_Token_Native_Scaled <= 0n) { // Use BigInt comparison
           const errorMsg = `Mock scaled price for ${tokenObject.symbol}/${nativeCurrencyToken.symbol} is 0 or negative. Cannot convert.`;
           logger.warn(`${logPrefix} ${errorMsg}`);
           return 0n; // Return 0n on invalid mock price
      }


      const tokenDecimals = BigInt(tokenObject.decimals);
      const nativeDecimals = BigInt(nativeCurrencyToken.decimals);

      // Formula: Amount Native Wei = (Amount Token Wei * Price(Token Standard / Native Standard) * (10^NativeDecimals) / (10^TokenDecimals))
      // Using Scaled Price(Token/Native): Amount Native Wei = (Amount Token Wei * tokenNativePriceScaled / PRICE_SCALE * (10^NativeDecimals) / (10^TokenDecimals))
      // Amount Native Wei = (amountWeiBigInt * mockPriceStandardRatio_Token_Native_Scaled * (10n ** nativeDecimals)) / (PRICE_SCALE * (10n ** tokenDecimals))

      const numerator = amountWeiBigInt * mockPriceStandardRatio_Token_Native_Scaled * (10n ** nativeDecimals);
      const denominator = PRICE_SCALE * (10n ** tokenDecimals);

       if (denominator === 0n) {
            const errorMsg = `Division by zero during conversion math for ${tokenObject.symbol}. Check decimals or PRICE_SCALE.`;
            logger.error(`${logPrefix} CRITICAL: ${errorMsg}`);
            throw new ArbitrageError("PriceConversionError", errorMsg); // Throw
       }

      const amountNativeWei = numerator / denominator;

      logger.debug(`${logPrefix} Converted ${ethers.formatUnits(amountWeiBigInt, tokenObject.decimals)} ${tokenObject.symbol} (raw ${amountWeiBigInt.toString()}) to ${ethers.formatUnits(amountNativeWei, nativeCurrencyToken.decimals)} ${nativeCurrencyToken.symbol} (raw ${amountNativeWei.toString()}) using scaled price ${mockPriceStandardRatio_Token_Native_Scaled.toString()}`); // Added raw amounts to log

      return amountNativeWei;
      // --- END MOCK IMPLEMENTATION ---
}


module.exports = {
    convertToNativeWei
};
