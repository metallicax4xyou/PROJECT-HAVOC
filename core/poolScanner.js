// /workspaces/arbitrum-flash/core/poolScanner.js
// --- REFACTORED VERSION ---
// Uses dedicated fetchers, keeps opportunity finding logic here for now.

const { ethers } = require('ethers');
const { Token } = require('@uniswap/sdk-core');
const logger = require('../utils/logger');
const { ArbitrageError, handleError } = require('../utils/errorHandler');
const { getScaledPriceRatio, formatScaledBigIntForLogging } = require('./scannerUtils'); // Keep utils needed for finders

// --- Import Fetchers ---
const UniswapV3Fetcher = require('./fetchers/uniswapV3Fetcher');
const SushiSwapFetcher = require('./fetchers/sushiSwapFetcher');
// --- ---

const BIGNUM_SCALE_DECIMALS = 36;
const BIGNUM_SCALE = 10n ** BigInt(BIGNUM_SCALE_DECIMALS);
const PROFIT_THRESHOLD_SCALED = (10005n * BIGNUM_SCALE) / 10000n; // 1.0005x scaled profit threshold
const LOG_ALL_TRIANGLES = true; // Keep true for debugging V3 triangular paths


class PoolScanner {
    constructor(config, provider) {
        logger.debug(`[PoolScanner Refactored] Initializing...`);
        if (!config || !provider) {
            throw new ArbitrageError('PoolScanner requires config and provider.', 'INITIALIZATION_ERROR');
        }
        this.config = config;
        this.provider = provider;

        // Instantiate Fetchers
        try {
            this.v3Fetcher = new UniswapV3Fetcher(provider);
            this.sushiFetcher = new SushiSwapFetcher(provider);
        } catch (fetcherError) {
            logger.error(`[PoolScanner Refactored] Failed to initialize fetchers: ${fetcherError.message}`);
            throw fetcherError;
        }
        logger.info(`[PoolScanner Refactored] Initialized with V3 and Sushi Fetchers.`);
    }

    /**
     * Fetches live states for all configured pools using dedicated fetchers.
     * @param {Array<object>} poolInfos Array of pool configuration objects from config.
     * @returns {Promise<object>} A map of poolAddress.toLowerCase() to its live state object, or an empty object if fetch fails.
     */
    async fetchPoolStates(poolInfos) {
        logger.debug(`[PoolScanner Refactored] Received ${poolInfos?.length ?? 0} poolInfos to fetch.`);
        if (!poolInfos || poolInfos.length === 0) {
            logger.warn('[PoolScanner Refactored] No pool configurations provided.');
            return {};
        }
        logger.info(`[PoolScanner Refactored] Delegating state fetching for ${poolInfos.length} pools...`);

        const fetchPromises = [];

        for (const poolInfo of poolInfos) {
            if (!poolInfo || !poolInfo.address || !poolInfo.dexType) {
                logger.warn(`[PoolScanner Refactored] Skipping invalid poolInfo (missing address or dexType): ${JSON.stringify(poolInfo)}`);
                continue;
            }

            if (poolInfo.dexType === 'uniswapV3') {
                fetchPromises.push(this.v3Fetcher.fetchPoolState(poolInfo));
            } else if (poolInfo.dexType === 'sushiswap') {
                fetchPromises.push(this.sushiFetcher.fetchPoolState(poolInfo));
            } else {
                logger.warn(`[PoolScanner Refactored] Skipping pool ${poolInfo.address}: Unsupported dexType '${poolInfo.dexType}'`);
            }
        }

        if (fetchPromises.length === 0) {
            logger.warn('[PoolScanner Refactored] No valid pools to fetch states for.');
            return {};
        }

        const livePoolStates = {};
        try {
            const results = await Promise.all(fetchPromises); // Fetch promises directly return state object or null

            for (const state of results) {
                if (state && state.address) { // Check if fetch was successful and returned a valid state object
                    livePoolStates[state.address.toLowerCase()] = state;
                }
                // Errors/nulls are already logged within the fetcher methods
            }
        } catch (error) { // Catch errors from Promise.all itself (less likely now)
            logger.error(`[PoolScanner Refactored] CRITICAL Error during Promise.all execution: ${error.message}`);
            if (typeof handleError === 'function') handleError(error, 'PoolScanner.fetchPoolStates.PromiseAll');
            return {}; // Return empty on critical error
        }

        const finalCount = Object.keys(livePoolStates).length;
        const attemptedCount = fetchPromises.length;
        logger.info(`[PoolScanner Refactored] Successfully processed states for ${finalCount} out of ${attemptedCount} attempted pools.`);
        if (finalCount < attemptedCount) {
             logger.warn(`[PoolScanner Refactored] ${attemptedCount - finalCount} pools failed to fetch/process. Check previous logs.`);
        }
        return livePoolStates;
    } // --- End fetchPoolStates ---


