// core/swapSimulator.js
// --- VERSION v1.6 --- Updated DODO simulation to use querySellBase/querySellQuote view functions.

const { ethers } = require('ethers');
const logger = require('../utils/logger'); // Adjust path if needed
const { ABIS } = require('../constants/abis'); // Adjust path if needed
const { ArbitrageError } = require('../utils/errorHandler'); // Adjust path if needed
const { Token } = require('@uniswap/sdk-core'); // May not be strictly needed, but keep for now
const { TOKENS } = require('../constants/tokens');
const { getTickSpacingFromFeeBps } = require('./scannerUtils'); // Path ok relative to core/
const { getCanonicalPairKey } = require('../utils/pairUtils'); // Correct path relative to core/

const MAX_UINT128 = (1n << 128n) - 1n; // Maybe not needed in this file, keep for context

class SwapSimulator {
    constructor(config, provider) {
        logger.debug('[SwapSimulator] Initializing...');
        if (!config?.QUOTER_ADDRESS || !ethers.isAddress(config.QUOTER_ADDRESS)) throw new ArbitrageError('SwapSimulatorInit', 'Valid QUOTER_ADDRESS missing.');
        if (!provider) throw new ArbitrageError('SwapSimulatorInit', 'Provider instance required.');
        if (!ABIS?.IQuoterV2) throw new ArbitrageError('SwapSimulatorInit', "IQuoterV2 ABI missing.");
        // Ensure DODO ABI is available for DODO simulations
        if (!ABIS?.DODOV1V2Pool) logger.warn("[SwapSimulatorInit] DODOV1V2Pool ABI missing. DODO simulations will fail.");

        this.config = config;
        this.provider = provider;
        // Use the Quoter V2 contract instance from the constructor
        this.quoterContract = new ethers.Contract(config.QUOTER_ADDRESS, ABIS.IQuoterV2, this.provider);
        this.dodoPoolContractCache = {};
        logger.info(`[SwapSimulator] Initialized with Quoter V2 at ${config.QUOTER_ADDRESS}`);
        if (ABIS?.DODOV1V2Pool) {
             logger.info(`[SwapSimulator] DODO V1/V2 Pool ABI loaded.`);
        }
    }

    // Helper to get DODO pool contract instance
    _getDodoPoolContract(poolAddress) {
        const lowerCaseAddress = poolAddress.toLowerCase();
        if (!this.dodoPoolContractCache[lowerCaseAddress]) {
            try {
                if (!ABIS?.DODOV1V2Pool) throw new Error("DODOV1V2Pool ABI is not loaded or missing.");
                this.dodoPoolContractCache[lowerCaseAddress] = new ethers.Contract( poolAddress, ABIS.DODOV1V2Pool, this.provider );
                logger.debug(`[SwapSim] Created DODO contract instance for ${poolAddress}`);
            } catch (error) {
                logger.error(`[SwapSim] Error creating DODO contract instance ${poolAddress}: ${error.message}`);
                throw new ArbitrageError('DodoSimError', `Failed to create contract instance: ${error.message}`); // Wrap error
            }
        }
        return this.dodoPoolContractCache[lowerCaseAddress];
    }

