// core/profitCalculator.js
// --- VERSION v2.2 ---
// Checks estimateGasSuccess flag from GasEstimator v1.4

const { ethers } = require('ethers');
const logger = require('../utils/logger');
const { convertTokenAmountToNative } = require('../utils/priceFeed');
const GasEstimator = require('../utils/gasEstimator'); // No change to import
const { ArbitrageError } = require('../utils/errorHandler');
const { TOKENS } = require('../constants/tokens');
const SwapSimulator = require('./swapSimulator');

const SIMULATION_INPUT_AMOUNTS = { /* ... */ };

class ProfitCalculator {
    constructor(config, provider, swapSimulator, gasEstimator) { /* ... unchanged constructor ... */
        logger.debug('[ProfitCalculator] Initializing...'); if (!config) throw new ArbitrageError('PC Init', 'Config missing.'); if (!provider) throw new ArbitrageError('PC Init', 'Provider missing.'); if (!swapSimulator?.simulateSwap) throw new ArbitrageError('PC Init', 'Simulator invalid.'); if (!gasEstimator?.estimateTxGasCost) throw new ArbitrageError('PC Init', 'GasEstimator invalid.'); if (!config.MIN_PROFIT_THRESHOLDS?.NATIVE || !config.MIN_PROFIT_THRESHOLDS?.DEFAULT) throw new Error(`Config missing NATIVE/DEFAULT thresholds.`); if (!config.CHAINLINK_FEEDS || Object.keys(config.CHAINLINK_FEEDS).length === 0) logger.warn(`Config missing CHAINLINK_FEEDS.`); this.config = config; this.provider = provider; this.swapSimulator = swapSimulator; this.gasEstimator = gasEstimator; this.minProfitThresholdsConfig = this.config.MIN_PROFIT_THRESHOLDS; this.profitBufferPercent = BigInt(this.config.PROFIT_BUFFER_PERCENT || 5); this.nativeSymbol = this.config.NATIVE_CURRENCY_SYMBOL || 'ETH'; this.wrappedNativeSymbol = this.config.WRAPPED_NATIVE_SYMBOL || 'WETH'; this.nativeToken = Object.values(TOKENS).find(t => t?.symbol === this.nativeSymbol) || { decimals: 18, symbol: 'ETH', address: ethers.ZeroAddress, type:'native' }; this.nativeDecimals = this.nativeToken.decimals; this.chainlinkFeeds = this.config.CHAINLINK_FEEDS || {}; logger.info(`[ProfitCalculator v2.2] Initialized. Checks estimateGas success.`);
    }

    _getMinProfitThresholdWei(profitToken) { /* ... unchanged ... */ }

    async calculate(opportunities, signerAddress) { /* ... unchanged ... */
        if (!opportunities || !Array.isArray(opportunities)) return []; if (!signerAddress || !ethers.isAddress(signerAddress)) { logger.error("[PC.calculate] Invalid signerAddress."); return []; } logger.info(`[ProfitCalculator] Evaluating ${opportunities.length} opps for signer ${signerAddress}...`); const profitableTrades = []; const calculationPromises = opportunities.map(opp => this.evaluateOpportunity(opp, signerAddress)); const results = await Promise.allSettled(calculationPromises); results.forEach((result, index) => { const opp = opportunities[index]; const pairKey = opp?.pairKey || 'N/A'; if (result.status === 'fulfilled' && result.value?.isProfitable) { profitableTrades.push(result.value.tradeData); const profitEth = ethers.formatEther(result.value.netProfitNativeWei || 0n); logger.info(`[ProfitCalculator] ✅ PROFITABLE: Pair ${pairKey}, Net ~${profitEth} ${this.nativeSymbol}`); } else if (result.status === 'rejected') { logger.warn(`[ProfitCalculator] ❌ Eval FAILED for Opp ${pairKey}: ${result.reason?.message || result.reason}`); } else if (result.status === 'fulfilled' && result.value && !result.value.isProfitable) { const profitEth = ethers.formatEther(result.value.netProfitNativeWei || 0n); logger.info(`[ProfitCalculator] ➖ NOT Profitable: Pair ${pairKey}, Reason: ${result.value.reason || 'Threshold'}, Net ~${profitEth} ${this.nativeSymbol}`); } }); logger.info(`[ProfitCalculator] Finished eval. Found ${profitableTrades.length} profitable trades.`); return profitableTrades;
    }

