// core/profitCalculator.js
// --- VERSION UPDATED FOR Dynamic Thresholds & Ethers V6 Utils ---

const { ethers } = require('ethers'); // Ethers v6+
const logger = require('../utils/logger');
const { getChainlinkPriceData, convertTokenAmountToWei } = require('../utils/priceFeed'); // Ensure this uses ethers v6 if needed
const { ArbitrageError } = require('../utils/errorHandler');
const { TOKENS } = require('../constants/tokens'); // Import TOKENS to find native token details

class ProfitCalculator {
    /**
     * @param {object} config Configuration object containing parsed values.
     * @param {object} config.MIN_PROFIT_THRESHOLDS Object mapping canonical symbols/NATIVE/DEFAULT to min profit strings.
     * @param {number} config.PROFIT_BUFFER_PERCENT Safety buffer percentage for net profit comparison.
     * @param {ethers.Provider} config.provider Ethers provider instance (needed for priceFeed).
     * @param {object} config.chainlinkFeeds Map of Chainlink feeds for price conversion.
     * @param {string} [config.NATIVE_CURRENCY_SYMBOL='ETH'] Symbol of the native currency.
     * @param {string} [config.WRAPPED_NATIVE_SYMBOL='WETH'] Symbol for wrapped native token.
     */
    constructor(config) {
        // --- *** MODIFIED CONSTRUCTOR TO ACCEPT MIN_PROFIT_THRESHOLDS *** ---
        const requiredKeys = ['MIN_PROFIT_THRESHOLDS', 'PROFIT_BUFFER_PERCENT', 'provider', 'chainlinkFeeds', 'NATIVE_CURRENCY_SYMBOL'];
        const missingKeys = requiredKeys.filter(key => !(key in config));
        if (missingKeys.length > 0) {
            throw new Error(`[ProfitCalculator] Invalid configuration provided. Missing keys: ${missingKeys.join(', ')}`);
        }
        if (typeof config.MIN_PROFIT_THRESHOLDS !== 'object' || config.MIN_PROFIT_THRESHOLDS === null) {
            throw new Error(`[ProfitCalculator] config.MIN_PROFIT_THRESHOLDS must be an object. Received: ${typeof config.MIN_PROFIT_THRESHOLDS}`);
        }
        if (!config.MIN_PROFIT_THRESHOLDS.NATIVE || !config.MIN_PROFIT_THRESHOLDS.DEFAULT) {
             throw new Error(`[ProfitCalculator] config.MIN_PROFIT_THRESHOLDS must contain 'NATIVE' and 'DEFAULT' keys.`);
        }

        this.minProfitThresholdsConfig = config.MIN_PROFIT_THRESHOLDS;
        this.profitBufferPercent = ethers.toBigInt(config.PROFIT_BUFFER_PERCENT);
        this.provider = config.provider;
        this.chainlinkFeeds = config.chainlinkFeeds;
        this.nativeSymbol = config.NATIVE_CURRENCY_SYMBOL || 'ETH'; // Use symbol from main config
        // Find native token details (needed for default threshold conversion)
        this.nativeToken = Object.values(TOKENS).find(t => t.type === 'native' || t.symbol === this.nativeSymbol);
         if (!this.nativeToken) {
             // Fallback if type 'native' isn't set, check by symbol directly
             this.nativeToken = Object.values(TOKENS).find(t => t.symbol === this.nativeSymbol);
             if(!this.nativeToken) {
                 logger.warn(`[ProfitCalculator] Could not find native token details for '${this.nativeSymbol}' in constants/tokens.js. Using default decimals 18.`);
                 this.nativeDecimals = 18; // Default if lookup fails
             } else {
                 this.nativeDecimals = this.nativeToken.decimals;
             }
         } else {
             this.nativeDecimals = this.nativeToken.decimals;
         }

        this.wrappedNativeSymbol = config.WRAPPED_NATIVE_SYMBOL || 'WETH'; // Get from main config if possible

        if (this.profitBufferPercent < 0n || this.profitBufferPercent > 100n) {
             throw new Error("[ProfitCalculator] PROFIT_BUFFER_PERCENT must be between 0 and 100.");
        }
        logger.info(`[ProfitCalculator] Initialized with Dynamic Thresholds (Buffer: ${this.profitBufferPercent.toString()}%). Default: ${this.minProfitThresholdsConfig.DEFAULT} ${this.nativeSymbol}`);
    }