    // Main simulation dispatcher
    async simulateSwap(poolState, tokenIn, amountIn) {
        const logPrefix = `[SwapSim ${poolState?.dexType || 'N/A'} ${poolState?.address?.substring(0,6) || 'N/A'}]`;

        if (!poolState || !tokenIn || !amountIn || amountIn <= 0n) {
             logger.warn(`${logPrefix} Invalid args for simulateSwap: poolState=${!!poolState}, tokenIn=${!!tokenIn}, amountIn=${amountIn?.toString()}`);
             return { success: false, amountOut: null, error: 'Invalid arguments' };
        }
        try {
             logger.debug(`${logPrefix} Sim Swap: ${ethers.formatUnits(amountIn, tokenIn.decimals)} ${tokenIn.symbol} (raw ${amountIn.toString()})`);
        } catch (formatError) {
            logger.debug(`${logPrefix} Sim Swap: (Cannot format amount) ${amountIn.toString()} ${tokenIn?.symbol || '?'}`);
        }

        try {
            switch (poolState.dexType?.toLowerCase()) { // Use lowercase for safety
                case 'uniswapv3': return await this.simulateV3Swap(poolState, tokenIn, amountIn);
                case 'sushiswap': return await this.simulateV2Swap(poolState, tokenIn, amountIn);
                case 'dodo':      return await this.simulateDodoSwap(poolState, tokenIn, amountIn);
                default:          logger.warn(`${logPrefix} Unsupported dexType: ${poolState.dexType}`); return { success: false, amountOut: null, error: `Unsupported dex: ${poolState.dexType}` };
            }
        } catch (error) {
            // Catch unexpected errors during simulation dispatch
            const errMsg = error instanceof ArbitrageError ? error.message : `Unexpected error during simulation dispatch: ${error.message}`;
            logger.error(`${logPrefix} Simulation dispatch failed: ${errMsg}`, error);
            return { success: false, amountOut: null, error: `Simulation dispatch failed: ${errMsg}` };
        }
     }

    // Uniswap V3 Simulation (Adjusted to use poolState properties directly)
    async simulateV3Swap(poolState, tokenIn, amountIn) {
        const { fee, token0, token1, address, sqrtPriceX96, liquidity, tick } = poolState;
        const logPrefix = `[SwapSim V3 ${address?.substring(0,6)}]`;

        const tokenOut = tokenIn.address.toLowerCase() === token0.address.toLowerCase() ? token1 : token0;
        if (!tokenOut) {
             logger.warn(`${logPrefix} Cannot determine tokenOut from pair.`);
             return { success: false, amountOut: null, error: 'Cannot determine tokenOut' };
        }

        const sqrtPriceLimitX96 = 0n; // Used to set price bounds, 0 means no limit for quoteExactInputSingle

        // Basic validation for critical V3 state props
        // Also check if sqrtPriceX96 is 0n, which indicates an unusable pool state
        if (sqrtPriceX96 === undefined || sqrtPriceX96 === null || BigInt(sqrtPriceX96) === 0n ||
            liquidity === undefined || liquidity === null || tick === undefined || tick === null) {
             const errMsg = `Missing or zero critical V3 state properties for simulation (sqrtPriceX96: ${sqrtPriceX96}, liquidity: ${liquidity}, tick: ${tick}).`;
             logger.warn(`${logPrefix} ${errMsg}`);
             return { success: false, amountOut: null, error: errMsg };
        }

        try {
            // Use the Quoter V2 contract instance from the constructor
            logger.debug(`${logPrefix} Quoting ${tokenIn.symbol}->${tokenOut.symbol} Fee ${fee} In ${amountIn.toString()} (raw)`);
            // Call the quoter contract using the correct function and parameters
            // Note: quoteExactInputSingle takes amountIn as the input token amount (in smallest units)
            const quoteResult = await this.quoterContract.quoteExactInputSingle.staticCall(
                 tokenIn.address, // address tokenIn
                 tokenOut.address, // address tokenOut
                 fee, // uint24 fee (Note: poolState.fee is uint24 from fetcher)
                 amountIn, // uint256 amountIn (already in smallest units)
                 sqrtPriceLimitX96 // uint160 sqrtPriceLimitX96
            );

            // The result is an array, where the first element is the amountOut (uint256)
            const amountOut = BigInt(quoteResult[0]); // Amount out in smallest units of tokenOut
            // Note: quoteResult might contain gas estimate and sqrtPriceX96After
            // const estimatedGasUsed = BigInt(quoteResult[1]); // For potential gas cost estimation

            logger.debug(`${logPrefix} Quoter Out: ${amountOut.toString()} (raw)`);

            // A zero amountOut usually means insufficient liquidity or price impact makes it zero
            if (amountOut <= 0n) {
                logger.debug(`${logPrefix} Quoter zero or negative output (${amountOut}).`);
                return { success: false, amountOut: 0n, error: 'Quoter zero output' }; // Return 0n amountOut on zero/negative output
            }

            return { success: true, amountOut: amountOut, error: null };

        } catch (error) {
             // Attempt to decode revert reason if available
            let reason = error.reason || error.message;
            if (error.data && typeof error.data === 'string' && error.data !== '0x') {
                 try { reason = ethers.toUtf8String(error.data); } catch {} // Use ethers.toUtf8String
            }
            logger.warn(`${logPrefix} Quoter fail: ${reason}`);
            return { success: false, amountOut: null, error: `Quoter fail: ${reason}` };
        }
    }

