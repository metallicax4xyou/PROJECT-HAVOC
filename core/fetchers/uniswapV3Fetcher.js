// core/fetchers/uniswapV3Fetcher.js
const { ethers } = require('ethers');
const { ABIS } = require('../../constants/abis'); // Adjust path if needed
const logger = require('../../utils/logger'); // Adjust path if needed
const { ArbitrageError } = require('../../utils/errorHandler'); // Adjust path if needed
const { Token } = require('@uniswap/sdk-core'); // Keep for type hints if needed
const { TOKENS } = require('../../constants/tokens'); // Adjust path if needed
const { getTickSpacingFromFeeBps } = require('../scannerUtils'); // Adjust path if needed

const MAX_UINT128 = (1n << 128n) - 1n;

class UniswapV3Fetcher {
    constructor(provider) {
        if (!provider) {
            throw new ArbitrageError('UniswapV3Fetcher requires a provider.', 'INITIALIZATION_ERROR');
        }
        this.provider = provider;
        this.poolContractCache = {}; // Internal cache for V3 contracts
        logger.debug('[UniswapV3Fetcher] Initialized.');
    }

    _getPoolContract(poolAddress) {
        const lowerCaseAddress = poolAddress.toLowerCase();
        if (!this.poolContractCache[lowerCaseAddress]) {
            try {
                if (!ABIS || !ABIS.UniswapV3Pool) { throw new Error("UniswapV3Pool ABI not found in constants/abis."); }
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
     * Fetches the state (slot0, liquidity) for a single Uniswap V3 pool.
     * @param {object} poolInfo Configuration object for the pool, must include address, fee, token0Symbol, token1Symbol, groupName.
     * @returns {Promise<object|null>} Formatted pool state object or null on failure.
     */
    async fetchPoolState(poolInfo) {
        const address = poolInfo.address;
        logger.debug(`[UniswapV3Fetcher] Fetching state for V3 pool: ${address} (${poolInfo.groupName} ${poolInfo.fee}bps)`);

        try {
            const poolContract = this._getPoolContract(address);
            const [slot0Result, liquidityResult] = await Promise.allSettled([
                poolContract.slot0({ blockTag: 'latest' }),
                poolContract.liquidity({ blockTag: 'latest' })
            ]);

            // Process results
            if (slot0Result.status !== 'fulfilled' || liquidityResult.status !== 'fulfilled') {
                const reason = slot0Result.reason?.message || liquidityResult.reason?.message || 'Unknown Error';
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
                logger.warn(`[UniswapV3Fetcher] Pool ${address} liquidity ${currentLiquidity} exceeds MAX_UINT128.`);
                // Depending on strategy, might return null or the state anyway
                // For now, return null as it might cause issues downstream with SDK
                return null;
                // throw new Error(`Liquidity > MAX_UINT128.`);
            }

            const token0 = TOKENS[poolInfo.token0Symbol];
            const token1 = TOKENS[poolInfo.token1Symbol];
            if (!(token0 instanceof Token) || !(token1 instanceof Token)) {
                throw new Error(`Could not resolve SDK Tokens for ${poolInfo.token0Symbol}/${poolInfo.token1Symbol}. Check constants/tokens.js`);
            }

            // ---> ADDED THIS BLOCK <---
            const token0Address = ethers.getAddress(token0.address); // Normalize address
            const token1Address = ethers.getAddress(token1.address); // Normalize address
            const pairKey = token0Address < token1Address
                ? `${token0Address}-${token1Address}`
                : `${token1Address}-${token0Address}`;
            // ---> END ADDED BLOCK <---

            // Return the formatted state object
            return {
                address: address,
                dexType: 'uniswapV3', // Mark the type
                fee: poolInfo.fee,
                tick: currentTick,
                liquidity: currentLiquidity,
                sqrtPriceX96: currentSqrtPriceX96,
                tickSpacing: getTickSpacingFromFeeBps(poolInfo.fee),
                token0: token0,
                token1: token1,
                token0Symbol: poolInfo.token0Symbol,
                token1Symbol: poolInfo.token1Symbol,
                groupName: poolInfo.groupName || 'N/A',
                pairKey: pairKey, // ---> ADDED THIS LINE <---
            };

        } catch (error) {
            logger.warn(`[UniswapV3Fetcher] Failed to fetch/process state for V3 pool ${address}: ${error.message}`);
            // Optional: Handle specific errors differently
            return null; // Return null on any error during fetch/process for this pool
        }
    }
}

module.exports = UniswapV3Fetcher;
