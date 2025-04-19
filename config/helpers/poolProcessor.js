// config/helpers/poolProcessor.js
// --- VERSION UPDATED FOR PHASE 1 REFACTOR ---
// Removed per-group minNetProfit check

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
            // --- Validate Group Structure ---
            // REMOVED: typeof group.minNetProfit === 'undefined' check
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
                    // Assign standard names for clarity, matching what opportunityProcessor expects
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
                    errorMessages.push(`Group "${group.name}": Missing borrow amount env var ${borrowAmountEnvKey}.`);
                    currentGroupIsValid = false;
                } else {
                    try {
                        // Ensure borrowToken has decimals before parsing
                        if (!group.borrowToken || typeof group.borrowToken.decimals !== 'number') {
                             throw new Error("borrowToken or its decimals are missing.");
                        }
                        group.borrowAmount = ethers.utils.parseUnits(rawBorrowAmount, group.borrowToken.decimals);
                        if (group.borrowAmount.lte(0)) { // Use lte for BigNumber comparison
                            throw new Error("parsed borrow amount must be positive.");
                        }
                        logger.log(`[Pool Processor] Group ${group.name}: Borrow Amount set to ${rawBorrowAmount} ${group.borrowTokenSymbol}`);
                    } catch (e) {
                        errorMessages.push(`Group "${group.name}": Invalid borrow amount "${rawBorrowAmount}" for token ${group.borrowTokenSymbol} (decimals: ${group.borrowToken?.decimals}): ${e.message}`);
                        currentGroupIsValid = false;
                    }
                }
            }

            // REMOVED: Enrich with Min Net Profit - Handled globally now

            // Load Pools for Group
            if (currentGroupIsValid) {
                group.pools = []; // Initialize pools array
                let poolsFoundForGroup = 0; // Counter for this specific group
                if (group.feeTierToEnvMap && typeof group.feeTierToEnvMap === 'object') {
                    for (const feeTierStr in group.feeTierToEnvMap) {
                        const feeTier = parseInt(feeTierStr, 10);
                        if (isNaN(feeTier) || feeTier < 0) { // Add check for valid fee tier number
                            logger.warn(`[Pool Processor] Invalid fee tier key "${feeTierStr}" for group ${group.name}. Skipping.`); continue;
                        }

                        const envVarKey = group.feeTierToEnvMap[feeTierStr];
                        if (!envVarKey || typeof envVarKey !== 'string') {
                             logger.warn(`[Pool Processor] Invalid env var key mapping for fee tier ${feeTier} in group ${group.name}. Skipping.`); continue;
                        }

                        const rawAddress = process.env[envVarKey];
                        if (rawAddress) {
                            const validatedAddress = Validators.validateAndNormalizeAddress(rawAddress, envVarKey);
                            if (validatedAddress) {
                                // Check for duplicates across all groups
                                if (loadedPoolAddresses.has(validatedAddress.toLowerCase())) {
                                    logger.warn(`[Pool Processor] Skipping duplicate pool address ${validatedAddress} from env var ${envVarKey} (already loaded).`);
                                    continue;
                                }
                                // Add pool details needed by scanner/processor
                                const poolConfig = {
                                    address: validatedAddress,
                                    fee: feeTier,
                                    groupName: group.name, // Link back to group
                                    token0Symbol: group.token0Symbol, // Store symbols for potential later use
                                    token1Symbol: group.token1Symbol,
                                    // Store SDK tokens directly on pool config? Might be useful.
                                    // token0: group.sdkToken0,
                                    // token1: group.sdkToken1,
                                };
                                group.pools.push(poolConfig);
                                totalPoolsLoaded++;
                                poolsFoundForGroup++;
                                loadedPoolAddresses.add(validatedAddress.toLowerCase()); // Add validated, lowercased address
                                logger.debug(`[Pool Processor] Loaded pool ${validatedAddress} (Fee: ${feeTier}) for group ${group.name} from ${envVarKey}.`);
                            } else {
                                logger.warn(`[Pool Processor] Invalid address format for env var ${envVarKey}: "${rawAddress}". Skipping pool.`);
                            }
                        } // else { logger.debug(`[Pool Processor] Optional: Env var ${envVarKey} not found for group ${group.name}.`); }
                    } // end for feeTierStr

                    logger.log(`[Pool Processor] Group ${group.name} processed: Found ${poolsFoundForGroup} pools in .env.`);
                } else {
                    logger.warn(`[Pool Processor] No feeTierToEnvMap provided for group ${group.name}. Cannot load pools.`);
                }

                // Add group to the final list ONLY if it has valid base info AND at least one pool loaded
                if (currentGroupIsValid && group.pools.length > 0) {
                    // Add only the necessary processed info, not the temporary validation stuff
                    validProcessedPoolGroups.push({
                        name: group.name,
                        token0Symbol: group.token0Symbol,
                        token1Symbol: group.token1Symbol,
                        borrowTokenSymbol: group.borrowTokenSymbol,
                        sdkToken0: group.sdkToken0,
                        sdkToken1: group.sdkToken1,
                        sdkBorrowToken: group.sdkBorrowToken,
                        borrowAmount: group.borrowAmount, // Parsed BigNumber amount
                        pools: group.pools, // Array of loaded pool configs
                        // feeTierToEnvMap: group.feeTierToEnvMap // Keep original map if needed elsewhere? Optional.
                    });
                } else if (currentGroupIsValid && group.pools.length === 0) {
                    logger.warn(`[Pool Processor] Group ${group.name} skipped: Valid base config but no valid pools were loaded from .env based on feeTierToEnvMap.`);
                } else {
                    // Errors already logged if !currentGroupIsValid
                }
            } else {
                // Log errors accumulated during validation checks
                logger.error(`[Pool Processor] Skipping POOL_GROUP ${group?.name || `Index #${groupIndex}`} due to errors: ${errorMessages.join('; ')}`);
            }

        } catch (groupError) {
            // Catch unexpected errors during the processing of a single group
            logger.error(`[Pool Processor] Unexpected error processing POOL_GROUP ${groupInput?.name || `Index #${groupIndex}`}: ${groupError.message}. Skipping.`, groupError);
        }
    }); // End forEach groupInput

    logger.log(`[Pool Processor] Finished processing pool groups. Valid groups loaded: ${validProcessedPoolGroups.length}`);
    logger.log(`[Pool Processor] Total unique pools loaded across all valid groups: ${loadedPoolAddresses.size}`);
    if (loadedPoolAddresses.size === 0) {
        // Make this a more prominent warning or even an error depending on expectations
        logger.error("[Pool Processor] CRITICAL WARNING: No pool addresses were loaded from .env variables. Bot cannot function without pools.");
    }

    return { validProcessedPoolGroups, loadedPoolAddresses };
}

module.exports = {
    processPoolGroups,
};
