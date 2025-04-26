// config/helpers/poolLoader.js
// Logic to load and process pool configurations from network-specific definitions and environment variables.

const { ethers } = require('ethers');
const Validators = require('./validators'); // Assumes validators.js is in the same directory
let logger; try { logger = require('../../utils/logger'); } catch(e) { console.error("No logger for poolLoader"); logger = console; }

/**
 * Loads pool configurations based on enabled DEXs and network-specific definitions.
 * Reads pool addresses from environment variables mapped in the network config.
 *
 * @param {object} baseTokens - The TOKENS object from baseConfig.TOKENS.
 * @param {object} networkSpecificConfig - The loaded network-specific config (e.g., arbitrum.js content).
 * @param {boolean} isV3Enabled - Flag indicating if Uniswap V3 is enabled.
 * @param {boolean} isSushiEnabled - Flag indicating if SushiSwap is enabled.
 * @param {boolean} isDodoEnabled - Flag indicating if DODO is enabled.
 * @returns {Array<object>} - An array of processed pool configuration objects.
 */
function loadPoolConfigs(baseTokens, networkSpecificConfig, isV3Enabled, isSushiEnabled, isDodoEnabled) {
    logger.debug('[Pool Loader] Starting pool configuration loading...');
    const allPoolConfigs = [];
    const loadedPoolAddresses = new Set(); // Track unique addresses across all DEX types

    // --- Process Uniswap V3 Pools ---
    if (isV3Enabled && networkSpecificConfig.UNISWAP_V3_POOLS && Array.isArray(networkSpecificConfig.UNISWAP_V3_POOLS)) {
        logger.debug(`[Pool Loader] Processing ${networkSpecificConfig.UNISWAP_V3_POOLS.length} V3 pool groups...`);
        for (const group of networkSpecificConfig.UNISWAP_V3_POOLS) {
            const token0 = baseTokens[group.token0Symbol];
            const token1 = baseTokens[group.token1Symbol];
            if (!token0 || !token1) {
                logger.warn(`[Pool Loader] V3 Group ${group.name}: Skipping due to missing token definition for ${group.token0Symbol} or ${group.token1Symbol}.`);
                continue;
            }
            const pairTokenObjects = [token0, token1]; // Store actual token objects

            if (!group.feeTierToEnvMap || typeof group.feeTierToEnvMap !== 'object') {
                 logger.warn(`[Pool Loader] V3 Group ${group.name}: Skipping due to missing or invalid feeTierToEnvMap.`);
                 continue;
            }

            for (const feeTierStr in group.feeTierToEnvMap) {
                const envVarName = group.feeTierToEnvMap[feeTierStr];
                if (!envVarName || typeof envVarName !== 'string') continue;

                const fee = parseInt(feeTierStr, 10);
                if (isNaN(fee)) {
                    logger.warn(`[Pool Loader] V3 Group ${group.name}: Invalid fee tier string "${feeTierStr}". Skipping.`);
                    continue;
                }

                const poolAddress = Validators.validateAndNormalizeAddress(process.env[envVarName], envVarName);
                if (poolAddress && poolAddress !== ethers.ZeroAddress) {
                    const lowerCaseAddress = poolAddress.toLowerCase();
                    if (loadedPoolAddresses.has(lowerCaseAddress)) {
                        logger.debug(`[Pool Loader] V3 Group ${group.name}: Skipping duplicate pool address ${poolAddress}.`);
                        continue;
                    }
                    allPoolConfigs.push({
                        address: poolAddress,
                        dexType: 'uniswapV3',
                        fee: fee,
                        token0Symbol: group.token0Symbol, // Keep symbols for reference
                        token1Symbol: group.token1Symbol,
                        pair: pairTokenObjects, // Include the actual token objects
                        groupName: group.name || 'N/A'
                    });
                    loadedPoolAddresses.add(lowerCaseAddress);
                    logger.debug(`[Pool Loader] Added V3 Pool: ${poolAddress} (${group.name} ${fee}bps)`);
                } else if (process.env[envVarName]) {
                     logger.warn(`[Pool Loader] V3 Group ${group.name}: Invalid address found for env var ${envVarName}: "${process.env[envVarName]}".`);
                }
            }
        }
    } else if (isV3Enabled) {
         logger.warn("[Pool Loader] Uniswap V3 enabled but no UNISWAP_V3_POOLS found or invalid in network config.");
    }

    // --- Process SushiSwap Pools ---
    if (isSushiEnabled && networkSpecificConfig.SUSHISWAP_POOLS && Array.isArray(networkSpecificConfig.SUSHISWAP_POOLS)) {
         logger.debug(`[Pool Loader] Processing ${networkSpecificConfig.SUSHISWAP_POOLS.length} SushiSwap pools...`);
         for (const poolInfo of networkSpecificConfig.SUSHISWAP_POOLS) {
             const token0 = baseTokens[poolInfo.token0Symbol];
             const token1 = baseTokens[poolInfo.token1Symbol];
             if (!token0 || !token1) {
                 logger.warn(`[Pool Loader] Sushi Pool ${poolInfo.name}: Skipping due to missing token definition for ${poolInfo.token0Symbol} or ${poolInfo.token1Symbol}.`);
                 continue;
             }
             const pairTokenObjects = [token0, token1];
             const envVarName = poolInfo.poolAddressEnv;
             if (!envVarName || typeof envVarName !== 'string') {
                  logger.warn(`[Pool Loader] Sushi Pool ${poolInfo.name}: Skipping due to missing poolAddressEnv.`);
                  continue;
             }
             const poolAddress = Validators.validateAndNormalizeAddress(process.env[envVarName], envVarName);
             if (poolAddress && poolAddress !== ethers.ZeroAddress) {
                 const lowerCaseAddress = poolAddress.toLowerCase();
                 if (loadedPoolAddresses.has(lowerCaseAddress)) {
                     logger.debug(`[Pool Loader] Sushi Pool ${poolInfo.name}: Skipping duplicate pool address ${poolAddress}.`);
                     continue;
                 }
                 const feeBps = poolInfo.fee; // Standard Sushi fee is usually 30bps (0.3%)
                 if (typeof feeBps !== 'number' || isNaN(feeBps)) {
                     logger.warn(`[Pool Loader] Sushi Pool ${poolInfo.name}: Invalid or missing fee, using default? Verify config.`);
                 }
                 allPoolConfigs.push({
                     address: poolAddress,
                     dexType: 'sushiswap',
                     fee: feeBps, // Store the configured fee
                     token0Symbol: poolInfo.token0Symbol,
                     token1Symbol: poolInfo.token1Symbol,
                     pair: pairTokenObjects,
                     groupName: poolInfo.name || 'N/A'
                 });
                 loadedPoolAddresses.add(lowerCaseAddress);
                 logger.debug(`[Pool Loader] Added Sushi Pool: ${poolAddress} (${poolInfo.name})`);
             } else if (process.env[envVarName]) {
                  logger.warn(`[Pool Loader] Sushi Pool ${poolInfo.name}: Invalid address found for env var ${envVarName}: "${process.env[envVarName]}".`);
             }
         }
    } else if (isSushiEnabled) {
         logger.warn("[Pool Loader] SushiSwap enabled but no SUSHISWAP_POOLS found or invalid in network config.");
    }

    // --- Process DODO Pools ---
    if (isDodoEnabled && networkSpecificConfig.DODO_POOLS && Array.isArray(networkSpecificConfig.DODO_POOLS)) {
         logger.debug(`[Pool Loader] Processing ${networkSpecificConfig.DODO_POOLS.length} DODO pools...`);
         for (const poolInfo of networkSpecificConfig.DODO_POOLS) {
             const token0 = baseTokens[poolInfo.token0Symbol];
             const token1 = baseTokens[poolInfo.token1Symbol];
             if (!token0 || !token1) {
                 logger.warn(`[Pool Loader] DODO Pool ${poolInfo.name}: Skipping due to missing token definition for ${poolInfo.token0Symbol} or ${poolInfo.token1Symbol}.`);
                 continue;
             }
             const pairTokenObjects = [token0, token1];
             // DODO needs the base token symbol specified correctly
             if (!poolInfo.baseTokenSymbol || (poolInfo.baseTokenSymbol !== poolInfo.token0Symbol && poolInfo.baseTokenSymbol !== poolInfo.token1Symbol)) {
                 logger.warn(`[Pool Loader] DODO Pool ${poolInfo.name}: Skipping due to missing or invalid baseTokenSymbol.`);
                 continue;
             }
             const envVarName = poolInfo.poolAddressEnv;
             if (!envVarName || typeof envVarName !== 'string') {
                 logger.warn(`[Pool Loader] DODO Pool ${poolInfo.name}: Skipping due to missing poolAddressEnv.`);
                 continue;
             }
             const poolAddress = Validators.validateAndNormalizeAddress(process.env[envVarName], envVarName);
             if (poolAddress && poolAddress !== ethers.ZeroAddress) {
                 const lowerCaseAddress = poolAddress.toLowerCase();
                 if (loadedPoolAddresses.has(lowerCaseAddress)) {
                     logger.debug(`[Pool Loader] DODO Pool ${poolInfo.name}: Skipping duplicate pool address ${poolAddress}.`);
                     continue;
                 }
                 const feeBps = poolInfo.fee; // DODO fees are complex, config value might be indicative
                 if (feeBps !== undefined && (typeof feeBps !== 'number' || isNaN(feeBps))) {
                     logger.warn(`[Pool Loader] DODO Pool ${poolInfo.name}: Invalid fee format.`);
                 }
                 allPoolConfigs.push({
                     address: poolAddress,
                     dexType: 'dodo',
                     fee: feeBps, // Store configured indicative fee
                     token0Symbol: poolInfo.token0Symbol,
                     token1Symbol: poolInfo.token1Symbol,
                     pair: pairTokenObjects,
                     baseTokenSymbol: poolInfo.baseTokenSymbol, // Crucial for DODO fetcher
                     groupName: poolInfo.name || 'N/A'
                 });
                 loadedPoolAddresses.add(lowerCaseAddress);
                 logger.debug(`[Pool Loader] Added DODO Pool: ${poolAddress} (${poolInfo.name})`);
             } else if (process.env[envVarName]) {
                 logger.warn(`[Pool Loader] DODO Pool ${poolInfo.name}: Invalid address found for env var ${envVarName}: "${process.env[envVarName]}".`);
             }
         }
    } else if (isDodoEnabled) {
         logger.warn("[Pool Loader] DODO enabled but no DODO_POOLS found or invalid in network config.");
    }

    logger.info(`[Pool Loader] Finished processing. Total unique pools loaded: ${loadedPoolAddresses.size}`);
    if (loadedPoolAddresses.size === 0 && (isV3Enabled || isSushiEnabled || isDodoEnabled)) {
        logger.error("[Pool Loader] CRITICAL WARNING: DEXs are enabled but NO pool addresses were loaded from .env variables. Check network config and .env mappings.");
    }

    return allPoolConfigs;
}

module.exports = {
    loadPoolConfigs,
};
