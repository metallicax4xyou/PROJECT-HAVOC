// core/fetchers/camelotFetcher.js
// --- Adapted from sushiSwapFetcher.js for Camelot V2 Pools ---
const { ethers } = require('ethers');
const logger = require('../../utils/logger');
const { ArbitrageError } = require('../../utils/errorHandler');
const { Token } = require('@uniswap/sdk-core');
const { TOKENS } = require('../../constants/tokens');
const { getCanonicalPairKey } = require('../../utils/pairUtils');

// Standard AMM V2 Pair ABI (Same as SushiSwap V2)
const CAMELOT_PAIR_ABI = [
    "function getReserves() external view returns (uint112 _reserve0, uint112 _reserve1, uint32 _blockTimestampLast)",
    "function token0() external view returns (address)",
    "function token1() external view returns (address)"
];

// Standard Camelot V2 Fee (usually 0.3%, but can vary with stable/volatile flags - assume 0.3% for now)
const CAMELOT_DEFAULT_FEE_BPS = 3000; // 0.3%

class CamelotFetcher {
    constructor(provider) {
        if (!provider) {
            throw new ArbitrageError('CamelotFetcher requires a provider.', 'INITIALIZATION_ERROR');
        }
        this.provider = provider;
        this.poolContractCache = {}; // Internal cache for Camelot contracts
        logger.debug('[CamelotFetcher] Initialized.');
    }

    _getPoolContract(poolAddress) {
        const lowerCaseAddress = poolAddress.toLowerCase();
        if (!this.poolContractCache[lowerCaseAddress]) {
            try {
                this.poolContractCache[lowerCaseAddress] = new ethers.Contract(
                    poolAddress, CAMELOT_PAIR_ABI, this.provider
                );
            } catch (error) {
                 logger.error(`[CamelotFetcher] Error creating contract instance for ${poolAddress}: ${error.message}`);
                 throw error;
            }
        }
        return this.poolContractCache[lowerCaseAddress];
    }

    /**
     * Fetches the state (reserves) for a single Camelot V2 pool.
     * @param {object} poolInfo Configuration object for the pool (must include address, token0Symbol, token1Symbol).
     * @returns {Promise<object|null>} Formatted pool state object or null on failure.
     */
    async fetchPoolState(poolInfo) {
        const address = poolInfo.address;
        const networkTokens = TOKENS; // Assumes TOKENS is pre-filtered for the correct network
        // Use poolInfo.name or generate desc from symbols for logging
        const poolDesc = poolInfo.name || `${poolInfo.token0Symbol}/${poolInfo.token1Symbol}_CAMELOT`;
        const logPrefix = `[CamelotFetcher Pool ${address.substring(0,6)}]`;
        logger.debug(`${logPrefix} Fetching state (${poolDesc})`);

        try {
            const poolContract = this._getPoolContract(address);
            // Fetch reserves - Camelot V2 uses standard getReserves
            const reservesResult = await Promise.allSettled([
                 poolContract.getReserves({ blockTag: 'latest' })
            ]);

            const reservesSettle = reservesResult[0];
            if (reservesSettle.status !== 'fulfilled') {
                 throw new Error(`RPC call failed for getReserves: ${reservesSettle.reason?.message || 'Unknown Error'}`);
            }
            const reserves = reservesSettle.value;

            if (!reserves || typeof reserves._reserve0 === 'undefined' || typeof reserves._reserve1 === 'undefined') {
                throw new Error(`Invalid Reserves Data received from RPC.`);
            }

            const reserve0 = BigInt(reserves._reserve0);
            const reserve1 = BigInt(reserves._reserve1);

            // Basic check: Reserves cannot be zero for swaps
            if (reserve0 === 0n || reserve1 === 0n) {
                throw new Error(`Zero reserves found (${reserve0}, ${reserve1}). Pool likely empty or invalid.`);
            }

            // Resolve Token objects using the symbols from poolInfo
            const token0 = networkTokens[poolInfo.token0Symbol];
            const token1 = networkTokens[poolInfo.token1Symbol];
             if (!token0 || !token1) {
                throw new Error(`${logPrefix} Could not resolve SDK Tokens for ${poolInfo.token0Symbol}/${poolInfo.token1Symbol}. Check constants/tokens.js and pool config.`);
            }

            // Generate canonical pair key using shared utility
            const pairKey = getCanonicalPairKey(token0, token1);
             if (!pairKey) {
                throw new Error(`${logPrefix} Failed to generate canonical pair key for ${token0.symbol}/${token1.symbol}.`);
            }

            // Determine fee - Use explicitly defined fee in config if available, otherwise default
            const feeBps = poolInfo.fee || CAMELOT_DEFAULT_FEE_BPS;
            logger.debug(`${logPrefix} Using Fee: ${feeBps} bps`);


            // TEMP DEBUG LOGGING (Keep for consistency)
            logger.debug(`${logPrefix} T0: ${token0.symbol} (Canon: ${token0.canonicalSymbol ?? 'N/A'})`);
            logger.debug(`${logPrefix} T1: ${token1.symbol} (Canon: ${token1.canonicalSymbol ?? 'N/A'})`);
            logger.debug(`${logPrefix} Generated PairKey: ${pairKey}`);
            // END TEMP DEBUG LOGGING

            // Return the formatted state object, similar to SushiSwapFetcher but with dexType='camelot'
            return {
                address: address,
                dexType: 'camelot', // *** Identify as Camelot ***
                fee: feeBps,        // Use determined fee
                reserve0: reserve0,
                reserve1: reserve1,
                token0: token0,
                token1: token1,
                token0Symbol: poolInfo.token0Symbol,
                token1Symbol: poolInfo.token1Symbol,
                pairKey: pairKey,
                groupName: poolInfo.name || 'N/A', // Use name from config if provided
                // Set V3 specific fields to null for V2-style pools
                sqrtPriceX96: null,
                liquidity: null,
                tick: null,
                tickSpacing: null,
            };

        } catch (error) {
            logger.warn(`${logPrefix} Failed to fetch/process state for Camelot pool ${address} (${poolDesc}): ${error.message}`);
            return null; // Return null on any error during fetch/process for this pool
        }
    }
}

module.exports = CamelotFetcher;
