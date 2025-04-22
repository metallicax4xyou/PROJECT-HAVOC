// core/profitCalculator.js
// --- VERSION USING SIMULATOR, GAS ESTIMATOR, AND PRICE FEED ---

const { ethers } = require('ethers');
const logger = require('../utils/logger');
// *** Import GasEstimator and PriceFeed utils ***
const { convertTokenAmountToNative } = require('../utils/priceFeed'); // Adjust path
const GasEstimator = require('../utils/gasEstimator'); // Adjust path
const { ArbitrageError } = require('../utils/errorHandler');
const { TOKENS } = require('../constants/tokens');
const SwapSimulator = require('./swapSimulator'); // Need type validation

// Simulation Input Amounts (Consider moving to config)
const SIMULATION_INPUT_AMOUNTS = { /* ... same as before ... */
    'USDC':   ethers.parseUnits('100', 6), 'USDC.e': ethers.parseUnits('100', 6),
    'USDT':   ethers.parseUnits('100', 6), 'DAI':    ethers.parseUnits('100', 18),
    'WETH':   ethers.parseUnits('0.1', 18), 'WBTC':   ethers.parseUnits('0.01', 8),
};

class ProfitCalculator {
    /**
     * @param {object} config Configuration object
     * @param {ethers.Provider} provider Ethers provider instance.
     * @param {SwapSimulator} swapSimulator Instance of SwapSimulator.
     * @param {GasEstimator} gasEstimator Instance of GasEstimator. // *** ADDED gasEstimator ***
     */
    constructor(config, provider, swapSimulator, gasEstimator) { // Added gasEstimator
        logger.debug('[ProfitCalculator] Initializing...');
        // --- Validate Inputs ---
        if (!config) throw new ArbitrageError('InitializationError', 'ProfitCalculator: Missing config.');
        if (!provider) throw new ArbitrageError('InitializationError', 'ProfitCalculator: Missing provider.');
        if (!swapSimulator || typeof swapSimulator.simulateSwap !== 'function') throw new ArbitrageError('InitializationError', 'ProfitCalculator: Invalid SwapSimulator.');
        if (!gasEstimator || typeof gasEstimator.estimateTxGasCost !== 'function') throw new ArbitrageError('InitializationError', 'ProfitCalculator: Invalid GasEstimator.'); // *** Validate gasEstimator ***
        if (!config.MIN_PROFIT_THRESHOLDS?.NATIVE || !config.MIN_PROFIT_THRESHOLDS?.DEFAULT) throw new Error(`Config missing NATIVE/DEFAULT profit thresholds.`);
        if (!config.CHAINLINK_FEEDS || Object.keys(config.CHAINLINK_FEEDS).length === 0) logger.warn(`Config missing CHAINLINK_FEEDS. Profit conversion might fail.`); // Warn only

        // --- Store dependencies ---
        this.config = config;
        this.provider = provider;
        this.swapSimulator = swapSimulator;
        this.gasEstimator = gasEstimator; // *** Store gasEstimator ***
        this.minProfitThresholdsConfig = this.config.MIN_PROFIT_THRESHOLDS;
        this.profitBufferPercent = BigInt(this.config.PROFIT_BUFFER_PERCENT || 5);
        this.nativeSymbol = this.config.NATIVE_CURRENCY_SYMBOL || 'ETH';
        this.wrappedNativeSymbol = this.config.WRAPPED_NATIVE_SYMBOL || 'WETH';
        this.nativeToken = Object.values(TOKENS).find(t => t.symbol === this.nativeSymbol) || { decimals: 18, symbol: 'ETH' }; // More robust fallback
        this.nativeDecimals = this.nativeToken.decimals;
        this.chainlinkFeeds = this.config.CHAINLINK_FEEDS || {};

        logger.info(`[ProfitCalculator v2.1] Initialized with Simulator & Gas Estimator. Buffer: ${this.profitBufferPercent.toString()}%.`);
    }

    // --- _getMinProfitThresholdWei (no change) ---
    _getMinProfitThresholdWei(profitToken) { /* ... unchanged ... */
        if (!profitToken?.decimals || !profitToken?.symbol) throw new Error('Invalid profitToken.'); const canonicalSymbol = profitToken.canonicalSymbol || profitToken.symbol; let thresholdStr, thresholdTokenDecimals, thresholdTokenSymbol;
        if (profitToken.symbol === this.nativeSymbol || profitToken.symbol === this.wrappedNativeSymbol) { thresholdStr = this.minProfitThresholdsConfig.NATIVE; thresholdTokenDecimals = this.nativeDecimals; thresholdTokenSymbol = this.nativeSymbol; }
        else if (this.minProfitThresholdsConfig[canonicalSymbol]) { thresholdStr = this.minProfitThresholdsConfig[canonicalSymbol]; thresholdTokenDecimals = profitToken.decimals; thresholdTokenSymbol = canonicalSymbol; }
        else { thresholdStr = this.minProfitThresholdsConfig.DEFAULT; thresholdTokenDecimals = this.nativeDecimals; thresholdTokenSymbol = this.nativeSymbol; }
        if (!thresholdStr) throw new Error(`No threshold found for ${profitToken.symbol}.`);
        try { return ethers.parseUnits(thresholdStr, thresholdTokenDecimals); } catch (e) { logger.error(`Failed to parse threshold "${thresholdStr}"`); throw new Error(`Bad threshold: ${thresholdStr}`); }
    }

