// core/profitCalculator.js
// --- VERSION USING SWAP SIMULATOR ---

const { ethers } = require('ethers');
const logger = require('../utils/logger');
// No priceFeed needed yet if we calculate profit in intermediate token
// const { getChainlinkPriceData, convertTokenAmountToWei } = require('../utils/priceFeed');
const { ArbitrageError } = require('../utils/errorHandler');
const { TOKENS } = require('../constants/tokens');
const SwapSimulator = require('./swapSimulator'); // Need type for validation if using TS

// Define a fixed input amount for simulation (e.g., 1 USDC, 0.1 WETH)
// TODO: Make this dynamic later
const SIMULATION_INPUT_AMOUNTS = {
    'USDC':   ethers.parseUnits('100', 6), // 100 USDC
    'USDC.e': ethers.parseUnits('100', 6), // 100 USDC.e
    'USDT':   ethers.parseUnits('100', 6), // 100 USDT
    'DAI':    ethers.parseUnits('100', 18), // 100 DAI
    'WETH':   ethers.parseUnits('0.1', 18), // 0.1 WETH
    'WBTC':   ethers.parseUnits('0.01', 8), // 0.01 WBTC
    // Add other potential quote tokens if needed
};


class ProfitCalculator {
    /**
     * @param {object} config Configuration object
     * @param {ethers.Provider} provider Ethers provider instance.
     * @param {SwapSimulator} swapSimulator Instance of SwapSimulator.
     */
    constructor(config, provider, swapSimulator) { // Added swapSimulator
        logger.debug('[ProfitCalculator] Initializing...');
        if (!config) { throw new ArbitrageError('InitializationError', 'ProfitCalculator: Missing config.'); }
        if (!provider) { throw new ArbitrageError('InitializationError', 'ProfitCalculator: Missing provider.'); }
        if (!swapSimulator || typeof swapSimulator.simulateSwap !== 'function') { // Check simulator
             throw new ArbitrageError('InitializationError', 'ProfitCalculator: Valid SwapSimulator instance required.');
         }
        // Simplified validation - assume necessary keys exist for now
        if (!config.MIN_PROFIT_THRESHOLDS?.NATIVE || !config.MIN_PROFIT_THRESHOLDS?.DEFAULT) { throw new Error(`Config missing NATIVE/DEFAULT profit thresholds.`); }

        this.config = config;
        this.provider = provider;
        this.swapSimulator = swapSimulator; // Store simulator instance
        this.minProfitThresholdsConfig = this.config.MIN_PROFIT_THRESHOLDS;
        this.profitBufferPercent = BigInt(this.config.PROFIT_BUFFER_PERCENT || 5); // Default buffer
        this.nativeSymbol = this.config.NATIVE_CURRENCY_SYMBOL || 'ETH';
        this.wrappedNativeSymbol = this.config.WRAPPED_NATIVE_SYMBOL || 'WETH';
        this.nativeToken = Object.values(TOKENS).find(t => t.symbol === this.nativeSymbol) || { decimals: 18 }; // Fallback
        this.nativeDecimals = this.nativeToken.decimals;

        logger.info(`[ProfitCalculator v2.0] Initialized with SwapSimulator. Buffer: ${this.profitBufferPercent.toString()}%.`);
    }

    // --- _getMinProfitThresholdWei (no change needed from Response #24) ---
    _getMinProfitThresholdWei(profitToken) {
        // ... (keep implementation from Response #24 / #30) ...
        if (!profitToken?.decimals || !profitToken?.symbol) throw new Error('Invalid profitToken.');
        const canonicalSymbol = profitToken.canonicalSymbol || profitToken.symbol;
        let thresholdStr, thresholdTokenDecimals, thresholdTokenSymbol;
        if (profitToken.symbol === this.nativeSymbol || profitToken.symbol === this.wrappedNativeSymbol) { thresholdStr = this.minProfitThresholdsConfig.NATIVE; thresholdTokenDecimals = this.nativeDecimals; thresholdTokenSymbol = this.nativeSymbol; }
        else if (this.minProfitThresholdsConfig[canonicalSymbol]) { thresholdStr = this.minProfitThresholdsConfig[canonicalSymbol]; thresholdTokenDecimals = profitToken.decimals; thresholdTokenSymbol = canonicalSymbol; }
        else { thresholdStr = this.minProfitThresholdsConfig.DEFAULT; thresholdTokenDecimals = this.nativeDecimals; thresholdTokenSymbol = this.nativeSymbol; }
        if (!thresholdStr) throw new Error(`No threshold found for ${profitToken.symbol}.`);
        try { return ethers.parseUnits(thresholdStr, thresholdTokenDecimals); }
        catch (e) { logger.error(`Failed to parse threshold "${thresholdStr}" for ${thresholdTokenSymbol}`); throw new Error(`Bad threshold: ${thresholdStr}`); }
    }

