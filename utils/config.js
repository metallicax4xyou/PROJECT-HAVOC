// /workspaces/arbitrum-flash/utils/config.js

require('dotenv').config(); // Load environment variables from .env file
const { ethers } = require('ethers');
const logger = require('./logger'); // Assuming logger is in utils

// --- Helper Functions ---
function parsePoolGroupEnv(envVar) {
    // Parses environment variables like: WETH_USDC_POOLS="0xPool1:WETH:USDC:500,0xPool2:WETH:USDC:3000"
    if (!envVar) return {};
    const groups = {};
    const pairs = envVar.split(',');
    pairs.forEach(pair => {
        const parts = pair.split(':');
        if (parts.length >= 4) {
            const address = parts[0].trim();
            const token0Symbol = parts[1].trim().toUpperCase();
            const token1Symbol = parts[2].trim().toUpperCase();
            const fee = parseInt(parts[3].trim(), 10);
            const groupName = `${token0Symbol}_${token1Symbol}`;

            if (!ethers.isAddress(address) || isNaN(fee)) {
                 logger.warn(`[Config] Invalid pool format in ENV: ${pair}`);
                 return;
            }

            if (!groups[groupName]) {
                groups[groupName] = {
                    token0Symbol: token0Symbol,
                    token1Symbol: token1Symbol,
                    pools: []
                };
            }
            // Add minimal pool info, scanner will fetch details
            groups[groupName].pools.push({ address: address, fee: fee });
        } else {
            logger.warn(`[Config] Skipping invalid pool format in ENV: ${pair}`);
        }
    });
    return groups;
}

function getEnv(key, defaultValue, isRequired = false) {
    const value = process.env[key];
    if (value === undefined || value === null || value === '') {
        if (isRequired) {
            throw new Error(`[Config] Missing required environment variable: ${key}`);
        }
        return defaultValue;
    }
    return value;
}

// --- Global Configuration ---
const globalConfig = {
    logLevel: getEnv('LOG_LEVEL', 'info'),
    dryRun: getEnv('DRY_RUN', 'true').toLowerCase() === 'true',
};

// --- Network Specific Configuration ---
// Load pool groups directly from environment variables like WETH_USDC_POOLS, USDC_USDT_POOLS etc.
const allEnvPoolGroups = {};
Object.keys(process.env).forEach(key => {
    if (key.endsWith('_POOLS')) {
        const groupName = key.replace('_POOLS', '');
        const poolsData = parsePoolGroupEnv(process.env[key]);
        if (poolsData[groupName]) {
             // Merge pools into the correct group structure
             if (!allEnvPoolGroups[groupName]) {
                allEnvPoolGroups[groupName] = poolsData[groupName];
             } else {
                 // If group already exists (e.g. from another var), merge pools
                 allEnvPoolGroups[groupName].pools.push(...poolsData[groupName].pools);
             }
             logger.debug(`[Config] Loaded ${poolsData[groupName].pools.length} pools for group ${groupName} from ENV var ${key}`);
        }
    }
});


const networkConfigs = {
    arbitrum: {
        name: 'arbitrum',
        chainId: 42161,
        rpcUrls: [getEnv('ARBITRUM_RPC_URL', undefined, true)], // Require RPC URL
        flashSwapAddress: getEnv('FLASH_SWAP_ADDRESS', undefined, true), // Require Flash Swap address
        poolGroups: allEnvPoolGroups, // Load dynamically from ENV
        // Add specific gas settings if needed, otherwise use provider defaults
        gasSettings: {
             // maxFeePerGas: ethers.parseUnits(getEnv('ARBITRUM_MAX_FEE_GWEI', '5'), 'gwei'),
             // maxPriorityFeePerGas: ethers.parseUnits(getEnv('ARBITRUM_PRIORITY_FEE_GWEI', '0.1'), 'gwei')
        },
    },
    // Add other networks like polygon, base, optimism if needed
    // polygon: { ... },
    // base: { ... },
    // optimism: { ... },
};

// --- Engine Configuration ---
const engineConfig = {
    cycleIntervalMs: parseInt(getEnv('CYCLE_INTERVAL_MS', '5000'), 10),
    profitThresholdUsd: parseFloat(getEnv('PROFIT_THRESHOLD_USD', '1.0')),
};

// --- Flash Swap Specific Configuration ---
const flashSwapConfig = {
    borrowAmount: getEnv('FLASH_BORROW_AMOUNT', '1'), // Amount of token0 to borrow (e.g., '1' WETH)
    // Note: Borrow token is determined by the opportunity (token0)
};


// --- Combined Configuration Object ---
const config = {
    global: globalConfig,
    networks: networkConfigs,
    engine: engineConfig,
    flashSwap: flashSwapConfig,
};


// --- Exported Functions ---

/**
 * Gets the combined configuration object.
 * @returns {object} The full configuration object.
 */
function getConfig() {
    return config;
}

/**
 * Gets the configuration for the specified network.
 * @param {string} [networkName=process.env.NETWORK] - The name of the network (e.g., 'arbitrum'). Defaults to process.env.NETWORK.
 * @returns {object} The configuration object for the specified network.
 * @throws {Error} If the network configuration is not found.
 */
function getNetworkConfig(networkName) {
    const targetNetwork = networkName || getEnv('NETWORK', 'arbitrum'); // Default to arbitrum if NETWORK env not set
    const networkConfig = config.networks[targetNetwork.toLowerCase()];

    if (!networkConfig) {
        throw new Error(`[Config] Configuration for network "${targetNetwork}" not found. Available: ${Object.keys(config.networks).join(', ')}`);
    }

    // --- Dynamic Pool Loading & Logging ---
    // Log loaded pools after selecting network config
    let totalPools = 0;
    const uniquePoolAddresses = new Set();
    if (networkConfig.poolGroups && Object.keys(networkConfig.poolGroups).length > 0) {
        logger.info(`[Config] Loading pools for network: ${targetNetwork}`);
        Object.entries(networkConfig.poolGroups).forEach(([groupName, groupData]) => {
            const poolCount = groupData.pools?.length || 0;
            logger.info(`[Config] Group ${groupName} initialized with ${poolCount} pools.`);
            groupData.pools?.forEach(p => uniquePoolAddresses.add(p.address.toLowerCase()));
            totalPools += poolCount;
        });
        logger.info(`[Config] Total unique pools loaded from .env: ${uniquePoolAddresses.size}`);
    } else {
         logger.warn(`[Config] No pool groups found or loaded for network ${targetNetwork} from environment variables (e.g., WETH_USDC_POOLS).`);
    }
    // --- End Dynamic Pool Loading ---

     logger.info(`[Config] Loaded Flash Swap Address: ${networkConfig.flashSwapAddress}`);
     if (config.global.dryRun) {
         logger.warn('[Config] --- DRY RUN MODE ENABLED --- Transactions will NOT be sent.');
     }
     logger.info(`[Config] Configuration loaded successfully for network: ${targetNetwork} (Chain ID: ${networkConfig.chainId})`);


    return networkConfig;
}


module.exports = {
    getConfig,
    getNetworkConfig,
};
