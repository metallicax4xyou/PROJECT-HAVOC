// core/profitCalculator.js
// --- VERSION v2.1.1 ---
// Accepts signerAddress and passes it to GasEstimator.

const { ethers } = require('ethers');
const logger = require('../utils/logger');
const { convertTokenAmountToNative } = require('../utils/priceFeed');
const GasEstimator = require('../utils/gasEstimator');
const { ArbitrageError } = require('../utils/errorHandler');
const { TOKENS } = require('../constants/tokens');
const SwapSimulator = require('./swapSimulator');

// Simulation Input Amounts
const SIMULATION_INPUT_AMOUNTS = {
    'USDC':   ethers.parseUnits('100', 6), 'USDC.e': ethers.parseUnits('100', 6),
    'USDT':   ethers.parseUnits('100', 6), 'DAI':    ethers.parseUnits('100', 18),
    'WETH':   ethers.parseUnits('0.1', 18), 'WBTC':   ethers.parseUnits('0.01', 8),
};

class ProfitCalculator {
    constructor(config, provider, swapSimulator, gasEstimator) {
        logger.debug('[ProfitCalculator] Initializing...');
        if (!config) throw new ArbitrageError('InitializationError', 'PC: Missing config.');
        if (!provider) throw new ArbitrageError('InitializationError', 'PC: Missing provider.');
        if (!swapSimulator?.simulateSwap) throw new ArbitrageError('InitializationError', 'PC: Invalid SwapSimulator.');
        if (!gasEstimator?.estimateTxGasCost) throw new ArbitrageError('InitializationError', 'PC: Invalid GasEstimator.');
        if (!config.MIN_PROFIT_THRESHOLDS?.NATIVE || !config.MIN_PROFIT_THRESHOLDS?.DEFAULT) throw new Error(`Config missing NATIVE/DEFAULT profit thresholds.`);
        if (!config.CHAINLINK_FEEDS || Object.keys(config.CHAINLINK_FEEDS).length === 0) logger.warn(`Config missing CHAINLINK_FEEDS.`);

        this.config = config; this.provider = provider; this.swapSimulator = swapSimulator; this.gasEstimator = gasEstimator;
        this.minProfitThresholdsConfig = this.config.MIN_PROFIT_THRESHOLDS;
        this.profitBufferPercent = BigInt(this.config.PROFIT_BUFFER_PERCENT || 5);
        this.nativeSymbol = this.config.NATIVE_CURRENCY_SYMBOL || 'ETH';
        this.wrappedNativeSymbol = this.config.WRAPPED_NATIVE_SYMBOL || 'WETH';
        this.nativeToken = Object.values(TOKENS).find(t => t?.symbol === this.nativeSymbol) || { decimals: 18, symbol: 'ETH', address: ethers.ZeroAddress, type:'native' };
        this.nativeDecimals = this.nativeToken.decimals;
        this.chainlinkFeeds = this.config.CHAINLINK_FEEDS || {};
        logger.info(`[ProfitCalculator v2.1.1] Initialized. Buffer: ${this.profitBufferPercent.toString()}%.`);
    }

    _getMinProfitThresholdWei(profitToken) {
        if (!profitToken?.decimals || !profitToken?.symbol) throw new Error('Invalid profitToken.'); const canonicalSymbol = profitToken.canonicalSymbol || profitToken.symbol; let thresholdStr, thresholdTokenDecimals, thresholdTokenSymbol;
        if (profitToken.symbol === this.nativeSymbol || profitToken.symbol === this.wrappedNativeSymbol) { thresholdStr = this.minProfitThresholdsConfig.NATIVE; thresholdTokenDecimals = this.nativeDecimals; thresholdTokenSymbol = this.nativeSymbol; }
        else if (this.minProfitThresholdsConfig[canonicalSymbol]) { thresholdStr = this.minProfitThresholdsConfig[canonicalSymbol]; thresholdTokenDecimals = profitToken.decimals; thresholdTokenSymbol = canonicalSymbol; }
        else { thresholdStr = this.minProfitThresholdsConfig.DEFAULT; thresholdTokenDecimals = this.nativeDecimals; thresholdTokenSymbol = this.nativeSymbol; }
        if (!thresholdStr) throw new Error(`No threshold found for ${profitToken.symbol}.`);
        try { return ethers.parseUnits(thresholdStr, thresholdTokenDecimals); } catch (e) { logger.error(`Failed to parse threshold "${thresholdStr}"`); throw new Error(`Bad threshold: ${thresholdStr}`); }
    }

