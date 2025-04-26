// core/profitCalculator.js
// --- VERSION v2.6 --- Refactored helpers to profitCalcUtils.js

const { ethers } = require('ethers');
const logger = require('../utils/logger');
// Removed direct dependency on priceFeed here, helpers use it
const GasEstimator = require('../utils/gasEstimator');
const { ArbitrageError } = require('../utils/errorHandler');
const { TOKENS } = require('../constants/tokens');
const SwapSimulator = require('./swapSimulator');

// --- Import Helper Functions ---
const ProfitCalcUtils = require('./profitCalcUtils');
// --- ---

class ProfitCalculator {
    // Constructor remains largely unchanged, stores instances needed by helpers
    constructor(config, provider, swapSimulator, gasEstimator) {
        logger.debug('[ProfitCalculator] Initializing...');
        if (!config) throw new ArbitrageError('PC Init', 'Config missing.');
        if (!provider) throw new ArbitrageError('PC Init', 'Provider missing.');
        if (!swapSimulator?.simulateSwap) throw new ArbitrageError('PC Init', 'Simulator invalid.');
        if (!gasEstimator?.estimateTxGasCost) throw new ArbitrageError('PC Init', 'GasEstimator invalid.');
        if (!config.MIN_PROFIT_THRESHOLDS?.NATIVE || !config.MIN_PROFIT_THRESHOLDS?.DEFAULT) { throw new Error(`Config missing MIN_PROFIT_THRESHOLDS NATIVE/DEFAULT keys.`); }
        if (!config.CHAINLINK_FEEDS || Object.keys(config.CHAINLINK_FEEDS).length === 0) { logger.warn(`[PC Init] Config missing CHAINLINK_FEEDS.`); }
        if (config.AAVE_FLASH_LOAN_FEE_BPS === undefined || typeof config.AAVE_FLASH_LOAN_FEE_BPS !== 'bigint') { logger.warn(`[PC Init] Config missing/invalid AAVE_FLASH_LOAN_FEE_BPS.`); this.aaveFeeBps = 0n;} else { this.aaveFeeBps = config.AAVE_FLASH_LOAN_FEE_BPS;}

        this.config = config;
        this.provider = provider;
        this.swapSimulator = swapSimulator; // Needed by simulatePath helper
        this.gasEstimator = gasEstimator; // Needed by estimateGas helper
        this.minProfitThresholdsConfig = this.config.MIN_PROFIT_THRESHOLDS;
        this.profitBufferPercent = BigInt(this.config.PROFIT_BUFFER_PERCENT || 5); // Needed by checkThreshold helper
        this.nativeSymbol = this.config.NATIVE_CURRENCY_SYMBOL || 'ETH'; // Needed by helpers
        this.nativeToken = Object.values(TOKENS).find(t => t?.symbol === this.nativeSymbol) || { decimals: 18, symbol: 'ETH', address: ethers.ZeroAddress, type:'native' }; // Needed by helpers
        this.nativeDecimals = this.nativeToken.decimals; // Needed by helpers
        this.chainlinkFeeds = this.config.CHAINLINK_FEEDS || {}; // Needed by helpers

        logger.info(`[ProfitCalculator v2.6] Initialized. Helpers moved to profitCalcUtils. Handles Aave fee (${this.aaveFeeBps} BPS).`);
    }

    // Keep this internal method here as it's simple and uses instance config
    _getMinProfitThresholdWei(profitToken) {
        if (!profitToken || !profitToken.symbol) return this.config.MIN_PROFIT_THRESHOLDS?.DEFAULT || 0n;
        const threshold = this.minProfitThresholdsConfig[profitToken.symbol.toUpperCase()] || this.minProfitThresholdsConfig.NATIVE || this.minProfitThresholdsConfig.DEFAULT;
        try { const thresholdString = String(threshold || '0'); return ethers.parseUnits(thresholdString, profitToken.decimals); }
        catch (e) { logger.warn(`[ProfitCalc] Failed parseUnits for threshold '${threshold}' for ${profitToken.symbol}, using default.`); const defaultThresholdString = String(this.config.MIN_PROFIT_THRESHOLDS?.DEFAULT || '0'); try { return ethers.parseUnits(defaultThresholdString, this.nativeDecimals); } catch { return 0n; } }
    }