    // Uniswap V2 / SushiSwap Simulation (Adjusted to use poolState properties directly)
    async simulateV2Swap(poolState, tokenIn, amountIn) {
        const { reserve0, reserve1, token0, token1, address } = poolState;
        const logPrefix = `[SwapSim V2 ${address?.substring(0,6)}]`;

        // Basic validation for critical V2 state props
        if (reserve0 === undefined || reserve0 === null || reserve1 === undefined || reserve1 === null) {
             const errMsg = `Missing critical V2 state properties (reserves).`;
             logger.warn(`${logPrefix} ${errMsg}`);
             return { success: false, amountOut: null, error: errMsg };
        }

        const bigIntReserve0 = BigInt(reserve0);
        const bigIntReserve1 = BigInt(reserve1);

        if (bigIntReserve0 <= 0n || bigIntReserve1 <= 0n) {
             logger.debug(`${logPrefix} Skipping due to zero or negative reserves (R0: ${bigIntReserve0}, R1: ${bigIntReserve1}). Output=0.`);
             return { success: false, amountOut: 0n, error: 'Zero or negative reserves' }; // Return 0n amountOut on zero reserves
        }

        let reserveIn, reserveOut;
        if (tokenIn.address.toLowerCase() === token0.address.toLowerCase()) {
            reserveIn = bigIntReserve0;
            reserveOut = bigIntReserve1;
        } else if (tokenIn.address.toLowerCase() === token1.address.toLowerCase()) {
            reserveIn = bigIntReserve1;
            reserveOut = bigIntReserve0;
        } else {
             const errMsg = `tokenIn mismatch with pool tokens. Input: ${tokenIn.symbol}, Pool: ${token0.symbol}/${token1.symbol}`;
             logger.warn(`${logPrefix} ${errMsg}`);
             return { success: false, amountOut: null, error: errMsg };
        }

        try {
            // V2 swap formula: amountOut = (amountIn * reserveOut * 997) / (reserveIn * 1000 + amountIn * 997)
            // Fee is 0.3%, so (1 - 0.003) = 0.997 or 997/1000
            const amountInWithFee = amountIn * 997n; // Multiply by 997
            const numerator = reserveOut * amountInWithFee;
            const denominator = (reserveIn * 1000n) + amountInWithFee; // Multiply reserveIn by 1000

            if (denominator === 0n) {
                 logger.warn(`${logPrefix} Division by zero in V2 calculation.`);
                 return { success: false, amountOut: null, error: 'Div by zero in V2 calc' };
            }

            const amountOut = numerator / denominator; // Integer division

            logger.debug(`${logPrefix} Sim Out: ${amountOut.toString()} (raw)`);
            if (amountOut <= 0n) {
                 logger.debug(`${logPrefix} V2 calculation zero or negative output (${amountOut}).`);
                 return { success: false, amountOut: 0n, error: 'V2 zero output' }; // Return 0n amountOut on zero/negative output
            }

            return { success: true, amountOut: amountOut, error: null };

        } catch (error) {
             // Catch errors from BigInt calculations
            logger.error(`${logPrefix} Unexpected V2 calculation error: ${error.message}`, error);
            return { success: false, amountOut: null, error: `V2 calc error: ${error.message}` };
        }
    }

