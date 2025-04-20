// core/fetchers/sushiSwapFetcher.js
const { ethers } = require('ethers');
const logger = require('../../utils/logger'); // Adjust path if needed
const { ArbitrageError } = require('../../utils/errorHandler'); // Adjust path if needed
const { Token } = require('@uniswap/sdk-core'); // Keep for type hints if needed
const { TOKENS } = require('../../constants/tokens'); // Adjust path if needed

// SushiSwap V2 Pair ABI (Simplified)
const SUSHI_PAIR_ABI = [
    "function getReserves() external view returns (uint112 _reserve0, uint112 _reserve1, uint32 _blockTimestampLast)",
    "function token0() external view returns (address)", // Optional: if needed for verification
    "function token1() external view returns (address)"  // Optional: if needed for verification
];

class SushiSwapFetcher {
    constructor(provider) {
        if (!provider) {
            throw new ArbitrageError('SushiSwapFetcher requires a provider.', 'INITIALIZATION_ERROR');
        }
        this.provider = provider;
        this.poolContractCache = {}; // Internal cache for Sushi contracts
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
     * Fetches the state (reserves) for a single SushiSwap (V2 style) pool.
     * @param {object} poolInfo Configuration object for the pool, must include address, fee, token0Symbol, token1Symbol, groupName.
     * @returns {Promise<object|null>} Formatted pool state object or null on failure.
     */
    async fetchPoolState(poolInfo) {
        const address = poolInfo.address;
        logger.debug(`[SushiSwapFetcher] Fetching state for Sushi pool: ${address} (${poolInfo.groupName})`);

        try {
            const poolContract = this._getPoolContract(address);
            const reservesResult = await Promise.allSettled([
                 poolContract.getReserves({ blockTag: 'latest' })
                 // Optional: Fetch token addresses if validation is needed
                 // poolContract.token0({ blockTag: 'latest' }),
                 // poolContract.token1({ blockTag: 'latest' })
            ]);

            const reservesSettle = reservesResult[0];
            // const token0Settle = reservesResult[1]; // If fetching
            // const token1Settle = reservesResult[2]; // If fetching

            if (reservesSettle.status !== 'fulfilled') {
                 throw new Error(`RPC call failed for getReserves: ${reservesSettle.reason?.message || 'Unknown Error'}`);
            }
            const reserves = reservesSettle.value;

            if (!reserves || typeof reserves._reserve0 === 'undefined' || typeof reserves._reserve1 === 'undefined') {
                throw new Error(`Invalid Reserves Data received from RPC.`);
            }

            const reserve0 = BigInt(reserves._reserve0);
            const reserve1 = BigInt(reserves._reserve1);

            // Basic check: SushiSwap reserves cannot be zero for swaps
            if (reserve0 === 0n || reserve1 === 0n) {
                throw new Error(`Zero reserves found (${reserve0}, ${reserve1}). Pool likely empty or invalid.`);
            }

            // Optional: Validate fetched token addresses against config (code omitted for brevity, was commented out)

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
                dexType: 'sushiswap', // Mark the type
                fee: poolInfo.fee, // Sushi fee (e.g., 30 bps)
                reserve0: reserve0,
                reserve1: reserve1,
                token0: token0,
                token1: token1,
                token0Symbol: poolInfo.token0Symbol,
                token1Symbol: poolInfo.token1Symbol,
                groupName: poolInfo.groupName || 'N/A',
                pairKey: pairKey, // ---> ADDED THIS LINE <---
                // V3 specific fields set to null
                sqrtPriceX96: null,
                liquidity: null,
                tick: null,
                tickSpacing: null,
            };

        } catch (error) {
            logger.warn(`[SushiSwapFetcher] Failed to fetch/process state for Sushi pool ${address}: ${error.message}`);
            return null; // Return null on any error during fetch/process for this pool
        }
    }
}

module.exports = SushiSwapFetcher;
