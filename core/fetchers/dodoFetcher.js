// core/fetchers/dodoFetcher.js
// --- Fetches prices from DODO pools using DODOHelper (or direct pool query if needed) ---

const { ethers } = require('ethers');
const logger = require('../../utils/logger');
const { ArbitrageError } = require('../../utils/errorHandler');
const { TOKENS } = require('../../constants/tokens');
const { getCanonicalPairKey } = require('../../utils/pairUtils');
const { ABIS } = require('../../constants/abis'); // Load ABIs

// DODO Helper contract address on Arbitrum (Seems incorrect based on checks, keeping for reference)
// const DODO_HELPER_ADDRESS_WRONG = '0xc3984061d7a0eb08479b5f85b43cba2d4d5a379c';
// Using direct pool interaction as per V1/V2 ABI

class DodoFetcher {
    constructor(provider) {
        if (!provider) {
            throw new ArbitrageError('DodoFetcher requires a provider.', 'INITIALIZATION_ERROR');
        }
        this.provider = provider;
        this.poolContractCache = {}; // Cache for individual pool contracts

        // Ensure the DODOV1V2Pool ABI is loaded correctly
        if (!ABIS || !ABIS.DODOV1V2Pool) {
             throw new ArbitrageError('DodoFetcherInit', "DODOV1V2Pool ABI not found in constants/abis.js.");
        }
        this.poolAbi = ABIS.DODOV1V2Pool;
        logger.debug(`[DodoFetcher] Initialized.`);
    }

    _getPoolContract(poolAddress) {
        const lowerCaseAddress = poolAddress.toLowerCase();
        if (!this.poolContractCache[lowerCaseAddress]) {
            try {
                this.poolContractCache[lowerCaseAddress] = new ethers.Contract(
                    poolAddress,
                    this.poolAbi,
                    this.provider
                );
                 logger.debug(`[DodoFetcher] Created contract instance for pool ${poolAddress}`);
            } catch (error) {
                 logger.error(`[DodoFetcher] Error creating contract instance for DODO pool ${poolAddress}: ${error.message}`);
                 throw error; // Re-throw error
            }
        }
        return this.poolContractCache[lowerCaseAddress];
    }


    /**
     * Fetches the effective price for selling 1 unit of baseToken from a DODO pool.
     * @param {object} poolInfo Configuration object (address, token0Symbol, token1Symbol, baseTokenSymbol)
     * @returns {Promise<object|null>} Formatted pool state object (price-focused) or null on failure.
     */
    async fetchPoolState(poolInfo) {
        const address = poolInfo.address;
        const networkTokens = TOKENS;
        const poolDesc = poolInfo.name || `${poolInfo.token0Symbol}/${poolInfo.token1Symbol}_DODO`;
        const logPrefix = `[DodoFetcher Pool ${address.substring(0,6)}]`;
        logger.debug(`${logPrefix} Fetching state (${poolDesc})`);

        try {
            // Resolve tokens from config symbols
            const token0 = networkTokens[poolInfo.token0Symbol];
            const token1 = networkTokens[poolInfo.token1Symbol];
            if (!token0 || !token1) { throw new Error(`Could not resolve SDK Tokens for ${poolInfo.token0Symbol}/${poolInfo.token1Symbol}.`); }

            // Get base/quote tokens based on config
            if (!poolInfo.baseTokenSymbol || (poolInfo.baseTokenSymbol !== poolInfo.token0Symbol && poolInfo.baseTokenSymbol !== poolInfo.token1Symbol)) {
                 throw new Error(`DODO pool config for ${address} must specify 'baseTokenSymbol' ('${poolInfo.token0Symbol}' or '${poolInfo.token1Symbol}')`);
             }
            const baseToken = networkTokens[poolInfo.baseTokenSymbol];
            const quoteToken = (poolInfo.baseTokenSymbol === poolInfo.token0Symbol) ? token1 : token0;
            if (!baseToken || !quoteToken) { throw new Error(`Could not determine base/quote tokens.`); }

            logger.debug(`${logPrefix} Querying: Sell 1 ${baseToken.symbol} for ${quoteToken.symbol}`);

            // Get the specific DODO pool contract instance
            const poolContract = this._getPoolContract(address);

            // Standard amount to query (1 unit of base token)
            const amountIn = ethers.parseUnits('1', baseToken.decimals);
            let amountOutWei;

            // Query the pool contract directly using querySellBaseToken
            try {
                 // Note: DODO V1/V2 pool ABI has this function directly
                 amountOutWei = await poolContract.querySellBaseToken(amountIn);
                 logger.debug(`${logPrefix} pool.querySellBaseToken Result: ${amountOutWei.toString()} ${quoteToken.symbol} wei`);
             } catch (queryError) {
                  logger.warn(`${logPrefix} pool.querySellBaseToken failed for ${baseToken.symbol}->${quoteToken.symbol}: ${queryError.message}. Pool might be wrong type or query invalid.`);
                  throw new Error(`DODO query failed: ${queryError.message}`);
              }

            if (amountOutWei === undefined || amountOutWei === null || amountOutWei < 0n) {
                throw new Error(`Invalid amountOut received from DODO query: ${amountOutWei}`);
            }

            // Generate canonical pair key
            const pairKey = getCanonicalPairKey(baseToken, quoteToken);
            if (!pairKey) { throw new Error(`Failed to generate canonical pair key.`); }

            // Convert amountOut to a human-readable price (Units of Quote per 1 Unit of Base)
            const priceString = ethers.formatUnits(amountOutWei, quoteToken.decimals);
            const effectivePrice = parseFloat(priceString);

            // Get fee (use from config or default)
            const feeBps = poolInfo.fee !== undefined ? poolInfo.fee : 3000; // Default to 0.3%

            return {
                address: address,
                dexType: 'dodo',
                fee: feeBps,
                reserve0: null, reserve1: null, // Not applicable
                token0: token0, token1: token1,
                token0Symbol: poolInfo.token0Symbol, token1Symbol: poolInfo.token1Symbol,
                pairKey: pairKey,
                effectivePrice: effectivePrice, // Units of Quote per 1 Base
                queryBaseToken: baseToken,
                queryQuoteToken: quoteToken,
                queryAmountOutWei: amountOutWei, // Raw output amount
                // Nullify V3 fields
                sqrtPriceX96: null, liquidity: null, tick: null, tickSpacing: null,
                groupName: poolInfo.name || 'N/A',
                timestamp: Date.now() // Add timestamp
            };

        } catch (error) {
            logger.warn(`${logPrefix} Failed to fetch/process state for DODO pool ${address} (${poolDesc}): ${error.message}`);
            return null; // Return null on any error
        }
    }
}

module.exports = DodoFetcher;