     /**
     * Simulates a DODO swap by calling the pool's querySellBase or querySellQuote
     * view functions. Relies on the fetcher providing poolState with a valid address
     * and correctly identified baseTokenSymbol.
     * DOES NOT use PMMState math directly in JS, delegates to contract view functions.
     */
     async simulateDodoSwap(poolState, tokenIn, amountIn) {
        // Access properties directly from poolState
        // PMMState is fetched but not directly used here, as we delegate simulation to the contract queries.
        const { address, token0, token1, baseTokenSymbol } = poolState; // Removed queryAmountOutWei etc.
        const logPrefix = `[SwapSim DODO ${address?.substring(0,6)}]`;

        if (!baseTokenSymbol) {
             const errMsg = 'Missing baseTokenSymbol in poolState for DODO simulation.';
             logger.warn(`${logPrefix} ${errMsg}`);
             return { success: false, amountOut: null, error: errMsg };
        }
        if (!token0 || !token1 || !token0.symbol || !token1.symbol || !token0.address || !token1.address) {
             const errMsg = 'Missing token objects in poolState for DODO simulation.';
             logger.warn(`${logPrefix} ${errMsg}`);
             return { success: false, amountOut: null, error: errMsg };
        }
         if (!ethers.isAddress(address)) {
             const errMsg = `Invalid pool address in poolState for DODO simulation: ${address}`;
             logger.warn(`${logPrefix} ${errMsg}`);
             return { success: false, amountOut: null, error: errMsg };
         }
        if (amountIn === undefined || amountIn === null || amountIn <= 0n) {
             logger.warn(`${logPrefix} Invalid amountIn for DODO simulation: ${amountIn}`);
             return { success: false, amountOut: null, error: 'Invalid amountIn' };
        }

        try {
            const poolContract = this._getDodoPoolContract(address); // Get contract instance

            // Determine if the input token is the base token
            // Use token addresses for robustness, comparing against the baseToken's address from config
            // This assumes the fetcher correctly looked up baseToken based on baseTokenSymbol
            const baseToken = this.config.TOKENS[baseTokenSymbol];
             if (!baseToken || !baseToken.address) {
                 const errorMsg = `Base token symbol '${baseTokenSymbol}' not found or invalid in config.TOKENS.`;
                 logger.error(`${logPrefix} ${errorMsg}`);
                 throw new ArbitrageError('DodoSimError', errorMsg);
             }
            const isSellingBase = tokenIn.address.toLowerCase() === baseToken.address.toLowerCase();

            let amountOut = 0n;
            let queryResult;

            if (isSellingBase) {
                // --- Simulating Selling BASE token ---
                logger.debug(`${logPrefix} Simulating sell BASE: ${ethers.formatUnits(amountIn, tokenIn.decimals)} ${tokenIn.symbol}`);

                // Call the pool's querySellBase view function
                 // querySellBase returns (uint receiveQuoteAmount, uint mtFee)
                 if (typeof poolContract.querySellBase !== 'function') {
                     const errorMsg = "querySellBase function not found in DODO ABI for this contract.";
                     logger.error(`${logPrefix} ${errorMsg}`);
                     throw new ArbitrageError('DodoSimError', errorMsg);
                 }
                try {
                     // querySellBase(address trader, uint256 payBaseAmount)
                     // Use ethers.ZeroAddress as the trader for simulation
                     queryResult = await poolContract.querySellBase.staticCall(ethers.ZeroAddress, amountIn);
                     amountOut = BigInt(queryResult[0]); // The first element is receiveQuoteAmount
                     // Note: queryResult[1] is mtFee, might need later for detailed analysis, but standard simulation doesn't use it directly.

                    logger.debug(`${logPrefix} DODO querySellBase Sim Out: ${amountOut.toString()} (raw)`);
                } catch (queryError) {
                    // Attempt to decode revert reason
                    let reason = queryError.reason || queryError.message;
                    if (queryError.data && typeof queryError.data === 'string' && queryError.data !== '0x') {
                        try { reason = ethers.toUtf8String(queryError.data); } catch {}
                    }
                    // Log common reverts at debug/info level, others at warn/error
                    if (reason.includes("BALANCE_NOT_ENOUGH") || reason.includes("TARGET_IS_ZERO") || reason.includes("SELL_BASE_RESULT_IS_ZERO") || reason.includes("DODO_SELL_AMOUNT_TOO_SMALL")) {
                         logger.debug(`${logPrefix} querySellBase reverted (zero output expected): ${reason}`);
                         amountOut = 0n; // Explicitly set amountOut to 0 on these expected reverts
                         // Do NOT throw, return success: false with amountOut: 0n
                         return { success: false, amountOut: 0n, error: `DODO query zero output: ${reason}` };
                     } else {
                        logger.warn(`${logPrefix} querySellBase reverted unexpectedly: ${reason}`);
                        throw queryError; // Re-throw unexpected errors
                    }
                }

            } else {
                // --- Simulating Selling QUOTE token ---
                logger.debug(`${logPrefix} Simulating sell QUOTE: ${ethers.formatUnits(amountIn, tokenIn.decimals)} ${tokenIn.symbol}`);

                // Call the pool's querySellQuote view function
                // querySellQuote returns (uint receiveBaseAmount, uint mtFee)
                if (typeof poolContract.querySellQuote !== 'function') {
                    const errorMsg = "querySellQuote function not found in DODO ABI for this contract.";
                     logger.error(`${logPrefix} ${errorMsg}`);
                     throw new ArbitrageError('DodoSimError', errorMsg);
                }
                try {
                    // querySellQuote(address trader, uint256 payQuoteAmount)
                    // Use ethers.ZeroAddress as the trader for simulation
                    queryResult = await poolContract.querySellQuote.staticCall(ethers.ZeroAddress, amountIn);
                    amountOut = BigInt(queryResult[0]); // The first element is receiveBaseAmount
                    // Note: queryResult[1] is mtFee

                    logger.debug(`${logPrefix} DODO querySellQuote Sim Out: ${amountOut.toString()} (raw)`);
                } catch (queryError) {
                    // Attempt to decode revert reason
                    let reason = queryError.reason || queryError.message;
                     if (queryError.data && typeof queryError.data === 'string' && queryError.data !== '0x') {
                         try { reason = ethers.toUtf8String(queryError.data); } catch {}
                     }
                     // Log common reverts at debug/info level, others at warn/error
                    if (reason.includes("BALANCE_NOT_ENOUGH") || reason.includes("TARGET_IS_ZERO") || reason.includes("SELL_QUOTE_RESULT_IS_ZERO") || reason.includes("DODO_SELL_AMOUNT_TOO_SMALL")) {
                        logger.debug(`${logPrefix} querySellQuote reverted (zero output expected): ${reason}`);
                         amountOut = 0n; // Explicitly set amountOut to 0 on these expected reverts
                         // Do NOT throw, return success: false with amountOut: 0n
                         return { success: false, amountOut: 0n, error: `DODO query zero output: ${reason}` };
                    } else {
                        logger.warn(`${logPrefix} querySellQuote reverted unexpectedly: ${reason}`);
                        throw queryError; // Re-throw unexpected errors
                    }
                }
            }

            // Final validation of output amount
            // This catch is for unexpected errors AFTER the query, or errors in setup
             if (amountOut < 0n) {
                 logger.warn(`${logPrefix} Simulation resulted in negative amountOut (${amountOut}). Setting to 0.`);
                 amountOut = 0n;
             }

             // If amountOut is still 0, treat as simulation failure for opportunity calculation
            if (amountOut === 0n) {
                 logger.debug(`${logPrefix} Simulation resulted in 0 amountOut.`);
                 // The specific revert reasons above already handle returning success: false.
                 // This check catches cases where query didn't revert but returned 0.
                 // Return success: true here as the query executed without unexpected error, but output was 0.
                 // The profit calculation logic will then correctly determine zero profit.
                 return { success: true, amountOut: 0n, error: null };
            }

            // Simulation successful, non-zero output
            logger.debug(`${logPrefix} DODO simulation successful.`);
            return { success: true, amountOut: amountOut, error: null };

        } catch(error) {
            // Catch errors from contract creation, validation, or re-thrown unexpected query errors
            const errMsg = error instanceof ArbitrageError ? error.message : `Unexpected DODO sim error: ${error.message}`;
            logger.error(`${logPrefix} DODO simulation failed: ${errMsg}`, error);
            return { success: false, amountOut: null, error: `DODO simulation failed: ${errMsg}` };
        }
    }
}

module.exports = SwapSimulator;