    // --- calculate method - NOW USES SIMULATOR ---
    async calculate(opportunities) { // **** Now ASYNC ****
        if (!opportunities || !Array.isArray(opportunities)) { return []; }
        logger.info(`[ProfitCalculator] Evaluating ${opportunities.length} potential opportunities using simulator...`);
        const profitableTrades = [];
        const calculationPromises = []; // Run simulations concurrently

        for (const opportunity of opportunities) {
            calculationPromises.push(this.evaluateOpportunity(opportunity));
        }

        const results = await Promise.allSettled(calculationPromises);

        results.forEach((result, index) => {
             if (result.status === 'fulfilled' && result.value && result.value.isProfitable) {
                 profitableTrades.push(result.value.tradeData); // Add successful, profitable trades
             } else if (result.status === 'rejected') {
                  logger.warn(`[ProfitCalculator] Evaluation failed for opportunity #${index}: ${result.reason?.message || result.reason}`);
             }
              // Optionally log non-profitable trades:
             // else if (result.status === 'fulfilled' && result.value && !result.value.isProfitable) {
             //     logger.debug(`[ProfitCalculator] Opportunity #${index} evaluated as not profitable (Net: ${result.value.netProfitWei?.toString()}).`);
             // }
        });


        logger.info(`[ProfitCalculator] Found ${profitableTrades.length} profitable trades (after simulation, before gas/threshold).`);
        return profitableTrades;
    }

