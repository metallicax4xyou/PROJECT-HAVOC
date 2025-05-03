// core/swapSimulator.js
// --- VERSION v1.4 --- Fixed require path for scannerUtils.

const { ethers } = require('ethers');
const logger = require('../utils/logger'); // Adjust path if needed
const { ABIS } = require('../constants/abis'); // Adjust path if needed
const { ArbitrageError } = require('../utils/errorHandler'); // Adjust path if needed
const { Token } = require('@uniswap/sdk-core');
const { TOKENS } = require('../constants/tokens');
// CORRECTED PATH: Changed from '../scannerUtils' to './scannerUtils'
const { getTickSpacingFromFeeBps } = require('./scannerUtils'); // Path ok relative to core/
const { getCanonicalPairKey } = require('../../utils/pairUtils'); // Correct path

const MAX_UINT128 = (1n << 128n) - 1n;

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
        // Access properties directly from poolState
        // REMOVED: const { dexType, address } = poolState;
        const logPrefix = `[SwapSim ${poolState?.dexType || 'N/A'} ${poolState?.address?.substring(0,6) || 'N/A'}]`; // Access dexType and address from poolState

        if (!poolState || !tokenIn || !amountIn || amountIn <= 0n) {
             logger.warn(`${logPrefix} Invalid args for simulateSwap`);
             return { success: false, amountOut: null, error: 'Invalid arguments' };
        }
        // Use token decimals from the token object passed in
        try {
             logger.debug(`${logPrefix} Sim Swap: ${ethers.formatUnits(amountIn, tokenIn.decimals)} ${tokenIn.symbol}`);
        } catch (formatError) {
            logger.debug(`${logPrefix} Sim Swap: (Cannot format amount) ${amountIn.toString()} ${tokenIn.symbol}`);
        }


        try {
            // Access dexType directly from the poolState object in the switch statement
            switch (poolState.dexType?.toLowerCase()) { // Use lowercase for safety
                case 'uniswapv3': return await this.simulateV3Swap(poolState, tokenIn, amountIn); // Pass poolState directly
                case 'sushiswap': return await this.simulateV2Swap(poolState, tokenIn, amountIn); // Pass poolState directly
                case 'dodo':      return await this.simulateDodoSwap(poolState, tokenIn, amountIn); // Pass poolState directly
                // Access dexType directly from poolState in the default case log
                default:          logger.warn(`${logPrefix} Unsupported dexType: ${poolState.dexType}`); return { success: false, amountOut: null, error: `Unsupported dex: ${poolState.dexType}` };
            }
        } catch (error) {
             // Access dexType directly from poolState in the error log
            logger.error(`${logPrefix} Unexpected error during simulation dispatch: ${error.message}`, error);
            return { success: false, amountOut: null, error: `Simulation dispatch error: ${error.message}` };
        }
     }

    // Uniswap V3 Simulation (Adjusted to use poolState properties directly)
    async simulateV3Swap(poolState, tokenIn, amountIn) {
        // Access properties directly from poolState
        const { fee, token0, token1, address, sqrtPriceX96, liquidity, tick } = poolState;
        const logPrefix = `[SwapSim V3 ${address?.substring(0,6)}]`;

        const tokenOut = tokenIn.address.toLowerCase() === token0.address.toLowerCase() ? token1 : token0;
        if (!tokenOut) {
             logger.warn(`${logPrefix} Cannot determine tokenOut from pair.`);
             return { success: false, amountOut: null, error: 'Cannot determine tokenOut' };
        }

        const sqrtPriceLimitX96 = 0n; // Used to set price bounds, 0 means no limit for quoteExactInputSingle

        // Basic validation for critical V3 state props
        if (sqrtPriceX96 === undefined || sqrtPriceX96 === null || liquidity === undefined || liquidity === null || tick === undefined || tick === null) {
             logger.warn(`${logPrefix} Missing critical V3 state properties for simulation.`);
             return { success: false, amountOut: null, error: 'Missing V3 state data' };
        }

        try {
             // Use the Quoter V2 contract instance from the constructor
            logger.debug(`${logPrefix} Quoting ${tokenIn.symbol}->${tokenOut.symbol} Fee ${fee} In ${amountIn.toString()} (raw)`);
            // Call the quoter contract using the correct function and parameters
            // Note: quoteExactInputSingle takes amountIn as the input token amount (in smallest units)
            const quoteResult = await this.quoterContract.quoteExactInputSingle.staticCall(
                 tokenIn.address, // address tokenIn
                 tokenOut.address, // address tokenOut
                 fee, // uint24 fee
                 amountIn, // uint256 amountIn (already in smallest units)
                 sqrtPriceLimitX96 // uint160 sqrtPriceLimitX96
            );

            // The result is an array, where the first element is the amountOut (uint256)
            const amountOut = BigInt(quoteResult[0]); // Amount out in smallest units of tokenOut

            logger.debug(`${logPrefix} Quoter Out: ${amountOut.toString()} (raw)`);
            if (amountOut <= 0n) {
                logger.debug(`${logPrefix} Quoter zero or negative output (${amountOut}).`); // Use debug for zero output
                return { success: false, amountOut: 0n, error: 'Quoter zero output' }; // Return 0n amountOut on zero output, but success: false
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
        // Access properties directly from poolState
        const { reserve0, reserve1, token0, token1, address } = poolState;
        const logPrefix = `[SwapSim V2 ${address?.substring(0,6)}]`;

        // Basic validation for critical V2 state props
        if (reserve0 === undefined || reserve0 === null || reserve1 === undefined || reserve1 === null) {
             logger.warn(`${logPrefix} Missing critical V2 state properties (reserves).`);
             return { success: false, amountOut: null, error: 'Missing V2 state data' };
        }

        const bigIntReserve0 = BigInt(reserve0);
        const bigIntReserve1 = BigInt(reserve1);

        if (bigIntReserve0 <= 0n || bigIntReserve1 <= 0n) {
             logger.debug(`${logPrefix} Skipping due to zero or negative reserves (R0: ${bigIntReserve0}, R1: ${bigIntReserve1}).`); // Use debug for zero reserves
             return { success: false, amountOut: 0n, error: 'Zero or negative reserves' }; // Return 0n amountOut, but success: false
        }


        let reserveIn, reserveOut;
        if (tokenIn.address.toLowerCase() === token0.address.toLowerCase()) {
            reserveIn = bigIntReserve0;
            reserveOut = bigIntReserve1;
        } else if (tokenIn.address.toLowerCase() === token1.address.toLowerCase()) {
            reserveIn = bigIntReserve1;
            reserveOut = bigIntReserve0;
        } else {
             logger.warn(`${logPrefix} tokenIn mismatch with pool tokens.`);
             return { success: false, amountOut: null, error: 'tokenIn mismatch' };
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
                 logger.debug(`${logPrefix} V2 calculation zero or negative output (${amountOut}).`); // Use debug for zero output
                 return { success: false, amountOut: 0n, error: 'V2 zero output' }; // Return 0n amountOut, but success: false
            }

            return { success: true, amountOut: amountOut, error: null };

        } catch (error) {
             // Catch errors from BigInt calculations
            logger.error(`${logPrefix} Unexpected V2 calculation error: ${error.message}`, error);
            return { success: false, amountOut: null, error: `V2 calc error: ${error.message}` };
        }
    }

     /**
     * Simulates a DODO swap using direct pool query for selling base,
     * and derived rate from fetcher results for selling quote.
     * Handles cases where DODO query functions might revert.
     * Adjusted to use poolState properties directly.
     */
     async simulateDodoSwap(poolState, tokenIn, amountIn) {
        // Access properties directly from poolState
        const { address, token0, token1, baseTokenSymbol, queryAmountOutWei, queryBaseToken, queryQuoteToken } = poolState;
        const logPrefix = `[SwapSim DODO ${address?.substring(0,6)}]`;

        if (!baseTokenSymbol) {
             logger.warn(`${logPrefix} Missing baseTokenSymbol in poolState.`);
             return { success: false, amountOut: null, error: 'Missing baseTokenSymbol' };
        }
        if (!token0 || !token1 || !token0.symbol || !token1.symbol || !token0.address || !token1.address) {
             logger.warn(`${logPrefix} Missing token objects in poolState.`);
             return { success: false, amountOut: null, error: 'Missing token objects' };
        }
        if (amountIn === undefined || amountIn === null || amountIn <= 0n) {
             logger.warn(`${logPrefix} Invalid amountIn for simulation: ${amountIn}`);
             return { success: false, amountOut: null, error: 'Invalid amountIn' };
        }


        let amountOut = 0n; // Initialize amountOut

        try {
            // Look up base token object from config using the symbol from poolState
            const baseToken = this.config.TOKENS[baseTokenSymbol];
            if (!baseToken || !baseToken.address || baseToken.decimals === undefined || baseToken.decimals === null) {
                const errorMsg = `Base token symbol '${baseTokenSymbol}' not found or invalid in config.TOKENS.`;
                logger.error(`${logPrefix} ${errorMsg}`);
                throw new ArbitrageError('DodoSimError', errorMsg);
            }

            // Determine if the input token is the base token
            const isSellingBase = tokenIn.address.toLowerCase() === baseToken.address.toLowerCase();

            if (isSellingBase) {
                // --- Selling BASE token ---
                logger.debug(`${logPrefix} Simulating sell BASE: ${ethers.formatUnits(amountIn, tokenIn.decimals)} ${tokenIn.symbol} (raw ${amountIn.toString()})`);
                const poolContract = this._getDodoPoolContract(address); // Get contract instance

                // Basic check if the function exists before calling
                if (typeof poolContract.querySellBaseToken !== 'function') {
                    const errorMsg = "querySellBaseToken function not found in DODO ABI for this contract.";
                    logger.error(`${logPrefix} ${errorMsg}`);
                    throw new ArbitrageError('DodoSimError', errorMsg);
                }

                try {
                    // Use staticCall for simulation
                    amountOut = BigInt(await poolContract.querySellBaseToken.staticCall(amountIn));
                    logger.debug(`${logPrefix} DODO querySellBaseToken Result: ${amountOut.toString()} (raw)`);
                } catch (queryError) {
                     // Attempt to decode revert reason
                     let reason = queryError.reason || queryError.message;
                     if (queryError.data && typeof queryError.data === 'string' && queryError.data !== '0x') {
                         try { reason = ethers.toUtf8String(queryError.data); } catch {}} // Use ethers.toUtf8String
                     logger.warn(`${logPrefix} querySellBaseToken reverted: ${reason}`);

                     // Handle common reverts indicating zero output explicitly
                     if (reason.includes("BALANCE_NOT_ENOUGH") || reason.includes("TARGET_IS_ZERO") || reason.includes("SELL_BASE_RESULT_IS_ZERO")) { // Added SELL_BASE_RESULT_IS_ZERO
                         amountOut = 0n;
                         logger.debug(`${logPrefix} Query failed due to balance/target/zero result, output=0.`);
                         return { success: false, amountOut: 0n, error: `DODO query zero output: ${reason}` }; // Indicate failure but return 0n amountOut
                     } else {
                         throw queryError; // Re-throw unexpected errors
                     }
                }
            } else {
                // --- Selling QUOTE token ---
                const quoteToken = tokenIn; // Input token is the quote token
                logger.debug(`${logPrefix} Simulating sell QUOTE (using derived rate): ${ethers.formatUnits(amountIn, tokenIn.decimals)} ${tokenIn.symbol} (raw ${amountIn.toString()})`);

                // Retrieve the query results stored by the fetcher in poolState
                // The fetcher is expected to store the result of selling 1 unit of BASE token.
                const rateQuoteWeiPerBaseStandard = queryAmountOutWei; // Amount of Quote (smallest units) per 1 Standard Base Unit
                const rateInfo_BaseToken = queryBaseToken; // Base token object used for the stored rate
                const rateInfo_QuoteToken = queryQuoteToken; // Quote token object used for the stored rate

                // Validate the stored rate info
                if (rateQuoteWeiPerBaseStandard === undefined || rateQuoteWeiPerBaseStandard === null ||
                    !rateInfo_BaseToken?.decimals || !rateInfo_QuoteToken?.decimals) {
                    const errorMsg = "Missing DODO rate info from fetcher in poolState.";
                     logger.error(`${logPrefix} ${errorMsg}`);
                    throw new ArbitrageError('DodoSimError', errorMsg);
                }

                 const bigIntRateQuotePerBase = BigInt(rateQuoteWeiPerBaseStandard);
                 const baseDecimals = BigInt(rateInfo_BaseToken.decimals); // Use decimals from stored rate info
                 const quoteDecimals = BigInt(rateInfo_QuoteToken.decimals); // Use decimals from stored rate info

                 // Price Quote / Base Standard = (Amount Quote smallest / 10^decimalsQuote) / (Amount Base smallest / 10^decimalsBase)
                 // Price Quote / Base Standard = (rateQuoteWeiPerBaseStandard / 10^decimalsQuote) / ( (1 * 10^decimalsBase) / 10^decimalsBase) --- No, rateQuoteWeiPerBaseStandard is amount of quote for 1 standard base unit.
                 // Price Quote / Base Standard = rateQuoteWeiPerBaseStandard / (10n ** decimalsQuote) --- This is the standard price of Quote per Base.

                 // We have AmountIn (Quote) in smallest units. We want AmountOut (Base) in smallest units.
                 // AmountOutBaseStandard = AmountInQuoteStandard / Price(Quote/Base Standard)
                 // AmountOutBaseStandard = (AmountInQuoteWei / 10^decimalsQuote) / (rateQuoteWeiPerBaseStandard / 10^decimalsQuote)
                 // AmountOutBaseStandard = AmountInQuoteWei / rateQuoteWeiPerBaseStandard

                 // AmountOutBaseWei = AmountOutBaseStandard * 10^decimalsBase
                 // AmountOutBaseWei = (AmountInQuoteWei / rateQuoteWeiPerBaseStandard) * 10^decimalsBase
                 // Integer arithmetic: (AmountInQuoteWei * 10^decimalsBase) / rateQuoteWeiPerBaseStandard

                 if (bigIntRateQuotePerBase <= 0n) {
                      logger.debug(`${logPrefix} DODO derived rate is zero or negative (${bigIntRateQuotePerBase}). Output=0.`); // Use debug
                      amountOut = 0n; // Cannot get anything if rate is zero/negative
                 } else {
                     const numerator = amountIn * (10n ** baseDecimals); // amountIn is quote wei
                     const denominator = bigIntRateQuotePerBase; // rate is quote wei per standard base unit
                     amountOut = numerator / denominator; // Result is in Base Token Wei
                 }
                 logger.debug(`${logPrefix} DODO Derived Rate Sim Out: ${amountOut.toString()} (Base Token Wei)`);
            }

            // Final validation of output amount
            if (amountOut < 0n) {
                 logger.warn(`${logPrefix} Simulation resulted in negative amountOut (${amountOut}). Setting to 0.`);
                 amountOut = 0n;
             }

            // If amountOut is still 0, treat as simulation failure for opportunity calculation
            if (amountOut === 0n) {
                 logger.debug(`${logPrefix} Simulation resulted in 0 amountOut.`); // Debug for zero output
                 return { success: false, amountOut: 0n, error: 'Simulation resulted in zero output' };
            }


            return { success: true, amountOut: amountOut, error: null };

        } catch(error) {
            // Catch errors from validation, contract creation, or unexpected calculation errors
            const errMsg = error instanceof ArbitrageError ? error.message : `Unexpected DODO sim error: ${error.message}`;
            logger.error(`${logPrefix} DODO simulation failed: ${errMsg}`, error); // Log at error level for caught exceptions
            return { success: false, amountOut: null, error: `DODO simulation failed: ${errMsg}` };
        }
    }
}

module.exports = SwapSimulator;
@metallicax4xyou ➜ /workspaces/arbitrum-f
trum-flash (main) $ 