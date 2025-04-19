// core/profitCalculator.js
// --- VERSION UPDATED FOR ETHERS V6 UTILS & ENHANCED LOGGING ---

const { ethers } = require('ethers'); // Ethers v6+
const logger = require('../utils/logger');
const { getChainlinkPriceData, convertTokenAmountToWei } = require('../utils/priceFeed'); // Ensure this uses ethers v6 if needed
const { ArbitrageError } = require('../utils/errorHandler'); // Keep if specific errors are thrown/caught

class ProfitCalculator {
    /**
     * @param {object} config Configuration object containing parsed values.
     * @param {bigint} config.minProfitWei Minimum required profit in Wei (already parsed BigInt).
     * @param {number} config.PROFIT_BUFFER_PERCENT Safety buffer percentage for net profit comparison.
     * @param {ethers.Provider} config.provider Ethers provider instance (needed for priceFeed).
     * @param {object} config.chainlinkFeeds Map of Chainlink feeds for price conversion.
     * @param {number} [config.nativeDecimals=18] Decimals of the native currency.
     * @param {string} [config.nativeSymbol='ETH'] Symbol of the native currency.
     * @param {string} [config.WRAPPED_NATIVE_SYMBOL='WETH'] Symbol for wrapped native token (e.g., WETH).
     */
    constructor(config) {
        const requiredKeys = ['minProfitWei', 'PROFIT_BUFFER_PERCENT', 'provider', 'chainlinkFeeds'];
        const missingKeys = requiredKeys.filter(key => !(key in config));
        if (missingKeys.length > 0) {
            throw new Error(`[ProfitCalculator] Invalid configuration provided. Missing keys: ${missingKeys.join(', ')}`);
        }
        if (typeof config.minProfitWei !== 'bigint') {
             throw new Error(`[ProfitCalculator] config.minProfitWei must be a bigint. Received: ${typeof config.minProfitWei}`);
        }

        this.minProfitWei = config.minProfitWei;
        this.profitBufferPercent = ethers.toBigInt(config.PROFIT_BUFFER_PERCENT);
        this.provider = config.provider;
        this.chainlinkFeeds = config.chainlinkFeeds;
        this.nativeDecimals = config.nativeDecimals || 18;
        this.nativeSymbol = config.nativeSymbol || 'ETH';
        this.wrappedNativeSymbol = config.WRAPPED_NATIVE_SYMBOL || 'WETH';

        if (this.profitBufferPercent < 0n || this.profitBufferPercent > 100n) {
             throw new Error("[ProfitCalculator] PROFIT_BUFFER_PERCENT must be between 0 and 100.");
        }
        logger.info(`[ProfitCalculator] Initialized with Min Profit: ${ethers.formatUnits(this.minProfitWei, this.nativeDecimals)} ${this.nativeSymbol}, Profit Buffer: ${this.profitBufferPercent.toString()}%`);
    }

