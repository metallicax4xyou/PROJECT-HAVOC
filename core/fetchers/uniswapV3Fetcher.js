// core/fetchers/uniswapV3Fetcher.js
// --- Uses shared getCanonicalPairKey utility ---
const { ethers } = require('ethers');
const { ABIS } = require('../../constants/abis');
const logger = require('../../utils/logger');
const { ArbitrageError } = require('../../utils/errorHandler');
const { Token } = require('@uniswap/sdk-core');
const { TOKENS } = require('../../constants/tokens');
const { getTickSpacingFromFeeBps } = require('../scannerUtils');
const { getCanonicalPairKey } = require('../../utils/pairUtils'); // <-- Import the utility

const MAX_UINT128 = (1n << 128n) - 1n;

class UniswapV3Fetcher {
    constructor(provider) {
        if (!provider) {
            throw new ArbitrageError('UniswapV3Fetcher requires a provider.', 'INITIALIZATION_ERROR');
        }
        this.provider = provider;
        this.poolContractCache = {};
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
     * Fetches the state for a single Uniswap V3 pool.
     * @param {object} poolInfo Configuration object for the pool.
     * @returns {Promise<object|null>} Formatted pool state object or null on failure.
     */
    async fetchPoolState(poolInfo) {
        const address = poolInfo.address;
        const networkTokens = TOKENS; // Assumes TOKENS is pre-filtered for the correct network
        const logPrefix = `[UniswapV3Fetcher Pool ${address.substring(0,6)}]`;
        logger.debug(`${logPrefix} Fetching state (${poolInfo.groupName} ${poolInfo.fee}bps)`);

        try {
            const poolContract = this._getPoolContract(address);
            const [slot0Result, liquidityResult] = await Promise.allSettled([
                poolContract.slot0({ blockTag: 'latest' }),
                poolContract.liquidity({ blockTag: 'latest' })
            ]);

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
                logger.warn(`${logPrefix} Liquidity ${currentLiquidity} exceeds MAX_UINT128.`);
                return null;
            }

            // Resolve Token objects using the symbols from poolInfo
            const token0 = networkTokens[poolInfo.token0Symbol];
            const token1 = networkTokens[poolInfo.token1Symbol];
            if (!token0 || !token1) { // Check if tokens were found in TOKENS map
                throw new Error(`${logPrefix} Could not resolve SDK Tokens for ${poolInfo.token0Symbol}/${poolInfo.token1Symbol}. Check constants/tokens.js and pool config.`);
            }

            // ---> USE SHARED UTILITY FOR PAIRKEY <---
            const pairKey = getCanonicalPairKey(token0, token1);
            if (!pairKey) {
                // Error already logged by utility, just need to handle the null return
                throw new Error(`${logPrefix} Failed to generate canonical pair key for ${token0.symbol}/${token1.symbol}.`);
            }
            // ---> END PAIRKEY LOGIC <---

            // TEMP DEBUG LOGGING (Keep for now as requested)
            logger.debug(`${logPrefix} T0: ${token0.symbol} (Canon: ${token0.canonicalSymbol ?? 'N/A'})`);
            logger.debug(`${logPrefix} T1: ${token1.symbol} (Canon: ${token1.canonicalSymbol ?? 'N/A'})`);
            logger.debug(`${logPrefix} Generated PairKey: ${pairKey}`);
            // END TEMP DEBUG LOGGING

            // Return the formatted state object
            return {
                address: address,
                dexType: 'uniswapV3',
                fee: poolInfo.fee,
                tick: currentTick,
                liquidity: currentLiquidity,
                sqrtPriceX96: currentSqrtPriceX96,
                tickSpacing: getTickSpacingFromFeeBps(poolInfo.fee),
                token0: token0, // Keep original Token objects
                token1: token1, // Keep original Token objects
                token0Symbol: poolInfo.token0Symbol, // Keep original symbols
                token1Symbol: poolInfo.token1Symbol, // Keep original symbols
                groupName: poolInfo.groupName || 'N/A',
                pairKey: pairKey, // Use the key generated by the utility
            };

        } catch (error) {
            logger.warn(`${logPrefix} Failed to fetch/process state: ${error.message}`);
            // Consider adding stack trace for harder errors: logger.error(error.stack);
            return null;
        }
    }
}

module.exports = UniswapV3Fetcher;
