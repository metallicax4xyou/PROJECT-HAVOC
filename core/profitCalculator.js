// core/profitCalculator.js
// --- VERSION REVERTED TO ACCEPT config AND provider SEPARATELY ---

const { ethers } = require('ethers');
const logger = require('../utils/logger');
const { getChainlinkPriceData, convertTokenAmountToWei } = require('../utils/priceFeed');
const { ArbitrageError } = require('../utils/errorHandler');
const { TOKENS } = require('../constants/tokens');

class ProfitCalculator {
    /**
     * @param {object} config Configuration object (MIN_PROFIT_THRESHOLDS, PROFIT_BUFFER_PERCENT, etc.)
     * @param {ethers.Provider} provider Ethers provider instance.
     */
    constructor(config, provider) { // Reverted to separate args
        logger.debug('[ProfitCalculator] Initializing...');

        // --- Validate Inputs ---
        if (!config || typeof config !== 'object') {
             throw new ArbitrageError('InitializationError', 'ProfitCalculator: Invalid or missing config object.');
        }
        if (!provider) { // Check the separate provider argument
             throw new ArbitrageError('InitializationError', 'ProfitCalculator: Provider instance is required.');
        }
        // Check required keys within the config object
        const requiredConfigKeys = ['MIN_PROFIT_THRESHOLDS', 'PROFIT_BUFFER_PERCENT', 'CHAINLINK_FEEDS', 'NATIVE_CURRENCY_SYMBOL'];
        const missingKeys = requiredConfigKeys.filter(key => !(key in config) || config[key] === null || config[key] === undefined);
        if (missingKeys.length > 0) {
            // Reference the config object passed in the error message
            throw new Error(`[ProfitCalculator] Invalid config object provided. Missing keys: ${missingKeys.join(', ')}`);
        }
        // Further validation of nested objects
        if (typeof config.MIN_PROFIT_THRESHOLDS !== 'object' || !config.MIN_PROFIT_THRESHOLDS.NATIVE || !config.MIN_PROFIT_THRESHOLDS.DEFAULT) {
            throw new Error(`[ProfitCalculator] config.MIN_PROFIT_THRESHOLDS must be an object with NATIVE and DEFAULT keys.`);
        }
         if (typeof config.CHAINLINK_FEEDS !== 'object' || Object.keys(config.CHAINLINK_FEEDS).length === 0) {
             throw new Error(`[ProfitCalculator] config.CHAINLINK_FEEDS must be a non-empty object.`);
         }

        // --- Store dependencies ---
        this.config = config; // Store the config object
        this.provider = provider; // Store the separate provider instance
        this.minProfitThresholdsConfig = this.config.MIN_PROFIT_THRESHOLDS;
        this.profitBufferPercent = ethers.toBigInt(this.config.PROFIT_BUFFER_PERCENT);
        this.chainlinkFeeds = this.config.CHAINLINK_FEEDS; // Get feeds from the config object
        this.nativeSymbol = this.config.NATIVE_CURRENCY_SYMBOL || 'ETH';
        this.wrappedNativeSymbol = this.config.WRAPPED_NATIVE_SYMBOL || 'WETH';

        // Native token lookup (no change needed here)
        this.nativeToken = Object.values(TOKENS).find(t => t.type === 'native' || t.symbol === this.nativeSymbol)
                        || Object.values(TOKENS).find(t => t.symbol === this.nativeSymbol);
         if (!this.nativeToken) {
             logger.warn(`[ProfitCalculator] Could not find native token details for '${this.nativeSymbol}'. Using default decimals 18.`);
             this.nativeDecimals = 18;
         } else {
             this.nativeDecimals = this.nativeToken.decimals;
         }

        if (this.profitBufferPercent < 0n || this.profitBufferPercent > 100n) {
             throw new Error("[ProfitCalculator] PROFIT_BUFFER_PERCENT must be between 0 and 100.");
        }
        logger.info(`[ProfitCalculator] Initialized with Dynamic Thresholds (Buffer: ${this.profitBufferPercent.toString()}%). Default: ${this.minProfitThresholdsConfig.DEFAULT} ${this.nativeSymbol}`);
    }

