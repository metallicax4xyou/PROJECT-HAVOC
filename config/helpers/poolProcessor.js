// config/helpers/poolProcessor.js
const { ethers } = require('ethers');
const { Token } = require('@uniswap/sdk-core');
let logger; try { logger = require('../../utils/logger'); } catch(e) { console.error("No logger for poolProcessor"); logger = console; } // Adjusted path
const Validators = require('./validators'); // Import validation helpers

function processPoolGroups(baseConfig, rawPoolGroups) {
    logger.debug(`[Pool Processor] Starting pool group processing...`);
    let totalPoolsLoaded = 0;
    const loadedPoolAddresses = new Set();
    const validProcessedPoolGroups = [];

    if (!rawPoolGroups || !Array.isArray(rawPoolGroups)) {
        logger.warn('[Pool Processor] POOL_GROUPS array is missing or invalid in network config.');
        return { validProcessedPoolGroups, loadedPoolAddresses }; // Return empty results
    }

    logger.debug(`[Pool Processor] Processing ${rawPoolGroups.length} raw POOL_GROUPS...`);
    rawPoolGroups.forEach((groupInput, groupIndex) => {
        const group = { ...groupInput }; // Work on a copy
        let currentGroupIsValid = true;
        const errorMessages = [];

        try {
            // Validate Group Structure
            if (!group || !group.name || !group.token0Symbol || !group.token1Symbol || !group.borrowTokenSymbol || typeof group.minNetProfit === 'undefined') {
                errorMessages.push(`Group #${groupIndex}: Missing required fields.`); currentGroupIsValid = false;
            }

            // Enrich with SDK Tokens
            if (currentGroupIsValid) {
                group.token0 = baseConfig.TOKENS[group.token0Symbol];
                group.token1 = baseConfig.TOKENS[group.token1Symbol];
                group.borrowToken = baseConfig.TOKENS[group.borrowTokenSymbol];
                if (!(group.token0 instanceof Token) || !(group.token1 instanceof Token) || !(group.borrowToken instanceof Token)) {
                    errorMessages.push(`Group "${group.name}": Failed SDK Token lookup.`); currentGroupIsValid = false;
                } else {
                    group.sdkToken0 = group.token0; group.sdkToken1 = group.token1; group.sdkBorrowToken = group.borrowToken;
                    logger.debug(`[Pool Processor] Assigned SDK tokens for group ${group.name}`);
                }
            }

            // Enrich with Borrow Amount
            if (currentGroupIsValid) {
                const borrowAmountEnvKey = `BORROW_AMOUNT_${group.borrowTokenSymbol}`;
                const rawBorrowAmount = process.env[borrowAmountEnvKey];
                if (!rawBorrowAmount) {
                    errorMessages.push(`Group "${group.name}": Missing env var ${borrowAmountEnvKey}.`); currentGroupIsValid = false;
                } else {
                    try {
                        group.borrowAmount = ethers.parseUnits(rawBorrowAmount, group.borrowToken.decimals);
                        if (group.borrowAmount <= 0n) { throw new Error("must be positive"); }
                        logger.log(`[Pool Processor] Group ${group.name}: Borrow Amount set to ${rawBorrowAmount} ${group.borrowTokenSymbol}`);
                    } catch (e) { errorMessages.push(`Group "${group.name}": Invalid borrow amt "${rawBorrowAmount}": ${e.message}`); currentGroupIsValid = false; }
                }
            }

            // Enrich with Min Net Profit
            if (currentGroupIsValid) {
                // Use the imported safeParseBigInt from Validators
                group.minNetProfit = Validators.safeParseBigInt(group.minNetProfit, `Group ${group.name} minNetProfit`, 0n);
                logger.log(`[Pool Processor] Group ${group.name}: Min Net Profit set to ${ethers.formatUnits(group.minNetProfit, 18)} ${baseConfig.NATIVE_SYMBOL}`);
            }

            // Load Pools for Group
            if (currentGroupIsValid) {
                group.pools = []; // Initialize pools array
                let poolsFoundForGroup = 0; // Counter for this specific group
                if (group.feeTierToEnvMap && typeof group.feeTierToEnvMap === 'object') {
                    for (const feeTierStr in group.feeTierToEnvMap) {
                        const feeTier = parseInt(feeTierStr, 10);
                        if (isNaN(feeTier)) { logger.warn(`[Pool Processor] Invalid fee tier key "${feeTierStr}" for group ${group.name}.`); continue; }
                        const envVarKey = group.feeTierToEnvMap[feeTierStr];
                        const rawAddress = process.env[envVarKey];
                        if (rawAddress) {
                            // Use the imported validator
                            const validatedAddress = Validators.validateAndNormalizeAddress(rawAddress, envVarKey);
                            if (validatedAddress) {
                                if (loadedPoolAddresses.has(validatedAddress.toLowerCase())) {
                                    logger.warn(`[Pool Processor] Skipping duplicate pool address ${validatedAddress} from ${envVarKey}.`);
                                    continue;
                                }
                                const poolConfig = {
                                    address: validatedAddress,
                                    fee: feeTier,
                                    groupName: group.name,
                                    token0Symbol: group.token0Symbol,
                                    token1Symbol: group.token1Symbol
                                };
                                group.pools.push(poolConfig);
                                totalPoolsLoaded++;
                                poolsFoundForGroup++;
                                loadedPoolAddresses.add(validatedAddress.toLowerCase());
                            } else { logger.warn(`[Pool Processor] Invalid address format for ${envVarKey}. Skipping pool.`); }
                        } // else { logger.debug(`[Pool Processor] Optional: Env var ${envVarKey} not found.`); }
                    } // end for feeTierStr
                    logger.log(`[Pool Processor] Group ${group.name} processed with ${poolsFoundForGroup} pools found in .env.`);
                } else { logger.warn(`[Pool Processor] No feeTierToEnvMap for group ${group.name}.`); }

                // Only add group if it has at least one valid pool loaded
                if (group.pools.length > 0) {
                    validProcessedPoolGroups.push(group);
                } else {
                    logger.warn(`[Pool Processor] Group ${group.name} skipped: No valid pools loaded from .env based on feeTierToEnvMap.`);
                }
            } else {
                logger.error(`[Pool Processor] Skipping POOL_GROUP ${group?.name || `#${groupIndex}`} due to errors: ${errorMessages.join('; ')}`);
            }

        } catch (groupError) {
            logger.error(`[Pool Processor] Unexpected error processing POOL_GROUP ${groupInput?.name || `#${groupIndex}`}: ${groupError.message}. Skipping.`);
        }
    }); // End forEach groupInput

    logger.log(`[Pool Processor] Finished processing pool groups. Valid groups loaded: ${validProcessedPoolGroups.length}`);
    logger.log(`[Pool Processor] Total unique pools loaded across all valid groups: ${loadedPoolAddresses.size}`);
    if (loadedPoolAddresses.size === 0) { console.warn("[Pool Processor] WARNING: No pool addresses were loaded from .env variables."); }

    return { validProcessedPoolGroups, loadedPoolAddresses };
}

module.exports = {
    processPoolGroups,
};
