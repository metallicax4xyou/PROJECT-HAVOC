// utils/priceFeed.js
// --- VERSION v1.2 ---
// Converts token value to native ETH value using USD feeds as intermediary.
// Handles USDC.e aliasing.

const { ethers } = require('ethers');
const logger = require('./logger'); // Adjust path if needed
const { ArbitrageError } = require('./errorHandler'); // Adjust path if needed
const { TOKENS } = require('../constants/tokens'); // Adjust path if needed

// Chainlink Aggregator V3 Interface ABI (minimal)
const CHAINLINK_ABI = [
    "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
    "function decimals() view returns (uint8)"
];

// Simple cache for contract instances and decimals
const feedContractCache = {};
const feedDecimalsCache = {};

// Precision constant for calculations using USD intermediate value
const USD_PRICE_PRECISION = 10n**18n; // Use 18 decimals for intermediate USD value

/**
 * Gets the Chainlink price feed address vs USD.
 * Handles aliases like USDC.e -> USDC.
 * @param {object} chainlinkFeedsConfig The CHAINLINK_FEEDS object from config.
 * @param {string} tokenSymbol The symbol of the token (e.g., 'USDC.e', 'ETH').
 * @returns {string | null} The feed address string or null if not found.
 */
function getFeedAddressVsUsd(chainlinkFeedsConfig, tokenSymbol) {
    let symbolForLookup = tokenSymbol;

    // --- ALIASING LOGIC ---
    if (tokenSymbol === 'USDC.e') symbolForLookup = 'USDC'; // Treat USDC.e as USDC
    else if (tokenSymbol === 'WETH') symbolForLookup = 'ETH'; // Treat WETH as ETH
    // Add other aliases here if needed (e.g., USDT.e -> USDT)

    const usdFeedKey = `${symbolForLookup}/USD`; // Key format e.g., "ETH/USD", "USDC/USD"

    if (chainlinkFeedsConfig && chainlinkFeedsConfig[usdFeedKey]) {
        logger.debug(`[PriceFeed] Found USD feed key: ${usdFeedKey} for original ${tokenSymbol}`);
        return chainlinkFeedsConfig[usdFeedKey];
    } else {
        logger.warn(`[PriceFeed] No Chainlink /USD feed found for ${tokenSymbol} (lookup: ${usdFeedKey})`);
        return null;
    }
}

/**
 * Fetches the latest price from a Chainlink feed vs USD.
 * Returns price scaled to 18 decimals (USD_PRICE_PRECISION) for consistent calculations.
 * @param {ethers.Provider} provider Ethers provider instance.
 * @param {string} feedAddress The address of the Chainlink feed contract.
 * @returns {Promise<bigint | null>} Price scaled by 1e18, or null on error.
 */
async function getUsdPriceDataScaled(provider, feedAddress) {
    const logPrefix = `[PriceFeed ${feedAddress.substring(0, 6)}]`;
    if (!provider || !feedAddress || !ethers.isAddress(feedAddress)) {
        logger.error(`${logPrefix} Invalid provider or feed address.`);
        return null;
    }

    try {
        // Use cache or create new contract instance
        if (!feedContractCache[feedAddress]) {
            feedContractCache[feedAddress] = new ethers.Contract(feedAddress, CHAINLINK_ABI, provider);
        }
        const feedContract = feedContractCache[feedAddress];

        // Use cache or fetch decimals
        let feedDecimals = feedDecimalsCache[feedAddress];
        if (feedDecimals === undefined) {
             // Use callStatic for safety on view functions if provider requires it, otherwise direct call is fine
            feedDecimals = Number(await feedContract.decimals()); // Use Number() to convert uint8
            feedDecimalsCache[feedAddress] = feedDecimals;
            logger.debug(`${logPrefix} Fetched feed decimals: ${feedDecimals}`);
        }

        // Fetch latest price data
        const roundData = await feedContract.latestRoundData();
        const price = BigInt(roundData.answer); // answer is int256, convert to BigInt

        if (price <= 0n) {
             logger.warn(`${logPrefix} Chainlink feed returned non-positive price: ${price}`);
             return null; // Cannot use non-positive price
        }

        // Scale the price to 18 decimals (USD_PRICE_PRECISION)
        const priceScaled = (price * USD_PRICE_PRECISION) / (10n ** BigInt(feedDecimals));

        logger.debug(`${logPrefix} Fetched raw price: ${price} (Dec: ${feedDecimals}), Scaled USD Price (18 Dec): ${priceScaled}`);
        return priceScaled;

    } catch (error) {
         // Log specific errors if possible (e.g., contract call reverted)
         if (error.code === 'CALL_EXCEPTION') {
             logger.error(`${logPrefix} Chainlink contract call failed: ${error.reason}`);
         } else {
             logger.error(`${logPrefix} Error fetching Chainlink price: ${error.message}`);
         }
        return null;
    }
}

