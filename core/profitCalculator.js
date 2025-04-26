// core/profitCalculator.js
// --- VERSION v2.5 --- Subtracts Aave fee in net profit calculation.

const { ethers } = require('ethers');
const logger = require('../utils/logger');
const { convertTokenAmountToNative } = require('../utils/priceFeed');
const GasEstimator = require('../utils/gasEstimator');
const { ArbitrageError } = require('../utils/errorHandler');
const { TOKENS } = require('../constants/tokens');
const SwapSimulator = require('./swapSimulator');

class ProfitCalculator {
    // Constructor remains unchanged
    constructor(config, provider, swapSimulator, gasEstimator) { logger.debug('[ProfitCalculator] Initializing...'); if (!config) throw new ArbitrageError('PC Init', 'Config missing.'); if (!provider) throw new ArbitrageError('PC Init', 'Provider missing.'); if (!swapSimulator?.simulateSwap) throw new ArbitrageError('PC Init', 'Simulator invalid.'); if (!gasEstimator?.estimateTxGasCost) throw new ArbitrageError('PC Init', 'GasEstimator invalid.'); if (!config.MIN_PROFIT_THRESHOLDS?.NATIVE || !config.MIN_PROFIT_THRESHOLDS?.DEFAULT) throw new Error(`Config missing NATIVE/DEFAULT thresholds.`); if (!config.CHAINLINK_FEEDS || Object.keys(config.CHAINLINK_FEEDS).length === 0) logger.warn(`Config missing CHAINLINK_FEEDS.`); if (config.AAVE_FLASH_LOAN_FEE_BPS === undefined) logger.warn(`[PC Init] Config missing AAVE_FLASH_LOAN_FEE_BPS.`); this.config = config; this.provider = provider; this.swapSimulator = swapSimulator; this.gasEstimator = gasEstimator; this.minProfitThresholdsConfig = this.config.MIN_PROFIT_THRESHOLDS; this.profitBufferPercent = BigInt(this.config.PROFIT_BUFFER_PERCENT || 5); this.nativeSymbol = this.config.NATIVE_CURRENCY_SYMBOL || 'ETH'; this.wrappedNativeSymbol = this.config.WRAPPED_NATIVE_SYMBOL || 'WETH'; this.nativeToken = Object.values(TOKENS).find(t => t?.symbol === this.nativeSymbol) || { decimals: 18, symbol: 'ETH', address: ethers.ZeroAddress, type:'native' }; this.nativeDecimals = this.nativeToken.decimals; this.chainlinkFeeds = this.config.CHAINLINK_FEEDS || {}; this.aaveFeeBps = this.config.AAVE_FLASH_LOAN_FEE_BPS; logger.info(`[ProfitCalculator v2.5] Initialized. Handles Aave fee. evaluateOpportunity refactored.`); } // Added AAVE fee check/store

    _getMinProfitThresholdWei(profitToken) { /* ... unchanged ... */ if (!profitToken || !profitToken.symbol) return this.config.MIN_PROFIT_THRESHOLDS?.DEFAULT || 0n; const threshold = this.minProfitThresholdsConfig[profitToken.symbol.toUpperCase()] || this.minProfitThresholdsConfig.NATIVE || this.minProfitThresholdsConfig.DEFAULT; try { return ethers.parseUnits(String(threshold), profitToken.decimals); } catch (e) { logger.warn(`[ProfitCalc] Failed parseUnits for ${profitToken.symbol}, using default.`); return this.config.MIN_PROFIT_THRESHOLDS?.DEFAULT || 0n; } }

    async calculate(opportunities, signerAddress) { /* ... unchanged ... */ if (!opportunities || !Array.isArray(opportunities)) return []; if (!signerAddress || !ethers.isAddress(signerAddress)) { logger.error("[PC.calculate] Invalid signerAddress."); return []; } logger.info(`[ProfitCalculator] Evaluating ${opportunities.length} opps for signer ${signerAddress}...`); const profitableTrades = []; const calculationPromises = opportunities.map(opp => this.evaluateOpportunity(opp, signerAddress)); const results = await Promise.allSettled(calculationPromises); results.forEach((result, index) => { const opp = opportunities[index]; const pairKey = opp?.pairKey || 'N/A'; if (result.status === 'fulfilled' && result.value?.isProfitable) { profitableTrades.push(result.value.tradeData); const profitEth = ethers.formatEther(result.value.netProfitNativeWei || 0n); logger.info(`[ProfitCalculator] ✅ PROFITABLE: Pair ${pairKey}, Net ~${profitEth} ${this.nativeSymbol}`); } else if (result.status === 'rejected') { logger.warn(`[ProfitCalculator] ❌ Eval FAILED for Opp ${pairKey}: ${result.reason?.message || result.reason}`); } else if (result.status === 'fulfilled' && result.value && !result.value.isProfitable) { const profitEth = ethers.formatEther(result.value.netProfitNativeWei || 0n); logger.info(`[ProfitCalculator] ➖ NOT Profitable: Pair ${pairKey}, Reason: ${result.value.reason || 'Threshold'}, Net ~${profitEth} ${this.nativeSymbol}`); } }); logger.info(`[ProfitCalculator] Finished eval. Found ${profitableTrades.length} profitable trades.`); return profitableTrades; }

