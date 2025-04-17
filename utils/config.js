// /workspaces/arbitrum-flash/utils/config.js

// --- REMOVED: require('dotenv').config(); --- It's now loaded in bot.js entry point

const { ethers } = require('ethers');
const logger = require('./logger'); // Assuming logger is in utils

// --- Helper Functions ---
function parsePoolGroupEnv(envVar) {
    // Ensure logger is available before using it extensively
     const log = logger || console; // Fallback to console if logger isn't ready

    if (!envVar) return {};
    const groups = {};
    const pairs = envVar.split(',');
    log.debug(`[Config ParsePool] Parsing ENV var content: "${envVar}"`);
    pairs.forEach((pair, index) => {
        const trimmedPair = pair.trim();
        log.debug(`[Config ParsePool] Processing pair #${index}: "${trimmedPair}"`);
        if (!trimmedPair) {
            log.debug(`[Config ParsePool] Skipping empty pair #${index}.`);
            return;
        }
        const parts = trimmedPair.split(':');
        log.debug(`[Config ParsePool] Split parts for pair #${index}: ${JSON.stringify(parts)} (Count: ${parts.length})`);

        if (parts.length === 4) {
            const address = parts[0].trim();
            const token0Symbol = parts[1].trim().toUpperCase();
            const token1Symbol = parts[2].trim().toUpperCase();
            const feeStr = parts[3].trim();
            const fee = parseInt(feeStr, 10);
            const groupName = `${token0Symbol}_${token1Symbol}`;

            let isValid = true;
            if (!ethers.isAddress(address)) {
                log.warn(`[Config ParsePool] Invalid address format in pair "${trimmedPair}": ${address}`);
                isValid = false;
            }
            if (isNaN(fee) || feeStr !== fee.toString()) {
                log.warn(`[Config ParsePool] Invalid fee format in pair "${trimmedPair}": ${parts[3].trim()}`);
                isValid = false;
            }
             if (!token0Symbol || !token1Symbol) {
                log.warn(`[Config ParsePool] Missing token symbol in pair "${trimmedPair}"`);
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
                log.debug(`[Config ParsePool] Added pool ${address} (Fee: ${fee}) to group ${groupName}`);
            } else {
                 log.warn(`[Config ParsePool] Skipping invalid pair due to errors: "${trimmedPair}"`);
            }
        } else {
            log.warn(`[Config ParsePool] Skipping pair with incorrect number of parts (${parts.length} instead of 4): "${trimmedPair}"`);
        }
    });
    log.debug(`[Config ParsePool] Finished parsing. Groups created: ${Object.keys(groups).join(', ')}`);
    return groups;
}

