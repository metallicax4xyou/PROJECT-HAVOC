// config/helpers/poolLoader.js
// --- VERSION v1.3 --- Corrects expected export keys and filenames.

const { ethers } = require('ethers');
const Validators = require('./validators'); // Assumes validators.js is in the same directory
let logger; try { logger = require('../../utils/logger'); } catch(e) { console.error("No logger for poolLoader"); logger = console; }

// --- Helper function to safely require pool definition files ---
function requirePoolFile(networkName, dexType) {
    // Define explicit mappings for filenames and export keys
    const filenameMap = {
        uniswapV3: 'uniswapV3.js',
        sushiSwap: 'sushiSwap.js', // Use the specific filename
        dodo:      'dodo.js'
    };
    const exportKeyMap = {
        uniswapV3: 'UNISWAP_V3_POOLS', // Exact key exported from uniswapV3.js
        sushiSwap: 'SUSHISWAP_POOLS', // Exact key exported from sushiSwap.js
        dodo:      'DODO_POOLS'      // Exact key exported from dodo.js
    };

    const filename = filenameMap[dexType];
    const expectedKey = exportKeyMap[dexType];

    if (!filename || !expectedKey) {
        // This case should not happen if called correctly from loadPoolConfigs
        logger.error(`[Pool Loader] Invalid internal dexType "${dexType}" provided to requirePoolFile.`);
        return [];
    }

    const filePath = `../pools/${networkName}/${filename}`; // Path relative to this helper file
    try {
        logger.debug(`[Pool Loader] Attempting to load pool file: ${filePath} for key ${expectedKey}`);
        const poolModule = require(filePath); // Dynamic require

        // Check if the module and the specific exported key exist and if it's an array
        if (poolModule && Array.isArray(poolModule[expectedKey])) {
             logger.debug(`[Pool Loader] Successfully loaded ${poolModule[expectedKey].length} pools for ${dexType} using key "${expectedKey}" from ${filePath}`);
             return poolModule[expectedKey]; // Return the array of pool definitions
        } else {
             logger.warn(`[Pool Loader] Pool file found at ${filePath}, but missing, invalid, or not an array export key "${expectedKey}".`);
             return []; // Return empty array if export is wrong
        }
    } catch (error) {
        // Handle file not found gracefully
        if (error.code === 'MODULE_NOT_FOUND') {
            logger.warn(`[Pool Loader] Pool definition file not found for ${dexType} at ${filePath}. Skipping ${dexType} pools.`);
        } else {
            // Log other errors (e.g., syntax errors in the pool file)
            logger.error(`[Pool Loader] Error loading pool file ${filePath}: ${error.message}`);
        }
        return []; // Return empty array if file doesn't exist or fails to load
    }
}
// --- End Helper ---


/**
 * Loads pool configurations based on enabled DEXs by loading dedicated pool files.
 * Reads pool addresses from environment variables mapped in the pool definitions.
 *
 * @param {string} networkName - The name of the network (e.g., 'arbitrum').
 * @param {object} baseTokens - The TOKENS object from baseConfig.TOKENS.
 * @param {boolean} isV3Enabled - Flag indicating if Uniswap V3 is enabled.
 * @param {boolean} isSushiEnabled - Flag indicating if SushiSwap is enabled.
 * @param {boolean} isDodoEnabled - Flag indicating if DODO is enabled.
 * @returns {Array<object>} - An array of processed pool configuration objects.
 */
