// utils/tokenUtils.js
const logger = require('./logger'); // Ensure logger is correctly imported

/**
 * Validates the structure of the loaded TOKENS configuration object.
 * Checks for required fields on each token definition.
 * Throws an error if validation fails, halting bot startup.
 * @param {object} tokensObject The TOKENS object (e.g., TOKENS_TO_EXPORT from constants/tokens.js)
 * @throws {Error} If any token is missing required fields.
 */
function validateTokenConfig(tokensObject) {
    logger.info('[Token Validator] Running validation on TOKENS config...');
    // Define all fields that MUST exist on every token object in constants/tokens.js
    const REQUIRED_FIELDS = ['address', 'decimals', 'symbol', 'chainId', 'type', 'canonicalSymbol'];
    let isValid = true;
    let errorCount = 0;

    // Check if the main tokens object itself is valid
    if (!tokensObject || typeof tokensObject !== 'object' || Object.keys(tokensObject).length === 0) {
        throw new Error('[Token Validator] FATAL: TOKENS object is empty or invalid.');
    }

    // Iterate through each token defined in the TOKENS object
    for (const [key, token] of Object.entries(tokensObject)) {
        // Check if the token entry is a valid object
        if (!token || typeof token !== 'object') {
            logger.error(`[Token Validator] Invalid token definition for key: ${key}. Expected an object.`);
            isValid = false;
            errorCount++;
            continue; // Skip further checks for this invalid entry
        }

        // Check for the presence and basic validity of each required field
        for (const field of REQUIRED_FIELDS) {
            if (!(field in token) || token[field] === undefined || token[field] === null || token[field] === '') {
                // Log error if field is missing or empty/null/undefined
                logger.error(`[Token Validator] Token '${key}' (Symbol: ${token.symbol || 'N/A'}) is missing or has invalid required field: '${field}'`);
                isValid = false;
                errorCount++;
            }
            // Optional: Add more specific type checks if needed
            // else if (field === 'decimals' && typeof token[field] !== 'number') {
            //    logger.error(`[Token Validator] Token '${key}' field '${field}' should be a number.`);
            //    isValid = false; errorCount++;
            // }
            // else if (field === 'address' && !ethers.isAddress(token[field])) { // Requires ethers import
            //    logger.error(`[Token Validator] Token '${key}' field '${field}' is not a valid address.`);
            //    isValid = false; errorCount++;
            // }
        }
    }

    // If any errors were found, throw a fatal error to stop the bot
    if (!isValid) {
        throw new Error(`[Token Validator] FATAL: ${errorCount} error(s) found in token configuration. Please check constants/tokens.js`);
    }

    // If all checks pass
    logger.info('[Token Validator] TOKENS configuration validated successfully.');
}

module.exports = {
    validateTokenConfig,
    // Add other token-related utils here later if needed
};
