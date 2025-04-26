// core/profitCalculator.js
// --- VERSION v2.6 --- Uses helpers from profitCalcUtils.js, Handles Aave Fee

const { ethers } = require('ethers');
const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler');
const { TOKENS } = require('../constants/tokens'); // Keep for token lookups if needed directly
const SwapSimulator = require('./swapSimulator'); // Keep for type hints/validation
const GasEstimator = require('../utils/gasEstimator'); // Keep for type hints/validation
// Import the newly created helper functions
const ProfitCalcUtils = require('./profitCalcUtils');

class ProfitCalculator {
    constructor(config, provider, swapSimulator, gasEstimator) {
        const logPrefix = '[ProfitCalculator v2.6]'; // Update version log
        logger.debug(`${logPrefix} Initializing...`);
        // Basic Dependency Injection Validation
        if (!config) throw new ArbitrageError('PC Init', 'Config missing.');
        if (!provider) throw new ArbitrageError('PC Init', 'Provider missing.');
        if (!swapSimulator?.simulateSwap) throw new ArbitrageError('PC Init', 'Simulator invalid.');
        if (!gasEstimator?.estimateTxGasCost) throw new ArbitrageError('PC Init', 'GasEstimator invalid.');
        // Validate required config keys
        if (!config.MIN_PROFIT_THRESHOLDS?.NATIVE || !config.MIN_PROFIT_THRESHOLDS?.DEFAULT) throw new Error(`${logPrefix} Config missing NATIVE/DEFAULT MIN_PROFIT_THRESHOLDS.`);
        if (!config.CHAINLINK_FEEDS || Object.keys(config.CHAINLINK_FEEDS).length === 0) logger.warn(`${logPrefix} Config missing CHAINLINK_FEEDS.`);
        if (config.AAVE_FLASH_LOAN_FEE_BPS === undefined || config.AAVE_FLASH_LOAN_FEE_BPS === null) logger.warn(`${logPrefix} Config missing AAVE_FLASH_LOAN_FEE_BPS.`);

        // Assign validated dependencies and config values
        this.config = config;
        this.provider = provider;
        this.swapSimulator = swapSimulator;
        this.gasEstimator = gasEstimator;
        this.minProfitThresholdsConfig = this.config.MIN_PROFIT_THRESHOLDS;
        this.profitBufferPercent = BigInt(this.config.PROFIT_BUFFER_PERCENT || 5);
        this.nativeSymbol = this.config.NATIVE_CURRENCY_SYMBOL || 'ETH';
        this.wrappedNativeSymbol = this.config.WRAPPED_NATIVE_SYMBOL || 'WETH';
        this.nativeToken = Object.values(TOKENS).find(t => t?.symbol === this.nativeSymbol) || { decimals: 18, symbol: 'ETH', address: ethers.ZeroAddress, type:'native' };
        this.nativeDecimals = this.nativeToken.decimals;
        this.chainlinkFeeds = this.config.CHAINLINK_FEEDS || {};
        // Store Aave fee BPS - ensure it's a BigInt, default to 0 if missing/invalid
        this.aaveFeeBps = config.AAVE_FLASH_LOAN_FEE_BPS !== undefined && config.AAVE_FLASH_LOAN_FEE_BPS !== null
             ? BigInt(config.AAVE_FLASH_LOAN_FEE_BPS)
             : 0n;

        logger.info(`${logPrefix} Initialized. Helpers moved to profitCalcUtils. Handles Aave fee (${this.aaveFeeBps} BPS).`);
    }