function loadPoolConfigs(networkName, baseTokens, isV3Enabled, isSushiEnabled, isDodoEnabled) {
    logger.debug('[Pool Loader v1.3] Starting pool configuration loading from dedicated files...'); // Version bump in log
    const allPoolConfigs = [];
    const loadedPoolAddresses = new Set(); // Track unique addresses across all DEX types

    // --- Process Uniswap V3 Pools ---
    if (isV3Enabled) {
        const uniswapV3Pools = requirePoolFile(networkName, 'uniswapV3');
        logger.debug(`[Pool Loader] Processing ${uniswapV3Pools.length} raw V3 pools...`);
        for (const group of uniswapV3Pools) {
            const token0 = baseTokens[group.token0Symbol];
            const token1 = baseTokens[group.token1Symbol];
            if (!token0 || !token1) { logger.warn(`[Pool Loader] V3 Group ${group.name}: Skipping due to missing token def: ${group.token0Symbol}/${group.token1Symbol}.`); continue; }
            const pairTokenObjects = [token0, token1];
            if (!group.feeTierToEnvMap || typeof group.feeTierToEnvMap !== 'object') { logger.warn(`[Pool Loader] V3 Group ${group.name}: Skipping due to invalid feeTierToEnvMap.`); continue; }

            for (const feeTierStr in group.feeTierToEnvMap) {
                const envVarName = group.feeTierToEnvMap[feeTierStr];
                if (!envVarName || typeof envVarName !== 'string') continue;
                const fee = parseInt(feeTierStr, 10);
                if (isNaN(fee)) { logger.warn(`[Pool Loader] V3 Group ${group.name}: Invalid fee tier "${feeTierStr}".`); continue; }

                const poolAddress = Validators.validateAndNormalizeAddress(process.env[envVarName], envVarName);
                if (poolAddress && poolAddress !== ethers.ZeroAddress) {
                    const lowerCaseAddress = poolAddress.toLowerCase();
                    if (loadedPoolAddresses.has(lowerCaseAddress)) { continue; } // Skip duplicate
                    allPoolConfigs.push({ address: poolAddress, dexType: 'uniswapV3', fee: fee, token0Symbol: group.token0Symbol, token1Symbol: group.token1Symbol, pair: pairTokenObjects, groupName: group.name || 'N/A' });
                    loadedPoolAddresses.add(lowerCaseAddress);
                    logger.debug(`[Pool Loader] Added V3 Pool: ${poolAddress} (${group.name} ${fee}bps)`);
                } else if (process.env[envVarName]) { logger.warn(`[Pool Loader] V3 Group ${group.name}: Invalid address env var ${envVarName}: "${process.env[envVarName]}".`); }
            }
        }
    } else {
        logger.info("[Pool Loader] Uniswap V3 pools disabled by config.");
    }

    // --- Process SushiSwap Pools ---
    if (isSushiEnabled) {
        const sushiSwapPools = requirePoolFile(networkName, 'sushiSwap'); // Uses helper with corrected maps
        logger.debug(`[Pool Loader] Processing ${sushiSwapPools.length} raw Sushi pools...`);
         for (const poolInfo of sushiSwapPools) {
             const token0 = baseTokens[poolInfo.token0Symbol]; const token1 = baseTokens[poolInfo.token1Symbol];
             if (!token0 || !token1) { logger.warn(`[Pool Loader] Sushi Pool ${poolInfo.name}: Skipping missing token def: ${poolInfo.token0Symbol}/${poolInfo.token1Symbol}.`); continue; }
             const pairTokenObjects = [token0, token1]; const envVarName = poolInfo.poolAddressEnv;
             if (!envVarName || typeof envVarName !== 'string') { logger.warn(`[Pool Loader] Sushi Pool ${poolInfo.name}: Skipping missing poolAddressEnv.`); continue; }
             const poolAddress = Validators.validateAndNormalizeAddress(process.env[envVarName], envVarName);
             if (poolAddress && poolAddress !== ethers.ZeroAddress) {
                 const lowerCaseAddress = poolAddress.toLowerCase(); if (loadedPoolAddresses.has(lowerCaseAddress)) continue;
                 const feeBps = poolInfo.fee; if (typeof feeBps !== 'number' || isNaN(feeBps)) { logger.warn(`[Pool Loader] Sushi Pool ${poolInfo.name}: Invalid fee.`); }
                 allPoolConfigs.push({ address: poolAddress, dexType: 'sushiswap', fee: feeBps, token0Symbol: poolInfo.token0Symbol, token1Symbol: poolInfo.token1Symbol, pair: pairTokenObjects, groupName: poolInfo.name || 'N/A' });
                 loadedPoolAddresses.add(lowerCaseAddress);
                 logger.debug(`[Pool Loader] Added Sushi Pool: ${poolAddress} (${poolInfo.name})`);
             } else if (process.env[envVarName]) { logger.warn(`[Pool Loader] Sushi Pool ${poolInfo.name}: Invalid address env var ${envVarName}: "${process.env[envVarName]}".`); }
         }
    } else {
        logger.info("[Pool Loader] SushiSwap pools disabled by config.");
    }

    // --- Process DODO Pools ---
    if (isDodoEnabled) {
        const dodoPools = requirePoolFile(networkName, 'dodo'); // Uses helper
        logger.debug(`[Pool Loader] Processing ${dodoPools.length} raw DODO pools...`);
         for (const poolInfo of dodoPools) {
             const token0 = baseTokens[poolInfo.token0Symbol]; const token1 = baseTokens[poolInfo.token1Symbol];
             if (!token0 || !token1) { logger.warn(`[Pool Loader] DODO Pool ${poolInfo.name}: Skipping missing token def: ${poolInfo.token0Symbol}/${poolInfo.token1Symbol}.`); continue; }
             const pairTokenObjects = [token0, token1];
             if (!poolInfo.baseTokenSymbol || (poolInfo.baseTokenSymbol !== poolInfo.token0Symbol && poolInfo.baseTokenSymbol !== poolInfo.token1Symbol)) { logger.warn(`[Pool Loader] DODO Pool ${poolInfo.name}: Skipping invalid baseTokenSymbol.`); continue; }
             const envVarName = poolInfo.poolAddressEnv; if (!envVarName || typeof envVarName !== 'string') { logger.warn(`[Pool Loader] DODO Pool ${poolInfo.name}: Skipping missing poolAddressEnv.`); continue; }
             const poolAddress = Validators.validateAndNormalizeAddress(process.env[envVarName], envVarName);
             if (poolAddress && poolAddress !== ethers.ZeroAddress) {
                 const lowerCaseAddress = poolAddress.toLowerCase(); if (loadedPoolAddresses.has(lowerCaseAddress)) continue;
                 const feeBps = poolInfo.fee; if (feeBps !== undefined && (typeof feeBps !== 'number' || isNaN(feeBps))) { logger.warn(`[Pool Loader] DODO Pool ${poolInfo.name}: Invalid fee format.`); }
                 allPoolConfigs.push({ address: poolAddress, dexType: 'dodo', fee: feeBps, token0Symbol: poolInfo.token0Symbol, token1Symbol: poolInfo.token1Symbol, pair: pairTokenObjects, baseTokenSymbol: poolInfo.baseTokenSymbol, groupName: poolInfo.name || 'N/A' });
                 loadedPoolAddresses.add(lowerCaseAddress);
                 logger.debug(`[Pool Loader] Added DODO Pool: ${poolAddress} (${poolInfo.name})`);
             } else if (process.env[envVarName]) { logger.warn(`[Pool Loader] DODO Pool ${poolInfo.name}: Invalid address env var ${envVarName}: "${process.env[envVarName]}".`); }
         }
    } else {
        logger.info("[Pool Loader] DODO pools disabled by config.");
    }

    logger.info(`[Pool Loader v1.3] Finished processing. Total unique pools loaded: ${loadedPoolAddresses.size}`);
    if (loadedPoolAddresses.size === 0 && (isV3Enabled || isSushiEnabled || isDodoEnabled)) {
        logger.error("[Pool Loader v1.3] CRITICAL WARNING: DEXs are enabled but NO pool addresses were loaded. Check .env variables and pool definition files in config/pools/");
    }

    return allPoolConfigs;
}

module.exports = {
    loadPoolConfigs,
};
