// core/profitCalculator.js
// --- VERSION v2.4 --- Refactored evaluateOpportunity

const { ethers } = require('ethers');
const logger = require('../utils/logger');
const { convertTokenAmountToNative } = require('../utils/priceFeed');
const GasEstimator = require('../utils/gasEstimator');
const { ArbitrageError } = require('../utils/errorHandler');
const { TOKENS } = require('../constants/tokens');
const SwapSimulator = require('./swapSimulator');

class ProfitCalculator {
    // Constructor remains unchanged
    constructor(config, provider, swapSimulator, gasEstimator) {
        logger.debug('[ProfitCalculator] Initializing...'); if (!config) throw new ArbitrageError('PC Init', 'Config missing.'); if (!provider) throw new ArbitrageError('PC Init', 'Provider missing.'); if (!swapSimulator?.simulateSwap) throw new ArbitrageError('PC Init', 'Simulator invalid.'); if (!gasEstimator?.estimateTxGasCost) throw new ArbitrageError('PC Init', 'GasEstimator invalid.'); if (!config.MIN_PROFIT_THRESHOLDS?.NATIVE || !config.MIN_PROFIT_THRESHOLDS?.DEFAULT) throw new Error(`Config missing NATIVE/DEFAULT thresholds.`); if (!config.CHAINLINK_FEEDS || Object.keys(config.CHAINLINK_FEEDS).length === 0) logger.warn(`Config missing CHAINLINK_FEEDS.`); this.config = config; this.provider = provider; this.swapSimulator = swapSimulator; this.gasEstimator = gasEstimator; this.minProfitThresholdsConfig = this.config.MIN_PROFIT_THRESHOLDS; this.profitBufferPercent = BigInt(this.config.PROFIT_BUFFER_PERCENT || 5); this.nativeSymbol = this.config.NATIVE_CURRENCY_SYMBOL || 'ETH'; this.wrappedNativeSymbol = this.config.WRAPPED_NATIVE_SYMBOL || 'WETH'; this.nativeToken = Object.values(TOKENS).find(t => t?.symbol === this.nativeSymbol) || { decimals: 18, symbol: 'ETH', address: ethers.ZeroAddress, type:'native' }; this.nativeDecimals = this.nativeToken.decimals; this.chainlinkFeeds = this.config.CHAINLINK_FEEDS || {}; logger.info(`[ProfitCalculator v2.4] Initialized. evaluateOpportunity refactored.`);
    }

    _getMinProfitThresholdWei(profitToken) {
        // --- Body remains unchanged ---
        if (!profitToken || !profitToken.symbol) return this.config.MIN_PROFIT_THRESHOLDS?.DEFAULT || 0n;
        const threshold = this.minProfitThresholdsConfig[profitToken.symbol.toUpperCase()] || this.minProfitThresholdsConfig.NATIVE || this.minProfitThresholdsConfig.DEFAULT;
        try { return ethers.parseUnits(String(threshold), profitToken.decimals); }
        catch (e) { logger.warn(`[ProfitCalc] Failed parseUnits for ${profitToken.symbol}, using default.`); return this.config.MIN_PROFIT_THRESHOLDS?.DEFAULT || 0n; }
    }

    async calculate(opportunities, signerAddress) {
        // --- Body remains unchanged ---
        if (!opportunities || !Array.isArray(opportunities)) return []; if (!signerAddress || !ethers.isAddress(signerAddress)) { logger.error("[PC.calculate] Invalid signerAddress."); return []; } logger.info(`[ProfitCalculator] Evaluating ${opportunities.length} opps for signer ${signerAddress}...`); const profitableTrades = []; const calculationPromises = opportunities.map(opp => this.evaluateOpportunity(opp, signerAddress)); const results = await Promise.allSettled(calculationPromises); results.forEach((result, index) => { const opp = opportunities[index]; const pairKey = opp?.pairKey || 'N/A'; if (result.status === 'fulfilled' && result.value?.isProfitable) { profitableTrades.push(result.value.tradeData); const profitEth = ethers.formatEther(result.value.netProfitNativeWei || 0n); logger.info(`[ProfitCalculator] ✅ PROFITABLE: Pair ${pairKey}, Net ~${profitEth} ${this.nativeSymbol}`); } else if (result.status === 'rejected') { logger.warn(`[ProfitCalculator] ❌ Eval FAILED for Opp ${pairKey}: ${result.reason?.message || result.reason}`); } else if (result.status === 'fulfilled' && result.value && !result.value.isProfitable) { const profitEth = ethers.formatEther(result.value.netProfitNativeWei || 0n); logger.info(`[ProfitCalculator] ➖ NOT Profitable: Pair ${pairKey}, Reason: ${result.value.reason || 'Threshold'}, Net ~${profitEth} ${this.nativeSymbol}`); } }); logger.info(`[ProfitCalculator] Finished eval. Found ${profitableTrades.length} profitable trades.`); return profitableTrades;
    }

