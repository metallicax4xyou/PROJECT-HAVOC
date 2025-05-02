// core/fetchers/uniswapV3Fetcher.js
// --- VERSION v1.3 --- Added debug log for raw fetched UniV3 state.

const { ethers } = require('ethers');
// *** CORRECTED PATHS ***
const { ABIS } = require('../../constants/abis');
const logger = require('../../utils/logger');
const { ArbitrageError } = require('../../utils/errorHandler');
const { Token } = require('@uniswap/sdk-core');
const { TOKENS } = require('../../constants/tokens');
const { getTickSpacingFromFeeBps } = require('../scannerUtils'); // Path ok relative to core/
const { getCanonicalPairKey } = require('../../utils/pairUtils'); // Correct path
const { getProvider } = require('../../utils/provider'); // Ensure getProvider is imported if used elsewhere

const MAX_UINT128 = (1n << 128n) - 1n;

class UniswapV3Fetcher {
    constructor(config) {
        if (!config || !config.PRIMARY_RPC_URL) { throw new ArbitrageError('UniswapV3Fetcher requires config with PRIMARY_RPC_URL.', 'INITIALIZATION_ERROR'); }
        // Use the global provider instance passed from bot.js or retrieved via getProvider()
        this.provider = config.provider || getProvider();
        this.config = config;
        this.poolContractCache = {};
        logger.debug('[UniswapV3Fetcher] Initialized.');
    }

    _getPoolContract(poolAddress) {
        const lowerCaseAddress = poolAddress.toLowerCase();
        if (!this.poolContractCache[lowerCaseAddress]) {
            try {
                if (!ABIS || !ABIS.UniswapV3Pool) {
                    // Attempt to load ABI if not already loaded via constants/abis.js
                    try {
                         const { abi: UniswapV3PoolABI } = require('@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json');
                         this.poolContractCache[lowerCaseAddress] = new ethers.Contract( poolAddress, UniswapV3PoolABI, this.provider );
                    } catch (loadError) {
                         throw new Error(`UniswapV3Pool ABI not found or could not be loaded: ${loadError.message}`);
                    }
                } else {
                     this.poolContractCache[lowerCaseAddress] = new ethers.Contract( poolAddress, ABIS.UniswapV3Pool, this.provider );
                }
            } catch (error) {
                 // Use error log level for contract creation failure
                 logger.error(`[UniswapV3Fetcher] Error creating contract for ${poolAddress}: ${error.message}`);
                 // Rethrow the error so it's caught upstream during initialization if critical
                 throw error;
            }
        }
        return this.poolContractCache[lowerCaseAddress];
    }


