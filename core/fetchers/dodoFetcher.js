// core/fetchers/dodoFetcher.js
const { ethers } = require('ethers');
const logger = require('../../utils/logger'); // Adjust path
const { ArbitrageError } = require('../../utils/errorHandler'); // Adjust path
const { TOKENS } = require('../../constants/tokens'); // Adjust path
const { getCanonicalPairKey } = require('../../utils/pairUtils'); // Adjust path
const { ABIS } = require('../../constants/abis'); // Adjust path

// Assuming IDODOV2 interface includes functions like _I_, _K_, etc., based on Arbiscan ABI

class DodoFetcher {
    constructor(config) {
        if (!config?.PRIMARY_RPC_URL) throw new ArbitrageError('DodoFetcher requires config with PRIMARY_RPC_URL.', 'INIT_ERR');
        this.provider = config.provider || new ethers.JsonRpcProvider(config.PRIMARY_RPC_URL);
        this.config = config;
        this.poolContractCache = {};
        // Ensure the correct DODO ABI is loaded
        if (!ABIS?.DODOV1V2Pool) {
             // This warning should now ideally NOT appear if ABI loaded successfully in constants/abis.js
             logger.error("[DodoFetcherInit] DODOV1V2Pool ABI is critically missing after boot. Cannot initialize fetcher.");
             throw new ArbitrageError('DodoFetcherInit', "DODOV1V2Pool ABI not loaded during initialization.");
        }
        this.poolAbi = ABIS.DODOV1V2Pool;
        logger.debug(`[DodoFetcher] Initialized. DODO ABI status: ${this.poolAbi ? 'Loaded' : 'Missing'}`);
    }

    _getPoolContract(poolAddress) {
        const lowerCaseAddress = poolAddress.toLowerCase();
        if (!this.poolContractCache[lowerCaseAddress]) {
            try {
                 // This check should ideally not fail now if the constructor passed
                 if (!this.poolAbi) throw new Error("DODOV1V2Pool ABI not loaded.");
                 this.poolContractCache[lowerCaseAddress] = new ethers.Contract(poolAddress, this.poolAbi, this.provider);
                 logger.debug(`[DodoFetcher] Created contract instance for ${poolAddress}`);
            } catch (error) {
                 // Log the error and re-throw with a specific message
                 logger.error(`[DodoFetcher] Error creating DODO contract instance for ${poolAddress}: ${error.message}`, error);
                 throw new ArbitrageError('DodoFetcherError', `Failed to create contract instance for ${poolAddress}: ${error.message}`);
            }
        }
        return this.poolContractCache[lowerCaseAddress];
    }