    /**
     * Determines the minimum profit threshold in Wei for a given token.
     * Uses NATIVE threshold if token matches native currency, otherwise DEFAULT.
     * @param {Token} profitToken - The token object representing the profit currency.
     * @returns {bigint} The minimum profit threshold in Wei.
     * @throws {Error} If thresholds are missing or invalid.
     * @private Internal method, intended to be called by helpers passing `this`.
     */
     _getMinProfitThresholdWei(profitToken) {
        const logPrefix = '[ProfitCalculator _getMinProfitThresholdWei]';
        if (!this.minProfitThresholdsConfig?.NATIVE || !this.minProfitThresholdsConfig?.DEFAULT) {
            throw new Error(`${logPrefix} MIN_PROFIT_THRESHOLDS.NATIVE or .DEFAULT missing from config.`);
        }
        let thresholdNative = 0;
        try {
            // Determine if the profit token is the native currency (e.g., ETH)
            const isNative = profitToken.symbol === this.nativeSymbol;
            const thresholdKey = isNative ? 'NATIVE' : 'DEFAULT';
            thresholdNative = this.minProfitThresholdsConfig[thresholdKey];

            if (typeof thresholdNative !== 'number' || isNaN(thresholdNative) || thresholdNative < 0) {
                throw new Error(`Invalid threshold value for ${thresholdKey}: ${thresholdNative}`);
            }
            // Convert the threshold (which is in native currency units, e.g., 0.001 ETH) to Wei
            const thresholdWei = ethers.parseUnits(thresholdNative.toString(), this.nativeDecimals);
            logger.debug(`${logPrefix} Using ${thresholdKey} threshold: ${thresholdNative} ${this.nativeSymbol} -> ${thresholdWei} Wei`);
            return thresholdWei;
        } catch (error) {
            logger.error(`${logPrefix} Error getting/parsing threshold: ${error.message}. Config Value: ${thresholdNative}`);
            throw new Error(`Failed to determine min profit threshold: ${error.message}`);
        }
    }


    /**
     * Evaluates multiple opportunities concurrently.
     * @param {Array<object>} opportunities - Array of opportunity objects from a finder.
     * @param {string} signerAddress - The address of the bot's signing wallet.
     * @returns {Promise<Array<object>>} A promise that resolves to an array of profitable tradeData objects.
     */
    async calculate(opportunities, signerAddress) {
        const logPrefix = '[ProfitCalculator]';
        if (!opportunities || !Array.isArray(opportunities)) {
             logger.warn(`${logPrefix} calculate called with invalid opportunities array.`);
             return [];
        }
        if (!signerAddress || !ethers.isAddress(signerAddress)) {
             logger.error(`${logPrefix} calculate called with invalid signerAddress.`);
             return [];
        }
        logger.info(`${logPrefix} Evaluating ${opportunities.length} opps for signer ${signerAddress}...`);

        const profitableTrades = [];
        // Use Promise.allSettled to run evaluations concurrently
        const calculationPromises = opportunities.map(opp =>
             this.evaluateOpportunity(opp, signerAddress)
                 .catch(evalError => { // Catch errors from evaluateOpportunity itself
                      handleError(evalError, `ProfitCalculator EvaluateOpportunity (${opp?.pairKey || 'N/A'})`);
                      return { isProfitable: false, reason: `Evaluation Exception: ${evalError.message}` }; // Return standard failure object
                 })
        );
        const results = await Promise.allSettled(calculationPromises);

        results.forEach((result, index) => {
            const opp = opportunities[index];
            const pairKey = opp?.pairKey || 'N/A';

            if (result.status === 'fulfilled') {
                 const evalResult = result.value; // Result from evaluateOpportunity or its catch block
                 if (evalResult?.isProfitable && evalResult.tradeData) {
                     profitableTrades.push(evalResult.tradeData);
                     const profitEth = ethers.formatEther(evalResult.netProfitNativeWei || 0n);
                     logger.info(`${logPrefix} ✅ PROFITABLE: Pair ${pairKey}, Net ~${profitEth} ${this.nativeSymbol}`);
                 } else {
                     // Log non-profitable cases (including those that failed evaluation gracefully)
                     const netProfit = evalResult?.netProfitNativeWei;
                     const profitStr = (netProfit !== null && netProfit !== undefined) ? `Net ~${ethers.formatEther(netProfit)} ${this.nativeSymbol}` : 'Net N/A';
                     logger.info(`${logPrefix} ➖ NOT Profitable: Pair ${pairKey}, Reason: ${evalResult?.reason || 'Unknown'}, ${profitStr}`);
                 }
            } else { // status === 'rejected' - Should not happen if evaluateOpportunity catches its errors
                 logger.error(`${logPrefix} ❌ UNEXPECTED REJECTION for Opp ${pairKey}: ${result.reason?.message || result.reason}`);
                 handleError(result.reason, `ProfitCalculator Promise (${pairKey})`);
            }
        });

        logger.info(`${logPrefix} Finished eval. Found ${profitableTrades.length} profitable trades.`);
        return profitableTrades;
    }


