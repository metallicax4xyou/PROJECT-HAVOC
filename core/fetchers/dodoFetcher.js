// core/fetchers/dodoFetcher.js
const { ethers } = require('ethers');
const logger = require('../../utils/logger'); // Adjust path
const { ArbitrageError } = require('../../utils/errorHandler'); // Adjust path
const { TOKENS } = require('../../constants/tokens'); // Adjust path
const { getCanonicalPairKey } = require('../../utils/pairUtils'); // Adjust path
const { ABIS } = require('../../constants/abis'); // Adjust path

class DodoFetcher {
    constructor(config) {
        if (!config?.PRIMARY_RPC_URL) throw new ArbitrageError('DodoFetcher requires config with PRIMARY_RPC_URL.', 'INIT_ERR');
        this.provider = config.provider || new ethers.JsonRpcProvider(config.PRIMARY_RPC_URL);
        this.config = config;
        this.poolContractCache = {};
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
     * Fetches state and simulates selling 1 unit of baseToken.
     * Includes baseTokenSymbol and query results in the returned poolData.
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
            const amountIn = ethers.parseUnits('1', baseToken.decimals);
            let amountOutWei;

            try {
                 if (!poolContract.querySellBaseToken) throw new Error("ABI missing querySellBaseToken.");
                 amountOutWei = await poolContract.querySellBaseToken.staticCall(amountIn);
                 logger.debug(`${logPrefix} pool.querySellBaseToken Result: ${amountOutWei.toString()} ${quoteToken.symbol} wei`);
             } catch (queryError) {
                 let reason = queryError.reason || queryError.message; if (queryError.data && queryError.data !== '0x') { try { reason = ethers.utils.toUtf8String(queryError.data); } catch {} } logger.warn(`${logPrefix} pool.querySellBaseToken failed: ${reason}`); if (reason.includes("BALANCE_NOT_ENOUGH") || reason.includes("TARGET_IS_ZERO")) { amountOutWei = 0n; logger.debug(`${logPrefix} Query failed due to balance/target, amountOut=0.`); } else { throw new Error(`DODO query failed: ${reason}`); }
             }
            if (amountOutWei === undefined || amountOutWei === null || amountOutWei < 0n) { throw new Error(`Invalid amountOut: ${amountOutWei}`); }

            const pairKey = getCanonicalPairKey(token0, token1);
            if (!pairKey) { throw new Error(`Failed to generate canonical pair key.`); }
            const priceString = ethers.formatUnits(amountOutWei, quoteToken.decimals);
            const effectivePrice = parseFloat(priceString);
            const feeBps = fee !== undefined ? fee : 10;

            // *** Ensure all relevant fields are returned ***
            const poolData = {
                address: address, dexType: 'dodo', fee: feeBps,
                reserve0: null, reserve1: null, token0: token0, token1: token1,
                token0Symbol: token0.symbol, token1Symbol: token1.symbol, pairKey: pairKey,
                effectivePrice: effectivePrice,
                // Store results of the query for selling BASE token
                queryBaseToken: baseToken,          // Base token object used in query
                queryQuoteToken: quoteToken,        // Quote token object received in query
                queryAmountOutWei: amountOutWei,    // Amount of QUOTE received for 1 BASE unit (wei)
                baseTokenSymbol: baseTokenSymbol,   // The symbol of the base token (needed for simulator)
                // Nullify V3 fields
                sqrtPriceX96: null, liquidity: null, tick: null, tickSpacing: null,
                groupName: groupName || 'N/A', timestamp: Date.now()
            };
            return { success: true, poolData: poolData, error: null };

        } catch (error) {
            logger.warn(`${logPrefix} Failed fetch/process for DODO pool ${address}: ${error.message}`);
            if (!(error instanceof ArbitrageError)) { logger.error(`Stack trace for DODO fetch failure: ${error.stack}`); }
            return { success: false, poolData: null, error: error.message };
        }
    }
}

module.exports = DodoFetcher;