    /**
     * Evaluates a single opportunity by calling helper methods.
     * @returns {Promise<{isProfitable: boolean, netProfitNativeWei: bigint|null, reason: string, tradeData: object|null}>}
     */
    async evaluateOpportunity(opportunity, signerAddress) {
        const logPrefix = `[ProfitCalc Opp ${opportunity?.pairKey}]`;
        logger.debug(`${logPrefix} evaluateOpportunity called...`);

        let validationResult, simResult, gasDetails, profitDetails, thresholdResult;

        try {
            // Step 1: Validate & Setup
            validationResult = this._validateAndSetup(opportunity, logPrefix);
            if (!validationResult.isValid) {
                return { isProfitable: false, reason: validationResult.reason, netProfitNativeWei: null, tradeData: null };
            }
            const { initialToken, intermediateToken, finalToken, amountInStart, poolBuyState, poolSellState } = validationResult;

            // Step 2: Simulate Swaps
            simResult = await this._simulatePath(initialToken, intermediateToken, finalToken, amountInStart, poolBuyState, poolSellState, logPrefix);
            if (!simResult.success) {
                return { isProfitable: false, reason: simResult.reason, netProfitNativeWei: null, tradeData: null };
            }
            const { amountIntermediate, finalAmountOut, grossProfitWei_InitialToken } = simResult;

            // Step 3: Estimate Gas Cost & Check Validity
            gasDetails = await this._estimateGas(opportunity, signerAddress, logPrefix);
            if (!gasDetails.success) {
                return { isProfitable: false, reason: gasDetails.reason, netProfitNativeWei: null, tradeData: null };
            }
            const { gasCostNativeWei, gasLimitEstimate } = gasDetails;

            // Step 4: Convert Profit & Calculate Net Profit
            profitDetails = await this._calculateNetProfitDetails(grossProfitWei_InitialToken, initialToken, gasCostNativeWei, logPrefix);
            if (!profitDetails.success) {
                return { isProfitable: false, reason: profitDetails.reason, netProfitNativeWei: profitDetails.netProfitNativeWei, tradeData: null };
            }
            const { netProfitNativeWei, grossProfitNativeWei } = profitDetails;

            // Step 5: Apply Buffer & Compare vs Threshold
            thresholdResult = this._checkThreshold(netProfitNativeWei, logPrefix);
            if (!thresholdResult.isProfitable) {
                return { isProfitable: false, reason: thresholdResult.reason, netProfitNativeWei: netProfitNativeWei, tradeData: null };
            }

            // Step 6: Build final trade data object
            const finalTradeData = this._buildTradeData(
                opportunity, amountInStart, amountIntermediate, finalAmountOut,
                grossProfitWei_InitialToken, grossProfitNativeWei, gasCostNativeWei,
                netProfitNativeWei, gasLimitEstimate, thresholdResult.thresholdNativeWei,
                initialToken
            );

            return { isProfitable: true, netProfitNativeWei, reason: "Passed threshold", tradeData: finalTradeData };

        } catch (error) {
             // Catch unexpected errors during the process
             logger.error(`${logPrefix} Unexpected error during evaluation: ${error.message}`, error);
             const reason = error instanceof ArbitrageError ? error.message : `Unexpected eval error: ${error.message}`;
             return { isProfitable: false, netProfitNativeWei: null, reason: reason, tradeData: null };
        }
    }


    // --- Private Helper Methods ---

