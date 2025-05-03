// core/profitCalculator.js
// --- VERSION v2.8 --- Corrected tokenIn/tokenOut logic in simulation loop.

const { ethers } = require('ethers');
const logger = require('../utils/logger');
const { calculateEffectivePrices, PRICE_SCALE } = require('./calculation/priceCalculation'); // Import price calc functions and PRICE_SCALE
const { ArbitrageError } = require('../utils/errorHandler');
const { TOKENS } = require('../constants/tokens'); // Import TOKENS to look up token objects

class ProfitCalculator {
    constructor(config, provider, swapSimulator, gasEstimator) {
        logger.info('[ProfitCalculator v2.8] Initializing. Helpers moved to profitCalcUtils. Handles Aave fee (9 BPS).');
        if (!config) throw new ArbitrageError('ProfitCalculatorInit', 'Missing config.');
        if (!provider) throw new ArbitrageError('ProfitCalculatorInit', 'Missing provider.');
        if (!swapSimulator?.simulateSwap) throw new ArbitrageError('ProfitCalculatorInit', 'Invalid SwapSimulator instance.');
        if (!gasEstimator?.estimateTxGasCost) throw new ArbitrageError('ProfitCalculatorInit', 'Invalid GasEstimator instance.');

        this.config = config;
        this.provider = provider;
        this.swapSimulator = swapSimulator;
        this.gasEstimator = gasEstimator;

        // Read config values, converting BigInt strings if necessary
        // Assuming these are already BigInts from config loader if defined in network files
        this.minProfitThresholds = config.MIN_PROFIT_THRESHOLDS; // Should be an object { SYMBOL: BigInt, ... }
        this.profitBufferPercent = BigInt(config.PROFIT_BUFFER_PERCENT); // Percentage as BigInt
        this.aaveFlashLoanFeeBps = BigInt(config.AAVE_FLASH_LOAN_FEE_BPS); // Basis points as BigInt

        // Find Native Currency Token object from config.TOKENS
        this.nativeCurrencyToken = Object.values(this.config.TOKENS).find(
             token => token.symbol?.toUpperCase() === this.config.NATIVE_CURRENCY_SYMBOL?.toUpperCase()
         );

         if (!this.nativeCurrencyToken) {
             logger.warn(`[ProfitCalculator] Could not identify Native Currency Token object from config.`);
             // Create a fallback token object if not found (assuming 18 decimals)
             this.nativeCurrencyToken = {
                 symbol: this.config.NATIVE_CURRENCY_SYMBOL || 'ETH',
                 decimals: 18,
                 address: ethers.ZeroAddress // Use ZeroAddress as a placeholder for native
             };
             logger.info(`[ProfitCalculator] Created fallback Native Currency Token object: ${this.nativeCurrencyToken.symbol}`);
         }

        logger.debug('[ProfitCalculator] Initialized with config:', {
            minProfitThresholds: this.minProfitThresholds, // Log the object structure
            profitBufferPercent: this.profitBufferPercent.toString(),
            aaveFlashLoanFeeBps: this.aaveFlashLoanFeeBps.toString(),
            nativeCurrencySymbol: this.nativeCurrencyToken.symbol,
            nativeCurrencyDecimals: this.nativeCurrencyToken.decimals
        });
    }


