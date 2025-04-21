// core/fetchers/uniswapV3Fetcher.js
const { ethers } = require('ethers');
const { ABIS } = require('../../constants/abis');
const logger = require('../../utils/logger');
const { ArbitrageError } = require('../../utils/errorHandler');
const { Token } = require('@uniswap/sdk-core'); // Keep for type checking if needed
const { TOKENS } = require('../../constants/tokens');
const { getTickSpacingFromFeeBps } = require('../scannerUtils');
const { getCanonicalPairKey } = require('../../utils/pairUtils');

const MAX_UINT128 = (1n << 128n) - 1n;

class UniswapV3Fetcher {
    // Constructor now accepts the main config object
    constructor(config) {
        if (!config || !config.PRIMARY_RPC_URL) {
            throw new ArbitrageError('UniswapV3Fetcher requires a config object with PRIMARY_RPC_URL.', 'INITIALIZATION_ERROR');
        }
        // Create provider internally if needed, or reuse if passed via config
        this.provider = config.provider || new ethers.JsonRpcProvider(config.PRIMARY_RPC_URL); // Use augmented provider or create new
        this.config = config; // Store config for accessing pool details
        this.poolContractCache = {};
        logger.debug('[UniswapV3Fetcher] Initialized.');
    }

    _getPoolContract(poolAddress) {
        // ... (no change needed in this helper) ...
        const lowerCaseAddress = poolAddress.toLowerCase();
        if (!this.poolContractCache[lowerCaseAddress]) {
            try {
                if (!ABIS || !ABIS.UniswapV3Pool) { throw new Error("UniswapV3Pool ABI not found."); }
                this.poolContractCache[lowerCaseAddress] = new ethers.Contract(
                    poolAddress, ABIS.UniswapV3Pool, this.provider
                );
            } catch (error) {
                 logger.error(`[UniswapV3Fetcher] Error creating contract instance for ${poolAddress}: ${error.message}`);
                 throw error;
            }
        }
        return this.poolContractCache[lowerCaseAddress];
    }

    /**
     * Fetches the state for a single Uniswap V3 pool.
     * @param {string} address The pool address.
     * @param {Array<string>} pair Array containing the canonical symbols [tokenASymbol, tokenBSymbol].
     * @returns {Promise<{success: boolean, poolData: object|null, error: string|null}>} Result object.
     */
    async fetchPoolData(address, pair) { // Renamed method and changed arguments
        const logPrefix = `[UniswapV3Fetcher Pool ${address.substring(0,6)}]`;

        // Find the corresponding poolInfo from the main config
        // This is less efficient than passing poolInfo directly, but aligns with current PoolScanner structure
        const poolInfo = this.config.POOL_CONFIGS?.find(p => p.address.toLowerCase() === address.toLowerCase());

        if (!poolInfo) {
             logger.warn(`${logPrefix} Could not find pool info in config for address ${address}. Cannot determine fee/symbols.`);
             return { success: false, poolData: null, error: 'Pool info not found in config' };
        }
        // Destructure needed info
        const { fee, token0Symbol, token1Symbol, groupName } = poolInfo;

        logger.debug(`${logPrefix} Fetching state (${groupName} ${fee}bps)`);

        try {
            // Resolve Token objects using the symbols from poolInfo
            // Ensure TOKENS has been loaded and contains the network's tokens
             const token0 = this.config.TOKENS[token0Symbol];
             const token1 = this.config.TOKENS[token1Symbol];
            if (!token0 || !token1) {
                const errorMsg = `Could not resolve SDK Tokens for ${token0Symbol}/${token1Symbol}. Check constants/tokens.js.`;
                logger.error(`${logPrefix} ${errorMsg}`);
                return { success: false, poolData: null, error: errorMsg };
            }

            const poolContract = this._getPoolContract(address);
            const [slot0Result, liquidityResult] = await Promise.allSettled([
                poolContract.slot0({ blockTag: 'latest' }),
                poolContract.liquidity({ blockTag: 'latest' })
            ]);

            if (slot0Result.status !== 'fulfilled' || liquidityResult.status !== 'fulfilled') {
                const reason = slot0Result.reason?.message || liquidityResult.reason?.message || 'Unknown RPC Error';
                throw new Error(`RPC call failed: ${reason}`);
            }
            const slot0 = slot0Result.value;
            const liquidity = liquidityResult.value;

            if (slot0 == null || typeof slot0.sqrtPriceX96 === 'undefined' || typeof slot0.tick === 'undefined' || liquidity == null) {
                 throw new Error(`Invalid State Data received from RPC.`);
            }

            const currentSqrtPriceX96 = BigInt(slot0.sqrtPriceX96);
            const currentLiquidity = BigInt(liquidity);
            const currentTick = Number(slot0.tick);

            if (currentLiquidity > MAX_UINT128) {
                logger.warn(`${logPrefix} Liquidity ${currentLiquidity} exceeds MAX_UINT128. Treating as invalid.`);
                return { success: false, poolData: null, error: 'Liquidity exceeds MAX_UINT128' };
            }
            if (currentLiquidity === 0n) {
                 logger.debug(`${logPrefix} Pool has zero liquidity.`);
                 // Still return data, but let downstream handle zero liquidity
            }


            // Use the already resolved token objects
            const pairKey = getCanonicalPairKey(token0, token1);
            if (!pairKey) {
                throw new Error(`${logPrefix} Failed to generate canonical pair key for ${token0.symbol}/${token1.symbol}.`);
            }

            const poolData = {
                address: address,
                dexType: 'uniswapV3',
                fee: fee, // Use fee from found poolInfo
                tick: currentTick,
                liquidity: currentLiquidity,
                sqrtPriceX96: currentSqrtPriceX96,
                tickSpacing: getTickSpacingFromFeeBps(fee),
                token0: token0, // Actual token object
                token1: token1, // Actual token object
                token0Symbol: token0Symbol, // Keep original symbols
                token1Symbol: token1Symbol, // Keep original symbols
                groupName: groupName || 'N/A',
                pairKey: pairKey,
                timestamp: Date.now()
            };
            return { success: true, poolData: poolData, error: null };

        } catch (error) {
            logger.warn(`${logPrefix} Failed to fetch/process state: ${error.message}`);
            return { success: false, poolData: null, error: error.message };
        }
    }
}

module.exports = UniswapV3Fetcher;