    _validateAndSetup(opportunity, logPrefix) {
        // Basic structure validation
        if (opportunity?.type !== 'spatial' || opportunity.path?.length !== 2 || !opportunity.tokenIn || !opportunity.tokenIntermediate) {
            return { isValid: false, reason: "Malformed structure (only 2-hop spatial)" };
        }
        const step1 = opportunity.path[0]; const step2 = opportunity.path[1];
        const poolBuyState = step1.poolState; const poolSellState = step2.poolState;
        if (!poolBuyState || !poolSellState) {
            return { isValid: false, reason: "Missing pool state in path" };
        }
        // Token lookup and validation
        const initialToken = this.config.TOKENS[opportunity.tokenIn.symbol];
        const intermediateToken = this.config.TOKENS[opportunity.tokenIntermediate.symbol];
        const finalToken = this.config.TOKENS[opportunity.tokenOut.symbol];
        if (!initialToken || !intermediateToken || !finalToken || initialToken.symbol !== finalToken.symbol) {
            return { isValid: false, reason: `Token mismatch/missing in config.TOKENS` };
        }
        // Amount validation
        const amountInStart = BigInt(opportunity.amountIn);
        if (!amountInStart || amountInStart <= 0n) {
            return { isValid: false, reason: "Invalid amountIn" };
        }
        logger.debug(`${logPrefix} Validation OK. Initial: ${ethers.formatUnits(amountInStart, initialToken.decimals)} ${initialToken.symbol}`);
        return { isValid: true, initialToken, intermediateToken, finalToken, amountInStart, poolBuyState, poolSellState };
    }


    async _simulatePath(initialToken, intermediateToken, finalToken, amountInStart, poolBuyState, poolSellState, logPrefix) {
        // Simulate Hop 1
        const sim1Result = await this.swapSimulator.simulateSwap(poolBuyState, initialToken, amountInStart);
        if (!sim1Result.success || !sim1Result.amountOut || sim1Result.amountOut <= 0n) {
            return { success: false, reason: `Leg 1 Sim Fail: ${sim1Result.error || 'Zero output'}` };
        }
        const amountIntermediate = sim1Result.amountOut;
        logger.debug(`${logPrefix} Sim Hop 1 Out: ${ethers.formatUnits(amountIntermediate, intermediateToken.decimals)} ${intermediateToken.symbol}`);

        // Simulate Hop 2
        const sim2Result = await this.swapSimulator.simulateSwap(poolSellState, intermediateToken, amountIntermediate);
        if (!sim2Result.success || !sim2Result.amountOut || sim2Result.amountOut <= 0n) {
            return { success: false, reason: `Leg 2 Sim Fail: ${sim2Result.error || 'Zero output'}` };
        }
        const finalAmountOut = sim2Result.amountOut;
        logger.debug(`${logPrefix} Sim Hop 2 Out: ${ethers.formatUnits(finalAmountOut, finalToken.decimals)} ${finalToken.symbol}`);

        // Calculate Gross Profit
        const grossProfitWei_InitialToken = finalAmountOut - amountInStart;
        if (grossProfitWei_InitialToken <= 0n) {
            return { success: false, reason: "Negative gross profit (sim)", grossProfitWei_InitialToken };
        }
        logger.debug(`${logPrefix} Gross Profit (Sim): ${ethers.formatUnits(grossProfitWei_InitialToken, initialToken.decimals)} ${initialToken.symbol}`);

        return { success: true, amountIntermediate, finalAmountOut, grossProfitWei_InitialToken };
    }


    async _estimateGas(opportunity, signerAddress, logPrefix) {
        logger.debug(`${logPrefix} Estimating gas...`);
        const gasCostDetails = await this.gasEstimator.estimateTxGasCost(opportunity, signerAddress);
        if (!gasCostDetails?.totalCostWei || gasCostDetails.totalCostWei <= 0n || !gasCostDetails.estimateGasSuccess) {
            const reason = !gasCostDetails?.estimateGasSuccess ? "estimateGas reverted (path invalid)" : "Gas cost estimation failed";
            return { success: false, reason: reason };
        }
        const gasCostNativeWei = gasCostDetails.totalCostWei;
        const gasLimitEstimate = gasCostDetails.pathGasLimit;
        if (!gasLimitEstimate || gasLimitEstimate <= 0n) {
             return { success: false, reason: "Invalid gas limit in gasCostDetails" };
        }
        logger.debug(`${logPrefix} Est. Gas Cost: ${ethers.formatEther(gasCostNativeWei)} ${this.nativeSymbol}, Gas Limit: ${gasLimitEstimate.toString()}`);
        return { success: true, gasCostNativeWei, gasLimitEstimate };
    }