    // --- calculate method ---
    async calculate(opportunities) {
        if (!opportunities || !Array.isArray(opportunities)) return [];
        logger.info(`[ProfitCalculator] Evaluating ${opportunities.length} potential opportunities (incl. gas & simulation)...`);
        const profitableTrades = [];
        const calculationPromises = opportunities.map(opp => this.evaluateOpportunity(opp)); // Create promises
        const results = await Promise.allSettled(calculationPromises); // Evaluate concurrently

        results.forEach((result, index) => {
             const opp = opportunities[index]; // Get original opportunity for logging context
             const pairKey = opp?.pairKey || 'N/A';
             if (result.status === 'fulfilled' && result.value && result.value.isProfitable) {
                 profitableTrades.push(result.value.tradeData); // Add successful, profitable trades
                 logger.info(`[ProfitCalculator] ✅ PROFITABLE Opportunity Found: Pair ${pairKey}, Net Profit ~${ethers.formatEther(result.value.netProfitNativeWei || 0n)} ${this.nativeSymbol}`);
             } else if (result.status === 'rejected') {
                  logger.warn(`[ProfitCalculator] ❌ Evaluation failed for Opp ${pairKey}: ${result.reason?.message || result.reason}`);
             } else if (result.status === 'fulfilled' && result.value && !result.value.isProfitable) {
                  logger.info(`[ProfitCalculator] ➖ Opportunity NOT Profitable: Pair ${pairKey}, Reason: ${result.value.reason || 'Threshold not met'}, Net Profit ~${ethers.formatEther(result.value.netProfitNativeWei || 0n)} ${this.nativeSymbol}`);
             } else {
                 logger.warn(`[ProfitCalculator] Unknown evaluation result for Opp ${pairKey}.`);
             }
        });

        logger.info(`[ProfitCalculator] Finished evaluation. Found ${profitableTrades.length} profitable trades.`);
        return profitableTrades;
    }