    /**
     * Evaluates a single opportunity using simulation, path-based gas estimation,
     * and an estimateGas validity check.
     */
    async evaluateOpportunity(opportunity, signerAddress) {
        const logPrefix = `[ProfitCalc Opp ${opportunity?.pairKey}]`;
        logger.debug(`${logPrefix} evaluateOpportunity called with signerAddress: ${signerAddress}`);
        if (!signerAddress || !ethers.isAddress(signerAddress)) { return { isProfitable: false, reason: "Internal signerAddress error" }; }

        // --- 1. Validate & Setup ---
        if (opportunity?.type !== 'spatial' || opportunity.path?.length !== 2 || !opportunity.tokenIn || !opportunity.tokenIntermediate) { return { isProfitable: false, reason: "Malformed structure" }; }
        const step1 = opportunity.path[0]; const step2 = opportunity.path[1]; const poolBuyState = step1.poolState; const poolSellState = step2.poolState; if (!poolBuyState || !poolSellState) { return { isProfitable: false, reason: "Missing pool state" }; }
        const initialToken = this.config.TOKENS[opportunity.tokenIn]; const intermediateToken = this.config.TOKENS[opportunity.tokenIntermediate]; const finalToken = this.config.TOKENS[opportunity.tokenOut]; if (!initialToken || !intermediateToken || !finalToken || initialToken.symbol !== finalToken.symbol) { return { isProfitable: false, reason: `Token mismatch/missing` }; }
        const amountInStart = BigInt(opportunity.amountIn); if (!amountInStart || amountInStart <= 0n) { return { isProfitable: false, reason: "Invalid amountIn" }; }
        logger.debug(`${logPrefix} Evaluating with initial ${ethers.formatUnits(amountInStart, initialToken.decimals)} ${initialToken.symbol}`);

        // --- 2. Simulate Swaps ---
        const sim1Result = await this.swapSimulator.simulateSwap(poolBuyState, initialToken, amountInStart); if (!sim1Result.success || !sim1Result.amountOut || sim1Result.amountOut <= 0n) { return { isProfitable: false, reason: `Leg 1 Sim Fail: ${sim1Result.error || 'Zero output'}` }; }
        const amountIntermediate = sim1Result.amountOut; const sim2Result = await this.swapSimulator.simulateSwap(poolSellState, intermediateToken, amountIntermediate); if (!sim2Result.success || !sim2Result.amountOut || sim2Result.amountOut <= 0n) { return { isProfitable: false, reason: `Leg 2 Sim Fail: ${sim2Result.error || 'Zero output'}` }; }
        const finalAmountOut = sim2Result.amountOut; logger.debug(`${logPrefix} Sim Out: ${ethers.formatUnits(finalAmountOut, finalToken.decimals)} ${finalToken.symbol}`);

        // --- 3. Gross Profit ---
        const grossProfitWei_InitialToken = finalAmountOut - amountInStart; if (grossProfitWei_InitialToken <= 0n) { return { isProfitable: false, netProfitNativeWei: null, reason: "Negative gross profit (sim)" }; } logger.debug(`${logPrefix} Gross Profit (Sim): ${ethers.formatUnits(grossProfitWei_InitialToken, initialToken.decimals)} ${initialToken.symbol}`);

        // --- 4. Estimate Gas Cost & Check Validity ---
        logger.debug(`${logPrefix} Calling gasEstimator.estimateTxGasCost...`);
        const gasCostDetails = await this.gasEstimator.estimateTxGasCost(opportunity, signerAddress);
        // ** Check if estimation failed or if estimateGas check indicated revert **
        if (!gasCostDetails?.totalCostWei || gasCostDetails.totalCostWei <= 0n || !gasCostDetails.estimateGasSuccess) {
            const reason = !gasCostDetails?.estimateGasSuccess ? "estimateGas reverted (path invalid)" : "Gas cost estimation failed";
            return { isProfitable: false, netProfitNativeWei: null, reason: reason, tradeData: null };
        }
        const gasCostNativeWei = gasCostDetails.totalCostWei;
        logger.debug(`${logPrefix} Est. Gas Cost: ${ethers.formatEther(gasCostNativeWei)} ${this.nativeSymbol}`);

        // --- 5. Convert Gross Profit to Native Wei ---
        const grossProfitNativeWei = await convertTokenAmountToNative( grossProfitWei_InitialToken, initialToken, this.chainlinkFeeds, this.nativeSymbol, this.nativeDecimals, this.provider );
        if (grossProfitNativeWei === null || grossProfitNativeWei <= 0n) { return { isProfitable: false, netProfitNativeWei: null, reason: "Gross profit conversion failed", tradeData: null }; } logger.debug(`${logPrefix} Gross Profit (Native): ${ethers.formatEther(grossProfitNativeWei)} ${this.nativeSymbol}`);

        // --- 6. Calculate Net Profit (Native Wei) ---
        const netProfitNativeWei = grossProfitNativeWei - gasCostNativeWei; if (netProfitNativeWei <= 0n) { return { isProfitable: false, netProfitNativeWei, reason: "Net profit <= 0 after gas", tradeData: null }; } logger.debug(`${logPrefix} Net Profit (Native): ${ethers.formatEther(netProfitNativeWei)} ${this.nativeSymbol}`);

        // --- 7. Apply Buffer & Compare vs Threshold ---
        try {
            const thresholdNativeWei = this._getMinProfitThresholdWei(this.nativeToken);
            const bufferMultiplier = 10000n - (this.profitBufferPercent * 100n); if (bufferMultiplier <= 0n) throw new Error("Invalid profit buffer."); const bufferedNetProfitNativeWei = (netProfitNativeWei * bufferMultiplier) / 10000n;
            const isProfitableAfterThreshold = bufferedNetProfitNativeWei > thresholdNativeWei;
            logger.debug(`${logPrefix} Buffered Net: ${ethers.formatEther(bufferedNetProfitNativeWei)}, Threshold: ${ethers.formatEther(thresholdNativeWei)}. Profitable: ${isProfitableAfterThreshold}`);
            if (isProfitableAfterThreshold) {
                 let profitPercentage = 0; try { const amountInNative = await convertTokenAmountToNative(amountInStart, initialToken, this.chainlinkFeeds, this.nativeSymbol, this.nativeDecimals, this.provider); if(amountInNative > 0n) { profitPercentage = Number((netProfitNativeWei * 1000000n) / amountInNative) / 10000;} } catch{}
                 const finalTradeData = { ...opportunity, amountIn: amountInStart.toString(), amountOut: finalAmountOut.toString(), profitAmount: grossProfitWei_InitialToken.toString(), profitAmountNativeWei: grossProfitNativeWei.toString(), gasCostNativeWei: gasCostNativeWei.toString(), netProfitNativeWei: netProfitNativeWei.toString(), profitPercentage: profitPercentage, thresholdNativeWei: thresholdNativeWei.toString(), timestamp: Date.now() };
                 return { isProfitable: true, netProfitNativeWei, reason: "Passed threshold", tradeData: finalTradeData };
            } else { return { isProfitable: false, netProfitNativeWei, reason: "Below profit threshold", tradeData: null }; }
        } catch (evalError) { logger.error(`${logPrefix} Error during final eval: ${evalError.message}`); return { isProfitable: false, netProfitNativeWei, reason: `Eval error: ${evalError.message}`, tradeData: null }; }
    }
}

module.exports = ProfitCalculator;
