// core/profitCalculator.js
// --- VERSION v2.1 ---
// Uses SwapSimulator, GasEstimator, and PriceFeed for realistic net profit calculation.

const { ethers } = require('ethers');
const logger = require('../utils/logger'); // Adjust path if needed
const { convertTokenAmountToNative } = require('../utils/priceFeed'); // Adjust path
const GasEstimator = require('../utils/gasEstimator'); // Adjust path
const { ArbitrageError } = require('../utils/errorHandler'); // Adjust path
const { TOKENS } = require('../constants/tokens'); // Adjust path
const SwapSimulator = require('./swapSimulator'); // Need type validation

// Simulation Input Amounts (Consider moving to config)
// Defines the starting amount for the *first leg* of the simulation based on the quote token
const SIMULATION_INPUT_AMOUNTS = {
    'USDC':   ethers.parseUnits('100', 6), // 100 USDC
    'USDC.e': ethers.parseUnits('100', 6), // 100 USDC.e
    'USDT':   ethers.parseUnits('100', 6), // 100 USDT
    'DAI':    ethers.parseUnits('100', 18), // 100 DAI
    'WETH':   ethers.parseUnits('0.1', 18), // 0.1 WETH
    'WBTC':   ethers.parseUnits('0.01', 8), // 0.01 WBTC
    // Add default or other common quote tokens if necessary
};

class ProfitCalculator {
    /**
     * @param {object} config Configuration object
     * @param {ethers.Provider} provider Ethers provider instance.
     * @param {SwapSimulator} swapSimulator Instance of SwapSimulator.
     * @param {GasEstimator} gasEstimator Instance of GasEstimator.
     */
    constructor(config, provider, swapSimulator, gasEstimator) {
        logger.debug('[ProfitCalculator] Initializing...');
        if (!config) throw new ArbitrageError('InitializationError', 'PC: Missing config.');
        if (!provider) throw new ArbitrageError('InitializationError', 'PC: Missing provider.');
        if (!swapSimulator?.simulateSwap) throw new ArbitrageError('InitializationError', 'PC: Invalid SwapSimulator.');
        if (!gasEstimator?.estimateTxGasCost) throw new ArbitrageError('InitializationError', 'PC: Invalid GasEstimator.');
        if (!config.MIN_PROFIT_THRESHOLDS?.NATIVE || !config.MIN_PROFIT_THRESHOLDS?.DEFAULT) throw new Error(`Config missing NATIVE/DEFAULT profit thresholds.`);
        if (!config.CHAINLINK_FEEDS || Object.keys(config.CHAINLINK_FEEDS).length === 0) logger.warn(`Config missing CHAINLINK_FEEDS.`);

        this.config = config;
        this.provider = provider;
        this.swapSimulator = swapSimulator;
        this.gasEstimator = gasEstimator;
        this.minProfitThresholdsConfig = this.config.MIN_PROFIT_THRESHOLDS;
        this.profitBufferPercent = BigInt(this.config.PROFIT_BUFFER_PERCENT || 5);
        this.nativeSymbol = this.config.NATIVE_CURRENCY_SYMBOL || 'ETH';
        this.wrappedNativeSymbol = this.config.WRAPPED_NATIVE_SYMBOL || 'WETH';
        // Ensure nativeToken is correctly found or defaults safely
        this.nativeToken = Object.values(TOKENS).find(t => t?.symbol === this.nativeSymbol) || { decimals: 18, symbol: 'ETH', address: ethers.ZeroAddress, type:'native' };
        this.nativeDecimals = this.nativeToken.decimals;
        this.chainlinkFeeds = this.config.CHAINLINK_FEEDS || {};

        logger.info(`[ProfitCalculator v2.1] Initialized. Buffer: ${this.profitBufferPercent.toString()}%. Native: ${this.nativeSymbol}`);
    }

    // --- _getMinProfitThresholdWei (no change) ---
    _getMinProfitThresholdWei(profitToken) {
        if (!profitToken?.decimals || !profitToken?.symbol) throw new Error('Invalid profitToken.'); const canonicalSymbol = profitToken.canonicalSymbol || profitToken.symbol; let thresholdStr, thresholdTokenDecimals, thresholdTokenSymbol;
        if (profitToken.symbol === this.nativeSymbol || profitToken.symbol === this.wrappedNativeSymbol) { thresholdStr = this.minProfitThresholdsConfig.NATIVE; thresholdTokenDecimals = this.nativeDecimals; thresholdTokenSymbol = this.nativeSymbol; }
        else if (this.minProfitThresholdsConfig[canonicalSymbol]) { thresholdStr = this.minProfitThresholdsConfig[canonicalSymbol]; thresholdTokenDecimals = profitToken.decimals; thresholdTokenSymbol = canonicalSymbol; }
        else { thresholdStr = this.minProfitThresholdsConfig.DEFAULT; thresholdTokenDecimals = this.nativeDecimals; thresholdTokenSymbol = this.nativeSymbol; }
        if (!thresholdStr) throw new Error(`No threshold found for ${profitToken.symbol}.`);
        try { return ethers.parseUnits(thresholdStr, thresholdTokenDecimals); } catch (e) { logger.error(`Failed to parse threshold "${thresholdStr}"`); throw new Error(`Bad threshold: ${thresholdStr}`); }
    }

