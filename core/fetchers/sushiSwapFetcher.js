// core/fetchers/sushiSwapFetcher.js
// --- Uses shared getCanonicalPairKey utility ---
const { ethers } = require('ethers');
const logger = require('../../utils/logger');
const { ArbitrageError } = require('../../utils/errorHandler');
const { Token } = require('@uniswap/sdk-core');
const { TOKENS } = require('../../constants/tokens');
const { getCanonicalPairKey } = require('../../utils/pairUtils'); // <-- Import the utility

const SUSHI_PAIR_ABI = [
    "function getReserves() external view returns (uint112 _reserve0, uint112 _reserve1, uint32 _blockTimestampLast)",
    "function token0() external view returns (address)",
    "function token1() external view returns (address)"
];

class SushiSwapFetcher {
    constructor(provider) {
        if (!provider) {
            throw new ArbitrageError('SushiSwapFetcher requires a provider.', 'INITIALIZATION_ERROR');
        }
        this.provider = provider;
        this.poolContractCache = {};
        logger.debug('[SushiSwapFetcher] Initialized.');
    }

    _getPoolContract(poolAddress) {
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
     * @param {object} poolInfo Configuration object for the pool.
     * @returns {Promise<object|null>} Formatted pool state object or null on failure.
     */
    async fetchPoolState(poolInfo) {
        const address = poolInfo.address;
        const networkTokens = TOKENS; // Assumes TOKENS is pre-filtered for the correct network
        const logPrefix = `[SushiSwapFetcher Pool ${address.substring(0,6)}]`;
        logger.debug(`${logPrefix} Fetching state (${poolInfo.groupName})`);

        try {
            const poolContract = this._getPoolContract(address);
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

            if (reserve0 === 0n || reserve1 === 0n) {
                throw new Error(`Zero reserves found (${reserve0}, ${reserve1}).`);
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
                dexType: 'sushiswap',
                fee: poolInfo.fee, // Sushi fee (e.g., 30 bps) - Make sure this is set correctly in config
                reserve0: reserve0,
                reserve1: reserve1,
                token0: token0, // Keep original Token objects
                token1: token1, // Keep original Token objects
                token0Symbol: poolInfo.token0Symbol, // Keep original symbols
                token1Symbol: poolInfo.token1Symbol, // Keep original symbols
                groupName: poolInfo.groupName || 'N/A',
                pairKey: pairKey, // Use the key generated by the utility
                sqrtPriceX96: null, // V3 specific fields
                liquidity: null,
                tick: null,
                tickSpacing: null,
            };

        } catch (error) {
            logger.warn(`${logPrefix} Failed to fetch/process state: ${error.message}`);
             // Consider adding stack trace for harder errors: logger.error(error.stack);
            return null;
        }
    }
}

module.exports = SushiSwapFetcher;
