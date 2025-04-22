// utils/priceFeed.js
const { ethers } = require('ethers');
const logger = require('./logger'); // Adjust path if needed
const { ArbitrageError } = require('./errorHandler'); // Adjust path if needed
const { TOKENS } = require('../constants/tokens'); // Adjust path if needed

// Chainlink Aggregator V3 Interface ABI (minimal)
const CHAINLINK_ABI = [
    "function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
    "function decimals() external view returns (uint8)"
];

// Cache for feed contracts and decimals
const feedContractCache = {};
const feedDecimalsCache = {};

/**
 * Gets the Chainlink price feed address for a given pair.
 * Handles direct and inverse pairs (e.g., ETH/USD vs USD/ETH).
 * @param {object} chainlinkFeedsConfig The CHAINLINK_FEEDS object from config.
 * @param {string} baseSymbol The symbol of the base currency (e.g., 'USDC').
 * @param {string} quoteSymbol The symbol of the quote currency (e.g., 'ETH').
 * @returns {{feedAddress: string | null, inverse: boolean}}
 */
function getFeedAddress(chainlinkFeedsConfig, baseSymbol, quoteSymbol) {
    const directKey = `${baseSymbol}/${quoteSymbol}`;
    const inverseKey = `${quoteSymbol}/${baseSymbol}`;

    if (chainlinkFeedsConfig[directKey]) {
        return { feedAddress: chainlinkFeedsConfig[directKey], inverse: false };
    } else if (chainlinkFeedsConfig[inverseKey]) {
        return { feedAddress: chainlinkFeedsConfig[inverseKey], inverse: true };
    } else {
        logger.warn(`[PriceFeed] No Chainlink feed found for ${directKey} or ${inverseKey}`);
        return { feedAddress: null, inverse: false };
    }
}

/**
 * Fetches the latest price from a Chainlink feed.
 * @param {ethers.Provider} provider Ethers provider instance.
 * @param {string} feedAddress The address of the Chainlink feed contract.
 * @returns {Promise<{price: bigint, decimals: number} | null>} Price in feed's units or null on error.
 */
async function getChainlinkPriceData(provider, feedAddress) {
    const logPrefix = `[PriceFeed ${feedAddress.substring(0, 6)}]`;
    if (!provider || !feedAddress || !ethers.isAddress(feedAddress)) {
        logger.error(`${logPrefix} Invalid provider or feed address.`);
        return null;
    }

    try {
        // Get contract instance from cache or create new
        if (!feedContractCache[feedAddress]) {
            feedContractCache[feedAddress] = new ethers.Contract(feedAddress, CHAINLINK_ABI, provider);
        }
        const feedContract = feedContractCache[feedAddress];

        // Get feed decimals from cache or fetch
        let feedDecimals = feedDecimalsCache[feedAddress];
        if (feedDecimals === undefined) {
            feedDecimals = await feedContract.decimals();
            feedDecimalsCache[feedAddress] = Number(feedDecimals); // Convert to number
             logger.debug(`${logPrefix} Fetched feed decimals: ${feedDecimals}`);
        }

        // Fetch latest round data
        const roundData = await feedContract.latestRoundData();
        // roundData = { roundId, answer (price), startedAt, updatedAt, answeredInRound }
        const price = BigInt(roundData.answer);

        if (price <= 0n) {
             logger.warn(`${logPrefix} Chainlink feed returned non-positive price: ${price}`);
             return null;
        }

         logger.debug(`${logPrefix} Fetched price: ${price} (Decimals: ${feedDecimals})`);
        return { price: price, decimals: feedDecimals };

    } catch (error) {
        logger.error(`${logPrefix} Error fetching Chainlink price: ${error.message}`);
        return null;
    }
}

/**
 * Converts a token amount (in wei) to its equivalent value in the native currency (ETH wei).
 * @param {bigint} amountWei The amount of the token in its own wei units.
 * @param {object} token The token object (needs symbol, decimals).
 * @param {object} chainlinkFeedsConfig The CHAINLINK_FEEDS object from config.
 * @param {string} nativeSymbol The symbol of the native currency (e.g., 'ETH').
 * @param {number} nativeDecimals The decimals of the native currency.
 * @param {ethers.Provider} provider Ethers provider instance.
 * @returns {Promise<bigint | null>} The equivalent value in native currency wei, or null on error.
 */