    // --- calculate method (Async wrapper for evaluateOpportunity) ---
    async calculate(opportunities) {
        if (!opportunities || !Array.isArray(opportunities)) return [];
        logger.info(`[ProfitCalculator] Evaluating ${opportunities.length} potential opportunities (incl. gas & simulation)...`);
        const profitableTrades = [];
        const calculationPromises = opportunities.map(opp => this.evaluateOpportunity(opp));
        const results = await Promise.allSettled(calculationPromises);

        results.forEach((result, index) => {
             const opp = opportunities[index];
             const pairKey = opp?.pairKey || 'N/A';
             if (result.status === 'fulfilled' && result.value?.isProfitable) {
                 profitableTrades.push(result.value.tradeData);
                 const profitEth = ethers.formatEther(result.value.netProfitNativeWei || 0n);
                 logger.info(`[ProfitCalculator] ✅ PROFITABLE: Pair ${pairKey}, Net ~${profitEth} ${this.nativeSymbol}`);
             } else if (result.status === 'rejected') {
                  logger.warn(`[ProfitCalculator] ❌ Eval FAILED for Opp ${pairKey}: ${result.reason?.message || result.reason}`);
             } else if (result.status === 'fulfilled' && result.value && !result.value.isProfitable) {
                  const profitEth = ethers.formatEther(result.value.netProfitNativeWei || 0n);
                  logger.info(`[ProfitCalculator] ➖ NOT Profitable: Pair ${pairKey}, Reason: ${result.value.reason || 'Threshold'}, Net ~${profitEth} ${this.nativeSymbol}`);
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
        const logPrefix = `[ProfitCalc Opp ${opportunity?.path?.[0]?.dex}/${opportunity?.path?.[1]?.dex} ${opportunity?.pairKey}]`;

        // --- 1. Validate Opportunity Structure ---
        if (opportunity?.type !== 'spatial' || !opportunity.path || opportunity.path.length !== 2 || !opportunity.tokenIn || !opportunity.tokenIntermediate || !opportunity.tokenOut) {
             return { isProfitable: false, netProfitNativeWei: null, reason: "Malformed structure", tradeData: null };
        }
        const step1 = opportunity.path[0]; const step2 = opportunity.path[1];
        const poolBuyState = step1.poolState; const poolSellState = step2.poolState;
        if (!poolBuyState || !poolSellState) { return { isProfitable: false, netProfitNativeWei: null, reason: "Missing pool state", tradeData: null }; }

        const initialToken = this.config.TOKENS[opportunity.tokenIn];
        const intermediateToken = this.config.TOKENS[opportunity.tokenIntermediate];
        const finalToken = this.config.TOKENS[opportunity.tokenOut]; // Should match initialToken
        if (!initialToken || !intermediateToken || !finalToken || initialToken.symbol !== finalToken.symbol) {
             return { isProfitable: false, netProfitNativeWei: null, reason: `Token mismatch/missing (${opportunity.tokenIn}/${opportunity.tokenIntermediate}/${opportunity.tokenOut})`, tradeData: null };
        }
        const amountInStart = BigInt(opportunity.amountIn);
        if (!amountInStart || amountInStart <= 0n) { return { isProfitable: false, netProfitNativeWei: null, reason: "Invalid amountIn", tradeData: null }; }
        logger.debug(`${logPrefix} Evaluating with initial ${ethers.formatUnits(amountInStart, initialToken.decimals)} ${initialToken.symbol}`);

        // --- 2. Simulate Swaps ---
        const sim1Result = await this.swapSimulator.simulateSwap(poolBuyState, initialToken, amountInStart);
        if (!sim1Result.success || !sim1Result.amountOut || sim1Result.amountOut <= 0n) { return { isProfitable: false, netProfitNativeWei: null, reason: `Leg 1 Sim Fail: ${sim1Result.error || 'Zero output'}`, tradeData: null }; }
        const amountIntermediate = sim1Result.amountOut;

        const sim2Result = await this.swapSimulator.simulateSwap(poolSellState, intermediateToken, amountIntermediate);
         if (!sim2Result.success || !sim2Result.amountOut || sim2Result.amountOut <= 0n) { return { isProfitable: false, netProfitNativeWei: null, reason: `Leg 2 Sim Fail: ${sim2Result.error || 'Zero output'}`, tradeData: null }; }
        const finalAmountOut = sim2Result.amountOut;
        logger.debug(`${logPrefix} Sim Out: ${ethers.formatUnits(finalAmountOut, finalToken.decimals)} ${finalToken.symbol}`);

        // --- 3. Calculate Gross Profit (Initial Token Units) ---
        const grossProfitWei_InitialToken = finalAmountOut - amountInStart;
        if (grossProfitWei_InitialToken <= 0n) { return { isProfitable: false, netProfitNativeWei: null, reason: "Negative gross profit (sim)", tradeData: null }; }
        logger.debug(`${logPrefix} Gross Profit (Sim): ${ethers.formatUnits(grossProfitWei_InitialToken, initialToken.decimals)} ${initialToken.symbol}`);

        // --- 4. Estimate Gas Cost ---
        const gasCostDetails = await this.gasEstimator.estimateTxGasCost(opportunity); // Uses fallback for now
        if (!gasCostDetails?.totalCostWei || gasCostDetails.totalCostWei <= 0n) { return { isProfitable: false, netProfitNativeWei: null, reason: "Gas cost estimation failed", tradeData: null }; }
        const gasCostNativeWei = gasCostDetails.totalCostWei;
        logger.debug(`${logPrefix} Est. Gas Cost: ${ethers.formatEther(gasCostNativeWei)} ${this.nativeSymbol}`);

        // --- 5. Convert Gross Profit to Native Wei ---
        const grossProfitNativeWei = await convertTokenAmountToNative(
            grossProfitWei_InitialToken, initialToken,
            this.chainlinkFeeds, this.nativeSymbol, this.nativeDecimals, this.provider
        );
        if (grossProfitNativeWei === null || grossProfitNativeWei <= 0n) { return { isProfitable: false, netProfitNativeWei: null, reason: "Gross profit conversion failed", tradeData: null }; }
        logger.debug(`${logPrefix} Gross Profit (Native): ${ethers.formatEther(grossProfitNativeWei)} ${this.nativeSymbol}`);

        // --- 6. Calculate Net Profit (Native Wei) ---
        const netProfitNativeWei = grossProfitNativeWei - gasCostNativeWei;
        if (netProfitNativeWei <= 0n) { return { isProfitable: false, netProfitNativeWei, reason: "Net profit <= 0 after gas", tradeData: null }; }
        logger.debug(`${logPrefix} Net Profit (Native): ${ethers.formatEther(netProfitNativeWei)} ${this.nativeSymbol}`);

        // --- 7. Apply Buffer & Compare vs Threshold ---
        try {
            const thresholdNativeWei = this._getMinProfitThresholdWei(this.nativeToken); // Get threshold for native token
            const bufferMultiplier = 10000n - (this.profitBufferPercent * 100n); // e.g., 5% buffer -> 9500
             if (bufferMultiplier <= 0n) throw new Error("Invalid profit buffer percentage."); // Sanity check
            const bufferedNetProfitNativeWei = (netProfitNativeWei * bufferMultiplier) / 10000n;

            const isProfitableAfterThreshold = bufferedNetProfitNativeWei > thresholdNativeWei;
            logger.debug(`${logPrefix} Buffered Net: ${ethers.formatEther(bufferedNetProfitNativeWei)}, Threshold: ${ethers.formatEther(thresholdNativeWei)}. Profitable: ${isProfitableAfterThreshold}`);

            if (isProfitableAfterThreshold) {
                 let profitPercentage = 0; try { const amountInNative = await convertTokenAmountToNative(amountInStart, initialToken, this.chainlinkFeeds, this.nativeSymbol, this.nativeDecimals, this.provider); if(amountInNative > 0n) { profitPercentage = Number((netProfitNativeWei * 1000000n) / amountInNative) / 10000;} } catch{}

                 const finalTradeData = { /* ... structure from previous _createOpportunity, updated amounts ... */
                    ...opportunity, // Keep original details like path structure
                    amountIn: amountInStart.toString(),
                    amountOut: finalAmountOut.toString(), // Simulated final amount
                    profitAmount: grossProfitWei_InitialToken.toString(), // Gross profit (initial token)
                    profitAmountNativeWei: grossProfitNativeWei.toString(),
                    gasCostNativeWei: gasCostNativeWei.toString(),
                    netProfitNativeWei: netProfitNativeWei.toString(),
                    profitPercentage: profitPercentage,
                    thresholdNativeWei: thresholdNativeWei.toString(), // Add threshold used
                    timestamp: Date.now()
                 };
                 return { isProfitable: true, netProfitNativeWei, reason: "Passed threshold", tradeData: finalTradeData };
            } else {
                 return { isProfitable: false, netProfitNativeWei, reason: "Below profit threshold", tradeData: null };
            }
        } catch (evalError) {
             logger.error(`${logPrefix} Error during final evaluation: ${evalError.message}`);
             return { isProfitable: false, netProfitNativeWei, reason: `Evaluation error: ${evalError.message}`, tradeData: null };
        }
        // --- ---
    }
}

module.exports = ProfitCalculator;
