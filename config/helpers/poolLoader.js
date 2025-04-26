// config/helpers/poolLoader.js
// --- VERSION v1.2 --- Corrects expected export keys and filenames.

const { ethers } = require('ethers');
const Validators = require('./validators');
let logger; try { logger = require('../../utils/logger'); } catch(e) { console.error("No logger for poolLoader"); logger = console; }

// --- Helper function to safely require pool definition files ---
function requirePoolFile(networkName, dexType) {
    // --- Adjust expected filename casing ---
    const filename = dexType === 'sushiSwap' ? 'sushiSwap.js' : `${dexType}.js`; // Use correct case for sushiSwap
    const filePath = `../pools/${networkName}/${filename}`;
    try {
        logger.debug(`[Pool Loader] Attempting to load pool file: ${filePath}`);
        const poolModule = require(filePath);

        // --- Adjust expected export key format ---
        let expectedKey = `${dexType.toUpperCase()}_POOLS`;
        if (dexType === 'uniswapV3') {
             expectedKey = 'UNISWAP_V3_POOLS'; // Match exact export from file
        } else if (dexType === 'sushiSwap') {
             expectedKey = 'SUSHISWAP_POOLS'; // Match exact export from file
        } else if (dexType === 'dodo') {
             expectedKey = 'DODO_POOLS'; // Match exact export from file
        }
        // --- End adjustment ---

        if (poolModule && Array.isArray(poolModule[expectedKey])) {
             logger.debug(`[Pool Loader] Successfully loaded ${poolModule[expectedKey].length} pools for ${dexType} from ${filePath}`);
             return poolModule[expectedKey];
        } else {
             logger.warn(`[Pool Loader] Pool file found at ${filePath}, but missing or invalid export key "${expectedKey}".`);
             return [];
        }
    } catch (error) {
        if (error.code === 'MODULE_NOT_FOUND') {
            logger.warn(`[Pool Loader] Pool definition file not found for ${dexType} at ${filePath}. Skipping ${dexType} pools.`);
        } else {
            logger.error(`[Pool Loader] Error loading pool file ${filePath}: ${error.message}`);
        }
        return [];
    }
}
// --- End Helper ---

