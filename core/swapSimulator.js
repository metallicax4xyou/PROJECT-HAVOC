// core/swapSimulator.js
const { ethers } = require('ethers');
const logger = require('../utils/logger');
const { ABIS } = require('../constants/abis');
const { ArbitrageError } = require('../utils/errorHandler');

class SwapSimulator {
    constructor(config, provider) {
        logger.debug('[SwapSimulator] Initializing...');
        if (!config?.QUOTER_ADDRESS || !ethers.isAddress(config.QUOTER_ADDRESS)) throw new ArbitrageError('SwapSimulatorInit', 'Valid QUOTER_ADDRESS missing.');
        if (!provider) throw new ArbitrageError('SwapSimulatorInit', 'Provider instance required.');
        if (!ABIS?.IQuoterV2) throw new ArbitrageError('SwapSimulatorInit', "IQuoterV2 ABI missing.");
        // Add check for DODO ABI needed by simulateDodoSwap
        if (!ABIS?.DODOV1V2Pool) logger.warn("[SwapSimulatorInit] DODOV1V2Pool ABI missing. DODO simulations might fail.");


        this.config = config;
        this.provider = provider;
        this.quoterContract = new ethers.Contract(config.QUOTER_ADDRESS, ABIS.IQuoterV2, this.provider);
        // Cache for DODO contracts
        this.dodoPoolContractCache = {};
        logger.info(`[SwapSimulator] Initialized with Quoter V2 at ${config.QUOTER_ADDRESS}`);
    }

    _getDodoPoolContract(poolAddress) {
        const lowerCaseAddress = poolAddress.toLowerCase();
        if (!this.dodoPoolContractCache[lowerCaseAddress]) {
            try {
                 if (!ABIS?.DODOV1V2Pool) throw new Error("DODOV1V2Pool ABI not found.");
                this.dodoPoolContractCache[lowerCaseAddress] = new ethers.Contract(
                    poolAddress, ABIS.DODOV1V2Pool, this.provider
                );
                 logger.debug(`[SwapSimulator] Created DODO contract instance for ${poolAddress}`);
            } catch (error) {
                 logger.error(`[SwapSimulator] Error creating DODO contract instance ${poolAddress}: ${error.message}`);
                 throw error;
            }
        }
        return this.dodoPoolContractCache[lowerCaseAddress];
    }


    async simulateSwap(poolState, tokenIn, amountIn) {
        const { dexType, address } = poolState;
        const logPrefix = `[SwapSim ${dexType} ${address?.substring(0,6) || 'N/A'}]`;
        if (!poolState || !tokenIn || !amountIn || amountIn <= 0n) {
             logger.warn(`${logPrefix} Invalid args: ${!!poolState}, ${!!tokenIn}, ${amountIn}`);
             return { success: false, amountOut: null, error: 'Invalid arguments' };
        }
        logger.debug(`${logPrefix} Sim Swap: ${ethers.formatUnits(amountIn, tokenIn.decimals)} ${tokenIn.symbol}`);
        try {
            switch (dexType) {
                case 'uniswapV3': return await this.simulateV3Swap(poolState, tokenIn, amountIn);
                case 'sushiswap': return await this.simulateV2Swap(poolState, tokenIn, amountIn);
                case 'dodo':      return await this.simulateDodoSwap(poolState, tokenIn, amountIn);
                default:          return { success: false, amountOut: null, error: `Unsupported dexType: ${dexType}` };
            }
        } catch (error) { return { success: false, amountOut: null, error: error.message }; }
    }

    async simulateV3Swap(poolState, tokenIn, amountIn) { /* ... unchanged from Response #39 ... */
        const { fee, token0, token1, address } = poolState; const logPrefix = `[SwapSim V3 ${address?.substring(0,6)}]`; const tokenOut = tokenIn.address.toLowerCase() === token0.address.toLowerCase() ? token1 : token0; if (!tokenOut) { return { success: false, amountOut: null, error: 'Cannot determine tokenOut' }; } const sqrtPriceLimitX96 = 0n; try { logger.debug(`${logPrefix} Quoting ${tokenIn.symbol}->${tokenOut.symbol} Fee ${fee} In ${amountIn}`); const quoteResult = await this.quoterContract.quoteExactInputSingle.staticCall( tokenIn.address, tokenOut.address, fee, amountIn, sqrtPriceLimitX96 ); const amountOut = BigInt(quoteResult[0]); logger.debug(`${logPrefix} Quoter Out: ${amountOut}`); if (amountOut <= 0n) { logger.warn(`${logPrefix} Quoter zero output.`); /* return { success: true, amountOut: 0n, error: null }; */ } return { success: true, amountOut: amountOut, error: null }; } catch (error) { let reason = error.reason || error.message; if (error.data && error.data !== '0x') { try { reason = ethers.utils.toUtf8String(error.data); } catch {} } logger.warn(`${logPrefix} Quoter fail: ${reason}`); return { success: false, amountOut: null, error: `Quoter fail: ${reason}` }; }
    }