    // --- *** NEW HELPER FUNCTION *** ---
    /**
     * Gets the minimum profit threshold in Wei for a given token.
     * Uses the token's canonical symbol to look up the threshold in the config.
     * Falls back to NATIVE or DEFAULT threshold if specific symbol is not found.
     * @param {Token} profitToken The token object (e.g., from @uniswap/sdk-core) representing the profit currency.
     * @returns {bigint} The minimum profit threshold in Wei.
     * @throws {Error} If the profitToken is invalid or threshold parsing fails.
     */
    _getMinProfitThresholdWei(profitToken) {
        if (!profitToken || typeof profitToken !== 'object' || !profitToken.decimals || !profitToken.symbol) {
            throw new Error('[ProfitCalculator] Invalid profitToken provided to _getMinProfitThresholdWei.');
        }

        const canonicalSymbol = profitToken.canonicalSymbol || profitToken.symbol;
        let thresholdStr;
        let thresholdTokenDecimals;
        let thresholdTokenSymbol;

        // Prioritize NATIVE key if the profit token is the native currency
        if (profitToken.symbol === this.nativeSymbol || profitToken.symbol === this.wrappedNativeSymbol) {
            thresholdStr = this.minProfitThresholdsConfig.NATIVE;
            thresholdTokenDecimals = this.nativeDecimals;
            thresholdTokenSymbol = this.nativeSymbol;
            logger.debug(`[ProfitCalculator] Using NATIVE threshold for ${profitToken.symbol}: ${thresholdStr}`);
        }
        // Check if a specific threshold exists for the token's canonical symbol
        else if (this.minProfitThresholdsConfig[canonicalSymbol]) {
            thresholdStr = this.minProfitThresholdsConfig[canonicalSymbol];
            thresholdTokenDecimals = profitToken.decimals; // Use profit token's decimals
            thresholdTokenSymbol = canonicalSymbol;
            logger.debug(`[ProfitCalculator] Using specific threshold for ${canonicalSymbol}: ${thresholdStr}`);
        }
        // Fallback to the DEFAULT threshold (assumed to be in native currency)
        else {
            thresholdStr = this.minProfitThresholdsConfig.DEFAULT;
            thresholdTokenDecimals = this.nativeDecimals; // Use native decimals for default
            thresholdTokenSymbol = this.nativeSymbol; // Default is in native
             logger.debug(`[ProfitCalculator] Using DEFAULT threshold (${thresholdStr} ${thresholdTokenSymbol}) for ${profitToken.symbol}`);
        }

        if (!thresholdStr) {
            // Should not happen if NATIVE and DEFAULT exist, but as a safeguard
            throw new Error(`[ProfitCalculator] Could not determine threshold string for token ${profitToken.symbol}. Check config.`);
        }

        try {
            // Convert the string threshold (e.g., "10.0", "0.001") to Wei using the correct decimals
            const thresholdWei = ethers.parseUnits(thresholdStr, thresholdTokenDecimals);
            logger.debug(`[ProfitCalculator] Parsed threshold for ${thresholdTokenSymbol}: ${thresholdStr} -> ${thresholdWei.toString()} Wei`);
            return thresholdWei;
        } catch (e) {
            logger.error(`[ProfitCalculator] Failed to parse threshold string "${thresholdStr}" for ${thresholdTokenSymbol} with decimals ${thresholdTokenDecimals}: ${e.message}`);
            throw new Error(`Failed to parse profit threshold string: ${thresholdStr}`);
        }
    }
    // --- *** END NEW HELPER FUNCTION *** ---


