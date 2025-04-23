// core/swapSimulator.js
const { ethers } = require('ethers');
const logger = require('../utils/logger');
const { ABIS } = require('../constants/abis');
const { ArbitrageError } = require('../utils/errorHandler');

class SwapSimulator {
    constructor(config, provider) {
        logger.debug('[SwapSimulator] Initializing...'); if (!config?.QUOTER_ADDRESS || !ethers.isAddress(config.QUOTER_ADDRESS)) throw new ArbitrageError('SwapSimulatorInit', 'Valid QUOTER_ADDRESS missing.'); if (!provider) throw new ArbitrageError('SwapSimulatorInit', 'Provider instance required.'); if (!ABIS?.IQuoterV2) throw new ArbitrageError('SwapSimulatorInit', "IQuoterV2 ABI missing."); if (!ABIS?.DODOV1V2Pool) logger.warn("[SwapSimulatorInit] DODOV1V2Pool ABI missing."); this.config = config; this.provider = provider; this.quoterContract = new ethers.Contract(config.QUOTER_ADDRESS, ABIS.IQuoterV2, this.provider); this.dodoPoolContractCache = {}; logger.info(`[SwapSimulator] Initialized with Quoter V2 at ${config.QUOTER_ADDRESS}`);
    }
    _getDodoPoolContract(poolAddress) { /* ... unchanged ... */
         const lowerCaseAddress = poolAddress.toLowerCase(); if (!this.dodoPoolContractCache[lowerCaseAddress]) { try { if (!ABIS?.DODOV1V2Pool) throw new Error("DODOV1V2Pool ABI not loaded."); this.dodoPoolContractCache[lowerCaseAddress] = new ethers.Contract( poolAddress, ABIS.DODOV1V2Pool, this.provider ); logger.debug(`[SwapSim] Created DODO contract for ${poolAddress}`); } catch (error) { logger.error(`[SwapSim] Error creating DODO contract ${poolAddress}: ${error.message}`); throw error; } } return this.dodoPoolContractCache[lowerCaseAddress];
    }

    async simulateSwap(poolState, tokenIn, amountIn) { /* ... unchanged ... */
        const { dexType, address } = poolState; const logPrefix = `[SwapSim ${dexType} ${address?.substring(0,6)}]`; if (!poolState || !tokenIn || !amountIn || amountIn <= 0n) { logger.warn(`${logPrefix} Invalid args`); return { success: false, amountOut: null, error: 'Invalid arguments' }; } logger.debug(`${logPrefix} Sim Swap: ${ethers.formatUnits(amountIn, tokenIn.decimals)} ${tokenIn.symbol}`); try { switch (dexType) { case 'uniswapV3': return await this.simulateV3Swap(poolState, tokenIn, amountIn); case 'sushiswap': return await this.simulateV2Swap(poolState, tokenIn, amountIn); case 'dodo': return await this.simulateDodoSwap(poolState, tokenIn, amountIn); default: return { success: false, amountOut: null, error: `Unsupported dex: ${dexType}` }; } } catch (error) { return { success: false, amountOut: null, error: error.message }; }
     }

    async simulateV3Swap(poolState, tokenIn, amountIn) { /* ... unchanged ... */ }
    async simulateV2Swap(poolState, tokenIn, amountIn) { /* ... unchanged ... */ }

