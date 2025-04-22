// utils/priceUtils.js
const { ethers } = require('ethers');
const logger = require('./logger'); // Assuming logger is in utils

// Constants using native bigint for better compatibility
const BIGNUMBER_1E18 = 10n**18n; // Represents 1.0 with 18 decimals

/**
 * Calculates the price of token0 in terms of token1 for a Uniswap V3 pool.
 * Uses BigInt for precision.
 * @param {bigint} sqrtPriceX96 The sqrtPriceX96 value from the pool's slot0.
 * @param {object} token0 Token object for token0 (needs decimals).
 * @param {object} token1 Token object for token1 (needs decimals).
 * @returns {bigint|null} The price of token0 in terms of token1, scaled by 1e18, or null if inputs invalid.
 */
function getUniV3Price(sqrtPriceX96, token0, token1) {
    if (!sqrtPriceX96 || !token0?.decimals || !token1?.decimals) {
        logger.warn('[getUniV3Price] Invalid arguments received.');
        return null;
    }
    try {
        const Q96 = 2n**96n;
        const Q192 = 2n**192n;
        const sqrtP = BigInt(sqrtPriceX96);
        const priceX192 = sqrtP * sqrtP; // price * 2^192

        // Calculate price of token0 in terms of token1
        // price = (sqrtP^2 / 2^192) * (10^(dec0 - dec1))
        // To maintain precision with BigInt:
        // priceScaled = (priceX192 * (10^dec0) * (10^18)) / (2^192 * (10^dec1))
        // priceScaled = (priceX192 * (10^(dec0 + 18))) / (Q192 * (10^dec1))

        const scaleFactor0 = 10n ** BigInt(token0.decimals);
        const scaleFactor1 = 10n ** BigInt(token1.decimals);

        // Calculate raw price ratio (token1/token0) scaled by 2^192
        // price1/0 = priceX192 / Q192
        // To get price0/1 = Q192 / priceX192 (potential precision loss here)
        // Alternative: Price of token1 in terms of token0 = priceX192 * 10^(dec1-dec0) / Q192
        // Price of token0 in terms of token1 = Q192 * 10^(dec0-dec1) / priceX192

        // Let's calculate price of token1 in terms of token0 first, scaled by 1e18
        const numerator1_0 = (priceX192 * scaleFactor1 * BIGNUMBER_1E18);
        const denominator1_0 = (Q192 * scaleFactor0);
        const price1_0_scaled = numerator1_0 / denominator1_0;

        // Now invert to get price of token0 in terms of token1, scaled by 1e18
        // P0/1 = 1 / P1/0
        // P0/1_scaled = (1 * 10^18) / P1/0_scaled = (10^18 * 10^18) / price1_0_scaled
        if (price1_0_scaled === 0n) return 0n; // Avoid division by zero
        const price0_1_scaled = (BIGNUMBER_1E18 * BIGNUMBER_1E18) / price1_0_scaled;

        return price0_1_scaled;

    } catch (error) {
        logger.error(`[getUniV3Price] Error calculating price: ${error.message}`);
        return null;
    }
}

/**
 * Calculates the price of token0 in terms of token1 for a Uniswap V2 style pool.
 * Uses BigInt for precision.
 * @param {bigint} reserve0 Reserve of token0.
 * @param {bigint} reserve1 Reserve of token1.
 * @param {object} token0 Token object for token0 (needs decimals).
 * @param {object} token1 Token object for token1 (needs decimals).
 * @returns {bigint|null} The price of token0 in terms of token1, scaled by 1e18, or null if inputs invalid/reserves zero.
 */
function getV2Price(reserve0, reserve1, token0, token1) {
    if (reserve0 === 0n || !reserve0 || !reserve1 || !token0?.decimals || !token1?.decimals) {
         // logger.debug('[getV2Price] Invalid arguments or zero reserves.'); // Too noisy maybe
        return null; // Cannot calculate price if a reserve is zero
    }
    try {
        const res0 = BigInt(reserve0);
        const res1 = BigInt(reserve1);

        // Price of token0 = reserve1 / reserve0 (adjusted for decimals)
        // price = (reserve1 / 10^dec1) / (reserve0 / 10^dec0)
        // price = (reserve1 * 10^dec0) / (reserve0 * 10^dec1)
        // Scaled Price = price * 10^18 = (reserve1 * 10^dec0 * 10^18) / (reserve0 * 10^dec1)

        const scaleFactor0 = 10n ** BigInt(token0.decimals);
        const scaleFactor1 = 10n ** BigInt(token1.decimals);

        const numerator = (res1 * scaleFactor0 * BIGNUMBER_1E18);
        const denominator = (res0 * scaleFactor1);

        if (denominator === 0n) return 0n; // Avoid division by zero
        return numerator / denominator;

    } catch (error) {
        logger.error(`[getV2Price] Error calculating price: ${error.message}`);
        return null;
    }
}

/**
 * Calculates the price of the base token in terms of the quote token for a DODO pool result.
 * Uses BigInt for precision.
 * @param {bigint} queryAmountOutWei The amount of quote token received for 1 unit of base token (in quoteToken wei).
 * @param {object} baseToken Token object for the base token sold (needs decimals).
 * @param {object} quoteToken Token object for the quote token received (needs decimals).
 * @returns {bigint|null} The price of base token in terms of quote token, scaled by 1e18, or null if inputs invalid.
 */
function getDodoPrice(queryAmountOutWei, baseToken, quoteToken) {
     if (queryAmountOutWei === undefined || queryAmountOutWei === null || !baseToken?.decimals || !quoteToken?.decimals) {
        logger.warn('[getDodoPrice] Invalid arguments received.');
        return null;
    }
     try {
         const amountOut = BigInt(queryAmountOutWei);
         // price = AmountOutQuote / AmountInBase
         // price = (amountOut / 10^quoteDec) / (1 / 1) = amountOut / 10^quoteDec
         // Scaled Price = price * 10^18 = (amountOut * 10^18) / 10^quoteDec

         const scaleFactorQuote = 10n ** BigInt(quoteToken.decimals);

         const numerator = (amountOut * BIGNUMBER_1E18);
         const denominator = scaleFactorQuote; // Amount in base was 1 unit (unscaled)

          if (denominator === 0n) return 0n;
         return numerator / denominator;

     } catch (error) {
        logger.error(`[getDodoPrice] Error calculating price: ${error.message}`);
        return null;
     }
}

module.exports = {
    getUniV3Price,
    getV2Price,
    getDodoPrice,
    BIGNUMBER_1E18 // Export scale factor for potential use elsewhere
};
