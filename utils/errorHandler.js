// utils/errorHandler.js
// Basic error handling structure

class ArbitrageError extends Error {
    constructor(message, type = 'GENERIC', details = {}) {
        super(message);
        this.type = type; // e.g., 'RPC_ERROR', 'SIMULATION_ERROR', 'GAS_ERROR', 'CONFIG_ERROR'
        this.details = details; // Optional extra context
        this.name = 'ArbitrageError';
        Error.captureStackTrace(this, this.constructor); // Capture stack trace properly
    }
}

// Basic handler - can be expanded to categorize errors, log differently, etc.
function handleError(error, context = 'Unknown context') {
    if (error instanceof ArbitrageError) {
        console.error(`[${context}] ArbitrageError (${error.type}): ${error.message}`, error.details);
    } else if (error.code) { // Check for common ethers errors by code
         console.error(`[${context}] EthersError (Code: ${error.code}): ${error.reason || error.message}`);
         // Potentially re-throw specific types
         if (error.code === 'INSUFFICIENT_FUNDS') {
            // Maybe throw new ArbitrageError('Insufficient gas funds', 'GAS_ERROR', { originalError: error });
         }
    }
     else {
        console.error(`[${context}] Unexpected Error: ${error.message}`, error);
    }
    // Decide if the error should halt the bot or just be logged
    // For critical setup errors, maybe process.exit(1)
}

module.exports = {
    ArbitrageError,
    handleError,
};