    /**
     * Calculates net profit and checks profitability against the configured dynamic threshold and buffer.
     */
    async calculateNetProfit({ simulationResult, gasEstimate, feeData }) {
        const functionSig = `[ProfitCalculator]`;

        // Basic Input Validation
        if (!simulationResult || typeof simulationResult.profitable !== 'boolean' || typeof simulationResult.grossProfit !== 'bigint' || !simulationResult.details?.tokenA) {
            logger.warn(`${functionSig} Invalid simulationResult received.`);
            return this._formatResult(false, null, null, null, null, {});
        }
        if (typeof gasEstimate !== 'bigint' || gasEstimate <= 0n) {
             logger.warn(`${functionSig} Invalid gasEstimate received: ${gasEstimate}`);
             return this._formatResult(false, null, null, null, null, {});
        }
        const gasPriceForCost = feeData?.maxFeePerGas || feeData?.gasPrice;
        if (!feeData || !gasPriceForCost || typeof gasPriceForCost !== 'bigint' || gasPriceForCost <= 0n) {
             logger.warn(`${functionSig} Invalid feeData received. Gas Price for Cost: ${gasPriceForCost}`);
             return this._formatResult(false, null, null, null, null, {});
        }
        // --- End Validation ---

        const { grossProfit } = simulationResult;
        const profitToken = simulationResult.details.tokenA; // Token profit is denominated in
        const estimatedGasCostWei = gasEstimate * gasPriceForCost;

        // Handle non-positive gross profit
        if (!simulationResult.profitable || grossProfit <= 0n) {
            logger.debug(`${functionSig} Gross profit (${this._format(grossProfit, profitToken.decimals)} ${profitToken.symbol}) is zero or negative. Not profitable.`);
            // No need to convert profit if it's not positive
            const details = this._prepareDetails(grossProfit, null, estimatedGasCostWei, null, null, profitToken, gasEstimate, feeData, null);
            this._logProfitDetails(details, false);
            return this._formatResult(false, null, estimatedGasCostWei, null, null, details);
        }

        // --- Steps for Positive Gross Profit ---
        // Convert gross profit to native token (Wei) for comparison with gas cost
        const grossProfitWei = await this._convertGrossProfitToWei(grossProfit, profitToken, functionSig);
        if (grossProfitWei === null || grossProfitWei <= 0n) {
            logger.warn(`${functionSig} Converted gross profit in Wei is null or not positive for ${profitToken.symbol}. Assuming not profitable.`);
            const details = this._prepareDetails(grossProfit, grossProfitWei, estimatedGasCostWei, null, null, profitToken, gasEstimate, feeData, null);
            this._logProfitDetails(details, false);
            return this._formatResult(false, grossProfitWei, estimatedGasCostWei, null, null, details);
        }

        const netProfitWei = grossProfitWei - estimatedGasCostWei;
        if (netProfitWei <= 0n) {
             logger.info(`${functionSig} Net profit (${this._format(netProfitWei)} ${this.nativeSymbol}) is zero or negative after gas cost. Not profitable.`);
             const details = this._prepareDetails(grossProfit, grossProfitWei, estimatedGasCostWei, netProfitWei, null, profitToken, gasEstimate, feeData, null);
             this._logProfitDetails(details, false);
             return this._formatResult(false, grossProfitWei, estimatedGasCostWei, netProfitWei, null, details);
        }

        // Apply profit buffer
        let bufferedNetProfitWei = netProfitWei;
        if (this.profitBufferPercent > 0n) {
             const bufferMultiplier = 100n - this.profitBufferPercent;
             bufferedNetProfitWei = (bufferMultiplier > 0n) ? (netProfitWei * bufferMultiplier) / 100n : 0n;
        }

        // --- *** USE DYNAMIC THRESHOLD *** ---
        let minProfitThresholdWei;
        try {
             minProfitThresholdWei = this._getMinProfitThresholdWei(profitToken);
        } catch (thresholdError) {
             logger.error(`${functionSig} Error getting min profit threshold: ${thresholdError.message}. Aborting check.`);
             const details = this._prepareDetails(grossProfit, grossProfitWei, estimatedGasCostWei, netProfitWei, bufferedNetProfitWei, profitToken, gasEstimate, feeData, null); // Pass null threshold
             this._logProfitDetails(details, false);
             return this._formatResult(false, grossProfitWei, estimatedGasCostWei, netProfitWei, bufferedNetProfitWei, details);
        }

        const isProfitable = bufferedNetProfitWei >= minProfitThresholdWei;
        // --- *** END DYNAMIC THRESHOLD CHECK *** ---


        // --- Logging & Formatting ---
        const details = this._prepareDetails(grossProfit, grossProfitWei, estimatedGasCostWei, netProfitWei, bufferedNetProfitWei, profitToken, gasEstimate, feeData, minProfitThresholdWei);
        this._logProfitDetails(details, isProfitable);

        return this._formatResult(isProfitable, grossProfitWei, estimatedGasCostWei, netProfitWei, bufferedNetProfitWei, details);
    }