    // --- _getMinProfitThresholdWei, calculateNetProfit, and other helpers remain unchanged ---
    // (Paste the previous implementations of these methods here if you don't have them)
    _getMinProfitThresholdWei(profitToken) {
        if (!profitToken || typeof profitToken !== 'object' || !profitToken.decimals || !profitToken.symbol) {
            throw new Error('[ProfitCalculator] Invalid profitToken provided to _getMinProfitThresholdWei.');
        }
        const canonicalSymbol = profitToken.canonicalSymbol || profitToken.symbol;
        let thresholdStr, thresholdTokenDecimals, thresholdTokenSymbol;

        if (profitToken.symbol === this.nativeSymbol || profitToken.symbol === this.wrappedNativeSymbol) {
            thresholdStr = this.minProfitThresholdsConfig.NATIVE;
            thresholdTokenDecimals = this.nativeDecimals;
            thresholdTokenSymbol = this.nativeSymbol;
        } else if (this.minProfitThresholdsConfig[canonicalSymbol]) {
            thresholdStr = this.minProfitThresholdsConfig[canonicalSymbol];
            thresholdTokenDecimals = profitToken.decimals;
            thresholdTokenSymbol = canonicalSymbol;
        } else {
            thresholdStr = this.minProfitThresholdsConfig.DEFAULT;
            thresholdTokenDecimals = this.nativeDecimals;
            thresholdTokenSymbol = this.nativeSymbol;
        }
        logger.debug(`[ProfitCalculator] Using threshold for ${profitToken.symbol}: ${thresholdStr} (${thresholdTokenSymbol})`);

        if (!thresholdStr) throw new Error(`Could not determine threshold string for token ${profitToken.symbol}.`);

        try {
            const thresholdWei = ethers.parseUnits(thresholdStr, thresholdTokenDecimals);
            logger.debug(`[ProfitCalculator] Parsed threshold for ${thresholdTokenSymbol}: ${thresholdStr} -> ${thresholdWei.toString()} Wei`);
            return thresholdWei;
        } catch (e) {
            logger.error(`[ProfitCalculator] Failed to parse threshold "${thresholdStr}" for ${thresholdTokenSymbol} (Decimals: ${thresholdTokenDecimals}): ${e.message}`);
            throw new Error(`Failed to parse profit threshold string: ${thresholdStr}`);
        }
    }

    // calculateNetProfit - ASSUMING THIS WAS THE PREVIOUS VERSION
    // If your previous calculateNetProfit used this.provider, it will now work correctly.
    // If your previous calculate was the simpler version from early stages, update it
    // For now, using the structure from Response #18 as calculate() - needs async if using provider
    calculate(opportunities) { // Mark as async if _convertGrossProfitToWei or gas estimation is used
        if (!opportunities || !Array.isArray(opportunities)) { return []; }
        logger.info(`[ProfitCalculator] Evaluating ${opportunities.length} potential opportunities...`);
        const profitableTrades = [];

        for (const opportunity of opportunities) {
            if (!opportunity?.type || !opportunity.amountIn || !opportunity.amountOut || !opportunity.tokenIn || !opportunity.tokenOut) {
                logger.warn('[ProfitCalculator] Skipping malformed opportunity:', opportunity); continue;
            }
            const tokenInSymbol = opportunity.tokenIn;
            const profitThreshold = this.minProfitThresholdsConfig[tokenInSymbol] || this.minProfitThresholdsConfig.DEFAULT; // Simple lookup for now

            if (profitThreshold === undefined || profitThreshold === null) {
                logger.warn(`[ProfitCalculator] No min profit threshold for ${tokenInSymbol} or DEFAULT. Skipping.`); continue;
            }

            try {
                 const amountInBN = ethers.BigNumber.from(opportunity.amountIn);
                 const amountOutBN = ethers.BigNumber.from(opportunity.amountOut);

                 // Simple check - needs gas estimation later
                 const profitAmountBN = amountOutBN.sub(amountInBN);
                 const thresholdBN = ethers.BigNumber.from(profitThreshold); // Needs parsing based on decimals

                 // TODO: Improve threshold comparison (parseUnits based on tokenIn decimals)
                 // For now, assumes threshold is also in tokenIn units and comparable scale
                 if (profitAmountBN.gt(thresholdBN)) {
                      let profitPercentage = 0;
                      if (!amountInBN.isZero()) {
                           const profitScaled = profitAmountBN.mul(1000000);
                           const percentageScaled = profitScaled.div(amountInBN);
                           profitPercentage = percentageScaled.toNumber() / 10000;
                      }
                     logger.info(`[ProfitCalculator] PROFITABLE (Basic Check): Type: ${opportunity.type}, Token: ${tokenInSymbol}, Profit: ${profitAmountBN.toString()}, Threshold: ${profitThreshold}, %: ${profitPercentage.toFixed(4)}%`);
                     profitableTrades.push({
                         ...opportunity,
                         profitAmount: profitAmountBN.toString(),
                         profitPercentage: profitPercentage,
                         threshold: profitThreshold,
                         timestamp: Date.now()
                     });
                 }

            } catch (error) {
                logger.error(`[ProfitCalculator] Error processing opportunity: ${error.message}`, { opportunity });
                ErrorHandler.handleError(error, 'ProfitCalculation');
            }
        }
        logger.info(`[ProfitCalculator] Found ${profitableTrades.length} profitable trades (basic check).`);
        return profitableTrades;
    }

    // ... other helpers (_convertGrossProfitToWei, _format, _prepareDetails, _logProfitDetails, _formatResult)
    // Make sure these helpers correctly use this.provider and this.chainlinkFeeds
}

module.exports = ProfitCalculator;
