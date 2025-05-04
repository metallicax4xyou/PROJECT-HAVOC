// utils/priceConverter.js
// Helper functions for converting token amounts to native currency amounts using price data.

const { ethers } = require('ethers');
const logger = require('./logger');
const { ArbitrageError } = require('./errorHandler'); // Using ErrorHandler from utils as it's a utility
const { PRICE_SCALE, TEN_THOUSAND } = require('../core/calculation/priceCalculation'); // Import constants

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
      if (amountWei === undefined || amountWei === null) {
           logger.debug(`${logPrefix} Received null/undefined amountWei for ${tokenObject.symbol}, returning 0n.`);
           return 0n; // Handle null/undefined amount
      }
      if (amountWei === 0n) return 0n; // 0 wei of any token is 0 native wei

     // If token is native, return amount directly
     // Check address as well as symbol for robustness
     if (nativeCurrencyToken && (tokenObject.symbol === nativeCurrencyToken.symbol || (nativeCurrencyToken.address && tokenObject.address.toLowerCase() === nativeCurrencyToken.address.toLowerCase()))) {
         logger.debug(`${logPrefix} Token ${tokenObject.symbol} is native, returning amount directly.`);
         return amountWei;
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
     const isNativeWeth = nativeCurrencyToken.symbol === 'WETH' || nativeCurrencyToken.address.toLowerCase() === '0x82af49447d8a07e3bd95bd0d56f35241523fbab1'.toLowerCase();
     if (!isNativeWeth) {
          logger.warn(`${logPrefix} Native currency is ${nativeCurrencyToken.symbol} (${nativeCurrencyToken.address}). Mock price conversion assumes WETH/ETH as base and might be inaccurate.`);
     }


     // --- Replace with real price feed logic here later ---
     if (tokenObject.symbol === 'USDC' || tokenObject.symbol === 'USDC.e' || tokenObject.symbol === 'USDT' || tokenObject.symbol === 'DAI' || tokenObject.symbol === 'FRAX') {
         // Assume stablecoin price relative to Native (~WETH/ETH) is ~1/1850 (using 1850 as ETH/Stablecoin price)
         // Price Stablecoin / Native Standard = Price Stablecoin / Native Standard * (10^NativeDecimals / 10^StablecoinDecimals)
         // Mock Price: Assume 1 Standard Stablecoin = 1/1850 Standard Native (Scaled 1e18)
          // Need to scale this price correctly based on *decimals* difference.
          // Price of Token (in Native Standard Units) = Amount Token (in Token Standard Units) * Price (Token Standard / Native Standard)
          // We have Amount Token Wei. Need Amount Token Standard.
          // Amount Token Standard = amountWei / (10^TokenDecimals)
          // Price (Token Standard / Native Standard) = Mock ratio (e.g. 1/1850 for stable)
          // Amount Native Standard = (amountWei / (10^TokenDecimals)) * MockRatio
          // Amount Native Wei = Amount Native Standard * (10^NativeDecimals)
          // Amount Native Wei = (amountWei / (10^TokenDecimals)) * MockRatio * (10^NativeDecimals)
          // Amount Native Wei = (amountWei * MockRatio * (10^NativeDecimals)) / (10^TokenDecimals)

          // Let's use Mock Ratio directly for now, assuming it's the price of 1 Token Standard in Native Standard.
          // Mock ratio for Stablecoin/Native is 1/1850
          const mockRatioStandard = 1n; // Representing 1 stablecoin
          const mockRatioDenominatorStandard = 1850n; // Representing 1850 native units

          // Amount Native Wei = amountWei * (Mock Ratio Standard / Mock Ratio Denom Standard) * (10^NativeDecimals / 10^TokenDecimals)
          // Amount Native Wei = amountWei * (1 * (10^NativeDecimals)) / (1850 * (10^TokenDecimals))
          // This still feels off. Let's simplify the mock based on the original scaled price approach.
          // Original: amountNativeWei = (amountWei * PRICE_SCALE * (10^NativeDecimals)) / (tokenNativePriceScaled * (10^TokenDecimals))
          // Where tokenNativePriceScaled is PRICE_SCALE * (Price of 1 Token Standard in Native Standard)
          // For stablecoin/Native (1/1850): Price of 1 Token Standard in Native Standard is 1/1850.
          // tokenNativePriceScaled = PRICE_SCALE * (1n/1850n) = PRICE_SCALE / 1850n. This matches the original mock.
          tokenNativePriceScaled = PRICE_SCALE / 1850n;

      } else if (tokenObject.symbol === 'WBTC') {
           // Price of 1 Standard WBTC in Native Standard (~WETH) is ~50.
           tokenNativePriceScaled = 50n * PRICE_SCALE;

      } else {
           // For other tokens (ARB, LINK, GMX, MAGIC), let's just assume 1:1 with Native for testing
           // Price of 1 Standard Token in Native Standard is 1.
           tokenNativePriceScaled = PRICE_SCALE;
      }

      if (tokenNativePriceScaled === 0n) {
           const errorMsg = `Mock price for ${tokenObject.symbol}/${nativeCurrencyToken.symbol} is 0. Cannot convert.`;
           logger.warn(`${logPrefix} ${errorMsg}`);
           // Return 0n rather than throwing, allows the loop to continue processing other opportunities
           return 0n;
           // If you prefer strictness and fail the *entire* batch on any price issue, throw here instead.
           // throw new ArbitrageError("PriceConversionError", errorMsg);
      }

      const tokenDecimals = BigInt(tokenObject.decimals);
      const nativeDecimals = BigInt(nativeCurrencyToken.decimals);

      // Amount Native Wei = (Amount Token Wei * PRICE_SCALE * (10^NativeDecimals)) / (tokenNativePriceScaled * (10^TokenDecimals))
      // Note: PRICE_SCALE is 1e18. tokenNativePriceScaled is scaled by 1e18 too.
      // So the formula simplifies if tokenNativePriceScaled is truly Price(Token/Native) * 1e18
      // Then Price(Native/Token) = 1 / Price(Token/Native)
      // Amount Native Wei = Amount Token Wei * Price(Native/Token Standard) * (10^NativeDecimals / 10^TokenDecimals)
      // Amount Native Wei = Amount Token Wei * (PRICE_SCALE / tokenNativePriceScaled) * (10^NativeDecimals / 10^TokenDecimals)
      // This matches the original calculation.

      const numerator = amountWei * PRICE_SCALE * (10n ** nativeDecimals);
      const denominator = tokenNativePriceScaled * (10n ** tokenDecimals);

      if (denominator === 0n) {
           const errorMsg = `Division by zero during conversion for ${tokenObject.symbol}. Check mock price or decimals.`;
           logger.error(`${logPrefix} CRITICAL: ${errorMsg}`);
           throw new ArbitrageError("PriceConversionError", errorMsg); // Throwing here seems appropriate for a mathematical error
      }

      const amountNativeWei = numerator / denominator;
      // logger.debug(`${logPrefix} Converted ${amountWei.toString()} ${tokenObject.symbol} wei (Decimals: ${tokenObject.decimals}) to ${amountNativeWei.toString()} ${nativeCurrencyToken.symbol} wei (Decimals: ${nativeCurrencyToken.decimals}) using scaled price ${tokenNativePriceScaled.toString()}`); // Too verbose

      return amountNativeWei;
      // --- END MOCK IMPLEMENTATION ---
}


module.exports = {
    convertToNativeWei
};