    async evaluateOpportunity(opportunity, signerAddress) { /* ... unchanged outer structure ... */
        const logPrefix = `[ProfitCalc Opp ${opportunity?.pairKey}]`; logger.debug(`${logPrefix} evaluateOpportunity called...`); let validationResult, simResult, gasDetails, profitDetails, thresholdResult; try { validationResult = this._validateAndSetup(opportunity, logPrefix); if (!validationResult.isValid) { return { isProfitable: false, reason: validationResult.reason, netProfitNativeWei: null, tradeData: null }; } const { initialToken, intermediateToken, finalToken, amountInStart, poolBuyState, poolSellState } = validationResult; simResult = await this._simulatePath(initialToken, intermediateToken, finalToken, amountInStart, poolBuyState, poolSellState, logPrefix); if (!simResult.success) { return { isProfitable: false, reason: simResult.reason, netProfitNativeWei: null, tradeData: null }; } const { amountIntermediate, finalAmountOut, grossProfitWei_InitialToken } = simResult; gasDetails = await this._estimateGas(opportunity, signerAddress, logPrefix); if (!gasDetails.success) { return { isProfitable: false, reason: gasDetails.reason, netProfitNativeWei: null, tradeData: null }; } const { gasCostNativeWei, gasLimitEstimate } = gasDetails;
            // --- Pass opportunity to profit calculation for fee check ---
            profitDetails = await this._calculateNetProfitDetails(grossProfitWei_InitialToken, initialToken, gasCostNativeWei, opportunity, logPrefix); // <<< ADDED opportunity
            // --- ---
             if (!profitDetails.success) { return { isProfitable: false, reason: profitDetails.reason, netProfitNativeWei: profitDetails.netProfitNativeWei, tradeData: null }; } const { netProfitNativeWei, grossProfitNativeWei } = profitDetails; thresholdResult = this._checkThreshold(netProfitNativeWei, logPrefix); if (!thresholdResult.isProfitable) { return { isProfitable: false, reason: thresholdResult.reason, netProfitNativeWei: netProfitNativeWei, tradeData: null }; } const finalTradeData = this._buildTradeData( opportunity, amountInStart, amountIntermediate, finalAmountOut, grossProfitWei_InitialToken, grossProfitNativeWei, gasCostNativeWei, netProfitNativeWei, gasLimitEstimate, thresholdResult.thresholdNativeWei, initialToken ); return { isProfitable: true, netProfitNativeWei, reason: "Passed threshold", tradeData: finalTradeData }; } catch (error) { logger.error(`${logPrefix} Unexpected error during evaluation: ${error.message}`, error); const reason = error instanceof ArbitrageError ? error.message : `Unexpected eval error: ${error.message}`; return { isProfitable: false, netProfitNativeWei: null, reason: reason, tradeData: null }; }
     }

    // --- Private Helper Methods ---

    _validateAndSetup(opportunity, logPrefix) { /* ... unchanged ... */ if (opportunity?.type !== 'spatial' || opportunity.path?.length !== 2 || !opportunity.tokenIn || !opportunity.tokenIntermediate) { return { isValid: false, reason: "Malformed structure (only 2-hop spatial)" }; } const step1 = opportunity.path[0]; const step2 = opportunity.path[1]; const poolBuyState = step1.poolState; const poolSellState = step2.poolState; if (!poolBuyState || !poolSellState) { return { isValid: false, reason: "Missing pool state in path" }; } const initialToken = this.config.TOKENS[opportunity.tokenIn.symbol]; const intermediateToken = this.config.TOKENS[opportunity.tokenIntermediate.symbol]; const finalToken = this.config.TOKENS[opportunity.tokenOut.symbol]; if (!initialToken || !intermediateToken || !finalToken || initialToken.symbol !== finalToken.symbol) { return { isValid: false, reason: `Token mismatch/missing in config.TOKENS` }; } const amountInStart = BigInt(opportunity.amountIn); if (!amountInStart || amountInStart <= 0n) { return { isValid: false, reason: "Invalid amountIn" }; } logger.debug(`${logPrefix} Validation OK. Initial: ${ethers.formatUnits(amountInStart, initialToken.decimals)} ${initialToken.symbol}`); return { isValid: true, initialToken, intermediateToken, finalToken, amountInStart, poolBuyState, poolSellState }; }