    /**
     * Evaluates a single opportunity using the swap simulator.
     * @param {object} opportunity The opportunity object from SpatialFinder.
     * @returns {Promise<{isProfitable: boolean, netProfitWei: bigint | null, tradeData: object | null}>}
     */
    async evaluateOpportunity(opportunity) {
        const logPrefix = `[ProfitCalc Opp ${opportunity.path?.[0]?.dex}/${opportunity.path?.[1]?.dex} ${opportunity.pairKey}]`;

        if (opportunity.type !== 'spatial' || !opportunity.path || opportunity.path.length !== 2) {
             logger.warn(`${logPrefix} Skipping non-spatial or malformed opportunity.`);
             return { isProfitable: false, netProfitWei: null, tradeData: null }; // Not profitable if malformed
        }

        const step1 = opportunity.path[0]; // Buy leg
        const step2 = opportunity.path[1]; // Sell leg

        // --- Find Pool States from Config/Cache (Needed for simulator) ---
        // This assumes pool state details are included IN the opportunity object by SpatialFinder
        // If not, we need to look them up based on address/dex. Let's assume they are included for now.
        const poolBuyState = opportunity.path[0].poolState; // NEED TO ADD THIS IN SPATIALFINDER
        const poolSellState = opportunity.path[1].poolState; // NEED TO ADD THIS IN SPATIALFINDER

        if (!poolBuyState || !poolSellState) {
             logger.error(`${logPrefix} Missing pool state data in opportunity object. Cannot simulate.`);
              return { isProfitable: false, netProfitWei: null, tradeData: null };
        }
        // --- ---

        // --- Determine Input Amount ---
        const initialTokenSymbol = opportunity.tokenIn; // e.g., USDC.e
        const intermediateTokenSymbol = opportunity.tokenIntermediate; // e.g., WETH
        const initialToken = this.config.TOKENS[initialTokenSymbol];
        const intermediateToken = this.config.TOKENS[intermediateTokenSymbol];

        if (!initialToken || !intermediateToken) {
             logger.warn(`${logPrefix} Could not find token definitions for ${initialTokenSymbol} or ${intermediateTokenSymbol}.`);
             return { isProfitable: false, netProfitWei: null, tradeData: null };
        }

        // Use a predefined input amount based on the initial token
        const amountInStart = SIMULATION_INPUT_AMOUNTS[initialToken.symbol] || SIMULATION_INPUT_AMOUNTS['WETH']; // Default to WETH if specific not found
        if (!amountInStart) {
             logger.warn(`${logPrefix} No simulation input amount defined for ${initialToken.symbol}. Skipping.`);
              return { isProfitable: false, netProfitWei: null, tradeData: null };
        }
        logger.debug(`${logPrefix} Simulating with initial ${ethers.formatUnits(amountInStart, initialToken.decimals)} ${initialToken.symbol}`);
        // --- ---

        // --- Simulate Leg 1 (Buy intermediate token) ---
        logger.debug(`${logPrefix} Simulating Leg 1: ${step1.dex} - Buy ${intermediateTokenSymbol}`);
        const sim1Result = await this.swapSimulator.simulateSwap(poolBuyState, initialToken, amountInStart);
        if (!sim1Result.success || sim1Result.amountOut === null || sim1Result.amountOut <= 0n) {
            logger.info(`${logPrefix} Leg 1 simulation failed or yielded zero output. Not profitable. Error: ${sim1Result.error || 'Zero output'}`);
            return { isProfitable: false, netProfitWei: null, tradeData: null };
        }
        const amountIntermediate = sim1Result.amountOut;
        logger.debug(`${logPrefix} Leg 1 Output: ${ethers.formatUnits(amountIntermediate, intermediateToken.decimals)} ${intermediateTokenSymbol}`);
        // --- ---

        // --- Simulate Leg 2 (Sell intermediate token) ---
        logger.debug(`${logPrefix} Simulating Leg 2: ${step2.dex} - Sell ${intermediateTokenSymbol}`);
        const sim2Result = await this.swapSimulator.simulateSwap(poolSellState, intermediateToken, amountIntermediate);
         if (!sim2Result.success || sim2Result.amountOut === null || sim2Result.amountOut <= 0n) {
            logger.info(`${logPrefix} Leg 2 simulation failed or yielded zero output. Not profitable. Error: ${sim2Result.error || 'Zero output'}`);
             return { isProfitable: false, netProfitWei: null, tradeData: null };
        }
        const finalAmountOut = sim2Result.amountOut;
        logger.debug(`${logPrefix} Leg 2 Output: ${ethers.formatUnits(finalAmountOut, initialToken.decimals)} ${initialTokenSymbol}`); // Should be back in initial token
        // --- ---

        // --- Calculate Gross Profit (in initial token) ---
        const grossProfitWei = finalAmountOut - amountInStart;

        if (grossProfitWei <= 0n) {
             logger.info(`${logPrefix} Simulation resulted in zero or negative gross profit (${ethers.formatUnits(grossProfitWei, initialToken.decimals)} ${initialTokenSymbol}). Not profitable.`);
             return { isProfitable: false, netProfitWei: null, tradeData: null };
        }

        logger.info(`${logPrefix} Simulation SUCCESS! Gross Profit: ${ethers.formatUnits(grossProfitWei, initialToken.decimals)} ${initialTokenSymbol}`);

        // --- TODO: Implement Gas Cost Estimation ---
        const gasCostWei = 0n; // Placeholder - NEEDS IMPLEMENTATION
        logger.debug(`${logPrefix} Gas cost estimation skipped (using ${gasCostWei}).`);
        // --- ---

        // --- TODO: Convert Profit & Gas to Native ---
        // For now, assume profit is calculated in native or comparison token and threshold matches
        const netProfitWei = grossProfitWei - gasCostWei; // Simplified net profit
        const profitTokenForThreshold = initialToken; // Assume we check threshold in the starting token
        // --- ---

        // --- TODO: Apply Buffer & Check Threshold ---
        let isProfitableAfterThreshold = false;
        try {
            const thresholdWei = this._getMinProfitThresholdWei(profitTokenForThreshold);
             // Apply buffer to net profit before comparing
             const bufferMultiplier = 10000n - this.profitBufferPercent * 100n; // e.g., 10% buffer -> 9000
             const bufferedNetProfitWei = (netProfitWei * bufferMultiplier) / 10000n;

            isProfitableAfterThreshold = bufferedNetProfitWei > thresholdWei;

            logger.info(`${logPrefix} Net Profit (Wei): ${netProfitWei}, Buffered Net: ${bufferedNetProfitWei}, Threshold: ${thresholdWei}. Profitable: ${isProfitableAfterThreshold}`);

        } catch (thresholdError) {
             logger.error(`${logPrefix} Error during threshold check: ${thresholdError.message}`);
             isProfitableAfterThreshold = false; // Treat as not profitable if threshold fails
        }
        // --- ---

        // --- Format Final Trade Object ---
        if (isProfitableAfterThreshold) {
            // Calculate percentage (optional)
            let profitPercentage = 0;
            if (amountInStart !== 0n) {
                profitPercentage = Number( (grossProfitWei * 1000000n) / amountInStart ) / 10000;
            }

            const finalTradeData = {
                ...opportunity, // Keep original opportunity details
                amountIn: amountInStart.toString(), // Actual simulated input
                amountOut: finalAmountOut.toString(), // Actual simulated output
                profitAmount: grossProfitWei.toString(), // Gross profit before gas
                profitPercentage: profitPercentage,
                // Add gas/net profit later
                // gasCostWei: gasCostWei.toString(),
                // netProfitWei: netProfitWei.toString(),
                timestamp: Date.now()
             };
             return { isProfitable: true, netProfitWei: netProfitWei, tradeData: finalTradeData };
        } else {
             return { isProfitable: false, netProfitWei: netProfitWei, tradeData: null };
        }
    }

}

module.exports = ProfitCalculator;
