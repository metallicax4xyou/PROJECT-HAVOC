// /workspaces/arbitrum-flash/core/poolDataProvider.js

const { ethers } = require('ethers');
const IUniswapV3PoolABI = require('@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json').abi;
const { getProvider } = require('../utils/provider'); // Adjust path if needed
const logger = require('../utils/logger');

// Simple in-memory cache (replace with a more robust solution if needed)
const poolDataCache = new Map();
const CACHE_TTL = 60 * 1000; // Cache for 60 seconds

/**
 * Fetches live slot0 and liquidity data for a given Uniswap V3 pool.
 * Uses a simple time-based cache.
 *
 * @param {string} poolAddress The address of the Uniswap V3 pool.
 * @returns {Promise<object|null>} Object containing { sqrtPriceX96, tick, liquidity, fee } or null if fetching fails.
 */
async function getPoolInfo(poolAddress) {
    const provider = getProvider();
    if (!provider) {
        logger.error("[PoolDataProvider] Provider not available.");
        return null;
    }
    if (!ethers.isAddress(poolAddress)) {
         logger.error(`[PoolDataProvider] Invalid pool address provided: ${poolAddress}`);
         return null;
    }

    const cacheKey = poolAddress.toLowerCase();
    const cached = poolDataCache.get(cacheKey);
    const now = Date.now();

    // --- Cache Check ---
    // Disabling cache for now to ensure fresh data for debugging simulation issues
    /*
    if (cached && (now - cached.timestamp < CACHE_TTL)) {
        // logger.debug(`[PoolDataProvider] Cache hit for pool ${poolAddress}`);
        return cached.data;
    }
    */
    // --- End Cache Check ---


    try {
        const poolContract = new ethers.Contract(poolAddress, IUniswapV3PoolABI, provider);

        // Fetch data concurrently
        const [slot0, liquidity, fee] = await Promise.all([
            poolContract.slot0(),
            poolContract.liquidity(),
            poolContract.fee() // Fee is immutable, could be cached more aggressively
        ]);

        if (!slot0) {
            logger.warn(`[PoolDataProvider] Failed to fetch slot0 for pool ${poolAddress}`);
            return null;
        }

        const poolState = {
            sqrtPriceX96: slot0.sqrtPriceX96,
            tick: Number(slot0.tick), // Convert BigInt tick to Number for SDK Pool constructor
            liquidity: liquidity,
            fee: Number(fee) // Convert fee BigInt to Number
        };

        // --- Update Cache ---
        poolDataCache.set(cacheKey, { data: poolState, timestamp: now });
        // --- End Update Cache ---

        // logger.debug(`[PoolDataProvider] Fetched live state for pool ${poolAddress}: Tick ${poolState.tick}, Liq ${poolState.liquidity.toString()}, Fee ${poolState.fee}`);
        return poolState;

    } catch (error) {
        logger.error(`[PoolDataProvider] Error fetching state for pool ${poolAddress}: ${error.message}`);
        // Remove potentially stale cache entry on error
        poolDataCache.delete(cacheKey);
        return null;
    }
}


/**
 * Fetches states for multiple pools, potentially using multicall for efficiency.
 * @param {string[]} poolAddresses Array of pool addresses.
 * @returns {Promise<Map<string, object>>} A map where keys are pool addresses and values are pool state objects.
 */
async function getMultiplePoolInfos(poolAddresses) {
    // TODO: Implement multicall for efficiency when fetching many pools
    // For now, fetch sequentially with individual caching via getPoolInfo
    const results = new Map();
    for (const address of poolAddresses) {
        const info = await getPoolInfo(address);
        if (info) {
            results.set(address.toLowerCase(), { address: address, ...info }); // Store with address key
        } else {
             results.set(address.toLowerCase(), null); // Indicate failure for this pool
        }
    }
    return results;
}


module.exports = {
    getPoolInfo,
    getMultiplePoolInfos,
};