    async fetchPoolData(address, pair) { // pair is [tokenObjectA, tokenObjectB]
        const logPrefix = `[UniswapV3Fetcher Pool ${address.substring(0,6)}]`;
        const poolInfo = this.config.POOL_CONFIGS?.find(p => p.address.toLowerCase() === address.toLowerCase());
        if (!poolInfo) {
             logger.warn(`${logPrefix} Pool info not found in config for address ${address}.`);
             return { success: false, poolData: null, error: 'Pool info not found in config' };
        }
        const { fee, token0Symbol, token1Symbol, groupName } = poolInfo;
        logger.debug(`${logPrefix} Fetching state (${groupName} ${fee}bps)`);

        try {
            // Get token objects directly from pair argument
            const [token0, token1] = pair;
             if (!token0 || !token1 || !token0.symbol || !token1.symbol || !token0.address || !token1.address || token0.decimals === undefined || token1.decimals === undefined) { // More robust check
                 const errorMsg = `Invalid or incomplete token objects received in pair argument.`;
                 logger.error(`${logPrefix} ${errorMsg}`);
                 return { success: false, poolData: null, error: errorMsg };
             }

            const poolContract = this._getPoolContract(address);

            // Use Promise.allSettled for robustness against individual RPC errors
            const [slot0Result, liquidityResult] = await Promise.allSettled([
                poolContract.slot0({ blockTag: 'latest' }),
                poolContract.liquidity({ blockTag: 'latest' })
            ]);

            // Check results status before accessing values
            if (slot0Result.status !== 'fulfilled') {
                const reason = slot0Result.reason instanceof Error ? slot0Result.reason.message : JSON.stringify(slot0Result.reason);
                throw new Error(`Failed to fetch slot0: ${reason}`);
            }
             if (liquidityResult.status !== 'fulfilled') {
                const reason = liquidityResult.reason instanceof Error ? liquidityResult.reason.message : JSON.stringify(liquidityResult.reason);
                throw new Error(`Failed to fetch liquidity: ${reason}`);
            }


            const slot0 = slot0Result.value;
            const liquidity = liquidityResult.value;

            // Validate fetched data structure and presence
            if (slot0 == null || typeof slot0.sqrtPriceX96 === 'undefined' || typeof slot0.tick === 'undefined' || liquidity == null) {
                 const errorMsg = `Invalid State Data from RPC: slot0=${JSON.stringify(slot0)}, liquidity=${liquidity}`;
                 logger.error(`${logPrefix} ${errorMsg}`);
                 throw new Error(errorMsg);
            }

            const currentSqrtPriceX96 = BigInt(slot0.sqrtPriceX96);
            const currentLiquidity = BigInt(liquidity);
            const currentTick = Number(slot0.tick);

            // --- ADD DEBUG LOG FOR RAW FETCHED DATA ---
            logger.debug(`${logPrefix} Fetched Raw Data: sqrtPriceX96=${currentSqrtPriceX96.toString()}, liquidity=${currentLiquidity.toString()}, tick=${currentTick.toString()}`);
            // --- END DEBUG LOG ---


            if (currentLiquidity > MAX_UINT128) {
                // Log a warning for surprisingly large liquidity, but don't necessarily fail the fetch
                logger.warn(`${logPrefix} Liquidity exceeds MAX_UINT128, capping for safety: ${currentLiquidity.toString()}`);
                 // Optionally cap liquidity or skip, for now just log warning and proceed
            }
             // Strict check for zero liquidity
             if (currentLiquidity === 0n) {
                 logger.debug(`${logPrefix} Skipping due to zero liquidity.`);
                 return { success: false, error: 'Zero liquidity' };
             }


            const pairKey = getCanonicalPairKey(token0, token1); // Use token objects from pair arg
            if (!pairKey) {
                 const errorMsg = `Failed to generate canonical pair key for ${token0.symbol}/${token1.symbol}.`;
                 logger.error(`${logPrefix} ${errorMsg}`);
                 return { success: false, poolData: null, error: errorMsg };
            }


            const poolData = {
                address: address,
                dexType: 'uniswapV3',
                fee: fee,
                tick: currentTick,
                liquidity: currentLiquidity,
                sqrtPriceX96: currentSqrtPriceX96,
                tickSpacing: getTickSpacingFromFeeBps(fee),
                token0: token0, // Store token objects
                token1: token1,
                token0Symbol: token0.symbol, // Get symbols from objects
                token1Symbol: token1.symbol,
                groupName: groupName || 'N/A',
                pairKey: pairKey,
                timestamp: Date.now()
            };

            logger.debug(`${logPrefix} Successfully processed fetched state.`);
            return { success: true, poolData: poolData, error: null };

        } catch (error) {
            // Log the specific pool address and the error message at error level
            logger.error(`${logPrefix} Failed to fetch state: ${error.message}`, error);
            return { success: false, poolData: null, error: error.message }; // Return error message
        }
    }

    // UniV3 fetcher might also implement a method to get amountOut for a given amountIn
    // using the Quoter contract, but this is typically handled by the SwapSimulator.
}

module.exports = UniswapV3Fetcher;