    async _simulatePath(initialToken, intermediateToken, finalToken, amountInStart, poolBuyState, poolSellState, logPrefix) { /* ... unchanged ... */ const sim1Result = await this.swapSimulator.simulateSwap(poolBuyState, initialToken, amountInStart); if (!sim1Result.success || !sim1Result.amountOut || sim1Result.amountOut <= 0n) { return { success: false, reason: `Leg 1 Sim Fail: ${sim1Result.error || 'Zero output'}` }; } const amountIntermediate = sim1Result.amountOut; logger.debug(`${logPrefix} Sim Hop 1 Out: ${ethers.formatUnits(amountIntermediate, intermediateToken.decimals)} ${intermediateToken.symbol}`); const sim2Result = await this.swapSimulator.simulateSwap(poolSellState, intermediateToken, amountIntermediate); if (!sim2Result.success || !sim2Result.amountOut || sim2Result.amountOut <= 0n) { return { success: false, reason: `Leg 2 Sim Fail: ${sim2Result.error || 'Zero output'}` }; } const finalAmountOut = sim2Result.amountOut; logger.debug(`${logPrefix} Sim Hop 2 Out: ${ethers.formatUnits(finalAmountOut, finalToken.decimals)} ${finalToken.symbol}`); const grossProfitWei_InitialToken = finalAmountOut - amountInStart; if (grossProfitWei_InitialToken <= 0n) { return { success: false, reason: "Negative gross profit (sim)", grossProfitWei_InitialToken }; } logger.debug(`${logPrefix} Gross Profit (Sim): ${ethers.formatUnits(grossProfitWei_InitialToken, initialToken.decimals)} ${initialToken.symbol}`); return { success: true, amountIntermediate, finalAmountOut, grossProfitWei_InitialToken }; }

    async _estimateGas(opportunity, signerAddress, logPrefix) { /* ... unchanged ... */ logger.debug(`${logPrefix} Estimating gas...`); const gasCostDetails = await this.gasEstimator.estimateTxGasCost(opportunity, signerAddress); if (!gasCostDetails?.totalCostWei || gasCostDetails.totalCostWei <= 0n || !gasCostDetails.estimateGasSuccess) { const reason = !gasCostDetails?.estimateGasSuccess ? "estimateGas reverted (path invalid)" : "Gas cost estimation failed"; return { success: false, reason: reason }; } const gasCostNativeWei = gasCostDetails.totalCostWei; const gasLimitEstimate = gasCostDetails.pathGasLimit; if (!gasLimitEstimate || gasLimitEstimate <= 0n) { return { success: false, reason: "Invalid gas limit in gasCostDetails" }; } logger.debug(`${logPrefix} Est. Gas Cost: ${ethers.formatEther(gasCostNativeWei)} ${this.nativeSymbol}, Gas Limit: ${gasLimitEstimate.toString()}`); return { success: true, gasCostNativeWei, gasLimitEstimate }; }

