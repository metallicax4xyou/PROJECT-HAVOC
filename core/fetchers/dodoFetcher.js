// core/fetchers/dodoFetcher.js
const { ethers } = require('ethers');
// *** CORRECTED PATHS ***
const logger = require('../../utils/logger');
const { ArbitrageError } = require('../../utils/errorHandler');
const { TOKENS } = require('../../constants/tokens');
const { getCanonicalPairKey } = require('../../utils/pairUtils'); // Correct path
const { ABIS } = require('../../constants/abis');

class DodoFetcher {
    constructor(config) {
        if (!config || !config.PRIMARY_RPC_URL) { throw new ArbitrageError('DodoFetcher requires config with PRIMARY_RPC_URL.', 'INITIALIZATION_ERROR'); }
        this.provider = config.provider || new ethers.JsonRpcProvider(config.PRIMARY_RPC_URL);
        this.config = config;
        this.poolContractCache = {};
        if (!ABIS || !ABIS.DODOV1V2Pool) { throw new ArbitrageError('DodoFetcherInit', "DODOV1V2Pool ABI not found."); }
        this.poolAbi = ABIS.DODOV1V2Pool;
        logger.debug(`[DodoFetcher] Initialized.`);
    }

    _getPoolContract(poolAddress) {
        const lowerCaseAddress = poolAddress.toLowerCase();
        if (!this.poolContractCache[lowerCaseAddress]) {
            try {
                this.poolContractCache[lowerCaseAddress] = new ethers.Contract( poolAddress, this.poolAbi, this.provider );
                 logger.debug(`[DodoFetcher] Created contract instance for pool ${poolAddress}`);
            } catch (error) { logger.error(`[DodoFetcher] Error creating contract instance for DODO pool ${poolAddress}: ${error.message}`); throw error; }
        }
        return this.poolContractCache[lowerCaseAddress];
    }

    async fetchPoolData(address, pair) { // pair is [tokenObjectA, tokenObjectB]
        const logPrefix = `[DodoFetcher Pool ${address.substring(0,6)}]`;
        const poolInfo = this.config.POOL_CONFIGS?.find(p => p.address.toLowerCase() === address.toLowerCase());
        if (!poolInfo) {
             logger.warn(`${logPrefix} Pool info not found for address ${address}.`);
              return { success: false, poolData: null, error: 'Pool info not found in config' };
        }
        const { fee, baseTokenSymbol, groupName } = poolInfo; // Get necessary info
        const poolDesc = groupName || `${pair[0]?.symbol || '?'}/${pair[1]?.symbol || '?'}_DODO`;
        logger.debug(`${logPrefix} Fetching state (${poolDesc})`);

        try {
            const [token0, token1] = pair; // Get token objects from pair arg
            if (!token0 || !token1 || !token0.symbol || !token1.symbol) {
                 return { success: false, poolData: null, error: `Invalid token objects received.` };
            }

            if (!baseTokenSymbol || (baseTokenSymbol !== token0.symbol && baseTokenSymbol !== token1.symbol)) {
                 throw new Error(`DODO pool config for ${address} missing/invalid 'baseTokenSymbol' ('${token0.symbol}' or '${token1.symbol}')`);
             }
            const baseToken = (baseTokenSymbol === token0.symbol) ? token0 : token1;
            const quoteToken = (baseTokenSymbol === token0.symbol) ? token1 : token0;

            logger.debug(`${logPrefix} Querying: Sell 1 ${baseToken.symbol} for ${quoteToken.symbol}`);
            const poolContract = this._getPoolContract(address);
            const amountIn = ethers.parseUnits('1', baseToken.decimals);
            let amountOutWei;

            try {
                 amountOutWei = await poolContract.querySellBaseToken.staticCall(amountIn);
                 logger.debug(`${logPrefix} pool.querySellBaseToken Result: ${amountOutWei.toString()} ${quoteToken.symbol} wei`);
             } catch (queryError) {
                 let reason = queryError.message;
                 if (queryError.reason) { reason = queryError.reason; }
                 else if (queryError.data && queryError.data !== '0x') { try { reason = ethers.utils.toUtf8String(queryError.data); } catch { /* ignore */ } }
                 logger.warn(`${logPrefix} pool.querySellBaseToken failed: ${reason}`);
                 if (reason.includes("BALANCE_NOT_ENOUGH") || reason.includes("TARGET_IS_ZERO")) {
                     amountOutWei = 0n;
                 } else { throw new Error(`DODO query failed: ${reason}`); }
             }

            if (amountOutWei === undefined || amountOutWei === null || amountOutWei < 0n) {
                throw new Error(`Invalid amountOut after DODO query: ${amountOutWei}`);
            }

            const pairKey = getCanonicalPairKey(token0, token1); // Use original token objects
            if (!pairKey) { throw new Error(`Failed to generate canonical pair key.`); }

            const priceString = ethers.formatUnits(amountOutWei, quoteToken.decimals);
            const effectivePrice = parseFloat(priceString);
            const feeBps = fee !== undefined ? fee : 3000; // Use fee from config or default

            const poolData = {
                address: address, dexType: 'dodo', fee: feeBps,
                reserve0: null, reserve1: null,
                token0: token0, token1: token1, // Store token objects
                token0Symbol: token0.symbol, token1Symbol: token1.symbol, // Get symbols from objects
                pairKey: pairKey,
                effectivePrice: effectivePrice, // Price: Units of Quote per 1 Base
                queryBaseToken: baseToken, queryQuoteToken: quoteToken, queryAmountOutWei: amountOutWei,
                sqrtPriceX96: null, liquidity: null, tick: null, tickSpacing: null,
                groupName: groupName || 'N/A', timestamp: Date.now()
            };
            return { success: true, poolData: poolData, error: null };

        } catch (error) {
            logger.warn(`${logPrefix} Failed state fetch for DODO pool ${address}: ${error.message}`);
            return { success: false, poolData: null, error: error.message };
        }
    }
}
module.exports = DodoFetcher;
