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
     * Includes baseTokenSymbol in the returned poolData.
     */
    async fetchPoolData(address, pair) { // pair is [tokenObjectA, tokenObjectB]
        const logPrefix = `[DodoFetcher Pool ${address.substring(0,6)}]`;
        const poolInfo = this.config.POOL_CONFIGS?.find(p => p.address.toLowerCase() === address.toLowerCase());

        if (!poolInfo?.baseTokenSymbol) {
             logger.warn(`${logPrefix} Pool info or baseTokenSymbol missing in config for ${address}.`);
             return { success: false, poolData: null, error: 'Pool info or baseTokenSymbol missing' };
        }
        // Extract necessary info early
        const { fee, baseTokenSymbol, groupName } = poolInfo;
        const [token0, token1] = pair; // Token objects directly from pair arg
        const poolDesc = groupName || `${token0?.symbol || '?'}/${token1?.symbol || '?'}_DODO`;

        logger.debug(`${logPrefix} Fetching state (${poolDesc})`);

        try {
            // Validate base token objects received in pair argument
            if (!token0 || !token0.symbol || !token0.address || !token0.decimals) {
                 throw new Error(`Invalid token0 object received for pool ${address}.`);
             }
            if (!token1 || !token1.symbol || !token1.address || !token1.decimals) {
                 throw new Error(`Invalid token1 object received for pool ${address}.`);
             }

            // --- *** Enhanced Base Token Lookup and Validation *** ---
            logger.debug(`${logPrefix} Looking up baseTokenSymbol: '${baseTokenSymbol}' in config.TOKENS`);
            const baseToken = this.config.TOKENS[baseTokenSymbol]; // Lookup by SYMBOL

            // Strict check if baseToken object was found
            if (!baseToken || !baseToken.symbol || !baseToken.address || !baseToken.decimals) {
                 logger.error(`${logPrefix} Failed to find valid token object for baseTokenSymbol '${baseTokenSymbol}' in config.TOKENS.`);
                 logger.debug(`${logPrefix} Available token symbols: ${Object.keys(this.config.TOKENS || {}).join(', ')}`);
                 throw new Error(`Base token object not found or invalid for symbol: ${baseTokenSymbol}`);
            }
            logger.debug(`${logPrefix} Found baseToken: ${baseToken.symbol} (${baseToken.address})`);
            // --- *** End Validation *** ---

            // Determine quote token (now safe to access baseToken.address)
            const quoteToken = (token0.address.toLowerCase() === baseToken.address.toLowerCase()) ? token1 : token0;
            // Verify quoteToken is different from baseToken
            if (quoteToken.address.toLowerCase() === baseToken.address.toLowerCase()) {
                 throw new Error("Base and Quote tokens resolved to the same token. Check pool config and token data.");
            }
            logger.debug(`${logPrefix} Configured Base: ${baseToken.symbol}, Quote: ${quoteToken.symbol}. Querying: Sell 1 ${baseToken.symbol}`);

            // --- DODO Pool Query ---
            const poolContract = this._getPoolContract(address);
            const amountIn = ethers.parseUnits('1', baseToken.decimals);
            let amountOutWei;

            try {
                 if (!poolContract.querySellBaseToken) throw new Error("ABI missing querySellBaseToken.");
                 amountOutWei = await poolContract.querySellBaseToken.staticCall(amountIn);
                 logger.debug(`${logPrefix} pool.querySellBaseToken Result: ${amountOutWei.toString()} ${quoteToken.symbol} wei`);
             } catch (queryError) { /* ... error handling unchanged ... */
                 let reason = queryError.reason || queryError.message; if (queryError.data && queryError.data !== '0x') { try { reason = ethers.utils.toUtf8String(queryError.data); } catch {} } logger.warn(`${logPrefix} pool.querySellBaseToken failed: ${reason}`); if (reason.includes("BALANCE_NOT_ENOUGH") || reason.includes("TARGET_IS_ZERO")) { amountOutWei = 0n; logger.debug(`${logPrefix} Query failed due to balance/target, amountOut=0.`); } else { throw new Error(`DODO query failed: ${reason}`); }
             }
            if (amountOutWei === undefined || amountOutWei === null || amountOutWei < 0n) throw new Error(`Invalid amountOut: ${amountOutWei}`);

            // --- Final Object Construction ---
            const pairKey = getCanonicalPairKey(token0, token1);
            if (!pairKey) { throw new Error(`Failed to generate canonical pair key.`); }
            const priceString = ethers.formatUnits(amountOutWei, quoteToken.decimals);
            const effectivePrice = parseFloat(priceString);
            const feeBps = fee !== undefined ? fee : 10;

            const poolData = {
                address: address, dexType: 'dodo', fee: feeBps,
                reserve0: null, reserve1: null, token0: token0, token1: token1,
                token0Symbol: token0.symbol, token1Symbol: token1.symbol, pairKey: pairKey,
                effectivePrice: effectivePrice, queryBaseToken: baseToken, queryQuoteToken: quoteToken,
                queryAmountOutWei: amountOutWei, baseTokenSymbol: baseTokenSymbol, // Include the crucial symbol
                sqrtPriceX96: null, liquidity: null, tick: null, tickSpacing: null,
                groupName: groupName || 'N/A', timestamp: Date.now()
            };
            return { success: true, poolData: poolData, error: null };

        } catch (error) {
            logger.warn(`${logPrefix} Failed fetch/process for DODO pool ${address}: ${error.message}`);
            // Log stack for unexpected errors during fetch/process
            if (!(error instanceof ArbitrageError)) { // Avoid logging stack for known config errors
                 logger.error(`Stack trace for DODO fetch failure: ${error.stack}`);
             }
            return { success: false, poolData: null, error: error.message };
        }
    }
}

module.exports = DodoFetcher;
