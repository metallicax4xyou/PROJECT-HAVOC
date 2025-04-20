// utils/pairUtils.js
const logger = require('./logger'); // Assuming logger is in utils

/**
 * Generates a standardized, sorted pair key based on token canonical symbols.
 * Handles cases where canonicalSymbol might be missing by falling back to symbol.
 * Ensures consistent sorting and formatting (UPPERCASE-UPPERCASE).
 *
 * @param {Token} tokenA The first Token object (from @uniswap/sdk-core, extended with canonicalSymbol).
 * @param {Token} tokenB The second Token object.
 * @returns {string|null} The canonical pair key (e.g., "USDC-WETH") or null if inputs are invalid.
 */
function getCanonicalPairKey(tokenA, tokenB) {
    if (!tokenA || !tokenB || typeof tokenA !== 'object' || typeof tokenB !== 'object') {
        logger.warn('[getCanonicalPairKey] Invalid token objects received.', { tokenA, tokenB });
        return null;
    }

    // Use canonicalSymbol if available, otherwise fallback to the token's symbol
    const symbolA = (tokenA.canonicalSymbol || tokenA.symbol);
    const symbolB = (tokenB.canonicalSymbol || tokenB.symbol);

    if (!symbolA || !symbolB) {
         logger.warn('[getCanonicalPairKey] Could not determine symbols for pair key generation.', { tokenA_sym: tokenA.symbol, tokenB_sym: tokenB.symbol, tokenA_canon: tokenA.canonicalSymbol, tokenB_canon: tokenB.canonicalSymbol });
         return null;
    }

    // Sort symbols alphabetically and convert to uppercase for consistency
    const [sortedA, sortedB] = [symbolA.toUpperCase(), symbolB.toUpperCase()].sort();

    return `${sortedA}-${sortedB}`;
}

module.exports = { getCanonicalPairKey };
