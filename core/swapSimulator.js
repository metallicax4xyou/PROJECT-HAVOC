// core/swapSimulator.js
// --- VERSION v1.10 --- Corrected UniV3 simulation staticCall to pass struct parameters as a single object.

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
        // Add version log here to confirm the correct file is loaded
        logger.debug('[SwapSimulator v1.10] Initializing...');
        if (!config?.QUOTER_ADDRESS || !ethers.isAddress(config.QUOTER_ADDRESS)) throw new ArbitrageError('SwapSimulatorInit', 'Valid QUOTER_ADDRESS missing.');
        if (!provider) throw new ArbitrageError('SwapSimulatorInit', 'Provider instance required.');
        // Check for required ABIs. Log errors/warnings if missing.
        if (!ABIS?.IQuoterV2) {
             logger.error("[SwapSimulatorInit] IQuoterV2 ABI missing. UniV3 simulations will fail.");
             // Throw only if UniV3 is enabled but Quoter ABI is missing
             if (config.UNISWAP_V3_ENABLED) throw new ArbitrageError('SwapSimulatorInit', "IQuoterV2 ABI critically missing for UniV3 simulation.");
        }
        if (!ABIS?.DODOV1V2Pool) {
             logger.warn("[SwapSimulatorInit] DODOV1V2Pool ABI missing. DODO simulations will fail.");
        }
         // Optional ABIs
         if (!ABIS?.ERC20) {
             logger.warn("[SwapSimulatorInit] ERC20 ABI missing. Some token operations may fail.");
         }


        this.config = config;
        this.provider = provider;
        // Initialize quoter contract only if ABI is available
        this.quoterContract = ABIS?.IQuoterV2 ? new ethers.Contract(config.QUOTER_ADDRESS, ABIS.IQuoterV2, this.provider) : null;
        this.dodoPoolContractCache = {};

        // Updated info log to include version
        logger.info(`[SwapSimulator v1.10] Initialized with Quoter V2 at ${config.QUOTER_ADDRESS || 'N/A'}`);
        if (ABIS?.DODOV1V2Pool) {
             logger.info(`[SwapSimulator v1.10] DODO V1/V2 Pool ABI loaded.`);
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
                // Do not throw here, allow fetcher/simulator to handle null contract gracefully
                this.dodoPoolContractCache[lowerCaseAddress] = null; // Cache as null to avoid retrying failed creation
                 return null;
            }
        }
        return this.dodoPoolContractCache[lowerCaseAddress];
    }

    // Main simulation dispatcher
    async simulateSwap(poolState, tokenIn, amountIn) {
        const logPrefix = `[SwapSim ${poolState?.dexType || 'N/A'} ${poolState?.address?.substring(0,6) || 'N/A'}]`;

        // Validate essential poolState properties needed for all simulations
         if (!poolState || poolState.dexType === undefined || !poolState.address || !poolState.token0 || !poolState.token1 || !poolState.token0.address || !poolState.token1.address || poolState.token0.decimals === undefined || poolState.token1.decimals === undefined) {
             logger.warn(`${logPrefix} Invalid basic poolState for simulateSwap.`);
             return { success: false, amountOut: null, error: 'Invalid basic poolState' };
         }


        if (!tokenIn || !amountIn || amountIn <= 0n) {
             logger.warn(`${logPrefix} Invalid tokenIn or amountIn for simulateSwap: tokenIn=${!!tokenIn}, amountIn=${amountIn?.toString()}`);
             return { success: false, amountOut: null, error: 'Invalid tokenIn or amountIn' };
        }
        try {
             logger.debug(`${logPrefix} Sim Swap: ${ethers.formatUnits(amountIn, tokenIn.decimals)} ${tokenIn.symbol} (raw ${amountIn.toString()})`);
        } catch (formatError) {
            logger.debug(`${logPrefix} Sim Swap: (Cannot format amount) ${amountIn.toString()} ${tokenIn?.symbol || '?'}`);
        }

        try {
            // Use lowercase for safety
            switch (poolState.dexType?.toLowerCase()) {
                case 'uniswapv3':
                     if (!this.quoterContract) {
                         logger.warn(`${logPrefix} Quoter contract not initialized. Skipping UniV3 simulation.`);
                         return { success: false, amountOut: null, error: 'Quoter contract not initialized' };
                     }
                     return await this.simulateV3Swap(poolState, tokenIn, amountIn);

                case 'sushiswap':
                     return await this.simulateV2Swap(poolState, tokenIn, amountIn);

                case 'dodo':
                     const dodoPoolContract = this._getDodoPoolContract(poolState.address);
                     if (!dodoPoolContract) {
                         logger.warn(`${logPrefix} DODO pool contract not initialized. Skipping DODO simulation.`);
                         return { success: false, amountOut: null, error: 'DODO pool contract not initialized' };
                     }
                     // NOTE: simulateDodoSwap currently relies on querySellBase/querySellQuote
                     // It does NOT use the PMMState fetched by the fetcher yet.
                     // This needs to be updated to use PMMState math for proper simulation.
                     return await this.simulateDodoSwap(poolState, tokenIn, amountIn, dodoPoolContract); // Pass the contract instance

                default:
                    logger.warn(`${logPrefix} Unsupported dexType: ${poolState.dexType}`);
                    return { success: false, amountOut: null, error: `Unsupported dex: ${poolState.dexType}` };
            }
        } catch (error) {
            // Catch unexpected errors during simulation dispatch
            const errMsg = error instanceof ArbitrageError ? error.message : `Unexpected error during simulation dispatch: ${error.message}`;
            logger.error(`${logPrefix} Simulation dispatch failed: ${errMsg}`, error);
            return { success: false, amountOut: null, error: `Simulation dispatch failed: ${errMsg}` };
        }
     }

    // Uniswap V3 Simulation (Corrected staticCall argument structure)
    async simulateV3Swap(poolState, tokenIn, amountIn) {
        // Destructure required properties from poolState. Assume these are populated by the fetcher and passed correctly by the finder.
        // NOTE: The Quoter call itself doesn't strictly *need* sqrtPriceX96, liquidity, tick from the poolState.
        // It performs its own state lookup via the RPC it's connected to.
        // We pass the fee which is from the PoolConfig, confirmed via fetcher.
        const { fee, token0, token1, address } = poolState; // Removed sqrtPriceX96, liquidity, tick from direct destructure
        const logPrefix = `[SwapSim V3 ${address?.substring(0,6)}]`;

        const tokenOut = tokenIn.address.toLowerCase() === token0.address.toLowerCase() ? token1 : token0;
        if (!tokenOut) {
             logger.warn(`${logPrefix} Cannot determine tokenOut from pair.`);
             return { success: false, amountOut: null, error: 'Cannot determine tokenOut' };
        }

        // Define the parameters for quoteExactInputSingle
        // The Quoter V2 ABI's quoteExactInputSingle takes a struct/tuple: QuoteExactInputSingleParams
        const params = {
             tokenIn: tokenIn.address,
             tokenOut: tokenOut.address,
             fee: Number(fee), // uint24 fee - Needs to be a number for the ABI encoding
             amountIn: amountIn, // uint256 amountIn (already in smallest units BigInt)
             // Use 0n for sqrtPriceLimitX96 to indicate no limit, or a calculated limit based on desired slippage
             // For simulation purposes, often no limit is needed to see max possible output
             sqrtPriceLimitX96: 0n // uint160 (BigInt)
        };

        // Basic validation for fee value range
         if (typeof params.fee !== 'number' || !Number.isInteger(params.fee) || params.fee < 0 || params.fee > 10000) { // Check fee is reasonable BPS (0-10000)
             // Adjusted check based on uint24 range, but BPS are the expected values from config.
             logger.warn(`${logPrefix} Invalid fee value for Quoter: ${params.fee}. Expected integer BPS 0-10000.`);
             // Keep the validation as it was, expecting standard BPS
             if (params.fee < 0 || params.fee > 10000) {
                  return { success: false, amountOut: null, error: `Invalid fee value for Quoter: ${params.fee}` };
             }
         }

         // Optional: Log V3 state if present (for debugging the state flow)
         // const { sqrtPriceX96, liquidity, tick } = poolState;
         // if (sqrtPriceX96 !== undefined && sqrtPriceX96 !== null && liquidity !== undefined && liquidity !== null && tick !== undefined && tick !== null) {
         //      logger.debug(`${logPrefix} DEBUG: V3 state passed (sqrtPriceX96: ${sqrtPriceX96}, liquidity: ${liquidity}, tick: ${tick}).`);
         // } else {
         //     logger.debug(`${logPrefix} DEBUG: V3 state seems missing in poolState passed to simulator.`);
         // }


        try {
            // Use the Quoter V2 contract instance from the constructor (already checked for null)
            logger.debug(`${logPrefix} Quoting ${tokenIn.symbol}->${tokenOut.symbol} Fee ${params.fee} In ${amountIn.toString()} (raw)`);
            // Call the quoter contract using the correct function and parameters AS A SINGLE OBJECT ARGUMENT
            // quoteExactInputSingle returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)
            const quoteResult = await this.quoterContract.quoteExactInputSingle.staticCall(
                // Pass the entire params object as the single argument
                params
            );

            // The result is an array, where the first element is the amountOut (uint256)
            const amountOut = BigInt(quoteResult[0]); // Amount out in smallest units of tokenOut
            // Note: quoteResult[1] is sqrtPriceX96After, quoteResult[2] is initializedTicksCrossed, quoteResult[3] is gasEstimate

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
            // Use error.data here
            if (error.data && typeof error.data === 'string' && error.data !== '0x') {
                 try { reason = ethers.toUtf8String(error.data); } catch {} // Use ethers.toUtf8String
            }
            // Log Quoter failures at WARN level as they indicate a simulation failure
            logger.warn(`${logPrefix} Quoter fail: ${reason}`);
            return { success: false, amountOut: null, error: `Quoter fail: ${reason}` };
        }
    }

    // Uniswap V2 / SushiSwap Simulation (Uses poolState reserves directly)
    async simulateV2Swap(poolState, tokenIn, amountIn) {
        // Destructure required properties from poolState
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

            logger.debug(`${logPrefix} V2 Sim Out: ${amountOut.toString()} (raw)`);
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
     * @param {object} poolState - The pool state object.
     * @param {object} tokenIn - The Token object for the input token.
     * @param {bigint} amountIn - The amount of input token (in smallest units, BigInt).
     * @param {ethers.Contract} poolContract - The initialized DODO pool contract instance.
     * @returns {Promise<{success: boolean, amountOut: bigint|null, error: string|null}>} Simulation result.
     */
     async simulateDodoSwap(poolState, tokenIn, amountIn, poolContract) {
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
         // Check if poolContract instance is valid (should be guaranteed by simulateSwap dispatcher now)
         if (!poolContract || typeof poolContract.getAddress !== 'function') {
              const errMsg = 'DODO poolContract instance is not valid or missing.';
              logger.error(`${logPrefix} ${errMsg}`);
              return { success: false, amountOut: null, error: errMsg };
         }
        if (amountIn === undefined || amountIn === null || amountIn <= 0n) {
             logger.warn(`${logPrefix} Invalid amountIn for DODO simulation: ${amountIn}`);
             return { success: false, amountOut: null, error: 'Invalid amountIn' };
        }

        try {
            // Determine if the input token is the base token
            // Use token addresses for robustness, comparing against the baseToken's address from config
            // This assumes the fetcher correctly looked up baseToken based on baseTokenSymbol
            const baseToken = this.config.TOKENS[baseTokenSymbol];
             if (!baseToken || !baseToken.address) {
                 const errorMsg = `Base token symbol '${baseTokenSymbol}' not found or invalid in config.TOKENS.`;
                 logger.error(`${logPrefix} ${errorMsg}`);
                 // Note: This is an initialization/config error, maybe should be caught earlier.
                 // Throwing an ArbitrageError here might be appropriate if this should never happen with valid config.
                 // For now, returning failure.
                 return { success: false, amountOut: null, error: errorMsg };
             }
            const isSellingBase = tokenIn.address.toLowerCase() === baseToken.address.toLowerCase();

            let amountOut = 0n;
            let queryResult;

            if (isSellingBase) {
                // --- Simulating Selling BASE token ---
                logger.debug(`${logPrefix} Simulating sell BASE: ${ethers.formatUnits(amountIn, tokenIn.decimals)} ${tokenIn.symbol}`);

                // Call the pool's querySellBase view function
                 // querySellBase returns (uint receiveQuoteAmount, uint mtFee)
                 // Check for function existence based on the loaded ABI
                 if (typeof poolContract.querySellBase !== 'function') {
                     const errorMsg = "querySellBase function not found in DODO ABI for this contract.";
                     logger.error(`${logPrefix} ${errorMsg}`);
                      // This indicates an ABI mismatch or an attempt to simulate on a non-standard DODO contract
                     return { success: false, amountOut: null, error: errorMsg };
                 }
                try {
                     // querySellBase(address trader, uint256 payBaseAmount)
                     // Use ethers.ZeroAddress as the trader for simulation
                     // Based on previous docs, it seems to expect arguments as separate inputs.
                     queryResult = await poolContract.querySellBase.staticCall(ethers.ZeroAddress, amountIn);
                     amountOut = BigInt(queryResult[0]); // The first element is receiveQuoteAmount
                     // Note: queryResult[1] is mtFee, might need later for detailed analysis, but standard simulation doesn't use it directly.

                    logger.debug(`${logPrefix} DODO querySellBase Sim Out: ${amountOut.toString()} (raw)`);
                } catch (queryError) {
                    // Attempt to decode revert reason
                    let reason = queryError.reason || queryError.message;
                    // Use queryError.data here
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
                        // Log unexpected reverts as errors
                        logger.error(`${logPrefix} querySellBase reverted unexpectedly: ${reason}`);
                        // Re-throw the error to be caught by the main simulateSwap catch block
                        throw new ArbitrageError('DodoSimError', `QuerySellBase unexpected revert: ${reason}`, queryError);
                    }
                }

            } else {
                // --- Simulating Selling QUOTE token ---
                logger.debug(`${logPrefix} Simulating sell QUOTE: ${ethers.formatUnits(amountIn, tokenIn.decimals)} ${tokenIn.symbol}`);

                // Call the pool's querySellQuote view function
                // querySellQuote returns (uint receiveBaseAmount, uint mtFee)
                // Check for function existence based on the loaded ABI
                if (typeof poolContract.querySellQuote !== 'function') {
                    const errorMsg = "querySellQuote function not found in DODO ABI for this contract.";
                     logger.error(`${logPrefix} ${errorMsg}`);
                    return { success: false, amountOut: null, error: errorMsg };
                }
                try {
                    // querySellQuote(address trader, uint256 payQuoteAmount)
                    // Use ethers.ZeroAddress as the trader for simulation
                    // For now, keeping as separate arguments:
                    queryResult = await poolContract.querySellQuote.staticCall(ethers.ZeroAddress, amountIn);
                    amountOut = BigInt(queryResult[0]); // The first element is receiveBaseAmount
                    // Note: queryResult[1] is mtFee

                    logger.debug(`${logPrefix} DODO querySellQuote Sim Out: ${amountOut.toString()} (raw)`);
                } catch (queryError) {
                    // Attempt to decode revert reason
                    let reason = queryError.reason || queryError.message;
                     // Use queryError.data here
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
                        // Log unexpected reverts as errors
                        logger.error(`${logPrefix} querySellQuote reverted unexpectedly: ${reason}`);
                        // Re-throw the error to be caught by the main simulateSwap catch block
                        throw new ArbitrageError('DodoSimError', `QuerySellQuote unexpected revert: ${reason}`, queryError);
                    }
                }
            }

            // Final validation of output amount
            // This catch is for unexpected errors AFTER the query, or errors in setup
             // Note: query functions usually return 0 on fail rather than negative
             if (amountOut < 0n) { // Should not happen with properly returning view functions
                 logger.warn(`${logPrefix} Simulation resulted in negative amountOut (${amountOut}). Setting to 0.`);
                 amountOut = 0n;
             }

             // If amountOut is still 0, and we didn't return success: false above for common reverts,
             // treat it as a simulation failure for opportunity calculation.
            if (amountOut === 0n) {
                 logger.debug(`${logPrefix} Simulation resulted in 0 amountOut.`);
                 // If we reached here, it means the query executed without unexpected error, but the result was 0.
                 // This could happen if liquidity is effectively zero for that amount, or the price is infinite.
                 // We return success: true because the query executed without unexpected error, but the result was 0.
                 // The profit calculation logic will then correctly determine zero profit.
                 return { success: true, amountOut: 0n, error: null };
            }

            // Simulation successful, non-zero output
            logger.debug(`${logPrefix} DODO simulation successful.`);
            return { success: true, amountOut: amountOut, error: null };

        } catch(error) {
            // Catch errors from contract creation (now handled in _getDodoPoolContract),
            // config validation, or re-thrown unexpected query errors.
            const errMsg = error instanceof ArbitrageError ? error.message : `Unexpected DODO sim error: ${error.message}`;
            logger.error(`${logPrefix} DODO simulation failed: ${errMsg}`, error);
            return { success: false, amountOut: null, error: `DODO simulation failed: ${errMsg}` };
        }
    }
}

module.exports = SwapSimulator;