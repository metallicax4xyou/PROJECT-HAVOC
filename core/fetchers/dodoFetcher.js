// core/fetchers/dodoFetcher.js
const { ethers } = require('ethers');
const logger = require('../../utils/logger'); // Adjust path
const { ArbitrageError } = require('../../utils/errorHandler'); // Adjust path
const { TOKENS } = require('../../constants/tokens'); // Adjust path
const { getCanonicalPairKey } = require('../../utils/pairUtils'); // Adjust path
const { ABIS } = require('../../constants/abis'); // Adjust path

// Assuming IDODOV2 interface includes getPMMState based on documentation
// If Ethers requires a specific interface definition for complex return types,
// you might need to import or define the PMMState struct type here.
// For now, Ethers often handles simple struct decoding.

class DodoFetcher {
    constructor(config) {
        if (!config?.PRIMARY_RPC_URL) throw new ArbitrageError('DodoFetcher requires config with PRIMARY_RPC_URL.', 'INIT_ERR');
        this.provider = config.provider || new ethers.JsonRpcProvider(config.PRIMARY_RPC_URL);
        this.config = config;
        this.poolContractCache = {};
        // The ABIS.DODOV1V2Pool should contain the functions defined in IDODOV2.sol
        if (!ABIS?.DODOV1V2Pool) logger.warn("[DodoFetcherInit] DODOV1V2Pool ABI missing.");
        this.poolAbi = ABIS.DODOV1V2Pool;
        logger.debug(`[DodoFetcher] Initialized.`);
    }

    _getPoolContract(poolAddress) {
        const lowerCaseAddress = poolAddress.toLowerCase();
        if (!this.poolContractCache[lowerCaseAddress]) {
            try {
                 if (!this.poolAbi) throw new Error("DODOV1V2Pool ABI not loaded.");
                 this.poolContractCache[lowerCaseAddress] = new ethers.Contract(poolAddress, this.poolAbi, this.provider);
                 logger.debug(`[DodoFetcher] Created contract instance for ${poolAddress}`);
            } catch (error) { logger.error(`[DodoFetcher] Error creating DODO contract ${poolAddress}: ${error.message}`); throw error; }
        }
        return this.poolContractCache[lowerCaseAddress];
    }