    async calculate(opportunities, signerAddress) { // Accept signerAddress
        if (!opportunities || !Array.isArray(opportunities)) return [];
        // *** Validate signerAddress received from ArbitrageEngine ***
        if (!signerAddress || !ethers.isAddress(signerAddress)) {
            logger.error("[PC.calculate] calculate method requires a valid signerAddress parameter.");
            // Optionally throw, or return empty array to prevent processing without address
            return [];
        }
        logger.info(`[ProfitCalculator] Evaluating ${opportunities.length} opportunities for signer ${signerAddress}...`);
        const profitableTrades = [];
        // *** Pass signerAddress down to evaluateOpportunity ***
        const calculationPromises = opportunities.map(opp => this.evaluateOpportunity(opp, signerAddress));
        const results = await Promise.allSettled(calculationPromises);

        results.forEach((result, index) => {
             const opp = opportunities[index]; const pairKey = opp?.pairKey || 'N/A';
             if (result.status === 'fulfilled' && result.value?.isProfitable) {
                 profitableTrades.push(result.value.tradeData); const profitEth = ethers.formatEther(result.value.netProfitNativeWei || 0n); logger.info(`[ProfitCalculator] ✅ PROFITABLE: Pair ${pairKey}, Net ~${profitEth} ${this.nativeSymbol}`);
             } else if (result.status === 'rejected') { logger.warn(`[ProfitCalculator] ❌ Eval FAILED for Opp ${pairKey}: ${result.reason?.message || result.reason}`); }
             else if (result.status === 'fulfilled' && result.value && !result.value.isProfitable) { const profitEth = ethers.formatEther(result.value.netProfitNativeWei || 0n); logger.info(`[ProfitCalculator] ➖ NOT Profitable: Pair ${pairKey}, Reason: ${result.value.reason || 'Threshold'}, Net ~${profitEth} ${this.nativeSymbol}`); }
             else { logger.warn(`[ProfitCalculator] Unknown eval result for Opp ${pairKey}.`); }
        });

        logger.info(`[ProfitCalculator] Finished evaluation. Found ${profitableTrades.length} profitable trades.`);
        return profitableTrades;
    }

