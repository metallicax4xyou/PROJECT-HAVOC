// core/fetchers/dodoFetcher.js
const { ethers } = require('ethers');
const logger = require('../../utils/logger');
const { ArbitrageError } = require('../../utils/errorHandler');
const { TOKENS } = require('../../constants/tokens');
const { getCanonicalPairKey } = require('../../utils/pairUtils');
const { ABIS } = require('../../constants/abis');

class DodoFetcher {
     // Constructor now accepts the main config object
    constructor(config) {
        if (!config || !config.PRIMARY_RPC_URL) {
            throw new ArbitrageError('DodoFetcher requires a config object with PRIMARY_RPC_URL.', 'INITIALIZATION_ERROR');
        }
        this.provider = config.provider || new ethers.JsonRpcProvider(config.PRIMARY_RPC_URL);
        this.config = config;
        this.poolContractCache = {};

        if (!ABIS || !ABIS.DODOV1V2Pool) {
             throw new ArbitrageError('DodoFetcherInit', "DODOV1V2Pool ABI not found.");
        }
        this.poolAbi = ABIS.DODOV1V2Pool;
        logger.debug(`[DodoFetcher] Initialized.`);
    }

    _getPoolContract(poolAddress) {
        // ... (no change needed in this helper) ...
        const lowerCaseAddress = poolAddress.toLowerCase();
        if (!this.poolContractCache[lowerCaseAddress]) {
            try {
                this.poolContractCache[lowerCaseAddress] = new ethers.Contract(
                    poolAddress, this.poolAbi, this.provider
                );
                 logger.debug(`[DodoFetcher] Created contract instance for pool ${poolAddress}`);
            } catch (error) {
                 logger.error(`[DodoFetcher] Error creating contract instance for DODO pool ${poolAddress}: ${error.message}`);
                 throw error;
            }
        }
        return this.poolContractCache[lowerCaseAddress];
    }


    /**
     * Fetches the effective price for selling 1 unit of baseToken from a DODO pool.
     * @param {string} address The pool address.
     * @param {Array<string>} pair Array containing the canonical symbols [tokenASymbol, tokenBSymbol].
     * @returns {Promise<{success: boolean, poolData: object|null, error: string|null}>} Result object.
     */
    async fetchPoolData(address, pair) { // Renamed method and changed arguments
        const logPrefix = `[DodoFetcher Pool ${address.substring(0,6)}]`;

        const poolInfo = this.config.POOL_CONFIGS?.find(p => p.address.toLowerCase() === address.toLowerCase());
        if (!poolInfo) {
             logger.warn(`${logPrefix} Could not find pool info in config for address ${address}.`);
              return { success: false, poolData: null, error: 'Pool info not found in config' };
        }
        const { fee, token0Symbol, token1Symbol, baseTokenSymbol, groupName } = poolInfo;
        const poolDesc = groupName || `${token0Symbol}/${token1Symbol}_DODO`;

        logger.debug(`${logPrefix} Fetching state (${poolDesc})`);

        try {
            // Resolve tokens from config symbols
             const token0 = this.config.TOKENS[token0Symbol];
             const token1 = this.config.TOKENS[token1Symbol];
            if (!token0 || !token1) { throw new Error(`Could not resolve SDK Tokens for ${token0Symbol}/${token1Symbol}.`); }

            // Get base/quote tokens based on config
            if (!baseTokenSymbol || (baseTokenSymbol !== token0Symbol && baseTokenSymbol !== token1Symbol)) {
                 throw new Error(`DODO pool config for ${address} must specify 'baseTokenSymbol' ('${token0Symbol}' or '${token1Symbol}')`);
             }
            const baseToken = this.config.TOKENS[baseTokenSymbol];
            const quoteToken = (baseTokenSymbol === token0Symbol) ? token1 : token0;
            if (!baseToken || !quoteToken) { throw new Error(`Could not determine base/quote tokens.`); }

            logger.debug(`${logPrefix} Querying: Sell 1 ${baseToken.symbol} for ${quoteToken.symbol}`);
            const poolContract = this._getPoolContract(address);
            const amountIn = ethers.parseUnits('1', baseToken.decimals);
            let amountOutWei;

            try {
                 // Using callStatic for safety on view/query functions
                 amountOutWei = await poolContract.querySellBaseToken.staticCall(amountIn);
                 logger.debug(`${logPrefix} pool.querySellBaseToken Result: ${amountOutWei.toString()} ${quoteToken.symbol} wei`);
             } catch (queryError) {
                 // Handle common revert reasons more gracefully
                 let reason = queryError.message;
                 if (queryError.reason) { reason = queryError.reason; }
                 else if (queryError.data) { try { reason = ethers.utils.toUtf8String(queryError.data); } catch { /* ignore decoding error */ } }

                 logger.warn(`${logPrefix} pool.querySellBaseToken failed for ${baseToken.symbol}->${quoteToken.symbol}: ${reason}`);
                 // Decide if this is a failure or just represents zero output
                 // If error is like "DODO_BASE_BALANCE_NOT_ENOUGH", treat as no valid price
                 if (reason.includes("BALANCE_NOT_ENOUGH") || reason.includes("TARGET_IS_ZERO")) {
                     amountOutWei = 0n; // Treat as zero output if query fails due to liquidity/target
                     logger.debug(`${logPrefix} Query failed due to low balance/zero target, treating amountOut as 0.`);
                 } else {
                     throw new Error(`DODO query failed: ${reason}`); // Re-throw other errors
                 }
             }

            if (amountOutWei === undefined || amountOutWei === null || amountOutWei < 0n) {
                // Should be caught by the 0n assignment above, but keep check
                throw new Error(`Invalid amountOut after DODO query: ${amountOutWei}`);
            }

            const pairKey = getCanonicalPairKey(token0, token1); // Use original token0/token1 for canonical key
            if (!pairKey) { throw new Error(`Failed to generate canonical pair key.`); }

            const priceString = ethers.formatUnits(amountOutWei, quoteToken.decimals);
            const effectivePrice = parseFloat(priceString);
            const feeBps = fee !== undefined ? fee : 3000; // Use fee from config or default

            const poolData = {
                address: address,
                dexType: 'dodo',
                fee: feeBps,
                reserve0: null, reserve1: null,
                token0: token0, token1: token1,
                token0Symbol: token0Symbol, token1Symbol: token1Symbol,
                pairKey: pairKey,
                effectivePrice: effectivePrice,
                queryBaseToken: baseToken,
                queryQuoteToken: quoteToken,
                queryAmountOutWei: amountOutWei,
                sqrtPriceX96: null, liquidity: null, tick: null, tickSpacing: null,
                groupName: groupName || 'N/A',
                timestamp: Date.now()
            };
            return { success: true, poolData: poolData, error: null };

        } catch (error) {
            logger.warn(`${logPrefix} Failed to fetch/process state for DODO pool ${address} (${poolDesc}): ${error.message}`);
            return { success: false, poolData: null, error: error.message };
        }
    }
}

module.exports = DodoFetcher;
