// core/profitCalculator.js
// --- VERSION v2.7 --- Added debug log for estimated net profit before threshold check.

const { ethers } = require('ethers');
const { ArbitrageError } = require('../utils/errorHandler');
const logger = require('../utils/logger');
const { calculateFlashLoanFee } = require('../utils/priceUtils'); // Assuming priceUtils has this helper
// Import profit calculation helpers
const {
    calculateSushiswapV2Swap,
    calculateUniswapV3Swap,
    calculateDodoSwap,
    // Add other DEX swap calculation helpers as needed
} = require('./calculation/priceCalculation');


class ProfitCalculator {
    constructor(config, provider, swapSimulator, gasEstimator) {
        logger.info('[ProfitCalculator v2.7] Initialized. Helpers moved to profitCalcUtils. Handles Aave fee (9 BPS).'); // Updated version log
        if (!config) throw new ArbitrageError('InitializationError', 'ProfitCalculator: Missing config.');
        if (!provider) throw new ArbitrageError('InitializationError', 'ProfitCalculator: Missing provider.');
        if (!swapSimulator?.simulateSwap) throw new ArbitrageError('InitializationError', 'ProfitCalculator: Invalid SwapSimulator instance.');
        if (!gasEstimator?.estimateTxGasCost) throw new ArbitrageError('InitializationError', 'ProfitCalculator: Invalid GasEstimator instance.');

        this.config = config;
        this.provider = provider;
        this.swapSimulator = swapSimulator;
        this.gasEstimator = gasEstimator;

        // Get the native currency token from config
        this.nativeCurrencyToken = Object.values(this.config.TOKENS).find(
            token => token.address.toLowerCase() === ethers.ZeroAddress.toLowerCase() ||
                     token.symbol === (this.config.NATIVE_CURRENCY_SYMBOL || 'ETH') // Fallback to symbol
        );
        if (!this.nativeCurrencyToken) {
             logger.warn('[ProfitCalculator] Could not identify Native Currency Token object from config.');
            // Attempt to create a basic native token object if not found, using symbol/decimals from config
             this.nativeCurrencyToken = {
                  symbol: this.config.NATIVE_CURRENCY_SYMBOL || 'ETH',
                  decimals: 18, // Standard for ETH
                  address: ethers.ZeroAddress // Use zero address for native
             };
             logger.info(`[ProfitCalculator] Created fallback Native Currency Token object: ${this.nativeCurrencyToken.symbol}`);
        } else {
             logger.debug(`[ProfitCalculator] Identified Native Currency Token: ${this.nativeCurrencyToken.symbol} (${this.nativeCurrencyToken.address})`);
        }
    }