    // --- MODIFIED _calculateNetProfitDetails ---
    async _calculateNetProfitDetails(grossProfitWei_InitialToken, initialToken, gasCostNativeWei, opportunity, logPrefix) { // Added opportunity
        // Convert Gross Profit to Native Wei
        const grossProfitNativeWei = await convertTokenAmountToNative( grossProfitWei_InitialToken, initialToken, this.chainlinkFeeds, this.nativeSymbol, this.nativeDecimals, this.provider );
        if (grossProfitNativeWei === null || grossProfitNativeWei <= 0n) {
             return { success: false, reason: "Gross profit conversion failed", netProfitNativeWei: null, grossProfitNativeWei: null };
        }
        logger.debug(`${logPrefix} Gross Profit (Native): ${ethers.formatEther(grossProfitNativeWei)} ${this.nativeSymbol}`);

        let totalFeesNativeWei = gasCostNativeWei; // Start with gas cost

        // --- ADD AAVE FEE IF APPLICABLE ---
        // Check if path starts with non-V3 (indication Aave might be used)
        // TODO: A cleaner approach is to have tradeHandler pass the chosen provider type
        const likelyUsesAave = opportunity.path[0].dex !== 'uniswapV3';
        if (likelyUsesAave && this.aaveFeeBps !== undefined && this.aaveFeeBps > 0n) {
             try {
                 // Calculate Aave fee on the *borrowed* amount (amountInStart)
                 const borrowedAmountNativeWei = await convertTokenAmountToNative( opportunity.amountIn, initialToken, this.chainlinkFeeds, this.nativeSymbol, this.nativeDecimals, this.provider );
                 if (borrowedAmountNativeWei && borrowedAmountNativeWei > 0n) {
                      const aaveFeeNativeWei = (borrowedAmountNativeWei * this.aaveFeeBps) / 10000n;
                      logger.debug(`${logPrefix} Adding estimated Aave Fee (Native): ${ethers.formatEther(aaveFeeNativeWei)} ${this.nativeSymbol}`);
                      totalFeesNativeWei += aaveFeeNativeWei;
                 } else {
                      logger.warn(`${logPrefix} Could not convert borrow amount to native to estimate Aave fee accurately.`);
                      // Decide how to handle this? Add a fixed penalty? For now, proceed without explicit Aave fee.
                 }
             } catch (feeConvError) {
                  logger.error(`${logPrefix} Error calculating/converting Aave fee: ${feeConvError.message}`);
                  // Proceed without Aave fee if calculation fails
             }
        }
        // --- END AAVE FEE ---

        // Calculate Net Profit (Native Wei) using total fees
        const netProfitNativeWei = grossProfitNativeWei - totalFeesNativeWei;
        if (netProfitNativeWei <= 0n) {
             logger.debug(`${logPrefix} Net profit <= 0 after total fees (gas + flash): ${ethers.formatEther(netProfitNativeWei)} ${this.nativeSymbol}`);
             return { success: false, reason: "Net profit <= 0 after fees", netProfitNativeWei, grossProfitNativeWei };
        }
        logger.debug(`${logPrefix} Net Profit (Native, after fees): ${ethers.formatEther(netProfitNativeWei)} ${this.nativeSymbol}`);
        return { success: true, netProfitNativeWei, grossProfitNativeWei };
    }
    // --- END MODIFIED ---

    _checkThreshold(netProfitNativeWei, logPrefix) { /* ... unchanged ... */ try { const thresholdNativeWei = this._getMinProfitThresholdWei(this.nativeToken); const bufferMultiplier = 10000n - (this.profitBufferPercent * 100n); if (bufferMultiplier <= 0n) throw new Error("Invalid profit buffer percentage."); const bufferedNetProfitNativeWei = (netProfitNativeWei * bufferMultiplier) / 10000n; const isProfitableAfterThreshold = bufferedNetProfitNativeWei > thresholdNativeWei; logger.debug(`${logPrefix} Buffered Net: ${ethers.formatEther(bufferedNetProfitNativeWei)}, Threshold: ${ethers.formatEther(thresholdNativeWei)}. Profitable: ${isProfitableAfterThreshold}`); if (!isProfitableAfterThreshold) { return { isProfitable: false, reason: "Below profit threshold", thresholdNativeWei }; } return { isProfitable: true, thresholdNativeWei }; } catch (evalError) { logger.error(`${logPrefix} Error during threshold check: ${evalError.message}`); throw new ArbitrageError(`Threshold check error: ${evalError.message}`, 'THRESHOLD_ERROR', evalError); } }

    // Modified to potentially await price feed conversion
    async _buildTradeData( opportunity, amountInStart, amountIntermediate, finalAmountOut, grossProfitWei_InitialToken, grossProfitNativeWei, gasCostNativeWei, netProfitNativeWei, gasLimitEstimate, thresholdNativeWei, initialToken) { /* ... Now async ... */
        let profitPercentage = 0;
        try {
            // Await the conversion for better accuracy
            const amountInNative = await convertTokenAmountToNative(amountInStart, initialToken, this.chainlinkFeeds, this.nativeSymbol, this.nativeDecimals, this.provider);
            if (amountInNative && amountInNative > 0n) {
                 profitPercentage = Number((netProfitNativeWei * 1000000n) / amountInNative) / 10000;
            }
         } catch (percError) { logger.warn(`[ProfitCalc] Failed to calculate profitPercentage: ${percError.message}`); }

        const finalTradeData = { /* ... unchanged structure ... */ ...opportunity, amountIn: amountInStart.toString(), intermediateAmountOut: amountIntermediate.toString(), amountOut: finalAmountOut.toString(), profitAmount: grossProfitWei_InitialToken.toString(), profitAmountNativeWei: grossProfitNativeWei.toString(), gasCostNativeWei: gasCostNativeWei.toString(), netProfitNativeWei: netProfitNativeWei.toString(), gasEstimate: gasLimitEstimate.toString(), profitPercentage: profitPercentage, thresholdNativeWei: thresholdNativeWei.toString(), timestamp: Date.now() };
        return finalTradeData;
    } // Made async to await conversion

} // End ProfitCalculator class

module.exports = ProfitCalculator;
