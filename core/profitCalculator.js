// core/profitCalculator.js
// --- VERSION UPDATED FOR ETHERS V6 UTILS & PHASE 1 REFACTOR ---

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
        // Ensure minProfitWei is actually a BigInt after parsing in engine
        if (typeof config.minProfitWei !== 'bigint') {
             throw new Error(`[ProfitCalculator] config.minProfitWei must be a bigint. Received: ${typeof config.minProfitWei}`);
        }

        this.minProfitWei = config.minProfitWei; // Should be BigInt
        this.profitBufferPercent = ethers.toBigInt(config.PROFIT_BUFFER_PERCENT); // Convert percentage to BigInt
        this.provider = config.provider;
        this.chainlinkFeeds = config.chainlinkFeeds;
        this.nativeDecimals = config.nativeDecimals || 18;
        this.nativeSymbol = config.nativeSymbol || 'ETH';
        this.wrappedNativeSymbol = config.WRAPPED_NATIVE_SYMBOL || 'WETH'; // Get from config or default

        if (this.profitBufferPercent < 0n || this.profitBufferPercent > 100n) { // BigInt comparison
             throw new Error("[ProfitCalculator] PROFIT_BUFFER_PERCENT must be between 0 and 100.");
        }
        // --- Use ethers.formatUnits (v6 syntax) ---
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
     * @returns {Promise<{
     *   isProfitable: boolean,
     *   grossProfitWei: bigint | null,
     *   estimatedGasCostWei: bigint | null,
     *   netProfitWei: bigint | null,
     *   bufferedNetProfitWei: bigint | null,
     *   details: { grossProfitTokenFormatted: string, grossProfitWeiFormatted: string, gasCostFormatted: string, netProfitFormatted: string, bufferedNetProfitFormatted: string, minProfitFormatted: string, bufferPercent: string, tokenSymbol: string, maxFeePerGasGwei?: string, maxPriorityFeePerGasGwei?: string, gasPriceGwei?: string } | object // Empty object on failure
     * }>} Profitability decision and detailed breakdown. Values are null if calculations fail.
     */
    async calculateNetProfit({ simulationResult, gasEstimate, feeData }) {
        const functionSig = `[ProfitCalculator]`; // Logging prefix

        // --- Input Validation ---
        if (!simulationResult || typeof simulationResult.profitable !== 'boolean' || typeof simulationResult.grossProfit !== 'bigint' || !simulationResult.details?.tokenA) {
            logger.warn(`${functionSig} Invalid simulation result provided.`, simulationResult);
            return this._formatResult(false, null, null, null, null, {});
        }
        if (typeof gasEstimate !== 'bigint' || gasEstimate <= 0n) { // Check BigInt
            logger.warn(`${functionSig} Invalid gasEstimate provided: ${gasEstimate?.toString()}`);
            return this._formatResult(false, null, null, null, null, {});
        }
        // Check for usable fee data (either EIP-1559 or legacy)
        const gasPriceForCost = feeData?.maxFeePerGas || feeData?.gasPrice; // Already BigInt from FeeData
        if (!feeData || !gasPriceForCost || typeof gasPriceForCost !== 'bigint' || gasPriceForCost <= 0n) { // Check BigInt
            logger.warn(`${functionSig} Invalid feeData provided (missing or invalid maxFeePerGas/gasPrice).`, feeData);
             return this._formatResult(false, null, null, null, null, {});
        }
        // --- End Validation ---

        const { grossProfit } = simulationResult; // Already BigInt
        const sdkTokenBorrowed = simulationResult.details.tokenA; // SDK Token instance

        // Calculate Gas Cost early (needed for logging even if not profitable)
        const estimatedGasCostWei = gasEstimate * gasPriceForCost; // BigInt multiplication

        // If gross profit is not positive, skip further calculation
        if (!simulationResult.profitable || grossProfit <= 0n) { // BigInt comparison
            // --- Use ethers.formatUnits (v6 syntax) ---
            logger.debug(`${functionSig} Gross profit (${this._format(grossProfit, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}) is zero or negative. Not profitable.`);
            // Attempt conversion for logging consistency
            const grossProfitWei = await this._convertGrossProfitToWei(grossProfit, sdkTokenBorrowed, functionSig);
            const details = this._prepareDetails(grossProfit, grossProfitWei, estimatedGasCostWei, null, null, sdkTokenBorrowed, gasEstimate, feeData);
            return this._formatResult(false, grossProfitWei, estimatedGasCostWei, null, null, details);
        }

        // --- Steps for Positive Gross Profit ---

        // 1. Convert Gross Profit to Wei (Native Token)
        const grossProfitWei = await this._convertGrossProfitToWei(grossProfit, sdkTokenBorrowed, functionSig); // Returns BigInt or null

        if (grossProfitWei === null) {
            logger.warn(`${functionSig} Failed to convert gross profit to ${this.nativeSymbol}. Assuming not profitable.`);
            const details = this._prepareDetails(grossProfit, null, estimatedGasCostWei, null, null, sdkTokenBorrowed, gasEstimate, feeData);
            return this._formatResult(false, null, estimatedGasCostWei, null, null, details);
        }
         if (grossProfitWei <= 0n) { // Additional check after conversion
             logger.warn(`${functionSig} Converted gross profit in Wei (${this._format(grossProfitWei)} ${this.nativeSymbol}) is not positive. Not profitable.`);
             const details = this._prepareDetails(grossProfit, grossProfitWei, estimatedGasCostWei, null, null, sdkTokenBorrowed, gasEstimate, feeData);
             return this._formatResult(false, grossProfitWei, estimatedGasCostWei, null, null, details);
         }

        // 2. Calculate Net Profit (Wei)
        const netProfitWei = grossProfitWei - estimatedGasCostWei; // BigInt subtraction

        if (netProfitWei <= 0n) { // BigInt comparison
             logger.info(`${functionSig} Net profit (${this._format(netProfitWei)} ${this.nativeSymbol}) is zero or negative after gas cost. Not profitable.`);
             const details = this._prepareDetails(grossProfit, grossProfitWei, estimatedGasCostWei, netProfitWei, null, sdkTokenBorrowed, gasEstimate, feeData);
             return this._formatResult(false, grossProfitWei, estimatedGasCostWei, netProfitWei, null, details);
        }

        // 3. Apply Safety Buffer to Net Profit
        let bufferedNetProfitWei = netProfitWei; // Default to net profit if buffer is 0
        if (this.profitBufferPercent > 0n) { // BigInt comparison
             const bufferMultiplier = 100n - this.profitBufferPercent; // Use BigInt 100n
             if (bufferMultiplier > 0n) {
                  // Use BigInt division: (a * b) / c
                  bufferedNetProfitWei = (netProfitWei * bufferMultiplier) / 100n;
             } else {
                  // Handle edge case of 100% buffer
                  bufferedNetProfitWei = 0n; // Use BigInt zero
             }
        }

        // 4. Compare Buffered Net Profit against Minimum Threshold
        const isProfitable = bufferedNetProfitWei >= this.minProfitWei; // BigInt comparison

        // --- Logging & Formatting ---
        const details = this._prepareDetails(grossProfit, grossProfitWei, estimatedGasCostWei, netProfitWei, bufferedNetProfitWei, sdkTokenBorrowed, gasEstimate, feeData);
        // --- Use ethers.formatUnits (v6 syntax) ---
        const logMessage = `${functionSig} Profit Check: Gross=${details.grossProfitWeiFormatted} | Gas=${details.gasCostFormatted} | Net=${details.netProfitFormatted} | BufferedNet=${details.bufferedNetProfitFormatted} (MinReq: ${details.minProfitFormatted}, Buffer: ${details.bufferPercent}%) -> Profitable: ${isProfitable ? '✅ YES' : '❌ NO'}`;
        if (isProfitable) {
            logger.log(logMessage); // Use standard log for success
        } else {
            logger.info(logMessage); // Use info for non-profitable checks
        }

        return this._formatResult(isProfitable, grossProfitWei, estimatedGasCostWei, netProfitWei, bufferedNetProfitWei, details);
    }

    /** Helper to convert gross profit in token units to Wei (returns BigInt or null) */
    async _convertGrossProfitToWei(grossProfitAmount, sdkToken, logPrefix) {
        // Handle native token case first (ensure input is BigInt)
        const grossProfitBigInt = ethers.toBigInt(grossProfitAmount);
        if (sdkToken.symbol === this.nativeSymbol && sdkToken.decimals === this.nativeDecimals) {
            logger.debug(`${logPrefix} Gross profit is already in native token (${this.nativeSymbol}).`);
            return grossProfitBigInt;
        }
        // Special case: Wrapped native token (e.g., WETH)
        if (sdkToken.symbol === this.wrappedNativeSymbol && sdkToken.decimals === this.nativeDecimals) {
             logger.debug(`${logPrefix} Gross profit is in wrapped native token (${sdkToken.symbol}). Assuming 1:1 conversion to ${this.nativeSymbol}.`);
             return grossProfitBigInt;
        }

        // --- Proceed with Chainlink conversion for other tokens ---
        logger.debug(`${logPrefix} Gross profit in ${sdkToken.symbol}. Fetching price vs ${this.nativeSymbol} via Chainlink...`);
        try {
            // Ensure priceFeed helpers are compatible with ethers v6 if they use utils
            const priceData = await getChainlinkPriceData(
                sdkToken.symbol,
                this.provider,
                { CHAINLINK_FEEDS: this.chainlinkFeeds, NATIVE_SYMBOL: this.nativeSymbol }
            );

            if (priceData) {
                // Ensure convertTokenAmountToWei returns a BigInt or null
                const convertedWei = convertTokenAmountToWei(grossProfitBigInt, sdkToken.decimals, priceData, this.nativeDecimals);
                if (convertedWei !== null) {
                     const convertedBigInt = ethers.toBigInt(convertedWei); // Ensure result is BigInt
                     // --- Use ethers.formatUnits (v6 syntax) ---
                     logger.debug(`${logPrefix} Converted gross profit: ${this._format(grossProfitBigInt, sdkToken.decimals)} ${sdkToken.symbol} -> ${this._format(convertedBigInt)} ${this.nativeSymbol}`);
                     return convertedBigInt;
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

     /** Helper to format BigNumberish values for logging */
    _format(value, decimals = this.nativeDecimals) {
         if (value === null || typeof value === 'undefined') return 'N/A';
         // Check if it's BigInt or BigNumber-like before formatting
         if (!ethers.isBigNumberish(value)) return 'Invalid Value';
         try {
              // --- Use ethers.formatUnits (v6 syntax) ---
              return ethers.formatUnits(value, decimals);
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
             // Add formatted Gwei fees for easier reading
             maxFeePerGasGwei: this._format(feeData?.maxFeePerGas, 'gwei'),
             maxPriorityFeePerGasGwei: this._format(feeData?.maxPriorityFeePerGas, 'gwei'),
             gasPriceGwei: this._format(feeData?.gasPrice, 'gwei'),
         };
    }

    /** Helper to structure the final return object, ensuring BigInts */
    _formatResult(isProfitable, grossProfitWei, estimatedGasCostWei, netProfitWei, bufferedNetProfitWei, details) {
        // Ensure all BigInt values are returned consistently as BigInt or null
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
