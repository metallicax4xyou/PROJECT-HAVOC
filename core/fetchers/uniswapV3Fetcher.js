// core/fetchers/uniswapV3Fetcher.js
const { ethers } = require('ethers');
// *** CORRECTED PATHS ***
const { ABIS } = require('../../constants/abis');
const logger = require('../../utils/logger');
const { ArbitrageError } = require('../../utils/errorHandler');
const { Token } = require('@uniswap/sdk-core');
const { TOKENS } = require('../../constants/tokens');
const { getTickSpacingFromFeeBps } = require('../scannerUtils'); // Path ok relative to core/
const { getCanonicalPairKey } = require('../../utils/pairUtils'); // Correct path

const MAX_UINT128 = (1n << 128n) - 1n;

class UniswapV3Fetcher {
    constructor(config) {
        if (!config || !config.PRIMARY_RPC_URL) { throw new ArbitrageError('UniswapV3Fetcher requires config with PRIMARY_RPC_URL.', 'INITIALIZATION_ERROR'); }
        this.provider = config.provider || new ethers.JsonRpcProvider(config.PRIMARY_RPC_URL);
        this.config = config;
        this.poolContractCache = {};
        logger.debug('[UniswapV3Fetcher] Initialized.');
    }

    _getPoolContract(poolAddress) {
        const lowerCaseAddress = poolAddress.toLowerCase();
        if (!this.poolContractCache[lowerCaseAddress]) {
            try {
                if (!ABIS || !ABIS.UniswapV3Pool) { throw new Error("UniswapV3Pool ABI not found."); }
                this.poolContractCache[lowerCaseAddress] = new ethers.Contract( poolAddress, ABIS.UniswapV3Pool, this.provider );
            } catch (error) { logger.error(`[UniswapV3Fetcher] Error creating contract for ${poolAddress}: ${error.message}`); throw error; }
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
             if (!token0 || !token1 || !token0.symbol || !token1.symbol) { // Basic check
                 const errorMsg = `Invalid token objects received in pair argument.`;
                 logger.error(`${logPrefix} ${errorMsg}`);
                 return { success: false, poolData: null, error: errorMsg };
             }

            const poolContract = this._getPoolContract(address);
            const [slot0Result, liquidityResult] = await Promise.allSettled([
                poolContract.slot0({ blockTag: 'latest' }),
                poolContract.liquidity({ blockTag: 'latest' })
            ]);

            if (slot0Result.status !== 'fulfilled' || liquidityResult.status !== 'fulfilled') {
                throw new Error(`RPC call failed: ${slot0Result.reason?.message || liquidityResult.reason?.message || 'Unknown'}`);
            }
            const slot0 = slot0Result.value; const liquidity = liquidityResult.value;
            if (slot0 == null || typeof slot0.sqrtPriceX96 === 'undefined' || typeof slot0.tick === 'undefined' || liquidity == null) {
                 throw new Error(`Invalid State Data from RPC.`);
            }
            const currentSqrtPriceX96 = BigInt(slot0.sqrtPriceX96);
            const currentLiquidity = BigInt(liquidity);
            const currentTick = Number(slot0.tick);

            if (currentLiquidity > MAX_UINT128) {
                return { success: false, poolData: null, error: 'Liquidity exceeds MAX_UINT128' };
            }

            const pairKey = getCanonicalPairKey(token0, token1); // Use token objects from pair arg
            if (!pairKey) { throw new Error(`Failed to generate canonical pair key.`); }

            const poolData = {
                address: address, dexType: 'uniswapV3', fee: fee,
                tick: currentTick, liquidity: currentLiquidity, sqrtPriceX96: currentSqrtPriceX96,
                tickSpacing: getTickSpacingFromFeeBps(fee),
                token0: token0, token1: token1, // Store token objects
                token0Symbol: token0.symbol, token1Symbol: token1.symbol, // Get symbols from objects
                groupName: groupName || 'N/A', pairKey: pairKey, timestamp: Date.now()
            };
            return { success: true, poolData: poolData, error: null };

        } catch (error) {
            logger.warn(`${logPrefix} Failed state fetch: ${error.message}`);
            return { success: false, poolData: null, error: error.message };
        }
    }
}
module.exports = UniswapV3Fetcher;
