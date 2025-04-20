// core/finders/spatialFinder.js
// --- VERSION 1.7: Extreme debugging with console.log around requires and entry ---

// --- Log BEFORE requires ---
console.log("!!! SPATIAL FINDER V1.7: TOP OF FILE - BEFORE REQUIRES !!!");

const logger = require('../../utils/logger');
// --- Log AFTER logger require ---
console.log("!!! SPATIAL FINDER V1.7: Logger required:", !!logger);

const { handleError, ArbitrageError } = require('../../utils/errorHandler');
// --- Log AFTER errorHandler require ---
console.log("!!! SPATIAL FINDER V1.7: ErrorHandler required:", !!handleError);

const { getScaledPriceRatio, formatScaledBigIntForLogging } = require('../scannerUtils');
// --- Log AFTER scannerUtils require ---
console.log("!!! SPATIAL FINDER V1.7: scannerUtils required:", !!getScaledPriceRatio);


// Constants
console.log("!!! SPATIAL FINDER V1.7: Defining constants...");
const BIGNUM_SCALE_DECIMALS = 36;
const BIGNUM_SCALE = 10n ** BigInt(BIGNUM_SCALE_DECIMALS);
const PROFIT_THRESHOLD_SCALED = (10001n * BIGNUM_SCALE) / 10000n;
const TEN_THOUSAND = 10000n;
console.log("!!! SPATIAL FINDER V1.7: Constants defined.");

class SpatialFinder {
    constructor() {
        // --- Log inside constructor ---
        console.log("!!! SPATIAL FINDER V1.7: CONSTRUCTOR CALLED !!!");
        logger.info('[SpatialFinder] Initialized.');
    }

    findOpportunities(livePoolStatesMap) {
        // --- *** ADDED TOP-LEVEL CONSOLE LOG AND INPUT LOG *** ---
        console.log("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        console.log("!!! DEBUG: ENTERED SpatialFinder.findOpportunities V1.7 !!!"); // This is the key log now
        console.log("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        const receivedKeys = livePoolStatesMap ? Object.keys(livePoolStatesMap) : [];
        console.log(`[SpatialFinder Console] Received livePoolStatesMap with ${receivedKeys.length} keys.`); // Simplified log

        const logPrefix = '[SpatialFinder]';
        // --- Try logging IMMEDIATELY after entry ---
        try {
             logger.info(`${logPrefix} Starting spatial scan... (Inside findOpportunities)`); // Use logger
        } catch(logError) {
             console.error("!!! SPATIAL FINDER V1.7: ERROR CALLING logger.info at start of function:", logError);
        }

        const opportunities = [];
        const checkedPairings = new Set();
        const poolsByPair = {};

        // --- Step 1: Group pools (using logger.debug as before) ---
        const poolAddresses = receivedKeys;
        logger.debug(`--- SPATIAL FINDER GROUPING (Cycle ${this.cycleCount || 'N/A'}) ---`);
        logger.debug(`[SpatialFinder Grouping] Starting grouping for ${poolAddresses.length} addresses.`);
        if (poolAddresses.length === 0) { /* ... */ }
        for (const address of poolAddresses) { /* ... grouping logic using logger.debug ... */ }
        logger.debug(`${logPrefix} --- Final Grouping Structure ---`);
        for (const key in poolsByPair) { /* ... log structure ... */ }
        logger.debug(`--- END SPATIAL FINDER GROUPING ---`);


        // --- Step 2: Iterate and compare pools (using logger) ---
        const pairKeysToCompare = Object.keys(poolsByPair);
        logger.debug(`${logPrefix} Starting comparisons across ${pairKeysToCompare.length} unique pairs found in grouping.`);
        if (pairKeysToCompare.length === 0) { /* ... */ }
        for (const pairKey of pairKeysToCompare) { /* ... comparison logic using logger.debug ... */ }

        logger.info(`${logPrefix} Scan finished. Found ${opportunities.length} potential spatial opportunities.`);
        return opportunities;
    }


    // --- Price Calculation Helpers (remain the same) ---
     _calculateV3Price(poolState) { /* ... */ }
     _calculateSushiPrice(poolState) { /* ... */ }
} // End Class

console.log("!!! SPATIAL FINDER V1.7: End of file, exporting module..."); // Log before export
module.exports = SpatialFinder;
console.log("!!! SPATIAL FINDER V1.7: Module exported."); // Log after export
