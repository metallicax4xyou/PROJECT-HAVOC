// core/calculation/priceCalculation.js
// Utility functions for calculating raw and effective prices for arbitrage finders.

const logger = require('../../utils/logger'); // Assuming logger is accessible via relative path
const { handleError, ArbitrageError } = require('../../utils/errorHandler'); // Adjust path as needed

// Constants needed for calculations (can be passed in or defined here if static)
const BIGNUM_SCALE_DECIMALS = 36; // TODO: Consider passing scale/decimals as args if they vary
const BIGNUM_SCALE = 10n ** BigInt(BIGNUM_SCALE_DECIMALS);
const TEN_THOUSAND = 10000n;

/**
 * Calculates the price for a Uniswap V3 pool state (token1/token0).
 * Returns price scaled by BIGNUM_SCALE. Returns null on error.
 */
function calculateV3Price(poolState) {
    const logPrefix = '[priceCalculation calculateV3Price]';
    if (!poolState || !poolState.sqrtPriceX96 || poolState.sqrtPriceX96 === '0' || poolState.sqrtPriceX96 === 0n) {
        logger.warn(`${logPrefix} Invalid V3 state for price calc: Missing sqrtPriceX96. Pool: ${poolState?.address}`);
        return null;
    }
    if (!poolState.token0?.decimals || !poolState.token1?.decimals) {
        logger.warn(`${logPrefix} Invalid V3 state for price calc: Missing token decimals. Pool: ${poolState?.address}`);
        return null;
    }
    try {
        const sqrtPriceX96 = BigInt(poolState.sqrtPriceX96);
        const Q96 = 2n ** 96n;
        const priceX192_scaled = (sqrtPriceX96 * sqrtPriceX96 * BIGNUM_SCALE);
        const Q192 = Q96 * Q96;
        if (Q192 === 0n) throw new Error("Q192 is zero"); // Should not happen
        let rawPrice = priceX192_scaled / Q192;

        const decimals0 = BigInt(poolState.token0.decimals);
        const decimals1 = BigInt(poolState.token1.decimals);
        const decimalFactor = 10n ** (decimals0 - decimals1 + BigInt(BIGNUM_SCALE_DECIMALS));

        if (BIGNUM_SCALE === 0n) throw new Error("BIGNUM_SCALE is zero"); // Should not happen
        const adjustedPriceScaled = (rawPrice * decimalFactor) / BIGNUM_SCALE;

        logger.trace(`${logPrefix} V3 Pool ${poolState.address.substring(0,6)} | Adjusted Price (scaled): ${adjustedPriceScaled}`);
        return adjustedPriceScaled;
    } catch (error) {
        logger.error(`${logPrefix} Error calculating V3 price for ${poolState.address}: ${error.message}`);
        handleError(error, `V3PriceCalc ${poolState.address}`);
        return null;
    }
}

/**
 * Calculates the price for a SushiSwap pool state (token1/token0).
 * Returns price scaled by BIGNUM_SCALE. Returns null on error.
 */
function calculateSushiPrice(poolState) {
    const logPrefix = '[priceCalculation calculateSushiPrice]';
    if (!poolState || !poolState.reserve0 || !poolState.reserve1 || poolState.reserve0 === '0' || poolState.reserve0 === 0n) {
        logger.warn(`${logPrefix} Invalid Sushi state for price calc: Missing or zero reserves. Pool: ${poolState?.address}`);
        return null;
    }
    if (!poolState.token0?.decimals || !poolState.token1?.decimals) {
        logger.warn(`${logPrefix} Invalid Sushi state for price calc: Missing token decimals. Pool: ${poolState?.address}`);
        return null;
    }
    try {
        const reserve0 = BigInt(poolState.reserve0);
        const reserve1 = BigInt(poolState.reserve1);
        if (reserve0 === 0n) { // Explicitly handled by initial check, but safe
             logger.error(`${logPrefix} Division by zero avoided: reserve0 is zero. Pool: ${poolState.address}`);
             return null;
        }
        const rawPrice = (reserve1 * BIGNUM_SCALE) / reserve0;

        const decimals0 = BigInt(poolState.token0.decimals);
        const decimals1 = BigInt(poolState.token1.decimals);
        const decimalFactor = 10n ** (decimals0 - decimals1 + BigInt(BIGNUM_SCALE_DECIMALS));

        if (BIGNUM_SCALE === 0n) throw new Error("BIGNUM_SCALE is zero");
        const adjustedPriceScaled = (rawPrice * decimalFactor) / BIGNUM_SCALE;

        logger.trace(`${logPrefix} Sushi Pool ${poolState.address.substring(0,6)} | Adjusted Price (scaled): ${adjustedPriceScaled}`);
        return adjustedPriceScaled;
    } catch (error) {
        logger.error(`${logPrefix} Error calculating Sushi price for ${poolState.address}: ${error.message}`);
        handleError(error, `SushiPriceCalc ${poolState.address}`);
        return null;
    }
}