    /**
     * Fetches essential state for DODO pools, including PMM state components.
     * Also performs a 1-unit query for basic price info (may be deprecated later).
     * Includes baseTokenSymbol, individual PMM state components, and query results in the returned poolData.
     */
    async fetchPoolData(address, pair) { // pair is [tokenObjectA, tokenObjectB]
        const logPrefix = `[DodoFetcher Pool ${address.substring(0,6)}]`;
        const poolInfo = this.config.POOL_CONFIGS?.find(p => p.address.toLowerCase() === address.toLowerCase());

        if (!poolInfo?.baseTokenSymbol) {
             logger.warn(`${logPrefix} Pool info or baseTokenSymbol missing in config for ${address}.`);
             return { success: false, poolData: null, error: 'Pool info or baseTokenSymbol missing' };
        }
        const { fee, baseTokenSymbol, groupName } = poolInfo;
        const [token0, token1] = pair;
        const poolDesc = groupName || `${token0?.symbol || '?'}/${token1?.symbol || '?'}_DODO`;

        logger.debug(`${logPrefix} Starting fetch (${poolDesc})`);

        try {
            if (!token0 || !token1 || !token0.address || !token1.address || token0.decimals === undefined || token0.decimals === null || token1.decimals === undefined || token1.decimals === null) {
                 throw new ArbitrageError('DodoFetcherError', `Invalid token objects received for pool ${address}.`);
            }

            const poolContract = this._getPoolContract(address); // Get or create contract instance

            // Look up base token object from config using the symbol from poolInfo
            const baseToken = this.config.TOKENS[baseTokenSymbol];
            if (!baseToken || !baseToken.address || baseToken.decimals === undefined || baseToken.decimals === null) {
                 const errorMsg = `Base token symbol '${baseTokenSymbol}' not found or invalid in config.TOKENS.`;
                 logger.error(`${logPrefix} ${errorMsg}`);
                 throw new ArbitrageError('DodoFetcherError', errorMsg);
            }

            const quoteToken = (token0.address.toLowerCase() === baseToken.address.toLowerCase()) ? token1 : token0;
            if (quoteToken.address.toLowerCase() === baseToken.address.toLowerCase()) {
                 throw new ArbitrageError('DodoFetcherError', `Base and Quote tokens are the same for pool ${address}.`);
            }
             logger.debug(`${logPrefix} Configured Base: ${baseToken.symbol}, Quote: ${quoteToken.symbol}.`);


            // --- Fetch Individual PMM State Components (Replacing getPMMState) ---
            let pmmState = null;
            try {
                 logger.debug(`${logPrefix} Attempting to fetch individual PMM state components...`);
                 // Call individual view functions present in the ABI
                 // Check for existence before calling
                 if (typeof poolContract._I_ !== 'function') throw new Error("ABI missing _I_ function.");
                 if (typeof poolContract._K_ !== 'function') throw new Error("ABI missing _K_ function.");
                 if (typeof poolContract._BASE_BALANCE_ !== 'function') throw new Error("ABI missing _BASE_BALANCE_ function.");
                 if (typeof poolContract._QUOTE_BALANCE_ !== 'function') throw new Error("ABI missing _QUOTE_BALANCE_ function.");
                 if (typeof poolContract._TARGET_BASE_TOKEN_AMOUNT_ !== 'function') throw new Error("ABI missing _TARGET_BASE_TOKEN_AMOUNT_ function.");
                 if (typeof poolContract._TARGET_QUOTE_TOKEN_AMOUNT_ !== 'function') throw new Error("ABI missing _TARGET_QUOTE_TOKEN_AMOUNT_ function.");
                 if (typeof poolContract._R_STATUS_ !== 'function') throw new Error("ABI missing _R_STATUS_ function.");


                 const [i, K, B, Q, B0, Q0, R] = await Promise.all([
                     poolContract._I_.staticCall(), // Oracle price
                     poolContract._K_.staticCall(), // Slippage coefficient
                     poolContract._BASE_BALANCE_.staticCall(), // Current base token reserve (wei)
                     poolContract._QUOTE_BALANCE_.staticCall(), // Current quote token reserve (wei)
                     poolContract._TARGET_BASE_TOKEN_AMOUNT_.staticCall(), // Target base token reserve (wei)
                     poolContract._TARGET_QUOTE_TOKEN_AMOUNT_.staticCall(), // Target quote token reserve (wei)
                     poolContract._R_STATUS_.staticCall(), // Reserve status (enum)
                 ]);

                 pmmState = { i, K, B, Q, B0, Q0, R }; // Reconstruct the state object
                 logger.debug(`${logPrefix} Successfully fetched PMM State components.`);
                 // logger.debug(`${logPrefix} PMM State: ${JSON.stringify(pmmState)}`); // Use with caution, can be verbose

            } catch (stateError) {
                 let reason = stateError.reason || stateError.message; if (stateError.data && typeof stateError.data === 'string' && stateError.data !== '0x') { try { reason = ethers.toUtf8String(stateError.data); } catch {} }
                 logger.warn(`${logPrefix} Failed to fetch PMM State components: ${reason}`);
                 // If PMM state fetch fails, we cannot accurately simulate.
                 // Return null poolData to indicate unusable state.
                 return { success: false, poolData: null, error: `Failed to fetch PMM state components: ${reason}` };
            }


            // --- Perform 1-unit Query (for basic price check, may be deprecated) ---
            // This also serves as a check that querySellBase exists and works
            const amountIn_1_Unit = ethers.parseUnits('1', baseToken.decimals);
            let queryAmountOutWei = 0n; // Initialize to 0n
             let mtFee_1_Unit_Query = 0n;

            try {
                 logger.debug(`${logPrefix} Performing 1-unit query: Sell 1 ${baseToken.symbol}`);
                 // Check if querySellBase function exists in the loaded ABI
                 if (typeof poolContract.querySellBase !== 'function') {
                     const errorMsg = "querySellBase function not found in loaded DODO ABI.";
                     logger.warn(`${logPrefix} ${errorMsg}`);
                     // Allow fetch to continue, but queryAmountOutWei will remain 0n.
                 } else {
                      // querySellBase returns (uint receiveQuoteAmount, uint mtFee)
                      logger.debug(`${logPrefix} Querying poolContract.querySellBase.staticCall(ethers.ZeroAddress, ${amountIn_1_Unit.toString()})`);
                      // --- DEBUGGING HELP ---
                      // Check the property type just before calling staticCall
                      logger.debug(`${logPrefix} Type of poolContract.querySellBase: ${typeof poolContract.querySellBase}`);
                      // --- END DEBUGGING HELP ---

                     const queryResult = await poolContract.querySellBase.staticCall(ethers.ZeroAddress, amountIn_1_Unit);
                     queryAmountOutWei = BigInt(queryResult[0]); // The first element is receiveQuoteAmount
                     mtFee_1_Unit_Query = BigInt(queryResult[1]); // The second element is mtFee
                     logger.debug(`${logPrefix} pool.querySellBase(1 ${baseToken.symbol}) Result: ${queryAmountOutWei.toString()} ${quoteToken.symbol} wei (MT Fee: ${mtFee_1_Unit_Query.toString()})`);
                 }
             } catch (queryError) {
                 let reason = queryError.reason || queryError.message; if (queryError.data && typeof queryError.data === 'string' && queryError.data !== '0x') { try { reason = ethers.toUtf8String(queryError.data); } catch {} }
                 // Log common reverts at debug level, others at warn
                 if (reason.includes("BALANCE_NOT_ENOUGH") || reason.includes("TARGET_IS_ZERO") || reason.includes("SELL_BASE_RESULT_IS_ZERO") || reason.includes("DODO_SELL_AMOUNT_TOO_SMALL")) {
                      logger.debug(`${logPrefix} pool.querySellBase(1 unit) reverted (zero output expected): ${reason}`);
                      queryAmountOutWei = 0n; // Explicitly set amountOutWei to 0 on these expected reverts
                 } else {
                      logger.warn(`${logPrefix} pool.querySellBase(1 unit) failed unexpectedly: ${reason}`);
                       // queryAmountOutWei remains 0n
                 }
             }


            // TODO: Add logic to fetch dynamic total fee rate (lpFeeRate + mtFeeRate) in BPS
            // The 'fee' field in poolData currently comes from the config, which is static.
            // Accurate profit calculation for arbitrary amounts requires dynamic fees.
            // This likely requires checking the ABI for functions like getUserFeeRate or getPairDetail,
            // or combining _LP_FEE_RATE_ and _MT_FEE_RATE_ (fetched above) and converting to BPS.
            // Deferring this for now to focus on getting PMM state simulation working.
            // For now, calculate a simple total fee from fetched rates for calculateEffectivePrices
            let totalFeeRate = 0; // Placeholder, needs conversion to BPS
            try {
                // Assuming _LP_FEE_RATE_ and _MT_FEE_RATE_ are values like 1000000000000000000 for 1e18
                // If fee is 0.3%, rate is 0.003 * 1e18. Total fee is (lpFee + mtFee)
                // Convert to BPS: (rate / 1e18) * 10000
                 const lpFee = BigInt(pmmState.i) > 0n ? BigInt(pmmState.i) : 0n; // Oracle price might be used for fee calc base? Need to re-check DODO docs.
                 const mtFee = BigInt(pmmState.K) > 0n ? BigInt(pmmState.K) : 0n; // Slippage K might be used for fee rate? This mapping is likely wrong.

                 // Let's try fetching _LP_FEE_RATE_ and _MT_FEE_RATE_ directly if they exist and are different
                 let lpFeeRate = 0n;
                 let mtFeeRate = 0n;
                 if (typeof poolContract._LP_FEE_RATE_ === 'function' && typeof poolContract._MT_FEE_RATE_ === 'function') {
                     [lpFeeRate, mtFeeRate] = await Promise.all([
                         poolContract._LP_FEE_RATE_.staticCall(),
                         poolContract._MT_FEE_RATE_.staticCall()
                     ]);
                     // Assuming rates are scaled by 1e18 (common)
                     // Convert to BPS: (rate / 1e18) * 10000
                     const totalFeeRateWei = lpFeeRate + mtFeeRate;
                     if (totalFeeRateWei > 0n) {
                         totalFeeRate = Number(totalFeeRateWei * 10000n / (10n ** 18n)); // Convert to BPS
                     }
                      logger.debug(`${logPrefix} Fetched Dynamic Fees: LP=${lpFeeRate.toString()} MT=${mtFeeRate.toString()}. Total BPS: ${totalFeeRate}`);
                 } else {
                     // Fallback to config fee if dynamic fees couldn't be fetched
                     totalFeeRate = fee !== undefined ? fee : 10;
                      logger.debug(`${logPrefix} Using static config fee: ${totalFeeRate} BPS`);
                 }


            } catch (feeError) {
                 logger.warn(`${logPrefix} Failed to fetch or calculate dynamic fees: ${feeError.message}. Using static config fee.`);
                 totalFeeRate = fee !== undefined ? fee : 10; // Fallback to config fee
            }


            // Note: effectivePrice calculated here is still based on the 1-unit query,
            // which is not suitable for arbitrage simulation of arbitrary amounts.
            // This field might become less relevant once we rely fully on simulator.
             const effectivePrice = (queryAmountOutWei > 0n && quoteToken.decimals !== undefined && quoteToken.decimals !== null) ?
                                    parseFloat(ethers.formatUnits(queryAmountOutWei, quoteToken.decimals)) : 0;


            // *** Ensure all relevant fields are returned ***
            const poolData = {
                address: address,
                dexType: 'dodo',
                // Use the dynamically fetched fee (in BPS) if successful, fallback to config
                fee: totalFeeRate,

                reserve0: pmmState.B, // DODO base balance acts as reserve0 (wei)
                reserve1: pmmState.Q, // DODO quote balance acts as reserve1 (wei)
                token0: token0,
                token1: token1,
                token0Symbol: token0.symbol,
                token1Symbol: token1.symbol,
                pairKey: getCanonicalPairKey(token0, token1),

                // This effectivePrice is based on the 1-unit query, might be inaccurate for large swaps
                effectivePrice: effectivePrice,

                // Store results of the 1-unit query (may be deprecated later)
                queryBaseToken: baseToken,          // Base token object used in query
                queryQuoteToken: quoteToken,        // Quote token object received in query
                queryAmountOutWei: queryAmountOutWei, // Amount of QUOTE received for 1 BASE unit (wei)
                // Add the MT Fee from the 1-unit query if needed for logging/debugging
                queryMtFeeWei: mtFee_1_Unit_Query,
                 baseTokenSymbol: baseTokenSymbol,   // The symbol of the base token (needed for simulator)

                // *** Add fetched DODO PMM state COMPONENTS ***
                // Note: Simulator does *not* use this pmmState object directly anymore,
                // but it's fetched for potential future use (e.g., price calculation method)
                pmmState: pmmState, // Contains { i, K, B, Q, B0, Q0, R }

                // Nullify irrelevant fields from other DEX types
                sqrtPriceX96: null, liquidity: null, tick: null, tickSpacing: null, // UniV3
                groupName: groupName || 'N/A',
                timestamp: Date.now()
            };

            // Basic validation: If reserves are zero after fetching, this pool is likely unusable.
             if (BigInt(poolData.reserve0) <= 0n || BigInt(poolData.reserve1) <= 0n) {
                 logger.debug(`${logPrefix} PMM State shows zero or negative reserves (B: ${poolData.reserve0}, Q: ${poolData.reserve1}). Skipping.`);
                 return { success: false, poolData: null, error: 'Zero or negative reserves in PMM state' };
             }


             logger.debug(`${logPrefix} Successfully fetched data for DODO pool ${address}`);
            return { success: true, poolData: poolData, error: null };

        } catch (error) {
            // Catch errors from contract creation, validation, or re-thrown query errors
            const errMsg = error instanceof ArbitrageError ? error.message : `Unexpected DODO fetch/process error: ${error.message}`;
            logger.error(`${logPrefix} DODO fetch/process failed: ${errMsg}`, error); // Log at error level for caught exceptions
            return { success: false, poolData: null, error: `DODO fetch/process failed: ${errMsg}` };
        }
    }
}

module.exports = DodoFetcher;