    async evaluateOpportunity(opportunity, signerAddress) { // Accept signerAddress
        const logPrefix = `[ProfitCalc Opp ${opportunity?.pairKey}]`;
        // *** Log received signerAddress for confirmation ***
        logger.debug(`${logPrefix} evaluateOpportunity called with signerAddress: ${signerAddress}`);
        if (!signerAddress || !ethers.isAddress(signerAddress)) { // Final check
             logger.error(`${logPrefix} Invalid signerAddress within evaluateOpportunity!`);
             return { isProfitable: false, netProfitNativeWei: null, reason: "Internal signerAddress error", tradeData: null };
        }

        // --- 1. Validate & Setup ---
        if (opportunity?.type !== 'spatial' || !opportunity.path || opportunity.path.length !== 2 || !opportunity.tokenIn || !opportunity.tokenIntermediate || !opportunity.tokenOut) { return { isProfitable: false, reason: "Malformed structure", tradeData: null }; }
        const step1 = opportunity.path[0]; const step2 = opportunity.path[1]; const poolBuyState = step1.poolState; const poolSellState = step2.poolState; if (!poolBuyState || !poolSellState) { return { isProfitable: false, reason: "Missing pool state", tradeData: null }; }
        const initialToken = this.config.TOKENS[opportunity.tokenIn]; const intermediateToken = this.config.TOKENS[opportunity.tokenIntermediate]; const finalToken = this.config.TOKENS[opportunity.tokenOut]; if (!initialToken || !intermediateToken || !finalToken || initialToken.symbol !== finalToken.symbol) { return { isProfitable: false, reason: `Token mismatch/missing`, tradeData: null }; }
        const amountInStart = BigInt(opportunity.amountIn); if (!amountInStart || amountInStart <= 0n) { return { isProfitable: false, reason: "Invalid amountIn", tradeData: null }; }
        logger.debug(`${logPrefix} Evaluating with initial ${ethers.formatUnits(amountInStart, initialToken.decimals)} ${initialToken.symbol}`);

        // --- 2. Simulate Swaps ---
        const sim1Result = await this.swapSimulator.simulateSwap(poolBuyState, initialToken, amountInStart); if (!sim1Result.success || !sim1Result.amountOut || sim1Result.amountOut <= 0n) { return { isProfitable: false, reason: `Leg 1 Sim Fail: ${sim1Result.error || 'Zero output'}`, tradeData: null }; }
        const amountIntermediate = sim1Result.amountOut; const sim2Result = await this.swapSimulator.simulateSwap(poolSellState, intermediateToken, amountIntermediate); if (!sim2Result.success || !sim2Result.amountOut || sim2Result.amountOut <= 0n) { return { isProfitable: false, reason: `Leg 2 Sim Fail: ${sim2Result.error || 'Zero output'}`, tradeData: null }; }
        const finalAmountOut = sim2Result.amountOut; logger.debug(`${logPrefix} Sim Out: ${ethers.formatUnits(finalAmountOut, finalToken.decimals)} ${finalToken.symbol}`);

        // --- 3. Gross Profit ---
        const grossProfitWei_InitialToken = finalAmountOut - amountInStart; if (grossProfitWei_InitialToken <= 0n) { return { isProfitable: false, netProfitNativeWei: null, reason: "Negative gross profit (sim)", tradeData: null }; } logger.debug(`${logPrefix} Gross Profit (Sim): ${ethers.formatUnits(grossProfitWei_InitialToken, initialToken.decimals)} ${initialToken.symbol}`);

        // --- 4. Estimate Gas Cost ---
        // *** Pass the validated signerAddress down ***
        logger.debug(`${logPrefix} Calling gasEstimator with signer: ${signerAddress}`);
        const gasCostDetails = await this.gasEstimator.estimateTxGasCost(opportunity, signerAddress);
        if (!gasCostDetails?.totalCostWei || gasCostDetails.totalCostWei <= 0n) { return { isProfitable: false, netProfitNativeWei: null, reason: "Gas cost estimation failed", tradeData: null }; }
        const gasCostNativeWei = gasCostDetails.totalCostWei; logger.debug(`${logPrefix} Est. Gas Cost: ${ethers.formatEther(gasCostNativeWei)} ${this.nativeSymbol}`);

        // --- 5. Convert Gross Profit to Native ---
        const grossProfitNativeWei = await convertTokenAmountToNative( grossProfitWei_InitialToken, initialToken, this.chainlinkFeeds, this.nativeSymbol, this.nativeDecimals, this.provider );
        if (grossProfitNativeWei === null || grossProfitNativeWei <= 0n) { return { isProfitable: false, netProfitNativeWei: null, reason: "Gross profit conversion failed", tradeData: null }; } logger.debug(`${logPrefix} Gross Profit (Native): ${ethers.formatEther(grossProfitNativeWei)} ${this.nativeSymbol}`);

        // --- 6. Calculate Net Profit ---
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