    /**
     * Fetches state and simulates selling 1 unit of baseToken for basic price check.
     * NOW ALSO fetches the full PMM state for accurate simulation of arbitrary amounts.
     * Includes baseTokenSymbol, PMM state, and query results in the returned poolData.
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

        logger.debug(`${logPrefix} Fetching state (${poolDesc})`);

        try {
            if (!token0 || !token1 || !token0.address || !token1.address || !token0.decimals || !token1.decimals) {
                 throw new Error(`Invalid token objects received for pool ${address}.`);
            }

            logger.debug(`${logPrefix} Looking up baseTokenSymbol: '${baseTokenSymbol}' in config.TOKENS`);
            const baseToken = this.config.TOKENS[baseTokenSymbol];
            if (!baseToken || !baseToken.symbol || !baseToken.address || !baseToken.decimals) {
                 logger.error(`${logPrefix} Failed to find valid token object for baseTokenSymbol '${baseTokenSymbol}'.`);
                 throw new Error(`Base token object not found or invalid for symbol: ${baseTokenSymbol}`);
            }
            logger.debug(`${logPrefix} Found baseToken: ${baseToken.symbol} (${baseToken.address})`);

            const quoteToken = (token0.address.toLowerCase() === baseToken.address.toLowerCase()) ? token1 : token0;
            if (quoteToken.address.toLowerCase() === baseToken.address.toLowerCase()) {
                 throw new Error("Base and Quote tokens are the same.");
            }
            logger.debug(`${logPrefix} Configured Base: ${baseToken.symbol}, Quote: ${quoteToken.symbol}. Querying: Sell 1 ${baseToken.symbol}`);

            const poolContract = this._getPoolContract(address);

            // --- Existing: Query for 1 unit of base token (for basic price check) ---
            const amountIn_1_Unit = ethers.parseUnits('1', baseToken.decimals);
            let queryAmountOutWei = 0n; // Initialize to 0n
            try {
                 // Using staticCall for a view-like call
                 if (!poolContract.querySellBaseToken) throw new Error("ABI missing querySellBaseToken."); // Ensure querySellBaseToken is in ABIS.DODOV1V2Pool
                 // Note: querySellBaseToken is not standard IDODOV2. querySellBase(address trader, uint256 payBaseAmount) is.
                 // Let's update to use querySellBase as per documentation.
                 queryAmountOutWei = await poolContract.querySellBase.staticCall(ethers.ZeroAddress, amountIn_1_Unit);
                 logger.debug(`${logPrefix} pool.querySellBase(1 ${baseToken.symbol}) Result: ${queryAmountOutWei.toString()} ${quoteToken.symbol} wei`);
             } catch (queryError) {
                 let reason = queryError.reason || queryError.message; if (queryError.data && queryError.data !== '0x') { try { reason = ethers.utils.toUtf8String(queryError.data); } catch {} }
                 logger.warn(`${logPrefix} pool.querySellBase(1 unit) failed: ${reason}`);
                 // If query fails, amountOutWei remains 0n, which priceCalculation will handle.
             }
            // Note: querySellBase actually returns (uint receiveQuoteAmount, uint mtFee).
            // The above only captures receiveQuoteAmount. We might need mtFee later.
            // For now, we only need the base/quote amounts and the full PMM state for simulation.


            // --- NEW: Fetch PMM State ---
            let pmmState = null;
            try {
                 // Assuming getPMMState is available on the pool contract ABI (IDODOV2)
                 if (!poolContract.getPMMState) throw new Error("ABI missing getPMMState."); // Ensure getPMMState is in ABIS.DODOV1V2Pool
                 pmmState = await poolContract.getPMMState.staticCall(); // Use staticCall for view function
                 logger.debug(`${logPrefix} Fetched PMM State: ${JSON.stringify(pmmState)}`); // Log state content
            } catch (stateError) {
                 let reason = stateError.reason || stateError.message; if (stateError.data && stateError.data !== '0x') { try { reason = ethers.utils.toUtf8String(stateError.data); } catch {} }
                 logger.warn(`${logPrefix} Failed to fetch PMM State: ${reason}`);
                 // If PMM state fetch fails, we cannot accurately simulate.
                 // Return null poolData to indicate unusable state.
                 return { success: false, poolData: null, error: `Failed to fetch PMM state: ${reason}` };
            }

            // TODO: Add logic to fetch dynamic fee rates (lpFeeRate, mtFeeRate)
            // The current 'fee' field in poolData comes from the config, which is static.
            // Accurate profit calculation for arbitrary amounts requires dynamic fees.
            // This likely requires checking the ABI for functions like getUserFeeRate or getPairDetail.
            // Deferring this for now to focus on PMM state simulation.

            const pairKey = getCanonicalPairKey(token0, token1);
            if (!pairKey) { throw new Error(`Failed to generate canonical pair key.`); }

            // Note: effectivePrice calculated here is still based on the 1-unit query,
            // which is not suitable for arbitrage simulation of arbitrary amounts.
            // This field might become less relevant once we rely fully on simulator.
            const priceString = ethers.formatUnits(queryAmountOutWei, quoteToken.decimals);
            const effectivePrice = parseFloat(priceString); // This is approximate for 1 unit


            // *** Ensure all relevant fields are returned ***
            const poolData = {
                address: address,
                dexType: 'dodo',
                // WARNING: 'fee' here is from config, NOT dynamic fee rate from contract
                // This needs refinement for accurate profit calculation
                fee: fee !== undefined ? fee : 10, // Keep static config fee for now

                reserve0: null, reserve1: null, // DODO doesn't use standard reserves like UniV2
                token0: token0,
                token1: token1,
                token0Symbol: token0.symbol,
                token1Symbol: token1.symbol,
                pairKey: pairKey,

                // This effectivePrice is based on the 1-unit query, might be inaccurate for large swaps
                effectivePrice: effectivePrice,

                // Store results of the 1-unit query (might be deprecated later)
                queryBaseToken: baseToken,          // Base token object used in query
                queryQuoteToken: quoteToken,        // Quote token object received in query
                queryAmountOutWei: queryAmountOutWei, // Amount of QUOTE received for 1 BASE unit (wei)

                // *** NEW: Add fetched DODO PMM state ***
                pmmState: pmmState,
                 baseTokenSymbol: baseTokenSymbol,   // The symbol of the base token (needed for simulator)


                // Nullify irrelevant fields from other DEX types
                sqrtPriceX96: null,
                liquidity: null, // UniV3
                tick: null,
                tickSpacing: null,
                groupName: groupName || 'N/A',
                timestamp: Date.now()
            };

             logger.debug(`${logPrefix} Successfully fetched data for DODO pool ${address}`);
            return { success: true, poolData: poolData, error: null };

        } catch (error) {
            // Catch any errors during the entire fetch process
            logger.warn(`${logPrefix} Failed fetch/process for DODO pool ${address}: ${error.message}`);
            if (!(error instanceof ArbitrageError)) { logger.error(`Stack trace for DODO fetch failure on ${address}: ${error.stack}`); }
            return { success: false, poolData: null, error: error.message };
        }
    }
}

module.exports = DodoFetcher;