/**
 * Calculates the effective buy and sell prices for a V3/Sushi pairing, accounting for fees.
 * @param {object} v3Pool - The Uniswap V3 pool state object.
 * @param {object} sushiPool - The SushiSwap pool state object.
 * @param {bigint} priceV3_scaled - Scaled raw price of the V3 pool.
 * @param {bigint} priceSushi_scaled - Scaled raw price of the SushiSwap pool.
 * @returns {object|null} An object with effective prices { sushiBuy, v3Sell, v3Buy, sushiSell } or null if calculation fails.
 */
function calculateEffectivePrices(v3Pool, sushiPool, priceV3_scaled, priceSushi_scaled) {
    const logPrefix = '[priceCalculation calculateEffectivePrices]';
    let v3FeeBps, sushiFeeBps, divisorSushi, divisorV3;

    // Validate inputs needed for fee calculation
    if (!v3Pool || typeof v3Pool.fee === 'undefined' || !sushiPool || typeof sushiPool.fee === 'undefined') {
        logger.error(`${logPrefix} Missing fee information for effective price calculation. V3: ${v3Pool?.fee}, Sushi: ${sushiPool?.fee}`);
        return null;
    }
    if (priceV3_scaled === null || priceSushi_scaled === null) {
        logger.error(`${logPrefix} Cannot calculate effective prices with null raw prices.`);
        return null;
    }

    try { // Setup fees and divisors
        v3FeeBps = BigInt(v3Pool.fee);
        sushiFeeBps = BigInt(sushiPool.fee); // Assuming fee is in basis points
        divisorSushi = (TEN_THOUSAND - sushiFeeBps);
        divisorV3 = (TEN_THOUSAND - v3FeeBps);

        if (divisorSushi <= 0n || divisorV3 <= 0n || TEN_THOUSAND <= 0n || BIGNUM_SCALE <= 0n) {
           throw new ArbitrageError(`Invalid fee divisor generated (V3 Div: ${divisorV3}, Sushi Div: ${divisorSushi})`);
        }
        logger.trace(`${logPrefix} Fees OK | V3 Fee: ${v3FeeBps}, Sushi Fee: ${sushiFeeBps}, DivV3: ${divisorV3}, DivSushi: ${divisorSushi}`);
    } catch (feeError) {
        logger.error(`${logPrefix} Error preparing fee values: ${feeError.message}`);
        handleError(feeError, `SpatialFeePrep ${v3Pool?.pairKey || 'N/A'}`);
        return null;
    }

    // Calculate individual effective prices
    let effectiveSushiBuyPrice_scaled, effectiveV3SellPrice_scaled, effectiveV3BuyPrice_scaled, effectiveSushiSellPrice_scaled;
    let calcError = null;

    try { // sushiBuy: Price * (1 / (1 - fee)) = Price * 10000 / divisorSushi
        if (divisorSushi === 0n) throw new Error("DivisorSushi is zero");
        effectiveSushiBuyPrice_scaled = (priceSushi_scaled * TEN_THOUSAND * BIGNUM_SCALE) / (divisorSushi * BIGNUM_SCALE);
    } catch (e) { calcError = e; logger.error(`${logPrefix} ERROR calc effectiveSushiBuyPrice_scaled: ${e.message}`); }

    if (!calcError) try { // v3Sell: Price * (1 - fee) = Price * divisorV3 / 10000
        effectiveV3SellPrice_scaled = (priceV3_scaled * divisorV3) / TEN_THOUSAND;
    } catch (e) { calcError = e; logger.error(`${logPrefix} ERROR calc effectiveV3SellPrice_scaled: ${e.message}`); }

    if (!calcError) try { // v3Buy: Price * (1 / (1 - fee)) = Price * 10000 / divisorV3
        if (divisorV3 === 0n) throw new Error("DivisorV3 is zero");
        effectiveV3BuyPrice_scaled = (priceV3_scaled * TEN_THOUSAND * BIGNUM_SCALE) / (divisorV3 * BIGNUM_SCALE);
    } catch (e) { calcError = e; logger.error(`${logPrefix} ERROR calc effectiveV3BuyPrice_scaled: ${e.message}`); }

    if (!calcError) try { // sushiSell: Price * (1 - fee) = Price * divisorSushi / 10000
        effectiveSushiSellPrice_scaled = (priceSushi_scaled * divisorSushi) / TEN_THOUSAND;
    } catch (e) { calcError = e; logger.error(`${logPrefix} ERROR calc effectiveSushiSellPrice_scaled: ${e.message}`); }

    if (calcError) {
        logger.warn(`${logPrefix} Effective price calculation failed due to error.`);
        handleError(calcError, `SpatialEffectivePriceCalc ${v3Pool?.pairKey || 'N/A'}`);
        return null;
    }

    logger.trace(`${logPrefix} Effective prices calculated successfully.`);
    return {
        sushiBuy: effectiveSushiBuyPrice_scaled,
        v3Sell: effectiveV3SellPrice_scaled,
        v3Buy: effectiveV3BuyPrice_scaled,
        sushiSell: effectiveSushiSellPrice_scaled
    };
}


module.exports = {
    calculateV3Price,
    calculateSushiPrice,
    calculateEffectivePrices,
    // Expose constants if needed by callers, or keep them internal
    // BIGNUM_SCALE,
    // BIGNUM_SCALE_DECIMALS,
};