     /**
     * Simulates a DODO swap using direct query for selling base,
     * and derived rate from fetcher results for selling quote.
     */
     async simulateDodoSwap(poolState, tokenIn, amountIn) {
        const { address, token0, token1, baseTokenSymbol } = poolState; // Use baseTokenSymbol from state
        const logPrefix = `[SwapSim DODO ${address?.substring(0,6)}]`;

        // --- Validate inputs specific to DODO Sim ---
        if (!baseTokenSymbol) return { success: false, amountOut: null, error: 'Missing baseTokenSymbol in poolState' };
        if (!token0 || !token1) return { success: false, amountOut: null, error: 'Missing token objects in poolState' };
        // ---

        try {
            const baseToken = this.config.TOKENS[baseTokenSymbol];
            if (!baseToken || !baseToken.address || !baseToken.decimals) { throw new Error(`Base token '${baseTokenSymbol}' not found or invalid.`); }

            const isSellingBase = tokenIn.address.toLowerCase() === baseToken.address.toLowerCase();
            const poolContract = this._getDodoPoolContract(address);
            let amountOut = 0n;

            if (isSellingBase) {
                 logger.debug(`${logPrefix} Simulating sell base: ${ethers.formatUnits(amountIn, baseToken.decimals)} ${baseToken.symbol}`);
                 if (!poolContract.querySellBaseToken) throw new Error("ABI missing querySellBaseToken.");
                 amountOut = await poolContract.querySellBaseToken.staticCall(amountIn);
                 logger.debug(`${logPrefix} DODO querySellBaseToken Result: ${amountOut}`);
                 amountOut = BigInt(amountOut);
            } else {
                 // Selling QUOTE token: Use rate derived from fetcher results stored in poolState
                 logger.debug(`${logPrefix} Simulating sell quote (using derived rate): ${ethers.formatUnits(amountIn, tokenIn.decimals)} ${tokenIn.symbol}`);

                 // *** Retrieve the query results stored BY THE FETCHER ***
                 const rateInfo_QuoteWeiPerBaseWei = poolState.queryAmountOutWei;
                 const rateInfo_BaseToken = poolState.queryBaseToken; // Base token obj from query
                 const rateInfo_QuoteToken = poolState.queryQuoteToken; // Quote token obj from query

                 if (rateInfo_QuoteWeiPerBaseWei === undefined || rateInfo_QuoteWeiPerBaseWei === null || !rateInfo_BaseToken || !rateInfo_QuoteToken) {
                     // This error would now indicate SpatialFinder didn't pass the data correctly
                     throw new Error("Missing DODO rate info (queryAmountOutWei/Base/Quote) in poolState. Check SpatialFinder->extractSimState.");
                 }
                 // Optional: Cross-check tokens if needed (should match the pool's base/quote derived here)
                 if (rateInfo_BaseToken.symbol !== baseToken.symbol || rateInfo_QuoteToken.symbol !== tokenIn.symbol) {
                      logger.warn(`${logPrefix} Token mismatch between simulation input and stored rate info.`);
                      // Decide how to handle: error out or proceed with caution?
                      // Let's proceed for now, assuming the symbols are correct guides.
                 }

                 const rateQuotePerBase = BigInt(rateInfo_QuoteWeiPerBaseWei);
                 const baseDecimals = BigInt(rateInfo_BaseToken.decimals);
                 // const quoteDecimals = BigInt(rateInfo_QuoteToken.decimals); // Same as tokenIn.decimals

                 if (rateQuotePerBase <= 0n) { amountOut = 0n; }
                 else {
                     // AmountOutBaseWei = (AmountInQuoteWei * 10^BaseDecimals) / RateQuoteWeiPerBaseWei
                     const numerator = amountIn * (10n ** baseDecimals);
                     const denominator = rateQuotePerBase;
                     if (denominator === 0n) throw new Error("Division by zero in DODO derived rate calc.");
                     amountOut = numerator / denominator;
                 }
                 logger.debug(`${logPrefix} DODO Derived Rate Sim Out: ${amountOut} (Base Token Wei)`);
            }

            return { success: true, amountOut: amountOut, error: null };

        } catch(error) { /* ... Error handling unchanged ... */
            let reason = error.reason || error.message; if (error.data && error.data !== '0x') { try { reason = ethers.utils.toUtf8String(error.data); } catch {}} logger.warn(`${logPrefix} DODO simulation failed: ${reason}`); if (reason.includes("BALANCE_NOT_ENOUGH") || reason.includes("TARGET_IS_ZERO")) { logger.debug(`${logPrefix} DODO Query failed due to balance/target, output=0.`); return { success: true, amountOut: 0n, error: null }; } return { success: false, amountOut: null, error: `DODO simulation failed: ${reason}` };
        }
    }
}

module.exports = SwapSimulator;