// --- loadPoolConfigs function remains unchanged from v1.1 ---
function loadPoolConfigs(networkName, baseTokens, isV3Enabled, isSushiEnabled, isDodoEnabled) {
    logger.debug('[Pool Loader v1.2] Starting pool configuration loading from dedicated files...'); // Version bump in log
    const allPoolConfigs = [];
    const loadedPoolAddresses = new Set();

    // Process Uniswap V3 Pools
    if (isV3Enabled) {
        const uniswapV3Pools = requirePoolFile(networkName, 'uniswapV3'); // Uses helper
        logger.debug(`[Pool Loader] Processing ${uniswapV3Pools.length} raw V3 pools...`);
        for (const group of uniswapV3Pools) { /* ... V3 processing logic ... */ const token0 = baseTokens[group.token0Symbol]; const token1 = baseTokens[group.token1Symbol]; if (!token0 || !token1) { logger.warn(`[Pool Loader] V3 Group ${group.name}: Skipping due to missing token def: ${group.token0Symbol}/${group.token1Symbol}.`); continue; } const pairTokenObjects = [token0, token1]; if (!group.feeTierToEnvMap || typeof group.feeTierToEnvMap !== 'object') { logger.warn(`[Pool Loader] V3 Group ${group.name}: Skipping due to invalid feeTierToEnvMap.`); continue; } for (const feeTierStr in group.feeTierToEnvMap) { const envVarName = group.feeTierToEnvMap[feeTierStr]; if (!envVarName || typeof envVarName !== 'string') continue; const fee = parseInt(feeTierStr, 10); if (isNaN(fee)) { logger.warn(`[Pool Loader] V3 Group ${group.name}: Invalid fee tier "${feeTierStr}".`); continue; } const poolAddress = Validators.validateAndNormalizeAddress(process.env[envVarName], envVarName); if (poolAddress && poolAddress !== ethers.ZeroAddress) { const lowerCaseAddress = poolAddress.toLowerCase(); if (loadedPoolAddresses.has(lowerCaseAddress)) continue; allPoolConfigs.push({ address: poolAddress, dexType: 'uniswapV3', fee: fee, token0Symbol: group.token0Symbol, token1Symbol: group.token1Symbol, pair: pairTokenObjects, groupName: group.name || 'N/A' }); loadedPoolAddresses.add(lowerCaseAddress); logger.debug(`[Pool Loader] Added V3 Pool: ${poolAddress} (${group.name} ${fee}bps)`); } else if (process.env[envVarName]) { logger.warn(`[Pool Loader] V3 Group ${group.name}: Invalid address env var ${envVarName}: "${process.env[envVarName]}".`); } } }
    }

    // Process SushiSwap Pools
    if (isSushiEnabled) {
        const sushiSwapPools = requirePoolFile(networkName, 'sushiSwap'); // Uses helper with corrected filename lookup
        logger.debug(`[Pool Loader] Processing ${sushiSwapPools.length} raw Sushi pools...`);
         for (const poolInfo of sushiSwapPools) { /* ... Sushi processing logic ... */ const token0 = baseTokens[poolInfo.token0Symbol]; const token1 = baseTokens[poolInfo.token1Symbol]; if (!token0 || !token1) { logger.warn(`[Pool Loader] Sushi Pool ${poolInfo.name}: Skipping missing token def: ${poolInfo.token0Symbol}/${poolInfo.token1Symbol}.`); continue; } const pairTokenObjects = [token0, token1]; const envVarName = poolInfo.poolAddressEnv; if (!envVarName || typeof envVarName !== 'string') { logger.warn(`[Pool Loader] Sushi Pool ${poolInfo.name}: Skipping missing poolAddressEnv.`); continue; } const poolAddress = Validators.validateAndNormalizeAddress(process.env[envVarName], envVarName); if (poolAddress && poolAddress !== ethers.ZeroAddress) { const lowerCaseAddress = poolAddress.toLowerCase(); if (loadedPoolAddresses.has(lowerCaseAddress)) continue; const feeBps = poolInfo.fee; if (typeof feeBps !== 'number' || isNaN(feeBps)) { logger.warn(`[Pool Loader] Sushi Pool ${poolInfo.name}: Invalid fee.`); } allPoolConfigs.push({ address: poolAddress, dexType: 'sushiswap', fee: feeBps, token0Symbol: poolInfo.token0Symbol, token1Symbol: poolInfo.token1Symbol, pair: pairTokenObjects, groupName: poolInfo.name || 'N/A' }); loadedPoolAddresses.add(lowerCaseAddress); logger.debug(`[Pool Loader] Added Sushi Pool: ${poolAddress} (${poolInfo.name})`); } else if (process.env[envVarName]) { logger.warn(`[Pool Loader] Sushi Pool ${poolInfo.name}: Invalid address env var ${envVarName}: "${process.env[envVarName]}".`); } }
    }

    // Process DODO Pools
    if (isDodoEnabled) {
        const dodoPools = requirePoolFile(networkName, 'dodo'); // Uses helper
        logger.debug(`[Pool Loader] Processing ${dodoPools.length} raw DODO pools...`);
         for (const poolInfo of dodoPools) { /* ... DODO processing logic ... */ const token0 = baseTokens[poolInfo.token0Symbol]; const token1 = baseTokens[poolInfo.token1Symbol]; if (!token0 || !token1) { logger.warn(`[Pool Loader] DODO Pool ${poolInfo.name}: Skipping missing token def: ${poolInfo.token0Symbol}/${poolInfo.token1Symbol}.`); continue; } const pairTokenObjects = [token0, token1]; if (!poolInfo.baseTokenSymbol || (poolInfo.baseTokenSymbol !== poolInfo.token0Symbol && poolInfo.baseTokenSymbol !== poolInfo.token1Symbol)) { logger.warn(`[Pool Loader] DODO Pool ${poolInfo.name}: Skipping invalid baseTokenSymbol.`); continue; } const envVarName = poolInfo.poolAddressEnv; if (!envVarName || typeof envVarName !== 'string') { logger.warn(`[Pool Loader] DODO Pool ${poolInfo.name}: Skipping missing poolAddressEnv.`); continue; } const poolAddress = Validators.validateAndNormalizeAddress(process.env[envVarName], envVarName); if (poolAddress && poolAddress !== ethers.ZeroAddress) { const lowerCaseAddress = poolAddress.toLowerCase(); if (loadedPoolAddresses.has(lowerCaseAddress)) continue; const feeBps = poolInfo.fee; if (feeBps !== undefined && (typeof feeBps !== 'number' || isNaN(feeBps))) { logger.warn(`[Pool Loader] DODO Pool ${poolInfo.name}: Invalid fee format.`); } allPoolConfigs.push({ address: poolAddress, dexType: 'dodo', fee: feeBps, token0Symbol: poolInfo.token0Symbol, token1Symbol: poolInfo.token1Symbol, pair: pairTokenObjects, baseTokenSymbol: poolInfo.baseTokenSymbol, groupName: poolInfo.name || 'N/A' }); loadedPoolAddresses.add(lowerCaseAddress); logger.debug(`[Pool Loader] Added DODO Pool: ${poolAddress} (${poolInfo.name})`); } else if (process.env[envVarName]) { logger.warn(`[Pool Loader] DODO Pool ${poolInfo.name}: Invalid address env var ${envVarName}: "${process.env[envVarName]}".`); } }
    }

    logger.info(`[Pool Loader v1.2] Finished processing. Total unique pools loaded: ${loadedPoolAddresses.size}`);
    if (loadedPoolAddresses.size === 0 && (isV3Enabled || isSushiEnabled || isDodoEnabled)) {
        logger.error("[Pool Loader v1.2] CRITICAL WARNING: DEXs are enabled but NO pool addresses were loaded. Check .env variables and pool definition files in config/pools/");
    }
    return allPoolConfigs;
}

module.exports = {
    loadPoolConfigs,
};