    /**
     * Calculates the profitability of a given arbitrage opportunity.
     * This involves simulating the swaps, estimating gas costs, and applying fees/thresholds.
     * @param {Array<object>} opportunities - Array of potential opportunity objects from finders.
     * @param {string} signerAddress - The address that will execute the transaction (used for gas estimation).
     * @returns {Promise<Array<object>>} Array of profitable opportunity objects, augmented with profit/cost details.
     */
    async calculate(opportunities, signerAddress) {
        logger.debug(`[ProfitCalculator] Calculating profitability for ${opportunities.length} opportunities...`);
        const profitableTrades = [];

        for (const opportunity of opportunities) {
            const logPrefix = `[ProfitCalc ${opportunity.type} ${opportunity.pairKey}]`;
            logger.debug(`${logPrefix} Processing opportunity:`, opportunity);

            // --- 1. Simulate the swap path ---
            let currentAmountIn = opportunity.amountIn; // Starting amount (borrowed)
            let simulationSuccess = true;
            let currentAmountOut = 0n; // Amount after the final swap
            let intermediateAmountOut = 0n; // Amount after the first swap

            logger.debug(`${logPrefix} Starting simulation with initial amountIn: ${currentAmountIn.toString()} (raw)`);

            // Iterate through each step in the swap path
            for (let i = 0; i < opportunity.path.length; i++) {
                const step = opportunity.path[i];

                // --- CORRECTED LOGIC: Get Token objects for the CURRENT step's input/output ---
                // Use the token symbols from the step to look up the actual Token objects from config.TOKENS
                const stepTokenIn = this.config.TOKENS[step.tokenInSymbol];
                const stepTokenOut = this.config.TOKENS[step.tokenOutSymbol];

                if (!stepTokenIn || !stepTokenOut) {
                    const errorMsg = `Missing Token object for step ${i} (${step.tokenInSymbol}->${step.tokenOutSymbol}).`;
                    logger.error(`${logPrefix} ${errorMsg}`);
                    simulationSuccess = false;
                    opportunity.simulationError = errorMsg; // Add error detail to opportunity
                    break; // Exit the loop if we can't find the token objects
                }
                // --- END CORRECTED LOGIC ---


                // Call the SwapSimulator for this step
                const simResult = await this.swapSimulator.simulateSwap(
                    step.poolState, // poolState for the current step (contains dexType, address, etc.)
                    stepTokenIn, // Pass the correct Token object for this step's input
                    currentAmountIn // amountIn for the current step (output from previous step, or initial amountIn)
                );

                if (!simResult.success) {
                    simulationSuccess = false;
                    logger.debug(`${logPrefix} Simulation failed or returned invalid data for step ${i}. Reason: ${simResult.error}`);
                    opportunity.simulationError = simResult.error; // Store simulation error reason
                    break; // Exit the loop if any simulation step fails
                }

                // Update currentAmountIn for the next step or store final amountOut
                currentAmountIn = simResult.amountOut; // Output of current step is input for next

                if (i === 0) {
                    intermediateAmountOut = simResult.amountOut; // Store amount after the first swap
                }
                if (i === opportunity.path.length - 1) {
                    currentAmountOut = simResult.amountOut; // Store final output after the last swap
                }
            } // End path iteration

            // If simulation failed for any step, skip this opportunity
            if (!simulationSuccess || currentAmountOut <= 0n) {
                logger.debug(`${logPrefix} Simulation failed or yielded non-positive output (${currentAmountOut}). Skipping.`);
                continue; // Skip to the next opportunity
            }

            // Augment opportunity object with simulation results
            opportunity.amountOut = currentAmountOut;
            opportunity.intermediateAmountOut = intermediateAmountOut;
            logger.debug(`${logPrefix} Simulation successful. Final amountOut: ${currentAmountOut.toString()} (raw)`);


            // --- 2. Estimate Gas Cost ---
            let gasCostNativeWei = 0n;
            let gasEstimationSuccess = true;
            try {
                // Estimate gas for the entire transaction using the path and other data
                gasCostNativeWei = await this.gasEstimator.estimateTxGasCost(
                    opportunity.type, // e.g., 'spatial'
                    opportunity.path, // The simulated path details
                    opportunity.amountIn, // Initial borrowed amount
                    signerAddress // Address sending the transaction
                    // Add other necessary parameters for gas estimation if needed (e.g., slippage)
                );
                opportunity.gasEstimate = gasCostNativeWei; // Augment opportunity object
                logger.debug(`${logPrefix} Gas estimation successful: ${gasCostNativeWei.toString()} wei`);

                if (gasCostNativeWei <= 0n) {
                    logger.warn(`${logPrefix} Gas estimation resulted in zero or negative cost. Skipping.`);
                    gasEstimationSuccess = false; // Treat as failure if gas is non-positive
                }

            } catch (gasError) {
                gasEstimationSuccess = false;
                logger.error(`${logPrefix} Gas estimation failed: ${gasError.message}`, gasError);
                opportunity.gasEstimationError = gasError.message; // Store gas estimation error
                continue; // Skip to the next opportunity if gas estimation fails
            }

            // If gas estimation failed, skip this opportunity
            if (!gasEstimationSuccess) {
                 logger.debug(`${logPrefix} Gas estimation failed. Skipping opportunity.`);
                 continue; // Skip to the next opportunity
            }


            // --- 3. Calculate Net Profit ---
            // Net Profit = Amount Out (Native) - Amount Borrowed (Native) - Flash Loan Fee (Native) - Gas Cost (Native) - Tithe (Native)
            // Need to convert all amounts to a common base currency (Native ETH) for profit calculation.
            // This requires price feeds or reliable conversions for non-native tokens.

            // Convert Amount In (Borrowed Token) to Native Wei
            // opportunity.tokenIn is the borrowed token object
            // currentAmountIn (after simulation) is the amount of tokenIn received back. This is the amount to compare against borrowed.
            // Let's rename currentAmountIn after simulation to finalAmountOutBorrowedToken
            const finalAmountOutBorrowedToken = opportunity.amountOut; // Final output is in the borrowed token

            let borrowedAmountNativeWei = 0n;
            let finalAmountOutNativeWei = 0n;
            let flashLoanFeeNativeWei = 0n;
            let minProfitThresholdNativeWei = 0n;
            let titheAmountNativeWei = 0n; // Will calculate Tithe amount

            try {
                // Convert initial borrowed amount (opportunity.amountIn) to Native Wei
                // This requires the price of the borrowed token relative to native.
                // Assuming price feeds are available or there's a direct path to native.
                // For simplicity in local testing, let's assume the borrowed token *is* native, or we use a direct price feed.
                // If borrowed token is WETH, and native is ETH, they are equivalent.
                // If borrowed token is USDC, need USDC/ETH price.

                // --- Need a way to get price of ANY token relative to NATIVE ---
                // This is a missing component! For now, let's assume borrowed token is WETH (Native equivalent)
                // or we use a simplified conversion if it's a stablecoin like USDC.

                // Let's ADD a price feed lookup here (or mock it for now)
                // Mocking: Assume 1 WETH = 1 ETH, 1 USDC = 1800 ETH (approx)
                let borrowedTokenPriceInNativeScaled = PRICE_SCALE; // Default: 1:1 if borrowed token is Native (WETH/ETH)

                // Look up the price of the borrowed token relative to the native currency
                // This is a significant missing piece of logic that needs to be implemented robustly.
                // For testing WETH/USDC spatial: borrowed token is USDC. Need USDC/ETH price.
                // Price USDC/WETH scaled = priceA_1_per_0_scaled from SpatialFinder? No, need USDC/ETH price.
                // Let's assume we have a helper function `getPriceInNative(tokenObject)` that returns price scaled by PRICE_SCALE.
                // This function would use Chainlink feeds or other methods.

                // --- MOCK PRICE CONVERSION FOR TESTING (Replace with real logic later) ---
                if (opportunity.tokenIn.symbol === this.nativeCurrencyToken.symbol || opportunity.tokenIn.address.toLowerCase() === this.nativeCurrencyToken.address.toLowerCase()) {
                     borrowedAmountNativeWei = opportunity.amountIn; // If borrowed is native, already in native wei
                     finalAmountOutNativeWei = finalAmountOutBorrowedToken; // Final output is also in native wei
                     logger.debug(`${logPrefix} Borrowed token is Native. Amounts are already in Native Wei.`);

                     // Flash loan fee calculation: Assuming Aave fee is on the borrowed amount itself.
                     // Fee = Borrowed Amount * Aave Fee BPS / 10000
                     flashLoanFeeNativeWei = (opportunity.amountIn * this.aaveFlashLoanFeeBps) / TEN_THOUSAND;
                     logger.debug(`${logPrefix} Flash loan fee (Native): ${flashLoanFeeNativeWei.toString()} wei`);

                } else {
                     // If borrowed token is NOT native (e.g., USDC)
                     // Need price of Borrowed Token / Native (e.g., USDC/ETH) scaled by PRICE_SCALE
                     // Let's assume this price is available. For testing USDC/WETH, borrowed is USDC.
                     // We need USDC/WETH price first, then WETH/ETH price (if WETH != ETH)

                     // --- MOCK: Assume USDC/WETH price is ~0.00054 ETH (1/1850) ---
                     // Need to convert USDC amount (finalAmountOutBorrowedToken) to WETH amount
                     // Amount WETH = (Amount USDC * Price WETH/USDC)
                     // Price WETH/USDC Standard = (Price T0/T1 scaled) / PRICE_SCALE
                     // This requires knowing which token is T0 and T1 in the pool used for the final swap.
                     // This is getting complicated. A simpler approach for testing is to just convert final AmountOutBorrowedToken to Native Wei using a fixed price or a simple conversion helper.

                     // Let's use the final pool in the path (poolSwapT0toT1 from SpatialFinder)
                     // The final swap is Intermediate -> Borrowed.
                     // The output is finalAmountOutBorrowedToken.
                     // We need the price of Borrowed Token / Native. Let's find the price of USDC / WETH from the final pool.
                     // The final pool is poolSwapT0toT1, which means it has a HIGH T0/T1 price (e.g. HIGH WETH/USDC price).
                     // The swap is T0 -> T1, so WETH -> USDC on this pool.
                     // The final output is finalAmountOutBorrowedToken (USDC).
                     // We need to convert this USDC amount to Native (WETH) Wei.
                     // Amount Native Wei = Amount USDC Wei * Price WETH/USDC (in Native terms)
                     // This requires Price WETH/USDC Standard * 10^NativeDecimals? No...

                     // Let's simplify the Mocking dramatically for testing the Tithe calculation flow.
                     // Assume we are borrowing TOKEN_A and repaying TOKEN_A.
                     // Net Profit (in TOKEN_A wei) = Amount Out - Amount In - Flash Loan Fee (in TOKEN_A wei)
                     // Tithe = 30% of Net Profit (in TOKEN_A wei)
                     // Convert Tithe to Native Wei using a price feed (MOCK).

                     // --- SIMPLIFIED MOCK FOR TESTING TITHE CALCULATION ---
                     // Assume Net Profit is calculated in the borrowed token's smallest units.
                     const netProfitBorrowedTokenWei = finalAmountOutBorrowedToken - opportunity.amountIn;
                     logger.debug(`${logPrefix} Net profit in borrowed token wei: ${netProfitBorrowedTokenWei.toString()}`);

                     // Calculate Flash Loan Fee in Borrowed Token Wei
                     // Aave fee is on the borrowed amount
                     const flashLoanFeeBorrowedTokenWei = (opportunity.amountIn * this.aaveFlashLoanFeeBps) / TEN_THOUSAND;
                     logger.debug(`${logPrefix} Flash loan fee in borrowed token wei: ${flashLoanFeeBorrowedTokenWei.toString()}`);

                     const netProfitAfterFeeBorrowedTokenWei = netProfitBorrowedTokenWei - flashLoanFeeBorrowedTokenWei;
                     logger.debug(`${logPrefix} Net profit after fee in borrowed token wei: ${netProfitAfterFeeBorrowedTokenWei.toString()}`);


                     // Convert Net Profit (in Borrowed Token Wei) to Native Wei for comparison against threshold and Tithe
                     // Needs price of Borrowed Token / Native (e.g. USDC/ETH) scaled by PRICE_SCALE (1e18)
                     // Let's assume we have a function `getPriceOfTokenInNative(tokenObject)` returning scaled price.
                     // MOCKING: Assume USDC/WETH price is ~0.00054 WETH (scaled by 1e18)
                     // If borrowed is USDC (6 decimals), Native is WETH (18 decimals)
                     // Price USDC/WETH Standard = (Amount WETH / 10^18) / (Amount USDC / 10^6) = (Amount WETH / Amount USDC) * 10^-12
                     // Scaled Price USDC/WETH (1e18) = Price Standard * 1e18 = (Amount WETH / Amount USDC) * 10^-12 * 10^18 = (Amount WETH / Amount USDC) * 10^6
                     // So, Scaled Price USDC/WETH (1e18) = Price (USDC in smallest / WETH in smallest) * (10^18 / 10^6) * 10^18 / 10^18 = Price (USDC wei / WETH wei) * 10^12
                     // This is confusing. Let's use a simpler mock.

                     // --- SIMPLE MOCK: Assume price is 1:1 for all tokens to Native for testing ---
                     // THIS IS NOT REALISTIC, JUST FOR TESTING TITHE CALCULATION FLOW
                     const borrowedTokenNativePrice_Mock = PRICE_SCALE; // 1 Borrowed Token (standard) = 1 Native Token (standard), scaled by 1e18
                     const borrowedTokenNativeScaleFactor = 10n ** BigInt(opportunity.tokenIn.decimals); // Scale borrowed token from smallest to standard

                     if (borrowedTokenNativeScaleFactor === 0n) throw new Error("Borrowed token scale factor is zero");

                     // Convert net profit in borrowed token wei to Native Wei
                     // Net Profit (Native Wei) = Net Profit (Borrowed Wei) * Price (Native/Borrowed Standard) * 10^NativeDecimals
                     // Price (Native/Borrowed Standard) = 1 / Price (Borrowed/Native Standard)
                     // Price (Borrowed/Native Standard) = Scaled Price (Borrowed/Native, 1e18) / PRICE_SCALE
                     // Amount (Borrowed Standard) = Amount (Borrowed Wei) / borrowedTokenNativeScaleFactor
                     // Amount (Native Standard) = Amount (Borrowed Standard) * Price (Native/Borrowed Standard)
                     // Amount (Native Wei) = Amount (Native Standard) * 10^NativeDecimals

                     // Let's try: Convert Net Profit (Borrowed Wei) to Native Wei using the MOCK price of Borrowed/Native (Scaled 1e18)
                     // Net Profit (Native Wei) = (Net Profit Borrowed Wei / 10^BorrowedDecimals) * Price (Native/Borrowed Standard) * 10^NativeDecimals
                     // Price (Native/Borrowed Standard) = (PRICE_SCALE * PRICE_SCALE) / borrowedTokenNativePrice_Mock (Scaled 1e18)
                     // Net Profit (Native Wei) = (Net Profit Borrowed Wei * (PRICE_SCALE * PRICE_SCALE)) / (10^BorrowedDecimals * borrowedTokenNativePrice_Mock) * 10^NativeDecimals ??? No...

                     // Let's calculate Net Profit in Native Wei using the final amount received in the borrowed token
                     // finalAmountOutBorrowedToken is in borrowed token wei.
                     // We need to convert this to Native Wei.
                     // Amount Native Wei = finalAmountOutBorrowedToken (Borrowed Wei) * Price (Native/Borrowed, Wei/Wei)
                     // Price (Native/Borrowed, Wei/Wei) = Price (Native/Borrowed Standard) * (10^NativeDecimals / 10^BorrowedDecimals)
                     // Price (Native/Borrowed Standard) = (PRICE_SCALE * PRICE_SCALE) / borrowedTokenNativePrice_Mock (Scaled 1e18)
                     // So, Amount Native Wei = finalAmountOutBorrowedToken * ((PRICE_SCALE * PRICE_SCALE) / borrowedTokenNativePrice_Mock) * (10^NativeDecimals / 10^BorrowedDecimals) / PRICE_SCALE ??? No...

                     // Let's assume we borrow X amount of TOKEN_A. We get back Y amount of TOKEN_A.
                     // Gross Profit = Y - X (in TOKEN_A wei)
                     // Flash Loan Fee = X * Aave Fee BPS / 10000 (in TOKEN_A wei)
                     // Net Profit (pre-gas) = Gross Profit - Flash Loan Fee (in TOKEN_A wei)
                     // Convert Net Profit (pre-gas, in TOKEN_A wei) to Native Wei using a reliable price feed.
                     // Then subtract gas cost.
                     // Then apply Tithe percentage.

                     // Let's calculate Gross Profit in borrowed token wei
                     const grossProfitBorrowedTokenWei = finalAmountOutBorrowedToken - opportunity.amountIn;

                     // Calculate Flash Loan Fee in borrowed token wei
                     const flashLoanFeeBorrowedTokenWei_Corrected = (opportunity.amountIn * this.aaveFlashLoanFeeBps) / TEN_THOUSAND;
                     opportunity.flashLoanDetails = { // Add details to opportunity for logging
                         token: opportunity.tokenIn, // Borrowed token
                         amount: opportunity.amountIn, // Borrowed amount
                         feeBps: this.aaveFlashLoanFeeBps,
                         feeBorrowedTokenWei: flashLoanFeeBorrowedTokenWei_Corrected, // Fee in borrowed token wei
                         feeNativeWei: 0n // Placeholder, calculated later
                     };
                     logger.debug(`${logPrefix} Gross Profit (Borrowed): ${grossProfitBorrowedTokenWei.toString()} wei. FL Fee (Borrowed): ${flashLoanFeeBorrowedTokenWei_Corrected.toString()} wei.`);


                     const netProfitPreGasBorrowedTokenWei = grossProfitBorrowedTokenWei - flashLoanFeeBorrowedTokenWei_Corrected;
                     logger.debug(`${logPrefix} Net Profit (Pre-Gas, Borrowed): ${netProfitPreGasBorrowedTokenWei.toString()} wei.`);

                     if (netProfitPreGasBorrowedTokenWei <= 0n) {
                         logger.debug(`${logPrefix} Net Profit (Pre-Gas) is non-positive (${netProfitPreGasBorrowedTokenWei}). Skipping.`);
                         continue; // Skip if not profitable before gas
                     }

                     // Now convert Net Profit (Pre-Gas, Borrowed Token Wei) to Native Wei
                     // Needs price of Borrowed Token / Native, scaled by PRICE_SCALE (1e18). Let's call this price `borrowedTokenNativePriceScaled`.
                     // Amount Native Wei = (Net Profit Pre-Gas Borrowed Token Wei / 10^BorrowedDecimals) * Price (Borrowed/Native Standard) * 10^NativeDecimals
                     // Price (Borrowed/Native Standard) = borrowedTokenNativePriceScaled / PRICE_SCALE
                     // Amount Native Wei = (Net Profit Pre-Gas Borrowed Token Wei / 10^BorrowedDecimals) * (borrowedTokenNativePriceScaled / PRICE_SCALE) * 10^NativeDecimals
                     // Integer arithmetic: (Net Profit Pre-Gas Borrowed Token Wei * borrowedTokenNativePriceScaled * (10n ** this.nativeCurrencyToken.decimals)) / ((10n ** BigInt(opportunity.tokenIn.decimals)) * PRICE_SCALE)

                     // --- MOCK PRICE Lookup (Replace with real lookup) ---
                     let borrowedTokenNativePriceScaled = 0n; // Price of 1 Standard Borrowed Token in Standard Native Tokens, scaled by PRICE_SCALE
                     // Find price of opportunity.tokenIn (Borrowed) in this.nativeCurrencyToken
                     // This is complex and requires a price feed or graph traversal.
                     // For testing, let's MOCK this based on common pairs:
                     if (opportunity.tokenIn.symbol === 'USDC' || opportunity.tokenIn.symbol === 'USDC.e' || opportunity.tokenIn.symbol === 'USDT') {
                         // Assume stablecoin price relative to WETH/ETH is ~1/1850 (using WETH as proxy for Native)
                         // Price Stablecoin / WETH Standard = 1 / Price WETH / Stablecoin Standard
                         // Price WETH / Stablecoin Standard ~ 1850
                         // Scaled Price WETH / Stablecoin (1e18) ~ 1850 * 1e18
                         // Scaled Price Stablecoin / WETH (1e18) = (1e18 * 1e18) / (1850 * 1e18) = 1e18 / 1850
                         // Let's use 1e18 / 1850 as a mock price for USDC/WETH scaled by 1e18
                         borrowedTokenNativePriceScaled = PRICE_SCALE / 1850n; // Mock Price: 1 Standard Stablecoin = 1/1850 Standard WETH, scaled by 1e18
                         if (borrowedTokenNativePriceScaled === 0n) borrowedTokenNativePriceScaled = 1n; // Ensure not zero if 1850 is too large

                     } else if (opportunity.tokenIn.symbol === 'WBTC') {
                          // Assume WBTC/WETH price is ~50 (WBTC is worth about 50 WETH)
                          // Price WBTC/WETH Standard ~ 50
                          // Scaled Price WBTC/WETH (1e18) ~ 50 * 1e18
                         borrowedTokenNativePriceScaled = 50n * PRICE_SCALE; // Mock Price: 1 Standard WBTC = 50 Standard WETH, scaled by 1e18
                     } else {
                         // For other tokens (ARB, LINK, GMX, MAGIC, DAI), let's just assume 1:1 with Native for testing
                         borrowedTokenNativePriceScaled = PRICE_SCALE; // Mock Price: 1 Standard Token = 1 Standard Native, scaled by 1e18
                     }

                     logger.debug(`${logPrefix} Mock Price of ${opportunity.tokenIn.symbol}/${this.nativeCurrencyToken.symbol} (Scaled 1e18): ${borrowedTokenNativePriceScaled.toString()}`);

                     // Convert Net Profit (Pre-Gas, Borrowed Token Wei) to Native Wei using the mock price
                     // Amount Native Wei = (Net Profit Pre-Gas Borrowed Token Wei * borrowedTokenNativePriceScaled) / (10^BorrowedDecimals) / PRICE_SCALE * 10^NativeDecimals ???
                     // Let's use simpler conversion:
                     // Amount (Borrowed Standard) = Net Profit Pre-Gas Borrowed Token Wei / (10^BorrowedDecimals)
                     // Amount (Native Standard) = Amount (Borrowed Standard) * Price (Native/Borrowed Standard)
                     // Amount (Native Wei) = Amount (Native Standard) * (10^NativeDecimals)
                     // Amount (Native Wei) = (Net Profit Pre-Gas Borrowed Token Wei / (10^BorrowedDecimals)) * (borrowedTokenNativePriceScaled / PRICE_SCALE) * (10^NativeDecimals)
                     // Integer: (Net Profit Pre-Gas Borrowed Token Wei * borrowedTokenNativePriceScaled * (10n ** BigInt(this.nativeCurrencyToken.decimals))) / ((10n ** BigInt(opportunity.tokenIn.decimals)) * PRICE_SCALE)

                     // Let's use the inverse price Native/Borrowed (Scaled 1e18)
                     // Price Native/Borrowed Standard = (PRICE_SCALE * PRICE_SCALE) / borrowedTokenNativePriceScaled
                     // Amount Native Wei = (Net Profit Pre-Gas Borrowed Token Wei * (PRICE_SCALE * PRICE_SCALE / borrowedTokenNativePriceScaled)) / (10^BorrowedDecimals / 10^NativeDecimals) ??? No...

                     // Let's use the price of Borrowed/Native (Scaled 1e18) directly
                     // Net Profit (Native Wei) = (Net Profit Pre-Gas Borrowed Token Wei * Price (Native/Borrowed Standard)) * (10^NativeDecimals / 10^BorrowedDecimals)
                     // Price (Native/Borrowed Standard) = (PRICE_SCALE * PRICE_SCALE) / borrowedTokenNativePriceScaled (Scaled 1e18)
                     // Amount Native Wei = (Net Profit Pre-Gas Borrowed Token Wei / (10n ** BigInt(opportunity.tokenIn.decimals))) * ((PRICE_SCALE * PRICE_SCALE) / borrowedTokenNativePriceScaled) * (10n ** BigInt(this.nativeCurrencyToken.decimals)) ???

                     // Let's use the reciprocal price: Price Native/Borrowed Standard = 1 / Price Borrowed/Native Standard
                     // Price Borrowed/Native Standard = borrowedTokenNativePriceScaled / PRICE_SCALE
                     // Price Native/Borrowed Standard = PRICE_SCALE / borrowedTokenNativePriceScaled
                     // Amount Native Wei = (Net Profit Pre-Gas Borrowed Token Wei * Price (Native/Borrowed Standard)) * (10^NativeDecimals / 10^BorrowedDecimals)
                     // Amount Native Wei = (Net Profit Pre-Gas Borrowed Token Wei * (PRICE_SCALE / borrowedTokenNativePriceScaled)) * ((10n ** BigInt(this.nativeCurrencyToken.decimals)) / (10n ** BigInt(opportunity.tokenIn.decimals))) * PRICE_SCALE ???

                     // Simple conversion: Convert Net Profit (Borrowed Wei) to Borrowed Standard, then to Native Standard, then to Native Wei
                     const netProfitPreGasBorrowedStandard = netProfitPreGasBorrowedTokenWei / (10n ** BigInt(opportunity.tokenIn.decimals));
                     // Price Borrowed/Native Standard = borrowedTokenNativePriceScaled / PRICE_SCALE
                     // Price Native/Borrowed Standard = PRICE_SCALE / borrowedTokenNativePriceScaled
                     // Net Profit Native Standard = Net Profit Borrowed Standard * Price Native/Borrowed Standard
                     // Net Profit Native Standard = netProfitPreGasBorrowedStandard * (PRICE_SCALE / borrowedTokenNativePriceScaled)
                     // Net Profit Native Wei = Net Profit Native Standard * (10^NativeDecimals)
                     // Net Profit Native Wei = netProfitPreGasBorrowedStandard * (PRICE_SCALE / borrowedTokenNativePriceScaled) * (10n ** BigInt(this.nativeCurrencyToken.decimals))
                     // Net Profit Native Wei = (netProfitPreGasBorrowedTokenWei / (10n ** BigInt(opportunity.tokenIn.decimals))) * (PRICE_SCALE / borrowedTokenNativePriceScaled) * (10n ** BigInt(this.nativeCurrencyToken.decimals))
                     // Integer: (netProfitPreGasBorrowedTokenWei * PRICE_SCALE * (10n ** BigInt(this.nativeCurrencyToken.decimals))) / ((10n ** BigInt(opportunity.tokenIn.decimals)) * borrowedTokenNativePriceScaled)

                     // Okay, let's use the borrowedTokenNativePriceScaled (Price Borrowed/Native, scaled 1e18)
                     // Net Profit Native Wei = (Net Profit Borrowed Wei * PRICE_SCALE * (10^NativeDecimals)) / (borrowedTokenNativePriceScaled * (10^BorrowedDecimals))
                     const borrowedDecimals = BigInt(opportunity.tokenIn.decimals);
                     const nativeDecimals = BigInt(this.nativeCurrencyToken.decimals);

                     const numeratorNative = netProfitPreGasBorrowedTokenWei * PRICE_SCALE * (10n ** nativeDecimals);
                     const denominatorNative = borrowedTokenNativePriceScaled * (10n ** borrowedDecimals);

                     if (denominatorNative === 0n) throw new Error("Denominator Native is zero during conversion");

                     netProfitNativeWei = numeratorNative / denominatorNative;
                     logger.debug(`${logPrefix} Net Profit (Pre-Gas, Native): ${netProfitNativeWei.toString()} wei`);

                     // Flash loan fee in Native Wei (for logging)
                     // FL Fee Native Wei = (FL Fee Borrowed Wei * PRICE_SCALE * (10^NativeDecimals)) / (borrowedTokenNativePriceScaled * (10^BorrowedDecimals))
                     const numeratorFeeNative = flashLoanFeeBorrowedTokenWei_Corrected * PRICE_SCALE * (10n ** nativeDecimals);
                     flashLoanFeeNativeWei = numeratorFeeNative / denominatorNative;
                     opportunity.flashLoanDetails.feeNativeWei = flashLoanFeeNativeWei; // Store fee in native wei

                } // End else (borrowed token is not native)
                 // --- END MOCK PRICE CONVERSION ---


                // Subtract Gas Cost (already in Native Wei)
                 if (netProfitNativeWei < gasCostNativeWei) {
                     logger.debug(`${logPrefix} Net profit (${netProfitNativeWei}) less than gas cost (${gasCostNativeWei}). Skipping.`);
                     continue; // Skip if not profitable after gas
                 }
                const netProfitAfterGasNativeWei = netProfitNativeWei - gasCostNativeWei;
                opportunity.netProfitNativeWei = netProfitAfterGasNativeWei; // Augment opportunity object
                logger.debug(`${logPrefix} Net Profit (After Gas, Native): ${netProfitAfterGasNativeWei.toString()} wei`);


                // Apply Minimum Profit Threshold
                // The threshold is defined in the config (in native currency units)
                // Need to convert the threshold from standard native units to native wei
                 const minProfitThresholdStandard = BigInt(Math.round(this.minProfitThresholds[opportunity.borrowTokenSymbol] * (10**this.nativeCurrencyToken.decimals))) ||
                                                  BigInt(Math.round(this.minProfitThresholds.DEFAULT * (10**this.nativeCurrencyToken.decimals))); // Use specific or default, convert to smallest units


                 minProfitThresholdNativeWei = minProfitThresholdStandard; // This is already in native wei smallest units

                 // Find the correct threshold for the borrowed token, convert to Native Wei using its price
                 // Threshold is in Native standard units. Convert to Native Wei.
                 const thresholdInNativeStandardUnits = this.minProfitThresholds[opportunity.borrowTokenSymbol] || this.minProfitThresholds.DEFAULT;

                // Convert threshold (Native Standard) to Native Wei
                minProfitThresholdNativeWei = BigInt(Math.round(thresholdInNativeStandardUnits * (10 ** this.nativeCurrencyToken.decimals))); // Correct conversion to native wei smallest units
                 opportunity.thresholdNativeWei = minProfitThresholdNativeWei; // Store threshold in native wei


                if (netProfitAfterGasNativeWei <= minProfitThresholdNativeWei) {
                    logger.debug(`${logPrefix} Net profit (${netProfitAfterGasNativeWei}) below threshold (${minProfitThresholdNativeWei}). Skipping.`);
                    continue; // Skip if profit is below threshold
                }
                logger.debug(`${logPrefix} Net profit (${netProfitAfterGasNativeWei}) meets threshold (${minProfitThresholdNativeWei}).`);


                // --- 4. Calculate Tithe ---
                // Tithe is a percentage of the Net Profit (After Gas)
                // Tithe Amount (Native Wei) = Net Profit After Gas (Native Wei) * Tithe Percentage / 100
                // Assuming Tithe Percentage is hardcoded in the contract (30%)
                // Tithe BPS = 3000
                const titheBps = 3000n; // Hardcoded 30% = 3000 BPS
                titheAmountNativeWei = (netProfitAfterGasNativeWei * titheBps) / TEN_THOUSAND; // Tithe calculated in Native Wei
                opportunity.titheAmountNativeWei = titheAmountNativeWei; // Augment opportunity object
                logger.debug(`${logPrefix} Tithe Amount (Native): ${titheAmountNativeWei.toString()} wei (${titheBps * 100n / TEN_THOUSAND}% of ${netProfitAfterGasNativeWei})`);


                // Augment opportunity object with final profit details
                opportunity.estimatedProfit = netProfitAfterGasNativeWei; // Net profit after gas (before tithe)
                // Store profit *after* tithe for execution? Or Tithe is transferred automatically?
                // The contract handles the tithe transfer. The bot just needs to know the net profit before tithe
                // to check against the threshold, and pass the titheRecipient address.
                // The contract receives the gross profit (amountOut - amountIn), calculates net (subtracts FL fee, maybe others?), calculates tithe, sends tithe, sends remaining to executor.

                // Let's recalculate Net Profit based on the contract's assumed calculation:
                // Contract Net Profit = Amount Out (Borrowed) - Amount In (Borrowed) - FL Fee (Borrowed)
                const contractNetProfitBorrowedTokenWei = finalAmountOutBorrowedToken - opportunity.amountIn - flashLoanFeeBorrowedTokenWei_Corrected;

                // Re-calculate estimatedProfit based on what's left for the executor after tithe
                const estimatedProfitForExecutorNativeWei = netProfitAfterGasNativeWei - titheAmountNativeWei;
                opportunity.estimatedProfitForExecutorNativeWei = estimatedProfitForExecutorNativeWei; // Augment opportunity object
                logger.debug(`${logPrefix} Estimated Profit For Executor (Native): ${estimatedProfitForExecutorNativeWei.toString()} wei`);


                // Calculate Profit Percentage relative to the borrowed amount in Native Wei (for scoring/logging)
                let profitPercentage = 0;
                if (borrowedAmountNativeWei > 0n) { // Avoid division by zero
                    // Percentage = (Net Profit After Gas Native Wei / Borrowed Amount Native Wei) * 100
                    // Using BigInts: (netProfitAfterGasNativeWei * 10000n) / borrowedAmountNativeWei / 100n ... ?
                    // Need to convert borrowedAmountNativeWei to a comparable scale if it's huge.
                    // Let's use the initial borrowed amount in its standard units for percentage base
                     const borrowedAmountStandard = opportunity.amountIn / (10n ** BigInt(opportunity.tokenIn.decimals));
                     if (borrowedAmountStandard > 0n) {
                         // Convert net profit (Native Wei) to Native Standard units
                         const netProfitNativeStandard = netProfitAfterGasNativeWei / (10n ** BigInt(this.nativeCurrencyToken.decimals));

                         // Percentage = (Net Profit Native Standard / Borrowed Amount Standard) * 100
                         // This requires converting Borrowed Standard amount to Native Standard amount using price feed.
                         // Let's calculate percentage based on NET PROFIT (NATIVE WEI) relative to GAS COST (NATIVE WEI) - GWEI/GAS cost
                         // Or relative to the total value of the trade in Native?
                         // Let's use Net Profit (Native Wei) relative to the initial borrowed amount converted to Native Wei (borrowedAmountNativeWei)

                         if (borrowedAmountNativeWei > 0n) {
                            // Percentage = (netProfitAfterGasNativeWei * 10000n) / borrowedAmountNativeWei / 100n; // Using 10000 for BPS
                             // Correct percentage calc: (Net Profit Native Wei * 100) / Borrowed Amount Native Wei
                             profitPercentage = Number((netProfitAfterGasNativeWei * 10000n) / borrowedAmountNativeWei) / 100; // Calculate in BPS, then convert to percentage
                         }
                     }
                }
                 opportunity.profitPercentage = profitPercentage; // Augment opportunity object


                // --- 5. Add to Profitable Trades List ---
                profitableTrades.push(opportunity);
                logger.debug(`${logPrefix} Added to profitable trades list.`);

            } catch (profitCalcError) {
                // Catch errors during conversion or final calculations
                logger.error(`${logPrefix} Error during final profit calculation steps: ${profitCalcError.message}`, profitCalcError);
                opportunity.calculationError = profitCalcError.message; // Store calculation error
                continue; // Skip to the next opportunity
            }
        } // End opportunity loop

        logger.debug(`[ProfitCalculator] Finished calculation. Found ${profitableTrades.length} profitable trades.`);
        logger.info(`[ProfitCalculator] Found ${profitableTrades.length} profitable trades (after gas/threshold).`); // Keep this info log

        return profitableTrades; // Return list of profitable trades
    }


