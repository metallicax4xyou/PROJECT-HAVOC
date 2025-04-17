// /workspaces/arbitrum-flash/utils/config.js

require('dotenv').config(); // Load environment variables from .env file
const { ethers } = require('ethers');
const logger = require('./logger'); // Assuming logger is in utils

// --- Helper Functions ---
function parsePoolGroupEnv(envVar) {
    if (!envVar) return {};
    const groups = {};
    const pairs = envVar.split(',');
    // --- DEBUG LOG ADDED ---
    logger.debug(`[Config ParsePool] Parsing ENV var content: "${envVar}"`);
    pairs.forEach((pair, index) => {
        const trimmedPair = pair.trim();
        // --- DEBUG LOG ADDED ---
        logger.debug(`[Config ParsePool] Processing pair #${index}: "${trimmedPair}"`);
        if (!trimmedPair) {
            logger.debug(`[Config ParsePool] Skipping empty pair #${index}.`);
            return; // Skip empty strings often caused by trailing commas
        }
        const parts = trimmedPair.split(':');
        // --- DEBUG LOG ADDED ---
        logger.debug(`[Config ParsePool] Split parts for pair #${index}: ${JSON.stringify(parts)} (Count: ${parts.length})`);

        if (parts.length === 4) { // Require exactly 4 parts
            const address = parts[0].trim();
            const token0Symbol = parts[1].trim().toUpperCase();
            const token1Symbol = parts[2].trim().toUpperCase();
            const feeStr = parts[3].trim();
            const fee = parseInt(feeStr, 10);
            const groupName = `${token0Symbol}_${token1Symbol}`;

            let isValid = true;
            if (!ethers.isAddress(address)) {
                logger.warn(`[Config ParsePool] Invalid address format in pair "${trimmedPair}": ${address}`);
                isValid = false;
            }
            if (isNaN(fee) || feeStr !== fee.toString()) { // Check if parsing worked and if original string was just digits
                logger.warn(`[Config ParsePool] Invalid fee format in pair "${trimmedPair}": ${parts[3].trim()}`);
                isValid = false;
            }
             if (!token0Symbol || !token1Symbol) {
                logger.warn(`[Config ParsePool] Missing token symbol in pair "${trimmedPair}"`);
                isValid = false;
             }

            if (isValid) {
                if (!groups[groupName]) {
                    groups[groupName] = {
                        token0Symbol: token0Symbol,
                        token1Symbol: token1Symbol,
                        pools: []
                    };
                }
                groups[groupName].pools.push({ address: address, fee: fee });
                logger.debug(`[Config ParsePool] Added pool ${address} (Fee: ${fee}) to group ${groupName}`);
            } else {
                 logger.warn(`[Config ParsePool] Skipping invalid pair due to errors: "${trimmedPair}"`);
            }
        } else {
            logger.warn(`[Config ParsePool] Skipping pair with incorrect number of parts (${parts.length} instead of 4): "${trimmedPair}"`);
        }
    });
    // --- DEBUG LOG ADDED ---
    logger.debug(`[Config ParsePool] Finished parsing. Groups created: ${Object.keys(groups).join(', ')}`);
    return groups;
}