    /** Helper to convert gross profit in token units to Wei (returns BigInt or null) */
    async _convertGrossProfitToWei(grossProfitAmount, sdkToken, logPrefix) {
        const grossProfitBigInt = ethers.toBigInt(grossProfitAmount);
        // Check if profit is already in native or wrapped native
        if (sdkToken.symbol === this.nativeSymbol || sdkToken.symbol === this.wrappedNativeSymbol) {
            if(sdkToken.decimals !== this.nativeDecimals){
                 logger.warn(`${logPrefix} Profit token ${sdkToken.symbol} matches native/wrapped but decimals mismatch (${sdkToken.decimals} vs ${this.nativeDecimals}). Returning unconverted.`);
                 // Decide how to handle this edge case - maybe throw error or attempt conversion anyway? For now, return as is.
                 return grossProfitBigInt; // Or potentially adjust based on decimals? Risky.
            }
            logger.debug(`${logPrefix} Gross profit is already in native/wrapped native token (${sdkToken.symbol}).`);
            return grossProfitBigInt;
        }

        logger.debug(`${logPrefix} Gross profit in ${sdkToken.symbol}. Fetching price vs ${this.nativeSymbol} via Chainlink...`);
        try {
            // Ensure getChainlinkPriceData can handle the token pair dynamically
             const priceData = await getChainlinkPriceData(this.provider, this.chainlinkFeeds, sdkToken.symbol, this.nativeSymbol);
            if (priceData) {
                // Ensure convertTokenAmountToWei handles BigInts and decimals correctly
                const convertedWei = convertTokenAmountToWei(grossProfitBigInt, sdkToken.decimals, priceData, this.nativeDecimals);
                if (convertedWei !== null) {
                     const convertedBigInt = ethers.toBigInt(convertedWei);
                     logger.debug(`${logPrefix} Converted gross profit: ${this._format(grossProfitBigInt, sdkToken.decimals)} ${sdkToken.symbol} -> ${this._format(convertedBigInt)} ${this.nativeSymbol}`);
                     return convertedBigInt;
                } else {
                    logger.warn(`${logPrefix} convertTokenAmountToWei returned null for ${sdkToken.symbol}.`);
                    return null;
                }
            } else {
                 logger.warn(`${logPrefix} No Chainlink price data found for ${sdkToken.symbol}/${this.nativeSymbol}.`);
                 return null;
             }
        } catch (error) {
            logger.error(`${logPrefix} Error converting gross profit for ${sdkToken.symbol} to Wei: ${error.message}`);
            return null;
        }
    }

     /** Helper to format BigNumberish values for logging */
    _format(value, decimals = this.nativeDecimals) {
         if (value === null || typeof value === 'undefined') return 'N/A';
         try {
              // Use fixed precision for readability, especially for ETH values
              const precision = (decimals === this.nativeDecimals) ? 8 : 4; // More decimals for ETH, fewer for others
              return ethers.formatUnits(value, decimals); // Consider using toFixed() after formatUnits for display trimming
         } catch (formatError) {
             logger.warn(`[ProfitCalculator _format] Error formatting value: ${value?.toString()} with decimals ${decimals}`, formatError);
             return 'Format Error';
         }
    }