// --- CRITICAL Error Handling Helper ---
// Moved error handling outside getEnv to be callable directly if needed
function exitWithError(variableName, reason) {
    const log = logger || console; // Fallback logger
    log.fatal(`[Config] CRITICAL: Invalid environment variable: ${variableName}. Reason: ${reason}\n!!! Bot cannot start. Please check your .env file.`);
    console.error(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
    console.error(`!!! FATAL CONFIGURATION ERROR !!!`);
    console.error(`!!! [Config] CRITICAL: Invalid environment variable: ${variableName}.`);
    console.error(`!!! Reason: ${reason}`);
    console.error(`!!! Bot cannot start. Please check your .env file.`);
    console.error(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
    process.exit(1); // Exit on invalid required env var
}

// --- getEnv with Integrated Validation ---
function getEnv(key, defaultValue, isRequired = false, validationFn = null) {
    const log = logger || console; // Fallback logger
    const value = process.env[key];

    // Check if required variable is missing
    if (isRequired && (value === undefined || value === null || value === '')) {
        // Use the specific exit function for missing required vars
        exitWithError(key, `Missing required environment variable`);
    }

    // If not required and missing, return default
    if (value === undefined || value === null || value === '') {
        return defaultValue;
    }

    // If validation function is provided, run it
    if (validationFn) {
        const { isValid, message } = validationFn(key, value);
        if (!isValid) {
            // Use the specific exit function for validation failures
             exitWithError(key, message);
        }
    }
    // Return the value if it exists and passes validation (or if no validation needed)
    return value;
}

 // --- Specific Validation Functions ---
 function validatePrivateKey(key, value) {
    const isValid = /^[a-fA-F0-9]{64}$/.test(value); // 64 hex chars, no 0x
    return { isValid, message: "PRIVATE_KEY must be exactly 64 hexadecimal characters and must NOT include the '0x' prefix." };
}
function validateRpcUrl(key, value) {
    const isValid = /^(https?|wss?):\/\/.+/.test(value); // Basic URL check
    return { isValid, message: `${key} must be a valid URL (starting with http/https/ws/wss).` };
}
 function validateAddress(key, value) {
    const isValid = ethers.isAddress(value);
    return { isValid, message: `${key} must be a valid Ethereum address.` };
}
// --- END Validation Functions ---


// --- Global Configuration ---
const globalConfig = {
    logLevel: getEnv('LOG_LEVEL', 'info'),
    dryRun: getEnv('DRY_RUN', 'true').toLowerCase() === 'true',
};

// --- Network Specific Configuration ---
// Load pool groups directly from environment variables
const allEnvPoolGroups = {};
Object.keys(process.env).forEach(key => {
    if (key.endsWith('_POOLS')) {
        const groupName = key.replace('_POOLS', '');
        const poolsData = parsePoolGroupEnv(process.env[key]); // Use the enhanced parser
        if (poolsData[groupName]) {
             if (!allEnvPoolGroups[groupName]) { allEnvPoolGroups[groupName] = poolsData[groupName]; }
             else { allEnvPoolGroups[groupName].pools.push(...poolsData[groupName].pools); }
        }
    }
});


// --- Validate Required Variables for Arbitrum ---
// We assume NETWORK=arbitrum is set based on bot.js logic or default
const networkName = getEnv('NETWORK', 'arbitrum'); // Get network name for context

let rpcUrlsRaw, flashSwapAddressRaw;

if (networkName.toLowerCase() === 'arbitrum') {
    // ** Expect Plural ARBITRUM_RPC_URLS based on utils/provider.js **
    rpcUrlsRaw = getEnv('ARBITRUM_RPC_URLS', undefined, true, validateRpcUrl);
    flashSwapAddressRaw = getEnv('FLASH_SWAP_ADDRESS', undefined, true, validateAddress);
    // Validate Private Key (globally required) - this will exit if invalid
    getEnv('PRIVATE_KEY', undefined, true, validatePrivateKey);
} else {
    exitWithError('NETWORK', `Network "${networkName}" is not currently supported in config.js.`);
}
// --- End Validation ---


const networkConfigs = {
    // Only define arbitrum for now, add others if needed
    arbitrum: {
        name: 'arbitrum',
        chainId: 42161,
        rpcUrls: [rpcUrlsRaw], // Use validated value
        flashSwapAddress: flashSwapAddressRaw, // Use validated value
        poolGroups: allEnvPoolGroups, // Parsed pool groups
        gasSettings: {}, // Add specific gas settings if needed
    },
};

// --- Engine Configuration ---
const engineConfig = {
    cycleIntervalMs: parseInt(getEnv('CYCLE_INTERVAL_MS', '5000'), 10),
    profitThresholdUsd: parseFloat(getEnv('PROFIT_THRESHOLD_USD', '1.0')),
};

// --- Flash Swap Specific Configuration ---
const flashSwapConfig = {
    borrowAmount: getEnv('FLASH_BORROW_AMOUNT', '1'), // Use FLASH_BORROW_AMOUNT from .env
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

function getNetworkConfig(networkNameInput) {
    const log = logger || console; // Fallback logger
    // networkName is already validated and set above
    const targetNetwork = networkName.toLowerCase();
    const networkConfig = config.networks[targetNetwork];

    if (!networkConfig) {
        // Should not happen due to earlier check, but safeguard
        exitWithError('NETWORK', `Configuration for network "${targetNetwork}" not found unexpectedly.`);
    }

    // --- Log Loaded Pools ---
    let totalPools = 0;
    const uniquePoolAddresses = new Set();
    if (networkConfig.poolGroups && Object.keys(networkConfig.poolGroups).length > 0) {
        log.info(`[Config] Loading pools for network: ${targetNetwork}`);
        Object.entries(networkConfig.poolGroups).forEach(([groupName, groupData]) => {
            const poolCount = groupData.pools?.length || 0;
            log.info(`[Config] Group ${groupName} initialized with ${poolCount} pools.`);
            if (poolCount === 0 && process.env[`${groupName}_POOLS`]) {
                 log.warn(`[Config] Zero pools loaded for group ${groupName} despite ENV var existing. Check format: ${groupName}_POOLS="Addr:Sym0:Sym1:Fee,..."`);
            }
            groupData.pools?.forEach(p => uniquePoolAddresses.add(p.address.toLowerCase()));
            totalPools += poolCount;
        });
        log.info(`[Config] Total unique pools loaded from .env: ${uniquePoolAddresses.size}`);
        if (uniquePoolAddresses.size === 0) {
            log.warn(`[Config] WARNING: No pool addresses were successfully loaded from .env variables. Bot cannot scan pools.`);
        }
    } else {
         log.warn(`[Config] No pool groups found or loaded for network ${targetNetwork} from environment variables (e.g., WETH_USDC_POOLS).`);
    }
    // --- End Pool Logging ---

     log.info(`[Config] Loaded Flash Swap Address: ${networkConfig.flashSwapAddress}`);
     if (config.global.dryRun) {
         log.warn('[Config] --- DRY RUN MODE ENABLED --- Transactions will NOT be sent.');
     }
     log.info(`[Config] Configuration loaded successfully for network: ${targetNetwork} (Chain ID: ${networkConfig.chainId})`);

    return networkConfig;
}


module.exports = { getConfig, getNetworkConfig };
