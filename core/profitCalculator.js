// core/profitCalculator.js
// --- VERSION UPDATED FOR PHASE 1 REFACTOR ---

const { ethers } = require('ethers');
const logger = require('../utils/logger');
// Import the Price Feed utility functions directly
const { getChainlinkPriceData, convertTokenAmountToWei } = require('../utils/priceFeed');
const { ArbitrageError } = require('../utils/errorHandler'); // Keep if specific errors are thrown/caught

class ProfitCalculator {
    /**
     * @param {object} config Configuration object containing parsed values.
     * @param {ethers.BigNumber} config.minProfitWei Minimum required profit in Wei (already parsed BigNumber).
     * @param {number} config.PROFIT_BUFFER_PERCENT Safety buffer percentage for net profit comparison.
     * @param {ethers.providers.Provider} config.provider Ethers provider instance (needed for priceFeed).
     * @param {object} config.chainlinkFeeds Map of Chainlink feeds for price conversion.
     * @param {number} [config.nativeDecimals=18] Decimals of the native currency.
     * @param {string} [config.nativeSymbol='ETH'] Symbol of the native currency.
     */
    constructor(config) {
        const requiredKeys = ['minProfitWei', 'PROFIT_BUFFER_PERCENT', 'provider', 'chainlinkFeeds'];
        const missingKeys = requiredKeys.filter(key => !(key in config));
        if (missingKeys.length > 0) {
            throw new Error(`[ProfitCalculator] Invalid configuration provided. Missing keys: ${missingKeys.join(', ')}`);
        }
        if (!ethers.BigNumber.isBigNumber(config.minProfitWei)) {
             throw new Error(`[ProfitCalculator] config.minProfitWei must be a BigNumber.`);
        }

        this.minProfitWei = config.minProfitWei;
        this.profitBufferPercent = ethers.BigNumber.from(config.PROFIT_BUFFER_PERCENT); // Store as BigNumber
        this.provider = config.provider;
        this.chainlinkFeeds = config.chainlinkFeeds;
        this.nativeDecimals = config.nativeDecimals || 18;
        this.nativeSymbol = config.nativeSymbol || 'ETH';

        if (this.profitBufferPercent.lt(0) || this.profitBufferPercent.gt(100)) {
             throw new Error("[ProfitCalculator] PROFIT_BUFFER_PERCENT must be between 0 and 100.");
        }

        logger.info(`[ProfitCalculator] Initialized with Min Profit: ${ethers.utils.formatUnits(this.minProfitWei, this.nativeDecimals)} ${this.nativeSymbol}, Profit Buffer: ${this.profitBufferPercent.toString()}%`);
    }

