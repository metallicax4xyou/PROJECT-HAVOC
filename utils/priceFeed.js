// utils/priceFeed.js
// --- VERSION v1.3 ---
// Added detailed logging to getUsdPriceDataScaled

const { ethers } = require('ethers');
const logger = require('./logger');
const { ArbitrageError } = require('./errorHandler');
const { TOKENS } = require('../constants/tokens');

const CHAINLINK_ABI = [
    "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
    "function decimals() view returns (uint8)"
];

const feedContractCache = {};
const feedDecimalsCache = {};
const USD_PRICE_PRECISION = 10n**18n;

function getFeedAddressVsUsd(chainlinkFeedsConfig, tokenSymbol) { /* ... unchanged ... */
    let symbolForLookup = tokenSymbol; if (tokenSymbol === 'USDC.e') symbolForLookup = 'USDC'; else if (tokenSymbol === 'WETH') symbolForLookup = 'ETH'; const usdFeedKey = `${symbolForLookup}/USD`; if (chainlinkFeedsConfig && chainlinkFeedsConfig[usdFeedKey]) { logger.debug(`[PriceFeed] Found USD feed key: ${usdFeedKey} for original ${tokenSymbol}`); return chainlinkFeedsConfig[usdFeedKey]; } else { logger.warn(`[PriceFeed] No Chainlink /USD feed found for ${tokenSymbol} (lookup: ${usdFeedKey})`); return null; }
}

/**
 * Fetches the latest price from a Chainlink feed vs USD. Includes detailed logging.
 */
async function getUsdPriceDataScaled(provider, feedAddress) {
    const logPrefix = `[PriceFeed ${feedAddress.substring(0, 6)}]`;
    logger.debug(`${logPrefix} Attempting to fetch USD price data...`); // Log entry

    if (!provider || typeof provider.getNetwork !== 'function') { // Basic provider check
        logger.error(`${logPrefix} Invalid provider object received.`);
        return null;
    }
    if (!feedAddress || !ethers.isAddress(feedAddress)) {
        logger.error(`${logPrefix} Invalid feed address: ${feedAddress}`);
        return null;
    }

    let feedContract;
    try {
        // Check cache first
        if (!feedContractCache[feedAddress]) {
            logger.debug(`${logPrefix} Creating new contract instance...`);
            // *** Log provider state before creating contract ***
            const network = await provider.getNetwork();
            logger.debug(`${logPrefix} Provider network check before contract creation: ${network.name} (ID: ${network.chainId})`);
            feedContractCache[feedAddress] = new ethers.Contract(feedAddress, CHAINLINK_ABI, provider);
            logger.debug(`${logPrefix} Contract instance created.`);
        } else {
             logger.debug(`${logPrefix} Using cached contract instance.`);
        }
        feedContract = feedContractCache[feedAddress];

        // Use cache or fetch decimals
        let feedDecimals = feedDecimalsCache[feedAddress];
        if (feedDecimals === undefined) {
            logger.debug(`${logPrefix} Fetching decimals...`);
            try {
                feedDecimals = Number(await feedContract.decimals());
                 logger.debug(`${logPrefix} Decimals call successful: ${feedDecimals}`);
                feedDecimalsCache[feedAddress] = feedDecimals;
            } catch (decimalError) {
                 logger.error(`${logPrefix} Error calling decimals(): ${decimalError.message}`, decimalError);
                 throw new Error(`Failed to fetch decimals: ${decimalError.message}`); // Re-throw to be caught below
            }
        } else {
             logger.debug(`${logPrefix} Using cached decimals: ${feedDecimals}`);
        }

        // Fetch latest round data
        logger.debug(`${logPrefix} Fetching latestRoundData...`);
        let roundData;
        try {
            roundData = await feedContract.latestRoundData();
             logger.debug(`${logPrefix} latestRoundData call successful.`);
        } catch (roundError) {
            logger.error(`${logPrefix} Error calling latestRoundData(): ${roundError.message}`, roundError);
            throw new Error(`Failed to fetch round data: ${roundError.message}`); // Re-throw
        }

        const price = BigInt(roundData.answer);
        if (price <= 0n) { logger.warn(`${logPrefix} Non-positive price: ${price}`); return null; }

        const priceScaled = (price * USD_PRICE_PRECISION) / (10n ** BigInt(feedDecimals));
        logger.debug(`${logPrefix} Fetched raw price: ${price} (Dec: ${feedDecimals}), Scaled USD Price (18 Dec): ${priceScaled}`);
        return priceScaled;

    } catch (error) {
        // Catch errors from contract creation or re-thrown errors from calls
        logger.error(`${logPrefix} Error during price data fetch: ${error.message}`);
        // *** This might be the source of the generic error message ***
        // Let's return null instead of re-throwing the generic error here
        return null;
        // throw new Error(`Failed interacting with feed ${feedAddress}: ${error.message}`); // Avoid re-throwing generic error
    }
}

/**
 * Converts a token amount (in wei) to native currency (ETH wei) using USD feeds.
 */
async function convertTokenAmountToNative(amountTokenWei, token, chainlinkFeedsConfig, nativeSymbol, nativeDecimals, provider) {
    // ... (Function logic remains unchanged, relies on updated getUsdPriceDataScaled) ...
    const logPrefix = `[PriceFeedConvert ${token?.symbol}->${nativeSymbol}]`; if (!amountTokenWei || !token?.symbol || !token?.decimals || !chainlinkFeedsConfig || !nativeSymbol || !nativeDecimals || !provider) { logger.error(`${logPrefix} Invalid arguments.`); return null; } const amountToken = BigInt(amountTokenWei); if (amountToken === 0n) return 0n; if (token.symbol === nativeSymbol || (token.symbol === 'WETH' && nativeSymbol === 'ETH')) { return amountToken; } const tokenUsdFeedAddress = getFeedAddressVsUsd(chainlinkFeedsConfig, token.symbol); if (!tokenUsdFeedAddress) return null; const tokenUsdPriceScaled = await getUsdPriceDataScaled(provider, tokenUsdFeedAddress); if (tokenUsdPriceScaled === null) return null; const nativeUsdFeedAddress = getFeedAddressVsUsd(chainlinkFeedsConfig, nativeSymbol); if (!nativeUsdFeedAddress) return null; const nativeUsdPriceScaled = await getUsdPriceDataScaled(provider, nativeUsdFeedAddress); if (nativeUsdPriceScaled === null || nativeUsdPriceScaled <= 0n) { logger.error(`${logPrefix} Failed valid ${nativeSymbol}/USD price.`); return null; } try { const valueUsdScaled = (amountToken * tokenUsdPriceScaled) / (10n ** BigInt(token.decimals)); const nativeValueWei = (valueUsdScaled * (10n ** BigInt(nativeDecimals))) / nativeUsdPriceScaled; logger.debug(`${logPrefix} Converted ${ethers.formatUnits(amountToken, token.decimals)} ${token.symbol} -> ${ethers.formatUnits(nativeValueWei, nativeDecimals)} ${nativeSymbol} (via USD feeds)`); return nativeValueWei; } catch (error) { logger.error(`${logPrefix} Error during conversion calc via USD: ${error.message}`); return null; }
}

module.exports = { convertTokenAmountToNative };