    async simulateV2Swap(poolState, tokenIn, amountIn) { /* ... unchanged from Response #39 ... */
        const { reserve0, reserve1, token0, token1, address } = poolState; const logPrefix = `[SwapSim V2 ${address?.substring(0,6)}]`; if (reserve0 === undefined || reserve1 === undefined || reserve0 <= 0n || reserve1 <= 0n) { return { success: false, amountOut: null, error: 'Invalid/zero reserves' }; } let reserveIn, reserveOut; if (tokenIn.address.toLowerCase() === token0.address.toLowerCase()) { reserveIn = reserve0; reserveOut = reserve1; } else if (tokenIn.address.toLowerCase() === token1.address.toLowerCase()) { reserveIn = reserve1; reserveOut = reserve0; } else { return { success: false, amountOut: null, error: 'tokenIn mismatch' }; } try { const amountInWithFee = amountIn * 997n; const numerator = reserveOut * amountInWithFee; const denominator = (reserveIn * 1000n) + amountInWithFee; if (denominator === 0n) { return { success: false, amountOut: null, error: 'Div by zero' }; } const amountOut = numerator / denominator; logger.debug(`${logPrefix} Sim Out: ${amountOut}`); return { success: true, amountOut: amountOut, error: null }; } catch (error) { return { success: false, amountOut: null, error: `V2 calc error: ${error.message}` }; }
    }

     /**
     * Simulates a DODO swap using direct pool queries.
     * NOTE: Requires DODOV1V2Pool ABI with querySellBaseToken and querySellQuoteToken.
     */
     async simulateDodoSwap(poolState, tokenIn, amountIn) {
        const { address, token0, token1, baseTokenSymbol } = poolState;
        const logPrefix = `[SwapSim DODO ${address?.substring(0,6)}]`;

        if (!baseTokenSymbol) return { success: false, amountOut: null, error: 'Missing baseTokenSymbol in poolState' };
        if (!token0 || !token1) return { success: false, amountOut: null, error: 'Missing token objects in poolState' };

        try {
            // *** FIX: Look up baseToken object using the symbol ***
            const baseToken = this.config.TOKENS[baseTokenSymbol];
            if (!baseToken) {
                throw new Error(`Base token symbol '${baseTokenSymbol}' not found in config.TOKENS`);
            }

            // Now safe to compare addresses
            const isSellingBase = tokenIn.address.toLowerCase() === baseToken.address.toLowerCase();

            const poolContract = this._getDodoPoolContract(address); // Use specific getter
            let amountOut = 0n;

            if (isSellingBase) {
                logger.debug(`${logPrefix} Simulating sell base: ${ethers.formatUnits(amountIn, baseToken.decimals)} ${baseToken.symbol}`);
                // Ensure ABI has querySellBaseToken
                if (!poolContract.querySellBaseToken) throw new Error("querySellBaseToken function not found in DODO ABI.");
                amountOut = await poolContract.querySellBaseToken.staticCall(amountIn);
            } else { // Selling Quote
                const quoteToken = (tokenIn.address.toLowerCase() === token0.address.toLowerCase()) ? token0 : token1; // tokenIn is the quote token
                logger.debug(`${logPrefix} Simulating sell quote: ${ethers.formatUnits(amountIn, quoteToken.decimals)} ${quoteToken.symbol}`);
                 // Ensure ABI has querySellQuoteToken
                 if (!poolContract.querySellQuoteToken) throw new Error("querySellQuoteToken function not found in DODO ABI.");
                 amountOut = await poolContract.querySellQuoteToken.staticCall(amountIn);
            }
            logger.debug(`${logPrefix} DODO Query Result: ${amountOut}`);

            return { success: true, amountOut: BigInt(amountOut), error: null };

        } catch(error) {
            let reason = error.reason || error.message;
             if (error.data && error.data !== '0x') { try { reason = ethers.utils.toUtf8String(error.data); } catch { /* ignore */ } }
             logger.warn(`${logPrefix} DODO simulation query failed: ${reason}`);
            // Treat specific DODO errors as non-fatal (e.g., insufficient liquidity might just mean 0 output)
            if (reason.includes("DODO_BASE_BALANCE_NOT_ENOUGH") || reason.includes("DODO_QUOTE_BALANCE_NOT_ENOUGH") || reason.includes("TARGET_IS_ZERO")) {
                 logger.debug(`${logPrefix} DODO Query failed due to balance/target, treating as 0 output.`);
                 return { success: true, amountOut: 0n, error: null }; // Return 0 output
             }
            // Re-throw other contract/RPC errors
            return { success: false, amountOut: null, error: `DODO simulation query failed: ${reason}` };
        }
    }
}

module.exports = SwapSimulator;