    // Calculate method remains the same - orchestrates calls to evaluateOpportunity
    async calculate(opportunities, signerAddress) {
        if (!opportunities || !Array.isArray(opportunities)) return []; if (!signerAddress || !ethers.isAddress(signerAddress)) { logger.error("[PC.calculate] Invalid signerAddress."); return []; } logger.info(`[ProfitCalculator] Evaluating ${opportunities.length} opps for signer ${signerAddress}...`); const profitableTrades = []; const calculationPromises = opportunities.map(opp => this.evaluateOpportunity(opp, signerAddress)); const results = await Promise.allSettled(calculationPromises); results.forEach((result, index) => { const opp = opportunities[index]; const pairKey = opp?.pairKey || 'N/A'; if (result.status === 'fulfilled' && result.value?.isProfitable) { profitableTrades.push(result.value.tradeData); const profitEth = ethers.formatEther(result.value.netProfitNativeWei || 0n); logger.info(`[ProfitCalculator] ✅ PROFITABLE: Pair ${pairKey}, Net ~${profitEth} ${this.nativeSymbol}`); } else if (result.status === 'rejected') { logger.warn(`[ProfitCalculator] ❌ Eval CRASHED for Opp ${pairKey}: ${result.reason?.message || result.reason}`); } else if (result.status === 'fulfilled' && result.value && !result.value.isProfitable) { const profitEth = ethers.formatEther(result.value.netProfitNativeWei || 0n); logger.info(`[ProfitCalculator] ➖ NOT Profitable: Pair ${pairKey}, Reason: ${result.value.reason || 'Unknown'}, Net ~${profitEth} ${this.nativeSymbol}`); } else if (result.status === 'fulfilled' && !result.value) { logger.error(`[ProfitCalculator] ❌ Eval returned unexpected null/undefined for Opp ${pairKey}`); } }); logger.info(`[ProfitCalculator] Finished eval. Found ${profitableTrades.length} profitable trades.`); return profitableTrades;
    }

    /**
     * Evaluates a single opportunity by calling imported helper functions.
     * @returns {Promise<{isProfitable: boolean, netProfitNativeWei: bigint|null, reason: string, tradeData: object|null}>}
     */
    async evaluateOpportunity(opportunity, signerAddress) {
        const logPrefix = `[ProfitCalc Opp ${opportunity?.pairKey}]`;
        logger.debug(`${logPrefix} evaluateOpportunity called...`);

        try {
            // Step 1: Validate & Setup
            const validationResult = ProfitCalcUtils.validateAndSetup(opportunity, this.config, logPrefix);
            if (!validationResult.isValid) return { isProfitable: false, reason: validationResult.reason, tradeData: null };
            const { initialToken, intermediateToken, finalToken, amountInStart, poolBuyState, poolSellState } = validationResult;

            // Step 2: Simulate Swaps
            const simResult = await ProfitCalcUtils.simulatePath(this.swapSimulator, initialToken, intermediateToken, finalToken, amountInStart, poolBuyState, poolSellState, logPrefix);
            if (!simResult.success) return { isProfitable: false, reason: simResult.reason, tradeData: null };
            const { amountIntermediate, finalAmountOut, grossProfitWei_InitialToken } = simResult;

            // Step 3: Estimate Gas Cost & Check Validity
            const gasDetails = await ProfitCalcUtils.estimateGas(this.gasEstimator, opportunity, signerAddress, logPrefix);
            if (!gasDetails.success) return { isProfitable: false, reason: gasDetails.reason, tradeData: null };
            const { gasCostNativeWei, gasLimitEstimate } = gasDetails;

            // Step 4: Calculate Net Profit (includes Aave fee logic)
            const profitDetails = await ProfitCalcUtils.calculateNetProfitDetails(this, grossProfitWei_InitialToken, initialToken, gasCostNativeWei, opportunity, amountInStart, logPrefix); // Pass instance 'this'
            if (!profitDetails.success) return { isProfitable: false, reason: profitDetails.reason, netProfitNativeWei: profitDetails.netProfitNativeWei, tradeData: null };
            const { netProfitNativeWei, grossProfitNativeWei } = profitDetails;

            // Step 5: Apply Buffer & Compare vs Threshold
            const thresholdResult = ProfitCalcUtils.checkThreshold(this, netProfitNativeWei, logPrefix); // Pass instance 'this'
            if (!thresholdResult.isProfitable) return { isProfitable: false, reason: thresholdResult.reason, netProfitNativeWei: netProfitNativeWei, tradeData: null };

            // Step 6: Build final trade data object
            const finalTradeData = await ProfitCalcUtils.buildTradeData( // Await async buildTradeData
                this, opportunity, amountInStart, amountIntermediate, finalAmountOut,
                grossProfitWei_InitialToken, grossProfitNativeWei, gasCostNativeWei,
                netProfitNativeWei, gasLimitEstimate, thresholdResult.thresholdNativeWei,
                initialToken
            );

            return { isProfitable: true, netProfitNativeWei, reason: "Passed threshold", tradeData: finalTradeData };

        } catch (error) {
             logger.error(`${logPrefix} Unexpected error during evaluation: ${error.message}`, error);
             if (!(error instanceof ArbitrageError)) { throw error; } // Re-throw unexpected
             return { isProfitable: false, reason: error.message, tradeData: null }; // Return structure for handled ArbitrageErrors
        }
    }

} // End ProfitCalculator class

module.exports = ProfitCalculator;