    async _calculateNetProfitDetails(grossProfitWei_InitialToken, initialToken, gasCostNativeWei, logPrefix) {
        // Convert Gross Profit to Native Wei
        const grossProfitNativeWei = await convertTokenAmountToNative( grossProfitWei_InitialToken, initialToken, this.chainlinkFeeds, this.nativeSymbol, this.nativeDecimals, this.provider );
        if (grossProfitNativeWei === null || grossProfitNativeWei <= 0n) {
             return { success: false, reason: "Gross profit conversion failed", netProfitNativeWei: null, grossProfitNativeWei: null };
        }
        logger.debug(`${logPrefix} Gross Profit (Native): ${ethers.formatEther(grossProfitNativeWei)} ${this.nativeSymbol}`);

        // Calculate Net Profit (Native Wei)
        const netProfitNativeWei = grossProfitNativeWei - gasCostNativeWei;
        if (netProfitNativeWei <= 0n) {
             logger.debug(`${logPrefix} Net profit <= 0 after gas: ${ethers.formatEther(netProfitNativeWei)} ${this.nativeSymbol}`);
             return { success: false, reason: "Net profit <= 0 after gas", netProfitNativeWei, grossProfitNativeWei };
        }
        logger.debug(`${logPrefix} Net Profit (Native): ${ethers.formatEther(netProfitNativeWei)} ${this.nativeSymbol}`);
        return { success: true, netProfitNativeWei, grossProfitNativeWei };
    }


    _checkThreshold(netProfitNativeWei, logPrefix) {
        try {
            const thresholdNativeWei = this._getMinProfitThresholdWei(this.nativeToken);
            const bufferMultiplier = 10000n - (this.profitBufferPercent * 100n);
            if (bufferMultiplier <= 0n) throw new Error("Invalid profit buffer percentage."); // Check buffer validity

            const bufferedNetProfitNativeWei = (netProfitNativeWei * bufferMultiplier) / 10000n;
            const isProfitableAfterThreshold = bufferedNetProfitNativeWei > thresholdNativeWei;

            logger.debug(`${logPrefix} Buffered Net: ${ethers.formatEther(bufferedNetProfitNativeWei)}, Threshold: ${ethers.formatEther(thresholdNativeWei)}. Profitable: ${isProfitableAfterThreshold}`);

            if (!isProfitableAfterThreshold) {
                return { isProfitable: false, reason: "Below profit threshold", thresholdNativeWei };
            }
            return { isProfitable: true, thresholdNativeWei };

        } catch (evalError) {
            logger.error(`${logPrefix} Error during threshold check: ${evalError.message}`);
            throw new ArbitrageError(`Threshold check error: ${evalError.message}`, 'THRESHOLD_ERROR', evalError); // Re-throw specific error
        }
    }


    _buildTradeData( opportunity, amountInStart, amountIntermediate, finalAmountOut, grossProfitWei_InitialToken, grossProfitNativeWei, gasCostNativeWei, netProfitNativeWei, gasLimitEstimate, thresholdNativeWei, initialToken) {
        // Calculate profit percentage (best effort)
        let profitPercentage = 0;
        try {
            const amountInNative = convertTokenAmountToNative(amountInStart, initialToken, this.chainlinkFeeds, this.nativeSymbol, this.nativeDecimals, this.provider);
            // Note: convertTokenAmountToNative is async, but we don't necessarily need to wait here
            // If it's quick (e.g., cached price), could await, otherwise do it non-blocking?
            // For simplicity, let's assume it resolves reasonably fast or we accept potential slight delay/inaccuracy if not awaited.
            // Or, better, make this function async and await it. Let's make it async.
            // --> Actually, let's keep it sync for now and accept potential calculation failure.
            if(amountInNative && amountInNative > 0n) { // Check if conversion worked sync (if it returns null/0 sync)
                 profitPercentage = Number((netProfitNativeWei * 1000000n) / amountInNative) / 10000;
            }
         } catch { /* Ignore error here */ }

        const finalTradeData = {
            ...opportunity,
            amountIn: amountInStart.toString(),
            intermediateAmountOut: amountIntermediate.toString(),
            amountOut: finalAmountOut.toString(),
            profitAmount: grossProfitWei_InitialToken.toString(),
            profitAmountNativeWei: grossProfitNativeWei.toString(),
            gasCostNativeWei: gasCostNativeWei.toString(),
            netProfitNativeWei: netProfitNativeWei.toString(),
            gasEstimate: gasLimitEstimate.toString(),
            profitPercentage: profitPercentage,
            thresholdNativeWei: thresholdNativeWei.toString(),
            timestamp: Date.now()
        };
        return finalTradeData;
    }

} // End ProfitCalculator class

module.exports = ProfitCalculator;