    /**
     * Evaluates a single opportunity using helper functions.
     * @param {object} opportunity - The opportunity object from a finder.
     * @param {string} signerAddress - The address of the bot's signing wallet.
     * @returns {Promise<{isProfitable: boolean, reason: string, netProfitNativeWei: bigint|null, tradeData: object|null}>}
     */
    async evaluateOpportunity(opportunity, signerAddress) {
        const logPrefix = `[ProfitCalc Opp ${opportunity?.pairKey || 'N/A'}]`;
        let simulationResult = null;
        let gasResult = null;
        let netProfitResult = null;
        let thresholdResult = null;
        let setupResult = null;

        try {
            // --- 1. Validate & Setup ---
            setupResult = ProfitCalcUtils.validateAndSetup(opportunity, this.config, logPrefix);
            if (!setupResult.isValid) return { isProfitable: false, reason: setupResult.reason, netProfitNativeWei: null, tradeData: null };
            const { initialToken, intermediateToken, finalToken, amountInStart, poolBuyState, poolSellState } = setupResult;

            // --- 2. Simulate Swaps ---
            simulationResult = await ProfitCalcUtils.simulatePath( this.swapSimulator, initialToken, intermediateToken, finalToken, amountInStart, poolBuyState, poolSellState, logPrefix );
            if (!simulationResult.success) return { isProfitable: false, reason: simulationResult.reason, netProfitNativeWei: simulationResult.grossProfitWei_InitialToken, tradeData: null }; // Pass gross profit if available
            const { amountIntermediate, finalAmountOut, grossProfitWei_InitialToken } = simulationResult;

            // --- 3. Estimate Gas Cost & Check Validity ---
            gasResult = await ProfitCalcUtils.estimateGas(this.gasEstimator, opportunity, signerAddress, logPrefix);
            if (!gasResult.success) return { isProfitable: false, reason: gasResult.reason, netProfitNativeWei: null, tradeData: null };
            const { gasCostNativeWei, gasLimitEstimate } = gasResult;

            // --- 4. Calculate Net Profit (handles Aave fee) ---
            netProfitResult = await ProfitCalcUtils.calculateNetProfitDetails( this, grossProfitWei_InitialToken, initialToken, gasCostNativeWei, opportunity, amountInStart, logPrefix ); // Pass 'this' and amountInStart
            if (!netProfitResult.success) return { isProfitable: false, reason: netProfitResult.reason, netProfitNativeWei: netProfitResult.netProfitNativeWei, tradeData: null }; // Pass net profit if available
            const { netProfitNativeWei, grossProfitNativeWei } = netProfitResult;

            // --- 5. Apply Buffer & Compare vs Threshold ---
            thresholdResult = ProfitCalcUtils.checkThreshold(this, netProfitNativeWei, logPrefix); // Pass 'this'
            if (!thresholdResult.isProfitable) return { isProfitable: false, reason: thresholdResult.reason, netProfitNativeWei, tradeData: null };
            const { thresholdNativeWei } = thresholdResult;

            // --- 6. Build Final Trade Data ---
            const finalTradeData = await ProfitCalcUtils.buildTradeData( this, // Pass 'this' for context
                opportunity, amountInStart, amountIntermediate, finalAmountOut, grossProfitWei_InitialToken,
                grossProfitNativeWei, gasCostNativeWei, netProfitNativeWei, gasLimitEstimate, thresholdNativeWei, initialToken
            );

            // --- 7. Return Success ---
            return { isProfitable: true, netProfitNativeWei, reason: "Passed threshold", tradeData: finalTradeData };

        } catch (error) {
            // Catch errors thrown by helper functions (e.g., threshold check failure)
            handleError(error, `ProfitCalculator EvaluateOpportunity Internal (${opportunity?.pairKey || 'N/A'})`);
            // Return standard failure object
            return { isProfitable: false, reason: `Evaluation error: ${error.message}`, netProfitNativeWei: netProfitResult?.netProfitNativeWei ?? null, tradeData: null };
        }
    } // End evaluateOpportunity
} // End Class

module.exports = ProfitCalculator;
