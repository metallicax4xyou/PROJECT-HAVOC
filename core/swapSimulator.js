// core/swapSimulator.js
// --- VERSION v1.1 ---
// Refined DODO simulation logic and logging based on feedback.

const { ethers } = require('ethers');
const logger = require('../utils/logger'); // Adjust path if needed
const { ABIS } = require('../constants/abis'); // Adjust path if needed
const { ArbitrageError } = require('../utils/errorHandler'); // Adjust path if needed

class SwapSimulator {
    constructor(config, provider) {
        logger.debug('[SwapSimulator] Initializing...');
        if (!config?.QUOTER_ADDRESS || !ethers.isAddress(config.QUOTER_ADDRESS)) throw new ArbitrageError('SwapSimulatorInit', 'Valid QUOTER_ADDRESS missing.');
        if (!provider) throw new ArbitrageError('SwapSimulatorInit', 'Provider instance required.');
        if (!ABIS?.IQuoterV2) throw new ArbitrageError('SwapSimulatorInit', "IQuoterV2 ABI missing.");
        if (!ABIS?.DODOV1V2Pool) logger.warn("[SwapSimulatorInit] DODOV1V2Pool ABI missing. DODO simulations might fail if direct queries are needed.");

        this.config = config;
        this.provider = provider;
        this.quoterContract = new ethers.Contract(config.QUOTER_ADDRESS, ABIS.IQuoterV2, this.provider);
        this.dodoPoolContractCache = {};
        logger.info(`[SwapSimulator] Initialized with Quoter V2 at ${config.QUOTER_ADDRESS}`);
    }

    // Helper to get DODO pool contract instance
    _getDodoPoolContract(poolAddress) {
        const lowerCaseAddress = poolAddress.toLowerCase();
        if (!this.dodoPoolContractCache[lowerCaseAddress]) {
            try {
                if (!ABIS?.DODOV1V2Pool) throw new Error("DODOV1V2Pool ABI is not loaded.");
                this.dodoPoolContractCache[lowerCaseAddress] = new ethers.Contract( poolAddress, ABIS.DODOV1V2Pool, this.provider );
                logger.debug(`[SwapSim] Created DODO contract instance for ${poolAddress}`);
            } catch (error) {
                logger.error(`[SwapSim] Error creating DODO contract instance ${poolAddress}: ${error.message}`);
                throw error; // Re-throw to be caught by simulateDodoSwap
            }
        }
        return this.dodoPoolContractCache[lowerCaseAddress];
    }

    // Main simulation dispatcher
    async simulateSwap(poolState, tokenIn, amountIn) {
        const { dexType, address } = poolState;
        const logPrefix = `[SwapSim ${dexType} ${address?.substring(0,6) || 'N/A'}]`;
        if (!poolState || !tokenIn || !amountIn || amountIn <= 0n) {
             logger.warn(`${logPrefix} Invalid args for simulateSwap`);
             return { success: false, amountOut: null, error: 'Invalid arguments' };
        }
        logger.debug(`${logPrefix} Sim Swap: ${ethers.formatUnits(amountIn, tokenIn.decimals)} ${tokenIn.symbol}`);
        try {
            switch (dexType?.toLowerCase()) { // Use lowercase for safety
                case 'uniswapv3': return await this.simulateV3Swap(poolState, tokenIn, amountIn);
                case 'sushiswap': return await this.simulateV2Swap(poolState, tokenIn, amountIn);
                case 'dodo':      return await this.simulateDodoSwap(poolState, tokenIn, amountIn);
                default:          logger.warn(`${logPrefix} Unsupported dexType: ${dexType}`); return { success: false, amountOut: null, error: `Unsupported dex: ${dexType}` };
            }
        } catch (error) {
            logger.error(`${logPrefix} Unexpected error during simulation dispatch: ${error.message}`, error);
            return { success: false, amountOut: null, error: `Simulation dispatch error: ${error.message}` };
        }
     }