    // Helper function to convert an amount of a token (in smallest units) to Native Wei
    // This is a placeholder and needs proper implementation using price feeds.
    async _convertToNativeWei(amountWei, tokenObject) {
         // --- MOCK IMPLEMENTATION ---
         if (!tokenObject?.address || tokenObject.decimals === undefined || tokenObject.decimals === null) {
             throw new Error("Invalid token object for native conversion mock.");
         }
          if (amountWei === undefined || amountWei === null) return 0n; // Handle null/undefined amount

         // If token is native, return amount directly
         if (tokenObject.symbol === this.nativeCurrencyToken.symbol || tokenObject.address.toLowerCase() === this.nativeCurrencyToken.address.toLowerCase()) {
             return amountWei;
         }

         // For non-native tokens, use a mock price conversion
         // Need price of Token / Native (Scaled 1e18)
         let tokenNativePriceScaled = 0n;
         if (tokenObject.symbol === 'USDC' || tokenObject.symbol === 'USDC.e' || tokenObject.symbol === 'USDT' || tokenObject.symbol === 'DAI') {
             // Assume stablecoin price relative to Native is ~1/1850 (if Native is WETH/ETH)
             // Price Stablecoin / Native Standard = PRICE_SCALE / 1850n (Scaled 1e18)
              tokenNativePriceScaled = PRICE_SCALE / 1850n;
              if (tokenNativePriceScaled === 0n) tokenNativePriceScaled = 1n; // Ensure not zero

         } else if (tokenObject.symbol === 'WBTC') {
              // Assume WBTC/Native price is ~50 (if Native is WETH/ETH)
             tokenNativePriceScaled = 50n * PRICE_SCALE;

         } else {
             // For other tokens, assume 1:1
             tokenNativePriceScaled = PRICE_SCALE;
         }

         if (tokenNativePriceScaled === 0n) {
              logger.warn(`[_convertToNativeWei Mock] Mock price for ${tokenObject.symbol}/${this.nativeCurrencyToken.symbol} is 0. Cannot convert.`);
              return 0n; // Cannot convert if price is zero
         }

         // Convert amount (Token Wei) to Native Wei
         // Amount Native Wei = (Amount Token Wei / 10^TokenDecimals) * Price (Native/Token Standard) * 10^NativeDecimals
         // Price (Native/Token Standard) = PRICE_SCALE / tokenNativePriceScaled (Scaled 1e18)
         // Amount Native Wei = (Amount Token Wei / 10^TokenDecimals) * (PRICE_SCALE / tokenNativePriceScaled) * 10^NativeDecimals
         // Integer: (amountWei * PRICE_SCALE * (10n ** BigInt(this.nativeCurrencyToken.decimals))) / ((10n ** BigInt(tokenObject.decimals)) * tokenNativePriceScaled)

         const tokenDecimals = BigInt(tokenObject.decimals);
         const nativeDecimals = BigInt(this.nativeCurrencyToken.decimals);

         const numerator = amountWei * PRICE_SCALE * (10n ** nativeDecimals);
         const denominator = tokenNativePriceScaled * (10n ** tokenDecimals);

         if (denominator === 0n) {
              logger.error(`[_convertToNativeWei Mock] Division by zero during conversion for ${tokenObject.symbol}.`);
              return 0n;
         }

         const amountNativeWei = numerator / denominator;
         logger.debug(`[_convertToNativeWei Mock] Converted ${amountWei.toString()} ${tokenObject.symbol} wei to ${amountNativeWei.toString()} ${this.nativeCurrencyToken.symbol} wei`);

         return amountNativeWei;
         // --- END MOCK IMPLEMENTATION ---
    }


} // End ProfitCalculator class

module.exports = ProfitCalculator;