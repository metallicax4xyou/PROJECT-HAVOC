// core/tx/paramBuilder.js
// Index file for transaction parameter builders.
// --- VERSION v1.1 --- Adds export for aavePathBuilder

module.exports = {
    ...require('./builders/triangularBuilder'),
    ...require('./builders/twoHopV3Builder'),
    ...require('./builders/aavePathBuilder'), // <<<--- ADD THIS LINE BACK
    // Exporting unsupported builders for completeness, but they might fail execution
    ...require('./builders/v3SushiBuilder'),
    ...require('./builders/sushiV3Builder'),
};