    // Uniswap V3 Simulation (Unchanged from previous working version)
    async simulateV3Swap(poolState, tokenIn, amountIn) {
        const { fee, token0, token1, address } = poolState; const logPrefix = `[SwapSim V3 ${address?.substring(0,6)}]`; const tokenOut = tokenIn.address.toLowerCase() === token0.address.toLowerCase() ? token1 : token0; if (!tokenOut) { return { success: false, amountOut: null, error: 'Cannot determine tokenOut' }; } const sqrtPriceLimitX96 = 0n; try { logger.debug(`${logPrefix} Quoting ${tokenIn.symbol}->${tokenOut.symbol} Fee ${fee} In ${amountIn}`); const quoteResult = await this.quoterContract.quoteExactInputSingle.staticCall( tokenIn.address, tokenOut.address, fee, amountIn, sqrtPriceLimitX96 ); const amountOut = BigInt(quoteResult[0]); logger.debug(`${logPrefix} Quoter Out: ${amountOut}`); if (amountOut <= 0n) { logger.warn(`${logPrefix} Quoter zero output.`); } return { success: true, amountOut: amountOut, error: null }; } catch (error) { let reason = error.reason || error.message; if (error.data && error.data !== '0x') { try { reason = ethers.utils.toUtf8String(error.data); } catch {} } logger.warn(`${logPrefix} Quoter fail: ${reason}`); return { success: false, amountOut: null, error: `Quoter fail: ${reason}` }; }
    }

    // Uniswap V2 / SushiSwap Simulation (Unchanged from previous working version)
    async simulateV2Swap(poolState, tokenIn, amountIn) {
        const { reserve0, reserve1, token0, token1, address } = poolState; const logPrefix = `[SwapSim V2 ${address?.substring(0,6)}]`; if (reserve0 === undefined || reserve1 === undefined || reserve0 <= 0n || reserve1 <= 0n) { return { success: false, amountOut: null, error: 'Invalid/zero reserves' }; } let reserveIn, reserveOut; if (tokenIn.address.toLowerCase() === token0.address.toLowerCase()) { reserveIn = reserve0; reserveOut = reserve1; } else if (tokenIn.address.toLowerCase() === token1.address.toLowerCase()) { reserveIn = reserve1; reserveOut = reserve0; } else { return { success: false, amountOut: null, error: 'tokenIn mismatch' }; } try { const amountInWithFee = amountIn * 997n; const numerator = reserveOut * amountInWithFee; const denominator = (reserveIn * 1000n) + amountInWithFee; if (denominator === 0n) { return { success: false, amountOut: null, error: 'Div by zero' }; } const amountOut = numerator / denominator; logger.debug(`${logPrefix} Sim Out: ${amountOut}`); return { success: true, amountOut: amountOut, error: null }; } catch (error) { return { success: false, amountOut: null, error: `V2 calc error: ${error.message}` }; }
    }

