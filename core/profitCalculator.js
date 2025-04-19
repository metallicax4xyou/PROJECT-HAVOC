// core/profitCalculator.js
// --- VERSION UPDATED FOR ETHERS V6 UTILS ---

const { ethers } = require('ethers'); // Ethers v6+
const logger = require('../utils/logger');
const { getChainlinkPriceData, convertTokenAmountToWei } = require('../utils/priceFeed');
const { ArbitrageError } = require('../utils/errorHandler');

class ProfitCalculator {
    constructor(config) {
        // ... (constructor validation remains the same) ...
        this.minProfitWei = config.minProfitWei;
        this.profitBufferPercent = ethers.toBigInt(config.PROFIT_BUFFER_PERCENT); // Use toBigInt for safety
        this.provider = config.provider;
        this.chainlinkFeeds = config.chainlinkFeeds;
        this.nativeDecimals = config.nativeDecimals || 18;
        this.nativeSymbol = config.nativeSymbol || 'ETH';

        if (this.profitBufferPercent < 0 || this.profitBufferPercent > 100) { // BigInt comparison works
             throw new Error("[ProfitCalculator] PROFIT_BUFFER_PERCENT must be between 0 and 100.");
        }
        // --- Use ethers.formatUnits ---
        logger.info(`[ProfitCalculator] Initialized with Min Profit: ${ethers.formatUnits(this.minProfitWei, this.nativeDecimals)} ${this.nativeSymbol}, Profit Buffer: ${this.profitBufferPercent.toString()}%`);
    }

    async calculateNetProfit({ simulationResult, gasEstimate, feeData }) {
        const functionSig = `[ProfitCalculator]`;

        // ... (Input Validation remains the same) ...
        const { grossProfit } = simulationResult;
        const sdkTokenBorrowed = simulationResult.details.tokenA;

        const gasPriceForCost = feeData?.maxFeePerGas || feeData?.gasPrice;
        if (!feeData || !gasPriceForCost || !ethers.isBigNumberish(gasPriceForCost) || ethers.toBigInt(gasPriceForCost) <= 0) {
            logger.warn(`${functionSig} Invalid feeData provided (missing or invalid maxFeePerGas/gasPrice).`, feeData);
             return this._formatResult(false, null, null, null, null, {});
        }
        const estimatedGasCostWei = ethers.toBigInt(gasEstimate) * ethers.toBigInt(gasPriceForCost); // Use toBigInt for calculations

        if (!simulationResult.profitable || grossProfit <= 0) { // Use BigInt comparison
            // --- Use ethers.formatUnits ---
            logger.debug(`${functionSig} Gross profit (${ethers.formatUnits(grossProfit, sdkTokenBorrowed.decimals)} ${sdkTokenBorrowed.symbol}) is zero or negative. Not profitable.`);
            const grossProfitWei = await this._convertGrossProfitToWei(grossProfit, sdkTokenBorrowed, functionSig);
            const details = this._prepareDetails(grossProfit, grossProfitWei, estimatedGasCostWei, null, null, sdkTokenBorrowed, gasEstimate, feeData);
            return this._formatResult(false, grossProfitWei, estimatedGasCostWei, null, null, details);
        }

        const grossProfitWei = await this._convertGrossProfitToWei(grossProfit, sdkTokenBorrowed, functionSig);
        if (grossProfitWei === null || grossProfitWei <= 0) { // Check null and non-positive
            logger.warn(`${functionSig} Converted gross profit in Wei is null or not positive (${this._format(grossProfitWei)} ${this.nativeSymbol}). Not profitable.`);
            const details = this._prepareDetails(grossProfit, grossProfitWei, estimatedGasCostWei, null, null, sdkTokenBorrowed, gasEstimate, feeData);
            return this._formatResult(false, grossProfitWei, estimatedGasCostWei, null, null, details);
        }

        const netProfitWei = grossProfitWei - estimatedGasCostWei; // BigInt subtraction
        if (netProfitWei <= 0) {
             logger.info(`${functionSig} Net profit (${this._format(netProfitWei)} ${this.nativeSymbol}) is zero or negative after gas cost. Not profitable.`);
             const details = this._prepareDetails(grossProfit, grossProfitWei, estimatedGasCostWei, netProfitWei, null, sdkTokenBorrowed, gasEstimate, feeData);
             return this._formatResult(false, grossProfitWei, estimatedGasCostWei, netProfitWei, null, details);
        }

        let bufferedNetProfitWei = netProfitWei;
        if (this.profitBufferPercent > 0) {
             const bufferMultiplier = 100n - this.profitBufferPercent; // Use BigInt 100n
             if (bufferMultiplier > 0) { bufferedNetProfitWei = (netProfitWei * bufferMultiplier) / 100n; } // Use BigInt division
             else { bufferedNetProfitWei = 0n; } // Use BigInt zero
        }

        const isProfitable = bufferedNetProfitWei >= this.minProfitWei; // BigInt comparison

        const details = this._prepareDetails(grossProfit, grossProfitWei, estimatedGasCostWei, netProfitWei, bufferedNetProfitWei, sdkTokenBorrowed, gasEstimate, feeData);
        // --- Use ethers.formatUnits ---
        const logMessage = `${functionSig} Profit Check: Gross=${details.grossProfitWeiFormatted} | Gas=${details.gasCostFormatted} | Net=${details.netProfitFormatted} | BufferedNet=${details.bufferedNetProfitFormatted} (MinReq: ${details.minProfitFormatted}, Buffer: ${details.bufferPercent}%) -> Profitable: ${isProfitable ? '✅ YES' : '❌ NO'}`;
        if (isProfitable) { logger.log(logMessage); } else { logger.info(logMessage); }

        return this._formatResult(isProfitable, grossProfitWei, estimatedGasCostWei, netProfitWei, bufferedNetProfitWei, details);
    }

