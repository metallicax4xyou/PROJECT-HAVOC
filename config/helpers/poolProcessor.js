// config/helpers/poolProcessor.js
// --- VERSION UPDATED FOR ETHERS V6 UTILS & PHASE 1 REFACTOR ---

const { ethers } = require('ethers'); // Ethers v6+
const { Token } = require('@uniswap/sdk-core');
let logger; try { logger = require('../../utils/logger'); } catch(e) { console.error("No logger for poolProcessor"); logger = console; }
const Validators = require('./validators'); // Assuming validators use ethers v6 syntax if needed

function processPoolGroups(baseConfig, rawPoolGroups) {
    logger.debug(`[Pool Processor] Starting pool group processing...`);
    let totalPoolsLoaded = 0;
    const loadedPoolAddresses = new Set();
    const validProcessedPoolGroups = [];

    if (!rawPoolGroups || !Array.isArray(rawPoolGroups)) {
        logger.warn('[Pool Processor] POOL_GROUPS array is missing or invalid in network config.');
        return { validProcessedPoolGroups, loadedPoolAddresses };
    }

    logger.debug(`[Pool Processor] Processing ${rawPoolGroups.length} raw POOL_GROUPS...`);
    rawPoolGroups.forEach((groupInput, groupIndex) => {
        const group = { ...groupInput };
        let currentGroupIsValid = true;
        const errorMessages = [];

        try {
            // --- Validate Group Structure ---
            // Removed minNetProfit check
            if (!group || !group.name || !group.token0Symbol || !group.token1Symbol || !group.borrowTokenSymbol) {
                errorMessages.push(`Group #${groupIndex}: Missing required fields (name, token0Symbol, token1Symbol, borrowTokenSymbol).`);
                currentGroupIsValid = false;
            }
            // --- End Validation ---

            // Enrich with SDK Tokens
            if (currentGroupIsValid) {
                group.token0 = baseConfig.TOKENS[group.token0Symbol];
                group.token1 = baseConfig.TOKENS[group.token1Symbol];
                group.borrowToken = baseConfig.TOKENS[group.borrowTokenSymbol];
                if (!(group.token0 instanceof Token) || !(group.token1 instanceof Token) || !(group.borrowToken instanceof Token)) {
                    errorMessages.push(`Group "${group.name}": Failed SDK Token lookup for symbols ${group.token0Symbol}/${group.token1Symbol}/${group.borrowTokenSymbol}. Ensure they exist in constants/tokens.js.`);
                    currentGroupIsValid = false;
                } else {
                    group.sdkToken0 = group.token0;
                    group.sdkToken1 = group.token1;
                    group.sdkBorrowToken = group.borrowToken;
                    logger.debug(`[Pool Processor] Assigned SDK tokens for group ${group.name}`);
                }
            }

            // Enrich with Borrow Amount
            if (currentGroupIsValid) {
                const borrowAmountEnvKey = `BORROW_AMOUNT_${group.borrowTokenSymbol}`;
                const rawBorrowAmount = process.env[borrowAmountEnvKey];
                if (!rawBorrowAmount) {
                    // Log specific warning for known missing env var if needed
                    if (group.name === 'WBTC_USDT' && group.borrowTokenSymbol === 'USDT') {
                         logger.warn(`[Pool Processor] Group "${group.name}": Expected borrow amount env var ${borrowAmountEnvKey} not found. This group will be skipped.`);
                    } else {
                         errorMessages.push(`Group "${group.name}": Missing borrow amount env var ${borrowAmountEnvKey}.`);
                    }
                    currentGroupIsValid = false; // Skip group if borrow amount missing
                } else {
                    try {
                        if (!group.borrowToken || typeof group.borrowToken.decimals !== 'number') {
                             throw new Error("borrowToken or its decimals are missing.");
                        }
                        // --- Use ethers.parseUnits (v6 syntax) ---
                        group.borrowAmount = ethers.parseUnits(rawBorrowAmount, group.borrowToken.decimals);
                        // --- ---
                        if (group.borrowAmount <= 0n) { // Use BigInt comparison
                            throw new Error("parsed borrow amount must be positive.");
                        }
                        logger.log(`[Pool Processor] Group ${group.name}: Borrow Amount set to ${rawBorrowAmount} ${group.borrowTokenSymbol} (${group.borrowAmount.toString()} smallest unit)`);
                    } catch (e) {
                        errorMessages.push(`Group "${group.name}": Invalid borrow amount "${rawBorrowAmount}" for token ${group.borrowTokenSymbol} (decimals: ${group.borrowToken?.decimals}): ${e.message}`);
                        currentGroupIsValid = false;
                    }
                }
            }

            // Load Pools for Group
            if (currentGroupIsValid) {
                group.pools = [];
                let poolsFoundForGroup = 0;
                if (group.feeTierToEnvMap && typeof group.feeTierToEnvMap === 'object') {
                    for (const feeTierStr in group.feeTierToEnvMap) {
                        const feeTier = parseInt(feeTierStr, 10);
                        if (isNaN(feeTier) || feeTier < 0) { continue; }

                        const envVarKey = group.feeTierToEnvMap[feeTierStr];
                        if (!envVarKey || typeof envVarKey !== 'string') { continue; }

                        const rawAddress = process.env[envVarKey];
                        if (rawAddress) {
                            // Assuming Validators.validateAndNormalizeAddress uses ethers.getAddress or similar v6 compatible check
                            const validatedAddress = Validators.validateAndNormalizeAddress(rawAddress, envVarKey);
                            if (validatedAddress) {
                                if (loadedPoolAddresses.has(validatedAddress.toLowerCase())) { continue; }
                                const poolConfig = {
                                    address: validatedAddress,
                                    fee: feeTier,
                                    groupName: group.name,
                                    token0Symbol: group.token0Symbol,
                                    token1Symbol: group.token1Symbol,
                                };
                                group.pools.push(poolConfig);
                                totalPoolsLoaded++;
                                poolsFoundForGroup++;
                                loadedPoolAddresses.add(validatedAddress.toLowerCase());
                                logger.debug(`[Pool Processor] Loaded pool ${validatedAddress} (Fee: ${feeTier}) for group ${group.name} from ${envVarKey}.`);
                            } else {
                                logger.warn(`[Pool Processor] Invalid address format for env var ${envVarKey}: "${rawAddress}". Skipping pool.`);
                            }
                        }
                    }
                    logger.log(`[Pool Processor] Group ${group.name} processed: Found ${poolsFoundForGroup} pools in .env.`);
                } else {
                    logger.warn(`[Pool Processor] No feeTierToEnvMap provided for group ${group.name}. Cannot load pools.`);
                }

                // Add group to the final list if valid and pools were found
                if (currentGroupIsValid && group.pools.length > 0) {
                    validProcessedPoolGroups.push({
                        name: group.name, token0Symbol: group.token0Symbol, token1Symbol: group.token1Symbol, borrowTokenSymbol: group.borrowTokenSymbol,
                        sdkToken0: group.sdkToken0, sdkToken1: group.sdkToken1, sdkBorrowToken: group.sdkBorrowToken,
                        borrowAmount: group.borrowAmount, // Parsed BigInt amount
                        pools: group.pools, // Array of loaded pool configs
                    });
                } else if (currentGroupIsValid && group.pools.length === 0) {
                    logger.warn(`[Pool Processor] Group ${group.name} skipped: Valid base config but no valid pools were loaded from .env based on feeTierToEnvMap.`);
                }
                // If !currentGroupIsValid, errors were already collected or logged
            } else {
                // Only log accumulated errors if the group was initially considered valid
                if (errorMessages.length > 0) {
                    logger.error(`[Pool Processor] Skipping POOL_GROUP ${group?.name || `Index #${groupIndex}`} due to errors: ${errorMessages.join('; ')}`);
                }
                 // If only the USDT env var was missing, it was already logged as a warning.
            }

        } catch (groupError) {
            logger.error(`[Pool Processor] Unexpected error processing POOL_GROUP ${groupInput?.name || `Index #${groupIndex}`}: ${groupError.message}. Skipping.`, groupError);
        }
    });

    logger.log(`[Pool Processor] Finished processing pool groups. Valid groups loaded: ${validProcessedPoolGroups.length}`);
    logger.log(`[Pool Processor] Total unique pools loaded across all valid groups: ${loadedPoolAddresses.size}`);
    if (loadedPoolAddresses.size === 0) {
        logger.error("[Pool Processor] CRITICAL WARNING: No pool addresses were loaded from .env variables. Bot cannot function without pools.");
    }

    return { validProcessedPoolGroups, loadedPoolAddresses };
}

module.exports = {
    processPoolGroups,
};