     /**
     * Simulates a DODO swap using direct pool query for selling base,
     * and derived rate from fetcher results for selling quote.
     * Handles cases where DODO query functions might revert.
     */
     async simulateDodoSwap(poolState, tokenIn, amountIn) {
        const { address, token0, token1, baseTokenSymbol } = poolState;
        const logPrefix = `[SwapSim DODO ${address?.substring(0,6)}]`;

        if (!baseTokenSymbol) return { success: false, amountOut: null, error: 'Missing baseTokenSymbol in poolState' };
        if (!token0 || !token1 || !token0.symbol || !token1.symbol) return { success: false, amountOut: null, error: 'Missing token objects in poolState' };

        let amountOut = 0n; // Initialize amountOut

        try {
            // Look up base token object from config using the symbol from poolState
            const baseToken = this.config.TOKENS[baseTokenSymbol];
            if (!baseToken || !baseToken.address || !baseToken.decimals) {
                throw new ArbitrageError('DodoSimError', `Base token symbol '${baseTokenSymbol}' not found or invalid in config.TOKENS.`);
            }

            // Determine if the input token is the base token
            const isSellingBase = tokenIn.address.toLowerCase() === baseToken.address.toLowerCase();
            const poolContract = this._getDodoPoolContract(address); // Get contract instance

            if (isSellingBase) {
                // --- Selling BASE token ---
                logger.debug(`${logPrefix} Simulating sell BASE: ${ethers.formatUnits(amountIn, baseToken.decimals)} ${baseToken.symbol}`);
                if (typeof poolContract.querySellBaseToken !== 'function') {
                    throw new ArbitrageError('DodoSimError', "querySellBaseToken function not found in DODO ABI.");
                }
                try {
                    amountOut = BigInt(await poolContract.querySellBaseToken.staticCall(amountIn));
                    logger.debug(`${logPrefix} DODO querySellBaseToken Result: ${amountOut}`);
                } catch (queryError) {
                     // Handle reverts specifically for this query
                     let reason = queryError.reason || queryError.message; if (queryError.data && queryError.data !== '0x') { try { reason = ethers.utils.toUtf8String(queryError.data); } catch {}} logger.warn(`${logPrefix} querySellBaseToken reverted: ${reason}`);
                     if (reason.includes("BALANCE_NOT_ENOUGH") || reason.includes("TARGET_IS_ZERO")) {
                         amountOut = 0n; logger.debug(`${logPrefix} Query failed due to balance/target, output=0.`);
                     } else { throw queryError; } // Re-throw unexpected errors
                }
            } else {
                // --- Selling QUOTE token ---
                const quoteToken = tokenIn; // Input token is the quote token
                logger.debug(`${logPrefix} Simulating sell QUOTE (using derived rate): ${ethers.formatUnits(amountIn, quoteToken.decimals)} ${quoteToken.symbol}`);

                // Retrieve the query results stored by the fetcher
                const rateInfo_QuoteWeiPerBaseWei = poolState.queryAmountOutWei; // Amount of Quote per 1 Base unit
                const rateInfo_BaseToken = poolState.queryBaseToken; // Base token object used for the stored rate
                const rateInfo_QuoteToken = poolState.queryQuoteToken; // Quote token object used for the stored rate

                // Validate the stored rate info
                if (rateInfo_QuoteWeiPerBaseWei === undefined || rateInfo_QuoteWeiPerBaseWei === null || !rateInfo_BaseToken?.decimals || !rateInfo_QuoteToken?.decimals) {
                    throw new ArbitrageError('DodoSimError', "Missing DODO rate info from fetcher in poolState.");
                }
                // Optional Sanity check: ensure stored tokens match expected
                if (rateInfo_BaseToken.address.toLowerCase() !== baseToken.address.toLowerCase() ||
                    rateInfo_QuoteToken.address.toLowerCase() !== quoteToken.address.toLowerCase()) {
                     logger.warn(`${logPrefix} Token mismatch between simulation tokens and stored rate tokens.`);
                     // Continue, but be aware calculation might use slightly different token context than expected
                 }

                 const rateQuotePerBase = BigInt(rateInfo_QuoteWeiPerBaseWei);
                 const baseDecimals = BigInt(rateInfo_BaseToken.decimals); // Use decimals from stored rate info

                 // Optional: Check for suspiciously low rates
                 if (rateQuotePerBase <= 100n) { // Example threshold (adjust)
                      logger.warn(`${logPrefix} Suspiciously low DODO rate (<100 wei quote/base): ${rateQuotePerBase}`);
                 }

                 if (rateQuotePerBase <= 0n) {
                      amountOut = 0n; // Cannot get anything if rate is zero/negative
                 } else {
                     // Calculate AmountOutBaseWei = (AmountInQuoteWei * 10^BaseDecimals) / RateQuoteWeiPerBaseWei
                     const numerator = amountIn * (10n ** baseDecimals);
                     const denominator = rateQuotePerBase;
                     amountOut = numerator / denominator; // Result is in Base Token Wei
                 }
                 logger.debug(`${logPrefix} DODO Derived Rate Sim Out: ${amountOut} (Base Token Wei)`);
            }

            // Final validation of output amount
            if (amountOut < 0n) {
                 logger.warn(`${logPrefix} Simulation resulted in negative amountOut (${amountOut}). Setting to 0.`);
                 amountOut = 0n;
             }

            return { success: true, amountOut: amountOut, error: null };

        } catch(error) {
            // Catch errors from validation, contract creation, or unexpected calculation errors
            const errMsg = error instanceof ArbitrageError ? error.message : `Unexpected DODO sim error: ${error.message}`;
            logger.warn(`${logPrefix} DODO simulation failed: ${errMsg}`);
            return { success: false, amountOut: null, error: `DODO simulation failed: ${errMsg}` };
        }
    }
}

module.exports = SwapSimulator;