    /**
     * Calculates net profit and checks profitability against the configured threshold and buffer.
     * Assumes gasEstimate is already buffered and feeData is current.
     *
     * @param {object} params Parameters object.
     * @param {object} params.simulationResult Result from quoteSimulator { profitable (bool), grossProfit (BigInt), initialAmount, finalAmount, details: { tokenA: SDKToken } }.
     * @param {bigint} params.gasEstimate The estimated gas limit (already buffered, as BigInt).
     * @param {ethers.FeeData} params.feeData Current EIP-1559 fee data (or legacy gasPrice).
     * @returns {Promise<{...profitability data...}>} Profitability decision and detailed breakdown.
     */
    async calculateNetProfit({ simulationResult, gasEstimate, feeData }) {
        const functionSig = `[ProfitCalculator]`;

        // --- Input Validation ---
        if (!simulationResult || typeof simulationResult.profitable !== 'boolean' || typeof simulationResult.grossProfit !== 'bigint' || !simulationResult.details?.tokenA) { /* ... */ return this._formatResult(false, null, null, null, null, {}); }
        if (typeof gasEstimate !== 'bigint' || gasEstimate <= 0n) { /* ... */ return this._formatResult(false, null, null, null, null, {}); }
        const gasPriceForCost = feeData?.maxFeePerGas || feeData?.gasPrice;
        if (!feeData || !gasPriceForCost || typeof gasPriceForCost !== 'bigint' || gasPriceForCost <= 0n) { /* ... */ return this._formatResult(false, null, null, null, null, {}); }
        // --- End Validation ---

        const { grossProfit } = simulationResult;
        const sdkTokenBorrowed = simulationResult.details.tokenA;
        const estimatedGasCostWei = gasEstimate * gasPriceForCost;

        // Handle non-positive gross profit
        if (!simulationResult.profitable || grossProfit <= 0n) {
            logger.debug(`${functionSig} Gross profit (${this._format(grossProfit, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}) is zero or negative. Not profitable.`);
            const grossProfitWei = await this._convertGrossProfitToWei(grossProfit, sdkTokenBorrowed, functionSig);
            const details = this._prepareDetails(grossProfit, grossProfitWei, estimatedGasCostWei, null, null, sdkTokenBorrowed, gasEstimate, feeData);
            // Log gas details even if not profitable
            this._logProfitDetails(details, gasEstimate, false); // Log with isProfitable = false
            return this._formatResult(false, grossProfitWei, estimatedGasCostWei, null, null, details);
        }

        // --- Steps for Positive Gross Profit ---
        const grossProfitWei = await this._convertGrossProfitToWei(grossProfit, sdkTokenBorrowed, functionSig);
        if (grossProfitWei === null || grossProfitWei <= 0n) {
            logger.warn(`${functionSig} Converted gross profit in Wei is null or not positive. Assuming not profitable.`);
            const details = this._prepareDetails(grossProfit, grossProfitWei, estimatedGasCostWei, null, null, sdkTokenBorrowed, gasEstimate, feeData);
            this._logProfitDetails(details, gasEstimate, false); // Log with isProfitable = false
            return this._formatResult(false, grossProfitWei, estimatedGasCostWei, null, null, details);
        }

        const netProfitWei = grossProfitWei - estimatedGasCostWei;
        if (netProfitWei <= 0n) {
             logger.info(`${functionSig} Net profit (${this._format(netProfitWei)} ${this.nativeSymbol}) is zero or negative after gas cost. Not profitable.`);
             const details = this._prepareDetails(grossProfit, grossProfitWei, estimatedGasCostWei, netProfitWei, null, sdkTokenBorrowed, gasEstimate, feeData);
             this._logProfitDetails(details, gasEstimate, false); // Log with isProfitable = false
             return this._formatResult(false, grossProfitWei, estimatedGasCostWei, netProfitWei, null, details);
        }

        let bufferedNetProfitWei = netProfitWei;
        if (this.profitBufferPercent > 0n) {
             const bufferMultiplier = 100n - this.profitBufferPercent;
             bufferedNetProfitWei = (bufferMultiplier > 0n) ? (netProfitWei * bufferMultiplier) / 100n : 0n;
        }

        const isProfitable = bufferedNetProfitWei >= this.minProfitWei;

        // --- Logging & Formatting ---
        const details = this._prepareDetails(grossProfit, grossProfitWei, estimatedGasCostWei, netProfitWei, bufferedNetProfitWei, sdkTokenBorrowed, gasEstimate, feeData);
        // *** Call Enhanced Logging Function ***
        this._logProfitDetails(details, gasEstimate, isProfitable);

        return this._formatResult(isProfitable, grossProfitWei, estimatedGasCostWei, netProfitWei, bufferedNetProfitWei, details);
    }

    /** Helper to convert gross profit in token units to Wei (returns BigInt or null) */
    async _convertGrossProfitToWei(grossProfitAmount, sdkToken, logPrefix) {
        const grossProfitBigInt = ethers.toBigInt(grossProfitAmount);
        if (sdkToken.symbol === this.nativeSymbol && sdkToken.decimals === this.nativeDecimals) {
            logger.debug(`${logPrefix} Gross profit is already in native token (${this.nativeSymbol}).`);
            return grossProfitBigInt;
        }
        if (sdkToken.symbol === this.wrappedNativeSymbol && sdkToken.decimals === this.nativeDecimals) {
             logger.debug(`${logPrefix} Gross profit is in wrapped native token (${sdkToken.symbol}). Assuming 1:1 conversion to ${this.nativeSymbol}.`);
             return grossProfitBigInt;
        }

        logger.debug(`${logPrefix} Gross profit in ${sdkToken.symbol}. Fetching price vs ${this.nativeSymbol} via Chainlink...`);
        try {
            const priceData = await getChainlinkPriceData( /* ... */ ); // Assuming this returns correct data
            if (priceData) {
                const convertedWei = convertTokenAmountToWei(grossProfitBigInt, sdkToken.decimals, priceData, this.nativeDecimals);
                if (convertedWei !== null) {
                     const convertedBigInt = ethers.toBigInt(convertedWei);
                     logger.debug(`${logPrefix} Converted gross profit: ${this._format(grossProfitBigInt, sdkToken.decimals)} ${sdkToken.symbol} -> ${this._format(convertedBigInt)} ${this.nativeSymbol}`);
                     return convertedBigInt;
                } else { /*...*/ return null; }
            } else { /*...*/ return null; }
        } catch (error) { /*...*/ return null; }
    }