    /**
     * Calculates net profit and checks profitability against the configured threshold and buffer.
     * Assumes gasEstimate is already buffered and feeData is current.
     *
     * @param {object} params Parameters object.
     * @param {object} params.simulationResult Result from quoteSimulator { profitable (bool), grossProfit (token units BigNumber), initialAmount, finalAmount, details: { tokenA: SDKToken } }.
     * @param {ethers.BigNumber} params.gasEstimate The estimated gas limit (already buffered).
     * @param {ethers.providers.FeeData} params.feeData Current EIP-1559 fee data (or legacy gasPrice).
     * @returns {Promise<{
     *   isProfitable: boolean,
     *   grossProfitWei: ethers.BigNumber | null,
     *   estimatedGasCostWei: ethers.BigNumber | null,
     *   netProfitWei: ethers.BigNumber | null,
     *   bufferedNetProfitWei: ethers.BigNumber | null,
     *   details: { grossProfitTokenFormatted: string, grossProfitWeiFormatted: string, gasCostFormatted: string, netProfitFormatted: string, bufferedNetProfitFormatted: string, minProfitFormatted: string, bufferPercent: string, tokenSymbol: string } | object // Empty object on failure
     * }>} Profitability decision and detailed breakdown. Values are null if calculations fail (e.g., price conversion or invalid inputs).
     */
    async calculateNetProfit({ simulationResult, gasEstimate, feeData }) {
        const functionSig = `[ProfitCalculator]`; // Logging prefix

        // --- Input Validation ---
        if (!simulationResult || typeof simulationResult.profitable !== 'boolean' || !ethers.BigNumber.isBigNumber(simulationResult.grossProfit) || !simulationResult.details?.tokenA) {
            logger.warn(`${functionSig} Invalid simulation result provided.`, simulationResult);
            return this._formatResult(false, null, null, null, null, {});
        }
        if (!gasEstimate || !ethers.BigNumber.isBigNumber(gasEstimate) || gasEstimate.lte(0)) {
            logger.warn(`${functionSig} Invalid gasEstimate provided: ${gasEstimate?.toString()}`);
            return this._formatResult(false, null, null, null, null, {});
        }
        // Check for usable fee data (either EIP-1559 or legacy)
        const gasPriceForCost = feeData?.maxFeePerGas || feeData?.gasPrice;
        if (!feeData || !gasPriceForCost || !ethers.BigNumber.isBigNumber(gasPriceForCost) || gasPriceForCost.lte(0)) {
            logger.warn(`${functionSig} Invalid feeData provided (missing or invalid maxFeePerGas/gasPrice).`, feeData);
             return this._formatResult(false, null, null, null, null, {});
        }
        // --- End Validation ---

        const { grossProfit } = simulationResult; // Amount in borrowed token's smallest unit (BigNumber)
        const sdkTokenBorrowed = simulationResult.details.tokenA; // SDK Token instance

        // Calculate Gas Cost early (needed for logging even if not profitable)
        // Use maxFeePerGas primarily, fallback to gasPrice if needed (checked in validation)
        const estimatedGasCostWei = gasEstimate.mul(gasPriceForCost);

        // If gross profit is not positive, skip further calculation
        if (!simulationResult.profitable || grossProfit.lte(0)) {
            logger.debug(`${functionSig} Gross profit (${this._format(grossProfit, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}) is zero or negative. Not profitable.`);
            // Attempt conversion for logging consistency
            const grossProfitWei = await this._convertGrossProfitToWei(grossProfit, sdkTokenBorrowed, functionSig);
            const details = this._prepareDetails(grossProfit, grossProfitWei, estimatedGasCostWei, null, null, sdkTokenBorrowed, gasEstimate, feeData);
            return this._formatResult(false, grossProfitWei, estimatedGasCostWei, null, null, details);
        }

        // --- Steps for Positive Gross Profit ---

        // 1. Convert Gross Profit to Wei (Native Token)
        const grossProfitWei = await this._convertGrossProfitToWei(grossProfit, sdkTokenBorrowed, functionSig);

        if (grossProfitWei === null) {
            // Conversion failed, cannot determine profitability
            logger.warn(`${functionSig} Failed to convert gross profit to ${this.nativeSymbol}. Assuming not profitable.`);
            const details = this._prepareDetails(grossProfit, null, estimatedGasCostWei, null, null, sdkTokenBorrowed, gasEstimate, feeData);
            return this._formatResult(false, null, estimatedGasCostWei, null, null, details);
        }
         // Additional check: If conversion somehow resulted in non-positive Wei value
         if (grossProfitWei.lte(0)) {
             logger.warn(`${functionSig} Converted gross profit in Wei (${this._format(grossProfitWei)} ${this.nativeSymbol}) is not positive. Not profitable.`);
             const details = this._prepareDetails(grossProfit, grossProfitWei, estimatedGasCostWei, null, null, sdkTokenBorrowed, gasEstimate, feeData);
             return this._formatResult(false, grossProfitWei, estimatedGasCostWei, null, null, details);
         }


        // 2. Calculate Net Profit (Wei)
        const netProfitWei = grossProfitWei.sub(estimatedGasCostWei);
        if (netProfitWei.lte(0)) {
             logger.info(`${functionSig} Net profit (${this._format(netProfitWei)} ${this.nativeSymbol}) is zero or negative after gas cost. Not profitable.`);
             const details = this._prepareDetails(grossProfit, grossProfitWei, estimatedGasCostWei, netProfitWei, null, sdkTokenBorrowed, gasEstimate, feeData);
             return this._formatResult(false, grossProfitWei, estimatedGasCostWei, netProfitWei, null, details);
        }

        // 3. Apply Safety Buffer to Net Profit
        // buffered = net * (100 - buffer) / 100
        let bufferedNetProfitWei = netProfitWei; // Default to net profit if buffer is 0
        if (this.profitBufferPercent.gt(0)) {
             const bufferMultiplier = ethers.BigNumber.from(100).sub(this.profitBufferPercent);
             // Ensure buffer calculation doesn't make it negative if original net profit was tiny positive
             if (bufferMultiplier.gt(0)) {
                  bufferedNetProfitWei = netProfitWei.mul(bufferMultiplier).div(100);
             } else {
                  // Handle edge case of 100% buffer - profit must be > 0
                  bufferedNetProfitWei = ethers.BigNumber.from(0);
             }
        }


        // 4. Compare Buffered Net Profit against Minimum Threshold
        const isProfitable = bufferedNetProfitWei.gte(this.minProfitWei);

        // --- Logging & Formatting ---
        const details = this._prepareDetails(grossProfit, grossProfitWei, estimatedGasCostWei, netProfitWei, bufferedNetProfitWei, sdkTokenBorrowed, gasEstimate, feeData);
        const logMessage = `${functionSig} Profit Check: Gross=${details.grossProfitWeiFormatted} | Gas=${details.gasCostFormatted} | Net=${details.netProfitFormatted} | BufferedNet=${details.bufferedNetProfitFormatted} (MinReq: ${details.minProfitFormatted}, Buffer: ${details.bufferPercent}%) -> Profitable: ${isProfitable ? '✅ YES' : '❌ NO'}`;
        if (isProfitable) {
            logger.log(logMessage); // Use standard log for success
        } else {
            logger.info(logMessage); // Use info for non-profitable checks
        }


        return this._formatResult(isProfitable, grossProfitWei, estimatedGasCostWei, netProfitWei, bufferedNetProfitWei, details);
    }