async function convertTokenAmountToNative(amountWei, token, chainlinkFeedsConfig, nativeSymbol, nativeDecimals, provider) {
    const logPrefix = `[PriceFeedConvert ${token?.symbol}]`;
    if (!amountWei || !token || !chainlinkFeedsConfig || !nativeSymbol || !nativeDecimals || !provider) {
        logger.error(`${logPrefix} Invalid arguments for conversion.`);
        return null;
    }

    const tokenSymbol = token.symbol;
    const tokenDecimals = token.decimals;

    // If the token IS the native currency, no conversion needed
    if (tokenSymbol === nativeSymbol) {
        // Cross-check decimals - should match but log warning if not
        if (tokenDecimals !== nativeDecimals) {
             logger.warn(`${logPrefix} Native token decimal mismatch (${tokenDecimals} vs ${nativeDecimals}). Returning original amount.`);
        }
        return BigInt(amountWei);
    }

    // Find the appropriate Chainlink feed (Token/ETH or ETH/Token)
    const { feedAddress, inverse } = getFeedAddress(chainlinkFeedsConfig, tokenSymbol, nativeSymbol);
    if (!feedAddress) {
        // Log warning if feed not found for non-native token
        logger.warn(`${logPrefix} No Chainlink feed found to convert ${tokenSymbol} to ${nativeSymbol}. Cannot calculate native value.`);
        return null;
    }

    // Get the price data from the feed
    const priceData = await getChainlinkPriceData(provider, feedAddress);
    if (!priceData) {
         logger.warn(`${logPrefix} Failed to get price data from feed ${feedAddress}.`);
        return null;
    }

    const price = priceData.price; // Price from feed (e.g., ETH per Token, or Token per ETH)
    const feedDecimals = priceData.decimals; // Decimals of the price feed itself

    try {
        let nativeValueWei;
        const amount = BigInt(amountWei);
        const scaleFactorToken = 10n ** BigInt(tokenDecimals);
        const scaleFactorNative = 10n ** BigInt(nativeDecimals);
        const scaleFactorFeed = 10n ** BigInt(feedDecimals);

        if (!inverse) {
            // Feed is Token/ETH (e.g., USDC/ETH price is ETH per USDC)
            // ValueETH = AmountToken * Price (ETH per Token)
            // ValueETHWei = (AmountTokenWei / 10^tokenDec) * (PriceFeed / 10^feedDec) * 10^nativeDec
            // ValueETHWei = (AmountTokenWei * PriceFeed * 10^nativeDec) / (10^tokenDec * 10^feedDec)
            nativeValueWei = (amount * price * scaleFactorNative) / (scaleFactorToken * scaleFactorFeed);
             logger.debug(`${logPrefix} Converted ${tokenSymbol}->${nativeSymbol} (Direct Feed): ${nativeValueWei} Wei`);
        } else {
            // Feed is ETH/Token (e.g., ETH/USDC price is USDC per ETH)
            // ValueETH = AmountToken / Price (Token per ETH)
            // ValueETHWei = (AmountTokenWei / 10^tokenDec) / (PriceFeed / 10^feedDec) * 10^nativeDec
            // ValueETHWei = (AmountTokenWei * 10^feedDec * 10^nativeDec) / (10^tokenDec * PriceFeed)
            const numerator = amount * scaleFactorFeed * scaleFactorNative;
            const denominator = scaleFactorToken * price;
            if (denominator === 0n) { throw new Error("Division by zero during inverse conversion."); }
            nativeValueWei = numerator / denominator;
             logger.debug(`${logPrefix} Converted ${tokenSymbol}->${nativeSymbol} (Inverse Feed): ${nativeValueWei} Wei`);
        }

        return nativeValueWei;

    } catch (error) {
        logger.error(`${logPrefix} Error during conversion calculation: ${error.message}`);
        return null;
    }
}

module.exports = {
    getChainlinkPriceData, // Export if needed directly elsewhere
    convertTokenAmountToNative
};