function getEnv(key, defaultValue, isRequired = false, validationFn = null) {
    const value = process.env[key];
    if (value === undefined || value === null || value === '') {
        if (isRequired) {
             logger.fatal(`[Config] CRITICAL: Missing required environment variable: ${key}.\n!!! Bot cannot start. Please check your .env file and config files.`);
             // Added more descriptive error and exit
             console.error(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
             console.error(`!!! FATAL CONFIGURATION ERROR !!!`);
             console.error(`!!! [Config] CRITICAL: Missing required environment variable: ${key}.`);
             console.error(`!!! Bot cannot start. Please check your .env file and config files.`);
             console.error(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
             process.exit(1); // Exit on missing required env var
            // throw new Error(`[Config] Missing required environment variable: ${key}`); // Old way
        }
        return defaultValue;
    }
    // --- ADDED Validation Logic ---
    if (validationFn) {
        const { isValid, message } = validationFn(key, value);
        if (!isValid) {
             logger.fatal(`[Config] CRITICAL: Invalid environment variable: ${key}. Reason: ${message}\n!!! Bot cannot start. Please check your .env file and config files.`);
             console.error(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
             console.error(`!!! FATAL CONFIGURATION ERROR !!!`);
             console.error(`!!! [Config] CRITICAL: Invalid environment variable: ${key}.`);
             console.error(`!!! Reason: ${message}`);
             console.error(`!!! Bot cannot start. Please check your .env file and config files.`);
             console.error(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
             process.exit(1); // Exit on invalid required env var
            // throw new Error(`[Config] Invalid environment variable: ${key}. Reason: ${message}`); // Old way
        }
    }
    // --- END Validation Logic ---
    return value;
}

 // --- ADDED Specific Validation Functions ---
function validatePrivateKey(key, value) {
    // Valid key: 64 hex chars, no 0x prefix
    const isValid = /^[a-fA-F0-9]{64}$/.test(value);
    return {
        isValid,
        message: isValid ? "OK" : "PRIVATE_KEY must be exactly 64 hexadecimal characters and must NOT include the '0x' prefix."
        // Updated message to be clear, ignoring the potentially confusing "66 chars" check from before
    };
}
function validateRpcUrl(key, value) {
     // Basic check for http/https/ws/wss start
    const isValid = /^(https?|wss?):\/\/.+/.test(value);
     return {
        isValid,
        message: isValid ? "OK" : `${key} must be a valid URL (starting with http/https/ws/wss).`
     };
}
 function validateAddress(key, value) {
    const isValid = ethers.isAddress(value);
     return {
        isValid,
        message: isValid ? "OK" : `${key} must be a valid Ethereum address.`
     };
}
// --- END Validation Functions ---


// --- Global Configuration ---
const globalConfig = {
    logLevel: getEnv('LOG_LEVEL', 'info'),
    dryRun: getEnv('DRY_RUN', 'true').toLowerCase() === 'true',
};

// --- Network Specific Configuration ---
const allEnvPoolGroups = {};
Object.keys(process.env).forEach(key => {
    if (key.endsWith('_POOLS')) {
        const groupName = key.replace('_POOLS', '');
        // Pass the raw env var string to the parser
        const poolsData = parsePoolGroupEnv(process.env[key]);
        if (poolsData[groupName]) {
             if (!allEnvPoolGroups[groupName]) { allEnvPoolGroups[groupName] = poolsData[groupName]; }
             else { allEnvPoolGroups[groupName].pools.push(...poolsData[groupName].pools); }
             // Removed debug log from here, it's now inside the parser
        }
    }
});

// --- ADDED Validation Calls for Required Env Vars ---
const networkName = getEnv('NETWORK', 'arbitrum'); // Get network name first
let rpcUrlsRaw;
let flashSwapAddressRaw;

if (networkName.toLowerCase() === 'arbitrum') {
    // Use ARBITRUM_RPC_URLS if NETWORK is arbitrum, based on previous grep results needing plural
     rpcUrlsRaw = getEnv('ARBITRUM_RPC_URLS', undefined, true, validateRpcUrl);
     flashSwapAddressRaw = getEnv('FLASH_SWAP_ADDRESS', undefined, true, validateAddress);
     // Validate Private Key here as it's globally required for signing
     getEnv('PRIVATE_KEY', undefined, true, validatePrivateKey);
} else {
    // Handle other networks or throw error if NETWORK is set to something unsupported
     logger.fatal(`[Config] Network "${networkName}" is not currently supported in config.js.`);
     process.exit(1);
}
// --- END Validation Calls ---


const networkConfigs = {
    arbitrum: {
        name: 'arbitrum',
        chainId: 42161,
        rpcUrls: [rpcUrlsRaw], // Use validated value
        flashSwapAddress: flashSwapAddressRaw, // Use validated value
        poolGroups: allEnvPoolGroups,
        gasSettings: {},
    },
};

// --- Engine Configuration ---
const engineConfig = {
    cycleIntervalMs: parseInt(getEnv('CYCLE_INTERVAL_MS', '5000'), 10),
    profitThresholdUsd: parseFloat(getEnv('PROFIT_THRESHOLD_USD', '1.0')),
};

// --- Flash Swap Specific Configuration ---
const flashSwapConfig = {
    borrowAmount: getEnv('FLASH_BORROW_AMOUNT', '1'),
};

// --- Combined Configuration Object ---
const config = {
    global: globalConfig,
    networks: networkConfigs,
    engine: engineConfig,
    flashSwap: flashSwapConfig,
};

// --- Exported Functions ---
function getConfig() { return config; }

function getNetworkConfig(networkNameInput) { // Renamed param to avoid conflict
    // Use validated networkName from earlier check
    const targetNetwork = networkName.toLowerCase();
    const networkConfig = config.networks[targetNetwork];

    // This check should technically be redundant now due to earlier validation
    if (!networkConfig) {
        logger.fatal(`[Config] Configuration for network "${targetNetwork}" not found unexpectedly.`);
        process.exit(1);
    }

    // --- Dynamic Pool Loading & Logging ---
    let totalPools = 0;
    const uniquePoolAddresses = new Set();
    if (networkConfig.poolGroups && Object.keys(networkConfig.poolGroups).length > 0) {
        logger.info(`[Config] Loading pools for network: ${targetNetwork}`);
        Object.entries(networkConfig.poolGroups).forEach(([groupName, groupData]) => {
            const poolCount = groupData.pools?.length || 0;
            logger.info(`[Config] Group ${groupName} initialized with ${poolCount} pools.`);
            if (poolCount === 0) {
                 logger.warn(`[Config] No pools loaded for group ${groupName}. Check ENV var format: ${groupName}_POOLS="Addr:Sym0:Sym1:Fee,..."`);
            }
            groupData.pools?.forEach(p => uniquePoolAddresses.add(p.address.toLowerCase()));
            totalPools += poolCount;
        });
        logger.info(`[Config] Total unique pools loaded from .env: ${uniquePoolAddresses.size}`);
        if (uniquePoolAddresses.size === 0) {
            logger.warn(`[Config] WARNING: No pool addresses were successfully loaded from .env variables. Bot cannot scan pools.`);
        }
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

module.exports = { getConfig, getNetworkConfig };
