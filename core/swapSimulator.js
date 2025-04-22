// core/swapSimulator.js
const { ethers } = require('ethers');
const logger = require('../utils/logger'); // Adjust path if needed
const { ABIS } = require('../constants/abis'); // Adjust path if needed
const { ArbitrageError } = require('../utils/errorHandler'); // Adjust path if needed

// Uniswap V3 Quoter V2 address (Arbitrum) - Make sure this is in your config or constants
// const QUOTER_V2_ADDRESS = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e'; // Example, verify correct address

class SwapSimulator {
    /**
     * @param {object} config The main configuration object (needs QUOTER_ADDRESS)
     * @param {ethers.Provider} provider Ethers provider instance
     */
    constructor(config, provider) {
        logger.debug('[SwapSimulator] Initializing...');
        if (!config || !config.QUOTER_ADDRESS || !ethers.isAddress(config.QUOTER_ADDRESS)) {
            throw new ArbitrageError('SwapSimulatorInit', 'Valid QUOTER_ADDRESS missing in config.');
        }
        if (!provider) {
            throw new ArbitrageError('SwapSimulatorInit', 'Provider instance required.');
        }
        if (!ABIS || !ABIS.IQuoterV2) {
             throw new ArbitrageError('SwapSimulatorInit', "IQuoterV2 ABI not found in constants/abis.js.");
        }

        this.config = config;
        this.provider = provider;
        this.quoterContract = new ethers.Contract(
            config.QUOTER_ADDRESS,
            ABIS.IQuoterV2, // Use the IQuoterV2 ABI
            this.provider
        );
        logger.info(`[SwapSimulator] Initialized with Quoter V2 at ${config.QUOTER_ADDRESS}`);
    }

    /**
     * Simulates a swap for a given pool state and input amount.
     * @param {object} poolState The fetched state of the pool (needs dexType, tokens, fee, etc.)
     * @param {object} tokenIn The token object (from constants/tokens) for the input token.
     * @param {bigint} amountIn The amount of tokenIn to swap (in wei).
     * @returns {Promise<{ success: boolean, amountOut: bigint | null, error: string | null }>} Simulation result.
     */
    async simulateSwap(poolState, tokenIn, amountIn) {
        const { dexType, address } = poolState;
        const logPrefix = `[SwapSimulator ${dexType} Pool ${address?.substring(0,6) || 'N/A'}]`;

        if (!poolState || !tokenIn || amountIn === undefined || amountIn === null || amountIn <= 0n) {
             logger.warn(`${logPrefix} Invalid arguments for simulateSwap.`);
             return { success: false, amountOut: null, error: 'Invalid arguments' };
        }

        logger.debug(`${logPrefix} Simulating swap: ${ethers.formatUnits(amountIn, tokenIn.decimals)} ${tokenIn.symbol}`);

        try {
            switch (dexType) {
                case 'uniswapV3':
                    return await this.simulateV3Swap(poolState, tokenIn, amountIn);
                case 'sushiswap':
                    return await this.simulateV2Swap(poolState, tokenIn, amountIn);
                case 'dodo':
                    return await this.simulateDodoSwap(poolState, tokenIn, amountIn);
                // Add cases for other DEXs
                default:
                    logger.warn(`${logPrefix} Unsupported dexType for simulation: ${dexType}`);
                    return { success: false, amountOut: null, error: `Unsupported dexType: ${dexType}` };
            }
        } catch (error) {
             logger.error(`${logPrefix} Error during simulation: ${error.message}`, error);
             return { success: false, amountOut: null, error: error.message };
        }
    }

    /**
     * Simulates a Uniswap V3 swap using the Quoter V2 contract.
     * @param {object} poolState V3 pool state (needs fee, token0, token1).
     * @param {object} tokenIn Input token object.
     * @param {bigint} amountIn Input amount (wei).
     * @returns {Promise<{ success: boolean, amountOut: bigint | null, error: string | null }>}
     */
    async simulateV3Swap(poolState, tokenIn, amountIn) {
        const { fee, token0, token1, address } = poolState;
        const logPrefix = `[SwapSimulator V3 Pool ${address?.substring(0,6)}]`;

        // Determine tokenOut
        const tokenOut = tokenIn.address.toLowerCase() === token0.address.toLowerCase() ? token1 : token0;
        if (!tokenOut) { return { success: false, amountOut: null, error: 'Could not determine tokenOut' }; }

        // V3 Quoter requires sqrtPriceLimitX96 = 0 for exact input swaps across ticks
        const sqrtPriceLimitX96 = 0n;

        try {
            logger.debug(`${logPrefix} Calling quoterV2.quoteExactInputSingle: ${tokenIn.symbol} -> ${tokenOut.symbol}, Fee: ${fee}, AmountIn: ${amountIn}`);

            // Use callStatic for simulation without sending a transaction
            // Params: tokenIn, tokenOut, fee, amountIn, sqrtPriceLimitX96
            const quoteResult = await this.quoterContract.quoteExactInputSingle.staticCall(
                tokenIn.address,
                tokenOut.address,
                fee,
                amountIn,
                sqrtPriceLimitX96
            );

            // Quoter V2 returns multiple values, we typically want amountOut (index 0)
            const amountOut = BigInt(quoteResult[0]); // amountOut is the first element
            logger.debug(`${logPrefix} Quoter Result amountOut: ${amountOut}`);

            if (amountOut <= 0n) {
                logger.warn(`${logPrefix} Quoter returned 0 or negative amountOut. Likely insufficient liquidity or other issue.`);
                // Treat as simulation failure or just zero output? Let's say zero output is valid.
                 return { success: true, amountOut: 0n, error: null };
            }

            return { success: true, amountOut: amountOut, error: null };

        } catch (error) {
             // Handle specific Quoter reverts if possible
             let reason = error.reason || error.message;
             if (error.data && error.data !== '0x') { // Try decoding error data
                 try { reason = ethers.utils.toUtf8String(error.data); } catch { /* ignore decoding error */ }
             }
             logger.warn(`${logPrefix} Quoter V2 simulation failed: ${reason}`);
             // Common reasons: "Too little received" (if sqrtPriceLimit hit), "Address is not initialized" (bad pool/tokens)
             return { success: false, amountOut: null, error: `QuoterV2 simulation failed: ${reason}` };
        }
    }

