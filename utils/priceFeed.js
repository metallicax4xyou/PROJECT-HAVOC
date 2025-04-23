// utils/priceFeed.js
// --- VERSION v1.4 ---
// Converts token value to native ETH value using ONLY the ETH/USD feed
// Assumes stablecoins (USDC, USDC.e, USDT, DAI, FRAX) are pegged 1:1 to USD for conversion.

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
 * Handles aliases like USDC.e -> USDC, WETH -> ETH.
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
    logger.debug(`${logPrefix} Attempting to fetch USD price data...`); // Log entry

    if (!provider || typeof provider.getNetwork !== 'function') { logger.error(`${logPrefix} Invalid provider object received.`); return null; }
    if (!feedAddress || !ethers.isAddress(feedAddress)) { logger.error(`${logPrefix} Invalid feed address: ${feedAddress}`); return null; }

    let feedContract;
    try {
        if (!feedContractCache[feedAddress]) {
            logger.debug(`${logPrefix} Creating new contract instance...`);
            const network = await provider.getNetwork(); // Check provider state
            logger.debug(`${logPrefix} Provider network check: ${network.name} (ID: ${network.chainId})`);
            feedContractCache[feedAddress] = new ethers.Contract(feedAddress, CHAINLINK_ABI, provider);
            logger.debug(`${logPrefix} Contract instance created.`);
        } else { logger.debug(`${logPrefix} Using cached contract instance.`); }
        feedContract = feedContractCache[feedAddress];

        let feedDecimals = feedDecimalsCache[feedAddress];
        if (feedDecimals === undefined) {
            logger.debug(`${logPrefix} Fetching decimals...`);
            try {
                feedDecimals = Number(await feedContract.decimals());
                 logger.debug(`${logPrefix} Decimals call successful: ${feedDecimals}`);
                feedDecimalsCache[feedAddress] = feedDecimals;
            } catch (decimalError) { logger.error(`${logPrefix} Error calling decimals(): ${decimalError.message}`, decimalError); throw new Error(`Failed to fetch decimals: ${decimalError.message}`); }
        } else { logger.debug(`${logPrefix} Using cached decimals: ${feedDecimals}`); }

        logger.debug(`${logPrefix} Fetching latestRoundData...`);
        let roundData;
        try {
            roundData = await feedContract.latestRoundData();
             logger.debug(`${logPrefix} latestRoundData call successful.`);
        } catch (roundError) { logger.error(`${logPrefix} Error calling latestRoundData(): ${roundError.message}`, roundError); throw new Error(`Failed to fetch round data: ${roundError.message}`); }

        const price = BigInt(roundData.answer);
        if (price <= 0n) { logger.warn(`${logPrefix} Non-positive price: ${price}`); return null; }

        const priceScaled = (price * USD_PRICE_PRECISION) / (10n ** BigInt(feedDecimals));
        logger.debug(`${logPrefix} Fetched raw price: ${price} (Dec: ${feedDecimals}), Scaled USD Price (18 Dec): ${priceScaled}`);
        return priceScaled;

    } catch (error) {
        logger.error(`${logPrefix} Error during price data fetch: ${error.message}`);
        return null; // Return null instead of throwing generic error
    }
}

/**
 * Converts a token amount (in wei) to its equivalent value in the native currency (ETH wei)
 * using ONLY the ETH/USD Chainlink feed and assuming stablecoins are $1.
 * NOTE: Will return null for non-stablecoins if their /USD feed isn't explicitly handled.
 */
async function convertTokenAmountToNative(amountTokenWei, token, chainlinkFeedsConfig, nativeSymbol, nativeDecimals, provider) {
    const logPrefix = `[PriceFeedConvert ${token?.symbol}->${nativeSymbol}]`;
    if (!amountTokenWei || !token?.symbol || !token?.decimals || !chainlinkFeedsConfig || !nativeSymbol || !nativeDecimals || !provider) {
        logger.error(`${logPrefix} Invalid arguments.`); return null;
    }

    const amountToken = BigInt(amountTokenWei);
    if (amountToken === 0n) return 0n;

    // Handle Native Token
    if (token.symbol === nativeSymbol || (token.symbol === 'WETH' && nativeSymbol === 'ETH')) {
        return amountToken;
    }

    // --- Get Native/USD Price ---
    const nativeUsdFeedAddress = getFeedAddressVsUsd(chainlinkFeedsConfig, nativeSymbol);
    if (!nativeUsdFeedAddress) {
        logger.error(`${logPrefix} Cannot convert - ${nativeSymbol}/USD feed missing in config.`);
        return null;
    }
    const nativeUsdPriceScaled = await getUsdPriceDataScaled(provider, nativeUsdFeedAddress);
    if (nativeUsdPriceScaled === null || nativeUsdPriceScaled <= 0n) {
        logger.error(`${logPrefix} Failed to get valid ${nativeSymbol}/USD price.`);
        return null;
    }

    // --- Determine Token/USD Price ---
    let tokenUsdPriceScaled;
    const stablecoins = ['USDC', 'USDC.e', 'USDT', 'DAI', 'FRAX']; // Define stables
    if (stablecoins.includes(token.symbol)) {
        tokenUsdPriceScaled = USD_PRICE_PRECISION; // Assume $1 (scaled by 1e18)
         logger.debug(`${logPrefix} Assuming ${token.symbol} = $1 USD.`);
    } else {
        // --- Fetch Token/USD Price for non-stables ---
        const tokenUsdFeedAddress = getFeedAddressVsUsd(chainlinkFeedsConfig, token.symbol);
        if (!tokenUsdFeedAddress) {
             logger.warn(`${logPrefix} Conversion for non-stable ${token.symbol} requires its /USD feed.`);
             return null; // Cannot convert without the feed
        }
        tokenUsdPriceScaled = await getUsdPriceDataScaled(provider, tokenUsdFeedAddress);
        if (tokenUsdPriceScaled === null) {
             logger.warn(`${logPrefix} Failed to get ${token.symbol}/USD price.`);
             return null;
        }
    }

    // --- Calculate Native Value ---
    try {
        // ValueUSD_Scaled = (AmountTokenWei * tokenUsdPriceScaled) / 10^tokenDec
        const valueUsdScaled = (amountToken * tokenUsdPriceScaled) / (10n ** BigInt(token.decimals));

        // ValueNativeWei = (ValueUSD_Scaled * 10^nativeDec) / nativeUsdPriceScaled (ETH/USD price)
        const nativeValueWei = (valueUsdScaled * (10n ** BigInt(nativeDecimals))) / nativeUsdPriceScaled;

        logger.debug(`${logPrefix} Converted ${ethers.formatUnits(amountToken, token.decimals)} ${token.symbol} -> ${ethers.formatUnits(nativeValueWei, nativeDecimals)} ${nativeSymbol}`);
        return nativeValueWei;

    } catch (error) {
        logger.error(`${logPrefix} Error during conversion calculation via USD: ${error.message}`);
        return null;
    }
}

module.exports = {
    convertTokenAmountToNative,
};
