// core/fetchers/sushiSwapFetcher.js
const { ethers } = require('ethers');
// *** CORRECTED PATHS ***
const logger = require('../../utils/logger');
const { ArbitrageError } = require('../../utils/errorHandler');
const { Token } = require('@uniswap/sdk-core');
const { TOKENS } = require('../../constants/tokens');
const { getCanonicalPairKey } = require('../../utils/pairUtils'); // Correct path

const SUSHI_PAIR_ABI = [
    "function getReserves() external view returns (uint112 _reserve0, uint112 _reserve1, uint32 _blockTimestampLast)",
    "function token0() external view returns (address)",
    "function token1() external view returns (address)"
];

class SushiSwapFetcher {
    constructor(config) {
        if (!config || !config.PRIMARY_RPC_URL) { throw new ArbitrageError('SushiSwapFetcher requires config with PRIMARY_RPC_URL.', 'INITIALIZATION_ERROR'); }
        this.provider = config.provider || new ethers.JsonRpcProvider(config.PRIMARY_RPC_URL);
        this.config = config;
        this.poolContractCache = {};
        logger.debug('[SushiSwapFetcher] Initialized.');
    }

    _getPoolContract(poolAddress) {
       const lowerCaseAddress = poolAddress.toLowerCase();
        if (!this.poolContractCache[lowerCaseAddress]) {
            try {
                this.poolContractCache[lowerCaseAddress] = new ethers.Contract( poolAddress, SUSHI_PAIR_ABI, this.provider );
            } catch (error) { logger.error(`[SushiSwapFetcher] Error creating contract for ${poolAddress}: ${error.message}`); throw error; }
        }
        return this.poolContractCache[lowerCaseAddress];
    }

    async fetchPoolData(address, pair) { // pair is [tokenObjectA, tokenObjectB]
        const logPrefix = `[SushiSwapFetcher Pool ${address.substring(0,6)}]`;
        const poolInfo = this.config.POOL_CONFIGS?.find(p => p.address.toLowerCase() === address.toLowerCase());
        if (!poolInfo) {
             logger.warn(`${logPrefix} Pool info not found for address ${address}.`);
             return { success: false, poolData: null, error: 'Pool info not found in config' };
        }
        const { fee, groupName } = poolInfo; // Get fee, groupName from poolInfo
        logger.debug(`${logPrefix} Fetching state (${groupName})`);

        try {
            const [token0, token1] = pair; // Get token objects from pair arg
             if (!token0 || !token1 || !token0.symbol || !token1.symbol) {
                 return { success: false, poolData: null, error: `Invalid token objects received.` };
             }

            const poolContract = this._getPoolContract(address);
            const reserves = await poolContract.getReserves({ blockTag: 'latest' });

            if (!reserves || typeof reserves._reserve0 === 'undefined' || typeof reserves._reserve1 === 'undefined') {
                throw new Error(`Invalid Reserves Data from RPC.`);
            }
            const reserve0 = BigInt(reserves._reserve0);
            const reserve1 = BigInt(reserves._reserve1);

            if (reserve0 === 0n || reserve1 === 0n) {
                logger.debug(`${logPrefix} Zero reserves found (${reserve0}, ${reserve1}).`);
            }

            const pairKey = getCanonicalPairKey(token0, token1); // Use token objects
            if (!pairKey) { throw new Error(`Failed to generate canonical pair key.`); }

            const poolData = {
                address: address, dexType: 'sushiswap', fee: fee, // Use fee from poolInfo
                reserve0: reserve0, reserve1: reserve1,
                token0: token0, token1: token1, // Store token objects
                token0Symbol: token0.symbol, token1Symbol: token1.symbol, // Get symbols from objects
                groupName: groupName || 'N/A', pairKey: pairKey,
                sqrtPriceX96: null, liquidity: null, tick: null, tickSpacing: null, // V3 specific
                timestamp: Date.now()
            };
             return { success: true, poolData: poolData, error: null };

        } catch (error) {
             if (error.code === 'CALL_EXCEPTION') { logger.warn(`${logPrefix} Call exception: ${error.reason}`); }
             else { logger.warn(`${logPrefix} Failed state fetch: ${error.message}`); }
            return { success: false, poolData: null, error: error.message };
        }
    }
}
module.exports = SushiSwapFetcher;