    /**
     * Simulates a Uniswap V2 / SushiSwap swap using AMM formula.
     * @param {object} poolState V2 pool state (needs reserve0, reserve1, token0, token1).
     * @param {object} tokenIn Input token object.
     * @param {bigint} amountIn Input amount (wei).
     * @returns {Promise<{ success: boolean, amountOut: bigint | null, error: string | null }>}
     */
    async simulateV2Swap(poolState, tokenIn, amountIn) {
        const { reserve0, reserve1, token0, token1, address } = poolState;
        const logPrefix = `[SwapSimulator V2 Pool ${address?.substring(0,6)}]`;

        if (reserve0 === undefined || reserve1 === undefined || reserve0 <= 0n || reserve1 <= 0n) {
            logger.warn(`${logPrefix} Invalid or zero reserves for simulation.`);
            return { success: false, amountOut: null, error: 'Invalid or zero reserves' };
        }

        let reserveIn, reserveOut;
        if (tokenIn.address.toLowerCase() === token0.address.toLowerCase()) {
            reserveIn = reserve0;
            reserveOut = reserve1;
        } else if (tokenIn.address.toLowerCase() === token1.address.toLowerCase()) {
            reserveIn = reserve1;
            reserveOut = reserve0;
        } else {
             return { success: false, amountOut: null, error: 'tokenIn does not match pool tokens' };
        }

        try {
            // Standard AMM formula: amountOut = (reserveOut * amountIn * 997) / (reserveIn * 1000 + amountIn * 997)
            const amountInWithFee = amountIn * 997n; // amountIn * (1 - fee) where fee = 0.3%
            const numerator = reserveOut * amountInWithFee;
            const denominator = (reserveIn * 1000n) + amountInWithFee;

            if (denominator === 0n) {
                 return { success: false, amountOut: null, error: 'Division by zero in V2 simulation' };
            }

            const amountOut = numerator / denominator;
            logger.debug(`${logPrefix} V2 Simulation: In: ${amountIn}, Out: ${amountOut}`);

             return { success: true, amountOut: amountOut, error: null };

        } catch (error) {
             logger.error(`${logPrefix} Error during V2 simulation calculation: ${error.message}`);
              return { success: false, amountOut: null, error: `V2 calculation error: ${error.message}` };
        }
    }

     /**
     * Simulates a DODO swap.
     * @param {object} poolState DODO pool state (needs querySellBaseToken/queryBuyBaseToken logic implemented in fetcher or here).
     * @param {object} tokenIn Input token object.
     * @param {bigint} amountIn Input amount (wei).
     * @returns {Promise<{ success: boolean, amountOut: bigint | null, error: string | null }>}
     */
     async simulateDodoSwap(poolState, tokenIn, amountIn) {
        const { address, token0, token1, baseTokenSymbol } = poolState; // Need baseTokenSymbol if using direct query
        const logPrefix = `[SwapSimulator DODO Pool ${address?.substring(0,6)}]`;

        // DODO simulation is tricky without a dedicated SDK or helper.
        // Option 1: Use the results from fetcher's `querySellBaseToken` if amountIn is always 1 unit. (Less flexible)
        // Option 2: Implement `querySellQuoteToken`, `queryBuyBaseToken` etc., calls here.
        // Option 3: Rely on a DODO Helper contract if one exists and is reliable.

        // --- Placeholder Implementation (Option 2 - Needs Pool Contract Interaction) ---
        logger.warn(`${logPrefix} DODO simulation is currently a placeholder. Needs direct pool query implementation.`);

        try {
            // Determine if selling base or quote
             const baseToken = this.config.TOKENS[baseTokenSymbol];
             const isSellingBase = tokenIn.address.toLowerCase() === baseToken.address.toLowerCase();

             // Get DODO pool contract (requires ABI in constants)
             if (!ABIS.DODOV1V2Pool) { throw new Error("DODOV1V2Pool ABI missing"); }
             const poolContract = new ethers.Contract(address, ABIS.DODOV1V2Pool, this.provider);

             let amountOut = 0n;
             if (isSellingBase) {
                 logger.debug(`${logPrefix} Simulating sell base: ${amountIn} ${tokenIn.symbol}`);
                 amountOut = await poolContract.querySellBaseToken.staticCall(amountIn);
             } else { // Selling Quote
                 logger.debug(`${logPrefix} Simulating sell quote: ${amountIn} ${tokenIn.symbol}`);
                 amountOut = await poolContract.querySellQuoteToken.staticCall(amountIn);
             }
             logger.debug(`${logPrefix} DODO Query Result: ${amountOut}`);

            return { success: true, amountOut: BigInt(amountOut), error: null };

        } catch(error) {
            let reason = error.reason || error.message;
             if (error.data && error.data !== '0x') { try { reason = ethers.utils.toUtf8String(error.data); } catch { /* ignore */ } }
             logger.warn(`${logPrefix} DODO simulation query failed: ${reason}`);
            return { success: false, amountOut: null, error: `DODO simulation query failed: ${reason}` };
        }
        // --- End Placeholder ---
    }
}

module.exports = SwapSimulator;