    /**
     * Calculates the estimated profit for a list of potential arbitrage opportunities.
     * Filters out opportunities that are not profitable after accounting for fees, gas, and thresholds.
     * @param {Array<object>} opportunities - Array of potential opportunity objects from the finders.
     * @param {string} signerAddress - The address of the signer/bot wallet.
     * @returns {Promise<Array<object>>} A promise resolving to an array of profitable opportunity objects.
     */
    async calculate(opportunities, signerAddress) {
        logger.debug(`[ProfitCalculator] Calculating profitability for ${opportunities.length} opportunities...`);
        const profitableTrades = [];

        for (const opportunity of opportunities) {
            try {
                // Ensure required properties exist before proceeding
                if (!opportunity.type || !opportunity.path || opportunity.path.length < 2 || !opportunity.amountIn || !opportunity.tokenIn || !opportunity.tokenOut) {
                    logger.warn(`[ProfitCalculator] Skipping malformed opportunity: ${JSON.stringify(opportunity)}`);
                    continue;
                }

                // --- Simulation ---
                // Simulate the trade path using the simulator
                const simulationResult = await this.swapSimulator.simulateSwap(
                    opportunity.path,
                    opportunity.amountIn,
                    signerAddress // Pass signer address for simulation context if needed
                );

                if (!simulationResult || !simulationResult.success || simulationResult.amountOut === undefined || simulationResult.amountOut === null) {
                    logger.debug(`[ProfitCalculator] Simulation failed or returned invalid data for opportunity ${opportunity.type} ${opportunity.pairKey}. Reason: ${simulationResult.error || 'Unknown'}`);
                    continue; // Skip if simulation fails
                }

                const amountOutAfterSimulation = BigInt(simulationResult.amountOut); // Amount received after the full swap path simulation

                // Opportunity is only potentially profitable if amountOut > amountIn
                // (This is a gross profit check before fees/gas)
                if (amountOutAfterSimulation <= opportunity.amountIn) {
                    logger.debug(`[ProfitCalculator] Opportunity ${opportunity.type} ${opportunity.pairKey} not grossly profitable (Simulated Out <= In). In: ${ethers.formatUnits(opportunity.amountIn, opportunity.tokenIn.decimals)}, Out: ${ethers.formatUnits(amountOutAfterSimulation, opportunity.tokenOut.decimals)}`);
                    continue; // Skip if not grossly profitable
                }

                // --- Flash Loan Fee Calculation ---
                // Assume the flash loan is for `opportunity.amountIn` of `opportunity.tokenIn`
                const flashLoanFeeDetails = calculateFlashLoanFee(
                     opportunity.amountIn,
                     opportunity.tokenIn,
                     this.config.AAVE_FLASH_LOAN_FEE_BPS, // Assuming Aave fee structure for all loans for now
                     this.config.TOKENS, // Pass full tokens map for native conversion
                     this.config.CHAINLINK_FEEDS // Pass chainlink feeds for native conversion
                );

                if (!flashLoanFeeDetails) {
                     logger.error(`[ProfitCalculator] Failed to calculate flash loan fee for opportunity ${opportunity.type} ${opportunity.pairKey}. Skipping.`);
                     continue; // Skip if fee calculation fails
                }

                const flashLoanFeeNativeWei = BigInt(flashLoanFeeDetails.feeNativeWei);


                // --- Gas Estimation ---
                // Estimate the gas cost for executing this transaction
                const gasEstimateDetails = await this.gasEstimator.estimateTxGasCost(
                    opportunity, // Pass the opportunity structure
                    signerAddress // Pass the signer address
                );

                if (!gasEstimateDetails || !gasEstimateDetails.gasCostNativeWei) {
                    logger.error(`[ProfitCalculator] Gas estimation failed for opportunity ${opportunity.type} ${opportunity.pairKey}. Skipping.`);
                    continue; // Skip if gas estimation fails
                }

                const gasCostNativeWei = BigInt(gasEstimateDetails.gasCostNativeWei);


                // --- Profit Calculation ---
                // Gross profit is the amount out after simulation MINUS the amount in (borrowed)
                const grossProfitTokenWei = amountOutAfterSimulation - opportunity.amountIn;

                // Convert gross profit to native currency (ETH) for consistent comparison
                // Requires knowing the price of opportunity.tokenOut in terms of native currency
                // Use priceUtils.convertTokenAmountToNative or similar
                // For simplicity *for now*, let's assume the borrowed token (opportunity.tokenIn)
                // is one we can directly convert to native for profit calculation.
                // In a real scenario, you'd convert the final profit token (opportunity.tokenOut) to native.
                // Since spatial arbitrage returns the same token borrowed (tokenIn = tokenOut),
                // we convert grossProfitTokenWei (which is in terms of opportunity.tokenIn/tokenOut) to native.

                const grossProfitNativeWei = await this.gasEstimator.convertTokenAmountToNative( // Reusing gasEstimator's conversion logic
                     grossProfitTokenWei,
                     opportunity.tokenIn, // The token the profit is denominated in
                     this.config.CHAINLINK_FEEDS, // Pass necessary price feeds
                     this.config.TOKENS // Pass tokens map
                );

                if (grossProfitNativeWei === null) {
                     logger.error(`[ProfitCalculator] Failed to convert gross profit to native for opportunity ${opportunity.type} ${opportunity.pairKey}. Skipping.`);
                     continue; // Skip if conversion fails
                }


                // Calculate estimated net profit
                const netProfitNativeWei = grossProfitNativeWei - gasCostNativeWei - flashLoanFeeNativeWei;

                // --- ADDED DEBUG LOG (v2.7) ---
                // Log the estimated profit before applying the threshold
                logger.debug(`[ProfitCalculator] Opportunity ${opportunity.type} ${opportunity.pairKey} | Estimated Net Profit (Native): ${ethers.formatEther(netProfitNativeWei)} ${this.config.NATIVE_CURRENCY_SYMBOL || 'ETH'} | Threshold (Native): ${ethers.formatEther(trade.thresholdNativeWei)} ${this.config.NATIVE_CURRENCY_SYMBOL || 'ETH'}`);
                // --- END ADDED DEBUG LOG ---


                // --- Apply minimum profit threshold ---
                // Get the minimum required profit threshold for the native currency
                // Check specific native token threshold first, then fallback to DEFAULT
                const minProfitThresholdNative = BigInt(
                     this.config.MIN_PROFIT_THRESHOLDS?.[this.nativeCurrencyToken.symbol] ||
                     this.config.MIN_PROFIT_THRESHOLDS?.['DEFAULT'] ||
                     0n // Default to 0 if no thresholds are configured
                );

                // Create a mutable copy of the opportunity to add calculation results
                const trade = { ...opportunity };

                // Add calculation results to the trade object
                trade.amountOut = amountOutAfterSimulation; // Simulated amount out
                trade.intermediateAmountOut = simulationResult.intermediateAmountOut; // Output of the first swap
                trade.gasEstimate = gasEstimateDetails.gasEstimate; // Raw gas estimate
                trade.gasCostNativeWei = gasCostNativeWei; // Gas cost in native currency
                trade.flashLoanFeeNativeWei = flashLoanFeeNativeWei; // Flash loan fee in native currency
                trade.grossProfitTokenWei = grossProfitTokenWei; // Gross profit in borrowed token terms
                trade.grossProfitNativeWei = grossProfitNativeWei; // Gross profit in native currency terms
                trade.netProfitNativeWei = netProfitNativeWei; // Net profit in native currency terms
                trade.thresholdNativeWei = minProfitThresholdNative; // The threshold applied (in native)
                trade.flashLoanDetails = flashLoanFeeDetails; // Store fee details

                // Calculate profit percentage relative to the borrowed amount
                // Avoid division by zero if amountIn is 0
                if (opportunity.amountIn > 0n) {
                     // Calculate percentage profit based on amountIn (borrowed token)
                     // (Amount Out - Amount In) * 100 / Amount In
                     const profitBasisPoints = (grossProfitTokenWei * 10000n) / opportunity.amountIn;
                     trade.profitPercentage = Number(profitBasisPoints) / 100; // Convert basis points to percentage
                } else {
                     trade.profitPercentage = 0;
                }


                // --- Apply minimum profit threshold (using the calculated net profit in native) ---
                if (netProfitNativeWei > 0n && netProfitNativeWei >= minProfitThresholdNative) {
                    // --- Tithe Calculation (Off-chain wiring) ---
                    // Calculate the tithe amount based on the net profit in native currency
                    // The percentage (currently hardcoded 30%) is applied here off-chain.
                    // The smart contract will also verify/re-calculate the split on-chain.
                    const tithePercentage = BigInt(this.config.TITHE_PERCENTAGE || 30); // Get from config if added later, default 30
                    const titheAmountNativeWei = (netProfitNativeWei * tithePercentage) / 100n; // Calculate 30% of net profit
                    trade.titheAmountNativeWei = titheAmountNativeWei; // Add tithe amount to trade object

                    // --- Final Net Profit After Tithe (Optional for display/scoring) ---
                    // The *executable* net profit for the bot wallet is netProfitNativeWei - titheAmountNativeWei
                    // We can add this for clarity, but the primary check is against total netProfitNativeWei
                    trade.netProfitAfterTitheNativeWei = netProfitNativeWei - titheAmountNativeWei;


                    profitableTrades.push(trade); // Add the profitable trade to the list
                    logger.debug(`[ProfitCalculator] Added profitable trade: ${trade.type} ${trade.pairKey}`);
                } else {
                    // Use debug level for opportunities that didn't meet the threshold
                    logger.debug(`[ProfitCalculator] Opportunity ${opportunity.type} ${opportunity.pairKey} did not meet min profit threshold (${ethers.formatEther(netProfitNativeWei)} < ${ethers.formatEther(minProfitThresholdNative)} Native).`);
                }

            } catch (error) {
                // Log errors specific to processing a single opportunity, but don't stop the whole process
                logger.error(`[ProfitCalculator] Error processing opportunity ${opportunity.type} ${opportunity.pairKey}: ${error.message}`, error);
                logger.debug(`[ProfitCalculator] Opportunity object that caused error:`, JSON.stringify(opportunity, (k,v) => typeof v === 'bigint' ? v.toString() : v, 2));
            }
        }

        logger.debug(`[ProfitCalculator] Finished calculation. Found ${profitableTrades.length} profitable trades.`);
        return profitableTrades;
    }

     // Helper method to convert any token amount to the native currency (ETH) equivalent
     // This is crucial for comparing profits from different token pairs consistently.
     // Relies on Chainlink price feeds configured in the bot's config.
     async convertTokenAmountToNative(amountWei, token, chainlinkFeeds, tokens) {
         // Delegate the actual conversion logic to GasEstimator (or a shared price conversion utility)
         // This avoids duplicating the price feed lookup and calculation logic.
         if (typeof this.gasEstimator?.convertTokenAmountToNative === 'function') {
              return this.gasEstimator.convertTokenAmountToNative(amountWei, token, chainlinkFeeds, tokens);
         } else {
              logger.error('[ProfitCalculator Conversion] GasEstimator.convertTokenAmountToNative is missing or not a function!');
              return null; // Cannot perform conversion
         }
     }
}

module.exports = ProfitCalculator;
