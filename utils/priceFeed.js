// utils/priceFeed.js
const { ethers } = require('ethers');
const logger = require('./logger');

// Minimal ABI for Chainlink AggregatorV3Interface
const CHAINLINK_ABI = [
    "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
    "function decimals() view returns (uint8)"
];

/**
 * Fetches the latest price data for a given token symbol relative to ETH from Chainlink.
 * @param {string} tokenSymbol The symbol of the token (e.g., 'USDC', 'USDT'). Case-sensitive match with config.
 * @param {ethers.Provider} provider Ethers provider instance.
 * @param {object} networkConfig The loaded network configuration (e.g., from config/index.js). Must contain CHAINLINK_FEEDS.
 * @returns {Promise<{price: bigint, feedDecimals: number} | null>} Object containing the price (as BigInt) and feed decimals, or null if failed.
 * Price represents how much ETH 1 unit of the token is worth, scaled by feedDecimals.
 */
async function getChainlinkPriceData(tokenSymbol, provider, networkConfig) {
    if (!networkConfig || !networkConfig.CHAINLINK_FEEDS) {
        logger.error('[PriceFeed] CHAINLINK_FEEDS not found in network configuration.');
        return null;
    }

    // Handle native token (WETH is treated as ETH price = 1)
    // Assumes NATIVE_SYMBOL is defined in the root config merged by config/index.js
    if (tokenSymbol === (networkConfig.NATIVE_SYMBOL || 'WETH')) {
        logger.debug(`[PriceFeed] Price requested for native token (${tokenSymbol}), returning 1 ETH.`);
        // Return price = 1, decimals = 18 (standard ETH decimals)
        // Price = 1 * 10^18, feedDecimals = 18. This means 1 Native Token = (10^18 / 10^18) ETH = 1 ETH
        return { price: 10n ** 18n, feedDecimals: 18 };
    }

    const feedAddress = networkConfig.CHAINLINK_FEEDS[`${tokenSymbol}/ETH`]; // Assumes feeds vs ETH
    if (!feedAddress) {
        logger.warn(`[PriceFeed] Chainlink feed address not found for ${tokenSymbol}/ETH in configuration.`);
        return null;
    }

    try {
        const feedContract = new ethers.Contract(feedAddress, CHAINLINK_ABI, provider);
        logger.debug(`[PriceFeed] Querying Chainlink feed for ${tokenSymbol}/ETH at ${feedAddress}`);

        const [roundData, feedDecimals] = await Promise.all([
            feedContract.latestRoundData(),
            feedContract.decimals() // Fetch decimals directly from contract
        ]);

        // roundData = { roundId, answer (price), startedAt, updatedAt, answeredInRound }
        const price = roundData.answer; // Price is int256, but usually positive
        const decimals = Number(feedDecimals); // Convert uint8 to number

        if (price <= 0n) {
             logger.warn(`[PriceFeed] Chainlink feed for ${tokenSymbol}/ETH returned non-positive price: ${price}`);
             return null;
        }

        logger.debug(`[PriceFeed] Chainlink Data for ${tokenSymbol}/ETH: Price=${price}, Decimals=${decimals}`);
        return { price, feedDecimals: decimals };

    } catch (error) {
        logger.error(`[PriceFeed] Error fetching price for ${tokenSymbol}/ETH from ${feedAddress}: ${error.message}`);
        // Optionally check error type (e.g., network error, contract call error)
        return null;
    }
}

/**
 * Converts an amount of a token (in its smallest unit) to its equivalent value in ETH (wei).
 * @param {bigint} amountTokenSmallestUnit The amount of the token in its smallest denomination (e.g., 1,000,000 for 1 USDC if decimals=6).
 * @param {number} tokenDecimals The number of decimals for the token.
 * @param {object} priceData The price data object from getChainlinkPriceData {price: bigint, feedDecimals: number}.
 * @returns {bigint | null} The equivalent value in wei, or null if conversion is not possible.
 */
function convertTokenAmountToWei(amountTokenSmallestUnit, tokenDecimals, priceData) {
    if (!priceData || amountTokenSmallestUnit < 0n) {
        return null;
    }

    const { price, feedDecimals } = priceData;
    const EIGHTEEN_DECIMALS = 10n ** 18n; // Wei decimals

    try {
        // Formula: wei = (amountToken * price * 10^18) / (10^tokenDecimals * 10^feedDecimals)
        const numerator = amountTokenSmallestUnit * price * EIGHTEEN_DECIMALS;
        const denominator = (10n ** BigInt(tokenDecimals)) * (10n ** BigInt(feedDecimals));

        if (denominator === 0n) {
            logger.error('[PriceFeed] Price conversion denominator is zero, cannot convert.');
            return null;
        }

        const amountInWei = numerator / denominator;
        return amountInWei;

    } catch (error) {
        // Potential BigInt overflow if numbers are massive, though unlikely with typical token amounts/prices
        logger.error(`[PriceFeed] Error during BigInt calculation for price conversion: ${error.message}`);
        return null;
    }
}


module.exports = {
    getChainlinkPriceData,
    convertTokenAmountToWei,
};