/**
 * Converts a token amount (in wei) to its equivalent value in the native currency (ETH wei)
 * using respective Token/USD and ETH/USD Chainlink feeds.
 */
async function convertTokenAmountToNative(amountTokenWei, token, chainlinkFeedsConfig, nativeSymbol, nativeDecimals, provider) {
    const logPrefix = `[PriceFeedConvert ${token?.symbol}->${nativeSymbol}]`;
    if (!amountTokenWei || !token?.symbol || !token?.decimals || !chainlinkFeedsConfig || !nativeSymbol || !nativeDecimals || !provider) {
        logger.error(`${logPrefix} Invalid arguments.`); return null;
    }

    const amountToken = BigInt(amountTokenWei);
    if (amountToken === 0n) return 0n;

    // Handle Native Token (no conversion needed)
    if (token.symbol === nativeSymbol || (token.symbol === 'WETH' && nativeSymbol === 'ETH')) {
        if (token.decimals !== nativeDecimals) logger.warn(`${logPrefix} Native token decimal mismatch.`);
        return amountToken;
    }

    // --- Get Token/USD Price (scaled to 1e18) ---
    const tokenUsdFeedAddress = getFeedAddressVsUsd(chainlinkFeedsConfig, token.symbol);
    if (!tokenUsdFeedAddress) return null; // Error logged in helper
    const tokenUsdPriceScaled = await getUsdPriceDataScaled(provider, tokenUsdFeedAddress);
    if (tokenUsdPriceScaled === null) return null; // Error logged in helper

    // --- Get Native/USD Price (scaled to 1e18) ---
    const nativeUsdFeedAddress = getFeedAddressVsUsd(chainlinkFeedsConfig, nativeSymbol);
    if (!nativeUsdFeedAddress) return null;
    const nativeUsdPriceScaled = await getUsdPriceDataScaled(provider, nativeUsdFeedAddress);
    if (nativeUsdPriceScaled === null || nativeUsdPriceScaled <= 0n) { // Cannot divide by zero or invalid price
        logger.error(`${logPrefix} Failed to get valid ${nativeSymbol}/USD price (${nativeUsdPriceScaled}).`);
        return null;
    }

    // --- Calculate Native Value using USD intermediate ---
    try {
        // ValueUSD_Scaled = (AmountTokenWei * tokenUsdPriceScaled) / 10^tokenDec
        const valueUsdScaled = (amountToken * tokenUsdPriceScaled) / (10n ** BigInt(token.decimals));

        // ValueNativeWei = (ValueUSD_Scaled * 10^nativeDec) / nativeUsdPriceScaled
        const nativeValueWei = (valueUsdScaled * (10n ** BigInt(nativeDecimals))) / nativeUsdPriceScaled;

        logger.debug(`${logPrefix} Converted ${ethers.formatUnits(amountToken, token.decimals)} ${token.symbol} -> ${ethers.formatUnits(nativeValueWei, nativeDecimals)} ${nativeSymbol} (via USD feeds)`);
        return nativeValueWei;

    } catch (error) {
        logger.error(`${logPrefix} Error during conversion calculation via USD: ${error.message}`);
        return null;
    }
}

module.exports = {
    convertTokenAmountToNative,
    // Expose helpers only if needed externally
    // getFeedAddressVsUsd,
    // getUsdPriceDataScaled
};