    /** Helper to prepare detailed breakdown object for logging and return */
    _prepareDetails(grossProfitToken, grossProfitWei, gasCostWei, netProfitWei, bufferedNetProfitWei, sdkToken, gasEstimate, feeData, minProfitThresholdWeiUsed) {
         const effectiveGasPrice = feeData?.maxFeePerGas || feeData?.gasPrice;
         return {
             grossProfitTokenFormatted: this._format(grossProfitToken, sdkToken?.decimals),
             grossProfitWeiFormatted: this._format(grossProfitWei),
             gasCostFormatted: this._format(gasCostWei),
             netProfitFormatted: this._format(netProfitWei),
             bufferedNetProfitFormatted: this._format(bufferedNetProfitWei),
             // *** MODIFIED: Show the actual threshold used ***
             minProfitThresholdUsedFormatted: this._format(minProfitThresholdWeiUsed), // Format the specific threshold used
             profitTokenSymbol: sdkToken?.symbol || 'N/A', // Show which token's threshold was used
             bufferPercent: this.profitBufferPercent.toString(),
             gasEstimateUnits: gasEstimate?.toString() || 'N/A',
             effectiveGasPriceGwei: this._format(effectiveGasPrice, 'gwei'),
             maxFeePerGasGwei: this._format(feeData?.maxFeePerGas, 'gwei'),
             maxPriorityFeePerGasGwei: this._format(feeData?.maxPriorityFeePerGas, 'gwei'),
             gasPriceGwei: this._format(feeData?.gasPrice, 'gwei'),
         };
    }

    /** Enhanced logging function */
    _logProfitDetails(details, isProfitableFlag) {
        const functionSig = `[ProfitCalculator]`;
        const gasPriceUsedGwei = details.effectiveGasPriceGwei !== 'N/A' ? details.effectiveGasPriceGwei : details.gasPriceGwei;

        // --- *** MODIFIED Log Message to include threshold used *** ---
        const logParts = [
            `Gross: ${details.grossProfitWeiFormatted} ${this.nativeSymbol}`,
            `Gas: ${details.gasCostFormatted} ${this.nativeSymbol} (${details.gasEstimateUnits} units @ ${gasPriceUsedGwei} Gwei)`,
            `Net: ${details.netProfitFormatted} ${this.nativeSymbol}`,
            `BufferedNet: ${details.bufferedNetProfitFormatted} ${this.nativeSymbol}`,
             // Show threshold used for the specific profit token
            `(MinReq for ${details.profitTokenSymbol}: ${details.minProfitThresholdUsedFormatted} ${this.nativeSymbol}, Buffer: ${details.bufferPercent}%)`,
            `-> Profitable: ${isProfitableFlag ? '✅ YES' : '❌ NO'}`
        ];
        // --- *** END MODIFIED Log Message *** ---


        const logMessage = `${functionSig} Profit Check | ${logParts.join(' | ')}`;

        if (isProfitableFlag) {
            logger.log(logMessage); // Use default log level for success
        } else {
            if (details.netProfitFormatted !== 'N/A') {
                logger.info(logMessage); // Use info for non-profitable but calculated checks
            } else {
                logger.warn(`${functionSig} Profit calculation incomplete. Gross: ${details.grossProfitWeiFormatted}, Gas: ${details.gasCostFormatted}`);
            }
        }
    }


    /** Helper to structure the final return object */
    _formatResult(isProfitable, grossProfitWei, estimatedGasCostWei, netProfitWei, bufferedNetProfitWei, details) {
        // Ensure all BigInt fields are actual BigInts or null
        const toSafeBigInt = (val) => (val !== null && typeof val !== 'undefined') ? ethers.toBigInt(val) : null;
        return {
            isProfitable,
            grossProfitWei: toSafeBigInt(grossProfitWei),
            estimatedGasCostWei: toSafeBigInt(estimatedGasCostWei),
            netProfitWei: toSafeBigInt(netProfitWei),
            bufferedNetProfitWei: toSafeBigInt(bufferedNetProfitWei),
            details // Object with formatted strings and context
        };
    }
}

module.exports = ProfitCalculator;