    /** Helper to convert gross profit in token units to Wei */
    async _convertGrossProfitToWei(grossProfitAmount, sdkToken, logPrefix) {
        // Handle native token case first
        if (sdkToken.symbol === this.nativeSymbol && sdkToken.decimals === this.nativeDecimals) {
            logger.debug(`${logPrefix} Gross profit is already in native token (${this.nativeSymbol}).`);
            return grossProfitAmount; // Already in Wei (or native smallest unit)
        }
        // Special case: Wrapped native token (e.g., WETH on ETH mainnet/Arbitrum)
        // Assumes WETH has same decimals as ETH (usually 18)
        if ((sdkToken.symbol === 'WETH' || sdkToken.symbol === this.config?.WRAPPED_NATIVE_SYMBOL) && sdkToken.decimals === this.nativeDecimals) {
             logger.debug(`${logPrefix} Gross profit is in wrapped native token (${sdkToken.symbol}). Assuming 1:1 conversion to ${this.nativeSymbol}.`);
             return grossProfitAmount;
        }

        // --- Proceed with Chainlink conversion for other tokens ---
        logger.debug(`${logPrefix} Gross profit in ${sdkToken.symbol}. Fetching price vs ${this.nativeSymbol} via Chainlink...`);
        try {
            // Pass provider and feeds config to priceFeed helper
            const priceData = await getChainlinkPriceData(
                sdkToken.symbol,
                this.provider,
                { CHAINLINK_FEEDS: this.chainlinkFeeds, NATIVE_SYMBOL: this.nativeSymbol } // Pass native symbol context
            );

            if (priceData) {
                const convertedWei = convertTokenAmountToWei(grossProfitAmount, sdkToken.decimals, priceData, this.nativeDecimals);
                if (convertedWei !== null) {
                     logger.debug(`${logPrefix} Converted gross profit: ${this._format(grossProfitAmount, sdkToken.decimals)} ${sdkToken.symbol} -> ${this._format(convertedWei)} ${this.nativeSymbol}`);
                     return convertedWei;
                } else {
                    logger.warn(`${logPrefix} Failed to convert ${sdkToken.symbol} gross profit to ${this.nativeSymbol} (convertTokenAmountToWei returned null). Check decimals or price data validity.`);
                    return null;
                }
            } else {
                logger.warn(`${logPrefix} Could not fetch price data for ${sdkToken.symbol}/${this.nativeSymbol} from Chainlink.`);
                return null;
            }
        } catch (error) {
             logger.error(`${logPrefix} Error fetching/converting price for ${sdkToken.symbol}/${this.nativeSymbol}: ${error.message}`, error);
             return null;
        }
    }

     /** Helper to format BigNumber values for logging */
    _format(value, decimals = this.nativeDecimals) {
         if (value === null || typeof value === 'undefined') return 'N/A';
         if (!ethers.BigNumber.isBigNumber(value)) return 'Invalid Value';
         try {
              return ethers.utils.formatUnits(value, decimals);
         } catch (formatError) {
             logger.warn(`[ProfitCalculator] Error formatting value: ${value?.toString()} with decimals ${decimals}`, formatError);
             return 'Format Error';
         }
    }

    /** Helper to prepare detailed breakdown object for logging and return */
    _prepareDetails(grossProfitToken, grossProfitWei, gasCostWei, netProfitWei, bufferedNetProfitWei, sdkToken, gasEstimate, feeData) {
         return {
             grossProfitTokenFormatted: this._format(grossProfitToken, sdkToken?.decimals),
             grossProfitWeiFormatted: this._format(grossProfitWei),
             gasCostFormatted: this._format(gasCostWei),
             netProfitFormatted: this._format(netProfitWei),
             bufferedNetProfitFormatted: this._format(bufferedNetProfitWei),
             minProfitFormatted: this._format(this.minProfitWei),
             bufferPercent: this.profitBufferPercent.toString(),
             tokenSymbol: sdkToken?.symbol || 'N/A',
             // Optionally include gas details for deeper debugging if needed
             // gasEstimate: gasEstimate?.toString() || 'N/A',
             // maxFeePerGasGwei: this._format(feeData?.maxFeePerGas, 'gwei'),
             // gasPriceGwei: this._format(feeData?.gasPrice, 'gwei'),
         };
    }

    /** Helper to structure the final return object */
    _formatResult(isProfitable, grossProfitWei, estimatedGasCostWei, netProfitWei, bufferedNetProfitWei, details) {
        return {
            isProfitable,
            grossProfitWei,         // BigNumber or null
            estimatedGasCostWei,    // BigNumber or null
            netProfitWei,           // BigNumber or null
            bufferedNetProfitWei,   // BigNumber or null
            details                 // Object with formatted strings and context
        };
    }
}

module.exports = ProfitCalculator;