    // --- Opportunity Finding Logic (Kept here for now, can be refactored later) ---

    // --- findTriangularOpportunities (V3 only) ---
    findTriangularOpportunities(livePoolStatesMap) {
        // Filter for V3 pools only
        const v3PoolStates = {};
        for (const addr in livePoolStatesMap) {
            if (livePoolStatesMap[addr].dexType === 'uniswapV3' && livePoolStatesMap[addr].sqrtPriceX96 !== null) {
                v3PoolStates[addr] = livePoolStatesMap[addr];
            }
        }
        logger.info(`[PoolScanner] Starting V3 triangular opportunity scan with ${Object.keys(v3PoolStates).length} live V3 pool states.`);
        const opportunities = [];
        if (!v3PoolStates || Object.keys(v3PoolStates).length < 3) {
             logger.info('[PoolScanner V3 Tri] Not enough live V3 pool states (< 3).');
             return opportunities;
        }
        const tokenGraph = {};
        if (LOG_ALL_TRIANGLES) logger.debug('[PoolScanner V3 Tri] Building token graph...');
        for (const poolAddress in v3PoolStates) { /* ... (graph building logic) ... */ }
        if (LOG_ALL_TRIANGLES) logger.debug(`[PoolScanner V3 Tri] Token graph built. Tokens: ${Object.keys(tokenGraph).join(', ')}`);
        logger.debug(`[PoolScanner V3 Tri] Starting triangle detection...`);
        const checkedTriangles = new Set();
        for (const tokenASymbol in tokenGraph) { /* ... (triangle detection loop) ... */
            try { /* ... (price calculation) ... */
                if (rateWithFees_scaled > PROFIT_THRESHOLD_SCALED) { /* ... (log and add opportunity) ... */
                     const opportunity = { type: 'triangularV3', /*...*/ };
                     opportunities.push(opportunity);
                }
            } catch (error) { /* ... (log error) ... */ }
        }
        logger.info(`[PoolScanner V3 Tri] Scan finished. Found ${opportunities.length} potential V3 triangular opportunities.`);
        return opportunities;
    } // --- END findTriangularOpportunities ---