    /**
     * Evaluates a single opportunity using simulation, gas estimation, and price feeds.
     * @param {object} opportunity The opportunity object from SpatialFinder.
     * @returns {Promise<{isProfitable: boolean, netProfitNativeWei: bigint | null, reason: string | null, tradeData: object | null}>}
     */
    async evaluateOpportunity(opportunity) {
        const logPrefix = `[ProfitCalc Opp ${opportunity.path?.[0]?.dex}/${opportunity.path?.[1]?.dex} ${opportunity.pairKey}]`;

        // Basic validation
        if (opportunity.type !== 'spatial' || !opportunity.path || opportunity.path.length !== 2 || !opportunity.tokenIn || !opportunity.tokenIntermediate || !opportunity.tokenOut) {
             return { isProfitable: false, netProfitNativeWei: null, reason: "Malformed opportunity structure", tradeData: null };
        }

        const step1 = opportunity.path[0]; const step2 = opportunity.path[1];
        const poolBuyState = step1.poolState; const poolSellState = step2.poolState;
        if (!poolBuyState || !poolSellState) { return { isProfitable: false, netProfitNativeWei: null, reason: "Missing pool state in opportunity", tradeData: null }; }

        const initialToken = this.config.TOKENS[opportunity.tokenIn];
        const intermediateToken = this.config.TOKENS[opportunity.tokenIntermediate];
        if (!initialToken || !intermediateToken) { return { isProfitable: false, netProfitNativeWei: null, reason: "Cannot find token definitions", tradeData: null }; }

        const amountInStart = BigInt(opportunity.amountIn); // Amount is now set by SpatialFinder/Sim Defaults
        if (!amountInStart || amountInStart <= 0n) { return { isProfitable: false, netProfitNativeWei: null, reason: `Invalid simulation amountIn: ${opportunity.amountIn}`, tradeData: null }; }
        logger.debug(`${logPrefix} Evaluating with initial ${ethers.formatUnits(amountInStart, initialToken.decimals)} ${initialToken.symbol}`);

        // --- Simulate Swaps ---
        const sim1Result = await this.swapSimulator.simulateSwap(poolBuyState, initialToken, amountInStart);
        if (!sim1Result.success || !sim1Result.amountOut || sim1Result.amountOut <= 0n) { return { isProfitable: false, netProfitNativeWei: null, reason: `Leg 1 Sim Failed: ${sim1Result.error || 'Zero output'}`, tradeData: null }; }
        const amountIntermediate = sim1Result.amountOut;

        const sim2Result = await this.swapSimulator.simulateSwap(poolSellState, intermediateToken, amountIntermediate);
         if (!sim2Result.success || !sim2Result.amountOut || sim2Result.amountOut <= 0n) { return { isProfitable: false, netProfitNativeWei: null, reason: `Leg 2 Sim Failed: ${sim2Result.error || 'Zero output'}`, tradeData: null }; }
        const finalAmountOut = sim2Result.amountOut;
        // --- ---

        // --- Gross Profit ---
        const grossProfitWei_InitialToken = finalAmountOut - amountInStart;
        if (grossProfitWei_InitialToken <= 0n) { return { isProfitable: false, netProfitNativeWei: null, reason: "Negative gross profit", tradeData: null }; }
        logger.debug(`${logPrefix} Gross Profit (Simulated): ${ethers.formatUnits(grossProfitWei_InitialToken, initialToken.decimals)} ${initialToken.symbol}`);
        // --- ---

        // --- Estimate Gas Cost ---
        const gasCostDetails = await this.gasEstimator.estimateTxGasCost(opportunity); // Pass opportunity for context if needed
        if (!gasCostDetails || !gasCostDetails.totalCostWei || gasCostDetails.totalCostWei <= 0n) {
             return { isProfitable: false, netProfitNativeWei: null, reason: "Failed to estimate gas cost", tradeData: null };
        }
        const gasCostNativeWei = gasCostDetails.totalCostWei;
        logger.debug(`${logPrefix} Estimated Gas Cost: ${ethers.formatEther(gasCostNativeWei)} ${this.nativeSymbol}`);
        // --- ---

        // --- Convert Gross Profit to Native Wei ---
        const grossProfitNativeWei = await convertTokenAmountToNative(
            grossProfitWei_InitialToken,
            initialToken, // Profit is in the initial token unit
            this.chainlinkFeeds,
            this.nativeSymbol,
            this.nativeDecimals,
            this.provider
        );
        if (grossProfitNativeWei === null || grossProfitNativeWei <= 0n) {
             return { isProfitable: false, netProfitNativeWei: null, reason: `Failed to convert gross profit (${initialToken.symbol}) to ${this.nativeSymbol}`, tradeData: null };
        }
        logger.debug(`${logPrefix} Gross Profit (Native): ${ethers.formatEther(grossProfitNativeWei)} ${this.nativeSymbol}`);
        // --- ---

        // --- Calculate Net Profit & Compare ---
        const netProfitNativeWei = grossProfitNativeWei - gasCostNativeWei;
        if (netProfitNativeWei <= 0n) { return { isProfitable: false, netProfitNativeWei, reason: "Net profit negative after gas", tradeData: null }; }

        try {
            // Threshold should be compared in native currency
            const thresholdNativeWei = this._getMinProfitThresholdWei(this.nativeToken);

            const bufferMultiplier = 10000n - this.profitBufferPercent * 100n;
            const bufferedNetProfitNativeWei = (netProfitNativeWei * bufferMultiplier) / 10000n;

            const isProfitableAfterThreshold = bufferedNetProfitNativeWei > thresholdNativeWei;

            logger.debug(`${logPrefix} Net Profit (Native): ${ethers.formatEther(netProfitNativeWei)}, Buffered: ${ethers.formatEther(bufferedNetProfitNativeWei)}, Threshold: ${ethers.formatEther(thresholdNativeWei)}. Profitable: ${isProfitableAfterThreshold}`);

            if (isProfitableAfterThreshold) {
                let profitPercentage = 0; if (amountInStart !== 0n) { try { const amountInNative = await convertTokenAmountToNative(amountInStart, initialToken, this.chainlinkFeeds, this.nativeSymbol, this.nativeDecimals, this.provider); if(amountInNative && amountInNative > 0n) { profitPercentage = Number( (netProfitNativeWei * 1000000n) / amountInNative ) / 10000; } } catch {} }

                const finalTradeData = {
                    ...opportunity,
                    amountIn: amountInStart.toString(),
                    amountOut: finalAmountOut.toString(), // Simulated final amount out
                    profitAmount: grossProfitWei_InitialToken.toString(), // Gross profit in initial token
                    profitAmountNativeWei: grossProfitNativeWei.toString(), // Gross profit in native wei
                    gasCostNativeWei: gasCostNativeWei.toString(),
                    netProfitNativeWei: netProfitNativeWei.toString(), // Net profit in native wei
                    profitPercentage: profitPercentage, // % based on native values
                    thresholdNativeWei: thresholdNativeWei.toString(),
                    timestamp: Date.now()
                 };
                 return { isProfitable: true, netProfitNativeWei, reason: "Passed threshold", tradeData: finalTradeData };
            } else {
                 return { isProfitable: false, netProfitNativeWei, reason: "Below profit threshold", tradeData: null };
            }
        } catch (thresholdError) {
             logger.error(`${logPrefix} Error during threshold check: ${thresholdError.message}`);
             return { isProfitable: false, netProfitNativeWei, reason: `Threshold check error: ${thresholdError.message}`, tradeData: null };
        }
        // --- ---
    }
}

module.exports = ProfitCalculator;