    async _convertGrossProfitToWei(grossProfitAmount, sdkToken, logPrefix) {
        // ... (logic for native/wrapped check remains same) ...
        if ((sdkToken.symbol === 'WETH' || sdkToken.symbol === this.config?.WRAPPED_NATIVE_SYMBOL) && sdkToken.decimals === this.nativeDecimals) {
             return ethers.toBigInt(grossProfitAmount); // Ensure BigInt return
        }

        logger.debug(`${logPrefix} Gross profit in ${sdkToken.symbol}. Fetching price vs ${this.nativeSymbol} via Chainlink...`);
        try {
            const priceData = await getChainlinkPriceData( sdkToken.symbol, this.provider, { CHAINLINK_FEEDS: this.chainlinkFeeds, NATIVE_SYMBOL: this.nativeSymbol });
            if (priceData) {
                const convertedWei = convertTokenAmountToWei(grossProfitAmount, sdkToken.decimals, priceData, this.nativeDecimals);
                if (convertedWei !== null) {
                     // --- Use ethers.formatUnits ---
                     logger.debug(`${logPrefix} Converted gross profit: ${ethers.formatUnits(grossProfitAmount, sdkToken.decimals)} ${sdkToken.symbol} -> ${ethers.formatUnits(convertedWei, this.nativeDecimals)} ${this.nativeSymbol}`);
                     return ethers.toBigInt(convertedWei); // Ensure BigInt return
                } else { /* ... */ return null; }
            } else { /* ... */ return null; }
        } catch (error) { /* ... */ return null; }
    }

     _format(value, decimals = this.nativeDecimals) {
         if (value === null || typeof value === 'undefined') return 'N/A';
         // Check if it's BigInt or BigNumber-like before formatting
         if (!ethers.isBigNumberish(value)) return 'Invalid Value';
         try {
              // --- Use ethers.formatUnits ---
              return ethers.formatUnits(value, decimals);
         } catch (formatError) { /* ... */ }
    }

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

    _formatResult(isProfitable, grossProfitWei, estimatedGasCostWei, netProfitWei, bufferedNetProfitWei, details) {
        // Ensure all BigInt values are returned consistently as BigInt or null
        return {
            isProfitable,
            grossProfitWei: grossProfitWei ? ethers.toBigInt(grossProfitWei) : null,
            estimatedGasCostWei: estimatedGasCostWei ? ethers.toBigInt(estimatedGasCostWei) : null,
            netProfitWei: netProfitWei ? ethers.toBigInt(netProfitWei) : null,
            bufferedNetProfitWei: bufferedNetProfitWei ? ethers.toBigInt(bufferedNetProfitWei) : null,
            details
        };
    }
}

module.exports = ProfitCalculator;
