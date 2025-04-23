// utils/priceFeed.js
// --- VERSION v1.1 ---
// Handles USDC.e aliasing for feed lookup.

const { ethers } = require('ethers');
const logger = require('./logger');
const { ArbitrageError } = require('./errorHandler');
const { TOKENS } = require('../constants/tokens');

const CHAINLINK_ABI = [ /* ... ABI as before ... */
    "function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
    "function decimals() external view returns (uint8)"
];

const feedContractCache = {};
const feedDecimalsCache = {};

/**
 * Gets the Chainlink price feed address for a given pair vs native.
 * Handles direct/inverse pairs and aliases USDC.e to USDC.
 */
function getFeedAddress(chainlinkFeedsConfig, tokenSymbol, nativeSymbol) {
    let baseSymbolForLookup = tokenSymbol;

    // *** ALIASING LOGIC ***
    // If looking for USDC.e feed, try using the USDC feed instead
    if (tokenSymbol === 'USDC.e') {
        logger.debug(`[PriceFeed] Aliasing USDC.e to USDC for feed lookup vs ${nativeSymbol}.`);
        baseSymbolForLookup = 'USDC';
    }
    // Add other aliases if needed (e.g., USDT.e -> USDT)
    // else if (tokenSymbol === 'USDT.e') { baseSymbolForLookup = 'USDT'; }

    const directKey = `${baseSymbolForLookup}/${nativeSymbol}`; // e.g., USDC/ETH
    const inverseKey = `${nativeSymbol}/${baseSymbolForLookup}`; // e.g., ETH/USDC

    if (chainlinkFeedsConfig[directKey]) {
        logger.debug(`[PriceFeed] Found direct feed key: ${directKey}`);
        return { feedAddress: chainlinkFeedsConfig[directKey], inverse: false };
    } else if (chainlinkFeedsConfig[inverseKey]) {
         logger.debug(`[PriceFeed] Found inverse feed key: ${inverseKey}`);
        return { feedAddress: chainlinkFeedsConfig[inverseKey], inverse: true };
    } else {
        // Log the original token symbol in the warning
        logger.warn(`[PriceFeed] No Chainlink feed found for ${tokenSymbol} (or alias ${baseSymbolForLookup}) vs ${nativeSymbol}`);
        return { feedAddress: null, inverse: false };
    }
}

/**
 * Fetches the latest price from a Chainlink feed.
 */
async function getChainlinkPriceData(provider, feedAddress) { /* ... unchanged ... */
    const logPrefix = `[PriceFeed ${feedAddress.substring(0, 6)}]`; if (!provider || !feedAddress || !ethers.isAddress(feedAddress)) { logger.error(`${logPrefix} Invalid provider or feed address.`); return null; } try { if (!feedContractCache[feedAddress]) { feedContractCache[feedAddress] = new ethers.Contract(feedAddress, CHAINLINK_ABI, provider); } const feedContract = feedContractCache[feedAddress]; let feedDecimals = feedDecimalsCache[feedAddress]; if (feedDecimals === undefined) { feedDecimals = await feedContract.decimals(); feedDecimalsCache[feedAddress] = Number(feedDecimals); logger.debug(`${logPrefix} Fetched feed decimals: ${feedDecimals}`); } const roundData = await feedContract.latestRoundData(); const price = BigInt(roundData.answer); if (price <= 0n) { logger.warn(`${logPrefix} Chainlink feed returned non-positive price: ${price}`); return null; } logger.debug(`${logPrefix} Fetched price: ${price} (Decimals: ${feedDecimals})`); return { price: price, decimals: feedDecimals }; } catch (error) { logger.error(`${logPrefix} Error fetching Chainlink price: ${error.message}`); return null; }
}

/**
 * Converts a token amount (in wei) to its equivalent value in the native currency (ETH wei).
 */
async function convertTokenAmountToNative(amountWei, token, chainlinkFeedsConfig, nativeSymbol, nativeDecimals, provider) {
    const logPrefix = `[PriceFeedConvert ${token?.symbol}]`;
    if (!amountWei || !token || !chainlinkFeedsConfig || !nativeSymbol || !nativeDecimals || !provider) { logger.error(`${logPrefix} Invalid arguments for conversion.`); return null; }

    const tokenSymbol = token.symbol; const tokenDecimals = token.decimals;
    if (tokenSymbol === nativeSymbol) { if (tokenDecimals !== nativeDecimals) { logger.warn(`${logPrefix} Native token decimal mismatch (${tokenDecimals} vs ${nativeDecimals}).`); } return BigInt(amountWei); }

    // *** Use the updated getFeedAddress ***
    const { feedAddress, inverse } = getFeedAddress(chainlinkFeedsConfig, tokenSymbol, nativeSymbol);
    if (!feedAddress) { return null; } // Warning already logged by getFeedAddress

    const priceData = await getChainlinkPriceData(provider, feedAddress);
    if (!priceData) { logger.warn(`${logPrefix} Failed to get price data from feed ${feedAddress}.`); return null; }

    const price = priceData.price; const feedDecimals = priceData.decimals;
    try {
        let nativeValueWei; const amount = BigInt(amountWei); const scaleFactorToken = 10n ** BigInt(tokenDecimals); const scaleFactorNative = 10n ** BigInt(nativeDecimals); const scaleFactorFeed = 10n ** BigInt(feedDecimals);
        if (!inverse) { // Feed is Token/ETH (price = ETH per Token)
            nativeValueWei = (amount * price * scaleFactorNative) / (scaleFactorToken * scaleFactorFeed); logger.debug(`${logPrefix} Converted ${tokenSymbol}->${nativeSymbol} (Direct Feed): ${nativeValueWei} Wei`);
        } else { // Feed is ETH/Token (price = Token per ETH)
            const numerator = amount * scaleFactorFeed * scaleFactorNative; const denominator = scaleFactorToken * price; if (denominator === 0n) { throw new Error("Division by zero (inverse)."); } nativeValueWei = numerator / denominator; logger.debug(`${logPrefix} Converted ${tokenSymbol}->${nativeSymbol} (Inverse Feed): ${nativeValueWei} Wei`);
        }
        return nativeValueWei;
    } catch (error) { logger.error(`${logPrefix} Error during conversion calc: ${error.message}`); return null; }
}

module.exports = {
    getChainlinkPriceData,
    convertTokenAmountToNative
};
