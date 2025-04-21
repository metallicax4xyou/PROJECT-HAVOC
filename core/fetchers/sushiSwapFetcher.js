// core/fetchers/sushiSwapFetcher.js
const { ethers } = require('ethers');
const logger = require('../../utils/logger');
const { ArbitrageError } = require('../../utils/errorHandler');
const { Token } = require('@uniswap/sdk-core'); // Keep for type checking if needed
const { TOKENS } = require('../../constants/tokens');
const { getCanonicalPairKey } = require('../../utils/pairUtils');

const SUSHI_PAIR_ABI = [
    "function getReserves() external view returns (uint112 _reserve0, uint112 _reserve1, uint32 _blockTimestampLast)",
    "function token0() external view returns (address)",
    "function token1() external view returns (address)"
];

class SushiSwapFetcher {
     // Constructor now accepts the main config object
    constructor(config) {
        if (!config || !config.PRIMARY_RPC_URL) {
            throw new ArbitrageError('SushiSwapFetcher requires a config object with PRIMARY_RPC_URL.', 'INITIALIZATION_ERROR');
        }
        this.provider = config.provider || new ethers.JsonRpcProvider(config.PRIMARY_RPC_URL);
        this.config = config;
        this.poolContractCache = {};
        logger.debug('[SushiSwapFetcher] Initialized.');
    }

    _getPoolContract(poolAddress) {
       // ... (no change needed in this helper) ...
       const lowerCaseAddress = poolAddress.toLowerCase();
        if (!this.poolContractCache[lowerCaseAddress]) {
            try {
                this.poolContractCache[lowerCaseAddress] = new ethers.Contract(
                    poolAddress, SUSHI_PAIR_ABI, this.provider
                );
            } catch (error) {
                 logger.error(`[SushiSwapFetcher] Error creating contract instance for ${poolAddress}: ${error.message}`);
                 throw error;
            }
        }
        return this.poolContractCache[lowerCaseAddress];
    }

    /**
     * Fetches the state for a single SushiSwap (V2 style) pool.
      * @param {string} address The pool address.
      * @param {Array<string>} pair Array containing the canonical symbols [tokenASymbol, tokenBSymbol].
      * @returns {Promise<{success: boolean, poolData: object|null, error: string|null}>} Result object.
     */
    async fetchPoolData(address, pair) { // Renamed method and changed arguments
        const logPrefix = `[SushiSwapFetcher Pool ${address.substring(0,6)}]`;

        const poolInfo = this.config.POOL_CONFIGS?.find(p => p.address.toLowerCase() === address.toLowerCase());
        if (!poolInfo) {
             logger.warn(`${logPrefix} Could not find pool info in config for address ${address}.`);
             return { success: false, poolData: null, error: 'Pool info not found in config' };
        }
        const { fee, token0Symbol, token1Symbol, groupName } = poolInfo;

        logger.debug(`${logPrefix} Fetching state (${groupName})`);

        try {
             // Resolve Token objects
             const token0 = this.config.TOKENS[token0Symbol];
             const token1 = this.config.TOKENS[token1Symbol];
            if (!token0 || !token1) {
                const errorMsg = `Could not resolve SDK Tokens for ${token0Symbol}/${token1Symbol}.`;
                logger.error(`${logPrefix} ${errorMsg}`);
                return { success: false, poolData: null, error: errorMsg };
            }

            const poolContract = this._getPoolContract(address);
            // Use callStatic for view functions for safety, though direct call is common
            const reserves = await poolContract.getReserves({ blockTag: 'latest' });

            if (!reserves || typeof reserves._reserve0 === 'undefined' || typeof reserves._reserve1 === 'undefined') {
                throw new Error(`Invalid Reserves Data received from RPC.`);
            }

            const reserve0 = BigInt(reserves._reserve0);
            const reserve1 = BigInt(reserves._reserve1);

            // It's okay for pools to have 0 reserves initially or if drained, log but don't error
            if (reserve0 === 0n || reserve1 === 0n) {
                logger.debug(`${logPrefix} Zero reserves found (${reserve0}, ${reserve1}). Pool might be inactive.`);
            }

            const pairKey = getCanonicalPairKey(token0, token1);
            if (!pairKey) {
                throw new Error(`${logPrefix} Failed to generate canonical pair key for ${token0.symbol}/${token1.symbol}.`);
            }

            const poolData = {
                address: address,
                dexType: 'sushiswap',
                fee: fee, // Use fee from found poolInfo
                reserve0: reserve0,
                reserve1: reserve1,
                token0: token0, // Actual token object
                token1: token1, // Actual token object
                token0Symbol: token0Symbol,
                token1Symbol: token1Symbol,
                groupName: groupName || 'N/A',
                pairKey: pairKey,
                sqrtPriceX96: null, liquidity: null, tick: null, tickSpacing: null, // V3 specific
                timestamp: Date.now()
            };
             return { success: true, poolData: poolData, error: null };

        } catch (error) {
            // Handle potential reverts specifically if needed (e.g., pool doesn't exist)
             if (error.code === 'CALL_EXCEPTION') {
                 logger.warn(`${logPrefix} Call exception fetching state (pool might not exist or RPC issue): ${error.reason}`);
             } else {
                 logger.warn(`${logPrefix} Failed to fetch/process state: ${error.message}`);
             }
            return { success: false, poolData: null, error: error.message };
        }
    }
}

module.exports = SushiSwapFetcher;