    // --- findSpatialOpportunities (V3 vs Sushi) ---
    findSpatialOpportunities(livePoolStatesMap) {
        logger.info(`[PoolScanner Spatial] Starting spatial (UniV3 vs SushiSwap) opportunity scan...`);
        const opportunities = [];
        const checkedPairings = new Set();
        const poolsByPair = {};
        for (const address in livePoolStatesMap) { /* ... (grouping logic by pair/dexType) ... */ }

        for (const pairKey in poolsByPair) {
            const pairPools = poolsByPair[pairKey];
            if (pairPools.uniswapV3.length === 0 || pairPools.sushiswap.length === 0) continue;
            logger.debug(`[PoolScanner Spatial] Checking pair: ${pairKey}`);
            for (const v3Pool of pairPools.uniswapV3) {
                for (const sushiPool of pairPools.sushiswap) {
                    const pairingId = `${v3Pool.address}-${sushiPool.address}`;
                    if (checkedPairings.has(pairingId)) continue; checkedPairings.add(pairingId);
                    try {
                        const priceV3 = this._calculateV3Price(v3Pool);
                        const priceSushi = this._calculateSushiPrice(sushiPool);
                        if (priceV3 === null || priceSushi === null) continue;
                        logger.debug(`  Pairing: ${v3Pool.groupName}(${v3Pool.fee}) vs ${sushiPool.groupName} | V3 Price: ${formatScaledBigIntForLogging(priceV3, BIGNUM_SCALE_DECIMALS)} | Sushi Price: ${formatScaledBigIntForLogging(priceSushi, BIGNUM_SCALE_DECIMALS)}`);
                        // --- Check Opportunities (Buy Sushi->Sell V3 AND Buy V3->Sell Sushi) ---
                        const TEN_THOUSAND = 10000n; /*...*/
                        // Scenario 1: Buy Sushi, Sell V3
                        const effectiveSushiBuyPrice = /*...*/; const effectiveV3SellPrice = /*...*/;
                        if (effectiveV3SellPrice > (effectiveSushiBuyPrice * PROFIT_THRESHOLD_SCALED) / BIGNUM_SCALE) { /* ... (log and add opportunity) ... */
                            const opportunity = { type: 'spatial', buyPool: sushiPool, sellPool: v3Pool, /*...*/ };
                            opportunities.push(opportunity);
                        }
                        // Scenario 2: Buy V3, Sell Sushi
                        const effectiveV3BuyPrice = /*...*/; const effectiveSushiSellPrice = /*...*/;
                         if (effectiveSushiSellPrice > (effectiveV3BuyPrice * PROFIT_THRESHOLD_SCALED) / BIGNUM_SCALE) { /* ... (log and add opportunity) ... */
                             const opportunity = { type: 'spatial', buyPool: v3Pool, sellPool: sushiPool, /*...*/ };
                             opportunities.push(opportunity);
                         }
                    } catch (priceError) { /* ... (log error) ... */ }
                } // End Sushi loop
            } // End V3 loop
        } // End pair loop
        logger.info(`[PoolScanner Spatial] Scan finished. Found ${opportunities.length} potential spatial opportunities.`);
        return opportunities;
    } // --- END findSpatialOpportunities ---


    // --- Price Calculation Helpers (Kept here for now) ---

    _calculateV3Price(poolState) {
         if (!poolState || !poolState.sqrtPriceX96 || poolState.sqrtPriceX96 <= 0n || !poolState.token0 || !poolState.token1) return null;
         try {
             const priceRatioX96_scaled = getScaledPriceRatio(poolState.sqrtPriceX96, BIGNUM_SCALE);
             const price_scaled = (priceRatioX96_scaled * priceRatioX96_scaled) / BIGNUM_SCALE;
             const decimals0 = BigInt(poolState.token0.decimals); const decimals1 = BigInt(poolState.token1.decimals);
             const decimalDiff = decimals1 - decimals0;
             let adjustedPrice_scaled;
             if (decimalDiff >= 0n) { adjustedPrice_scaled = price_scaled * (10n ** decimalDiff); }
             else { const divisor = 10n ** (-decimalDiff); if (divisor === 0n) return null; adjustedPrice_scaled = price_scaled / divisor; }
             return adjustedPrice_scaled;
         } catch (e) { logger.error(`Error in _calculateV3Price for ${poolState.address}: ${e.message}`); return null; }
     }

    _calculateSushiPrice(poolState) {
         if (!poolState || !poolState.reserve0 || !poolState.reserve1 || poolState.reserve0 <= 0n || poolState.reserve1 <= 0n || !poolState.token0 || !poolState.token1) return null;
         try {
              const reserve0 = poolState.reserve0; const reserve1 = poolState.reserve1;
              const decimals0 = BigInt(poolState.token0.decimals); const decimals1 = BigInt(poolState.token1.decimals);
              const scale = BIGNUM_SCALE; let price_scaled;
              if (decimals1 >= decimals0) { const factor = 10n ** (decimals1 - decimals0); if (reserve0 * factor === 0n) return null; price_scaled = (reserve1 * scale) / (reserve0 * factor); }
              else { const factor = 10n ** (decimals0 - decimals1); price_scaled = (reserve1 * factor * scale) / reserve0; }
              return price_scaled;
         } catch (e) { logger.error(`Error in _calculateSushiPrice for ${poolState.address}: ${e.message}`); return null; }
     }
    // --- ---

} // --- END PoolScanner Class ---

module.exports = { PoolScanner }; // Keep exporting the main class
