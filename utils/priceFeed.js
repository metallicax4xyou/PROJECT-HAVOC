// utils/priceFeed.js
// --- VERSION v1.2 ---
// Converts token value to native ETH value using USD feeds as intermediary.
// Handles USDC.e aliasing.

const { ethers } = require('ethers');
const logger = require('./logger');
const { ArbitrageError } = require('./errorHandler');
const { TOKENS } = require('../constants/tokens');

// Chainlink ABI (minimal)
const CHAINLINK_ABI = [
    "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
    "function decimals() view returns (uint8)"
];

// Simple cache for contract instances and decimals
const feedContractCache = {};
const feedDecimalsCache = {};

// Precision constant for calculations
const USD_PRICE_PRECISION = 10n**18n; // Use 18 decimals for intermediate USD value

/**
 * Gets the Chainlink price feed address vs USD.
 * Handles aliases like USDC.e -> USDC.
 */
function getFeedAddressVsUsd(chainlinkFeedsConfig, tokenSymbol) {
    let symbolForLookup = tokenSymbol;

    // --- ALIASING LOGIC ---
    if (tokenSymbol === 'USDC.e' || tokenSymbol === 'USDC') symbolForLookup = 'USDC'; // Treat both as USDC
    else if (tokenSymbol === 'WETH' || tokenSymbol === 'ETH') symbolForLookup = 'ETH'; // Treat WETH as ETH
    else if (tokenSymbol === 'WBTC') symbolForLookup = 'WBTC'; // Keep WBTC as is
    // Add other aliases if necessary (e.g., USDT.e -> USDT)

    const usdFeedKey = `${symbolForLookup}/USD`;

    if (chainlinkFeedsConfig[usdFeedKey]) {
        logger.debug(`[PriceFeed] Found USD feed key: ${usdFeedKey} for original ${tokenSymbol}`);
        return chainlinkFeedsConfig[usdFeedKey];
    } else {
        logger.warn(`[PriceFeed] No Chainlink /USD feed found for ${tokenSymbol} (lookup: ${usdFeedKey})`);
        return null;
    }
}

/**
 * Fetches the latest price from a Chainlink feed vs USD.
 * Returns price scaled to 18 decimals for consistency.
 */
async function getUsdPriceDataScaled(provider, feedAddress) {
    const logPrefix = `[PriceFeed ${feedAddress.substring(0, 6)}]`;
    if (!provider || !feedAddress || !ethers.isAddress(feedAddress)) {
        logger.error(`${logPrefix} Invalid provider or feed address.`);
        return null;
    }

    try {
        if (!feedContractCache[feedAddress]) {
            feedContractCache[feedAddress] = new ethers.Contract(feedAddress, CHAINLINK_ABI, provider);
        }
        const feedContract = feedContractCache[feedAddress];

        let feedDecimals = feedDecimalsCache[feedAddress];
        if (feedDecimals === undefined) {
            feedDecimals = Number(await feedContract.decimals());
            feedDecimalsCache[feedAddress] = feedDecimals;
             logger.debug(`${logPrefix} Fetched feed decimals: ${feedDecimals}`);
        }

        const roundData = await feedContract.latestRoundData();
        const price = BigInt(roundData.answer);
        if (price <= 0n) { logger.warn(`${logPrefix} Non-positive price: ${price}`); return null; }

        // Scale the price to 18 decimals (USD_PRICE_PRECISION)
        // priceScaled = price * (10^18 / 10^feedDecimals)
        const priceScaled = (price * USD_PRICE_PRECISION) / (10n ** BigInt(feedDecimals));

        logger.debug(`${logPrefix} Fetched price: ${price} (Dec: ${feedDecimals}), Scaled Price (18 Dec): ${priceScaled}`);
        return priceScaled; // Return price scaled to 18 decimals

    } catch (error) {
        logger.error(`${logPrefix} Error fetching Chainlink price: ${error.message}`);
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
        logger.error(`${logPrefix} Invalid arguments. Token: ${token?.symbol}, Amount: ${amountTokenWei}`);
        return null;
    }

    const amountToken = BigInt(amountTokenWei);
    if (amountToken === 0n) return 0n; // No value if amount is zero

    // --- Handle Native Token ---
    if (token.symbol === nativeSymbol || (token.symbol === 'WETH' && nativeSymbol === 'ETH')) {
        if (token.decimals !== nativeDecimals) logger.warn(`${logPrefix} Native token decimal mismatch.`);
        return amountToken; // Amount is already in native wei
    }

    // --- Get Token/USD Price ---
    const tokenUsdFeedAddress = getFeedAddressVsUsd(chainlinkFeedsConfig, token.symbol);
    if (!tokenUsdFeedAddress) return null; // Error logged in getFeedAddressVsUsd
    const tokenUsdPriceScaled = await getUsdPriceDataScaled(provider, tokenUsdFeedAddress);
    if (tokenUsdPriceScaled === null) return null; // Error logged in getUsdPriceDataScaled

    // --- Get Native/USD Price ---
    const nativeUsdFeedAddress = getFeedAddressVsUsd(chainlinkFeedsConfig, nativeSymbol);
    if (!nativeUsdFeedAddress) return null;
    const nativeUsdPriceScaled = await getUsdPriceDataScaled(provider, nativeUsdFeedAddress);
    if (nativeUsdPriceScaled === null || nativeUsdPriceScaled === 0n) { // Cannot divide by zero
        logger.error(`${logPrefix} Failed to get valid ${nativeSymbol}/USD price.`);
        return null;
    }

    // --- Calculate Native Value ---
    // ValueUSD = AmountToken * Price (USD per Token)
    // ValueUSD_Scaled = (AmountTokenWei / 10^tokenDec) * (tokenUsdPriceScaled / 10^18) * 10^18 (intermediate USD precision)
    // ValueUSD_Scaled = (AmountTokenWei * tokenUsdPriceScaled) / 10^tokenDec
    const valueUsdScaled = (amountToken * tokenUsdPriceScaled) / (10n ** BigInt(token.decimals));

    // ValueNative = ValueUSD / Price (USD per Native)
    // ValueNativeWei = (ValueUSD_Scaled / 10^18) / (nativeUsdPriceScaled / 10^18) * 10^nativeDec
    // ValueNativeWei = (ValueUSD_Scaled * 10^nativeDec) / nativeUsdPriceScaled
    const nativeValueWei = (valueUsdScaled * (10n ** BigInt(nativeDecimals))) / nativeUsdPriceScaled;

    logger.debug(`${logPrefix} Converted ${ethers.formatUnits(amountToken, token.decimals)} ${token.symbol} -> ${ethers.formatUnits(nativeValueWei, nativeDecimals)} ${nativeSymbol}`);
    return nativeValueWei;
}

module.exports = {
    convertTokenAmountToNative,
    // Export helpers if needed elsewhere, otherwise keep private
    // getFeedAddressVsUsd,
    // getUsdPriceDataScaled
};