     /** Helper to format BigNumberish values for logging */
    _format(value, decimals = this.nativeDecimals) {
         if (value === null || typeof value === 'undefined') return 'N/A';
         try {
              return ethers.formatUnits(value, decimals);
         } catch (formatError) {
             logger.warn(`[ProfitCalculator _format] Error formatting value: ${value?.toString()} with decimals ${decimals}`, formatError);
             return 'Format Error';
         }
    }

    /** Helper to prepare detailed breakdown object for logging and return */
    _prepareDetails(grossProfitToken, grossProfitWei, gasCostWei, netProfitWei, bufferedNetProfitWei, sdkToken, gasEstimate, feeData) {
         // Determine effective gas price used for calculation
         const effectiveGasPrice = feeData?.maxFeePerGas || feeData?.gasPrice;
         return {
             grossProfitTokenFormatted: this._format(grossProfitToken, sdkToken?.decimals),
             grossProfitWeiFormatted: this._format(grossProfitWei),
             gasCostFormatted: this._format(gasCostWei), // Total gas cost in ETH
             netProfitFormatted: this._format(netProfitWei),
             bufferedNetProfitFormatted: this._format(bufferedNetProfitWei),
             minProfitFormatted: this._format(this.minProfitWei),
             bufferPercent: this.profitBufferPercent.toString(),
             tokenSymbol: sdkToken?.symbol || 'N/A',
             // Add gas price details used for the cost calculation
             gasEstimateUnits: gasEstimate?.toString() || 'N/A', // The gas limit units
             effectiveGasPriceGwei: this._format(effectiveGasPrice, 'gwei'), // Price per gas unit in Gwei
             // Include specific fee types for clarity
             maxFeePerGasGwei: this._format(feeData?.maxFeePerGas, 'gwei'),
             maxPriorityFeePerGasGwei: this._format(feeData?.maxPriorityFeePerGas, 'gwei'),
             gasPriceGwei: this._format(feeData?.gasPrice, 'gwei'), // Legacy price
         };
    }

    /** Enhanced logging function */
    _logProfitDetails(details, gasEstimateBigInt, isProfitableFlag) {
        const functionSig = `[ProfitCalculator]`;
        const gasPriceUsedGwei = details.effectiveGasPriceGwei !== 'N/A' ? details.effectiveGasPriceGwei : details.gasPriceGwei; // Show the price used

        // Build the log message string
        const logParts = [
            `Gross: ${details.grossProfitWeiFormatted} ${this.nativeSymbol}`,
            `Gas: ${details.gasCostFormatted} ${this.nativeSymbol} (${details.gasEstimateUnits} units @ ${gasPriceUsedGwei} Gwei)`,
            `Net: ${details.netProfitFormatted} ${this.nativeSymbol}`,
            `BufferedNet: ${details.bufferedNetProfitFormatted} ${this.nativeSymbol}`,
            `(MinReq: ${details.minProfitFormatted} ${this.nativeSymbol}, Buffer: ${details.bufferPercent}%)`,
            `-> Profitable: ${isProfitableFlag ? '✅ YES' : '❌ NO'}`
        ];

        const logMessage = `${functionSig} Profit Check | ${logParts.join(' | ')}`;

        // Log appropriately based on profitability
        if (isProfitableFlag) {
            logger.log(logMessage);
        } else {
            // Log non-profitable results at info level, unless netProfit is null (indicating error)
            if (details.netProfitFormatted !== 'N/A') {
                logger.info(logMessage);
            } else {
                // Log as warning if netProfit couldn't even be calculated (e.g., price conversion failed)
                logger.warn(`${functionSig} Profit calculation incomplete. Gross: ${details.grossProfitWeiFormatted}, Gas: ${details.gasCostFormatted}`);
            }
        }
    }


    /** Helper to structure the final return object, ensuring BigInts */
    _formatResult(isProfitable, grossProfitWei, estimatedGasCostWei, netProfitWei, bufferedNetProfitWei, details) {
        return {
            isProfitable,
            grossProfitWei: grossProfitWei ? ethers.toBigInt(grossProfitWei) : null,
            estimatedGasCostWei: estimatedGasCostWei ? ethers.toBigInt(estimatedGasCostWei) : null,
            netProfitWei: netProfitWei ? ethers.toBigInt(netProfitWei) : null,
            bufferedNetProfitWei: bufferedNetProfitWei ? ethers.toBigInt(bufferedNetProfitWei) : null,
            details // Object with formatted strings and context
        };
    }
}

module.exports = ProfitCalculator;
